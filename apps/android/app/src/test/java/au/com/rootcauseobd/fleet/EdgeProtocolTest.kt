package au.com.rootcauseobd.fleet

import au.com.rootcauseobd.fleet.data.*
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Test

class EdgeProtocolTest {
    @Test
    fun helloRequestMatchesWireSchema1_1_0() {
        val req = HelloRequest(
            requestId = "hello_123456",
            clientToken = "123456"
        )
        val encoded = EdgeCodec.encode(req)
        val obj = EdgeCodec.json.parseToJsonElement(encoded).jsonObject

        assertEquals("HelloRequest", obj["type"]?.jsonPrimitive?.content)
        assertEquals("hello_123456", obj["request_id"]?.jsonPrimitive?.content)
        assertEquals("123456", obj["client_token"]?.jsonPrimitive?.content)
        assertEquals("0.2.0", obj["client_version"]?.jsonPrimitive?.content)
        assertEquals("1.1.0", obj["protocol_version"]?.jsonPrimitive?.content)
        assertEquals("1.0.0", obj["policy_version"]?.jsonPrimitive?.content)
        assertNull("Old pairing_token field must not be sent", obj["pairing_token"])
    }

    @Test
    fun decodesHelloResponseAndAdapterList() {
        val helloJson = """
            {
              "type": "HelloResponse",
              "request_id": "hello_1",
              "session_id": "sess-abc",
              "daemon_version": "0.1.0",
              "protocol_version": "1.1.0",
              "policy_version": "1.0.0",
              "lease_tier": "PRO",
              "features": ["UDS_ACTIVE", "CAN_RE_PRO"]
            }
        """.trimIndent()
        val decoded = EdgeCodec.decode(helloJson)
        assertTrue(decoded is EdgeIncomingMessage.HelloResponse)
        val hello = decoded as EdgeIncomingMessage.HelloResponse
        assertEquals("sess-abc", hello.sessionId)
        assertEquals("PRO", hello.leaseTier)
        assertEquals(listOf("UDS_ACTIVE", "CAN_RE_PRO"), hello.features)

        val listJson = """
            {
              "type": "AdapterListResponse",
              "request_id": "adapters_1",
              "adapters": [
                {"adapter_id": "virtual-falcon-ba", "kind": "VIRTUAL", "display_name": "Virtual BA Falcon", "path": null}
              ]
            }
        """.trimIndent()
        val list = EdgeCodec.decode(listJson) as EdgeIncomingMessage.AdapterListResponse
        assertEquals(1, list.adapters.size)
        assertEquals("virtual-falcon-ba", list.adapters.first().adapterId)
    }

    @Test
    fun decodesErrorResponseAndHeuristicAlert() {
        val errJson = """
            {
              "type": "ErrorResponse",
              "request_id": "confirm_1",
              "code": "PRECONDITION_UNKNOWN",
              "message": "speed unknown",
              "hint": "Wait for PID 0x0D reading"
            }
        """.trimIndent()
        val err = EdgeCodec.decode(errJson) as EdgeIncomingMessage.ErrorResponse
        assertEquals("PRECONDITION_UNKNOWN", err.code)
        assertEquals("Wait for PID 0x0D reading", err.hint)

        val alertJson = """
            {
              "type": "HeuristicAlert",
              "rule_id": "vacuum_leak",
              "severity": "AMBER",
              "title": "Elevated idle fuel trim",
              "evidence_json": {"stft_b1": 18.5},
              "recommended_test": "Smoke-test intake tract"
            }
        """.trimIndent()
        val alert = EdgeCodec.decode(alertJson) as EdgeIncomingMessage.HeuristicAlert
        assertEquals("AMBER", alert.severity)
        assertEquals("Elevated idle fuel trim", alert.title)
    }
}
