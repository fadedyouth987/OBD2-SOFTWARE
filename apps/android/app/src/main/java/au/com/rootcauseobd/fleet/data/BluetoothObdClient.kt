package au.com.rootcauseobd.fleet.data

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.UUID

data class BtDeviceSummary(
    val name: String,
    val address: String
)

enum class BtConnectionState {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    ERROR
}

/**
 * Direct Bluetooth Classic SPP (RFCOMM) client for ELM327 / STN11xx / STN21xx OBD-II dongles.
 */
class BluetoothObdClient(context: Context) {
    private val appContext = context.applicationContext
    private val btManager = appContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
    private val adapter: BluetoothAdapter? get() = btManager?.adapter

    private val ioMutex = Mutex()
    private var socket: BluetoothSocket? = null
    private var input: InputStream? = null
    private var output: OutputStream? = null
    private var pollJob: Job? = null

    companion object {
        /** Standard Serial Port Profile (SPP) UUID used by Bluetooth ELM327/STN adapters. */
        val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")
        private val POLL_PIDS = listOf(0x0D, 0x0C, 0x05, 0x0F, 0x10, 0x06, 0x07)
    }

    fun isBluetoothAvailable(): Boolean = adapter?.isEnabled == true

    @SuppressLint("MissingPermission")
    fun listPairedDevices(): List<BtDeviceSummary> {
        val bonded = adapter?.bondedDevices ?: return emptyList()
        return bonded.map { dev ->
            BtDeviceSummary(
                name = dev.name?.takeIf { it.isNotBlank() } ?: "Unknown Device",
                address = dev.address
            )
        }.sortedByDescending {
            val n = it.name.uppercase()
            n.contains("OBD") || n.contains("ELM") || n.contains("STN") || n.contains("OBDLINK") || n.contains("VLINK")
        }
    }

    @SuppressLint("MissingPermission")
    fun connect(
        scope: CoroutineScope,
        address: String,
        onState: (BtConnectionState) -> Unit,
        onDeviceInfo: (ElmProtocol.ElmDeviceInfo) -> Unit,
        onPidSample: (PidSample) -> Unit,
        onBatteryV: (Double) -> Unit,
        onError: (String) -> Unit
    ) {
        disconnect()
        onState(BtConnectionState.CONNECTING)

        pollJob = scope.launch(Dispatchers.IO) {
            try {
                val bt = adapter ?: throw IOException("Bluetooth adapter unavailable")
                val device: BluetoothDevice = bt.getRemoteDevice(address)
                bt.cancelDiscovery()

                val rfcomm = device.createRfcommSocketToServiceRecord(SPP_UUID)
                rfcomm.connect()
                socket = rfcomm
                input = rfcomm.inputStream
                output = rfcomm.outputStream

                var elmVersion = "ELM327"
                for (cmd in ElmProtocol.INIT_COMMANDS) {
                    val resp = sendRawLocked(cmd, timeoutMs = if (cmd == "ATZ") 3000L else 1500L)
                    if (cmd == "ATZ" && resp.isNotBlank()) {
                        elmVersion = resp.lines().lastOrNull { it.isNotBlank() }?.trim() ?: elmVersion
                    }
                }

                val stiResp = sendRawLocked("STI", timeoutMs = 1000L)
                val stnVersion = if (!ElmProtocol.isErrorResponse(stiResp) && stiResp.isNotBlank()) {
                    stiResp.lines().firstOrNull { it.isNotBlank() }?.trim()
                } else null

                onDeviceInfo(ElmProtocol.ElmDeviceInfo(elmVersion = elmVersion, stnVersion = stnVersion))
                onState(BtConnectionState.CONNECTED)

                var cycle = 0
                while (isActive) {
                    // Always poll speed (0x0D) and RPM (0x0C) every cycle for fresh Rule 5 preconditions
                    val pidsThisCycle = if (cycle % 4 == 0) POLL_PIDS else listOf(0x0D, 0x0C)
                    for (pid in pidsThisCycle) {
                        if (!isActive) break
                        val cmd = "01%02X".format(pid)
                        val resp = ioMutex.withLock { sendRawLocked(cmd, timeoutMs = 1500L) }
                        ElmProtocol.parseMode01Pid(pid, resp)?.let(onPidSample)
                    }
                    if (cycle % 4 == 0) {
                        val vResp = ioMutex.withLock { sendRawLocked("ATRV", timeoutMs = 1000L) }
                        ElmProtocol.parseBatteryVoltage(vResp)?.let(onBatteryV)
                    }
                    cycle++
                    delay(200)
                }
            } catch (e: Exception) {
                if (isActive) {
                    onState(BtConnectionState.ERROR)
                    onError(e.message ?: "Bluetooth OBD connection failed")
                }
            }
        }
    }

