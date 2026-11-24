package au.com.rootcauseobd.fleet.data

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.UUID

/** Connects to local edge-daemon (ws://127.0.0.1:8765) and sends HelloRequest first (Rule 4). */
class EdgeWsClient(
    private val endpoint: String = "ws://127.0.0.1:8765",
    private val client: OkHttpClient = OkHttpClient()
) {
    private var socket: WebSocket? = null

    fun connect(pairingToken: String, onFrame: (String) -> Unit, onError: (String) -> Unit) {
        val req = Request.Builder().url(endpoint).build()
        socket = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: okhttp3.Response) {
                val hello = """{"type":"HelloRequest","request_id":"${UUID.randomUUID()}","protocol_version":"1.0.0","policy_version":"1.0.0","pairing_token":"$pairingToken"}"""
                webSocket.send(hello)
            }

            override fun onMessage(webSocket: WebSocket, text: String) = onFrame(text)

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: okhttp3.Response?) {
                onError(t.message ?: "Cannot reach local edge daemon")
            }
        })
    }

    fun connectAdapter(adapterId: String, protocol: String = "AUTO", safetyMode: String = "SILENT") {
        val msg = """{"type":"ConnectRequest","request_id":"${UUID.randomUUID()}","adapter_id":"$adapterId","protocol":"$protocol","baud_rate":null,"safety_mode":"$safetyMode"}"""
        socket?.send(msg)
    }

    fun requestSafetyConfirm(
        protocol: String,
        serviceId: Int,
        txId: Int,
        rxId: Int,
        payloadHex: String,
        userAckText: String
    ) {
        val msg = """{"type":"SafetyConfirmRequest","request_id":"${UUID.randomUUID()}","protocol":"$protocol","service_id":$serviceId,"tx_id":$txId,"rx_id":$rxId,"payload_hex":"$payloadHex","user_ack_text":"$userAckText"}"""
        socket?.send(msg)
    }

    fun sendDiagCommand(
        protocol: String,
        serviceId: Int,
        txId: Int,
        rxId: Int,
        payloadHex: String,
        safetyToken: String? = null
    ) {
        val tok = safetyToken?.let { "\"$it\"" } ?: "null"
        val msg = """{"type":"DiagCommandRequest","request_id":"${UUID.randomUUID()}","protocol":"$protocol","service_id":$serviceId,"tx_id":$txId,"rx_id":$rxId,"payload_hex":"$payloadHex","safety_token":$tok}"""
        socket?.send(msg)
    }

    fun close() {
        socket?.close(1000, "session closed")
        socket = null
    }
}
