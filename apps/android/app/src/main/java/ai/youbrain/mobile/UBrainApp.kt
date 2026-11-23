package ai.youbrain.mobile

import android.app.Application
import ai.youbrain.mobile.net.UBrainRepository

class UBrainApp : Application() {
    val repository: UBrainRepository by lazy { UBrainRepository(this) }
}
