package au.com.rootcauseobd.fleet.data

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import java.util.Base64

/**
 * The workshop's RootCause plan as this app sees it: a cloud-signed lease from
 * `POST /api/v1/auth/edge-lease`, the same token the edge daemon accepts.
 *
 * The app verifies it offline against pinned keys (see [CloudKeys]) with the
 * same rules as the daemon (`apps/edge-daemon/src/auth/lease.rs`): Ed25519
 * only, `aud=edge-daemon`, at most 72 h long, 5 min clock skew. Anything that
 * fails verification means the free Community plan with no paid features.
 */
data class Licence(
    val tier: String,
    val features: Set<String>,
    val tenantId: String,
    val userId: String?,
    val aasraVerified: Boolean,
    /** Unix seconds. */
    val expiresAt: Long,
    val token: String,
) {
    fun has(feature: String): Boolean = feature in features

    fun isCurrent(nowEpochS: Long): Boolean = nowEpochS <= expiresAt + LicenceVerifier.SKEW_SECS

    companion object {
        const val UDS_ACTIVE = "UDS_ACTIVE"
        val TIER_LABEL = mapOf(
            "COMMUNITY" to "Community",
            "PRO" to "Pro",
            "WORKSHOP" to "Workshop",
            "FLEET" to "Fleet",
        )
    }
}

class LicenceException(val reason: String) : Exception(reason)

object LicenceVerifier {
    const val SKEW_SECS = 300L
    const val MAX_LEASE_SECS = 72L * 3600L
    const val AUDIENCE = "edge-daemon"
    private val KNOWN_FEATURES = setOf("J2534", "UDS_ACTIVE", "CAN_RE_PRO", "IMMO_PROGRAM")
    private val KNOWN_TIERS = setOf("COMMUNITY", "PRO", "WORKSHOP", "FLEET")

    /** Verifies [token] at [nowEpochS] against [keys] (kid → raw 32-byte Ed25519 public key). */
    fun verify(token: String, keys: Map<String, ByteArray>, nowEpochS: Long): Licence {
        val parts = token.trim().split('.')
        if (parts.size != 3) throw LicenceException("not a compact JWS")
        val header = decodeJson(parts[0], "header")
        val alg = header.str("alg")
        if (alg != "EdDSA") throw LicenceException("unsupported algorithm ${alg ?: "none"}")
        if (header.containsKey("crit")) throw LicenceException("critical header extensions are not supported")
        val kid = header.str("kid") ?: throw LicenceException("missing kid")
        val key = keys[kid] ?: throw LicenceException("unknown signing key $kid")
        if (key.size != 32) throw LicenceException("bad public key for $kid")

        val signature = decodeB64(parts[2], "signature")
        val signer = Ed25519Signer()
        signer.init(false, Ed25519PublicKeyParameters(key, 0))
        val signed = "${parts[0]}.${parts[1]}".toByteArray(Charsets.US_ASCII)
        signer.update(signed, 0, signed.size)
        if (!signer.verifySignature(signature)) throw LicenceException("bad signature")

        val claims = decodeJson(parts[1], "payload")
        val audOk = when (val aud = claims["aud"]) {
            is JsonPrimitive -> aud.contentOrNull == AUDIENCE
            is JsonArray -> aud.any { (it as? JsonPrimitive)?.contentOrNull == AUDIENCE }
            else -> false
        }
        if (!audOk) throw LicenceException("wrong audience (expected $AUDIENCE)")
        // Immobilizer job tokens share the audience but are not a plan licence.
        if (claims.containsKey("lease_kind")) throw LicenceException("not a diagnostic lease")

        val exp = claims.num("exp") ?: throw LicenceException("missing exp")
        val start = claims.num("nbf") ?: claims.num("iat") ?: throw LicenceException("missing nbf")
        if (nowEpochS > exp + SKEW_SECS) throw LicenceException("expired")
        if (nowEpochS + SKEW_SECS < start) throw LicenceException("not yet valid")
        if (exp - start > MAX_LEASE_SECS) throw LicenceException("lease lasts too long")

        val tenantId = claims.str("tenant_id")?.takeIf { it.isNotBlank() }
            ?: throw LicenceException("missing tenant_id")
        val tier = claims.str("tier")?.takeIf { it in KNOWN_TIERS }
            ?: throw LicenceException("missing or unknown tier")
        // Unknown feature names (from a newer cloud) are ignored, never trusted.
        val features = (claims["features"] as? JsonArray)
            ?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
            ?.filter { it in KNOWN_FEATURES }
            ?.toSet()
            ?: emptySet()
        val userId = (claims.str("user_id") ?: claims.str("sub"))?.takeIf { it.isNotBlank() }
        val aasra = (claims["aasra_verified"] as? JsonPrimitive)?.booleanOrNull ?: false
        return Licence(tier, features, tenantId, userId, aasra, exp, token.trim())
    }

    /** The verified licence, or null (Community) if the token is missing or fails any check. */
    fun verifyOrNull(token: String?, keys: Map<String, ByteArray>, nowEpochS: Long): Licence? =
        token?.let { runCatching { verify(it, keys, nowEpochS) }.getOrNull() }

    fun hexKey(hex: String): ByteArray {
        val clean = hex.trim()
        require(clean.length == 64) { "an Ed25519 public key is 64 hex characters" }
        return ByteArray(32) { i -> clean.substring(i * 2, i * 2 + 2).toInt(16).toByte() }
    }

    private fun decodeB64(part: String, what: String): ByteArray = try {
        Base64.getUrlDecoder().decode(part)
    } catch (e: IllegalArgumentException) {
        throw LicenceException("bad base64 in $what")
    }

    private fun decodeJson(part: String, what: String): JsonObject = try {
        EdgeCodec.json.parseToJsonElement(String(decodeB64(part, what), Charsets.UTF_8)).jsonObject
    } catch (e: LicenceException) {
        throw e
    } catch (e: Exception) {
        throw LicenceException("bad JSON in $what")
    }

    private fun JsonObject.str(name: String): String? = (this[name] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

    private fun JsonObject.num(name: String): Long? = (this[name] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull
}
