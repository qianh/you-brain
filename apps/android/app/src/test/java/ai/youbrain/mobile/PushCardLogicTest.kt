package ai.youbrain.mobile

import ai.youbrain.mobile.ui.summarizePushBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PushCardLogicTest {

    @Test
    fun blankBodyHasNoPreviewAndCannotExpandByContent() {
        val summary = summarizePushBody("   \n  ", kind = "t3")
        assertEquals("", summary.previewText)
        assertFalse(summary.hasExtraOrRichContent)
    }

    @Test
    fun singleShortPlainSentenceStaysCompactWithoutForcingExpand() {
        val summary = summarizePushBody("已完成重启并恢复同步。", kind = "reminder")
        assertEquals("已完成重启并恢复同步。", summary.previewText)
        assertFalse(summary.hasExtraOrRichContent)
    }

    @Test
    fun markdownTableAndLinksCollapseToCleanPlainPreviewAndMarkExpandable() {
        val markdown = """
            三台开发/服务器设备的 `you-brain` 已全部更新到最新提交 **4861c81** 并完成重新安装与验证，当前 **4 台设备均在线**：

            | 设备 | 更新后 Commit | 操作 |
            |---|---|---|
            | **VPS 主控** | `3a447c8` → `4861c81` | [查看会话](https://app.t3.codes/threads/abc) |
        """.trimIndent()

        val summary = summarizePushBody(markdown, kind = "t3")
        assertTrue(summary.hasExtraOrRichContent)
        val lines = summary.previewText.lines()
        assertEquals(
            "三台开发/服务器设备的 you-brain 已全部更新到最新提交 4861c81 并完成重新安装与验证，当前 4 台设备均在线：",
            lines[0],
        )
        assertEquals("设备 · 更新后 Commit · 操作", lines[1])
        assertEquals("VPS 主控 · 3a447c8 → 4861c81 · 查看会话", lines[2])
    }

    @Test
    fun tty7SnapshotPreservesRawLinesAndDetectsOverflowingLineCount() {
        val shortTerm = "$ git status\nnothing to commit"
        val shortSummary = summarizePushBody(shortTerm, kind = "tty7")
        assertEquals("$ git status\nnothing to commit", shortSummary.previewText)
        assertFalse(shortSummary.hasExtraOrRichContent)

        val longTerm = "$ bun test\npass 1\npass 2\nAllow tool execution? [y/n]"
        val longSummary = summarizePushBody(longTerm, kind = "tty7")
        assertTrue(longSummary.hasExtraOrRichContent)
        assertTrue(longSummary.previewText.startsWith("$ bun test\npass 1"))
    }
}
