package ai.youbrain.mobile.data

import android.content.Context
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File

class AppStore(context: Context) {
    private val prefs = context.getSharedPreferences("ubrain_app", Context.MODE_PRIVATE)
    private val pushesFile = File(context.filesDir, "pushes_cache.json")
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    fun getLastPushSeq(): Long = prefs.getLong("last_push_seq", 0L)

    fun setLastPushSeq(seq: Long) {
        if (seq > getLastPushSeq()) {
            prefs.edit().putLong("last_push_seq", seq).apply()
        }
    }

    fun getSelectedMasterDeviceId(): String? = prefs.getString("master_device_id", null)

    fun setSelectedMasterDeviceId(deviceId: String?) {
        prefs.edit().apply {
            if (deviceId == null) remove("master_device_id") else putString("master_device_id", deviceId)
        }.apply()
    }

    fun isBackgroundKeepAliveEnabled(): Boolean = prefs.getBoolean("keep_alive", true)

    fun setBackgroundKeepAliveEnabled(enabled: Boolean) {
        prefs.edit().putBoolean("keep_alive", enabled).apply()
    }

    @Synchronized
    fun loadCachedPushes(): List<MobilePushItem> {
        return try {
            if (!pushesFile.exists()) return emptyList()
            json.decodeFromString<List<MobilePushItem>>(pushesFile.readText())
        } catch (_: Throwable) {
            emptyList()
        }
    }

    @Synchronized
    fun saveCachedPushes(items: List<MobilePushItem>) {
        runCatching {
            val trimmed = items.sortedByDescending { it.seq }.take(300)
            pushesFile.writeText(json.encodeToString(trimmed))
        }
    }

    @Synchronized
    fun clearPushesAndSeq() {
        prefs.edit().remove("last_push_seq").remove("master_device_id").apply()
        runCatching { pushesFile.delete() }
    }
}
