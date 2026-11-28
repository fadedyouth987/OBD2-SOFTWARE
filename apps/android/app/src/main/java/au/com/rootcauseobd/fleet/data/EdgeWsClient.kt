package au.com.rootcauseobd.fleet.data

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.UUID
import java.util.concurrent.TimeUnit

enum class WsConnectionState {
    DISCONNECTED,
    CONNECTING,
    CONNECTED,
    ERROR
}

/**
 * Connects to the local edge-daemon (default ws://127.0.0.1:8765) using wire protocol 1.1.0
 * and sends HelloRequest as the first message on every connection (Rule 4).
 */
class EdgeWsClient(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(15, TimeUnit.SECONDS)
        .build()
) {
    private var socket: WebSocket? = null

    fun connect(
        endpoint: String = EdgeProtocolConstants.DEFAULT_ENDPOINT,
        clientToken: String,
        onState: (WsConnectionState) -> Unit,
        onMessage: (EdgeIncomingMessage) -> Unit,
        onError: (String) -> Unit
    ) {
        close()
        onState(WsConnectionState.CONNECTING)
        val req = try {
            Request.Builder().url(endpoint.trim()).build()
        } catch (e: IllegalArgumentException) {
            onState(WsConnectionState.ERROR)
            onError("Invalid WebSocket URL: ${e.message}")
            return
        }

        socket = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val hello = HelloRequest(
                    requestId = newRequestId("hello"),
                    clientToken = clientToken.trim()
                )
                webSocket.send(EdgeCodec.encode(hello))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    val decoded = EdgeCodec.decode(text)
                    if (decoded is EdgeIncomingMessage.HelloResponse) {
                        onState(WsConnectionState.CONNECTED)
                    }
                    onMessage(decoded)
                } catch (e: Exception) {
                    onError("Protocol decode error: ${e.message}")
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                onState(WsConnectionState.DISCONNECTED)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                onState(WsConnectionState.DISCONNECTED)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                onState(WsConnectionState.ERROR)
                val detail = response?.let { "HTTP ${it.code}: ${it.message}" } ?: (t.message ?: "Cannot reach edge daemon")
                onError(detail)
            }
        })
    }

    fun listAdapters(): String {
        val reqId = newRequestId("adapters")
        socket?.send(EdgeCodec.encode(AdapterListRequest(requestId = reqId)))
        return reqId
    }

    fun connectAdapter(
        adapterId: String,
        protocol: BusProtocol = BusProtocol.AUTO,
        baudRate: Int? = null,
        safetyMode: SafetyMode = SafetyMode.SILENT
    ): String {
        val reqId = newRequestId("connect")
        val msg = ConnectRequest(
            requestId = reqId,
            adapterId = adapterId,
            protocol = protocol,
            baudRate = baudRate,
            safetyMode = safetyMode
        )
        socket?.send(EdgeCodec.encode(msg))
        return reqId
    }

    fun disconnectAdapter(adapterId: String): String {
        val reqId = newRequestId("disconnect")
        socket?.send(EdgeCodec.encode(DisconnectRequest(requestId = reqId, adapterId = adapterId)))
        return reqId
    }

    fun requestSafetyConfirm(routine: GatedRoutine): String {
        val reqId = newRequestId("confirm")
        val msg = SafetyConfirmRequest(
            requestId = reqId,
            txId = routine.txId,
            rxId = routine.rxId,
            protocol = routine.protocol,
            serviceId = routine.serviceId,
            payloadHex = routine.payloadHex,
            userAckText = routine.ackText()
        )
        socket?.send(EdgeCodec.encode(msg))
        return reqId
    }

    fun sendDiagCommand(
        protocol: DiagProtocol,
        serviceId: Int,
        txId: Int,
        rxId: Int,
        payloadHex: String,
        safetyToken: String? = null
    ): String {
        val reqId = newRequestId("diag")
        val msg = DiagCommandRequest(
            requestId = reqId,
            txId = txId,
            rxId = rxId,
            protocol = protocol,
            serviceId = serviceId,
            payloadHex = payloadHex,
            safetyToken = safetyToken
        )
        socket?.send(EdgeCodec.encode(msg))
        return reqId
    }

    fun requestLeaseStatus(): String {
        val reqId = newRequestId("lease")
        socket?.send(EdgeCodec.encode(LeaseStatusRequest(requestId = reqId)))
        return reqId
    }

    /** Sends the workshop's plan licence to the daemon; it answers with LeaseStatus. */
    fun installLease(leaseToken: String): String {
        val reqId = newRequestId("lease_install")
        socket?.send(EdgeCodec.encode(LeaseInstallRequest(requestId = reqId, leaseToken = leaseToken)))
        return reqId
    }

    fun close() {
        socket?.close(1000, "session closed")
        socket = null
    }

    private fun newRequestId(prefix: String): String =
        "${prefix}_${UUID.randomUUID().toString().replace("-", "").take(12)}"
}
