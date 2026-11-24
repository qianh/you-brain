package ai.youbrain.mobile.ui

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.pm.ActivityInfo
import android.graphics.Color as AndroidColor
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebMessage
import android.webkit.WebMessagePort
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.compose.BackHandler
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
import androidx.compose.ui.graphics.Path
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
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.util.Locale
import java.util.UUID
import kotlin.math.hypot

private sealed interface MobileRdStatus {
    data class Connecting(val stageText: String = "正在获取穿透配置…") : MobileRdStatus
    data object Ready : MobileRdStatus
    data object Closed : MobileRdStatus
    data class Failed(val reason: String) : MobileRdStatus
}

private class RdWebBridge(
    private val mainHandler: Handler,
    private val onOffer: (String) -> Unit,
    private val onLocalIce: (RdIceCandidate) -> Unit,
    private val onTrackReady: () -> Unit,
    private val onVideoSize: (Int, Int) -> Unit,
    private val onControlMessage: (String) -> Unit,
    private val onConnState: (String) -> Unit,
    private val onError: (String) -> Unit,
) {
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
        }
        sendToEngine("c", downObj.toString())
        sendToEngine("c", upObj.toString())
        clearStickyModifiers()
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

        status = MobileRdStatus.Connecting("正在获取穿透配置…")
        rttMs = null
        activeSessionId = ""

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
            iceTimeoutJob?.cancel()
            iceTimeoutJob = null
            status = MobileRdStatus.Ready
        }

        fun failWith(reason: String) {
            if (disposed || settled) return
            settled = true
            iceTimeoutJob?.cancel()
            iceTimeoutJob = null
            status = MobileRdStatus.Failed(reason)
            evalJs("window.__rdClose && window.__rdClose();")
            if (rdOpenReady) {
                rdOpenReady = false
                repository.closeRemoteDesktopAsync(device.id, sessionId)
            }
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
                        val text = obj["text"]?.jsonPrimitive?.contentOrNull.orEmpty()
                        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                        cm?.setPrimaryClip(ClipData.newPlainText("U-Brain Remote Desktop", text))
                        Toast.makeText(context, "已同步远端剪贴板", Toast.LENGTH_SHORT).show()
                    }
                }
            },
            onConnState = { st ->
                if (disposed) return@RdWebBridge
                when (st) {
                    "connected", "completed" -> markReady()
                    "failed" -> failWith(iceFailedReason())
                    "closed" -> if (everReady) {
                        settled = true
                        iceTimeoutJob?.cancel()
                        iceTimeoutJob = null
                        status = MobileRdStatus.Closed
                    }
                }
            },
            onError = { reason ->
                failWith(reason)
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

            // 触控板模式下绘制高对比度 macOS 风格虚拟光标
            if (status == MobileRdStatus.Ready && inputMode == RdInputMode.TOUCHPAD) {
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
                    drawPath(arrow, color = Color(0xEE111827))
                    drawPath(arrow, color = Color.White, style = Stroke(width = 1.4f * s))
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
                                    onClick = { reconnectNonce += 1 },
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
                                    onClick = { reconnectNonce += 1 },
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
                            rttMs?.let { append(" · ${it}ms") }
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
                        onClick = {
                            val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                            val clipText = cm?.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString().orEmpty()
                            if (clipText.isEmpty()) {
                                Toast.makeText(context, "本机剪贴板为空", Toast.LENGTH_SHORT).show()
                            } else {
                                val payload = buildJsonObject {
                                    put("t", "cb.set")
                                    put("text", clipText)
                                }
                                sendToEngine("c", payload.toString())
                                Toast.makeText(context, "已发送到远端剪贴板", Toast.LENGTH_SHORT).show()
                            }
                        },
                    )

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
  var msgPort = null;

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
    try { if (fastDc) fastDc.close(); } catch (e) {}
    try { if (ctrlDc) ctrlDc.close(); } catch (e) {}
    try { if (pc) pc.close(); } catch (e) {}
    fastDc = null;
    ctrlDc = null;
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
      if (window.RdNative) window.RdNative.postTrackReady();
    };
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
