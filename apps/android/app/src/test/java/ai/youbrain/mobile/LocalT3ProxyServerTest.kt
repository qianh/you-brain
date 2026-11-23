package ai.youbrain.mobile

import ai.youbrain.mobile.net.LocalT3ProxyServer
import ai.youbrain.mobile.net.T3Upstream
import ai.youbrain.mobile.net.TunnelHttpResponse
import ai.youbrain.mobile.net.UpstreamWs
import ai.youbrain.mobile.net.UpstreamWsListener
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.Socket
import java.net.URL
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class LocalT3ProxyServerTest {
    private data class RecordedCall(
        val method: String,
        val path: String,
        val headers: List<Pair<String, String>>,
        val body: ByteArray?,
    )

    private class FakeUpstream : T3Upstream {
        val calls = CopyOnWriteArrayList<RecordedCall>()
        var pairToken: String? = "pair-secret-001"
        var wsHeaders: List<Pair<String, String>> = emptyList()

        override suspend fun fetch(
            path: String,
            method: String,
            headers: List<Pair<String, String>>,
            body: ByteArray?,
        ): TunnelHttpResponse {
            calls.add(RecordedCall(method, path, headers, body))
            return when {
                path == "/" && method == "GET" -> TunnelHttpResponse(
                    status = 200,
                    statusText = "OK",
                    headers = listOf(
                        "Content-Type" to "text/html; charset=utf-8",
                        "X-Frame-Options" to "DENY",
                        "Content-Security-Policy" to "default-src 'self'; frame-ancestors 'none'; script-src 'self'",
                        "Set-Cookie" to "pref=dark; Domain=localhost; Path=/",
                    ),
                    body = "<html><head><title>T3</title></head><body>ok</body></html>".toByteArray(Charsets.UTF_8),
                )

                path == "/api/auth/session" && method == "GET" -> TunnelHttpResponse(
                    status = 200,
                    statusText = "OK",
                    headers = listOf("Content-Type" to "application/json"),
                    body = """{"authenticated":false}""".toByteArray(Charsets.UTF_8),
                )

                path == "/api/auth/browser-session" && method == "POST" -> TunnelHttpResponse(
                    status = 200,
                    statusText = "OK",
                    headers = listOf(
                        "Content-Type" to "application/json",
                        "Set-Cookie" to "t3_sid=session-xyz; Path=/; HttpOnly",
                    ),
                    body = """{"ok":true}""".toByteArray(Charsets.UTF_8),
                )

                path == "/api/echo" && method == "POST" -> TunnelHttpResponse(
                    status = 200,
                    statusText = "OK",
                    headers = listOf("Content-Type" to "text/plain; charset=utf-8"),
                    body = body ?: ByteArray(0),
                )

                else -> TunnelHttpResponse(404, "Not Found", emptyList(), "not found".toByteArray(Charsets.UTF_8))
            }
        }

        override suspend fun openSocket(
            path: String,
            headers: List<Pair<String, String>>,
            listener: UpstreamWsListener,
        ): UpstreamWs {
            wsHeaders = headers
            listener.onOpen()
            return object : UpstreamWs {
                override fun sendText(text: String) {
                    listener.onMessageText("echo:$text")
                }

                override fun sendBinary(bytes: ByteArray) {
                    listener.onMessageBinary(bytes.reversedArray())
                }

                override fun close(code: Int, reason: String) {
                    listener.onClose(code, reason)
                }
            }
        }

        override suspend fun pairCredential(): String? = pairToken
    }

    @Test
    fun cookieAndHeaderHelpersIsolateByDevicePrefix() {
        assertEquals(
            "devA__sid=123; Path=/; HttpOnly",
            LocalT3ProxyServer.prefixSetCookie("sid=123; Domain=example.com; Path=/; HttpOnly", "devA__"),
        )
        assertNull(LocalT3ProxyServer.prefixSetCookie("__Host-sid=123; Path=/", "devA__"))
        assertNull(LocalT3ProxyServer.prefixSetCookie("__Secure-sid=123; Path=/", "devA__"))

        assertEquals(
            "sid=123; theme=dark",
            LocalT3ProxyServer.stripCookiePrefix("devB__sid=999; devA__sid=123; raw=1; devA__theme=dark", "devA__"),
        )

        assertEquals(
            "default-src 'self'; script-src 'self'",
            LocalT3ProxyServer.stripFrameAncestors("default-src 'self'; frame-ancestors 'none'; script-src 'self'"),
        )
        assertNull(LocalT3ProxyServer.stripFrameAncestors("frame-ancestors *"))

        val injected = LocalT3ProxyServer.injectHtml("<html><head><title>x</title></head><body>y</body></html>")
        assertTrue(injected.contains("""<script src="/__ubrain_t3_inject.js"></script></head>"""))
    }

    @Test
    fun htmlNavigationAutoPairsStripsFrameHeadersAndIsolatesCookies() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val upstream = FakeUpstream()
        val capturedSetCookies = CopyOnWriteArrayList<String>()
        val proxy = LocalT3ProxyServer(
            scope = scope,
            upstream = upstream,
            cookiePrefix = "dev_a__",
            preferredPort = 0,
            onSetCookies = { _, cookies -> capturedSetCookies.addAll(cookies) },
        )

        try {
            val conn = (URL("${proxy.baseUrl}").openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                setRequestProperty("Accept", "text/html")
            }
            assertEquals(200, conn.responseCode)
            val body = conn.inputStream.bufferedReader().readText()
            assertTrue(body.contains("""<script src="/__ubrain_t3_inject.js"></script>"""))
            assertNull(conn.getHeaderField("X-Frame-Options"))
            val csp = conn.getHeaderField("Content-Security-Policy").orEmpty()
            assertTrue(!csp.contains("frame-ancestors"))

            val setCookies = conn.headerFields["Set-Cookie"].orEmpty()
            assertTrue(setCookies.any { it.startsWith("dev_a__pref=dark") })
            assertTrue(setCookies.any { it.startsWith("dev_a__t3_sid=session-xyz") })
            assertTrue(capturedSetCookies.any { it.startsWith("dev_a__t3_sid=session-xyz") })

            val pairCall = upstream.calls.firstOrNull { it.path == "/api/auth/browser-session" }
            assertEquals("""{"credential":"pair-secret-001"}""", String(pairCall!!.body!!, Charsets.UTF_8))

            // 验证 POST 与 Cookie 前缀隔离：只透传 dev_a__ 去掉前缀后的 Cookie
            val postConn = (URL("${proxy.origin}/api/echo").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                setRequestProperty("Cookie", "dev_a__t3_sid=session-xyz; dev_b__t3_sid=other-dev")
                outputStream.use { it.write("payload-123".toByteArray(Charsets.UTF_8)) }
            }
            assertEquals(200, postConn.responseCode)
            assertEquals("payload-123", postConn.inputStream.bufferedReader().readText())

            val echoCall = upstream.calls.last { it.path == "/api/echo" }
            val forwardedCookie = echoCall.headers.firstOrNull { it.first.equals("cookie", ignoreCase = true) }?.second
            assertEquals("t3_sid=session-xyz", forwardedCookie)
        } finally {
            proxy.stop()
            scope.cancel()
        }
    }

    @Test
    fun websocketRelaysTextAndBinaryBidirectionally() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val upstream = FakeUpstream()
        val proxy = LocalT3ProxyServer(
            scope = scope,
            upstream = upstream,
            cookiePrefix = "dev_ws__",
            preferredPort = 0,
        )
        val client = OkHttpClient.Builder().readTimeout(5, TimeUnit.SECONDS).build()
        val opened = CountDownLatch(1)
        val gotText = CountDownLatch(1)
        val gotBin = CountDownLatch(1)
        var textReply = ""
        var binReply = ByteArray(0)

        try {
            val req = Request.Builder()
                .url("ws://127.0.0.1:${proxy.port}/ws?thread=1")
                .addHeader("Cookie", "dev_ws__t3_sid=ws-tok; other__x=bad")
                .build()
            val ws = client.newWebSocket(
                req,
                object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        opened.countDown()
                    }

                    override fun onMessage(webSocket: WebSocket, text: String) {
                        textReply = text
                        gotText.countDown()
                    }

                    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                        binReply = bytes.toByteArray()
                        gotBin.countDown()
                    }
                },
            )

            assertTrue("WebSocket should open", opened.await(5, TimeUnit.SECONDS))
            assertTrue(ws.send("hello-t3"))
            assertTrue(ws.send(byteArrayOf(1, 2, 3, 4).toByteString()))

            assertTrue("Should receive echoed text", gotText.await(5, TimeUnit.SECONDS))
            assertTrue("Should receive reversed binary", gotBin.await(5, TimeUnit.SECONDS))
            assertEquals("echo:hello-t3", textReply)
            assertEquals(listOf<Byte>(4, 3, 2, 1), binReply.toList())
            val wsCookie = upstream.wsHeaders.firstOrNull { it.first.equals("cookie", ignoreCase = true) }?.second
            assertEquals("t3_sid=ws-tok", wsCookie)

            ws.close(1000, "done")
        } finally {
            client.dispatcher.executorService.shutdown()
            proxy.stop()
            scope.cancel()
        }
    }

    @Test
    fun keepAliveReusesSingleTcpSocketAndSkipsRedundantAuthProbe() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val upstream = FakeUpstream()
        val proxy = LocalT3ProxyServer(
            scope = scope,
            upstream = upstream,
            cookiePrefix = "dev_ka__",
            preferredPort = 0,
        )

        try {
            // 首次导航触发一次 pair 登录
            val firstConn = (URL(proxy.baseUrl).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                setRequestProperty("Accept", "text/html")
                setRequestProperty("Connection", "close")
            }
            assertEquals(200, firstConn.responseCode)
            firstConn.inputStream.close()
            assertEquals(1, upstream.calls.count { it.path == "/api/auth/browser-session" })

            // 在同一条 TCP Socket 上连续发送两条 HTTP/1.1 Keep-Alive 请求（包括第二次 HTML 导航）
            Socket("127.0.0.1", proxy.port).use { tcp ->
                tcp.soTimeout = 5_000
                val out = tcp.getOutputStream()
                val inp = tcp.getInputStream()

                fun readRawResponse(): String {
                    val buf = ByteArrayOutputStream()
                    while (true) {
                        val b = inp.read()
                        if (b == -1) break
                        buf.write(b)
                        val s = buf.toString(Charsets.ISO_8859_1.name())
                        val idx = s.indexOf("\r\n\r\n")
                        if (idx != -1) {
                            val head = s.substring(0, idx)
                            val lenMatch = Regex("Content-Length:\\s*(\\d+)", RegexOption.IGNORE_CASE).find(head)
                            val len = lenMatch?.groupValues?.get(1)?.toIntOrNull() ?: 0
                            val bodyBytes = ByteArray(len)
                            var read = 0
                            while (read < len) {
                                val n = inp.read(bodyBytes, read, len - read)
                                if (n <= 0) break
                                read += n
                            }
                            return head + "\r\n\r\n" + String(bodyBytes, Charsets.UTF_8)
                        }
                    }
                    return ""
                }

                out.write("GET / HTTP/1.1\r\nHost: 127.0.0.1:${proxy.port}\r\nAccept: text/html\r\nCookie: dev_ka__t3_sid=session-xyz\r\n\r\n".toByteArray())
                out.flush()
                val resp1 = readRawResponse()
                assertTrue(resp1.contains("HTTP/1.1 200 OK"))
                assertTrue(resp1.contains("Connection: keep-alive"))
                assertTrue(resp1.contains("<title>T3</title>"))

                // 复用同一条连接发第二条请求，并要求 close
                out.write("POST /api/echo HTTP/1.1\r\nHost: 127.0.0.1:${proxy.port}\r\nCookie: dev_ka__t3_sid=session-xyz\r\nContent-Length: 4\r\nConnection: close\r\n\r\nping".toByteArray())
                out.flush()
                val resp2 = readRawResponse()
                assertTrue(resp2.contains("HTTP/1.1 200 OK"))
                assertTrue(resp2.endsWith("\r\n\r\nping"))
            }

            // 10 分钟认证缓存窗口内，第二次 HTML 导航不再重复打 /api/auth/session 与 /api/auth/browser-session
            assertEquals(0, upstream.calls.count { it.path == "/api/auth/session" })
            assertEquals(1, upstream.calls.count { it.path == "/api/auth/browser-session" })
        } finally {
            proxy.stop()
            scope.cancel()
        }
    }
}
