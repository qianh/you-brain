package ai.youbrain.mobile

import ai.youbrain.mobile.net.UpstreamWs
import ai.youbrain.mobile.net.UpstreamWsListener
import ai.youbrain.mobile.ui.terminal.NativeTerminalSession
import ai.youbrain.mobile.ui.terminal.TerminalConnectionStatus
import ai.youbrain.mobile.ui.terminal.TerminalGridSize
import ai.youbrain.mobile.ui.terminal.TerminalSessionSnapshot
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class NativeTerminalSessionTest {
    @Test
    fun buffersReplaySilentlyMutesQueriesAndRevealsAtFinalScreen() {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        val sentText = CopyOnWriteArrayList<String>()
        val sentBinary = CopyOnWriteArrayList<ByteArray>()
        val states = CopyOnWriteArrayList<TerminalSessionSnapshot>()
        val revealedLatch = CountDownLatch(1)
        var capturedListener: UpstreamWsListener? = null

        val session = NativeTerminalSession(
            scope = scope,
            pane = 4,
            initialSize = TerminalGridSize(cols = 60, rows = 24, cellW = 12, cellH = 24),
            isDarkInitial = true,
            openSocket = { listener ->
                capturedListener = listener
                object : UpstreamWs {
                    override fun sendText(text: String) {
                        sentText.add(text)
                    }

                    override fun sendBinary(bytes: ByteArray) {
                        sentBinary.add(bytes)
                    }

                    override fun close(code: Int, reason: String) = Unit
                }
            },
            onStateChanged = { snap ->
                states.add(snap)
                if (snap.revealed) revealedLatch.countDown()
            },
            onScreenDirty = { _ -> },
        )

        try {
            session.start()
            // 等待 openSocket 注册完成
            val deadline = System.currentTimeMillis() + 3_000L
            while (capturedListener == null && System.currentTimeMillis() < deadline) {
                Thread.sleep(10)
            }
            val listener = capturedListener!!
            listener.onOpen()

            assertTrue(sentText.any { it.contains(""""type":"connect"""") && it.contains(""""maxReplayBytes":98304""") })

            listener.onMessageText("""{"type":"ready"}""")
            listener.onMessageText("""{"type":"size","size":{"cols":120,"rows":30,"cell_w":9,"cell_h":18}}""")
            // 包含 DA1 查询（\x1b[c）和中文宽字符的历史回放
            listener.onMessageBinary("\u001b[c第一行历史\r\n╭── 标题 ──╮\r\n最新一行输出".toByteArray(Charsets.UTF_8))

            // 收到 live 前不揭幕，且回放中的终端查询不会回写给对端
            assertFalse(states.lastOrNull()?.revealed == true)
            assertTrue(sentBinary.isEmpty())

            listener.onMessageText("""{"type":"live"}""")
            assertTrue(revealedLatch.await(3, TimeUnit.SECONDS))

            assertEquals(TerminalConnectionStatus.READY, states.last().status)
            assertTrue(states.last().revealed)
            // 揭幕后切回手机目标尺寸 60x24 并通知对端重绘
            assertEquals(60, session.withEmulator { it.mColumns })
            assertEquals(24, session.withEmulator { it.mRows })
            assertTrue(sentText.any { it.contains(""""type":"resize"""") && it.contains(""""cols":60""") })
            assertTrue(sentBinary.isEmpty())

            val visible = session.copyVisibleScreen()
            assertTrue(visible.contains("第一行历史"))
            assertTrue(visible.contains("最新一行输出"))
        } finally {
            session.close()
            scope.cancel()
        }
    }
}
