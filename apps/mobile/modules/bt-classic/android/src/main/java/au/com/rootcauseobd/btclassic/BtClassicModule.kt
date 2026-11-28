package au.com.rootcauseobd.btclassic

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.IOException
import java.util.UUID
import kotlin.concurrent.thread

// Serial Port Profile, the UUID classic ELM327 dongles use.
private val SPP_UUID: UUID = UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")

class BtClassicException(message: String) : CodedException(message)

/**
 * A classic Bluetooth (SPP) serial link to a paired ELM327 dongle. Only lists and
 * connects to already-paired devices; pairing happens in Android settings. The app's
 * JavaScript send guard decides what may be written.
 */
class BtClassicModule : Module() {
  private var socket: BluetoothSocket? = null
  private var reader: Thread? = null

  private val adapter
    get() = (appContext.reactContext?.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter

  override fun definition() = ModuleDefinition {
    Name("BtClassic")
    Events("onData", "onDisconnect")

    AsyncFunction("isEnabled") { adapter?.isEnabled == true }

    @SuppressLint("MissingPermission") // the JS side asks for BLUETOOTH_CONNECT first
    AsyncFunction("bondedDevices") {
      val a = adapter ?: throw BtClassicException("This phone has no Bluetooth.")
      a.bondedDevices.map { mapOf("name" to (it.name ?: it.address), "address" to it.address) }
    }

    @SuppressLint("MissingPermission")
    AsyncFunction("connect") { address: String ->
      val a = adapter ?: throw BtClassicException("This phone has no Bluetooth.")
      closeQuietly()
      val device = a.getRemoteDevice(address)
      a.cancelDiscovery()
      val s = device.createRfcommSocketToServiceRecord(SPP_UUID)
      try {
        s.connect()
      } catch (e: IOException) {
        try { s.close() } catch (_: IOException) {}
        throw BtClassicException("Couldn't connect to the dongle. Check it's plugged in and the ignition is on.")
      }
      socket = s
      val input = s.inputStream
      reader = thread(name = "bt-classic-reader", isDaemon = true) {
        val buf = ByteArray(1024)
        try {
          while (true) {
            val n = input.read(buf)
            if (n < 0) break
            sendEvent("onData", mapOf("data" to String(buf, 0, n, Charsets.ISO_8859_1)))
          }
        } catch (_: IOException) {
        }
        if (socket === s) {
          socket = null
          sendEvent("onDisconnect", mapOf("reason" to "The dongle disconnected."))
        }
      }
    }

    AsyncFunction("write") { text: String ->
      val s = socket ?: throw BtClassicException("Not connected to a dongle.")
      try {
        s.outputStream.write(text.toByteArray(Charsets.ISO_8859_1))
        s.outputStream.flush()
      } catch (e: IOException) {
        throw BtClassicException("Lost the connection to the dongle.")
      }
    }

    AsyncFunction("disconnect") { closeQuietly() }

    OnDestroy { closeQuietly() }
  }

  private fun closeQuietly() {
    val s = socket
    socket = null
    try { s?.close() } catch (_: IOException) {}
    reader = null
  }
}
