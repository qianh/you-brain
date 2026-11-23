package ai.youbrain.mobile.data

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.io.File

/**
 * 首次信任固定（TOFU）：记住每台对端设备的 Ed25519 公钥，
 * 之后若中转给出不同公钥则拒绝隧道握手（防止中转被攻破后中间人替换公钥）。
 */
class PeerPinStore(private val file: File) {
    private val json = Json { prettyPrint = true; ignoreUnknownKeys = true }

    @Synchronized
    fun resolve(deviceId: String, offered: String?): String {
        val pins = readAll().toMutableMap()
        val pinned = pins[deviceId]
        if (pinned != null) {
            if (offered != null && offered != pinned) {
                throw IllegalStateException("对端设备的身份密钥已变化，已拒绝连接（若该设备确实重装过，请在设置中清除该设备的公钥固定后重试）")
            }
            return pinned
        }
        require(!offered.isNullOrBlank()) { "中转没有给出这台设备的身份密钥" }
        pins[deviceId] = offered
        writeAll(pins)
        return offered
    }

    @Synchronized
    fun listPins(): Map<String, String> = readAll()

    @Synchronized
    fun forget(deviceId: String) {
        val pins = readAll().toMutableMap()
        if (pins.remove(deviceId) != null) {
            writeAll(pins)
        }
    }

    @Synchronized
    fun clearAll() {
        runCatching { file.delete() }
    }

    private fun readAll(): Map<String, String> {
        return try {
            if (!file.exists()) return emptyMap()
            json.decodeFromString<Map<String, String>>(file.readText())
        } catch (_: Throwable) {
            emptyMap()
        }
    }

    private fun writeAll(pins: Map<String, String>) {
        file.parentFile?.mkdirs()
        val tmp = File(file.parentFile, "${file.name}.tmp")
        tmp.writeText(json.encodeToString(pins) + "\n")
        if (!tmp.renameTo(file)) {
            file.writeText(tmp.readText())
            tmp.delete()
        }
    }
}
