package ai.youbrain.mobile.ui.terminal

import ai.youbrain.mobile.net.UpstreamWs
import ai.youbrain.mobile.net.UpstreamWsListener
import com.termux.terminal.TerminalEmulator
import com.termux.terminal.TerminalOutput
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import com.termux.terminal.TextStyle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.ByteArrayOutputStream

data class TerminalGridSize(
    val cols: Int,
    val rows: Int,
    val cellW: Int,
    val cellH: Int,
)

enum class TerminalConnectionStatus {
    CONNECTING,
    READY,
    DISCONNECTED,
    EXITED,
    ERROR,
}

data class TerminalSessionSnapshot(
    val status: TerminalConnectionStatus = TerminalConnectionStatus.CONNECTING,
    val detail: String = "",
    val warning: String = "",
    val leaseHolder: String = "",
    val revealed: Boolean = false,
    val replayBytesReceived: Int = 0,
    val isDark: Boolean = true,
)

/**
 * 原生终端会话控制器：
 * - 直接对接端到端加密隧道 `UpstreamWs` 二进制流，零 WebView / 本地代理中转开销。
 * - 使用 Termux 纯 Java `TerminalEmulator` 状态机解析 VT100/ANSI/TrueColor/UTF-8/WcWidth。
 * - 初始回放在后台静默缓冲并按原尺寸一次性解析完毕后再亮屏，彻底消除“从头滚到尾”与宽屏历史撕裂。
 */
