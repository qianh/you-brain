package ai.youbrain.mobile

import ai.youbrain.mobile.ui.NormPoint
import ai.youbrain.mobile.ui.RemoteDesktopMath
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteDesktopMathTest {
    @Test
    fun computeVideoBoxHandlesLetterboxAndPillarbox() {
        // 16:9 video in portrait 1080x1920 container -> letterbox top/bottom
        val portrait = RemoteDesktopMath.computeVideoBox(1080f, 1920f, 1920, 1080)
        assertEquals(0f, portrait.left, 0.01f)
        assertEquals(1080f, portrait.width, 0.01f)
        assertEquals(607.5f, portrait.height, 0.01f)
        assertEquals((1920f - 607.5f) * 0.5f, portrait.top, 0.01f)

        // 4:3 video in 2400x1080 ultrawide landscape phone -> pillarbox left/right
        val landscape = RemoteDesktopMath.computeVideoBox(2400f, 1080f, 1440, 1080)
        assertEquals(0f, landscape.top, 0.01f)
        assertEquals(1080f, landscape.height, 0.01f)
        assertEquals(1440f, landscape.width, 0.01f)
        assertEquals(480f, landscape.left, 0.01f)
    }

    @Test
    fun directTouchRoundTripsWithZoomAndPan() {
        val cw = 1080f
        val ch = 2200f
        val box = RemoteDesktopMath.computeVideoBox(cw, ch, 1920, 1080)
        val scale = 2.4f
        val (panX, panY) = RemoteDesktopMath.clampPan(180f, -260f, cw, ch, scale)

        val target = NormPoint(0.28f, 0.74f)
        val (sx, sy) = RemoteDesktopMath.normalizedToScreen(
            normX = target.x,
            normY = target.y,
            containerWidth = cw,
            containerHeight = ch,
            box = box,
            scale = scale,
            panX = panX,
            panY = panY,
        )
        val recovered = RemoteDesktopMath.screenToNormalizedDirect(
            touchX = sx,
            touchY = sy,
            containerWidth = cw,
            containerHeight = ch,
            box = box,
            scale = scale,
            panX = panX,
            panY = panY,
        )
        assertEquals(target.x, recovered.x, 1e-4f)
        assertEquals(target.y, recovered.y, 1e-4f)
    }

    @Test
    fun trackpadBallisticGainAcceleratesFastSwipesAndClamps() {
        val origin = NormPoint(0.5f, 0.5f)
        val slow = RemoteDesktopMath.applyTrackpadDelta(origin, deltaXDp = 2f, deltaYDp = 0f, referenceWidthDp = 380f)
        val fast = RemoteDesktopMath.applyTrackpadDelta(origin, deltaXDp = 20f, deltaYDp = 0f, referenceWidthDp = 380f)

        val slowStepPerDp = (slow.x - 0.5f) / 2f
        val fastStepPerDp = (fast.x - 0.5f) / 20f
        assertTrue("Fast swipe should have higher per-dp gain than slow nudge", fastStepPerDp > slowStepPerDp)

        val clamped = RemoteDesktopMath.applyTrackpadDelta(origin, deltaXDp = -9999f, deltaYDp = 9999f)
        assertEquals(0f, clamped.x, 1e-6f)
        assertEquals(1f, clamped.y, 1e-6f)
    }

    @Test
    fun clampPanAndScrollPixelsStayWithinBounds() {
        assertEquals(0f to 0f, RemoteDesktopMath.clampPan(120f, -80f, 1000f, 800f, 1.0f))
        assertEquals(500f to -400f, RemoteDesktopMath.clampPan(999f, -999f, 1000f, 800f, 2.0f))

        val (dx, dy) = RemoteDesktopMath.toMacScrollPixels(10f, -25f)
        assertEquals(24, dx)
        assertEquals(-60, dy)
    }
}
