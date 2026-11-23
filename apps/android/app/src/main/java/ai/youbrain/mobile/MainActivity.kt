package ai.youbrain.mobile

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import ai.youbrain.mobile.data.ConnectionState
import ai.youbrain.mobile.net.AppTab
import ai.youbrain.mobile.service.RelayForegroundService
import ai.youbrain.mobile.ui.AgentScreen
import ai.youbrain.mobile.ui.OnboardingScreen
import ai.youbrain.mobile.ui.PushCenterScreen
import ai.youbrain.mobile.ui.SettingsScreen
import ai.youbrain.mobile.ui.T3DeckScreen
import ai.youbrain.mobile.ui.theme.UBrainTheme
import kotlinx.coroutines.delay

class MainActivity : ComponentActivity() {
    private var pendingFileCallback: ValueCallback<Array<Uri>>? = null
    private var pairingUriState by mutableStateOf<String?>(null)

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val cb = pendingFileCallback
        pendingFileCallback = null
        val uris = WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data)
        cb?.onReceiveValue(uris)
    }

    private val notifPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { _ -> }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val repo = (application as UBrainApp).repository
        handleIncomingIntent(intent, repo)

        setContent {
            UBrainTheme {
                val state by repo.uiState.collectAsState()

                LaunchedEffect(state.enrolled, state.backgroundKeepAlive) {
                    if (state.enrolled) {
                        ensureNotificationPermission()
                        if (state.backgroundKeepAlive) {
                            runCatching { RelayForegroundService.start(this@MainActivity) }
                        } else {
                            RelayForegroundService.stop(this@MainActivity)
                        }
                    } else {
                        RelayForegroundService.stop(this@MainActivity)
                    }
                }

                if (!state.enrolled) {
                    OnboardingScreen(
                        defaultDeviceName = repo.identityStore.defaultDeviceName(),
                        initialPairingUri = pairingUriState,
                        onEnroll = { url, code, name -> repo.enroll(url, code, name) },
                    )
                } else {
                    MainTabsShell(
                        repository = repo,
                        onFileChooser = { cb, intent ->
                            pendingFileCallback?.onReceiveValue(null)
                            pendingFileCallback = cb
                            fileChooserLauncher.launch(intent)
                        },
                        onToggleBackgroundService = { enabled ->
                            if (enabled) {
                                runCatching { RelayForegroundService.start(this@MainActivity) }
                            } else {
                                RelayForegroundService.stop(this@MainActivity)
                            }
                        },
                        onUnenroll = {
                            RelayForegroundService.stop(this@MainActivity)
                            repo.unenroll()
                        },
                    )
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingIntent(intent, (application as UBrainApp).repository)
    }

    private fun handleIncomingIntent(intent: Intent?, repo: ai.youbrain.mobile.net.UBrainRepository) {
        if (intent == null) return
        val data = intent.data
        if (data != null && data.scheme == "ubrain" && data.host == "enroll") {
            pairingUriState = data.toString()
        }
        when (intent.getStringExtra(RelayForegroundService.EXTRA_TAB)) {
            "t3" -> repo.navigateTo(
                tab = AppTab.T3,
                deviceId = intent.getStringExtra(RelayForegroundService.EXTRA_DEVICE_ID),
                threadUrl = intent.getStringExtra(RelayForegroundService.EXTRA_THREAD_URL),
            )
            "pushes" -> repo.navigateTo(AppTab.PUSHES)
        }
    }

    private fun ensureNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val granted = ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) {
                notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }
}

