package au.com.rootcauseobd.fleet

import au.com.rootcauseobd.fleet.data.CloudKeys
import au.com.rootcauseobd.fleet.data.Licence
import au.com.rootcauseobd.fleet.data.LicenceException
import au.com.rootcauseobd.fleet.data.LicenceVerifier
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.File

/**
 * The plan licence is checked with the daemon's rules, against the shared fixture
 * (packages/schemas/fixtures/signing/cloud_tokens.json) that the cloud API, the
 * Rust daemon and the web app also test against.
 */
class LicenceVerifierTest {
    private val fixture: JsonObject by lazy {
        val rel = "packages/schemas/fixtures/signing/cloud_tokens.json"
        var dir: File? = File("").absoluteFile
        while (dir != null && !File(dir, rel).exists()) dir = dir.parentFile
        requireNotNull(dir) { "can't find $rel above ${File("").absolutePath}" }
        Json.parseToJsonElement(File(dir, rel).readText()).jsonObject
    }
    private val keys by lazy {
        mapOf(
            fixture["kid"]!!.jsonPrimitive.content to
                LicenceVerifier.hexKey(fixture["public_key_hex"]!!.jsonPrimitive.content)
        )
    }
    private val now by lazy { fixture["now"]!!.jsonPrimitive.long }
    private fun valid(name: String) = fixture["valid"]!!.jsonObject[name]!!.jsonPrimitive.content
    private fun rejected(name: String) = fixture["rejected"]!!.jsonObject[name]!!.jsonPrimitive.content

    @Test
    fun validLeaseUnlocksTheWorkshopPlan() {
        val expected = fixture["expected"]!!.jsonObject["lease"]!!.jsonObject
        val lic = LicenceVerifier.verify(valid("lease"), keys, now)
        assertEquals(expected["tier"]!!.jsonPrimitive.content, lic.tier)
        assertEquals(expected["tenant_id"]!!.jsonPrimitive.content, lic.tenantId)
        assertEquals(expected["user_id"]!!.jsonPrimitive.content, lic.userId)
        assertEquals(expected["exp"]!!.jsonPrimitive.long, lic.expiresAt)
        assertEquals(expected["features"]!!.jsonArray.map { it.jsonPrimitive.content }.toSet(), lic.features)
        assertTrue(lic.has(Licence.UDS_ACTIVE))
        assertTrue(lic.aasraVerified)
        assertTrue(lic.isCurrent(now))
    }

    @Test
    fun rejectsEverythingTheDaemonRejects() {
        for (name in listOf(
            "lease_signed_by_other_key",
            "lease_unknown_kid",
            "lease_expired",
            "pairing_as_lease",
            "session_as_lease",
            "immo_as_diagnostic_lease",
        )) {
            try {
                LicenceVerifier.verify(rejected(name), keys, now)
                fail("$name should have been rejected")
            } catch (_: LicenceException) {
                // expected
            }
            assertNull(name, LicenceVerifier.verifyOrNull(rejected(name), keys, now))
        }
    }

    @Test
    fun pairingAndImmoTokensAreNotPlanLicences() {
        assertNull(LicenceVerifier.verifyOrNull(valid("pairing"), keys, now))
        assertNull(LicenceVerifier.verifyOrNull(valid("immo_lease"), keys, now))
    }

    @Test
    fun expiresAfterTheFiveMinuteSkew() {
        val lic = LicenceVerifier.verify(valid("lease"), keys, now)
        assertTrue(lic.isCurrent(lic.expiresAt + 300))
        assertFalse(lic.isCurrent(lic.expiresAt + 301))
        assertNull(LicenceVerifier.verifyOrNull(valid("lease"), keys, lic.expiresAt + 301))
    }

    @Test
    fun tamperedOrMalformedTokensFail() {
        val parts = valid("lease").split('.')
        val forged = listOf(parts[0], parts[1].dropLast(2) + "AA", parts[2]).joinToString(".")
        assertNull(LicenceVerifier.verifyOrNull(forged, keys, now))
        assertNull(LicenceVerifier.verifyOrNull("not-a-token", keys, now))
        assertNull(LicenceVerifier.verifyOrNull("", keys, now))
        assertNull(LicenceVerifier.verifyOrNull(null, keys, now))
        // No keys at all (a release build with nothing pinned) means Community.
        assertNull(LicenceVerifier.verifyOrNull(valid("lease"), emptyMap(), now))
    }

    @Test
    fun releaseBuildsPinNoDevelopmentKey() {
        // Same rule as the daemon: never pin a development or fixture key.
        assertFalse(CloudKeys.PINNED.containsKey(fixture["kid"]!!.jsonPrimitive.content))
        assertFalse(CloudKeys.PINNED.containsValue(fixture["public_key_hex"]!!.jsonPrimitive.content))
    }
}
