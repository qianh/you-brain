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
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat
import ai.youbrain.mobile.data.ConnectionState
import ai.youbrain.mobile.net.AppTab
import ai.youbrain.mobile.service.RelayForegroundService
import ai.youbrain.mobile.ui.AgentScreen
import ai.youbrain.mobile.ui.OnboardingScreen
import ai.youbrain.mobile.ui.PushCenterScreen
import ai.youbrain.mobile.ui.SettingsScreen
import ai.youbrain.mobile.ui.T3DeckScreen
import ai.youbrain.mobile.ui.components.IosNavigationBar
import ai.youbrain.mobile.ui.components.IosTabBar
import ai.youbrain.mobile.ui.theme.IosTheme
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
            val darkTheme = isSystemInDarkTheme()
            UBrainTheme(darkTheme = darkTheme) {
                val iosColors = IosTheme.colors
                val view = LocalView.current
                if (!view.isInEditMode) {
                    SideEffect {
                        val window = this@MainActivity.window
                        @Suppress("DEPRECATION")
                        window.statusBarColor = iosColors.chromeBg.toArgb()
                        @Suppress("DEPRECATION")
                        window.navigationBarColor = iosColors.chromeBg.toArgb()
                        val controller = WindowCompat.getInsetsController(window, view)
                        controller.isAppearanceLightStatusBars = !darkTheme
                        controller.isAppearanceLightNavigationBars = !darkTheme
                    }
                }

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

    override fun onResume() {
        super.onResume()
        (application as UBrainApp).repository.onAppForegrounded()
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
            delay(2_500L)
            everOpenedT3 = true
        }
    }

    val c = IosTheme.colors

    Scaffold(
        containerColor = c.groupedBg,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            IosNavigationBar(
                title = when (currentTab) {
                    AppTab.AGENT -> "主控"
                    AppTab.T3 -> "设备 T3"
                    AppTab.PUSHES -> "消息"
                    AppTab.SETTINGS -> "设置"
                },
                connectionState = state.connectionState,
                onReconnect = { repository.reconnectNow() },
            )
        },
        bottomBar = {
            IosTabBar(
                currentTab = currentTab,
                unreadCount = state.unreadPushCount,
                onSelectTab = { nextTab ->
                    currentTab = nextTab
                    if (nextTab == AppTab.PUSHES) {
                        repository.markPushesRead()
                    }
                },
            )
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
                    color = c.groupedBg,
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
