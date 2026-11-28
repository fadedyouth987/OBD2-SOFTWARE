package au.com.rootcauseobd.daemonlink

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

class DaemonLinkException(message: String) : CodedException(message)

/**
 * Trusts exactly one certificate: the workshop PC's, whose SHA-256 (over the
 * DER encoding) the phone learned from the pairing QR code. No certificate
 * authority, no system trust store, no user-installed CAs: anything else fails
 * the TLS handshake before a single byte of the request is sent.
 */
class PinnedTrustManager(private val pinHex: String) : X509TrustManager {
  @Volatile var mismatch = false

  override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {
    throw CertificateException("client certificates are not used")
  }

  override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
    val leaf = chain?.firstOrNull() ?: throw CertificateException("no certificate")
    val got = MessageDigest.getInstance("SHA-256").digest(leaf.encoded)
    val want = pinHex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    if (!MessageDigest.isEqual(got, want)) {
      mismatch = true
      throw CertificateException("the PC's certificate does not match the pairing")
    }
  }

  override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
}

private class Link(val id: String, val trust: PinnedTrustManager) {
  @Volatile var socket: WebSocket? = null
  @Volatile var opened = false
}

private val PIN = Regex("^[0-9a-f]{64}$")
private val ID = Regex("^[A-Za-z0-9_-]{1,64}$")
private val AUTH = Regex("^(Bearer lan_[0-9a-f]{16}\\.[A-Za-z0-9_-]{43}|RootCause-Pair [A-Za-z0-9_-]{43})$")

/**
 * WebSocket connections to the workshop PC's edge daemon over the local
 * network, for the web view (which can't pin a self-signed certificate or set
 * headers on a WebSocket). Every connection pins the PC's certificate and sends
 * the web app's origin plus this phone's credential (or single-use pairing
 * code) in the upgrade request. What goes over it is the normal daemon
 * protocol; the daemon's safety interlock decides what may reach the car.
 */
class DaemonLinkModule : Module() {
  private val links = ConcurrentHashMap<String, Link>()
  private val base: OkHttpClient by lazy {
    OkHttpClient.Builder()
      .connectTimeout(8, TimeUnit.SECONDS)
      .readTimeout(0, TimeUnit.MILLISECONDS)
      .pingInterval(20, TimeUnit.SECONDS)
      .build()
  }

  override fun definition() = ModuleDefinition {
    Name("DaemonLink")
    Events("onOpen", "onMessage", "onClose")

    AsyncFunction("connect") { id: String, url: String, pin: String, authorization: String, origin: String ->
      if (!ID.matches(id)) throw DaemonLinkException("bad connection id")
      if (!url.startsWith("wss://")) throw DaemonLinkException("only wss:// addresses are allowed")
      if (!PIN.matches(pin)) throw DaemonLinkException("bad certificate fingerprint")
      if (!AUTH.matches(authorization)) throw DaemonLinkException("bad credential")
      if (!origin.startsWith("https://") && !origin.startsWith("http://")) throw DaemonLinkException("bad origin")
      links.remove(id)?.socket?.cancel()

      val trust = PinnedTrustManager(pin)
      val tls = SSLContext.getInstance("TLS")
      tls.init(null, arrayOf(trust), SecureRandom())
      val client = base.newBuilder()
        .sslSocketFactory(tls.socketFactory, trust)
        // The PC is identified by the pinned certificate, not by a name in it
        // (its address is a LAN IP that changes); the pin is the stronger check.
        .hostnameVerifier { _, _ -> true }
        .build()
      val request = Request.Builder()
        .url(url)
        .header("Origin", origin)
        .header("Authorization", authorization)
        .build()
      val link = Link(id, trust)
      links[id] = link
      link.socket = client.newWebSocket(request, listener(link))
    }

    AsyncFunction("send") { id: String, text: String ->
      links[id]?.socket?.send(text) ?: false
    }

    AsyncFunction("close") { id: String ->
      // Closed by the web app: no onClose event for it.
      links.remove(id)?.socket?.close(1000, null)
      Unit
    }

    OnDestroy {
      links.values.forEach { it.socket?.cancel() }
      links.clear()
    }
  }

  private fun listener(link: Link) = object : WebSocketListener() {
    override fun onOpen(webSocket: WebSocket, response: Response) {
      link.opened = true
      if (links[link.id] === link) sendEvent("onOpen", mapOf("id" to link.id))
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
      if (links[link.id] === link) sendEvent("onMessage", mapOf("id" to link.id, "text" to text))
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
      webSocket.close(1000, null)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
      finish(link, "closed", reason.ifEmpty { null })
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
      val status = response?.code
      val (reason, detail) = when {
        link.opened -> "closed" to null
        link.trust.mismatch -> "identity" to null
        status == 401 -> "revoked" to null
        status == 403 -> "rejected" to "it doesn't allow this app's web address or this network name"
        status == 429 -> "rejected" to "too many attempts; wait 5 minutes"
        status != null -> "rejected" to "HTTP $status"
        else -> "unreachable" to (t.message ?: t.javaClass.simpleName)
      }
      finish(link, reason, detail)
    }
  }

  private fun finish(link: Link, reason: String, detail: String?) {
    if (!links.remove(link.id, link)) return
    sendEvent(
      "onClose",
      mapOf("id" to link.id, "wasOpen" to link.opened, "reason" to reason, "detail" to detail),
    )
  }
}
