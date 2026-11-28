package au.com.rootcauseobd.fleet.data

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** What the account screen shows. */
data class AccountState(
    val serverUrl: String,
    val email: String? = null,
    val workspaceName: String? = null,
    /** False once the sign-in session has expired; the licence still works until it expires. */
    val sessionValid: Boolean = false,
    val licence: Licence? = null,
    /** Why the last licence refresh failed, if it did. */
    val licenceError: String? = null,
) {
    val signedIn: Boolean get() = email != null
}

class AccountException(message: String) : Exception(message)

/**
 * Signs in to the workshop's RootCause account and keeps its plan licence.
 *
 * The app never sells anything: plans are bought on the RootCause website by the
 * workshop owner (Google Play payments policy: a consumption-only app). The app
 * only reads the plan, as a signed lease it verifies offline, so a technician in
 * a car park with no signal keeps the features they paid for until it expires.
 */
class CloudAccount(
    context: Context,
    private val defaultServerUrl: String,
    /** Debug builds only: also trust the keys the configured server publishes. */
    private val trustServerKeys: Boolean,
    private val http: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(20, TimeUnit.SECONDS)
        .build(),
    private val now: () -> Long = { System.currentTimeMillis() / 1000 },
) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun state(): AccountState {
        val email = prefs.getString(K_EMAIL, null)
        val sessionExp = prefs.getLong(K_SESSION_EXP, 0L)
        return AccountState(
            serverUrl = serverUrl(),
            email = email,
            workspaceName = prefs.getString(K_WORKSPACE, null),
            sessionValid = email != null && prefs.getString(K_SESSION, null) != null && now() < sessionExp,
            licence = currentLicence(),
        )
    }

    fun serverUrl(): String = prefs.getString(K_SERVER, null) ?: defaultServerUrl

    /** The cached licence if it still verifies, else null (Community). */
    fun currentLicence(): Licence? =
        LicenceVerifier.verifyOrNull(prefs.getString(K_LEASE, null), trustedKeys(), now())

    suspend fun signIn(serverUrl: String, email: String, password: String): AccountState =
        withContext(Dispatchers.IO) {
            val base = normalizeServer(serverUrl)
            val body = buildJsonObject {
                put("email", email.trim())
                put("password", password)
            }
            val res = post("$base/api/v1/auth/login", body, bearer = null)
            val token = res.str("access_token") ?: throw AccountException("The server didn't return a session")
            val exp = (res["expires_at"] as? JsonPrimitive)?.longOrNull ?: (now() + 3600)
            val tenantId = res.str("tenant_id")
            val workspace = (res["workspaces"] as? JsonArray)
                ?.mapNotNull { it as? JsonObject }
                ?.firstOrNull { it.str("tenant_id") == tenantId }
                ?.str("name")
            prefs.edit()
                .putString(K_SERVER, base)
                .putString(K_EMAIL, email.trim())
                .putString(K_WORKSPACE, workspace)
                .putString(K_SESSION, token)
                .putLong(K_SESSION_EXP, exp)
                .remove(K_LEASE)
                .apply()
            if (trustServerKeys) fetchServerKeys(base)
            state().copy(licenceError = tryRefresh())
        }

    /**
     * Fetches a fresh licence when the session allows it. On failure the cached
     * licence is kept until it expires (offline work keeps going).
     */
    suspend fun refreshLicence(): AccountState = withContext(Dispatchers.IO) {
        state().copy(licenceError = tryRefresh())
    }

    private fun tryRefresh(): String? = try {
        refreshLicenceBlocking()
        null
    } catch (e: AccountException) {
        e.message
    }

    /** True when the licence is missing or within [withinSecs] of expiring. */
    fun licenceNeedsRefresh(withinSecs: Long = 2 * 3600): Boolean {
        val lic = currentLicence() ?: return true
        return lic.expiresAt - now() < withinSecs
    }

    fun signOut() {
        prefs.edit().clear().apply()
    }

    private fun refreshLicenceBlocking() {
        val session = prefs.getString(K_SESSION, null) ?: throw AccountException("Sign in first")
        if (now() >= prefs.getLong(K_SESSION_EXP, 0L)) {
            throw AccountException("Your sign-in has expired. Sign in again to renew the plan licence.")
        }
        val base = serverUrl()
        if (trustServerKeys && serverKeys().isEmpty()) fetchServerKeys(base)
        val res = post("$base/api/v1/auth/edge-lease", buildJsonObject { }, bearer = session)
        val token = res.str("token") ?: throw AccountException("The server didn't return a licence")
        // Store only what verifies: a token we can't check is worth nothing offline.
        try {
            LicenceVerifier.verify(token, trustedKeys(), now())
        } catch (e: LicenceException) {
            val hint = if (trustedKeys().isEmpty()) {
                " This build has no pinned RootCause key yet, so it runs on the free plan."
            } else ""
            throw AccountException("The plan licence couldn't be verified (${e.reason}).$hint")
        }
        prefs.edit().putString(K_LEASE, token).apply()
    }

    private fun trustedKeys(): Map<String, ByteArray> {
        val pinned = CloudKeys.pinned()
        if (!trustServerKeys) return pinned
        // Pinned keys win on a kid clash.
        return serverKeys() + pinned
    }

    private fun serverKeys(): Map<String, ByteArray> {
        val raw = prefs.getString(K_SERVER_KEYS, null) ?: return emptyMap()
        return runCatching {
            EdgeCodec.json.parseToJsonElement(raw).jsonObject.mapValues { (_, v) ->
                LicenceVerifier.hexKey((v as JsonPrimitive).content)
            }
        }.getOrDefault(emptyMap())
    }

    /** Debug only: GET /api/v1/auth/jwks and keep its OKP/Ed25519 keys as kid → hex. */
    private fun fetchServerKeys(base: String) {
        val body = runCatching {
            val req = Request.Builder().url("$base/api/v1/auth/jwks").get().build()
            http.newCall(req).execute().use { r -> if (r.isSuccessful) r.body?.string() else null }
        }.getOrNull() ?: return
        val keys = runCatching {
            val list = EdgeCodec.json.parseToJsonElement(body).jsonObject["keys"] as? JsonArray
            list.orEmpty().mapNotNull { it as? JsonObject }
                .filter { it.str("kty") == "OKP" && it.str("crv") == "Ed25519" }
                .mapNotNull { jwk ->
                    val kid = jwk.str("kid") ?: return@mapNotNull null
                    val x = jwk.str("x") ?: return@mapNotNull null
                    val raw = java.util.Base64.getUrlDecoder().decode(x)
                    if (raw.size != 32) null else kid to raw.joinToString("") { "%02x".format(it) }
                }
                .toMap()
        }.getOrDefault(emptyMap())
        if (keys.isEmpty()) return
        val json = buildJsonObject { keys.forEach { (kid, hex) -> put(kid, hex) } }
        prefs.edit().putString(K_SERVER_KEYS, json.toString()).apply()
    }

    private fun post(url: String, body: JsonObject, bearer: String?): JsonObject {
        val request = try {
            val builder = Request.Builder()
                .url(url)
                .post(body.toString().toRequestBody(JSON))
            if (bearer != null) builder.header("Authorization", "Bearer $bearer")
            builder.build()
        } catch (e: IllegalArgumentException) {
            throw AccountException("The server address isn't valid")
        }
        val response = try {
            http.newCall(request).execute()
        } catch (e: IOException) {
            throw AccountException("Can't reach RootCause (${e.message ?: "no connection"}). Check the signal and try again.")
        }
        return response.use { r ->
            val text = r.body?.string().orEmpty()
            val obj = runCatching { EdgeCodec.json.parseToJsonElement(text).jsonObject }.getOrNull()
            if (!r.isSuccessful) {
                val detail = (obj?.get("detail") as? JsonPrimitive)?.contentOrNull
                throw AccountException(
                    when {
                        r.code == 401 && bearer != null -> "Your sign-in has expired. Sign in again."
                        detail != null -> detail
                        else -> "RootCause answered HTTP ${r.code}"
                    }
                )
            }
            obj ?: throw AccountException("RootCause sent an unreadable answer")
        }
    }

    private fun JsonObject.str(name: String): String? = (this[name] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull

    companion object {
        private const val PREFS = "rootcause_account"
        private const val K_SERVER = "server_url"
        private const val K_EMAIL = "email"
        private const val K_WORKSPACE = "workspace_name"
        private const val K_SESSION = "session_token"
        private const val K_SESSION_EXP = "session_expires_at"
        private const val K_LEASE = "lease_token"
        private const val K_SERVER_KEYS = "debug_server_keys"
        private val JSON = "application/json".toMediaType()

        /** Trims and drops a trailing slash; adds https:// when no scheme is given. */
        fun normalizeServer(raw: String): String {
            val t = raw.trim().trimEnd('/')
            if (t.isEmpty()) throw AccountException("Enter the RootCause server address")
            return if (t.startsWith("http://") || t.startsWith("https://")) t else "https://$t"
        }
    }
}
