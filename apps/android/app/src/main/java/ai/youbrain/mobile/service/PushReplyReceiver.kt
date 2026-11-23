package ai.youbrain.mobile.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.RemoteInput
import ai.youbrain.mobile.R
import ai.youbrain.mobile.UBrainApp
import ai.youbrain.mobile.data.MobilePushItem
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json

class PushReplyReceiver : BroadcastReceiver() {
    companion object {
        const val KEY_REPLY_TEXT = "reply_text"
        const val EXTRA_PUSH_JSON = "push_json"
        const val EXTRA_NOTIFICATION_ID = "notification_id"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val replyText = RemoteInput.getResultsFromIntent(intent)
            ?.getCharSequence(KEY_REPLY_TEXT)
            ?.toString()
            ?.trim()
            .orEmpty()
        val pushJson = intent.getStringExtra(EXTRA_PUSH_JSON) ?: return
        val notificationId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, 2000)
        if (replyText.isEmpty()) return

        val item = runCatching { Json.decodeFromString<MobilePushItem>(pushJson) }.getOrNull() ?: return
        val app = context.applicationContext as? UBrainApp ?: return
        val pending = goAsync()

        CoroutineScope(Dispatchers.IO).launch {
            try {
                val res = app.repository.replyToPush(item, replyText)
                val statusText = res.fold(
                    onSuccess = { "✓ 已发送到 ${it.targetName.ifBlank { item.deviceName }}" },
                    onFailure = { "✕ 回复失败：${it.message ?: "请前往会话处理"}" },
                )
                val updated = NotificationCompat.Builder(context, RelayForegroundService.CHANNEL_PUSH)
                    .setSmallIcon(R.drawable.ic_launcher_foreground)
                    .setContentTitle("${item.deviceName} · ${item.title}")
                    .setContentText(statusText)
                    .setAutoCancel(true)
                    .build()
                runCatching { NotificationManagerCompat.from(context).notify(notificationId, updated) }
            } finally {
                pending.finish()
            }
        }
    }
}