class NativeTerminalSession(
    private val scope: CoroutineScope,
    private val pane: Int,
    private val initialSize: TerminalGridSize,
    private val isDarkInitial: Boolean,
    private val openSocket: suspend (UpstreamWsListener) -> UpstreamWs,
    private val onStateChanged: (TerminalSessionSnapshot) -> Unit,
    private val onScreenDirty: (scrollToBottom: Boolean) -> Unit,
    private val maxReplayBytes: Int = MOBILE_MAX_REPLAY_BYTES,
) {
    companion object {
        const val MOBILE_MAX_REPLAY_BYTES = 96 * 1024
        private const val TRANSCRIPT_ROWS = 2_000
        // 等待完整回放流到达：严禁因弱网短暂停顿（如 280ms）提前揭幕导致从头滚到尾与错位。
        private const val REPLAY_QUIET_MS = 1_200L
        private const val REPLAY_EMPTY_WAIT_MS = 1_500L
        private const val REPLAY_MAX_WAIT_MS = 12_000L

        private val DARK_ANSI_16 = intArrayOf(
            0xFF18181B.toInt(), // 0 black
            0xFFF87171.toInt(), // 1 red
            0xFF4ADE80.toInt(), // 2 green
            0xFFFACC15.toInt(), // 3 yellow
            0xFF60A5FA.toInt(), // 4 blue
            0xFFC084FC.toInt(), // 5 magenta
            0xFF22D3EE.toInt(), // 6 cyan
            0xFFE4E4E7.toInt(), // 7 white
            0xFF71717A.toInt(), // 8 bright black
            0xFFFCA5A5.toInt(), // 9 bright red
            0xFF86EFAC.toInt(), // 10 bright green
            0xFFFDE047.toInt(), // 11 bright yellow
            0xFF93C5FD.toInt(), // 12 bright blue
            0xFFD8B4FE.toInt(), // 13 bright magenta
            0xFF67E8F9.toInt(), // 14 bright cyan
            0xFFFAFAFA.toInt(), // 15 bright white
        )

        private val LIGHT_ANSI_16 = intArrayOf(
            0xFF18181B.toInt(), // 0 black
            0xFFDC2626.toInt(), // 1 red
            0xFF16A34A.toInt(), // 2 green
            0xFFCA8A04.toInt(), // 3 yellow
            0xFF2563EB.toInt(), // 4 blue
            0xFF9333EA.toInt(), // 5 magenta
            0xFF0891B2.toInt(), // 6 cyan
            0xFFD4D4D8.toInt(), // 7 white
            0xFF52525B.toInt(), // 8 bright black
            0xFFEF4444.toInt(), // 9 bright red
            0xFF22C55E.toInt(), // 10 bright green
            0xFFEAB308.toInt(), // 11 bright yellow
            0xFF3B82F6.toInt(), // 12 bright blue
            0xFFA855F7.toInt(), // 13 bright magenta
            0xFF06B6D4.toInt(), // 14 bright cyan
            0xFF18181B.toInt(), // 15 bright white
        )

        const val DARK_BG = 0xFF111216.toInt()
        const val DARK_FG = 0xFFE4E4E7.toInt()
        const val DARK_CURSOR = 0xFFF4F4F5.toInt()

        const val LIGHT_BG = 0xFFF8F9FB.toInt()
        const val LIGHT_FG = 0xFF18181B.toInt()
        const val LIGHT_CURSOR = 0xFF0A84FF.toInt()
    }

    private val lock = Any()
    private val json = Json { ignoreUnknownKeys = true }

    @Volatile
    private var closed = false
    private var connected = false
    private var wsOpened = false
    private var connectSent = false
    private var replaying = true
    private var revealed = false
    private var hasLease = true
    private var isDark = isDarkInitial

    private var currentTargetSize: TerminalGridSize = initialSize
    private var lastServerSize: TerminalGridSize? = null
    private var replayHintSize: TerminalGridSize? = null
    private val replayBuffer = ByteArrayOutputStream()

    private var remoteWs: UpstreamWs? = null
    private var connectJob: Job? = null
    private var quietRevealJob: Job? = null
    private var maxRevealJob: Job? = null

    private var snapshot = TerminalSessionSnapshot(isDark = isDarkInitial)

    private val terminalOutput = object : TerminalOutput() {
        override fun write(data: ByteArray, offset: Int, count: Int) {
            if (count <= 0) return
            val ws: UpstreamWs?
            synchronized(lock) {
                // 回放阶段严禁将终端查询应答（DA/DSR/OSC）回写给原会话。
                if (closed || !connected || replaying) return
                ws = remoteWs
            }
            val slice = if (offset == 0 && count == data.size) data else data.copyOfRange(offset, offset + count)
            ws?.sendBinary(slice)
        }

        override fun titleChanged(oldTitle: String?, newTitle: String?) = Unit
        override fun onCopyTextToClipboard(text: String?) = Unit
        override fun onPasteTextFromClipboard() = Unit
        override fun onBell() = Unit
        override fun onColorsChanged() {
            onScreenDirty(false)
        }
    }

    private val sessionClient = object : TerminalSessionClient {
        override fun onTextChanged(changedSession: TerminalSession?) = Unit
        override fun onTitleChanged(changedSession: TerminalSession?) = Unit
        override fun onSessionFinished(finishedSession: TerminalSession?) = Unit
        override fun onCopyTextToClipboard(session: TerminalSession?, text: String?) = Unit
        override fun onPasteTextFromClipboard(session: TerminalSession?) = Unit
        override fun onBell(session: TerminalSession?) = Unit
        override fun onColorsChanged(session: TerminalSession?) = Unit
        override fun onTerminalCursorStateChange(state: Boolean) {
            onScreenDirty(false)
        }
        override fun getTerminalCursorStyle(): Int = TerminalEmulator.DEFAULT_TERMINAL_CURSOR_STYLE
        override fun logError(tag: String?, message: String?) = Unit
        override fun logWarn(tag: String?, message: String?) = Unit
        override fun logInfo(tag: String?, message: String?) = Unit
        override fun logDebug(tag: String?, message: String?) = Unit
        override fun logVerbose(tag: String?, message: String?) = Unit
        override fun logStackTraceWithMessage(tag: String?, message: String?, e: Exception?) = Unit
        override fun logStackTrace(tag: String?, e: Exception?) = Unit
    }

    private var emulator: TerminalEmulator = createEmulator(initialSize.cols, initialSize.rows, isDarkInitial)

    private fun createEmulator(cols: Int, rows: Int, dark: Boolean): TerminalEmulator {
        val em = TerminalEmulator(
            terminalOutput,
            cols.coerceIn(20, 400),
            rows.coerceIn(6, 200),
            TRANSCRIPT_ROWS,
            sessionClient,
        )
        applyPaletteLocked(em, dark)
        return em
    }

    private fun applyPaletteLocked(em: TerminalEmulator, dark: Boolean) {
        val ansi = if (dark) DARK_ANSI_16 else LIGHT_ANSI_16
        val colors = em.mColors.mCurrentColors
        for (i in 0 until 16) {
            colors[i] = ansi[i]
        }
        colors[TextStyle.COLOR_INDEX_FOREGROUND] = if (dark) DARK_FG else LIGHT_FG
        colors[TextStyle.COLOR_INDEX_BACKGROUND] = if (dark) DARK_BG else LIGHT_BG
        colors[TextStyle.COLOR_INDEX_CURSOR] = if (dark) DARK_CURSOR else LIGHT_CURSOR
    }

    fun <T> withEmulator(block: (TerminalEmulator) -> T): T = synchronized(lock) { block(emulator) }

    fun setTheme(dark: Boolean) {
        val changed: Boolean
        synchronized(lock) {
            changed = (isDark != dark)
            isDark = dark
            applyPaletteLocked(emulator, dark)
            snapshot = snapshot.copy(isDark = dark)
        }
        if (changed) {
            emitState()
            onScreenDirty(false)
        }
    }

    fun start() {
        reconnect()
    }

    fun reconnect() {
        connectJob?.cancel()
        cancelRevealTimers()
        val oldWs: UpstreamWs?
        synchronized(lock) {
            if (closed) return
            oldWs = remoteWs
            remoteWs = null
            connected = false
            wsOpened = false
            connectSent = false
            replaying = true
            revealed = false
            hasLease = true
            lastServerSize = null
            replayHintSize = null
            replayBuffer.reset()
            emulator = createEmulator(currentTargetSize.cols, currentTargetSize.rows, isDark)
            snapshot = TerminalSessionSnapshot(
                status = TerminalConnectionStatus.CONNECTING,
                detail = "",
                warning = "",
                leaseHolder = "",
                revealed = false,
                isDark = isDark,
            )
        }
        runCatching { oldWs?.close(1000, "reconnect") }
        emitState()
        onScreenDirty(true)

        connectJob = scope.launch(Dispatchers.IO) {
            fun maybeSendConnect() {
                val ws: UpstreamWs
                val sz: TerminalGridSize
                synchronized(lock) {
                    if (closed || !wsOpened || connectSent) return
                    ws = remoteWs ?: return
                    connectSent = true
                    sz = currentTargetSize
                    lastServerSize = sz
                }
                ws.sendText(buildConnectPayload(sz))
            }

            val listener = object : UpstreamWsListener {
                override fun onOpen() {
                    synchronized(lock) {
                        if (closed) return
                        wsOpened = true
                    }
                    maybeSendConnect()
                }

                override fun onMessageText(text: String) {
                    handleControlMessage(text)
                }

                override fun onMessageBinary(bytes: ByteArray) {
                    handleBinaryOutput(bytes)
                }

                override fun onClose(code: Int, reason: String) {
                    val shouldUpdate: Boolean
                    synchronized(lock) {
                        if (closed) return
                        val wasExited = snapshot.status == TerminalConnectionStatus.EXITED
                        val wasErr = snapshot.status == TerminalConnectionStatus.ERROR
                        connected = false
                        replaying = false
                        if (!revealed) revealLocked(sendResizeIfNeeded = false)
                        shouldUpdate = !wasExited && !wasErr
                        if (shouldUpdate) {
                            snapshot = snapshot.copy(
                                status = TerminalConnectionStatus.DISCONNECTED,
                                detail = reason.ifBlank { "连接已断开" },
                                revealed = true,
                            )
                        }
                    }
                    cancelRevealTimers()
                    if (shouldUpdate) emitState()
                    onScreenDirty(false)
                }

                override fun onError() {
                    synchronized(lock) {
                        if (closed) return
                        connected = false
                        replaying = false
                        if (!revealed) revealLocked(sendResizeIfNeeded = false)
                        snapshot = snapshot.copy(
                            status = TerminalConnectionStatus.ERROR,
                            detail = "终端连接中断",
                            revealed = true,
                        )
                    }
                    cancelRevealTimers()
                    emitState()
                    onScreenDirty(false)
                }
            }

            try {
                val ws = openSocket(listener)
                synchronized(lock) {
                    if (closed) {
                        runCatching { ws.close(1000, "closed") }
                        return@launch
                    }
                    remoteWs = ws
                }
                maybeSendConnect()
            } catch (t: Throwable) {
                synchronized(lock) {
                    if (closed) return@launch
                    connected = false
                    replaying = false
                    revealed = true
                    snapshot = snapshot.copy(
                        status = TerminalConnectionStatus.ERROR,
                        detail = t.message ?: "无法连接对端终端",
                        revealed = true,
                    )
                }
                emitState()
            }
        }
    }

    private fun buildConnectPayload(size: TerminalGridSize): String {
        val obj = buildJsonObject {
            put("type", "connect")
            put("pane", pane)
            put(
                "size",
                buildJsonObject {
                    put("cols", size.cols)
                    put("rows", size.rows)
                    put("cell_w", size.cellW)
                    put("cell_h", size.cellH)
                },
            )
            put("maxReplayBytes", maxReplayBytes)
        }
        return json.encodeToString(kotlinx.serialization.json.JsonObject.serializer(), obj)
    }

    private fun buildResizePayload(size: TerminalGridSize): String {
        val obj = buildJsonObject {
            put("type", "resize")
            put(
                "size",
                buildJsonObject {
                    put("cols", size.cols)
                    put("rows", size.rows)
                    put("cell_w", size.cellW)
                    put("cell_h", size.cellH)
                },
            )
        }
        return json.encodeToString(kotlinx.serialization.json.JsonObject.serializer(), obj)
    }

    private fun handleBinaryOutput(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        var notifyUi = false
        var shouldArmQuiet = false
        var emitProgress = false
        synchronized(lock) {
            if (closed) return
            if (!revealed) {
                val prevKb = replayBuffer.size() / 8192
                replayBuffer.write(bytes)
                val nextSize = replayBuffer.size()
                if (nextSize / 8192 != prevKb || prevKb == 0) {
                    snapshot = snapshot.copy(replayBytesReceived = nextSize)
                    emitProgress = true
                }
                shouldArmQuiet = true
            } else {
                emulator.append(bytes, bytes.size)
                notifyUi = true
            }
        }
        if (emitProgress) emitState()
        if (shouldArmQuiet) armQuietReveal(REPLAY_QUIET_MS)
        if (notifyUi) onScreenDirty(false)
    }

    private fun handleControlMessage(rawText: String) {
        val obj = runCatching { json.parseToJsonElement(rawText).jsonObject }.getOrNull() ?: return
        val type = obj["type"]?.jsonPrimitive?.contentOrNull ?: return
        var stateChanged = false
        var screenDirty = false
        var scrollBottom = false
        var startTimers = false
        var cancelTimers = false
        var pendingResize: TerminalGridSize? = null
        val wsToSend: UpstreamWs?

        synchronized(lock) {
            if (closed) return
            wsToSend = remoteWs
            when (type) {
                "ready" -> {
                    connected = true
                    snapshot = snapshot.copy(status = TerminalConnectionStatus.READY, detail = "")
                    stateChanged = true
                    startTimers = true
                }
                "live" -> {
                    replaying = false
                    cancelTimers = true
                    if (!revealed) {
                        pendingResize = revealLocked(sendResizeIfNeeded = true)
                        stateChanged = true
                        screenDirty = true
                        scrollBottom = true
                    } else if (hasLease && (lastServerSize == null || lastServerSize!!.cols != currentTargetSize.cols || lastServerSize!!.rows != currentTargetSize.rows)) {
                        emulator.resize(currentTargetSize.cols, currentTargetSize.rows)
                        lastServerSize = currentTargetSize
                        pendingResize = currentTargetSize
                        screenDirty = true
                    }
                }
                "size" -> {
                    val szObj = obj["size"]?.jsonObject
                    val cols = szObj?.get("cols")?.jsonPrimitive?.intOrNull
                    val rows = szObj?.get("rows")?.jsonPrimitive?.intOrNull
                    val cw = szObj?.get("cell_w")?.jsonPrimitive?.intOrNull ?: currentTargetSize.cellW
                    val ch = szObj?.get("cell_h")?.jsonPrimitive?.intOrNull ?: currentTargetSize.cellH
                    if (cols != null && rows != null && cols in 20..400 && rows in 6..200) {
                        val srv = TerminalGridSize(cols, rows, cw.coerceAtLeast(1), ch.coerceAtLeast(1))
                        lastServerSize = srv
                        if (!revealed) {
                            replayHintSize = srv
                        } else if (!hasLease) {
                            emulator.resize(srv.cols, srv.rows)
                            screenDirty = true
                        }
                    }
                }
                "lease" -> {
                    val by = obj["by"]?.jsonPrimitive?.contentOrNull
                    val ours = by == null || by == "U-Brain"
                    hasLease = ours
                    snapshot = snapshot.copy(leaseHolder = if (ours) "" else by.ifBlank { "桌面窗口" })
                    stateChanged = true
                    if (!ours) {
                        lastServerSize?.let { srv ->
                            emulator.resize(srv.cols, srv.rows)
                            screenDirty = true
                        }
                    } else if (revealed) {
                        emulator.resize(currentTargetSize.cols, currentTargetSize.rows)
                        lastServerSize = currentTargetSize
                        pendingResize = currentTargetSize
                        screenDirty = true
                    }
                }
                "warning" -> {
                    val msg = obj["message"]?.jsonPrimitive?.contentOrNull.orEmpty()
                    snapshot = snapshot.copy(warning = msg)
                    stateChanged = true
                }
                "exit" -> {
                    val code = obj["code"]?.jsonPrimitive?.intOrNull
                    connected = false
                    replaying = false
                    cancelTimers = true
                    if (!revealed) {
                        revealLocked(sendResizeIfNeeded = false)
                        scrollBottom = true
                    }
                    snapshot = snapshot.copy(
                        status = TerminalConnectionStatus.EXITED,
                        detail = if (code == null) "会话已结束" else "会话已退出（退出码 $code）",
                        revealed = true,
                    )
                    stateChanged = true
                    screenDirty = true
                }
                "error" -> {
                    val msg = obj["message"]?.jsonPrimitive?.contentOrNull.orEmpty()
                    connected = false
                    replaying = false
                    cancelTimers = true
                    if (!revealed) {
                        revealLocked(sendResizeIfNeeded = false)
                        scrollBottom = true
                    }
                    snapshot = snapshot.copy(
                        status = TerminalConnectionStatus.ERROR,
                        detail = msg.ifBlank { "终端连接出错" },
                        revealed = true,
                    )
                    stateChanged = true
                    screenDirty = true
                }
            }
        }

        if (cancelTimers) cancelRevealTimers()
        if (startTimers) {
            armQuietReveal(REPLAY_EMPTY_WAIT_MS)
            maxRevealJob?.cancel()
            maxRevealJob = scope.launch(Dispatchers.IO) {
                delay(REPLAY_MAX_WAIT_MS)
                triggerRevealNow()
            }
        }
        pendingResize?.let { sz ->
            wsToSend?.sendText(buildResizePayload(sz))
        }
        if (stateChanged) emitState()
        if (screenDirty) onScreenDirty(scrollBottom)
    }

    /**
     * 必须在持有 lock 时调用：
     * 1. 若对端在回放阶段上报了历史尺寸，先按历史尺寸解析完整回放，防止宽屏历史在窄屏撕裂。
     * 2. 一次性解析完毕后再对齐手机目标尺寸，确保亮屏瞬间直接停在底部最新画面。
     */
    private fun revealLocked(sendResizeIfNeeded: Boolean): TerminalGridSize? {
        if (revealed) return null
        revealed = true
        val bytes = replayBuffer.toByteArray()
        replayBuffer.reset()

        val target = currentTargetSize
        val hint = replayHintSize
        if (bytes.isNotEmpty()) {
            if (hint != null && (hint.cols != emulator.mColumns || hint.rows != emulator.mRows)) {
                emulator.resize(hint.cols, hint.rows)
            }
            emulator.append(bytes, bytes.size)
        }

        var resizeToSend: TerminalGridSize? = null
        if (hasLease) {
            if (emulator.mColumns != target.cols || emulator.mRows != target.rows) {
                emulator.resize(target.cols, target.rows)
            }
            if (sendResizeIfNeeded && connected &&
                (lastServerSize == null || lastServerSize!!.cols != target.cols || lastServerSize!!.rows != target.rows)
            ) {
                lastServerSize = target
                resizeToSend = target
            }
        }
        snapshot = snapshot.copy(revealed = true)
        return resizeToSend
    }

    private fun armQuietReveal(delayMs: Long = REPLAY_QUIET_MS) {
        quietRevealJob?.cancel()
        quietRevealJob = scope.launch(Dispatchers.IO) {
            delay(delayMs)
            triggerRevealNow()
        }
    }

    private fun triggerRevealNow() {
        val pendingResize: TerminalGridSize?
        val ws: UpstreamWs?
        var didReveal = false
        synchronized(lock) {
            if (closed || revealed) return
            replaying = false
            ws = remoteWs
            pendingResize = revealLocked(sendResizeIfNeeded = true)
            didReveal = true
        }
        cancelRevealTimers()
        if (didReveal) {
            pendingResize?.let { ws?.sendText(buildResizePayload(it)) }
            emitState()
            onScreenDirty(true)
        }
    }

    private fun cancelRevealTimers() {
        quietRevealJob?.cancel()
        quietRevealJob = null
        maxRevealJob?.cancel()
        maxRevealJob = null
    }

    fun updateSize(next: TerminalGridSize, claimLease: Boolean = false) {
        if (next.cols < 20 || next.rows < 6) return
        var resizeToSend: TerminalGridSize? = null
        var stateChanged = false
        var screenDirty = false
        val ws: UpstreamWs?
        synchronized(lock) {
            if (closed) return
            val sizeChanged = next.cols != currentTargetSize.cols || next.rows != currentTargetSize.rows
            currentTargetSize = next
            ws = remoteWs
            if (claimLease && !hasLease) {
                hasLease = true
                snapshot = snapshot.copy(leaseHolder = "")
                stateChanged = true
            }
            if (hasLease && revealed && (sizeChanged || claimLease)) {
                emulator.resize(next.cols, next.rows)
                screenDirty = true
                if (connected && (lastServerSize == null || lastServerSize!!.cols != next.cols || lastServerSize!!.rows != next.rows || claimLease)) {
                    lastServerSize = next
                    resizeToSend = next
                }
            }
        }
        resizeToSend?.let { ws?.sendText(buildResizePayload(it)) }
        if (stateChanged) emitState()
        if (screenDirty) onScreenDirty(false)
    }

    fun reclaimLease() {
        val sz = synchronized(lock) { currentTargetSize }
        updateSize(sz, claimLease = true)
    }

    fun dismissWarning() {
        synchronized(lock) {
            if (snapshot.warning.isEmpty()) return
            snapshot = snapshot.copy(warning = "")
        }
        emitState()
    }

    fun sendBytes(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        val ws: UpstreamWs?
        var resizeToSend: TerminalGridSize? = null
        var stateChanged = false
        synchronized(lock) {
            if (closed || !connected) return
            ws = remoteWs
            if (!hasLease) {
                hasLease = true
                snapshot = snapshot.copy(leaseHolder = "")
                stateChanged = true
                emulator.resize(currentTargetSize.cols, currentTargetSize.rows)
                lastServerSize = currentTargetSize
                resizeToSend = currentTargetSize
            }
        }
        if (stateChanged) emitState()
        resizeToSend?.let { ws?.sendText(buildResizePayload(it)) }
        ws?.sendBinary(bytes)
    }

    fun sendText(text: String, sendEnter: Boolean) {
        if (text.isEmpty() && !sendEnter) return
        if (text.isNotEmpty()) {
            val normalized = text.replace("\r\n", "\r").replace("\n", "\r")
            sendBytes(normalized.toByteArray(Charsets.UTF_8))
        }
        if (sendEnter) {
            if (text.isEmpty()) {
                sendBytes(byteArrayOf(0x0D))
            } else {
                // TUI（Claude Code / Codex）紧跟粘贴的回车可能被当成换行，延迟 120ms 再发回车。
                scope.launch(Dispatchers.IO) {
                    delay(120L)
                    sendBytes(byteArrayOf(0x0D))
                }
            }
        }
    }

    fun copyVisibleScreen(): String = synchronized(lock) {
        val rows = emulator.mRows
        val cols = emulator.mColumns
        if (rows <= 0 || cols <= 0) return ""
        emulator.getScreen().getSelectedText(0, 0, cols - 1, rows - 1, true, true).trimEnd()
    }

    fun copyRecentOutput(maxLines: Int = 200): String = synchronized(lock) {
        val full = emulator.getScreen().transcriptTextWithoutJoinedLines.orEmpty().trimEnd()
        if (full.isEmpty()) return ""
        val lines = full.lines()
        if (lines.size <= maxLines) full else lines.takeLast(maxLines).joinToString("\n")
    }

    fun close() {
        connectJob?.cancel()
        cancelRevealTimers()
        val ws: UpstreamWs?
        synchronized(lock) {
            if (closed) return
            closed = true
            connected = false
            ws = remoteWs
            remoteWs = null
        }
        runCatching { ws?.close(1000, "closed") }
    }

    private fun emitState() {
        val current = synchronized(lock) { snapshot }
        onStateChanged(current)
    }
}