@Composable
private fun MainTabsShell(
    repository: ai.youbrain.mobile.net.UBrainRepository,
    onFileChooser: (ValueCallback<Array<Uri>>, Intent) -> Unit,
    onToggleBackgroundService: (Boolean) -> Unit,
    onUnenroll: () -> Unit,
) {
    val state by repository.uiState.collectAsState()
    var currentTab by remember { mutableStateOf(AppTab.AGENT) }
    var targetT3DeviceId by remember { mutableStateOf<String?>(null) }
    var targetT3ThreadUrl by remember { mutableStateOf<String?>(null) }
    var everOpenedT3 by remember { mutableStateOf(false) }

    LaunchedEffect(state.navTarget) {
        val nav = state.navTarget ?: return@LaunchedEffect
        currentTab = nav.tab
        if (nav.deviceId != null) targetT3DeviceId = nav.deviceId
        if (nav.threadUrl != null) targetT3ThreadUrl = nav.threadUrl
    }

    LaunchedEffect(currentTab) {
        if (currentTab == AppTab.T3) everOpenedT3 = true
    }

    val hasOnlineViewT3 = state.connectionState == ConnectionState.OK &&
        state.relayState.devices.any {
            it.id != state.deviceId && it.online && it.enrolled == true && it.dispatch?.viewT3 == true
        }
    LaunchedEffect(hasOnlineViewT3) {
        if (hasOnlineViewT3 && !everOpenedT3) {
            delay(500L)
            everOpenedT3 = true
        }
    }

    Scaffold(
        topBar = {
            Surface(tonalElevation = 1.dp, modifier = Modifier.fillMaxWidth()) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .statusBarsPadding()
                        .height(40.dp)
                        .padding(horizontal = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text(
                        text = when (currentTab) {
                            AppTab.AGENT -> "主控调度"
                            AppTab.T3 -> "设备 T3"
                            AppTab.PUSHES -> "推送中心"
                            AppTab.SETTINGS -> "设置"
                        },
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                    )
                    val statusLabel = when (state.connectionState) {
                        ConnectionState.OK -> "● 已连"
                        ConnectionState.CONNECTING -> "◌ 连接中"
                        else -> "✕ 重连"
                    }
                    val statusColor = when (state.connectionState) {
                        ConnectionState.OK -> MaterialTheme.colorScheme.secondary
                        ConnectionState.CONNECTING -> MaterialTheme.colorScheme.onSurfaceVariant
                        else -> MaterialTheme.colorScheme.error
                    }
                    Surface(
                        shape = RoundedCornerShape(999.dp),
                        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.7f),
                        modifier = Modifier.clickable { repository.reconnectNow() },
                    ) {
                        Text(
                            text = statusLabel,
                            color = statusColor,
                            style = MaterialTheme.typography.labelMedium,
                            maxLines = 1,
                            softWrap = false,
                            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                        )
                    }
                }
            }
        },
        bottomBar = {
            NavigationBar {
                NavigationBarItem(
                    selected = currentTab == AppTab.AGENT,
                    onClick = { currentTab = AppTab.AGENT },
                    icon = { Text("⌘") },
                    label = { Text("主控") },
                )
                NavigationBarItem(
                    selected = currentTab == AppTab.T3,
                    onClick = { currentTab = AppTab.T3 },
                    icon = { Text("🛰") },
                    label = { Text("T3") },
                )
                NavigationBarItem(
                    selected = currentTab == AppTab.PUSHES,
                    onClick = {
                        currentTab = AppTab.PUSHES
                        repository.markPushesRead()
                    },
                    icon = {
                        if (state.unreadPushCount > 0) {
                            BadgedBox(badge = { Badge { Text("${state.unreadPushCount}") } }) {
                                Text("🔔")
                            }
                        } else {
                            Text("🔔")
                        }
                    },
                    label = { Text("消息") },
                )
                NavigationBarItem(
                    selected = currentTab == AppTab.SETTINGS,
                    onClick = { currentTab = AppTab.SETTINGS },
                    icon = { Text("⚙") },
                    label = { Text("设置") },
                )
            }
        },
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding)) {
            if (everOpenedT3) {
                T3DeckScreen(
                    state = state,
                    repository = repository,
                    isVisibleTab = (currentTab == AppTab.T3),
                    preferredDeviceId = targetT3DeviceId,
                    preferredThreadUrl = targetT3ThreadUrl,
                    onFileChooser = onFileChooser,
                    onJumpSettings = { currentTab = AppTab.SETTINGS },
                )
            }
            if (currentTab != AppTab.T3) {
                Surface(
                    color = MaterialTheme.colorScheme.background,
                    modifier = Modifier.fillMaxSize(),
                ) {
                    when (currentTab) {
                        AppTab.AGENT -> AgentScreen(
                            state = state,
                            repository = repository,
                            onOpenDeviceT3 = { devId, threadUrl ->
                                targetT3DeviceId = devId
                                targetT3ThreadUrl = threadUrl
                                currentTab = AppTab.T3
                            },
                        )
                        AppTab.PUSHES -> PushCenterScreen(
                            state = state,
                            repository = repository,
                            onOpenDeviceT3 = { devId, threadUrl ->
                                targetT3DeviceId = devId
                                targetT3ThreadUrl = threadUrl
                                currentTab = AppTab.T3
                            },
                        )
                        AppTab.SETTINGS -> SettingsScreen(
                            state = state,
                            repository = repository,
                            onToggleBackgroundService = onToggleBackgroundService,
                            onUnenroll = onUnenroll,
                        )
                        AppTab.T3 -> Unit
                    }
                }
            }
        }
    }
}
