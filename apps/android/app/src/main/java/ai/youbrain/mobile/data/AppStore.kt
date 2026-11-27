package ai.youbrain.mobile.data

import android.content.Context
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File

class AppStore(context: Context) {
    private val prefs = context.getSharedPreferences("ubrain_app", Context.MODE_PRIVATE)
    private val pushesFile = File(context.filesDir, "pushes_cache.json")
    private val agentSnapshotsFile = File(context.filesDir, "agent_snapshots.json")
    private val todoBoardsFile = File(context.filesDir, "todo_boards_cache.json")
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

    fun getSelectedDeviceId(): String? =
        prefs.getString("selected_device_id", null) ?: prefs.getString("todo_device_id", null)

    fun setSelectedDeviceId(deviceId: String?) {
        prefs.edit().apply {
            if (deviceId == null) {
                remove("selected_device_id")
                remove("todo_device_id")
            } else {
                putString("selected_device_id", deviceId)
                putString("todo_device_id", deviceId)
            }
        }.apply()
    }

    fun getSelectedTodoDeviceId(): String? = getSelectedDeviceId()

    fun setSelectedTodoDeviceId(deviceId: String?) = setSelectedDeviceId(deviceId)

    fun isBackgroundKeepAliveEnabled(): Boolean = prefs.getBoolean("keep_alive", true)

    fun setBackgroundKeepAliveEnabled(enabled: Boolean) {
        prefs.edit().putBoolean("keep_alive", enabled).apply()
    }

    @Synchronized
    fun getDeviceAliases(): Map<String, String> {
        val raw = prefs.getString("device_aliases", null) ?: return emptyMap()
        return try {
            json.decodeFromString<Map<String, String>>(raw)
        } catch (_: Throwable) {
            emptyMap()
        }
    }

    @Synchronized
    fun setDeviceAlias(deviceId: String, alias: String?): Map<String, String> {
        val next = LinkedHashMap(getDeviceAliases())
        val clean = alias
            ?.replace(Regex("[\\u0000-\\u001f]"), "")
            ?.trim()
            ?.take(40)
            .orEmpty()
        if (clean.isEmpty()) {
            next.remove(deviceId)
        } else {
            next[deviceId] = clean
        }
        prefs.edit().putString("device_aliases", json.encodeToString(next)).apply()
        return next.toMap()
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
    fun loadCachedTodoBoards(): Map<String, TaskBoard> {
        return try {
            if (!todoBoardsFile.exists()) return emptyMap()
            json.decodeFromString<Map<String, TaskBoard>>(todoBoardsFile.readText())
        } catch (_: Throwable) {
            emptyMap()
        }
    }

    @Synchronized
    fun saveCachedTodoBoard(deviceId: String, board: TaskBoard) {
        if (deviceId.isBlank()) return
        runCatching {
            val existing = LinkedHashMap(loadCachedTodoBoards())
            existing.remove(deviceId)
            existing[deviceId] = board
            while (existing.size > 12) {
                val oldestKey = existing.keys.firstOrNull() ?: break
                existing.remove(oldestKey)
            }
            todoBoardsFile.writeText(json.encodeToString(existing))
        }
    }

    @Synchronized
    fun loadAgentSnapshot(masterDeviceId: String?): CachedAgentSnapshot? {
        if (masterDeviceId.isNullOrBlank()) return null
        return loadAllAgentSnapshots()[masterDeviceId]
    }

    @Synchronized
    fun saveAgentSnapshot(snapshot: CachedAgentSnapshot) {
        if (snapshot.masterDeviceId.isBlank()) return
        runCatching {
            val existing = LinkedHashMap(loadAllAgentSnapshots())
            val confirmedMessages = snapshot.messages
                .filter { it.position < 1_000_000 }
                .takeLast(80)
            existing.remove(snapshot.masterDeviceId)
            existing[snapshot.masterDeviceId] = snapshot.copy(
                messages = confirmedMessages,
                outbox = snapshot.outbox.take(30),
            )
            while (existing.size > 6) {
                val oldestKey = existing.keys.firstOrNull() ?: break
                existing.remove(oldestKey)
            }
            agentSnapshotsFile.writeText(json.encodeToString(existing))
        }
    }

    private fun loadAllAgentSnapshots(): Map<String, CachedAgentSnapshot> {
        return try {
            if (!agentSnapshotsFile.exists()) return emptyMap()
            json.decodeFromString<Map<String, CachedAgentSnapshot>>(agentSnapshotsFile.readText())
        } catch (_: Throwable) {
            emptyMap()
        }
    }

    @Synchronized
    fun clearPushesAndSeq() {
        prefs.edit()
            .remove("last_push_seq")
            .remove("master_device_id")
            .remove("selected_device_id")
            .remove("todo_device_id")
            .apply()
        runCatching { pushesFile.delete() }
        runCatching { agentSnapshotsFile.delete() }
        runCatching { todoBoardsFile.delete() }
    }
}
