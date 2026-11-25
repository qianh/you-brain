package ai.youbrain.mobile.ui

import kotlin.math.min

/** 与宿主协议一致：剪贴板文本按 48K 字符分片，总长不超过 400 万字符。 */
const val RD_CLIPBOARD_CHUNK_CHARS = 48_000
const val RD_CLIPBOARD_MAX_CHARS = 4_000_000

/** 剪贴板图片上限，与宿主 `CLIPBOARD_IMAGE_MAX_BYTES` 一致。 */
const val RD_CLIPBOARD_IMAGE_MAX_BYTES = 20 * 1024 * 1024

/** 远端剪贴板图片的虚拟下载路径。 */
const val RD_CLIPBOARD_IMAGE_PATH = "clipboard:image"

/** 自动重连上限与退避。 */
const val RD_MAX_AUTO_RECONNECTS = 6

fun rdReconnectDelayMs(attempt: Int): Long {
    val n = attempt.coerceAtLeast(1)
    return min(8_000L, 500L shl min(n - 1, 5))
}

/** 按字符数分片，不拆开代理对。 */
fun chunkClipboardText(text: String, size: Int = RD_CLIPBOARD_CHUNK_CHARS): List<String> {
    if (text.length <= size) return listOf(text)
    val out = ArrayList<String>()
    var start = 0
    while (start < text.length) {
        var end = min(text.length, start + size)
        if (end < text.length && end > start + 1 && Character.isHighSurrogate(text[end - 1])) end -= 1
        out.add(text.substring(start, end))
        start = end
    }
    return out
}

/** 重组远端分片推送的剪贴板文本；乱序也能拼回。 */
class ClipboardChunkAssembler {
    private var batchId: String? = null
    private var parts: Array<String?> = emptyArray()
    private var received = 0

    /** 收到完整文本时返回，否则返回 null。没有分片信息的消息直接返回原文。 */
    fun push(text: String, id: String?, index: Int?, total: Int?): String? {
        if (id == null || index == null || total == null || total <= 1) {
            reset()
            return text
        }
        if (total > 1_000 || index !in 0 until total) return null
        if (id != batchId || parts.size != total) {
            batchId = id
            parts = arrayOfNulls(total)
            received = 0
        }
        if (parts[index] == null) {
            parts[index] = text
            received += 1
        }
        if (received < total) return null
        val joined = parts.joinToString(separator = "") { it.orEmpty() }
        reset()
        return joined
    }

    private fun reset() {
        batchId = null
        parts = emptyArray()
        received = 0
    }
}

data class RdKeyEvent(
    val down: Boolean,
    val code: String,
    val meta: Boolean,
    val ctrl: Boolean,
    val alt: Boolean,
    val shift: Boolean,
)

data class RdKeyCombo(val label: String, val codes: List<String>)

val RD_KEY_COMBOS: List<RdKeyCombo> = listOf(
    RdKeyCombo("⌘Tab 切换应用", listOf("MetaLeft", "Tab")),
    RdKeyCombo("⌘Space 聚焦搜索", listOf("MetaLeft", "Space")),
    RdKeyCombo("⌃Space 输入法", listOf("ControlLeft", "Space")),
    RdKeyCombo("⌃↑ 调度中心", listOf("ControlLeft", "ArrowUp")),
    RdKeyCombo("⌘F3 显示桌面", listOf("MetaLeft", "F3")),
    RdKeyCombo("⌘C 复制", listOf("MetaLeft", "KeyC")),
    RdKeyCombo("⌘V 粘贴", listOf("MetaLeft", "KeyV")),
    RdKeyCombo("⌘X 剪切", listOf("MetaLeft", "KeyX")),
    RdKeyCombo("⌘Z 撤销", listOf("MetaLeft", "KeyZ")),
    RdKeyCombo("⌘A 全选", listOf("MetaLeft", "KeyA")),
    RdKeyCombo("⇧⌘5 截屏", listOf("MetaLeft", "ShiftLeft", "Digit5")),
    RdKeyCombo("⌥⌘Esc 强制退出", listOf("MetaLeft", "AltLeft", "Escape")),
    RdKeyCombo("⌃⌘Q 锁屏", listOf("ControlLeft", "MetaLeft", "KeyQ")),
    RdKeyCombo("⌘W 关闭窗口", listOf("MetaLeft", "KeyW")),
    RdKeyCombo("⌘H 隐藏", listOf("MetaLeft", "KeyH")),
    RdKeyCombo("⌘Q 退出应用", listOf("MetaLeft", "KeyQ")),
)

private fun modifierFlag(code: String): Char? = when (code) {
    "MetaLeft", "MetaRight" -> 'm'
    "ControlLeft", "ControlRight" -> 'c'
    "AltLeft", "AltRight" -> 'a'
    "ShiftLeft", "ShiftRight" -> 's'
    else -> null
}

/** 依次按下、逆序抬起，每个事件带上当时的修饰键状态（与 Web 端 expandKeyCombo 一致）。 */
fun expandKeyCombo(codes: List<String>): List<RdKeyEvent> {
    val held = HashSet<Char>()
    val out = ArrayList<RdKeyEvent>(codes.size * 2)
    fun event(down: Boolean, code: String) =
        RdKeyEvent(down, code, 'm' in held, 'c' in held, 'a' in held, 's' in held)
    for (code in codes) {
        modifierFlag(code)?.let { held.add(it) }
        out.add(event(true, code))
    }
    for (code in codes.asReversed()) {
        modifierFlag(code)?.let { held.remove(it) }
        out.add(event(false, code))
    }
    return out
}

/** 传输进度的简短文字，如 `3.2 / 10.0 MB`。 */
fun formatTransferBytes(bytes: Long): String = when {
    bytes >= 1024L * 1024 * 1024 -> String.format(java.util.Locale.US, "%.1f GB", bytes / 1024.0 / 1024 / 1024)
    bytes >= 1024L * 1024 -> String.format(java.util.Locale.US, "%.1f MB", bytes / 1024.0 / 1024)
    bytes >= 1024L -> String.format(java.util.Locale.US, "%.0f KB", bytes / 1024.0)
    else -> "$bytes B"
}
