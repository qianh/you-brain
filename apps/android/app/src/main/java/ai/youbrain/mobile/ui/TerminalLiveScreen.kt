package ai.youbrain.mobile.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.view.ViewGroup
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import ai.youbrain.mobile.data.ActiveTerminalTarget
import ai.youbrain.mobile.net.UBrainRepository
import ai.youbrain.mobile.ui.components.IosHairline
import ai.youbrain.mobile.ui.components.IosIcons
import ai.youbrain.mobile.ui.components.IosModalSheet
import ai.youbrain.mobile.ui.terminal.NativeTerminalCanvasView
import ai.youbrain.mobile.ui.terminal.NativeTerminalSession
import ai.youbrain.mobile.ui.terminal.TerminalConnectionStatus
import ai.youbrain.mobile.ui.terminal.TerminalGridSize
import ai.youbrain.mobile.ui.terminal.TerminalSessionSnapshot
import ai.youbrain.mobile.ui.terminal.TerminalWidthMode
import ai.youbrain.mobile.ui.theme.IosTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

private data class QuickTermKey(
    val label: String,
    val bytes: ByteArray,
    val accent: Boolean = false,
)

private val QUICK_TERM_KEYS = listOf(
    QuickTermKey("Esc", byteArrayOf(0x1B)),
    QuickTermKey("Tab", byteArrayOf(0x09)),
    QuickTermKey("⇧Tab", byteArrayOf(0x1B, '['.code.toByte(), 'Z'.code.toByte())),
    QuickTermKey("Ctrl+C", byteArrayOf(0x03), accent = true),
    QuickTermKey("↑", byteArrayOf(0x1B, '['.code.toByte(), 'A'.code.toByte())),
    QuickTermKey("↓", byteArrayOf(0x1B, '['.code.toByte(), 'B'.code.toByte())),
    QuickTermKey("←", byteArrayOf(0x1B, '['.code.toByte(), 'D'.code.toByte())),
    QuickTermKey("→", byteArrayOf(0x1B, '['.code.toByte(), 'C'.code.toByte())),
    QuickTermKey("Ctrl+D", byteArrayOf(0x04)),
    QuickTermKey("Ctrl+L", byteArrayOf(0x0C)),
    QuickTermKey("↵", byteArrayOf(0x0D)),
)

