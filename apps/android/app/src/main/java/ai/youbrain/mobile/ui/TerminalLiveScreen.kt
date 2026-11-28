package ai.youbrain.mobile.ui

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.view.ViewGroup
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.zIndex
import androidx.core.view.WindowCompat
import ai.youbrain.mobile.data.ActiveTerminalTarget
import ai.youbrain.mobile.net.UBrainRepository
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

// 终端界面与桌面端 tty7 对齐，始终保持深色终端外观，避免电脑端深色 TrueColor 输出在白底上错乱。
private val TermCanvasBg = Color(NativeTerminalSession.DARK_BG)
private val TermChromeBg = Color(0xFF181A20)
private val TermPillBg = Color(0xFF282B34)
private val TermHairline = Color(0xFF2C303A)
private val TermPrimaryText = Color(0xFFF2F4F8)
private val TermSecondaryText = Color(0xFF9CA3AF)
private val TermMutedText = Color(0xFF6B7280)
private val TermBlue = Color(0xFF0A84FF)
private val TermGreen = Color(0xFF30D158)
private val TermOrange = Color(0xFFFF9F0A)
private val TermRed = Color(0xFFFF453A)

@Composable
fun TerminalLiveScreen(
    target: ActiveTerminalTarget,
    deviceDisplayName: String,
    repository: UBrainRepository,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    val view = LocalView.current
    val iosColors = IosTheme.colors
    val scope = rememberCoroutineScope()

    var fontSizeSp by remember { mutableFloatStateOf(10.5f) }
    var widthMode by remember { mutableStateOf(TerminalWidthMode.FIT) }
    var isScrolledUp by remember { mutableStateOf(false) }
    var showCopyMenu by remember { mutableStateOf(false) }
    var copyToast by remember { mutableStateOf<String?>(null) }

    var snapshot by remember(target.deviceId, target.pane) {
        mutableStateOf(TerminalSessionSnapshot(isDark = true))
    }
    var canvasViewRef by remember { mutableStateOf<NativeTerminalCanvasView?>(null) }
    var sessionRef by remember { mutableStateOf<NativeTerminalSession?>(null) }
    var startedSessionKey by remember(target.deviceId, target.pane) { mutableStateOf(false) }

    val isImeVisible = WindowInsets.ime.getBottom(LocalDensity.current) > 0

    // 进入深色全屏终端时切换状态栏与导航栏为深色样式，离开时恢复主界面配色。
    DisposableEffect(view, iosColors.isDark) {
        val window = (context as? Activity)?.window
        val controller = if (window != null) WindowCompat.getInsetsController(window, view) else null
        if (window != null && controller != null) {
            @Suppress("DEPRECATION")
            window.statusBarColor = TermChromeBg.toArgb()
            @Suppress("DEPRECATION")
            window.navigationBarColor = TermChromeBg.toArgb()
            controller.isAppearanceLightStatusBars = false
            controller.isAppearanceLightNavigationBars = false
        }
        onDispose {
            if (window != null && controller != null) {
                @Suppress("DEPRECATION")
                window.statusBarColor = iosColors.chromeBg.toArgb()
                @Suppress("DEPRECATION")
                window.navigationBarColor = iosColors.chromeBg.toArgb()
                controller.isAppearanceLightStatusBars = !iosColors.isDark
                controller.isAppearanceLightNavigationBars = !iosColors.isDark
            }
        }
    }

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
            isDarkInitial = true,
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
            canvasViewRef?.hideSoftKeyboard()
            canvasViewRef?.session = null
            canvasViewRef = null
            sessionRef?.close()
            sessionRef = null
        }
    }

    BackHandler(onBack = {
        if (isImeVisible) {
            canvasViewRef?.hideSoftKeyboard()
        } else {
            onClose()
        }
    })

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

    fun pasteFromClipboard() {
        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        val text = cm?.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString().orEmpty()
        if (text.isEmpty()) {
            copyToast = "剪贴板为空"
            return
        }
        sessionRef?.sendText(text, sendEnter = false)
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
        TerminalConnectionStatus.READY -> TermGreen
        TerminalConnectionStatus.CONNECTING -> TermOrange
        TerminalConnectionStatus.EXITED -> TermSecondaryText
        TerminalConnectionStatus.DISCONNECTED, TerminalConnectionStatus.ERROR -> TermRed
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
            .background(TermCanvasBg)
            .navigationBarsPadding()
            .imePadding(),
    ) {
        // 顶部深色终端控制栏（zIndex + clipToBounds 保证永远清晰可见，左上角醒目「← 返回」）
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .zIndex(2f)
                .background(TermChromeBg)
                .statusBarsPadding(),
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(48.dp)
                    .padding(horizontal = 10.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Row(
                    modifier = Modifier
                        .height(30.dp)
                        .clip(RoundedCornerShape(9.dp))
                        .background(TermPillBg)
                        .clickable(onClick = onClose)
                        .padding(horizontal = 10.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Text(
                        text = "← 返回",
                        fontSize = 12.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = TermPrimaryText,
                        softWrap = false,
                    )
                }

                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = target.title.ifBlank { "终端 #%d".format(target.pane) },
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = TermPrimaryText,
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
                            color = TermSecondaryText,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }

                // 列宽模式切换（适屏 / 80列 / 100列）
                Box(
                    modifier = Modifier
                        .height(28.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (widthMode == TerminalWidthMode.FIT) TermPillBg else TermBlue.copy(alpha = 0.22f))
                        .clickable { cycleWidthMode() }
                        .padding(horizontal = 8.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = widthMode.label,
                        fontSize = 11.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = if (widthMode == TerminalWidthMode.FIT) TermPrimaryText else TermBlue,
                        softWrap = false,
                    )
                }

                // 字号缩小 / 放大
                Row(
                    modifier = Modifier
                        .height(28.dp)
                        .clip(RoundedCornerShape(8.dp))
                        .background(TermPillBg)
                        .padding(horizontal = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(6.dp))
                            .clickable(enabled = fontSizeSp > 8.6f) { adjustFont(-1f) }
                            .padding(horizontal = 6.dp, vertical = 4.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = "A-",
                            fontSize = 11.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = if (fontSizeSp > 8.6f) TermPrimaryText else TermMutedText,
                        )
                    }
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(6.dp))
                            .clickable(enabled = fontSizeSp < 19.9f) { adjustFont(1f) }
                            .padding(horizontal = 6.dp, vertical = 4.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = "A+",
                            fontSize = 11.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = if (fontSizeSp < 19.9f) TermPrimaryText else TermMutedText,
                        )
                    }
                }

                Box(
                    modifier = Modifier
                        .size(28.dp)
                        .clip(CircleShape)
                        .background(TermPillBg)
                        .clickable { sessionRef?.reconnect() },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = IosIcons.Refresh,
                        contentDescription = "重新连接",
                        tint = TermBlue,
                        modifier = Modifier.size(14.dp),
                    )
                }
            }
            HorizontalDivider(thickness = 0.5.dp, color = TermHairline)
        }

        // 租约被桌面窗口接管时的提示条
        if (snapshot.leaseHolder.isNotBlank()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .zIndex(2f)
                    .background(TermBlue.copy(alpha = 0.16f))
                    .clickable { sessionRef?.reclaimLease() }
                    .padding(horizontal = 12.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = "尺寸正由 ${snapshot.leaseHolder} 控制",
                    fontSize = 12.sp,
                    color = TermBlue,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = "适配手机宽度",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = TermBlue,
                )
            }
        }

        if (snapshot.warning.isNotBlank()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .zIndex(2f)
                    .background(TermOrange.copy(alpha = 0.16f))
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = snapshot.warning,
                    fontSize = 12.sp,
                    color = TermOrange,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = "关闭",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                    color = TermOrange,
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
                    .zIndex(2f)
                    .background((if (isExited) TermSecondaryText else TermRed).copy(alpha = 0.16f))
                    .padding(horizontal = 12.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = snapshot.detail.ifBlank { statusLabel },
                    fontSize = 12.5.sp,
                    color = if (isExited) TermSecondaryText else TermRed,
                    modifier = Modifier.weight(1f),
                )
                if (!isExited) {
                    Text(
                        text = "重连",
                        fontSize = 12.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = TermBlue,
                        modifier = Modifier
                            .clip(RoundedCornerShape(6.dp))
                            .clickable { sessionRef?.reconnect() }
                            .padding(horizontal = 8.dp, vertical = 2.dp),
                    )
                }
            }
        }

        // 中间整屏原生深色 Canvas 终端视图（clipToBounds 严控绘制边界，绝不越界覆盖顶栏）
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .clipToBounds(),
        ) {
            AndroidView(
                modifier = Modifier
                    .fillMaxSize()
                    .clipToBounds(),
                factory = { ctx ->
                    NativeTerminalCanvasView(ctx).apply {
                        layoutParams = ViewGroup.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT,
                        )
                        setTheme(true)
                        setFontSizeSp(fontSizeSp, notify = false)
                        setWidthMode(widthMode)
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
            )

            // 后台静默接收并解析完完整回放之前保持遮罩，彻底消除“从头滚到尾”。
            if (!snapshot.revealed) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(TermCanvasBg),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(26.dp),
                            strokeWidth = 2.4.dp,
                            color = TermBlue,
                        )
                        val progressText = when {
                            snapshot.status != TerminalConnectionStatus.READY ->
                                "正在连接 $deviceDisplayName 终端流…"
                            snapshot.replayBytesReceived > 0 ->
                                "正在同步最新终端画面（${maxOf(1, snapshot.replayBytesReceived / 1024)} KB）…"
                            else ->
                                "正在读取 $deviceDisplayName 最新终端画面…"
                        }
                        Text(
                            text = progressText,
                            fontSize = 13.sp,
                            color = TermSecondaryText,
                        )
                    }
                }
            }

            if (snapshot.revealed && isScrolledUp) {
                Box(
                    modifier = Modifier
                        .align(Alignment.BottomEnd)
                        .padding(end = 12.dp, bottom = 12.dp)
                        .clip(CircleShape)
                        .background(TermBlue.copy(alpha = 0.92f))
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

            copyToast?.let { tip ->
                Box(
                    modifier = Modifier
                        .align(Alignment.TopCenter)
                        .padding(top = 10.dp)
                        .clip(CircleShape)
                        .background(Color.Black.copy(alpha = 0.82f))
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

        // 底部单行终端快捷键条（不仿造输入框；点击终端画面或「键盘」按钮直接调起系统输入法写入终端原始输入框）
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .zIndex(2f)
                .background(TermChromeBg),
        ) {
            HorizontalDivider(thickness = 0.5.dp, color = TermHairline)
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 10.dp, vertical = 7.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Row(
                    modifier = Modifier
                        .clip(RoundedCornerShape(7.dp))
                        .background(if (isImeVisible) TermBlue else TermBlue.copy(alpha = 0.22f))
                        .clickable {
                            if (isImeVisible) {
                                canvasViewRef?.hideSoftKeyboard()
                            } else {
                                canvasViewRef?.showSoftKeyboard()
                            }
                        }
                        .padding(horizontal = 10.dp, vertical = 5.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    Icon(
                        imageVector = IosIcons.Keyboard,
                        contentDescription = if (isImeVisible) "收起键盘" else "打开键盘",
                        tint = if (isImeVisible) Color.White else TermBlue,
                        modifier = Modifier.size(13.dp),
                    )
                    Text(
                        text = if (isImeVisible) "收键盘" else "键盘",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = if (isImeVisible) Color.White else TermBlue,
                        softWrap = false,
                    )
                }

                QUICK_TERM_KEYS.forEach { key ->
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(7.dp))
                            .background(if (key.accent) TermRed.copy(alpha = 0.2f) else TermPillBg)
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
                            color = if (key.accent) TermRed else TermPrimaryText,
                            softWrap = false,
                        )
                    }
                }

                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(7.dp))
                        .background(TermPillBg)
                        .clickable { pasteFromClipboard() }
                        .padding(horizontal = 10.dp, vertical = 5.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = "粘贴",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium,
                        color = TermPrimaryText,
                        softWrap = false,
                    )
                }

                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(7.dp))
                        .background(TermPillBg)
                        .clickable { showCopyMenu = true }
                        .padding(horizontal = 10.dp, vertical = 5.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = "复制",
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium,
                        color = TermBlue,
                        softWrap = false,
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
                color = iosColors.secondaryLabel,
            )
        }
    }
}
