package ai.youbrain.mobile

import ai.youbrain.mobile.crypto.CommandSigner
import ai.youbrain.mobile.crypto.TunnelCrypto
import ai.youbrain.mobile.data.PeerPinStore
import ai.youbrain.mobile.net.CommandOutcome
import ai.youbrain.mobile.net.DecodedWsMessage
import ai.youbrain.mobile.net.TUNNEL_TTY7_HEADER
import ai.youbrain.mobile.net.TUNNEL_WS_GZIP_CAP
import ai.youbrain.mobile.net.TunnelClient
import ai.youbrain.mobile.net.WsReassembler
import ai.youbrain.mobile.net.encodeWsFrames
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.util.Random
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

class TunnelClientTest {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    @Test
    fun wsGzipCompressesLargeJsonAndSplitsMultipartFramesBelowRelayLimit() {
        val reassembler = WsReassembler()

        // 1) 大体积 T3 初始状态 JSON（约 220 KB），旧实现单帧不压缩会超 160 KB 中转上限导致隧道卡死
        val largeJson = buildString {
            append("""{"threads":[""")
            repeat(1500) { idx ->
                if (idx > 0) append(',')
                append("""{"id":"thread-$idx","title":"会话标题 $idx","summary":"包含较长上下文摘要内容用于测试压缩率与分片传输"}""")
            }
            append("]}")
        }
        assertTrue(largeJson.toByteArray(Charsets.UTF_8).size > 160 * 1024)

        val textFrames = encodeWsFrames(id = "ws-1", text = largeJson, binary = null, wsGzip = true)
        assertTrue(textFrames.isNotEmpty())
        for (frame in textFrames) {
            val rawFrameBytes = json.encodeToString(JsonObject.serializer(), frame).toByteArray(Charsets.UTF_8).size
            val estimatedRelaySize = ((rawFrameBytes + 24 + 2) / 3) * 4
            assertTrue("Frame must stay under 160KB relay max", estimatedRelaySize < TunnelCrypto.RELAY_FRAME_MAX)
        }

        var decodedText: DecodedWsMessage? = null
        for ((idx, f) in textFrames.withIndex()) {
            val out = reassembler.push(f)
            if (idx < textFrames.lastIndex) {
                assertNull(out)
            } else {
                decodedText = out
            }
        }
        assertEquals(largeJson, (decodedText as DecodedWsMessage.Text).text)

        // 2) 130 KB 不可压缩随机二进制帧：自动按 48 KB 分 3 片（more=true, more=true, 末片无 more）并无损重组
        val randomBytes = ByteArray(130 * 1024).also { Random(42L).nextBytes(it) }
        val binFrames = encodeWsFrames(id = "ws-2", text = null, binary = randomBytes, wsGzip = true)
        assertEquals(3, binFrames.size)

        var decodedBin: DecodedWsMessage? = null
        for ((idx, f) in binFrames.withIndex()) {
            val out = reassembler.push(f)
            if (idx < binFrames.lastIndex) {
                assertNull(out)
            } else {
                decodedBin = out
            }
        }
        assertArrayEquals(randomBytes, (decodedBin as DecodedWsMessage.Binary).bytes)
    }

    @Test
    fun negotiatesWsGzipResetsOnForceRefreshAndEvictsBrokenSessionOnSendFailure() {
        val dir = Files.createTempDirectory("tunnel-client-test-").toFile()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            val peerIdentity = CommandSigner.generateIdentity()
            val pins = PeerPinStore(dir.resolve("peers.json"))
            val handshakeCount = AtomicInteger(0)
            val advertisedCaps = CopyOnWriteArrayList<List<String>>()
            var lastFailureCallback: ((Throwable) -> Unit)? = null

            val client = TunnelClient(
                scope = scope,
                selfDeviceId = { "phone-1" },
                peerKey = { peerIdentity.publicKey },
                pins = pins,
                dispatchOpen = { to, sid, epk, caps ->
                    val attempt = handshakeCount.incrementAndGet()
                    advertisedCaps.add(caps)
                    // 模拟第一次握手超时、自动重试一次成功
                    if (attempt == 1) {
                        CommandOutcome.Err("等待目标设备结果超时")
                    } else {
                        val respEph = TunnelCrypto.newEphemeral()
                        val transcript = TunnelCrypto.tunnelTranscript(
                            sid = sid,
                            initiator = "phone-1",
                            responder = to,
                            initiatorKey = epk,
                            responderKey = respEph.publicKey,
                        )
                        val sig = CommandSigner.signText(peerIdentity.privateSeed, transcript)
                        CommandOutcome.Ok(
                            buildJsonObject {
                                put("epk", respEph.publicKey)
                                put("sig", sig)
                                put("caps", buildJsonArray { add(JsonPrimitive(TUNNEL_WS_GZIP_CAP)) })
                            },
                        )
                    }
                },
                sendTun = { _, _, _, onFailure ->
                    lastFailureCallback = onFailure
                },
            )

            runBlocking {
                // 首次连接遇到单次超时可自动重握手成功，且协商启用 wsGzip
                val s1 = client.session("mac-1")
                assertEquals(2, handshakeCount.get())
                assertTrue(s1.wsGzip)
                assertEquals(listOf(TUNNEL_WS_GZIP_CAP), advertisedCaps.last())
                assertFalse(s1.closed)

                // 手动强制刷新必须立刻作废旧会话并在下次请求重新握手
                client.forceResetSession("mac-1")
                assertTrue(s1.closed)
                val s2 = client.session("mac-1")
                assertNotSame(s1, s2)
                assertEquals(3, handshakeCount.get())

                // 中转投递失败（如对端掉线）时回调立刻关闭坏会话，避免后续请求苦等 60 秒超时
                runCatching { s2.pairCredential() }
                lastFailureCallback?.invoke(IllegalStateException("目标设备不在线"))
                assertTrue(s2.closed)

                val s3 = client.session("mac-1")
                assertNotSame(s2, s3)
                assertEquals(4, handshakeCount.get())
            }
        } finally {
            scope.cancel()
            dir.deleteRecursively()
        }
    }

    @Test
    fun tty7MarkerHeaderMatchesDaemonContract() {
        // 与 packages/core/src/dispatch/tunnel.ts 中的 TUNNEL_TTY7_HEADER 保持严格一致
        assertEquals("x-ubrain-tty7", TUNNEL_TTY7_HEADER)
    }
}
