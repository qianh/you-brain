package ai.youbrain.mobile

import ai.youbrain.mobile.ui.ClipboardChunkAssembler
import ai.youbrain.mobile.ui.chunkClipboardText
import ai.youbrain.mobile.ui.expandKeyCombo
import ai.youbrain.mobile.ui.formatTransferBytes
import ai.youbrain.mobile.ui.rdReconnectDelayMs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteDesktopInputTest {
    @Test
    fun chunkTextKeepsSurrogatePairs() {
        val text = "a".repeat(4) + "😀" + "b".repeat(5)
        val parts = chunkClipboardText(text, 5)
        assertEquals(text, parts.joinToString(""))
        parts.forEach { part ->
            assertFalse(part.isNotEmpty() && Character.isHighSurrogate(part.last()))
        }
        assertEquals(listOf("short"), chunkClipboardText("short", 10))
    }

    @Test
    fun assemblerJoinsOutOfOrderChunks() {
        val asm = ClipboardChunkAssembler()
        assertEquals("plain", asm.push("plain", null, null, null))
        assertNull(asm.push("c", "x", 2, 3))
        assertNull(asm.push("a", "x", 0, 3))
        assertNull(asm.push("a", "x", 0, 3))
        assertEquals("abc", asm.push("b", "x", 1, 3))
        // 新批次覆盖未完成的旧批次
        assertNull(asm.push("1", "y", 0, 2))
        assertNull(asm.push("q", "z", 0, 2))
        assertEquals("qr", asm.push("r", "z", 1, 2))
    }

    @Test
    fun keyComboPressesInOrderAndReleasesInReverse() {
        val events = expandKeyCombo(listOf("MetaLeft", "ShiftLeft", "Digit5"))
        assertEquals(listOf("MetaLeft", "ShiftLeft", "Digit5", "Digit5", "ShiftLeft", "MetaLeft"), events.map { it.code })
        assertEquals(listOf(true, true, true, false, false, false), events.map { it.down })
        val digitDown = events[2]
        assertTrue(digitDown.meta && digitDown.shift && !digitDown.ctrl && !digitDown.alt)
        val shiftUp = events[4]
        assertTrue(shiftUp.meta && !shiftUp.shift)
        val metaUp = events[5]
        assertFalse(metaUp.meta)
    }

    @Test
    fun reconnectBackoffCapsAtEightSeconds() {
        assertEquals(500L, rdReconnectDelayMs(1))
        assertEquals(1_000L, rdReconnectDelayMs(2))
        assertEquals(8_000L, rdReconnectDelayMs(5))
        assertEquals(8_000L, rdReconnectDelayMs(30))
    }

    @Test
    fun formatsBytes() {
        assertEquals("512 B", formatTransferBytes(512))
        assertEquals("2 KB", formatTransferBytes(2048))
        assertEquals("1.5 MB", formatTransferBytes(1_572_864))
    }
}
