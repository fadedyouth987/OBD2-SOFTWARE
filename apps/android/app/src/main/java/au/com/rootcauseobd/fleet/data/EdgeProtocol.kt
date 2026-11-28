package au.com.rootcauseobd.fleet.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

object EdgeProtocolConstants {
    const val PROTOCOL_VERSION = "1.1.0"
    const val POLICY_VERSION = "1.0.0"
    const val CLIENT_VERSION = "0.2.0"
    const val DEFAULT_ENDPOINT = "ws://127.0.0.1:8765"
}

@Serializable
enum class BusProtocol {
    AUTO,
    ISO15765_11_500,
    ISO15765_29_500,
    ISO15765_11_250,
    ISO15765_29_250,
    MS_CAN_125,
    BMW_DCAN,
    ISO14230_FAST,
    ISO14230_5BAUD,
    ISO9141_2,
    J1850_PWM,
    J1850_VPW
}

@Serializable
enum class DiagProtocol {
    UDS,
    KWP2000,
    OBD
}

@Serializable
data class AdapterInfo(
    @SerialName("adapter_id") val adapterId: String,
    val kind: String,
    @SerialName("display_name") val displayName: String,
    val path: String? = null
)

@Serializable
data class PidSample(
    @SerialName("timestamp_us") val timestampUs: Long,
    val pid: Int,
    val name: String,
    val value: Double,
    val unit: String
)

@Serializable
data class PreconditionsSnapshot(
    @SerialName("speed_kmh") val speedKmh: Double? = null,
    @SerialName("speed_age_ms") val speedAgeMs: Long? = null,
    val rpm: Double? = null,
    @SerialName("battery_v") val batteryV: Double? = null
)

@Serializable
data class NrcInfo(
    val code: Int,
    val name: String
)

// --- Outgoing requests (wire schema 1.1.0) ---

@Serializable
data class HelloRequest(
    val type: String = "HelloRequest",
    @SerialName("request_id") val requestId: String,
    @SerialName("client_token") val clientToken: String,
    @SerialName("client_version") val clientVersion: String = EdgeProtocolConstants.CLIENT_VERSION,
    @SerialName("protocol_version") val protocolVersion: String = EdgeProtocolConstants.PROTOCOL_VERSION,
    @SerialName("policy_version") val policyVersion: String = EdgeProtocolConstants.POLICY_VERSION
)

@Serializable
data class AdapterListRequest(
    val type: String = "AdapterListRequest",
    @SerialName("request_id") val requestId: String
)

@Serializable
data class ConnectRequest(
    val type: String = "ConnectRequest",
    @SerialName("request_id") val requestId: String,
    @SerialName("adapter_id") val adapterId: String,
    val protocol: BusProtocol = BusProtocol.AUTO,
    @SerialName("baud_rate") val baudRate: Int? = null,
    @SerialName("safety_mode") val safetyMode: SafetyMode = SafetyMode.SILENT
)

@Serializable
data class DisconnectRequest(
    val type: String = "DisconnectRequest",
    @SerialName("request_id") val requestId: String,
    @SerialName("adapter_id") val adapterId: String
)

@Serializable
data class SafetyConfirmRequest(
    val type: String = "SafetyConfirmRequest",
    @SerialName("request_id") val requestId: String,
    @SerialName("tx_id") val txId: Int,
    @SerialName("rx_id") val rxId: Int,
    val protocol: DiagProtocol,
    @SerialName("service_id") val serviceId: Int,
    @SerialName("payload_hex") val payloadHex: String,
    @SerialName("user_ack_text") val userAckText: String
)

@Serializable
data class DiagCommandRequest(
    val type: String = "DiagCommandRequest",
    @SerialName("request_id") val requestId: String,
    @SerialName("tx_id") val txId: Int,
    @SerialName("rx_id") val rxId: Int,
    val protocol: DiagProtocol,
    @SerialName("service_id") val serviceId: Int,
    @SerialName("payload_hex") val payloadHex: String,
    @SerialName("safety_token") val safetyToken: String? = null
)

@Serializable
data class LeaseStatusRequest(
    val type: String = "LeaseStatusRequest",
    @SerialName("request_id") val requestId: String
)

@Serializable
enum class LeaseKind {
    DIAGNOSTIC,
    IMMO
}

/** Installs a cloud-signed lease on the daemon, which verifies it against its own pinned keys. -> LeaseStatus */
@Serializable
data class LeaseInstallRequest(
    val type: String = "LeaseInstallRequest",
    @SerialName("request_id") val requestId: String,
    val kind: LeaseKind = LeaseKind.DIAGNOSTIC,
    @SerialName("lease_token") val leaseToken: String
)

