package ai.youbrain.mobile.ui

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Bitmap
import android.net.Uri
import android.view.View
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import ai.youbrain.mobile.data.ConnectionState
import ai.youbrain.mobile.data.RelayDevice
import ai.youbrain.mobile.net.AppUiState
import ai.youbrain.mobile.net.T3AssetCache
import ai.youbrain.mobile.net.UBrainRepository
import ai.youbrain.mobile.ui.components.IosHairline
import ai.youbrain.mobile.ui.components.IosIconBadge
import ai.youbrain.mobile.ui.components.IosIcons
import ai.youbrain.mobile.ui.theme.IosTheme
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import java.io.ByteArrayInputStream
import java.net.URI

private const val MAX_WEBVIEW_POOL = 4

private val NO_CACHE_HEADERS = mapOf(
    "Cache-Control" to "no-cache, no-store, must-revalidate",
    "Pragma" to "no-cache",
)

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun T3DeckScreen(
    state: AppUiState,
    repository: UBrainRepository,
    isVisibleTab: Boolean,
    preferredDeviceId: String?,
    preferredThreadUrl: String?,
    onFileChooser: (ValueCallback<Array<Uri>>, Intent) -> Unit,
    onJumpSettings: () -> Unit,
) {
    val context = LocalContext.current
    val c = IosTheme.colors
    val scope = rememberCoroutineScope()
    val devices = remember(state.relayState.devices, state.deviceId) {
        repository.viewT3Devices()
    }

    var selectedId by remember { mutableStateOf<String?>(null) }
    var renameDevice by remember { mutableStateOf<RelayDevice?>(null) }
    val proxyUrls = remember { mutableStateMapOf<String, String>() }
    val loadingIds = remember { mutableStateMapOf<String, Boolean>() }
    val refreshingIds = remember { mutableStateMapOf<String, Boolean>() }
    val progressByDevice = remember { mutableStateMapOf<String, Int>() }
    val errorByDevice = remember { mutableStateMapOf<String, String?>() }

    val webViews = remember { LinkedHashMap<String, WebView>(8, 0.75f, true) }
    val refreshJobs = remember { HashMap<String, Job>() }
    var containerRef by remember { mutableStateOf<FrameLayout?>(null) }

    fun reloadWebViewBypassCache(devId: String, freshBaseUrl: String) {
        val wv = webViews[devId] ?: return
        wv.stopLoading()
        val curUrl = wv.url
        val targetUrl = if (
            curUrl.isNullOrBlank() ||
            curUrl == "about:blank" ||
            !curUrl.startsWith(freshBaseUrl.trimEnd('/'))
        ) {
            freshBaseUrl
        } else {
            curUrl
        }
        wv.loadUrl(targetUrl, NO_CACHE_HEADERS)
    }

    fun triggerHardRefresh(devId: String) {
        refreshJobs[devId]?.cancel()
        refreshJobs[devId] = scope.launch {
            refreshingIds[devId] = true
            errorByDevice[devId] = null
            progressByDevice[devId] = 15
            try {
                val res = repository.forceRefreshDeviceT3(devId)
                res.fold(
                    onSuccess = { freshBaseUrl ->
                        proxyUrls[devId] = freshBaseUrl
                        errorByDevice[devId] = null
                        reloadWebViewBypassCache(devId, freshBaseUrl)
                    },
                    onFailure = { t ->
                        errorByDevice[devId] = t.message ?: "无法建立 T3 隧道"
                        progressByDevice[devId] = 100
                    },
                )
            } finally {
                refreshingIds[devId] = false
                loadingIds[devId] = false
            }
        }
    }

    LaunchedEffect(preferredDeviceId, state.agent.masterDeviceId, devices) {
        if (!preferredDeviceId.isNullOrBlank() && devices.any { it.id == preferredDeviceId }) {
            selectedId = preferredDeviceId
        } else if (selectedId == null || devices.none { it.id == selectedId }) {
            val masterOnline = state.agent.masterDeviceId?.takeIf { id ->
                devices.any { it.id == id && it.online }
            }
            selectedId = masterOnline ?: devices.firstOrNull { it.online }?.id ?: devices.firstOrNull()?.id
        }
    }

    val activeId = selectedId
    val activeDevice = devices.firstOrNull { it.id == activeId }

    LaunchedEffect(activeId, activeDevice?.online, state.connectionState) {
        val devId = activeId ?: return@LaunchedEffect
        if (refreshingIds[devId] == true) return@LaunchedEffect

        if (state.connectionState == ConnectionState.CONNECTING) {
            if (webViews[devId] == null) {
                loadingIds[devId] = true
            }
            return@LaunchedEffect
        }
        if (state.connectionState != ConnectionState.OK) {
            if (webViews[devId] == null) {
                errorByDevice[devId] = state.connectionError ?: "尚未连上中转服务器"
                loadingIds[devId] = false
            }
            return@LaunchedEffect
        }
        if (activeDevice?.online != true) {
            errorByDevice[devId] = "该设备当前离线"
            loadingIds[devId] = false
            return@LaunchedEffect
        }

        val wasInError = errorByDevice[devId] != null
        val freshBaseUrl = repository.getOrCreateT3ProxyImmediate(devId)
        proxyUrls[devId] = freshBaseUrl
        loadingIds[devId] = false
        errorByDevice[devId] = null

        val res = repository.ensureT3Tunnel(devId)
        res.fold(
            onSuccess = {
                errorByDevice[devId] = null
                if (wasInError) {
                    reloadWebViewBypassCache(devId, freshBaseUrl)
                }
            },
            onFailure = { t ->
                errorByDevice[devId] = t.message ?: "无法建立 T3 隧道"
            },
        )
    }

    LaunchedEffect(activeId, preferredThreadUrl, proxyUrls[activeId]) {
        val devId = activeId ?: return@LaunchedEffect
        val base = proxyUrls[devId] ?: return@LaunchedEffect
        val deep = preferredThreadUrl?.takeIf { it.isNotBlank() } ?: return@LaunchedEffect
        val rel = runCatching {
            val u = URI(deep)
            (u.rawPath.ifEmpty { "/" }) + (u.rawQuery?.let { "?$it" } ?: "")
        }.getOrNull() ?: return@LaunchedEffect
        errorByDevice[devId] = null
        val target = base.trimEnd('/') + rel
        webViews[devId]?.loadUrl(target)
    }

    DisposableEffect(Unit) {
        onDispose {
            for (job in refreshJobs.values) {
                job.cancel()
            }
            refreshJobs.clear()
            for (wv in webViews.values) {
                runCatching { wv.destroy() }
            }
            webViews.clear()
        }
    }

    BackHandler(enabled = isVisibleTab && activeId != null && webViews[activeId]?.canGoBack() == true) {
        activeId?.let { webViews[it]?.goBack() }
    }

    val isActiveRefreshing = activeId != null && refreshingIds[activeId] == true
    val activeProgress = activeId?.let { progressByDevice[it] } ?: 100

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(c.groupedBg),
    ) {
        // 纤薄 iOS 设备切换胶囊栏（右侧固定强制刷新按钮，绝不被长名称挤压）
        if (isVisibleTab) {
            Column(modifier = Modifier.fillMaxWidth().background(c.chromeBg)) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(42.dp)
                        .padding(horizontal = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    if (devices.isEmpty()) {
                        Text(
                            text = "暂无开放 T3 的设备",
                            fontSize = 13.sp,
                            color = c.secondaryLabel,
                            modifier = Modifier.weight(1f),
                        )
                    } else {
                        Row(
                            modifier = Modifier
                                .weight(1f)
                                .horizontalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            devices.forEach { dev ->
                                val isSelected = dev.id == activeId
                                val pillBg = if (isSelected) c.blue else c.tertiaryFill
                                val textColor = if (isSelected) Color.White else c.label
                                val dotColor = when {
                                    isSelected && dev.online -> Color(0xFF9DF7B2)
                                    isSelected -> Color.White.copy(alpha = 0.65f)
                                    dev.online -> c.green
                                    else -> c.secondaryLabel
                                }
                                Row(
                                    modifier = Modifier
                                        .height(28.dp)
                                        .widthIn(max = 172.dp)
                                        .clip(CircleShape)
                                        .background(pillBg)
                                        .clickable {
                                            if (isSelected) renameDevice = dev else selectedId = dev.id
                                        }
                                        .padding(horizontal = 10.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                                ) {
                                    Box(
                                        modifier = Modifier
                                            .size(6.dp)
                                            .clip(CircleShape)
                                            .background(dotColor),
                                    )
                                    Text(
                                        text = state.displayName(dev),
                                        fontSize = 12.5.sp,
                                        fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Medium,
                                        color = textColor,
                                        maxLines = 1,
                                        softWrap = false,
                                        overflow = TextOverflow.Ellipsis,
                                        modifier = Modifier.weight(1f, fill = false),
                                    )
                                    if (isSelected) {
                                        Icon(
                                            imageVector = IosIcons.Pencil,
                                            contentDescription = "改名",
                                            tint = Color.White.copy(alpha = 0.85f),
                                            modifier = Modifier.size(11.dp),
                                        )
                                    }
                                }
                            }
                        }

                        if (activeId != null) {
                            Box(
                                modifier = Modifier
                                    .size(28.dp)
                                    .clip(CircleShape)
                                    .background(c.tertiaryFill)
                                    .clickable(enabled = !isActiveRefreshing) {
                                        triggerHardRefresh(activeId)
                                    },
                                contentAlignment = Alignment.Center,
                            ) {
                                if (isActiveRefreshing) {
                                    CircularProgressIndicator(
                                        modifier = Modifier.size(14.dp),
                                        strokeWidth = 1.8.dp,
                                        color = c.blue,
                                    )
                                } else {
                                    Icon(
                                        imageVector = IosIcons.Refresh,
                                        contentDescription = "强制刷新",
                                        tint = c.blue,
                                        modifier = Modifier.size(15.dp),
                                    )
                                }
                            }
                        }
                    }
                }
                if (isActiveRefreshing || activeProgress in 1..99) {
                    if (isActiveRefreshing && activeProgress < 20) {
                        LinearProgressIndicator(
                            modifier = Modifier.fillMaxWidth().height(2.dp),
                            color = c.blue,
                            trackColor = Color.Transparent,
                        )
                    } else {
                        LinearProgressIndicator(
                            progress = { (activeProgress / 100f).coerceIn(0.08f, 1f) },
                            modifier = Modifier.fillMaxWidth().height(2.dp),
                            color = c.blue,
                            trackColor = Color.Transparent,
                        )
                    }
                } else {
                    IosHairline()
                }
            }
        }

        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { ctx ->
                    FrameLayout(ctx).also { containerRef = it }
                },
                update = { container ->
                    container.visibility = if (isVisibleTab) View.VISIBLE else View.GONE
                    val currentId = activeId
                    val readyUrl = currentId?.let { proxyUrls[it] }
                    if (currentId != null && readyUrl != null && !webViews.containsKey(currentId)) {
                        if (webViews.size >= MAX_WEBVIEW_POOL) {
                            val oldestKey = webViews.keys.firstOrNull()
                            if (oldestKey != null) {
                                val evicted = webViews.remove(oldestKey)
                                if (evicted != null) {
                                    container.removeView(evicted)
                                    evicted.destroy()
                                }
                            }
                        }
                        val boundDeviceId = currentId
                        val wv = WebView(container.context).apply {
                            setLayerType(View.LAYER_TYPE_HARDWARE, null)
                            settings.javaScriptEnabled = true
                            settings.domStorageEnabled = true
                            settings.databaseEnabled = true
                            settings.allowFileAccess = true
                            settings.useWideViewPort = true
                            settings.loadWithOverviewMode = true
                            settings.cacheMode = WebSettings.LOAD_DEFAULT
                            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                            val cm = CookieManager.getInstance()
                            cm.setAcceptCookie(true)
                            cm.setAcceptThirdPartyCookies(this, true)
                            webViewClient = object : WebViewClient() {
                                override fun shouldInterceptRequest(
                                    view: WebView,
                                    request: WebResourceRequest,
                                ): WebResourceResponse? {
                                    if (!request.method.equals("GET", ignoreCase = true)) return null
                                    val u = request.url
                                    if (u.host != "127.0.0.1" && u.host != "localhost") return null
                                    val path = u.encodedPath ?: return null
                                    if (path == "/__ubrain_t3_inject.js") {
                                        return WebResourceResponse(
                                            "text/javascript",
                                            "utf-8",
                                            200,
                                            "OK",
                                            mapOf("Cache-Control" to "no-store"),
                                            ByteArrayInputStream("/* u-brain mobile proxy */\n".toByteArray(Charsets.UTF_8)),
                                        )
                                    }
                                    if (T3AssetCache.isImmutableAssetPath(path)) {
                                        val hit = repository.assetCache.getCached(path) ?: return null
                                        return WebResourceResponse(
                                            hit.mime.mimeType,
                                            hit.mime.encoding,
                                            200,
                                            "OK",
                                            mapOf(
                                                "Cache-Control" to "public, max-age=31536000, immutable",
                                                "Access-Control-Allow-Origin" to "*",
                                            ),
                                            ByteArrayInputStream(hit.bytes),
                                        )
                                    }
                                    return null
                                }

                                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                                    val u = request.url
                                    if (u.host == "127.0.0.1" || u.host == "localhost") return false
                                    runCatching {
                                        context.startActivity(Intent(Intent.ACTION_VIEW, u))
                                    }
                                    return true
                                }

                                override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                                    progressByDevice[boundDeviceId] = 15
                                }

                                override fun onPageFinished(view: WebView?, url: String?) {
                                    progressByDevice[boundDeviceId] = 100
                                }

                                override fun onReceivedError(
                                    view: WebView?,
                                    request: WebResourceRequest?,
                                    error: WebResourceError?,
                                ) {
                                    if (request?.isForMainFrame == true && refreshingIds[boundDeviceId] != true) {
                                        progressByDevice[boundDeviceId] = 100
                                        errorByDevice[boundDeviceId] = "T3 页面连接超时或中断，请点击刷新重试"
                                    }
                                }

                                override fun onReceivedHttpError(
                                    view: WebView?,
                                    request: WebResourceRequest?,
                                    errorResponse: WebResourceResponse?,
                                ) {
                                    if (request?.isForMainFrame == true &&
                                        errorResponse?.statusCode == 502 &&
                                        refreshingIds[boundDeviceId] != true
                                    ) {
                                        progressByDevice[boundDeviceId] = 100
                                        errorByDevice[boundDeviceId] = "对端设备的 T3 暂时没有响应，请点击刷新重试"
                                    }
                                }
                            }
                            webChromeClient = object : WebChromeClient() {
                                override fun onProgressChanged(view: WebView?, newProgress: Int) {
                                    progressByDevice[boundDeviceId] = newProgress
                                }

                                override fun onShowFileChooser(
                                    webView: WebView?,
                                    filePathCallback: ValueCallback<Array<Uri>>,
                                    fileChooserParams: FileChooserParams,
                                ): Boolean {
                                    val intent = runCatching { fileChooserParams.createIntent() }
                                        .getOrElse { Intent(Intent.ACTION_GET_CONTENT).setType("*/*") }
                                    onFileChooser(filePathCallback, intent)
                                    return true
                                }
                            }
                            loadUrl(readyUrl)
                        }
                        webViews[currentId] = wv
                        container.addView(
                            wv,
                            FrameLayout.LayoutParams(
                                FrameLayout.LayoutParams.MATCH_PARENT,
                                FrameLayout.LayoutParams.MATCH_PARENT,
                            ),
                        )
                    }
                    for ((id, wv) in webViews) {
                        val isCurrent = id == currentId && readyUrl != null && errorByDevice[id] == null
                        if (isCurrent && isVisibleTab) {
                            wv.visibility = View.VISIBLE
                            wv.onResume()
                        } else if (isCurrent) {
                            wv.visibility = View.GONE
                        } else {
                            wv.visibility = View.GONE
                            wv.onPause()
                        }
                    }
                },
            )

            if (isVisibleTab) when {
                devices.isEmpty() -> {
                    Box(
                        modifier = Modifier.fillMaxSize().padding(24.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(16.dp))
                                .background(c.cardBg)
                                .padding(22.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            IosIconBadge(icon = IosIcons.TerminalWindow, background = c.indigo)
                            Text("暂无开放 T3 的设备", fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = c.label)
                            Text(
                                text = "请在电脑端 U-Brain「设置 → 接入 → 跨设备派活」开启「允许查看本机 T3」，并点击该手机的「信任此设备」。",
                                fontSize = 13.5.sp,
                                lineHeight = 19.sp,
                                color = c.secondaryLabel,
                                textAlign = TextAlign.Center,
                            )
                        }
                    }
                }
                activeId != null && (loadingIds[activeId] == true || (isActiveRefreshing && webViews[activeId] == null)) -> {
                    Column(
                        modifier = Modifier.fillMaxSize(),
                        verticalArrangement = Arrangement.Center,
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        CircularProgressIndicator(color = c.blue, modifier = Modifier.size(26.dp), strokeWidth = 2.5.dp)
                        Spacer(modifier = Modifier.height(10.dp))
                        Text("正在建立端到端加密 T3 隧道…", fontSize = 13.sp, color = c.secondaryLabel)
                    }
                }
                activeId != null && errorByDevice[activeId] != null -> {
                    val err = errorByDevice[activeId]!!
                    Box(
                        modifier = Modifier.fillMaxSize().padding(24.dp),
                        contentAlignment = Alignment.Center,
                    ) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(16.dp))
                                .background(c.cardBg)
                                .padding(20.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            IosIconBadge(icon = IosIcons.Shield, background = c.red)
                            Text(
                                text = err,
                                color = c.red,
                                fontSize = 15.sp,
                                fontWeight = FontWeight.Medium,
                                textAlign = TextAlign.Center,
                            )
                            if (err.contains("不接受") || err.contains("允许") || err.contains("密钥")) {
                                Text(
                                    text = "若刚用邀请码入网，请在电脑端对本手机点击「信任此设备」；若对端重装过，可在「设置」重置公钥固定。",
                                    fontSize = 13.sp,
                                    lineHeight = 18.sp,
                                    color = c.secondaryLabel,
                                    textAlign = TextAlign.Center,
                                )
                            }
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                Box(
                                    modifier = Modifier
                                        .weight(1f)
                                        .height(40.dp)
                                        .clip(RoundedCornerShape(10.dp))
                                        .background(c.blue)
                                        .clickable(enabled = !isActiveRefreshing) {
                                            triggerHardRefresh(activeId)
                                        },
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(
                                        text = if (isActiveRefreshing) "重连中…" else "重试连接",
                                        color = Color.White,
                                        fontSize = 14.5.sp,
                                        fontWeight = FontWeight.SemiBold,
                                    )
                                }
                                Box(
                                    modifier = Modifier
                                        .weight(1f)
                                        .height(40.dp)
                                        .clip(RoundedCornerShape(10.dp))
                                        .background(c.tertiaryFill)
                                        .clickable(onClick = onJumpSettings),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text("查看设置", color = c.label, fontSize = 14.5.sp, fontWeight = FontWeight.Medium)
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    if (isVisibleTab) {
        renameDevice?.let { dev ->
            RenameDeviceDialog(
                rawName = dev.name,
                currentDisplayName = state.displayName(dev),
                isSelf = false,
                hasAlias = state.hasCustomAlias(dev.id),
                onConfirm = { draft ->
                    repository.renameDevice(dev.id, draft)
                    renameDevice = null
                },
                onReset = {
                    repository.renameDevice(dev.id, "")
                    renameDevice = null
                },
                onDismiss = { renameDevice = null },
            )
        }
    }
}
