package ai.youbrain.mobile.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import ai.youbrain.mobile.UBrainApp

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        val app = context.applicationContext as? UBrainApp ?: return
        if (app.repository.identityStore.getEnrollment() != null &&
            app.repository.appStore.isBackgroundKeepAliveEnabled()
        ) {
            runCatching { RelayForegroundService.start(context) }
        }
    }
}
