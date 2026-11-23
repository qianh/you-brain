package ai.youbrain.mobile

import android.app.Application
import android.webkit.WebSettings
import ai.youbrain.mobile.net.UBrainRepository

class UBrainApp : Application() {
    val repository: UBrainRepository by lazy { UBrainRepository(this) }

    override fun onCreate() {
        super.onCreate()
        // 后台预加载 Chromium 内核，消除首次创建 WebView 的冷启动卡顿
        Thread { runCatching { WebSettings.getDefaultUserAgent(this) } }.start()
    }
}
