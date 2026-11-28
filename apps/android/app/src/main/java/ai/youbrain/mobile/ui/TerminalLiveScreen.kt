package ai.youbrain.mobile.ui

import android.annotation.SuppressLint
import android.util.Base64
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
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
import androidx.compose.foundation.layout.width
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
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalDensity
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
import ai.youbrain.mobile.ui.theme.IosTheme
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive

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

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun TerminalLiveScreen(
    target: ActiveTerminalTarget,
    deviceDisplayName: String,
    repository: UBrainRepository,
    onClose: () -> Unit,
) {
    val c = IosTheme.colors
    var fontSize by remember { mutableIntStateOf(11) }
    var status by remember { mutableStateOf("connecting") }
    var statusDetail by remember { mutableStateOf("") }
    var warning by remember { mutableStateOf("") }
    var leaseHolder by remember { mutableStateOf("") }
    var commandDraft by remember { mutableStateOf("") }
    var webViewRef by remember { mutableStateOf<WebView?>(null) }

    val pageUrl = remember(target.deviceId, target.pane) {
        repository.terminalPageUrl(
            deviceId = target.deviceId,
            pane = target.pane,
            fontSize = fontSize,
            isDark = c.isDark,
        )
    }

    val imeBottom = WindowInsets.ime.getBottom(LocalDensity.current)
    LaunchedEffect(imeBottom) {
        webViewRef?.evaluateJavascript("window.__ubrainTerm && window.__ubrainTerm.fitNow(false);", null)
    }

    LaunchedEffect(c.isDark) {
        val mode = if (c.isDark) "dark" else "light"
        webViewRef?.evaluateJavascript("window.__ubrainTerm && window.__ubrainTerm.setTheme('$mode');", null)
    }

    DisposableEffect(target.deviceId, target.pane) {
        repository.setTty7ViewingAsync(target.deviceId, target.pane)
        onDispose {
            repository.setTty7ViewingAsync(target.deviceId, null)
            webViewRef?.let { wv ->
                runCatching { wv.evaluateJavascript("window.__ubrainTerm && window.__ubrainTerm.dispose();", null) }
                runCatching { wv.destroy() }
            }
            webViewRef = null
        }
    }

    BackHandler(onBack = onClose)

    fun sendQuickKey(bytes: ByteArray) {
        val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
        webViewRef?.evaluateJavascript(
            "window.__ubrainTerm && window.__ubrainTerm.sendRawBase64('$b64');",
            null,
        )
    }

    fun sendDraftLine(sendEnter: Boolean = true) {
        val text = commandDraft
        if (text.isEmpty() && !sendEnter) return
        commandDraft = ""
        val quoted = Json.encodeToString(JsonPrimitive.serializer(), JsonPrimitive(text))
        webViewRef?.evaluateJavascript(
            "window.__ubrainTerm && window.__ubrainTerm.sendText($quoted, $sendEnter);",
            null,
        )
    }

    fun adjustFont(delta: Int) {
        val next = (fontSize + delta).coerceIn(9, 20)
        if (next == fontSize) return
        fontSize = next
        webViewRef?.evaluateJavascript("window.__ubrainTerm && window.__ubrainTerm.setFontSize($next);", null)
    }

    val statusColor = when (status) {
        "ready" -> c.green
        "connecting" -> c.orange
        "exited" -> c.secondaryLabel
        else -> c.red
    }
    val statusLabel = when (status) {
        "ready" -> "已连接"
        "connecting" -> "连接中"
        "exited" -> "已退出"
        "disconnected" -> "已断开"
        else -> "异常"
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(if (c.isDark) Color(0xFF111216) else Color(0xFFF8F9FB))
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
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Box(
                    modifier = Modifier
                        .size(32.dp)
                        .clip(CircleShape)
                        .background(c.tertiaryFill)
                        .clickable(onClick = onClose),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = IosIcons.Close,
                        contentDescription = "返回列表",
                        tint = c.label,
                        modifier = Modifier.size(16.dp),
                    )
                }

                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = target.title.ifBlank { "终端 #%d".format(target.pane) },
                        fontSize = 14.5.sp,
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
                            fontSize = 11.5.sp,
                            color = c.secondaryLabel,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                }

                // 字号缩小 / 放大
                Row(
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .background(c.tertiaryFill)
                        .padding(horizontal = 2.dp, vertical = 2.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(6.dp))
                            .clickable(enabled = fontSize > 9) { adjustFont(-1) }
                            .padding(horizontal = 7.dp, vertical = 4.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = "A-",
                            fontSize = 11.5.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = if (fontSize > 9) c.label else c.tertiaryLabel,
                        )
                    }
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(6.dp))
                            .clickable(enabled = fontSize < 20) { adjustFont(1) }
                            .padding(horizontal = 7.dp, vertical = 4.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = "A+",
                            fontSize = 11.5.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = if (fontSize < 20) c.label else c.tertiaryLabel,
                        )
                    }
                }

                Box(
                    modifier = Modifier
                        .size(30.dp)
                        .clip(CircleShape)
                        .background(c.tertiaryFill)
                        .clickable {
                            status = "connecting"
                            statusDetail = ""
                            webViewRef?.evaluateJavascript(
                                "window.__ubrainTerm && window.__ubrainTerm.reconnect();",
                                null,
                            )
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = IosIcons.Refresh,
                        contentDescription = "重新连接",
                        tint = c.blue,
                        modifier = Modifier.size(15.dp),
                    )
                }
            }
            IosHairline()
        }

        // 租约被桌面窗口接管时的提示条
        if (leaseHolder.isNotBlank()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(c.blue.copy(alpha = 0.14f))
                    .clickable {
                        leaseHolder = ""
                        webViewRef?.evaluateJavascript(
                            "window.__ubrainTerm && window.__ubrainTerm.fitNow(true);",
                            null,
                        )
                    }
                    .padding(horizontal = 12.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = "尺寸正由 $leaseHolder 控制",
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

        if (warning.isNotBlank()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(c.orange.copy(alpha = 0.15f))
                    .padding(horizontal = 12.dp, vertical = 6.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = warning,
                    fontSize = 12.sp,
                    color = c.orange,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = "关闭",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                    color = c.orange,
                    modifier = Modifier.clickable { warning = "" }.padding(start = 8.dp),
                )
            }
        }

        if (status == "error" || status == "disconnected" || status == "exited") {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background((if (status == "exited") c.secondaryLabel else c.red).copy(alpha = 0.14f))
                    .padding(horizontal = 12.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    text = statusDetail.ifBlank { statusLabel },
                    fontSize = 12.5.sp,
                    color = if (status == "exited") c.secondaryLabel else c.red,
                    modifier = Modifier.weight(1f),
                )
                if (status != "exited") {
                    Text(
                        text = "重连",
                        fontSize = 12.5.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = c.blue,
                        modifier = Modifier
                            .clip(RoundedCornerShape(6.dp))
                            .clickable {
                                status = "connecting"
                                statusDetail = ""
                                webViewRef?.evaluateJavascript(
                                    "window.__ubrainTerm && window.__ubrainTerm.reconnect();",
                                    null,
                                )
                            }
                            .padding(horizontal = 8.dp, vertical = 2.dp),
                    )
                }
            }
        }

        // 中间整屏实时 xterm.js WebView
        Box(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
        ) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { ctx ->
                    WebView(ctx).apply {
                        layoutParams = ViewGroup.LayoutParams(
                            ViewGroup.LayoutParams.MATCH_PARENT,
                            ViewGroup.LayoutParams.MATCH_PARENT,
                        )
                        setBackgroundColor(if (c.isDark) 0xFF111216.toInt() else 0xFFF8F9FB.toInt())
                        settings.javaScriptEnabled = true
                        settings.domStorageEnabled = false
                        settings.cacheMode = WebSettings.LOAD_NO_CACHE
                        settings.builtInZoomControls = false
                        settings.displayZoomControls = false
                        settings.setSupportZoom(false)
                        addJavascriptInterface(
                            object {
                                @JavascriptInterface
                                fun onStatus(nextStatus: String, detail: String) {
                                    post {
                                        status = nextStatus
                                        statusDetail = detail
                                    }
                                }

                                @JavascriptInterface
                                fun onWarning(msg: String) {
                                    post { warning = msg }
                                }

                                @JavascriptInterface
                                fun onLease(by: String) {
                                    post { leaseHolder = by }
                                }
                            },
                            "AndroidTerminalBridge",
                        )
                        webViewClient = object : WebViewClient() {
                            override fun onReceivedError(
                                view: WebView?,
                                request: WebResourceRequest?,
                                error: WebResourceError?,
                            ) {
                                if (request?.isForMainFrame == true) {
                                    status = "error"
                                    statusDetail = error?.description?.toString() ?: "终端页面加载失败"
                                }
                            }
                        }
                        loadUrl(pageUrl)
                        webViewRef = this
                    }
                },
            )

            if (status == "connecting") {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background((if (c.isDark) Color(0xFF111216) else Color(0xFFF8F9FB)).copy(alpha = 0.72f)),
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
                            text = "正在连接 $deviceDisplayName 终端流…",
                            fontSize = 13.sp,
                            color = c.secondaryLabel,
                        )
                    }
                }
            }
        }

        // 底部双轨输入区：常用触屏快捷键条 + 原生中文友好指令输入框
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
                QUICK_TERM_KEYS.forEach { key ->
                    Box(
                        modifier = Modifier
                            .clip(RoundedCornerShape(7.dp))
                            .background(
                                if (key.accent) c.red.copy(alpha = 0.14f) else c.tertiaryFill,
                            )
                            .clickable { sendQuickKey(key.bytes) }
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
                        .clickable {
                            webViewRef?.evaluateJavascript(
                                "window.__ubrainTerm && window.__ubrainTerm.scrollToBottom();",
                                null,
                            )
                        }
                        .padding(horizontal = 10.dp, vertical = 5.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = "到底",
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
}
