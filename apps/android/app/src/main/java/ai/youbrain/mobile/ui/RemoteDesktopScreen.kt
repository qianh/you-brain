package ai.youbrain.mobile.ui

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.ActivityInfo
import android.graphics.BitmapFactory
import android.graphics.Color as AndroidColor
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebMessage
import android.webkit.WebMessagePort
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
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
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import ai.youbrain.mobile.data.RdDisplayInfo
import ai.youbrain.mobile.data.RdIceCandidate
import ai.youbrain.mobile.data.RdIceServer
import ai.youbrain.mobile.data.RdPeerEvent
import ai.youbrain.mobile.data.RdPermissions
import ai.youbrain.mobile.data.RelayDevice
import ai.youbrain.mobile.net.UBrainRepository
import ai.youbrain.mobile.ui.components.IosIcons
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.util.Locale
import java.util.UUID
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.roundToInt

private sealed interface MobileRdStatus {
    data class Connecting(val stageText: String = "正在获取穿透配置…") : MobileRdStatus
    data object Ready : MobileRdStatus
    data object Closed : MobileRdStatus
    data class Failed(val reason: String) : MobileRdStatus
}

private class RdCursorShape(val image: ImageBitmap, val hx: Float, val hy: Float, val w: Float, val h: Float)

/** 剪贴板同步的去重状态，不参与重组。 */
private class RdClipState {
    val assembler = ClipboardChunkAssembler()
    /** 最近一次与远端一致的文字（双向同步时用于跳过回声）。 */
    var lastSyncedText: String? = null
    /** 最近一次上传到远端剪贴板的本机图片 URI。 */
    var lastUploadedImage: String? = null
}

