package ai.youbrain.mobile

import ai.youbrain.mobile.net.LocalTty7TerminalServer
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
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class LocalTty7TerminalServerTest {
    @Test
    fun servesStaticAssetsAndBridgesBinaryAndTextWs() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val receivedText = CopyOnWriteArrayList<String>()
        val receivedBin = CopyOnWriteArrayList<ByteArray>()
        var openedDevice: String? = null

        val server = LocalTty7TerminalServer(
            scope = scope,
            loadAsset = { name ->
                when (name) {
                    "index.html" -> "<html><body>terminal</body></html>".toByteArray()
                    "xterm.js" -> "window.Terminal=function(){};".toByteArray()
                    else -> null
                }
            },
            openRemoteTerminal = { deviceId, listener ->
                openedDevice = deviceId
                listener.onOpen()
                object : UpstreamWs {
                    override fun sendText(text: String) {
                        receivedText.add(text)
                        listener.onMessageText("""{"type":"ready"}""")
                    }

                    override fun sendBinary(bytes: ByteArray) {
                        receivedBin.add(bytes)
                        listener.onMessageBinary(bytes)
                    }

                    override fun close(code: Int, reason: String) = Unit
                }
            },
        )

        try {
            val client = OkHttpClient()
            client.newCall(Request.Builder().url("${server.origin}/").build()).execute().use { resp ->
                assertEquals(200, resp.code)
                assertTrue(resp.body?.string().orEmpty().contains("terminal"))
            }
            client.newCall(Request.Builder().url("${server.origin}/xterm.js").build()).execute().use { resp ->
                assertEquals(200, resp.code)
                assertTrue(resp.body?.string().orEmpty().contains("Terminal"))
            }

            val gotReady = CountDownLatch(1)
            val gotBinary = CountDownLatch(1)
            val clientText = CopyOnWriteArrayList<String>()
            val clientBin = CopyOnWriteArrayList<ByteArray>()

            val ws = client.newWebSocket(
                Request.Builder().url("ws://127.0.0.1:${server.port}/ws?deviceId=dev-mac-1").build(),
                object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        webSocket.send("""{"type":"connect","pane":3}""")
                        webSocket.send(byteArrayOf(0x6c, 0x73, 0x0d).toByteString())
                    }

                    override fun onMessage(webSocket: WebSocket, text: String) {
                        clientText.add(text)
                        gotReady.countDown()
                    }

                    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                        clientBin.add(bytes.toByteArray())
                        gotBinary.countDown()
                    }
                },
            )

            assertTrue(gotReady.await(5, TimeUnit.SECONDS))
            assertTrue(gotBinary.await(5, TimeUnit.SECONDS))
            assertEquals("dev-mac-1", openedDevice)
            assertEquals(listOf("""{"type":"connect","pane":3}"""), receivedText)
            assertEquals(listOf("""{"type":"ready"}"""), clientText)
            assertEquals(1, receivedBin.size)
            assertEquals("ls\r", String(clientBin[0], Charsets.UTF_8))
            ws.close(1000, "done")
            client.dispatcher.executorService.shutdown()
        } finally {
            server.stop()
            scope.cancel()
        }
    }
}