// --- Incoming responses & server pushes ---

sealed class EdgeIncomingMessage {
    @Serializable
    data class HelloResponse(
        @SerialName("request_id") val requestId: String,
        @SerialName("session_id") val sessionId: String,
        @SerialName("daemon_version") val daemonVersion: String,
        @SerialName("protocol_version") val protocolVersion: String,
        @SerialName("policy_version") val policyVersion: String,
        @SerialName("lease_tier") val leaseTier: String,
        val features: List<String> = emptyList()
    ) : EdgeIncomingMessage()

    @Serializable
    data class AdapterListResponse(
        @SerialName("request_id") val requestId: String,
        val adapters: List<AdapterInfo> = emptyList()
    ) : EdgeIncomingMessage()

    @Serializable
    data class AdapterStatus(
        @SerialName("request_id") val requestId: String? = null,
        @SerialName("adapter_id") val adapterId: String,
        val state: String,
        @SerialName("battery_v") val batteryV: Double? = null
    ) : EdgeIncomingMessage()

    @Serializable
    data class ObdPidStream(
        val samples: List<PidSample> = emptyList()
    ) : EdgeIncomingMessage()

    @Serializable
    data class SafetyConfirmResponse(
        @SerialName("request_id") val requestId: String,
        @SerialName("safety_token") val safetyToken: String,
        @SerialName("expires_at") val expiresAt: String,
        val preconditions: PreconditionsSnapshot = PreconditionsSnapshot()
    ) : EdgeIncomingMessage()

    @Serializable
    data class DiagCommandResponse(
        @SerialName("request_id") val requestId: String,
        val positive: Boolean,
        @SerialName("response_hex") val responseHex: String,
        val nrc: NrcInfo? = null
    ) : EdgeIncomingMessage()

    @Serializable
    data class HeuristicAlert(
        @SerialName("rule_id") val ruleId: String,
        val severity: String,
        val title: String,
        @SerialName("evidence_json") val evidenceJson: JsonObject? = null,
        @SerialName("recommended_test") val recommendedTest: String
    ) : EdgeIncomingMessage()

    @Serializable
    data class ErrorResponse(
        @SerialName("request_id") val requestId: String? = null,
        val code: String,
        val message: String,
        val hint: String = ""
    ) : EdgeIncomingMessage()

    @Serializable
    data class LeaseStatus(
        @SerialName("request_id") val requestId: String,
        @SerialName("lease_tier") val leaseTier: String,
        val features: List<String> = emptyList(),
        @SerialName("expires_at") val expiresAt: String? = null,
        @SerialName("immo_expires_at") val immoExpiresAt: String? = null,
        @SerialName("cloud_keys_pinned") val cloudKeysPinned: Boolean = false
    ) : EdgeIncomingMessage()

    data class CanFrameBatchReceived(val frameCount: Int) : EdgeIncomingMessage()
    data class Unknown(val rawType: String) : EdgeIncomingMessage()
}

object EdgeCodec {
    val json: Json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = true
    }

    inline fun <reified T> encode(message: T): String = json.encodeToString(message)

    fun decode(text: String): EdgeIncomingMessage {
        val obj = json.parseToJsonElement(text).jsonObject
        val type = obj["type"]?.jsonPrimitive?.contentOrNull ?: return EdgeIncomingMessage.Unknown("missing_type")
        return when (type) {
            "HelloResponse" -> json.decodeFromString<EdgeIncomingMessage.HelloResponse>(text)
            "AdapterListResponse" -> json.decodeFromString<EdgeIncomingMessage.AdapterListResponse>(text)
            "AdapterStatus" -> json.decodeFromString<EdgeIncomingMessage.AdapterStatus>(text)
            "ObdPidStream" -> json.decodeFromString<EdgeIncomingMessage.ObdPidStream>(text)
            "SafetyConfirmResponse" -> json.decodeFromString<EdgeIncomingMessage.SafetyConfirmResponse>(text)
            "DiagCommandResponse" -> json.decodeFromString<EdgeIncomingMessage.DiagCommandResponse>(text)
            "HeuristicAlert" -> json.decodeFromString<EdgeIncomingMessage.HeuristicAlert>(text)
            "ErrorResponse" -> json.decodeFromString<EdgeIncomingMessage.ErrorResponse>(text)
            "LeaseStatus" -> json.decodeFromString<EdgeIncomingMessage.LeaseStatus>(text)
            "CanFrameBatch" -> {
                val count = (obj["frames"] as? kotlinx.serialization.json.JsonArray)?.size ?: 0
                EdgeIncomingMessage.CanFrameBatchReceived(count)
            }
            else -> EdgeIncomingMessage.Unknown(type)
        }
    }
}