    suspend fun readDtcs(): Result<List<String>> = withContext(Dispatchers.IO) {
        runCatching {
            val resp = ioMutex.withLock { sendRawLocked("03", timeoutMs = 3000L) }
            if (ElmProtocol.isErrorResponse(resp) && !resp.uppercase().contains("NO DATA")) {
                throw IOException("OBD Mode 03 failed: $resp")
            }
            ElmProtocol.parseMode03Dtcs(resp)
        }
    }

    /**
     * Safety-gated Mode 0x04 Clear DTCs over direct Bluetooth OBD-II.
     * Enforces Rule 5 fail-closed preconditions before transmitting on the bus.
     */
    /**
     * Mode 04 is a paid action (UDS_ACTIVE, Pro and up), the same rule the edge daemon
     * applies with LEASE_REQUIRED. [licence] must be a verified, unexpired plan licence.
     */
    suspend fun clearDtcs(
        live: LivePreconditions,
        licence: Licence?,
        nowEpochS: Long = System.currentTimeMillis() / 1000
    ): Result<String> = withContext(Dispatchers.IO) {
        if (licence == null || !licence.isCurrent(nowEpochS) || !licence.has(Licence.UDS_ACTIVE)) {
            return@withContext Result.failure(
                IllegalStateException(
                    "LEASE_REQUIRED: Clearing codes needs a Pro plan or higher. " +
                        "Sign in on the Account tab; your workshop owner manages the plan on the RootCause website."
                )
            )
        }
        val check = SafetyPolicyEvaluator.evaluate(SafetyTier.A, live)
        if (!check.allowed) {
            return@withContext Result.failure(
                IllegalStateException("${check.code}: ${check.reason}")
            )
        }
        runCatching {
            val resp = ioMutex.withLock { sendRawLocked("04", timeoutMs = 3000L) }
            if (ElmProtocol.isErrorResponse(resp)) {
                throw IOException("OBD Mode 04 rejected: $resp")
            }
            resp.ifBlank { "44 (OK)" }
        }
    }

    fun disconnect() {
        pollJob?.cancel()
        pollJob = null
        try {
            socket?.close()
        } catch (_: IOException) {
        }
        socket = null
        input = null
        output = null
    }

    private fun sendRawLocked(command: String, timeoutMs: Long): String {
        val out = output ?: throw IOException("Bluetooth socket not open")
        val inp = input ?: throw IOException("Bluetooth socket not open")

        // Drain any stale bytes before sending
        while (inp.available() > 0) {
            inp.read()
        }

        out.write("$command\r".toByteArray(Charsets.US_ASCII))
        out.flush()

        val sb = StringBuilder()
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (inp.available() > 0) {
                val b = inp.read()
                if (b < 0) throw IOException("Bluetooth stream closed")
                val ch = b.toChar()
                if (ch == '>') break
                sb.append(ch)
            } else {
                Thread.sleep(15)
            }
        }
        return sb.toString().replace('\r', '\n').trim()
    }
}
