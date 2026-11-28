package ai.youbrain.mobile.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import androidx.core.content.ContextCompat
import ai.youbrain.mobile.MainActivity
import ai.youbrain.mobile.R
import ai.youbrain.mobile.UBrainApp
import ai.youbrain.mobile.data.ConnectionState
import ai.youbrain.mobile.data.MobilePushItem
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

class RelayForegroundService : Service() {
    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var stateJob: Job? = null
    private var switchJob: Job? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    @Volatile
    private var lastNetwork: Network? = null
    private var lastNotifiedText: String? = null
    private val json = Json { encodeDefaults = true }

    companion object {
        const val CHANNEL_KEEPALIVE = "ubrain_relay_keepalive"
        const val CHANNEL_PUSH = "ubrain_push_alerts"
        const val ONGOING_NOTIFICATION_ID = 1001
        const val EXTRA_TAB = "extra_tab"
        const val EXTRA_DEVICE_ID = "extra_device_id"
        const val EXTRA_THREAD_URL = "extra_thread_url"
        const val EXTRA_TERMINAL_PANE = "extra_terminal_pane"

        fun start(context: Context) {
            val intent = Intent(context, RelayForegroundService::class.java)
            ContextCompat.startForegroundService(context, intent)
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, RelayForegroundService::class.java))
        }

        fun ensureChannels(context: Context) {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
            val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val keepalive = NotificationChannel(
                CHANNEL_KEEPALIVE,
                "U-Brain 后台连接",
                NotificationManager.IMPORTANCE_LOW,
            ).apply {
                description = "保持与中转的长连接以实时接收推送与隧道访问"
                setShowBadge(false)
            }
            val push = NotificationChannel(
                CHANNEL_PUSH,
                "U-Brain 任务与终端推送",
                NotificationManager.IMPORTANCE_HIGH,
            ).apply {
                description = "接收全部设备的 T3、终端会话、派活进展与记忆提醒"
            }
            nm.createNotificationChannel(keepalive)
            nm.createNotificationChannel(push)
        }
    }

    override fun onCreate() {
        super.onCreate()
        ensureChannels(this)
        val app = application as UBrainApp
        val repo = app.repository

        startForeground(ONGOING_NOTIFICATION_ID, buildOngoingNotification("U-Brain 正在连接中转…"))

        repo.onNewLivePush = { item ->
            postPushNotification(item)
        }

        stateJob = serviceScope.launch {
            repo.uiState.collectLatest { state ->
                val text = when {
                    !state.enrolled -> "尚未入网"
                    state.connectionState == ConnectionState.OK -> {
                        val onlineCount = state.relayState.devices.count { it.online && it.id != state.deviceId }
                        "已连接中转 · 在线设备 $onlineCount 台"
                    }
                    state.connectionState == ConnectionState.CONNECTING -> "正在连接中转…"
                    state.connectionState == ConnectionState.ERROR -> state.connectionError ?: "连接断开，等待重连…"
                    else -> "已断开"
                }
                if (text != lastNotifiedText) {
                    lastNotifiedText = text
                    val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                    nm.notify(ONGOING_NOTIFICATION_ID, buildOngoingNotification(text))
                }
            }
        }

        registerNetworkWatcher()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY
    }

    override fun onDestroy() {
        val repo = (application as UBrainApp).repository
        repo.onNewLivePush = null
        unregisterNetworkWatcher()
        switchJob?.cancel()
        stateJob?.cancel()
        serviceScope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun registerNetworkWatcher() {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                val repo = (application as UBrainApp).repository
                val prev = lastNetwork
                if (prev == null) {
                    lastNetwork = network
                    repo.reconnectIfDisconnected()
                    return
                }
                if (prev != network) {
                    lastNetwork = network
                    switchJob?.cancel()
                    switchJob = serviceScope.launch {
                        delay(400L)
                        repo.reconnectNow()
                    }
                }
            }
        }
        networkCallback = cb
        runCatching { cm.registerDefaultNetworkCallback(cb) }
    }

    private fun unregisterNetworkWatcher() {
        val cb = networkCallback ?: return
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        runCatching { cm.unregisterNetworkCallback(cb) }
        networkCallback = null
    }

    private fun buildOngoingNotification(contentText: String): Notification {
        val openIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_KEEPALIVE)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("U-Brain")
            .setContentText(contentText)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setContentIntent(openIntent)
            .build()
    }

    private fun postPushNotification(item: MobilePushItem) {
        val notificationId = (2000 + (item.seq % 10000)).toInt()
        val terminalPane = ai.youbrain.mobile.ui.TerminalLogic.parsePaneFromPush(item)
        val targetTab = when {
            item.kind == "tty7" -> "terminal"
            item.kind == "t3" || !item.threadId.isNullOrBlank() -> "t3"
            else -> "pushes"
        }
        val openIntent = PendingIntent.getActivity(
            this,
            notificationId,
            Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra(EXTRA_TAB, targetTab)
                putExtra(EXTRA_DEVICE_ID, item.deviceId)
                putExtra(EXTRA_THREAD_URL, item.link)
                if (terminalPane != null) {
                    putExtra(EXTRA_TERMINAL_PANE, terminalPane)
                }
            },
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val senderLabel = (application as UBrainApp).repository.resolveDisplayName(item.deviceId, item.deviceName)
        val bodyText = item.body.ifBlank { item.title }
        val builder = NotificationCompat.Builder(this, CHANNEL_PUSH)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentTitle("$senderLabel · ${item.title}")
            .setContentText(bodyText)
            .setStyle(NotificationCompat.BigTextStyle().bigText(bodyText))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(openIntent)

        if (!item.replyToken.isNullOrBlank()) {
            val remoteInput = RemoteInput.Builder(PushReplyReceiver.KEY_REPLY_TEXT)
                .setLabel("回复到 $senderLabel…")
                .build()
            val replyIntent = Intent(this, PushReplyReceiver::class.java).apply {
                putExtra(PushReplyReceiver.EXTRA_PUSH_JSON, json.encodeToString(item))
                putExtra(PushReplyReceiver.EXTRA_NOTIFICATION_ID, notificationId)
            }
            val replyPending = PendingIntent.getBroadcast(
                this,
                notificationId + 20_000,
                replyIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
            )
            val action = NotificationCompat.Action.Builder(
                0,
                "快捷回复",
                replyPending,
            )
                .addRemoteInput(remoteInput)
                .setAllowGeneratedReplies(true)
                .build()
            builder.addAction(action)
        }

        runCatching {
            NotificationManagerCompat.from(this).notify(notificationId, builder.build())
        }
    }
}