@Composable
fun TerminalLiveScreen(
    target: ActiveTerminalTarget,
    deviceDisplayName: String,
    repository: UBrainRepository,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    val c = IosTheme.colors
    val scope = rememberCoroutineScope()

    var fontSizeSp by remember { mutableFloatStateOf(10.5f) }
    var widthMode by remember { mutableStateOf(TerminalWidthMode.FIT) }
    var directKeyboard by remember { mutableStateOf(false) }
    var isScrolledUp by remember { mutableStateOf(false) }
    var commandDraft by remember { mutableStateOf("") }
    var showCopyMenu by remember { mutableStateOf(false) }
    var copyToast by remember { mutableStateOf<String?>(null) }

    var snapshot by remember(target.deviceId, target.pane) {
        mutableStateOf(TerminalSessionSnapshot(isDark = c.isDark))
    }
    var canvasViewRef by remember { mutableStateOf<NativeTerminalCanvasView?>(null) }
    var sessionRef by remember { mutableStateOf<NativeTerminalSession?>(null) }

    // 首次测得真实终端网格尺寸后再建连，确保初始 connect 尺寸与屏幕完全一致。
    var startedSessionKey by remember(target.deviceId, target.pane) { mutableStateOf(false) }

    fun ensureSessionStarted(grid: TerminalGridSize) {
        val existing = sessionRef
        if (existing != null && startedSessionKey) {
            existing.updateSize(grid, claimLease = false)
            return
        }
        startedSessionKey = true
        val created = NativeTerminalSession(
            scope = scope,
            pane = target.pane,
            initialSize = grid,
            isDarkInitial = c.isDark,
            openSocket = { listener ->
                repository.openTty7TerminalSocket(target.deviceId, listener)
            },
            onStateChanged = { next ->
                scope.launch(Dispatchers.Main.immediate) {
                    snapshot = next
                }
            },
            onScreenDirty = { resetBottom ->
                canvasViewRef?.notifyContentChanged(resetBottom)
            },
        )
        sessionRef = created
        canvasViewRef?.session = created
        created.start()
    }

    LaunchedEffect(c.isDark) {
        sessionRef?.setTheme(c.isDark)
        canvasViewRef?.setTheme(c.isDark)
    }

    LaunchedEffect(copyToast) {
        if (copyToast != null) {
            delay(1_800L)
            copyToast = null
        }
    }

    DisposableEffect(target.deviceId, target.pane) {
        repository.setTty7ViewingAsync(target.deviceId, target.pane)
        onDispose {
            repository.setTty7ViewingAsync(target.deviceId, null)
            canvasViewRef?.setDirectKeyboardEnabled(false)
            canvasViewRef?.session = null
            canvasViewRef = null
            sessionRef?.close()
            sessionRef = null
        }
    }

    BackHandler(onBack = onClose)

    fun copyToClipboard(label: String, text: String) {
        val clean = text.trimEnd()
        if (clean.isEmpty()) {
            copyToast = "当前没有可复制的内容"
            return
        }
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        cm?.setPrimaryClip(ClipData.newPlainText(label, clean))
        copyToast = "已复制$label"
    }

    fun sendDraftLine(sendEnter: Boolean = true) {
        val text = commandDraft
        if (text.isEmpty() && !sendEnter) return
        commandDraft = ""
        sessionRef?.sendText(text, sendEnter)
        canvasViewRef?.scrollToBottom()
    }

    fun adjustFont(delta: Float) {
        val next = (fontSizeSp + delta).coerceIn(8.5f, 20f)
        if (kotlin.math.abs(next - fontSizeSp) < 0.05f) return
        fontSizeSp = next
        canvasViewRef?.setFontSizeSp(next, notify = false)
    }

    fun cycleWidthMode() {
        val modes = TerminalWidthMode.entries
        val next = modes[(modes.indexOf(widthMode) + 1) % modes.size]
        widthMode = next
        canvasViewRef?.setWidthMode(next)
    }

    val statusColor = when (snapshot.status) {
        TerminalConnectionStatus.READY -> c.green
        TerminalConnectionStatus.CONNECTING -> c.orange
        TerminalConnectionStatus.EXITED -> c.secondaryLabel
        TerminalConnectionStatus.DISCONNECTED, TerminalConnectionStatus.ERROR -> c.red
    }
    val statusLabel = when (snapshot.status) {
        TerminalConnectionStatus.READY -> if (snapshot.revealed) "已连接" else "同步中"
        TerminalConnectionStatus.CONNECTING -> "连接中"
        TerminalConnectionStatus.EXITED -> "已退出"
        TerminalConnectionStatus.DISCONNECTED -> "已断开"
        TerminalConnectionStatus.ERROR -> "异常"
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(if (c.isDark) Color(NativeTerminalSession.DARK_BG) else Color(NativeTerminalSession.LIGHT_BG))
            .navigationBarsPadding()
            .imePadding(),
    ) {
        // 顶部终端标题与控制栏
        Column(modifier = Modifier.fillMaxWidth().background(c.chromeBg)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .statusBarsPadding()
                    .height(46.dp)
                    .padding(horizontal = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                Box(
                    modifier = Modifier
                        .size(30.dp)
                        .clip(CircleShape)
                        .background(c.tertiaryFill)
                        .clickable(onClick = onClose),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = IosIcons.Close,
                        contentDescription = "返回列表",
                        tint = c.label,
                        modifier = Modifier.size(15.dp),
                    )
                }

                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = target.title.ifBlank { "终端 #%d".format(target.pane) },
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = c.label,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        Box(
                            modifier = Modifier
                                .size(6.dp)
                                .clip(CircleShape)
                                .background(statusColor),
                        )
                        Text(
                            text = "$deviceDisplayName · %${target.pane} · $statusLabel",
                            fontSize = 11.sp,
                            color = c.secondaryLabel,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }

                // 列宽模式切换（适屏 / 80列 / 100列）
                Box(
                    modifier = Modifier
                        .height(26.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (widthMode == TerminalWidthMode.FIT) c.tertiaryFill else c.blue.copy(alpha = 0.16f))
                        .clickable { cycleWidthMode() }
                        .padding(horizontal = 8.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = widthMode.label,
                        fontSize = 11.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = if (widthMode == TerminalWidthMode.FIT) c.label else c.blue,
                        softWrap = false,
                    )
                }

                // 字号缩小 / 放大
                Row(
                    modifier = Modifier
                        .height(26.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(c.tertiaryFill)
                        .padding(horizontal = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(6.dp))
                            .clickable(enabled = fontSizeSp > 8.6f) { adjustFont(-1f) }
                            .padding(horizontal = 6.dp, vertical = 3.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = "A-",
                            fontSize = 11.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = if (fontSizeSp > 8.6f) c.label else c.tertiaryLabel,
                        )
                    }
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(6.dp))
                            .clickable(enabled = fontSizeSp < 19.9f) { adjustFont(1f) }
                            .padding(horizontal = 6.dp, vertical = 3.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = "A+",
                            fontSize = 11.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = if (fontSizeSp < 19.9f) c.label else c.tertiaryLabel,
                        )
                    }
                }

                Box(
                    modifier = Modifier
                        .size(28.dp)
                        .clip(CircleShape)
                        .background(c.tertiaryFill)
                        .clickable { sessionRef?.reconnect() },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = IosIcons.Refresh,
                        contentDescription = "重新连接",
                        tint = c.blue,
                        modifier = Modifier.size(14.dp),
                    )
                }
            }
            IosHairline()
        }

        // 租约被桌面窗口接管时的提示条
        if (snapshot.leaseHolder.isNotBlank()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(c.blue.copy(alpha = 0.14f))
                    .clickable { sessionRef?.reclaimLease() }
                    .padding(horizontal = 12.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = "尺寸正由 ${snapshot.leaseHolder} 控制",
                    fontSize = 12.sp,
                    color = c.blue,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = "适配手机宽度",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = c.blue,
                )
            }
        }

        if (snapshot.warning.isNotBlank()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(c.orange.copy(alpha = 0.15f))
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = snapshot.warning,
                    fontSize = 12.sp,
                    color = c.orange,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = "关闭",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                    color = c.orange,
                    modifier = Modifier.clickable { sessionRef?.dismissWarning() }.padding(start = 8.dp),
                )
            }
        }

        if (snapshot.status == TerminalConnectionStatus.ERROR ||
            snapshot.status == TerminalConnectionStatus.DISCONNECTED ||
            snapshot.status == TerminalConnectionStatus.EXITED
        ) {
            val isExited = snapshot.status == TerminalConnectionStatus.EXITED
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background((if (isExited) c.secondaryLabel else c.red).copy(alpha = 0.14f))
                    .padding(horizontal = 12.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = snapshot.detail.ifBlank { statusLabel },
                    fontSize = 12.5.sp,
                    color = if (isExited) c.secondaryLabel else c.red,
                    modifier = Modifier.weight(1f),
                )
                if (!isExited) {
                    Text(
                        text = "重连",
                        fontSize = 12.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = c.blue,
                        modifier = Modifier
                            .clip(RoundedCornerShape(6.dp))
                            .clickable { sessionRef?.reconnect() }
                            .padding(horizontal = 8.dp, vertical = 2.dp),
                    )
                }
            }
        }

        // 中间整屏原生 Canvas 终端视图
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
        ) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { ctx ->
                    NativeTerminalCanvasView(ctx).apply {
                        layoutParams = ViewGroup.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT,
                        )
                        setTheme(c.isDark)
                        setFontSizeSp(fontSizeSp, notify = false)
                        setWidthMode(widthMode)
                        setDirectKeyboardEnabled(directKeyboard)
                        onGridSizeMeasured = { grid ->
                            ensureSessionStarted(grid)
                        }
                        onFontSizeSpChanged = { nextSp ->
                            fontSizeSp = nextSp
                        }
                        onScrolledUpChanged = { scrolledUp ->
                            isScrolledUp = scrolledUp
                        }
                        onLongPressMenu = {
                            showCopyMenu = true
                        }
                        canvasViewRef = this
                        session = sessionRef
                    }
                },
                update = { view ->
                    view.setTheme(c.isDark)
                },
            )

            // 后台静默解析初始回放期间保持遮罩，直到解析完成并停在最新行才一次性显示。
            if (!snapshot.revealed) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(if (c.isDark) Color(NativeTerminalSession.DARK_BG) else Color(NativeTerminalSession.LIGHT_BG)),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(26.dp),
                            strokeWidth = 2.4.dp,
                            color = c.blue,
                        )
                        Text(
                            text = if (snapshot.status == TerminalConnectionStatus.READY) {
                                "正在渲染 $deviceDisplayName 最新终端画面…"
                            } else {
                                "正在连接 $deviceDisplayName 终端流…"
                            },
                            fontSize = 13.sp,
                            color = c.secondaryLabel,
                        )
                    }
                }
            }

            // 上滑翻历史时显示悬浮「回到底部」胶囊
            if (snapshot.revealed && isScrolledUp) {
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .padding(end = 12.dp, bottom = 12.dp)
                        .clip(CircleShape)
                        .background(c.blue.copy(alpha = 0.92f))
                        .clickable { canvasViewRef?.scrollToBottom() }
                        .padding(horizontal = 12.dp, vertical = 6.dp),
                ) {
                    Text(
                        text = "↓ 回到底部",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = Color.White,
                    )
                }
            }

            // 复制成功轻提示
            copyToast?.let { tip ->
                Box(
                    modifier = Modifier
                        .align(Alignment.TopCenter)
                        .padding(top = 10.dp)
                        .clip(CircleShape)
                        .background(Color.Black.copy(alpha = 0.78f))
                        .padding(horizontal = 14.dp, vertical = 6.dp),
                ) {
                    Text(
                        text = tip,
                        fontSize = 12.5.sp,
                        color = Color.White,
                        fontWeight = FontWeight.Medium,
                    )
                }
            }
        }

        // 底部双轨输入区：直输键盘开关 + 触屏快捷键条 + 原生中文友好指令输入框
        Column(modifier = Modifier.fillMaxWidth().background(c.chromeBg)) {
            IosHairline()
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 10.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                // 按需直输键盘切换按钮（默认关，防止滑屏误触）
                Row(
                    modifier = Modifier
                        .clip(RoundedCornerShape(7.dp))
                        .background(if (directKeyboard) c.blue else c.tertiaryFill)
                        .clickable {
                            directKeyboard = !directKeyboard
                            canvasViewRef?.setDirectKeyboardEnabled(directKeyboard)
                        }
                        .padding(horizontal = 9.dp, vertical = 5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Icon(
                        imageVector = IosIcons.Keyboard,
                        contentDescription = "直输键盘",
                        tint = if (directKeyboard) Color.White else c.label,
                        modifier = Modifier.size(13.dp),
                    )
                    Text(
                        text = if (directKeyboard) "直输开" else "直输",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium,
                        color = if (directKeyboard) Color.White else c.label,
                        softWrap = false,
                    )
                }

                QUICK_TERM_KEYS.forEach { key ->
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(7.dp))
                            .background(if (key.accent) c.red.copy(alpha = 0.14f) else c.tertiaryFill)
                            .clickable {
                                sessionRef?.sendBytes(key.bytes)
                                canvasViewRef?.scrollToBottom()
                            }
                            .padding(horizontal = 10.dp, vertical = 5.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = key.label,
                            fontSize = 12.sp,
                            fontFamily = FontFamily.Monospace,
                            fontWeight = FontWeight.Medium,
                            color = if (key.accent) c.red else c.label,
                            softWrap = false,
                        )
                    }
                }

                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(7.dp))
                        .background(c.tertiaryFill)
                        .clickable { showCopyMenu = true }
                        .padding(horizontal = 10.dp, vertical = 5.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = "复制",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium,
                        color = c.blue,
                        softWrap = false,
                    )
                }
            }

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 10.dp, end = 10.dp, bottom = 8.dp),
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(18.dp))
                        .background(c.cardBg)
                        .border(0.5.dp, c.separator.copy(alpha = 0.6f), RoundedCornerShape(18.dp))
                        .padding(horizontal = 13.dp, vertical = 8.dp),
                ) {
                    if (commandDraft.isEmpty()) {
                        Text(
                            text = "输入指令或回复内容（支持中文）…",
                            fontSize = 14.sp,
                            color = c.secondaryLabel,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    BasicTextField(
                        value = commandDraft,
                        onValueChange = { commandDraft = it },
                        maxLines = 4,
                        textStyle = TextStyle(fontSize = 14.5.sp, lineHeight = 19.sp, color = c.label),
                        cursorBrush = SolidColor(c.blue),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                        keyboardActions = KeyboardActions(onSend = { sendDraftLine(true) }),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                val hasText = commandDraft.isNotEmpty()
                Box(
                    modifier = Modifier
                        .size(34.dp)
                        .clip(CircleShape)
                        .background(if (hasText) c.blue else c.tertiaryFill)
                        .clickable { sendDraftLine(true) },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = IosIcons.ArrowUp,
                        contentDescription = "发送并回车",
                        tint = if (hasText) Color.White else c.secondaryLabel,
                        modifier = Modifier.size(16.dp),
                    )
                }
            }
        }
    }

    if (showCopyMenu) {
        IosModalSheet(
            title = "复制终端输出",
            onDismiss = { showCopyMenu = false },
            confirmText = "复制当前屏幕",
            onConfirm = {
                showCopyMenu = false
                copyToClipboard("当前终端屏幕", sessionRef?.copyVisibleScreen().orEmpty())
            },
            secondaryText = "复制最近 200 行输出",
            onSecondary = {
                showCopyMenu = false
                copyToClipboard("最近终端输出", sessionRef?.copyRecentOutput(200).orEmpty())
            },
        ) {
            Text(
                text = "长按终端画布或点击底部「复制」按钮可随时复制当前屏幕或最近历史输出。",
                fontSize = 13.5.sp,
                lineHeight = 19.sp,
                color = c.secondaryLabel,
            )
        }
    }
}