private class RdWebBridge(
    private val mainHandler: Handler,
    private val files: RdFileTransfers,
    private val onOffer: (String) -> Unit,
    private val onLocalIce: (RdIceCandidate) -> Unit,
    private val onTrackReady: () -> Unit,
    private val onVideoSize: (Int, Int) -> Unit,
    private val onControlMessage: (String) -> Unit,
    private val onConnState: (String) -> Unit,
    private val onError: (String) -> Unit,
    private val onControlOpen: () -> Unit,
    private val onStats: (Int, Int, Double, Int) -> Unit,
    private val onFileOpen: () -> Unit,
    private val onFileClosed: () -> Unit,
) {
    @JavascriptInterface
    fun postControlOpen() {
        mainHandler.post { onControlOpen() }
    }

    @JavascriptInterface
    fun postStats(fps: Int, kbps: Int, lossPct: Double, rttMs: Int) {
        mainHandler.post { onStats(fps, kbps, lossPct, rttMs) }
    }

    @JavascriptInterface
    fun postFileOpen() {
        mainHandler.post { onFileOpen() }
    }

    @JavascriptInterface
    fun postFileClosed() {
        mainHandler.post { onFileClosed() }
    }

    /** 以下三个在 JavaBridge 线程同步执行，保证帧与分片的先后顺序。 */
    @JavascriptInterface
    fun postFile(frame: String) {
        files.onFileFrame(frame)
    }

    @JavascriptInterface
    fun postFileChunk(id: String, b64: String) {
        files.onDownloadChunk(id, b64)
    }

    @JavascriptInterface
    fun upRead(id: String): String = files.readUploadChunk(id)

    @JavascriptInterface
    fun postOffer(sdp: String) {
        mainHandler.post { onOffer(sdp) }
    }

    @JavascriptInterface
    fun postIce(candidate: String, sdpMid: String?, sdpMLineIndex: Int, ufrag: String?) {
        mainHandler.post {
            onLocalIce(
                RdIceCandidate(
                    candidate = candidate,
                    sdpMid = sdpMid?.takeIf { it.isNotEmpty() },
                    sdpMLineIndex = if (sdpMLineIndex >= 0) sdpMLineIndex else null,
                    usernameFragment = ufrag?.takeIf { it.isNotEmpty() },
                ),
            )
        }
    }

    @JavascriptInterface
    fun postTrackReady() {
        mainHandler.post { onTrackReady() }
    }

    @JavascriptInterface
    fun postVideoSize(width: Int, height: Int) {
        mainHandler.post { onVideoSize(width, height) }
    }

    @JavascriptInterface
    fun postControl(payload: String) {
        mainHandler.post { onControlMessage(payload) }
    }

    @JavascriptInterface
    fun postState(state: String) {
        mainHandler.post { onConnState(state) }
    }

    @JavascriptInterface
    fun postError(reason: String) {
        mainHandler.post { onError(reason) }
    }
}

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun RemoteDesktopScreen(
    device: RelayDevice,
    displayName: String,
    repository: UBrainRepository,
    onClose: () -> Unit,
) {
    val context = LocalContext.current
    val view = LocalView.current
    val density = LocalDensity.current
    val haptic = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val json = remember { Json { ignoreUnknownKeys = true; encodeDefaults = true } }

    var status by remember { mutableStateOf<MobileRdStatus>(MobileRdStatus.Connecting()) }
    var inputMode by remember { mutableStateOf(RdInputMode.TOUCHPAD) }
    var quality by remember { mutableStateOf("hd") }
    var displays by remember { mutableStateOf<List<RdDisplayInfo>>(emptyList()) }
    var activeDisplayId by remember { mutableIntStateOf(0) }
    var permissions by remember { mutableStateOf(RdPermissions()) }
    var videoWidth by remember { mutableIntStateOf(1920) }
    var videoHeight by remember { mutableIntStateOf(1080) }
    var rttMs by remember { mutableStateOf<Int?>(null) }
    var reconnectNonce by remember { mutableIntStateOf(0) }

    var hudExpanded by remember { mutableStateOf(true) }
    var imeBarOpen by remember { mutableStateOf(false) }
    var imeDraft by remember { mutableStateOf("") }
    val imeFocusRequester = remember { FocusRequester() }
    var forceLandscape by remember { mutableStateOf(false) }

    // 粘滞修饰键与拖拽锁
    var modMeta by remember { mutableStateOf(false) }
    var modCtrl by remember { mutableStateOf(false) }
    var modAlt by remember { mutableStateOf(false) }
    var modShift by remember { mutableStateOf(false) }
    var dragLocked by remember { mutableStateOf(false) }

    // 容器尺寸与视口缩放平移
    var stageWidthPx by remember { mutableFloatStateOf(1f) }
    var stageHeightPx by remember { mutableFloatStateOf(1f) }
    var scale by remember { mutableFloatStateOf(1f) }
    var panX by remember { mutableFloatStateOf(0f) }
    var panY by remember { mutableFloatStateOf(0f) }

    // 触控板虚拟光标位置（归一化 0..1）与按住状态
    var cursor by remember { mutableStateOf(NormPoint(0.5f, 0.5f)) }
    var pointerDownVisual by remember { mutableStateOf(false) }

    // 剪贴板、光标形状、统计、文件传输
    val prefs = remember { context.getSharedPreferences("rd_prefs", Context.MODE_PRIVATE) }
    var clipboardSync by remember { mutableStateOf(prefs.getBoolean("clipboardSync", true)) }
    val clipState = remember { RdClipState() }
    val clipboardManager = remember { context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager }
    var cursorShape by remember { mutableStateOf<RdCursorShape?>(null) }
    var showStats by remember { mutableStateOf(false) }
    var statsText by remember { mutableStateOf("") }
    var combosOpen by remember { mutableStateOf(false) }
    var autoReconnects by remember { mutableIntStateOf(0) }
    var remoteFiles by remember { mutableStateOf<List<RdRemoteFile>>(emptyList()) }
    var transferItems by remember { mutableStateOf<List<RdTransferItem>>(emptyList()) }
    val uiHandler = remember { Handler(Looper.getMainLooper()) }
    val transfers = remember {
        RdFileTransfers(
            context = context.applicationContext,
            mainHandler = uiHandler,
            onItems = { transferItems = it },
            onMessage = { msg -> uiHandler.post { Toast.makeText(context, msg, Toast.LENGTH_SHORT).show() } },
        )
    }
    DisposableEffect(Unit) {
        onDispose { transfers.shutdown() }
    }

    var webViewRef by remember { mutableStateOf<WebView?>(null) }
    var fastPortRef by remember { mutableStateOf<WebMessagePort?>(null) }
    var activeSessionId by remember { mutableStateOf("") }

    BackHandler {
        onClose()
    }

    // 沉浸式全屏 + 常亮，退出时完整恢复系统栏与屏幕方向
    DisposableEffect(Unit) {
        val prevKeepScreenOn = view.keepScreenOn
        view.keepScreenOn = true
        val activity = context as? Activity
        val prevOrientation = activity?.requestedOrientation ?: ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        val window = activity?.window
        val insetsController = if (window != null) WindowCompat.getInsetsController(window, view) else null
        insetsController?.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        insetsController?.hide(WindowInsetsCompat.Type.systemBars())

        onDispose {
            view.keepScreenOn = prevKeepScreenOn
            insetsController?.show(WindowInsetsCompat.Type.systemBars())
            if (activity != null) {
                activity.requestedOrientation = prevOrientation
            }
        }
    }

    LaunchedEffect(forceLandscape) {
        val activity = context as? Activity ?: return@LaunchedEffect
        activity.requestedOrientation = if (forceLandscape) {
            ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        } else {
            ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
    }

    fun sendToEngine(channel: String, payloadJson: String) {
        val port = fastPortRef
        if (port != null) {
            runCatching {
                port.postMessage(WebMessage("$channel|$payloadJson"))
                return
            }
        }
        val wv = webViewRef ?: return
        val escaped = json.encodeToString(payloadJson)
        val fn = if (channel == "f") "window.__rdFast" else "window.__rdCtrl"
        wv.evaluateJavascript("$fn($escaped);", null)
    }

    fun sendFastMove(pt: NormPoint) {
        val msg = String.format(
            Locale.US,
            "{\"t\":\"mm\",\"x\":%.5f,\"y\":%.5f}",
            pt.x,
            pt.y,
        )
        sendToEngine("f", msg)
    }

    fun sendFastWheel(pt: NormPoint, dx: Int, dy: Int) {
        if (dx == 0 && dy == 0) return
        val msg = String.format(
            Locale.US,
            "{\"t\":\"wh\",\"x\":%.5f,\"y\":%.5f,\"dx\":%d,\"dy\":%d}",
            pt.x,
            pt.y,
            dx,
            dy,
        )
        sendToEngine("f", msg)
    }

    fun sendMouseButton(down: Boolean, pt: NormPoint, button: Int, clicks: Int = 1) {
        val op = if (down) "md" else "mu"
        val msg = String.format(
            Locale.US,
            "{\"t\":\"%s\",\"x\":%.5f,\"y\":%.5f,\"b\":%d,\"clicks\":%d}",
            op,
            pt.x,
            pt.y,
            button,
            clicks,
        )
        sendToEngine("c", msg)
    }

    fun clearStickyModifiers() {
        modMeta = false
        modCtrl = false
        modAlt = false
        modShift = false
    }

    fun sendKeyTap(code: String, forceShift: Boolean = false) {
        val downObj = buildJsonObject {
            put("t", "kd")
            put("code", code)
            if (modMeta) put("meta", true)
            if (modCtrl) put("ctrl", true)
            if (modAlt) put("alt", true)
            if (modShift || forceShift) put("shift", true)
        }
        val upObj = buildJsonObject {
            put("t", "ku")
            put("code", code)
            put("meta", modMeta)
            put("ctrl", modCtrl)
            put("alt", modAlt)
            put("shift", modShift || forceShift)
        }
        sendToEngine("c", downObj.toString())
        sendToEngine("c", upObj.toString())
        clearStickyModifiers()
    }

    fun sendCombo(codes: List<String>) {
        for (ev in expandKeyCombo(codes)) {
            val obj = buildJsonObject {
                put("t", if (ev.down) "kd" else "ku")
                put("code", ev.code)
                put("meta", ev.meta)
                put("ctrl", ev.ctrl)
                put("alt", ev.alt)
                put("shift", ev.shift)
            }
            sendToEngine("c", obj.toString())
        }
        clearStickyModifiers()
    }

    fun toast(message: String) {
        Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
    }

    fun sendCfg() {
        sendToEngine("c", "{\"t\":\"cfg\",\"localCursor\":true,\"clipboardSync\":$clipboardSync}")
    }

    fun sendClipboardTextToRemote(text: String) {
        val clipped = if (text.length > RD_CLIPBOARD_MAX_CHARS) text.substring(0, RD_CLIPBOARD_MAX_CHARS) else text
        clipState.lastSyncedText = clipped
        val parts = chunkClipboardText(clipped)
        if (parts.size == 1) {
            sendToEngine("c", buildJsonObject { put("t", "cb.set"); put("text", clipped) }.toString())
            return
        }
        val batch = UUID.randomUUID().toString().replace("-", "").take(12)
        parts.forEachIndexed { i, part ->
            val obj = buildJsonObject {
                put("t", "cb.set")
                put("text", part)
                put("chunk", buildJsonObject { put("id", batch); put("i", i); put("n", parts.size) })
            }
            sendToEngine("c", obj.toString())
        }
    }

    /** 本机剪贴板里的图片（没有文字时）。 */
    fun localClipboardImage(): Uri? {
        val clip = runCatching { clipboardManager?.primaryClip }.getOrNull() ?: return null
        if (clip.itemCount == 0) return null
        val item = clip.getItemAt(0)
        val uri = item.uri ?: return null
        if (!item.text.isNullOrEmpty()) return null
        val mime = runCatching { context.contentResolver.getType(uri) }.getOrNull()
        val isImage = mime?.startsWith("image/") == true || clip.description.hasMimeType("image/*")
        return if (isImage) uri else null
    }

    /**
     * 把本机剪贴板同步到远端。[manual] 为用户点按「发送剪贴板」，[thenPaste] 为「粘贴」：
     * 同步完成后在远端按下 ⌘V。自动同步时内容未变就跳过。
     */
    fun syncLocalClipboardToRemote(manual: Boolean, thenPaste: Boolean) {
        if (status != MobileRdStatus.Ready) return
        val pasteKeys = listOf("MetaLeft", "KeyV")
        val image = localClipboardImage()
        if (image != null) {
            val key = image.toString()
            val alreadyRemote = image == transfers.lastClipboardImageUri ||
                (!manual && key == clipState.lastUploadedImage)
            if (alreadyRemote) {
                if (thenPaste) sendCombo(pasteKeys) else if (manual) toast("远端剪贴板已是这张图片")
                return
            }
            if (manual || thenPaste) toast("正在把图片发送到远端剪贴板…")
            transfers.uploadClipboardImage(image) { err ->
                if (err == null) {
                    clipState.lastUploadedImage = key
                    clipState.lastSyncedText = ""
                    if (thenPaste) sendCombo(pasteKeys) else if (manual) toast("图片已写入远端剪贴板")
                } else if (manual || thenPaste) {
                    toast("图片同步失败：$err")
                }
            }
            return
        }
        val text = runCatching {
            clipboardManager?.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString()
        }.getOrNull().orEmpty()
        if (text.isEmpty()) {
            if (thenPaste) sendCombo(pasteKeys) else if (manual) toast("本机剪贴板为空")
            return
        }
        if (manual || text != clipState.lastSyncedText) sendClipboardTextToRemote(text)
        if (thenPaste) sendCombo(pasteKeys) else if (manual) toast("已发送到远端剪贴板")
    }

    val pickFiles = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) {
            transfers.uploadUris(uris)
            toast("正在把 ${uris.size} 个文件发送到远端「下载」文件夹")
        }
    }

    // 本机剪贴板变化（应用在前台时）与回到前台：自动同步到远端
    val latestSync by rememberUpdatedState(clipboardSync)
    DisposableEffect(clipboardManager) {
        val listener = ClipboardManager.OnPrimaryClipChangedListener {
            if (latestSync) syncLocalClipboardToRemote(manual = false, thenPaste = false)
        }
        clipboardManager?.addPrimaryClipChangedListener(listener)
        val focusListener = ViewTreeObserver.OnWindowFocusChangeListener { hasFocus ->
            // Android 10+ 只有获得焦点后才能读剪贴板
            if (hasFocus && latestSync) {
                uiHandler.postDelayed({ syncLocalClipboardToRemote(manual = false, thenPaste = false) }, 150L)
            }
        }
        view.viewTreeObserver.addOnWindowFocusChangeListener(focusListener)
        onDispose {
            clipboardManager?.removePrimaryClipChangedListener(listener)
            if (view.viewTreeObserver.isAlive) view.viewTreeObserver.removeOnWindowFocusChangeListener(focusListener)
        }
    }

    fun sendTextCommit(text: String) {
        if (text.isEmpty()) return
        // 如果挂了 Cmd/Ctrl/Alt 组合键且为单字母，转成快捷键投递（例如手机输入 Cmd+C / Cmd+V）
        if ((modMeta || modCtrl || modAlt) && text.length == 1) {
            val ch = text[0].uppercaseChar()
            if (ch in 'A'..'Z') {
                sendKeyTap("Key$ch")
                return
            }
            if (ch in '0'..'9') {
                sendKeyTap("Digit$ch")
                return
            }
        }
        val payload = buildJsonObject {
            put("t", "txt")
            put("text", text)
        }
        sendToEngine("c", payload.toString())
        clearStickyModifiers()
    }

    // RTT 心跳测量（每 2 秒一次）
    LaunchedEffect(status, activeSessionId) {
        if (status != MobileRdStatus.Ready) return@LaunchedEffect
        while (isActive) {
            val nowMs = System.currentTimeMillis()
            sendToEngine("c", "{\"t\":\"ping\",\"ts\":$nowMs}")
            delay(2_000L)
        }
    }

    // 会话生命周期（WebView WebRTC + Trickle ICE + 信令握手）
    DisposableEffect(device.id, reconnectNonce) {
        val mainHandler = Handler(Looper.getMainLooper())
        var disposed = false
        var sessionId = "rd-" + UUID.randomUUID().toString().replace("-", "").take(20)
        var rdOpenReady = false
        var remoteDescReady = false
        var settled = false
        var everReady = false
        var hasTurn = false
        val localIceBuffer = ArrayList<RdIceCandidate>()
        val remoteIceBuffer = ArrayList<RdIceCandidate>()
        var iceFlushJob: Job? = null
        var iceTimeoutJob: Job? = null
        var disconnectJob: Job? = null
        var reconnectJob: Job? = null
        var hostClosed = false

        status = if (autoReconnects > 0) {
            MobileRdStatus.Connecting("连接中断，正在重连（第 $autoReconnects 次）…")
        } else {
            MobileRdStatus.Connecting("正在获取穿透配置…")
        }
        rttMs = null
        activeSessionId = ""
        cursorShape = null
        statsText = ""

        fun evalJs(script: String) {
            if (disposed) return
            webViewRef?.evaluateJavascript(script, null)
        }

        fun iceFailedReason(): String = if (hasTurn) {
            "ICE / TURN 建连失败或超时，请检查中转 TURN 端口（3478/udp、3478/tcp）与双方网络后重试。"
        } else {
            "ICE / P2P 无法跨网直连（当前中转未配置 TURN 中继，跨局域网或开启 VPN 时 UDP 打洞通常会失败）。请在中转 VPS 部署 coturn 并配置 RELAY_TURN_URLS / RELAY_TURN_SECRET，或将两台设备切到同一局域网。"
        }

        fun markReady() {
            if (disposed || settled) return
            settled = true
            everReady = true
            autoReconnects = 0
            iceTimeoutJob?.cancel()
            iceTimeoutJob = null
            status = MobileRdStatus.Ready
        }

        /** 用过的连接意外断开时自动重连（指数退避，最多 [RD_MAX_AUTO_RECONNECTS] 次）。 */
        fun scheduleReconnect(): Boolean {
            if (!(everReady || autoReconnects > 0) || autoReconnects >= RD_MAX_AUTO_RECONNECTS) return false
            autoReconnects += 1
            val attempt = autoReconnects
            status = MobileRdStatus.Connecting("连接中断，正在重连（第 $attempt 次）…")
            reconnectJob = scope.launch {
                delay(rdReconnectDelayMs(attempt))
                if (!disposed) reconnectNonce += 1
            }
            return true
        }

        fun failWith(reason: String) {
            if (disposed || settled) return
            settled = true
            iceTimeoutJob?.cancel()
            iceTimeoutJob = null
            disconnectJob?.cancel()
            evalJs("window.__rdClose && window.__rdClose();")
            if (rdOpenReady) {
                rdOpenReady = false
                repository.closeRemoteDesktopAsync(device.id, sessionId)
            }
            if (!scheduleReconnect()) status = MobileRdStatus.Failed(reason)
        }

        /** 已建立的连接掉线（宿主主动结束的不算）。 */
        fun dropConnection(reason: String) {
            if (disposed || hostClosed) return
            settled = false
            failWith(reason)
        }

        fun flushLocalIce() {
            iceFlushJob?.cancel()
            iceFlushJob = null
            if (disposed || !remoteDescReady || localIceBuffer.isEmpty()) return
            val batch = ArrayList<RdIceCandidate>(minOf(32, localIceBuffer.size))
            repeat(minOf(32, localIceBuffer.size)) {
                batch.add(localIceBuffer.removeAt(0))
            }
            scope.launch {
                repository.sendRemoteDesktopIce(device.id, sessionId, batch)
            }
            if (localIceBuffer.isNotEmpty()) {
                iceFlushJob = scope.launch {
                    delay(15L)
                    flushLocalIce()
                }
            }
        }

        fun pushRemoteCandidates(list: List<RdIceCandidate>) {
            if (disposed || list.isEmpty()) return
            val encoded = json.encodeToString(list)
            val escaped = json.encodeToString(encoded)
            evalJs("window.__rdAddIce && window.__rdAddIce($escaped);")
        }

        val eventsJob = scope.launch {
            repository.rdEvents.collect { ev ->
                if (disposed || ev.from != device.id) return@collect
                when (ev) {
                    is RdPeerEvent.Ice -> {
                        if (ev.sessionId != sessionId) return@collect
                        if (!remoteDescReady) {
                            remoteIceBuffer.addAll(ev.candidates)
                        } else {
                            pushRemoteCandidates(ev.candidates)
                        }
                    }
                    is RdPeerEvent.State -> {
                        if (ev.sessionId != sessionId) return@collect
                        ev.displays?.let { displays = it }
                        ev.activeDisplayId?.let { activeDisplayId = it }
                        ev.permissions?.let { permissions = it }
                        if (ev.state == "closed") {
                            hostClosed = true
                            settled = true
                            iceTimeoutJob?.cancel()
                            iceTimeoutJob = null
                            rdOpenReady = false
                            status = MobileRdStatus.Closed
                        } else if (ev.state == "error") {
                            failWith(ev.error ?: "远端桌面宿主异常")
                        }
                    }
                }
            }
        }

        val bridge = RdWebBridge(
            mainHandler = mainHandler,
            files = transfers,
            onOffer = { offerSdp ->
                if (disposed) return@RdWebBridge
                if (!settled) status = MobileRdStatus.Connecting("正在请求远端桌面会话…")
                scope.launch {
                    val res = repository.openRemoteDesktop(
                        toDeviceId = device.id,
                        offerSdp = offerSdp,
                        quality = quality,
                        displayId = activeDisplayId.takeIf { displays.isNotEmpty() },
                        sessionId = sessionId,
                    )
                    if (disposed) {
                        res.getOrNull()?.let { repository.closeRemoteDesktopAsync(device.id, it.sessionId) }
                        return@launch
                    }
                    res.fold(
                        onSuccess = { open ->
                            sessionId = open.sessionId
                            activeSessionId = open.sessionId
                            rdOpenReady = true
                            displays = open.displays
                            activeDisplayId = open.activeDisplayId
                            permissions = open.permissions
                            val escapedAnswer = json.encodeToString(open.answerSdp)
                            evalJs("window.__rdApplyAnswer && window.__rdApplyAnswer($escapedAnswer);")
                            remoteDescReady = true
                            if (!settled) {
                                status = MobileRdStatus.Connecting("正在建立实时连接（ICE 穿透中）…")
                            }
                            if (remoteIceBuffer.isNotEmpty()) {
                                val drained = ArrayList(remoteIceBuffer)
                                remoteIceBuffer.clear()
                                pushRemoteCandidates(drained)
                            }
                            flushLocalIce()
                            if (!settled) {
                                iceTimeoutJob?.cancel()
                                iceTimeoutJob = scope.launch {
                                    delay(15_000L)
                                    failWith(iceFailedReason())
                                }
                            }
                        },
                        onFailure = { err ->
                            failWith(err.message ?: "无法建立桌面协同会话")
                        },
                    )
                }
            },
            onLocalIce = { cand ->
                if (disposed) return@RdWebBridge
                localIceBuffer.add(cand)
                if (!remoteDescReady) return@RdWebBridge
                if (localIceBuffer.size >= 24) {
                    flushLocalIce()
                } else if (iceFlushJob == null) {
                    iceFlushJob = scope.launch {
                        delay(15L)
                        flushLocalIce()
                    }
                }
            },
            onTrackReady = {
                markReady()
            },
            onVideoSize = { w, h ->
                if (!disposed && w > 0 && h > 0) {
                    videoWidth = w
                    videoHeight = h
                }
            },
            onControlMessage = { rawText ->
                if (disposed) return@RdWebBridge
                val obj = runCatching { json.parseToJsonElement(rawText).jsonObject }.getOrNull() ?: return@RdWebBridge
                when (obj["t"]?.jsonPrimitive?.contentOrNull) {
                    "pong" -> {
                        val ts = obj["ts"]?.jsonPrimitive?.longOrNull ?: return@RdWebBridge
                        val delta = (System.currentTimeMillis() - ts).toInt()
                        if (delta in 0..10_000) rttMs = delta
                    }
                    "state" -> {
                        val parsed = runCatching {
                            json.decodeFromJsonElement(
                                ai.youbrain.mobile.data.RdStateEventPayload.serializer(),
                                buildJsonObject {
                                    put("sessionId", sessionId.ifEmpty { "rd-local" })
                                    put("state", "ready")
                                    obj["displays"]?.let { put("displays", it) }
                                    obj["activeDisplayId"]?.let { put("activeDisplayId", it) }
                                    obj["permissions"]?.let { put("permissions", it) }
                                },
                            )
                        }.getOrNull()
                        parsed?.displays?.let { displays = it }
                        parsed?.activeDisplayId?.let { activeDisplayId = it }
                        parsed?.permissions?.let { permissions = it }
                        obj["quality"]?.jsonPrimitive?.contentOrNull?.let { quality = it }
                    }
                    "cb" -> {
                        val raw = obj["text"]?.jsonPrimitive?.contentOrNull.orEmpty()
                        val chunk = runCatching { obj["chunk"]?.jsonObject }.getOrNull()
                        val text = clipState.assembler.push(
                            raw,
                            chunk?.get("id")?.jsonPrimitive?.contentOrNull,
                            chunk?.get("i")?.jsonPrimitive?.intOrNull,
                            chunk?.get("n")?.jsonPrimitive?.intOrNull,
                        ) ?: return@RdWebBridge
                        val auto = obj["auto"]?.jsonPrimitive?.booleanOrNull == true
                        if (auto && (!clipboardSync || text.isEmpty() || text == clipState.lastSyncedText)) {
                            return@RdWebBridge
                        }
                        if (text.isEmpty()) {
                            toast("远端剪贴板为空")
                            return@RdWebBridge
                        }
                        clipState.lastSyncedText = text
                        clipboardManager?.setPrimaryClip(ClipData.newPlainText("U-Brain Remote Desktop", text))
                        if (!auto) toast("已复制远端剪贴板内容")
                    }
                    "cb.image" -> {
                        val auto = obj["auto"]?.jsonPrimitive?.booleanOrNull == true
                        if (auto && !clipboardSync) return@RdWebBridge
                        transfers.fetchClipboardImage { err ->
                            if (err == null) {
                                clipState.lastSyncedText = ""
                                if (!auto) toast("已复制远端剪贴板里的图片")
                            } else if (!auto) {
                                toast("图片剪贴板同步失败：$err")
                            }
                        }
                    }
                    "cb.files" -> {
                        remoteFiles = runCatching {
                            obj["files"]?.jsonArray?.mapNotNull { el ->
                                val f = el.jsonObject
                                val path = f["path"]?.jsonPrimitive?.contentOrNull ?: return@mapNotNull null
                                RdRemoteFile(
                                    path = path,
                                    name = f["name"]?.jsonPrimitive?.contentOrNull ?: path.substringAfterLast('/'),
                                    size = f["size"]?.jsonPrimitive?.longOrNull ?: 0L,
                                )
                            }
                        }.getOrNull().orEmpty()
                    }
                    "cursor" -> {
                        val png = obj["png"]?.jsonPrimitive?.contentOrNull ?: return@RdWebBridge
                        val bitmap = runCatching {
                            val bytes = Base64.decode(png, Base64.DEFAULT)
                            BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
                        }.getOrNull() ?: return@RdWebBridge
                        fun num(key: String): Float =
                            obj[key]?.jsonPrimitive?.contentOrNull?.toFloatOrNull() ?: 0f
                        val w = num("w").takeIf { it > 0f } ?: bitmap.width.toFloat()
                        val h = num("h").takeIf { it > 0f } ?: bitmap.height.toFloat()
                        cursorShape = RdCursorShape(bitmap.asImageBitmap(), num("hx"), num("hy"), w, h)
                    }
                }
            },
            onConnState = { st ->
                if (disposed) return@RdWebBridge
                when (st) {
                    "connected", "completed" -> {
                        disconnectJob?.cancel()
                        disconnectJob = null
                        markReady()
                    }
                    "failed" -> if (everReady) dropConnection("网络中断") else failWith(iceFailedReason())
                    // 短暂断网会先进入 disconnected：给 4 秒自愈，否则按断线重连
                    "disconnected" -> if (everReady && disconnectJob == null) {
                        disconnectJob = scope.launch {
                            delay(4_000L)
                            disconnectJob = null
                            dropConnection("网络中断")
                        }
                    }
                    "closed" -> if (everReady) dropConnection("连接已关闭")
                }
            },
            onError = { reason ->
                failWith(reason)
            },
            onControlOpen = {
                if (!disposed) sendCfg()
            },
            onStats = { fps, kbps, loss, rtt ->
                if (!disposed) {
                    statsText = buildString {
                        append("${fps}fps · ")
                        append(if (kbps >= 1000) String.format(Locale.US, "%.1fMbps", kbps / 1000.0) else "${kbps}kbps")
                        if (loss >= 0.1) append(String.format(Locale.US, " · 丢包%.1f%%", loss))
                        if (rtt >= 0) append(" · RTT ${rtt}ms")
                    }
                }
            },
            onFileOpen = {
                if (!disposed) transfers.attach { script -> evalJs(script) }
            },
            onFileClosed = {
                transfers.detach("文件通道已关闭")
            },
        )

        val wv = WebView(context).apply {
            layoutParams = ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            )
            setBackgroundColor(AndroidColor.rgb(9, 11, 16))
            setLayerType(View.LAYER_TYPE_HARDWARE, null)
            isClickable = false
            isFocusable = false
            isLongClickable = false
            isHorizontalScrollBarEnabled = false
            isVerticalScrollBarEnabled = false
            settings.javaScriptEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.domStorageEnabled = false
            settings.cacheMode = WebSettings.LOAD_NO_CACHE
            addJavascriptInterface(bridge, "RdNative")
            webChromeClient = WebChromeClient()
            webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String?) {
                    if (disposed) return
                    val channels = view.createWebMessageChannel()
                    fastPortRef = channels[0]
                    view.postWebMessage(
                        WebMessage("init_port", arrayOf(channels[1])),
                        Uri.parse("https://rd.youbrain.local"),
                    )
                    scope.launch {
                        val iceServers: List<RdIceServer> = repository.fetchTurnIceServers()
                        if (disposed) return@launch
                        hasTurn = iceServers.any { srv ->
                            srv.urls.any { it.startsWith("turn:", ignoreCase = true) || it.startsWith("turns:", ignoreCase = true) }
                        }
                        val iceJson = json.encodeToString(iceServers)
                        val escaped = json.encodeToString(iceJson)
                        view.evaluateJavascript("window.__rdStart($escaped);", null)
                    }
                }
            }
            loadDataWithBaseURL(
                "https://rd.youbrain.local/",
                RD_WEBVIEW_HTML,
                "text/html",
                "utf-8",
                null,
            )
        }
        webViewRef = wv

        onDispose {
            disposed = true
            eventsJob.cancel()
            iceFlushJob?.cancel()
            iceTimeoutJob?.cancel()
            disconnectJob?.cancel()
            reconnectJob?.cancel()
            transfers.detach("连接已断开")
            runCatching { fastPortRef?.close() }
            fastPortRef = null
            if (rdOpenReady) {
                rdOpenReady = false
                repository.closeRemoteDesktopAsync(device.id, sessionId)
            }
            webViewRef = null
            runCatching {
                wv.evaluateJavascript("window.__rdClose && window.__rdClose();", null)
                wv.removeJavascriptInterface("RdNative")
                wv.stopLoading()
                wv.destroy()
            }
        }
    }

    val videoBox = remember(stageWidthPx, stageHeightPx, videoWidth, videoHeight) {
        RemoteDesktopMath.computeVideoBox(stageWidthPx, stageHeightPx, videoWidth, videoHeight)
    }

    // 最新状态引用，供长生命周期 pointerInput 协程零重组读取
    val latestMode by rememberUpdatedState(inputMode)
    val latestStatus by rememberUpdatedState(status)
    val latestVideoBox by rememberUpdatedState(videoBox)
    val latestStageW by rememberUpdatedState(stageWidthPx)
    val latestStageH by rememberUpdatedState(stageHeightPx)
    val latestScale by rememberUpdatedState(scale)
    val latestPanX by rememberUpdatedState(panX)
    val latestPanY by rememberUpdatedState(panY)
    val latestCursor by rememberUpdatedState(cursor)
    val latestDragLocked by rememberUpdatedState(dragLocked)
    val latestVideoRatio by rememberUpdatedState(
        if (videoHeight > 0) videoWidth.toFloat() / videoHeight.toFloat() else 16f / 9f,
    )

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(Color(0xFF090B10)),
    ) {
        // 底层：WebRTC 硬件解码画布 + 手势捕获层
        Box(
            modifier = Modifier
                .fillMaxSize()
                .onSizeChanged { sz ->
                    stageWidthPx = sz.width.toFloat().coerceAtLeast(1f)
                    stageHeightPx = sz.height.toFloat().coerceAtLeast(1f)
                }
                .pointerInput(Unit) {
                    val touchSlopPx = viewConfiguration.touchSlop
                    var lastSingleTapUpTime = 0L
                    var lastSingleTapNorm = NormPoint(0.5f, 0.5f)
                    var lastFastSendMs = 0L

                    fun throttledMove(pt: NormPoint, force: Boolean = false) {
                        val now = SystemClock.uptimeMillis()
                        if (force || now - lastFastSendMs >= 8L) {
                            lastFastSendMs = now
                            sendFastMove(pt)
                        }
                    }

                    awaitEachGesture {
                        val firstDown = awaitFirstDown(requireUnconsumed = false)
                        firstDown.consume()
                        if (latestStatus != MobileRdStatus.Ready) return@awaitEachGesture

                        val downTime = SystemClock.uptimeMillis()
                        val modeAtStart = latestMode
                        val isDoubleTapCandidate = (downTime - lastSingleTapUpTime) <= 280L

                        var maxPointersSeen = 1
                        var movedPastSlop = false
                        var dragStarted = false
                        var rightClickFiredOnHold = false
                        var totalMovePx = 0f

                        // 触控板模式下：若开启了拖拽锁，或双击后不抬手继续滑，立即按住左键拖拽
                        val touchpadHoldDrag = modeAtStart == RdInputMode.TOUCHPAD &&
                            (latestDragLocked || isDoubleTapCandidate)
                        if (modeAtStart == RdInputMode.TOUCHPAD && latestDragLocked) {
                            dragStarted = true
                            pointerDownVisual = true
                            sendMouseButton(true, latestCursor, 0, 1)
                        }

                        val startDirectNorm = RemoteDesktopMath.screenToNormalizedDirect(
                            touchX = firstDown.position.x,
                            touchY = firstDown.position.y,
                            containerWidth = latestStageW,
                            containerHeight = latestStageH,
                            box = latestVideoBox,
                            scale = latestScale,
                            panX = latestPanX,
                            panY = latestPanY,
                        )

                        while (true) {
                            val event = withTimeoutOrNull(420L) { awaitPointerEvent() }
                            if (event == null) {
                                // 手指静止满 420ms 且未移动、单指：在直触模式下触发右键点击！
                                if (!movedPastSlop && maxPointersSeen == 1 && !rightClickFiredOnHold &&
                                    modeAtStart == RdInputMode.DIRECT
                                ) {
                                    rightClickFiredOnHold = true
                                    cursor = startDirectNorm
                                    haptic.performHapticFeedback(HapticFeedbackType.LongPress)
                                    sendMouseButton(true, startDirectNorm, 2, 1)
                                    sendMouseButton(false, startDirectNorm, 2, 1)
                                }
                                continue
                            }

                            val pressed = event.changes.filter { it.pressed }
                            if (pressed.isEmpty()) {
                                // 所有手指抬起
                                break
                            }

                            if (pressed.size > maxPointersSeen) {
                                maxPointersSeen = pressed.size
                            }

                            if (pressed.size >= 2) {
                                // 若刚从单指切双指且之前误开了拖拽，先释放左键
                                if (dragStarted && !latestDragLocked) {
                                    dragStarted = false
                                    pointerDownVisual = false
                                    sendMouseButton(false, latestCursor, 0, 1)
                                }

                                val pan = event.calculatePan()
                                val zoomChange = event.calculateZoom()
                                event.changes.forEach { if (it.positionChanged()) it.consume() }

                                if (pan != Offset.Zero) {
                                    totalMovePx += hypot(pan.x, pan.y)
                                    if (totalMovePx > touchSlopPx) movedPastSlop = true
                                }

                                if (modeAtStart == RdInputMode.TOUCHPAD) {
                                    // 触控板双指滑动 → macOS 原生平滑滚轮
                                    if (movedPastSlop) {
                                        val dxDp = with(density) { pan.x.toDp().value }
                                        val dyDp = with(density) { pan.y.toDp().value }
                                        val (sx, sy) = RemoteDesktopMath.toMacScrollPixels(dxDp, dyDp)
                                        sendFastWheel(latestCursor, sx, sy)
                                    }
                                } else {
                                    // 直触模式双指捏合缩放 + 双指平移视口
                                    val nextScale = (latestScale * zoomChange).coerceIn(1f, 4f)
                                    val centroid = event.calculateCentroid(useCurrent = true)
                                    val cx = latestStageW * 0.5f
                                    val cy = latestStageH * 0.5f
                                    val ratio = if (latestScale > 0f) nextScale / latestScale else 1f
                                    val rawPanX = (latestPanX - (centroid.x - cx)) * ratio + (centroid.x - cx) + pan.x
                                    val rawPanY = (latestPanY - (centroid.y - cy)) * ratio + (centroid.y - cy) + pan.y
                                    val (clampedX, clampedY) = RemoteDesktopMath.clampPan(
                                        rawPanX,
                                        rawPanY,
                                        latestStageW,
                                        latestStageH,
                                        nextScale,
                                    )
                                    scale = nextScale
                                    panX = clampedX
                                    panY = clampedY
                                    movedPastSlop = true
                                }
                                continue
                            }

                            // 单指移动（且整段手势未曾出现过多指）
                            if (maxPointersSeen == 1) {
                                val change = pressed.first()
                                val delta = change.position - change.previousPosition
                                if (delta != Offset.Zero) {
                                    change.consume()
                                    totalMovePx += hypot(delta.x, delta.y)
                                    if (!movedPastSlop && totalMovePx > touchSlopPx) {
                                        movedPastSlop = true
                                        if (modeAtStart == RdInputMode.TOUCHPAD && touchpadHoldDrag && !dragStarted) {
                                            dragStarted = true
                                            pointerDownVisual = true
                                            haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                            sendMouseButton(true, latestCursor, 0, 1)
                                        } else if (modeAtStart == RdInputMode.DIRECT && !rightClickFiredOnHold && !dragStarted) {
                                            dragStarted = true
                                            pointerDownVisual = true
                                            cursor = startDirectNorm
                                            sendMouseButton(true, startDirectNorm, 0, 1)
                                        }
                                    }

                                    if (movedPastSlop && !rightClickFiredOnHold) {
                                        if (modeAtStart == RdInputMode.TOUCHPAD) {
                                            val dxDp = with(density) { delta.x.toDp().value }
                                            val dyDp = with(density) { delta.y.toDp().value }
                                            val refWidthDp = with(density) { latestStageW.toDp().value }
                                            val next = RemoteDesktopMath.applyTrackpadDelta(
                                                current = latestCursor,
                                                deltaXDp = dxDp,
                                                deltaYDp = dyDp,
                                                referenceWidthDp = refWidthDp * 0.72f,
                                                aspectRatio = latestVideoRatio,
                                            )
                                            cursor = next
                                            throttledMove(next)
                                        } else {
                                            val pt = RemoteDesktopMath.screenToNormalizedDirect(
                                                touchX = change.position.x,
                                                touchY = change.position.y,
                                                containerWidth = latestStageW,
                                                containerHeight = latestStageH,
                                                box = latestVideoBox,
                                                scale = latestScale,
                                                panX = latestPanX,
                                                panY = latestPanY,
                                            )
                                            cursor = pt
                                            throttledMove(pt)
                                        }
                                    }
                                }
                            }
                        }

                        // 手势结束结算
                        val upTime = SystemClock.uptimeMillis()
                        if (dragStarted) {
                            pointerDownVisual = false
                            val endPt = latestCursor
                            throttledMove(endPt, force = true)
                            sendMouseButton(false, endPt, 0, 1)
                            lastSingleTapUpTime = 0L
                        } else if (!movedPastSlop && !rightClickFiredOnHold && (upTime - downTime) < 420L) {
                            if (maxPointersSeen == 2) {
                                // 双指轻点 → 右键单击
                                val pt = latestCursor
                                haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                sendMouseButton(true, pt, 2, 1)
                                sendMouseButton(false, pt, 2, 1)
                                lastSingleTapUpTime = 0L
                            } else if (maxPointersSeen == 1) {
                                val tapPt = if (modeAtStart == RdInputMode.TOUCHPAD) {
                                    latestCursor
                                } else {
                                    cursor = startDirectNorm
                                    startDirectNorm
                                }
                                val nearPrev = hypot(
                                    tapPt.x - lastSingleTapNorm.x,
                                    tapPt.y - lastSingleTapNorm.y,
                                ) < 0.04f
                                val clicks = if (isDoubleTapCandidate && nearPrev) 2 else 1
                                sendFastMove(tapPt)
                                sendMouseButton(true, tapPt, 0, clicks)
                                sendMouseButton(false, tapPt, 0, clicks)
                                lastSingleTapUpTime = if (clicks == 1) upTime else 0L
                                lastSingleTapNorm = tapPt
                            }
                        }
                    }
                },
        ) {
            val currentWv = webViewRef
            if (currentWv != null) {
                AndroidView(
                    modifier = Modifier
                        .fillMaxSize()
                        .graphicsLayer {
                            scaleX = scale
                            scaleY = scale
                            translationX = panX
                            translationY = panY
                        },
                    factory = { currentWv },
                    update = { _ -> },
                )
            }

            // 远端光标：有形状时按远端真实形状绘制（两种模式都画），否则触控板模式画默认箭头
            val shape = cursorShape
            if (status == MobileRdStatus.Ready && (shape != null || inputMode == RdInputMode.TOUCHPAD)) {
                val (cx, cy) = RemoteDesktopMath.normalizedToScreen(
                    normX = cursor.x,
                    normY = cursor.y,
                    containerWidth = stageWidthPx,
                    containerHeight = stageHeightPx,
                    box = videoBox,
                    scale = scale,
                    panX = panX,
                    panY = panY,
                )
                Canvas(modifier = Modifier.fillMaxSize()) {
                    val s = density.density
                    val arrow = Path().apply {
                        moveTo(cx, cy)
                        lineTo(cx, cy + 16f * s)
                        lineTo(cx + 4.4f * s, cy + 12.2f * s)
                        lineTo(cx + 7.4f * s, cy + 18.2f * s)
                        lineTo(cx + 9.8f * s, cy + 17.0f * s)
                        lineTo(cx + 6.8f * s, cy + 11.0f * s)
                        lineTo(cx + 12.0f * s, cy + 11.0f * s)
                        close()
                    }
                    if (pointerDownVisual || dragLocked) {
                        drawCircle(
                            color = Color(0x663B82F6),
                            radius = 14f * s,
                            center = Offset(cx, cy),
                        )
                    }
                    if (shape != null) {
                        val displayWidth = displays.firstOrNull { it.id == activeDisplayId }?.width
                            ?: displays.firstOrNull()?.width ?: videoWidth
                        // 按画面缩放还原真实大小，手机上至少按 0.9dp/pt 显示，避免光标太小看不清
                        val k = max(videoBox.width * scale / displayWidth.coerceAtLeast(1), 0.9f * s)
                        val dw = (shape.w * k).roundToInt().coerceAtLeast(1)
                        val dh = (shape.h * k).roundToInt().coerceAtLeast(1)
                        drawImage(
                            image = shape.image,
                            srcOffset = IntOffset.Zero,
                            srcSize = IntSize(shape.image.width, shape.image.height),
                            dstOffset = IntOffset((cx - shape.hx * k).roundToInt(), (cy - shape.hy * k).roundToInt()),
                            dstSize = IntSize(dw, dh),
                            filterQuality = FilterQuality.High,
                        )
                    } else {
                        drawPath(arrow, color = Color(0xEE111827))
                        drawPath(arrow, color = Color.White, style = Stroke(width = 1.4f * s))
                    }
                }
            }
        }

        // 连接中 / 断开 / 错误覆盖层
        if (status != MobileRdStatus.Ready) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color(0xC8090B10))
                    .padding(24.dp),
                contentAlignment = Alignment.Center,
            ) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    when (val st = status) {
                        is MobileRdStatus.Connecting -> {
                            CircularProgressIndicator(
                                color = Color(0xFF3B82F6),
                                modifier = Modifier.size(28.dp),
                                strokeWidth = 2.6.dp,
                            )
                            Text(
                                text = st.stageText,
                                color = Color.White,
                                fontSize = 14.sp,
                            )
                        }
                        MobileRdStatus.Closed -> {
                            Text(
                                text = "远端桌面协同会话已断开",
                                color = Color.White,
                                fontSize = 15.sp,
                                fontWeight = FontWeight.SemiBold,
                            )
                            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                HudChip(
                                    text = "重新连接",
                                    active = true,
                                    onClick = {
                                        autoReconnects = 0
                                        reconnectNonce += 1
                                    },
                                )
                                HudChip(text = "返回", active = false, onClick = onClose)
                            }
                        }
                        is MobileRdStatus.Failed -> {
                            Text(
                                text = st.reason,
                                color = Color(0xFFFCA5A5),
                                fontSize = 14.sp,
                                fontWeight = FontWeight.Medium,
                            )
                            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                                HudChip(
                                    text = "重试连接",
                                    active = true,
                                    onClick = {
                                        autoReconnects = 0
                                        reconnectNonce += 1
                                    },
                                )
                                HudChip(text = "退出", active = false, onClick = onClose)
                            }
                        }
                        MobileRdStatus.Ready -> Unit
                    }
                }
            }
        }

        // 顶部悬浮控制胶囊栏（可折叠）
        Column(
            modifier = Modifier
                .align(Alignment.TopCenter)
                .fillMaxWidth()
                .statusBarsPadding()
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            if (!hudExpanded) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    HudChip(text = "← 退出", active = false, onClick = onClose)
                    HudChip(
                        text = "${displayName}${rttMs?.let { " · ${it}ms" }.orEmpty()} ▾",
                        active = false,
                        onClick = { hudExpanded = true },
                    )
                }
            } else {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(14.dp))
                        .background(Color(0xCC141821))
                        .border(0.5.dp, Color.White.copy(alpha = 0.14f), RoundedCornerShape(14.dp))
                        .horizontalScroll(rememberScrollState())
                        .padding(horizontal = 8.dp, vertical = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    HudChip(text = "← 退出", active = false, onClick = onClose)

                    Text(
                        text = buildString {
                            append(displayName)
                            if (showStats && statsText.isNotEmpty()) append(" · $statsText")
                            else rttMs?.let { append(" · ${it}ms") }
                        },
                        color = Color.White.copy(alpha = 0.9f),
                        fontSize = 12.sp,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier.padding(horizontal = 4.dp),
                    )

                    // 双模式切换：触控板 / 直触
                    HudChip(
                        text = "触控板",
                        active = inputMode == RdInputMode.TOUCHPAD,
                        onClick = {
                            inputMode = RdInputMode.TOUCHPAD
                            scale = 1f
                            panX = 0f
                            panY = 0f
                        },
                    )
                    HudChip(
                        text = "直触",
                        active = inputMode == RdInputMode.DIRECT,
                        onClick = {
                            inputMode = RdInputMode.DIRECT
                            dragLocked = false
                        },
                    )

                    if (scale > 1.02f) {
                        HudChip(
                            text = "1× 复位",
                            active = false,
                            onClick = {
                                scale = 1f
                                panX = 0f
                                panY = 0f
                            },
                        )
                    }

                    // 多显示器切换
                    if (displays.size > 1) {
                        displays.forEachIndexed { idx, disp ->
                            HudChip(
                                text = "屏${idx + 1}",
                                active = disp.id == activeDisplayId,
                                onClick = {
                                    activeDisplayId = disp.id
                                    sendToEngine("c", "{\"t\":\"disp\",\"displayId\":${disp.id}}")
                                },
                            )
                        }
                    }

                    // 画质循环切换
                    HudChip(
                        text = when (quality) {
                            "smooth" -> "流畅"
                            "ultra" -> "原画"
                            else -> "高清"
                        },
                        active = false,
                        onClick = {
                            val next = when (quality) {
                                "smooth" -> "hd"
                                "hd" -> "ultra"
                                else -> "smooth"
                            }
                            quality = next
                            sendToEngine("c", "{\"t\":\"qual\",\"quality\":\"$next\"}")
                        },
                    )

                    // 横竖屏切换
                    HudChip(
                        text = if (forceLandscape) "解锁旋转" else "横屏",
                        active = forceLandscape,
                        onClick = { forceLandscape = !forceLandscape },
                    )

                    // 剪贴板同步
                    HudChip(
                        text = "拉取剪贴板",
                        active = false,
                        onClick = { sendToEngine("c", "{\"t\":\"cb.get\"}") },
                    )
                    HudChip(
                        text = "发送剪贴板",
                        active = false,
                        onClick = { syncLocalClipboardToRemote(manual = true, thenPaste = false) },
                    )
                    HudChip(
                        text = if (clipboardSync) "自动剪贴板 开" else "自动剪贴板 关",
                        active = clipboardSync,
                        onClick = {
                            val next = !clipboardSync
                            clipboardSync = next
                            prefs.edit().putBoolean("clipboardSync", next).apply()
                            sendCfg()
                            toast(if (next) "已开启双向自动同步剪贴板（文字与图片）" else "已关闭自动同步剪贴板")
                        },
                    )
                    HudChip(
                        text = "上传文件",
                        active = false,
                        onClick = { runCatching { pickFiles.launch(arrayOf("*/*")) } },
                    )
                    HudChip(text = "统计", active = showStats, onClick = { showStats = !showStats })

                    HudChip(text = "收起 ▴", active = false, onClick = { hudExpanded = false })
                }
            }

            if (!permissions.screenRecording || !permissions.accessibility) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(10.dp))
                        .background(Color(0xD97F1D1D))
                        .padding(horizontal = 10.dp, vertical = 6.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = if (!permissions.screenRecording) {
                            "远端 Mac 未开启「屏幕录制」权限，请在目标设备系统设置中授权"
                        } else {
                            "远端 Mac 未开启「辅助功能」权限（当前仅可观看，无法键鼠控制）"
                        },
                        color = Color.White,
                        fontSize = 11.5.sp,
                        modifier = Modifier.weight(1f),
                    )
                    Spacer(modifier = Modifier.size(8.dp))
                    HudChip(
                        text = "重检",
                        active = true,
                        onClick = { sendToEngine("c", "{\"t\":\"perm\"}") },
                    )
                }
            }
        }

        // 底部修饰键、快捷键与输入法栏
        if (hudExpanded || imeBarOpen) {
            Column(
                modifier = Modifier
                    .align(Alignment.BottomCenter)
                    .fillMaxWidth()
                    .navigationBarsPadding()
                    .imePadding()
                    .padding(horizontal = 10.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                if (imeBarOpen) {
                    LaunchedEffect(Unit) {
                        runCatching { imeFocusRequester.requestFocus() }
                    }
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .background(Color(0xEB141821))
                            .border(0.5.dp, Color.White.copy(alpha = 0.18f), RoundedCornerShape(12.dp))
                            .padding(horizontal = 10.dp, vertical = 6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        BasicTextField(
                            value = imeDraft,
                            onValueChange = { imeDraft = it },
                            singleLine = true,
                            textStyle = TextStyle(color = Color.White, fontSize = 14.sp),
                            cursorBrush = SolidColor(Color(0xFF60A5FA)),
                            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                            keyboardActions = KeyboardActions(
                                onSend = {
                                    if (imeDraft.isNotEmpty()) {
                                        sendTextCommit(imeDraft)
                                        imeDraft = ""
                                    } else {
                                        sendKeyTap("Enter")
                                    }
                                },
                            ),
                            decorationBox = { inner ->
                                Box(modifier = Modifier.fillMaxWidth()) {
                                    if (imeDraft.isEmpty()) {
                                        Text(
                                            text = "输入中英文或配合 ⌘/⌃ 发送快捷键…",
                                            color = Color.White.copy(alpha = 0.42f),
                                            fontSize = 13.sp,
                                        )
                                    }
                                    inner()
                                }
                            },
                            modifier = Modifier
                                .weight(1f)
                                .focusRequester(imeFocusRequester),
                        )
                        HudChip(
                            text = "发送",
                            active = true,
                            onClick = {
                                if (imeDraft.isNotEmpty()) {
                                    sendTextCommit(imeDraft)
                                    imeDraft = ""
                                } else {
                                    sendKeyTap("Enter")
                                }
                            },
                        )
                        HudChip(
                            text = "关闭",
                            active = false,
                            onClick = { imeBarOpen = false },
                        )
                    }
                }

                if (remoteFiles.isNotEmpty() || transferItems.isNotEmpty()) {
                    RdTransfersPanel(
                        remoteFiles = remoteFiles,
                        items = transferItems,
                        onDownload = { transfers.download(it) },
                        onDownloadAll = { remoteFiles.forEach { transfers.download(it) } },
                        onDismissRemote = { remoteFiles = emptyList() },
                        onCancel = { transfers.cancel(it) },
                        onClear = { transfers.clearFinished() },
                    )
                }

                if (combosOpen) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(14.dp))
                            .background(Color(0xCC141821))
                            .border(0.5.dp, Color.White.copy(alpha = 0.14f), RoundedCornerShape(14.dp))
                            .horizontalScroll(rememberScrollState())
                            .padding(horizontal = 8.dp, vertical = 6.dp),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RD_KEY_COMBOS.forEach { combo ->
                            HudChip(text = combo.label, active = false, onClick = { sendCombo(combo.codes) })
                        }
                        listOf("F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
                            "Home", "End", "PageUp", "PageDown", "Delete").forEach { code ->
                            HudChip(text = if (code == "Delete") "⌦" else code, active = false, onClick = { sendKeyTap(code) })
                        }
                    }
                }

                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(14.dp))
                        .background(Color(0xCC141821))
                        .border(0.5.dp, Color.White.copy(alpha = 0.14f), RoundedCornerShape(14.dp))
                        .horizontalScroll(rememberScrollState())
                        .padding(horizontal = 8.dp, vertical = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Box(
                        modifier = Modifier
                            .height(28.dp)
                            .clip(CircleShape)
                            .background(if (imeBarOpen) Color(0xFF2563EB) else Color.White.copy(alpha = 0.12f))
                            .clickable { imeBarOpen = !imeBarOpen }
                            .padding(horizontal = 10.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(4.dp),
                        ) {
                            Icon(
                                imageVector = IosIcons.Keyboard,
                                contentDescription = "键盘",
                                tint = Color.White,
                                modifier = Modifier.size(14.dp),
                            )
                            Text("键盘", color = Color.White, fontSize = 12.sp, fontWeight = FontWeight.Medium)
                        }
                    }

                    if (inputMode == RdInputMode.TOUCHPAD) {
                        HudChip(
                            text = "拖拽锁",
                            active = dragLocked,
                            onClick = {
                                val next = !dragLocked
                                dragLocked = next
                                if (!next && pointerDownVisual) {
                                    pointerDownVisual = false
                                    sendMouseButton(false, cursor, 0, 1)
                                }
                            },
                        )
                    }

                    HudChip(
                        text = "右键",
                        active = false,
                        onClick = {
                            haptic.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                            sendMouseButton(true, cursor, 2, 1)
                            sendMouseButton(false, cursor, 2, 1)
                        },
                    )

                    HudChip(
                        text = "粘贴",
                        active = false,
                        onClick = { syncLocalClipboardToRemote(manual = false, thenPaste = true) },
                    )
                    HudChip(text = "快捷键", active = combosOpen, onClick = { combosOpen = !combosOpen })

                    HudChip(text = "⌘ Cmd", active = modMeta, onClick = { modMeta = !modMeta })
                    HudChip(text = "⌃ Ctrl", active = modCtrl, onClick = { modCtrl = !modCtrl })
                    HudChip(text = "⌥ Opt", active = modAlt, onClick = { modAlt = !modAlt })
                    HudChip(text = "⇧ Shift", active = modShift, onClick = { modShift = !modShift })

                    HudChip(text = "Esc", active = false, onClick = { sendKeyTap("Escape") })
                    HudChip(text = "Tab", active = false, onClick = { sendKeyTap("Tab") })
                    HudChip(text = "⌫", active = false, onClick = { sendKeyTap("Backspace") })
                    HudChip(text = "⏎", active = false, onClick = { sendKeyTap("Enter") })
                    HudChip(text = "Space", active = false, onClick = { sendKeyTap("Space") })
                    HudChip(text = "←", active = false, onClick = { sendKeyTap("ArrowLeft") })
                    HudChip(text = "↓", active = false, onClick = { sendKeyTap("ArrowDown") })
                    HudChip(text = "↑", active = false, onClick = { sendKeyTap("ArrowUp") })
                    HudChip(text = "→", active = false, onClick = { sendKeyTap("ArrowRight") })
                }
            }
        }
    }
}

