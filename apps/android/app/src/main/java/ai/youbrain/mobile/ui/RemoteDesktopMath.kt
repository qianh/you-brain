package ai.youbrain.mobile.ui

import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

enum class RdInputMode {
    TOUCHPAD,
    DIRECT,
}

data class VideoBox(
    val left: Float,
    val top: Float,
    val width: Float,
    val height: Float,
)

data class NormPoint(
    val x: Float,
    val y: Float,
)

object RemoteDesktopMath {
    /**
     * 计算 `object-fit: contain` 视频在容器中的真实显示矩形（排除上下或左右黑边）。
     */
    fun computeVideoBox(
        containerWidth: Float,
        containerHeight: Float,
        videoWidth: Int,
        videoHeight: Int,
    ): VideoBox {
        if (containerWidth <= 0f || containerHeight <= 0f) {
            return VideoBox(0f, 0f, 1f, 1f)
        }
        if (videoWidth <= 0 || videoHeight <= 0) {
            return VideoBox(0f, 0f, containerWidth, containerHeight)
        }
        val containerRatio = containerWidth / containerHeight
        val videoRatio = videoWidth.toFloat() / videoHeight.toFloat()
        return if (videoRatio > containerRatio) {
            val w = containerWidth
            val h = containerWidth / videoRatio
            VideoBox(left = 0f, top = (containerHeight - h) * 0.5f, width = w, height = h)
        } else {
            val h = containerHeight
            val w = containerHeight * videoRatio
            VideoBox(left = (containerWidth - w) * 0.5f, top = 0f, width = w, height = h)
        }
    }

    /**
     * 直触模式：将屏幕触点（考虑容器中心缩放 `scale` 与平移 `panX`/`panY`）逆变换回远端桌面 `[0, 1]` 归一化坐标。
     */
    fun screenToNormalizedDirect(
        touchX: Float,
        touchY: Float,
        containerWidth: Float,
        containerHeight: Float,
        box: VideoBox,
        scale: Float,
        panX: Float,
        panY: Float,
    ): NormPoint {
        val safeScale = scale.coerceAtLeast(1f)
        val cx = containerWidth * 0.5f
        val cy = containerHeight * 0.5f
        val unscaledX = (touchX - cx - panX) / safeScale + cx
        val unscaledY = (touchY - cy - panY) / safeScale + cy
        val nx = if (box.width > 0f) (unscaledX - box.left) / box.width else 0.5f
        val ny = if (box.height > 0f) (unscaledY - box.top) / box.height else 0.5f
        return NormPoint(
            x = clampUnit(nx),
            y = clampUnit(ny),
        )
    }

    /**
     * 将远端桌面 `[0, 1]` 坐标正变换为当前容器屏幕坐标（用于渲染虚拟光标）。
     */
    fun normalizedToScreen(
        normX: Float,
        normY: Float,
        containerWidth: Float,
        containerHeight: Float,
        box: VideoBox,
        scale: Float,
        panX: Float,
        panY: Float,
    ): Pair<Float, Float> {
        val baseX = box.left + clampUnit(normX) * box.width
        val baseY = box.top + clampUnit(normY) * box.height
        val cx = containerWidth * 0.5f
        val cy = containerHeight * 0.5f
        val sx = (baseX - cx) * scale + cx + panX
        val sy = (baseY - cy) * scale + cy + panY
        return sx to sy
    }

    /**
     * 触控板模式：基于手指位移（dp）计算带平滑速度增益曲线的光标新位置。
     * 慢速微移保持 1:1 精细像素定位，快速滑指自动加速横跨宽屏。
     */
    fun applyTrackpadDelta(
        current: NormPoint,
        deltaXDp: Float,
        deltaYDp: Float,
        referenceWidthDp: Float = 380f,
        aspectRatio: Float = 16f / 9f,
    ): NormPoint {
        val speedDp = hypot(deltaXDp, deltaYDp)
        val gain = (1.0f + min(1.8f, speedDp * 0.085f))
        val refW = max(180f, referenceWidthDp)
        val refH = max(120f, refW / max(0.5f, aspectRatio))
        val nextX = clampUnit(current.x + (deltaXDp * gain) / refW)
        val nextY = clampUnit(current.y + (deltaYDp * gain) / refH)
        return NormPoint(nextX, nextY)
    }

    /**
     * 约束缩放平移边界，防止画面被拖出视口外。
     */
    fun clampPan(
        panX: Float,
        panY: Float,
        containerWidth: Float,
        containerHeight: Float,
        scale: Float,
    ): Pair<Float, Float> {
        if (scale <= 1.001f) return 0f to 0f
        val maxX = containerWidth * (scale - 1f) * 0.5f
        val maxY = containerHeight * (scale - 1f) * 0.5f
        return panX.coerceIn(-maxX, maxX) to panY.coerceIn(-maxY, maxY)
    }

    /**
     * 双指触控板自然滚动：手指上滑（deltaYDp < 0）对应查看下方内容（macOS CGEvent wheel 负值）。
     */
    fun toMacScrollPixels(deltaXDp: Float, deltaYDp: Float): Pair<Int, Int> {
        val dx = (deltaXDp * 2.4f).roundToInt().coerceIn(-1600, 1600)
        val dy = (deltaYDp * 2.4f).roundToInt().coerceIn(-1600, 1600)
        return dx to dy
    }

    fun clampUnit(v: Float): Float {
        if (!v.isFinite()) return 0.5f
        return min(1f, max(0f, v))
    }
}
