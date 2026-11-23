package ai.youbrain.mobile.ui

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.view.View
import android.webkit.CookieManager
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import ai.youbrain.mobile.net.AppUiState
import ai.youbrain.mobile.net.UBrainRepository
import java.net.URI

private const val MAX_WEBVIEW_POOL = 4

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
    val devices = remember(state.relayState.devices, state.deviceId) {
        repository.viewT3Devices()
    }

    var selectedId by remember { mutableStateOf<String?>(null) }
    var reloadNonce by remember { mutableIntStateOf(0) }
    val proxyUrls = remember { mutableStateMapOf<String, String>() }
    val loadingIds = remember { mutableStateMapOf<String, Boolean>() }
    val errorByDevice = remember { mutableStateMapOf<String, String?>() }

    val webViews = remember { LinkedHashMap<String, WebView>(8, 0.75f, true) }
    var containerRef by remember { mutableStateOf<FrameLayout?>(null) }

    LaunchedEffect(preferredDeviceId, devices) {
        if (!preferredDeviceId.isNullOrBlank() && devices.any { it.id == preferredDeviceId }) {
            selectedId = preferredDeviceId
        } else if (selectedId == null || devices.none { it.id == selectedId }) {
            selectedId = devices.firstOrNull { it.online }?.id ?: devices.firstOrNull()?.id
        }
    }

    val activeId = selectedId
    val activeDevice = devices.firstOrNull { it.id == activeId }

    LaunchedEffect(activeId, activeDevice?.online, reloadNonce) {
        val devId = activeId ?: return@LaunchedEffect
        if (activeDevice?.online != true) {
            errorByDevice[devId] = "该设备当前离线"
            return@LaunchedEffect
        }
        loadingIds[devId] = true
        errorByDevice[devId] = null
        val res = repository.getOrStartT3ProxyUrl(devId)
        loadingIds[devId] = false
        res.fold(
            onSuccess = { url -> proxyUrls[devId] = url },
            onFailure = { t -> errorByDevice[devId] = t.message ?: "无法建立 T3 隧道" },
        )
    }

    // 如果来自消息或派活看板带具体 threadUrl，定位至对应路径
    LaunchedEffect(activeId, preferredThreadUrl, proxyUrls[activeId]) {
        val devId = activeId ?: return@LaunchedEffect
        val base = proxyUrls[devId] ?: return@LaunchedEffect
        val deep = preferredThreadUrl?.takeIf { it.isNotBlank() } ?: return@LaunchedEffect
        val rel = runCatching {
            val u = URI(deep)
            (u.rawPath.ifEmpty { "/" }) + (u.rawQuery?.let { "?$it" } ?: "")
        }.getOrNull() ?: return@LaunchedEffect
        val target = base.trimEnd('/') + rel
        webViews[devId]?.loadUrl(target)
    }

    DisposableEffect(Unit) {
        onDispose {
            for (wv in webViews.values) {
                runCatching { wv.destroy() }
            }
            webViews.clear()
        }
    }

    BackHandler(enabled = isVisibleTab && activeId != null && webViews[activeId]?.canGoBack() == true) {
        activeId?.let { webViews[it]?.goBack() }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        // 顶部设备切换栏（固定右侧重载按钮，避免长设备名挤压）
        if (isVisibleTab) {
            Surface(tonalElevation = 2.dp) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 10.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    if (devices.isEmpty()) {
                        Text(
                            text = "暂无开放 T3 的设备",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(vertical = 8.dp, horizontal = 4.dp),
                        )
                    } else {
                        Row(
                            modifier = Modifier
                                .weight(1f)
                                .horizontalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            devices.forEach { dev ->
                                val dot = if (dev.online) "● " else "○ "
                                FilterChip(
                                    selected = dev.id == activeId,
                                    onClick = { selectedId = dev.id },
                                    label = {
                                        Text(
                                            text = "$dot${dev.name}",
                                            maxLines = 1,
                                            softWrap = false,
                                            overflow = TextOverflow.Ellipsis,
                                            modifier = Modifier.widthIn(max = 160.dp),
                                        )
                                    },
                                )
                            }
                        }
                        if (activeId != null) {
                            TextButton(
                                onClick = {
                                    webViews[activeId]?.reload() ?: run { reloadNonce += 1 }
                                },
                                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                            ) {
                                Text("↻ 重载", maxLines = 1, softWrap = false)
                            }
                        }
                    }
                }
            }
        }

        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            // 始终保留多设备 WebView 容器，切换设备只改可见性，不丢输入框和滚动进度
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
                                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                                    val u = request.url
                                    if (u.host == "127.0.0.1" || u.host == "localhost") return false
                                    runCatching {
                                        context.startActivity(Intent(Intent.ACTION_VIEW, u))
                                    }
                                    return true
                                }
                            }
                            webChromeClient = object : WebChromeClient() {
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

            // 加载 / 错误 / 空态覆盖层
            if (isVisibleTab) when {
                devices.isEmpty() -> {
                    Column(
                        modifier = Modifier.fillMaxSize().padding(28.dp),
                        verticalArrangement = Arrangement.Center,
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text("还没有发现开放 T3 的设备", style = MaterialTheme.typography.titleMedium)
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(
                            text = "请在电脑端 U-Brain「设置 → 接入 → 跨设备派活」开启「允许查看本机 T3」，并点击该手机的「信任此设备」。",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                activeId != null && loadingIds[activeId] == true -> {
                    Column(
                        modifier = Modifier.fillMaxSize(),
                        verticalArrangement = Arrangement.Center,
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        CircularProgressIndicator()
                        Spacer(modifier = Modifier.height(10.dp))
                        Text("正在建立端到端加密 T3 隧道…", style = MaterialTheme.typography.bodySmall)
                    }
                }
                activeId != null && errorByDevice[activeId] != null -> {
                    val err = errorByDevice[activeId]!!
                    Column(
                        modifier = Modifier.fillMaxSize().padding(28.dp),
                        verticalArrangement = Arrangement.Center,
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text(
                            text = err,
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                        Spacer(modifier = Modifier.height(8.dp))
                        if (err.contains("不接受") || err.contains("允许") || err.contains("密钥")) {
                            Text(
                                text = "如果刚用邀请码入网，请到电脑端 U-Brain「设置 → 接入 → 跨设备派活」中对本手机点击「信任此设备」；若对端重装过，可在「设置」里重置其公钥固定。",
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Spacer(modifier = Modifier.height(10.dp))
                        }
                        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            Button(onClick = { reloadNonce += 1 }) { Text("重试连接") }
                            OutlinedButton(onClick = onJumpSettings) { Text("查看设置") }
                        }
                    }
                }
            }
        }
    }
}