@Composable
private fun RdTransfersPanel(
    remoteFiles: List<RdRemoteFile>,
    items: List<RdTransferItem>,
    onDownload: (RdRemoteFile) -> Unit,
    onDownloadAll: () -> Unit,
    onDismissRemote: () -> Unit,
    onCancel: (String) -> Unit,
    onClear: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(12.dp))
            .background(Color(0xE6141821))
            .border(0.5.dp, Color.White.copy(alpha = 0.14f), RoundedCornerShape(12.dp))
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (remoteFiles.isNotEmpty()) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    text = "远端复制了 ${remoteFiles.size} 个文件",
                    color = Color.White,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                if (remoteFiles.size > 1) HudChip(text = "全部下载", active = true, onClick = onDownloadAll)
                HudChip(text = "忽略", active = false, onClick = onDismissRemote)
            }
            remoteFiles.take(4).forEach { file ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        text = "${file.name} · ${formatTransferBytes(file.size)}",
                        color = Color.White.copy(alpha = 0.86f),
                        fontSize = 12.sp,
                        maxLines = 1,
                        modifier = Modifier.weight(1f),
                    )
                    HudChip(text = "下载", active = false, onClick = { onDownload(file) })
                }
            }
        }
        if (items.isNotEmpty()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "文件传输",
                    color = Color.White,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    modifier = Modifier.weight(1f),
                )
                HudChip(text = "清除已完成", active = false, onClick = onClear)
            }
            items.takeLast(4).forEach { item ->
                val arrow = if (item.upload) "↑" else "↓"
                val progress = when (item.status) {
                    "queued" -> "排队中"
                    "active" -> if (item.size > 0) {
                        "${formatTransferBytes(item.transferred)} / ${formatTransferBytes(item.size)}"
                    } else {
                        formatTransferBytes(item.transferred)
                    }
                    "done" -> if (item.upload) "已保存到远端下载文件夹" else "已保存到${item.message ?: "下载"}"
                    "cancelled" -> "已取消"
                    else -> "失败：${item.message ?: "未知错误"}"
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        text = "$arrow ${item.name} · $progress",
                        color = if (item.status == "error") Color(0xFFFCA5A5) else Color.White.copy(alpha = 0.86f),
                        fontSize = 12.sp,
                        maxLines = 1,
                        modifier = Modifier.weight(1f),
                    )
                    if (item.status == "queued" || item.status == "active") {
                        HudChip(text = "取消", active = false, onClick = { onCancel(item.id) })
                    }
                }
            }
        }
    }
}

@Composable
private fun HudChip(
    text: String,
    active: Boolean,
    onClick: () -> Unit,
) {
    Box(
        modifier = Modifier
            .height(28.dp)
            .clip(CircleShape)
            .background(if (active) Color(0xFF2563EB) else Color.White.copy(alpha = 0.12f))
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text,
            color = Color.White,
            fontSize = 12.sp,
            fontWeight = if (active) FontWeight.SemiBold else FontWeight.Medium,
            maxLines = 1,
        )
    }
}

private const val RD_WEBVIEW_HTML = """
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no" />
<style>
  html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: #090b10;
    user-select: none;
    -webkit-user-select: none;
  }
  video {
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #090b10;
    pointer-events: none;
  }
</style>
</head>
<body>
<video id="v" autoplay playsinline muted></video>
<script>
(function() {
  var video = document.getElementById('v');
  var pc = null;
  var fastDc = null;
  var ctrlDc = null;
  var fileDc = null;
  var msgPort = null;
  var upId = null;
  var dlWant = null;
  var dlId = null;
  var dlParts = [];
  var dlBytes = 0;
  var statsTimer = null;
  var lastStats = null;

  function b64FromBytes(u8) {
    var s = '';
    for (var i = 0; i < u8.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(u8.length, i + 0x8000)));
    }
    return btoa(s);
  }

  function bytesFromB64(b64) {
    var bin = atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function flushDownload() {
    if (!dlId || dlBytes === 0) return;
    var all = new Uint8Array(dlBytes);
    var off = 0;
    for (var i = 0; i < dlParts.length; i++) {
      all.set(dlParts[i], off);
      off += dlParts[i].length;
    }
    dlParts = [];
    dlBytes = 0;
    window.RdNative.postFileChunk(dlId, b64FromBytes(all));
  }

  // 上传：按需向原生拉取 256KB 数据，切成 16KB 发出；缓冲超过 4MB 时等待排空。
  function pumpUpload() {
    while (upId && fileDc && fileDc.readyState === 'open' && fileDc.bufferedAmount < 4194304) {
      var id = upId;
      var b64 = window.RdNative.upRead(id);
      if (upId !== id) return;
      if (b64 === '') {
        upId = null;
        try { fileDc.send(JSON.stringify({ t: 'end', id: id })); } catch (e) {}
        return;
      }
      if (b64.charAt(0) === '!') {
        upId = null;
        try { fileDc.send(JSON.stringify({ t: 'cancel', id: id })); } catch (e) {}
        window.RdNative.postFile(JSON.stringify({ t: 'error', id: id, message: b64.slice(1) }));
        return;
      }
      var bytes = bytesFromB64(b64);
      for (var p = 0; p < bytes.length; p += 16384) {
        fileDc.send(bytes.subarray(p, Math.min(bytes.length, p + 16384)));
      }
    }
  }

  function fileReady(id) {
    if (fileDc && fileDc.readyState === 'open') return true;
    if (window.RdNative) window.RdNative.postFile(JSON.stringify({ t: 'error', id: id, message: '文件通道未就绪' }));
    return false;
  }

  window.__rdFilePut = function(id, name, size, dest) {
    if (!fileReady(id)) return;
    var msg = { t: 'put', id: id, name: name, size: size };
    if (dest) msg.dest = dest;
    fileDc.send(JSON.stringify(msg));
    upId = id;
    setTimeout(pumpUpload, 0);
  };

  window.__rdFileGet = function(id, path) {
    if (!fileReady(id)) return;
    dlWant = id;
    dlId = null;
    dlParts = [];
    dlBytes = 0;
    fileDc.send(JSON.stringify({ t: 'get', id: id, path: path }));
  };

  window.__rdFileCancel = function(id) {
    if (upId === id) upId = null;
    if (dlWant === id || dlId === id) {
      dlWant = null;
      dlId = null;
      dlParts = [];
      dlBytes = 0;
    }
    if (fileDc && fileDc.readyState === 'open') {
      try { fileDc.send(JSON.stringify({ t: 'cancel', id: id })); } catch (e) {}
    }
  };

  function sampleStats() {
    if (!pc || !window.RdNative) return;
    pc.getStats().then(function(report) {
      var inbound = null;
      var pair = null;
      report.forEach(function(st) {
        if (st.type === 'inbound-rtp' && (st.kind === 'video' || st.mediaType === 'video')) inbound = st;
        if (st.type === 'candidate-pair' && st.state === 'succeeded' && (st.nominated || st.selected)) pair = st;
      });
      if (!inbound) return;
      var cur = {
        t: performance.now(),
        bytes: inbound.bytesReceived || 0,
        frames: inbound.framesDecoded || 0,
        lost: inbound.packetsLost || 0,
        recv: inbound.packetsReceived || 0
      };
      var prev = lastStats;
      lastStats = cur;
      if (!prev) return;
      var dt = (cur.t - prev.t) / 1000;
      if (dt <= 0) return;
      var dl = Math.max(0, cur.lost - prev.lost);
      var dr = Math.max(0, cur.recv - prev.recv);
      var rtt = pair && typeof pair.currentRoundTripTime === 'number' ? Math.round(pair.currentRoundTripTime * 1000) : -1;
      window.RdNative.postStats(
        Math.max(0, Math.round((cur.frames - prev.frames) / dt)),
        Math.max(0, Math.round((cur.bytes - prev.bytes) * 8 / dt / 1000)),
        dl + dr > 0 ? dl * 100 / (dl + dr) : 0,
        rtt
      );
    }).catch(function() {});
  }

  function applyZeroDelay(receiver) {
    if (!receiver) return;
    try { receiver.playoutDelayHint = 0; } catch (e) {}
    try { receiver.jitterBufferTarget = 0; } catch (e) {}
  }

  function preferH264(transceiver) {
    if (!transceiver || typeof transceiver.setCodecPreferences !== 'function') return;
    if (typeof RTCRtpReceiver === 'undefined' || typeof RTCRtpReceiver.getCapabilities !== 'function') return;
    var caps = RTCRtpReceiver.getCapabilities('video');
    if (!caps || !caps.codecs) return;
    var h264 = [];
    var rest = [];
    for (var i = 0; i < caps.codecs.length; i++) {
      var c = caps.codecs[i];
      if ((c.mimeType || '').toLowerCase() === 'video/h264') h264.push(c);
      else rest.push(c);
    }
    if (h264.length > 0) {
      try { transceiver.setCodecPreferences(h264.concat(rest)); } catch (e) {}
    }
  }

  window.__rdFast = function(raw) {
    if (fastDc && fastDc.readyState === 'open' && fastDc.bufferedAmount < 65536) {
      try { fastDc.send(raw); } catch (e) {}
    }
  };

  window.__rdCtrl = function(raw) {
    if (ctrlDc && ctrlDc.readyState === 'open') {
      try { ctrlDc.send(raw); } catch (e) {}
    }
  };

  window.addEventListener('message', function(ev) {
    if (ev.data === 'init_port' && ev.ports && ev.ports[0]) {
      msgPort = ev.ports[0];
      msgPort.onmessage = function(pe) {
        var s = pe.data || '';
        if (s.charAt(1) === '|') {
          var ch = s.charAt(0);
          var body = s.slice(2);
          if (ch === 'f') window.__rdFast(body);
          else window.__rdCtrl(body);
        }
      };
    }
  });

  video.addEventListener('loadedmetadata', function() {
    if (video.videoWidth > 0 && video.videoHeight > 0 && window.RdNative) {
      window.RdNative.postVideoSize(video.videoWidth, video.videoHeight);
    }
  });
  video.addEventListener('loadeddata', function() {
    if (video.videoWidth > 0 && video.videoHeight > 0 && window.RdNative) {
      window.RdNative.postVideoSize(video.videoWidth, video.videoHeight);
      window.RdNative.postTrackReady();
    }
  });
  video.addEventListener('playing', function() {
    if (video.videoWidth > 0 && video.videoHeight > 0 && window.RdNative) {
      window.RdNative.postVideoSize(video.videoWidth, video.videoHeight);
      window.RdNative.postTrackReady();
    }
  });
  video.addEventListener('resize', function() {
    if (video.videoWidth > 0 && video.videoHeight > 0 && window.RdNative) {
      window.RdNative.postVideoSize(video.videoWidth, video.videoHeight);
    }
  });

  window.__rdClose = function() {
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = null;
    lastStats = null;
    upId = null;
    dlWant = null;
    dlId = null;
    dlParts = [];
    dlBytes = 0;
    try { if (fastDc) fastDc.close(); } catch (e) {}
    try { if (ctrlDc) ctrlDc.close(); } catch (e) {}
    try { if (fileDc) fileDc.close(); } catch (e) {}
    try { if (pc) pc.close(); } catch (e) {}
    fastDc = null;
    ctrlDc = null;
    fileDc = null;
    pc = null;
    video.srcObject = null;
  };

  window.__rdStart = function(iceServersJson) {
    window.__rdClose();
    if (typeof RTCPeerConnection === 'undefined') {
      if (window.RdNative) window.RdNative.postError('当前系统 WebView 不支持 WebRTC');
      return;
    }
    var iceServers = [];
    try { iceServers = JSON.parse(iceServersJson); } catch (e) {}
    pc = new RTCPeerConnection({ iceServers: iceServers, bundlePolicy: 'max-bundle' });

    var tr = pc.addTransceiver('video', { direction: 'recvonly' });
    preferH264(tr);
    applyZeroDelay(tr.receiver);

    fastDc = pc.createDataChannel('input-fast', { ordered: false, maxRetransmits: 0 });
    ctrlDc = pc.createDataChannel('control', { ordered: true });
    ctrlDc.onopen = function() {
      if (window.RdNative) {
        window.RdNative.postControlOpen();
        window.RdNative.postTrackReady();
      }
    };

    var dc = pc.createDataChannel('file', { ordered: true });
    fileDc = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 1048576;
    dc.onbufferedamountlow = pumpUpload;
    dc.onopen = function() {
      if (window.RdNative && fileDc === dc) window.RdNative.postFileOpen();
    };
    dc.onclose = function() {
      if (fileDc !== dc) return;
      upId = null;
      dlWant = null;
      dlId = null;
      if (window.RdNative) window.RdNative.postFileClosed();
    };
    dc.onmessage = function(ev) {
      if (fileDc !== dc || !window.RdNative) return;
      if (typeof ev.data === 'string') {
        var f = null;
        try { f = JSON.parse(ev.data); } catch (e) { return; }
        if (!f || typeof f.id !== 'string') return;
        if (f.t === 'meta' && f.id === dlWant) {
          dlId = f.id;
          dlParts = [];
          dlBytes = 0;
        } else if ((f.t === 'done' || f.t === 'error') && f.id === dlId) {
          flushDownload();
          dlId = null;
          dlWant = null;
        } else if (f.t === 'error' && f.id === dlWant) {
          dlWant = null;
        } else if (f.t === 'error' && f.id === upId) {
          upId = null;
        }
        window.RdNative.postFile(ev.data);
        return;
      }
      if (!dlId || !(ev.data instanceof ArrayBuffer)) return;
      var u8 = new Uint8Array(ev.data);
      dlParts.push(u8);
      dlBytes += u8.length;
      if (dlBytes >= 262144) flushDownload();
    };

    statsTimer = setInterval(sampleStats, 1000);
    ctrlDc.onmessage = function(ev) {
      if (typeof ev.data === 'string' && window.RdNative) {
        window.RdNative.postControl(ev.data);
      }
    };

    pc.ontrack = function(ev) {
      applyZeroDelay(ev.receiver);
      var stream = (ev.streams && ev.streams[0]) ? ev.streams[0] : new MediaStream([ev.track]);
      if (video.srcObject !== stream) {
        video.srcObject = stream;
      }
      var p = video.play();
      if (p && typeof p.catch === 'function') p.catch(function() {});
    };

    pc.onicecandidate = function(ev) {
      if (!window.RdNative) return;
      if (!ev.candidate || !ev.candidate.candidate) {
        window.RdNative.postIce('', '', -1, '');
        return;
      }
      window.RdNative.postIce(
        ev.candidate.candidate,
        ev.candidate.sdpMid || '',
        typeof ev.candidate.sdpMLineIndex === 'number' ? ev.candidate.sdpMLineIndex : -1,
        ev.candidate.usernameFragment || ''
      );
    };

    pc.oniceconnectionstatechange = function() {
      if (pc && window.RdNative) {
        var st = pc.iceConnectionState || '';
        if (st === 'connected' || st === 'completed' || st === 'failed') {
          window.RdNative.postState(st);
        }
      }
    };

    pc.onconnectionstatechange = function() {
      if (pc && window.RdNative) {
        window.RdNative.postState(pc.connectionState || '');
      }
    };

    pc.createOffer()
      .then(function(offer) {
        return pc.setLocalDescription(offer).then(function() { return offer; });
      })
      .then(function(offer) {
        if (window.RdNative) window.RdNative.postOffer(pc.localDescription ? pc.localDescription.sdp : offer.sdp);
      })
      .catch(function(err) {
        if (window.RdNative) window.RdNative.postError(String(err && err.message ? err.message : err));
      });
  };

  window.__rdApplyAnswer = function(answerSdp) {
    if (!pc) return;
    pc.setRemoteDescription({ type: 'answer', sdp: answerSdp }).catch(function(err) {
      if (window.RdNative) window.RdNative.postError(String(err && err.message ? err.message : err));
    });
  };

  window.__rdAddIce = function(candidatesJson) {
    if (!pc) return;
    var list = [];
    try { list = JSON.parse(candidatesJson); } catch (e) {}
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c || !c.candidate) continue;
      pc.addIceCandidate({
        candidate: c.candidate,
        sdpMid: c.sdpMid || null,
        sdpMLineIndex: typeof c.sdpMLineIndex === 'number' ? c.sdpMLineIndex : null,
        usernameFragment: c.usernameFragment || null
      }).catch(function() {});
    }
  };
})();
</script>
</body>
</html>
"""
