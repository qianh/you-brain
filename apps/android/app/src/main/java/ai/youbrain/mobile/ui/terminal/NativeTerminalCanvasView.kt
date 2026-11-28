package ai.youbrain.mobile.ui.terminal

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.text.InputType
import android.util.TypedValue
import android.view.GestureDetector
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import android.widget.OverScroller
import com.termux.terminal.KeyHandler
import com.termux.terminal.TerminalEmulator
import com.termux.terminal.TextStyle
import com.termux.terminal.WcWidth
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

enum class TerminalWidthMode(val fixedCols: Int?, val label: String) {
    FIT(null, "适屏"),
    WIDE_80(80, "80列"),
    WIDE_100(100, "100列"),
}

/**
 * 原生 Android Canvas 终端渲染控件：
 * - 严格按等宽单元格网格绘制，结合 Termux WcWidth 与超出格宽微缩保护，杜绝中英文/Emoji/框线错位。
 * - 原生 OverScroller 60/120fps 惯性纵横滚动 + 双指捏合缩放字号。
 * - 默认单击不弹软键盘（防滑屏误触），按需开启直输键盘模式；长按触发复制菜单。
 */
@SuppressLint("ViewConstructor")
class NativeTerminalCanvasView(
    context: Context,
) : View(context) {

    var session: NativeTerminalSession? = null
        set(value) {
            field = value
            scrollRowOffset = 0
            scrollXPx = 0f
            invalidate()
        }

    var onGridSizeMeasured: ((TerminalGridSize) -> Unit)? = null
    var onFontSizeSpChanged: ((Float) -> Unit)? = null
    var onScrolledUpChanged: ((Boolean) -> Unit)? = null
    var onLongPressMenu: (() -> Unit)? = null

    private var fontSizeSp: Float = 10.5f
    private var widthMode: TerminalWidthMode = TerminalWidthMode.FIT
    private var directKeyboard: Boolean = false
    private var isDark: Boolean = true

    private val bgPaint = Paint()
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.SUBPIXEL_TEXT_FLAG).apply {
        typeface = Typeface.MONOSPACE
    }
    private val cursorPaint = Paint()
    private val scrollIndicatorPaint = Paint(Paint.ANTI_ALIAS_FLAG)

    private var fontWidth: Float = 16f
    private var fontLineSpacing: Int = 32
    private var fontAscent: Float = 24f

    private var padH: Float = dp(6f)
    private var padV: Float = dp(4f)

    /** 距离底部的向上滚动行数（0 = 紧贴最新底部）。 */
    private var scrollRowOffset: Int = 0
    private var verticalRemainderPx: Float = 0f

    /** 宽屏模式下的横向滚动偏移（像素）。 */
    private var scrollXPx: Float = 0f
    private var lastReportedScrolledUp: Boolean = false
    private var lastMeasuredGrid: TerminalGridSize? = null

    private val scroller = OverScroller(context)

    private val flingRunnable = object : Runnable {
        override fun run() {
            if (!scroller.computeScrollOffset()) return
            val currY = scroller.currY
            val currX = scroller.currX
            val maxTranscript = currentMaxTranscriptRows()
            scrollRowOffset = currY.coerceIn(0, maxTranscript)
            scrollXPx = currX.toFloat().coerceIn(0f, maxHorizontalScrollPx())
            reportScrollUpState()
            invalidate()
            if (!scroller.isFinished) {
                postOnAnimation(this)
            }
        }
    }

    private val scaleDetector = ScaleGestureDetector(
        context,
        object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScale(detector: ScaleGestureDetector): Boolean {
                val factor = detector.scaleFactor
                if (factor.isNaN() || factor <= 0f) return false
                val next = (fontSizeSp * factor).coerceIn(8.5f, 20f)
                if (kotlin.math.abs(next - fontSizeSp) >= 0.15f) {
                    setFontSizeSp(next, notify = true)
                }
                return true
            }
        },
    )

    private val gestureDetector = GestureDetector(
        context,
        object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(e: MotionEvent): Boolean {
                if (!scroller.isFinished) {
                    scroller.forceFinished(true)
                    removeCallbacks(flingRunnable)
                }
                verticalRemainderPx = 0f
                return true
            }

            override fun onSingleTapUp(e: MotionEvent): Boolean {
                if (directKeyboard) {
                    showSoftKeyboard()
                }
                return true
            }

            override fun onLongPress(e: MotionEvent) {
                onLongPressMenu?.invoke()
            }

            override fun onScroll(
                e1: MotionEvent?,
                e2: MotionEvent,
                distanceX: Float,
                distanceY: Float,
            ): Boolean {
                // 纵向：手指向下拉（distanceY < 0）增加 scrollRowOffset 查看历史。
                verticalRemainderPx -= distanceY
                val rowHeight = max(1, fontLineSpacing).toFloat()
                val deltaRows = (verticalRemainderPx / rowHeight).toInt()
                if (deltaRows != 0) {
                    verticalRemainderPx -= deltaRows * rowHeight
                    val maxRows = currentMaxTranscriptRows()
                    scrollRowOffset = (scrollRowOffset + deltaRows).coerceIn(0, maxRows)
                    reportScrollUpState()
                }

                // 横向：仅在宽屏模式内容超出屏宽时滚动。
                val maxX = maxHorizontalScrollPx()
                if (maxX > 0f) {
                    scrollXPx = (scrollXPx + distanceX).coerceIn(0f, maxX)
                }
                invalidate()
                return true
            }

            override fun onFling(
                e1: MotionEvent?,
                e2: MotionEvent,
                velocityX: Float,
                velocityY: Float,
            ): Boolean {
                val maxRows = currentMaxTranscriptRows()
                val maxX = maxHorizontalScrollPx().roundToInt()
                val rowVel = (velocityY / max(1, fontLineSpacing).toFloat()).roundToInt()
                val xVel = (-velocityX).roundToInt()
                scroller.fling(
                    scrollXPx.roundToInt(),
                    scrollRowOffset,
                    xVel,
                    rowVel,
                    0,
                    maxX,
                    0,
                    maxRows,
                )
                postOnAnimation(flingRunnable)
                return true
            }
        },
    )

    init {
        isFocusable = true
        isFocusableInTouchMode = true
        updateMetrics()
    }

    private fun dp(value: Float): Float =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, resources.displayMetrics)

    fun setTheme(dark: Boolean) {
        if (isDark == dark) return
        isDark = dark
        invalidate()
    }

    fun setFontSizeSp(sp: Float, notify: Boolean = false) {
        val clamped = sp.coerceIn(8.5f, 20f)
        if (kotlin.math.abs(clamped - fontSizeSp) < 0.05f) return
        fontSizeSp = clamped
        updateMetrics()
        remeasureGridAndNotify()
        scrollXPx = scrollXPx.coerceIn(0f, maxHorizontalScrollPx())
        invalidate()
        if (notify) onFontSizeSpChanged?.invoke(fontSizeSp)
    }

    fun setWidthMode(mode: TerminalWidthMode) {
        if (widthMode == mode) return
        widthMode = mode
        scrollXPx = 0f
        remeasureGridAndNotify()
        invalidate()
    }

    fun setDirectKeyboardEnabled(enabled: Boolean) {
        directKeyboard = enabled
        if (enabled) {
            showSoftKeyboard()
        } else {
            hideSoftKeyboard()
        }
    }

    fun scrollToBottom() {
        scroller.forceFinished(true)
        removeCallbacks(flingRunnable)
        scrollRowOffset = 0
        verticalRemainderPx = 0f
        reportScrollUpState()
        invalidate()
    }

    fun notifyContentChanged(resetToBottom: Boolean) {
        postOnAnimation {
            if (resetToBottom) {
                scrollRowOffset = 0
                verticalRemainderPx = 0f
            } else {
                val maxRows = currentMaxTranscriptRows()
                if (scrollRowOffset > maxRows) scrollRowOffset = maxRows
            }
            reportScrollUpState()
            invalidate()
        }
    }

    private fun showSoftKeyboard() {
        requestFocus()
        val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        imm?.showSoftInput(this, InputMethodManager.SHOW_IMPLICIT)
    }

    private fun hideSoftKeyboard() {
        val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager
        imm?.hideSoftInputFromWindow(windowToken, 0)
        clearFocus()
    }

    private fun updateMetrics() {
        textPaint.textSize = TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_SP,
            fontSizeSp,
            resources.displayMetrics,
        )
        textPaint.typeface = Typeface.MONOSPACE
        val measuredM = textPaint.measureText("M")
        fontWidth = if (measuredM > 1f) measuredM else textPaint.textSize * 0.6f
        val fm = textPaint.fontMetrics
        val rawHeight = fm.descent - fm.ascent
        fontLineSpacing = max(8, ceil(rawHeight * 1.16f).toInt())
        fontAscent = -fm.ascent + (fontLineSpacing - rawHeight) * 0.5f
    }

    private fun computeGridSize(viewW: Int, viewH: Int): TerminalGridSize? {
        val availW = viewW - padH * 2f
        val availH = viewH - padV * 2f
        if (availW <= 0f || availH <= 0f || fontWidth <= 0f || fontLineSpacing <= 0) return null
        val fitCols = floor(availW / fontWidth).toInt().coerceIn(28, 300)
        val cols = widthMode.fixedCols ?: fitCols
        val rows = floor(availH / fontLineSpacing.toFloat()).toInt().coerceIn(8, 160)
        return TerminalGridSize(
            cols = cols,
            rows = rows,
            cellW = max(1, fontWidth.roundToInt()),
            cellH = max(1, fontLineSpacing),
        )
    }

    private fun remeasureGridAndNotify() {
        val grid = computeGridSize(width, height) ?: return
        if (grid != lastMeasuredGrid) {
            lastMeasuredGrid = grid
            onGridSizeMeasured?.invoke(grid)
        }
    }

    private fun currentMaxTranscriptRows(): Int {
        val s = session ?: return 0
        return s.withEmulator { em ->
            if (em.isAlternateBufferActive) 0 else em.screen.activeTranscriptRows
        }
    }

    private fun maxHorizontalScrollPx(): Float {
        val s = session ?: return 0f
        val cols = s.withEmulator { it.mColumns }
        val contentW = cols * fontWidth + padH * 2f
        return max(0f, contentW - width.toFloat())
    }

    private fun reportScrollUpState() {
        val up = scrollRowOffset > 0
        if (up != lastReportedScrolledUp) {
            lastReportedScrolledUp = up
            onScrolledUpChanged?.invoke(up)
        }
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        remeasureGridAndNotify()
        scrollXPx = scrollXPx.coerceIn(0f, maxHorizontalScrollPx())
        invalidate()
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        scaleDetector.onTouchEvent(event)
        if (!scaleDetector.isInProgress) {
            gestureDetector.onTouchEvent(event)
        }
        return true
    }

    override fun onCheckIsTextEditor(): Boolean = directKeyboard

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
        if (!directKeyboard) return null
        outAttrs.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
        outAttrs.imeOptions = EditorInfo.IME_FLAG_NO_FULLSCREEN or EditorInfo.IME_FLAG_NO_EXTRACT_UI
        return object : BaseInputConnection(this, false) {
            override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
                val str = text?.toString().orEmpty()
                if (str.isNotEmpty()) {
                    session?.sendBytes(str.replace("\n", "\r").toByteArray(Charsets.UTF_8))
                }
                return true
            }

            override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
                if (beforeLength > 0) {
                    val dels = ByteArray(beforeLength) { 0x7F }
                    session?.sendBytes(dels)
                }
                return true
            }

            override fun sendKeyEvent(event: KeyEvent): Boolean {
                if (event.action == KeyEvent.ACTION_DOWN) {
                    return handleDirectKeyDown(event.keyCode, event)
                }
                return true
            }
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (directKeyboard && handleDirectKeyDown(keyCode, event)) return true
        return super.onKeyDown(keyCode, event)
    }

    private fun handleDirectKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        val s = session ?: return false
        val appCursor = s.withEmulator { it.isCursorKeysApplicationMode }
        val appKeypad = s.withEmulator { it.isKeypadApplicationMode }
        var keyMod = 0
        if (event.isCtrlPressed) keyMod = keyMod or KeyHandler.KEYMOD_CTRL
        if (event.isAltPressed) keyMod = keyMod or KeyHandler.KEYMOD_ALT
        if (event.isShiftPressed) keyMod = keyMod or KeyHandler.KEYMOD_SHIFT

        val mapped = KeyHandler.getCode(keyCode, keyMod, appCursor, appKeypad)
        if (mapped != null) {
            s.sendBytes(mapped.toByteArray(Charsets.UTF_8))
            return true
        }
        val unicode = event.unicodeChar
        if (unicode != 0) {
            val str = String(Character.toChars(unicode))
            s.sendBytes(str.toByteArray(Charsets.UTF_8))
            return true
        }
        return false
    }

    override fun onDraw(canvas: Canvas) {
        val defaultBg = if (isDark) NativeTerminalSession.DARK_BG else NativeTerminalSession.LIGHT_BG
        canvas.drawColor(defaultBg)

        val s = session ?: return
        s.withEmulator { em ->
            val screen = em.screen
            val palette = em.mColors.mCurrentColors
            val rows = em.mRows
            val cols = em.mColumns
            if (rows <= 0 || cols <= 0) return@withEmulator

            val activeTranscript = if (em.isAlternateBufferActive) 0 else screen.activeTranscriptRows
            val clampedOffset = scrollRowOffset.coerceIn(0, activeTranscript)
            scrollRowOffset = clampedOffset
            val topRow = -clampedOffset

            val reverseVideo = em.isReverseVideo
            val cursorRow = em.cursorRow
            val cursorCol = em.cursorCol
            val cursorVisible = em.shouldCursorBeVisible() && clampedOffset == 0
            val cursorStyle = em.cursorStyle

            val baseBgColor = resolveColor(TextStyle.COLOR_INDEX_BACKGROUND, palette)
            val baseFgColor = resolveColor(TextStyle.COLOR_INDEX_FOREGROUND, palette)
            val cursorColor = resolveColor(TextStyle.COLOR_INDEX_CURSOR, palette)

            canvas.save()
            canvas.translate(padH - scrollXPx, padV)

            val viewVisibleColsStart = max(0, floor((scrollXPx - padH) / fontWidth).toInt() - 1)
            val viewVisibleColsEnd = min(cols, ceil((scrollXPx + width) / fontWidth).toInt() + 1)

            for (screenRow in 0 until rows) {
                val externalRow = topRow + screenRow
                val internalRow = screen.externalToInternalRow(externalRow)
                val lineObj = screen.allocateFullLineIfNecessary(internalRow)
                val lineChars = lineObj.mText
                val spaceUsed = lineObj.spaceUsed

                val rowTopY = (screenRow * fontLineSpacing).toFloat()
                val rowBottomY = rowTopY + fontLineSpacing
                val baselineY = rowTopY + fontAscent

                // Pass 1: 合并连续相同背景色并绘制。
                var bgRunStart = -1
                var bgRunColor = 0
                for (col in viewVisibleColsStart until viewVisibleColsEnd) {
                    val style = lineObj.getStyle(col)
                    val effect = TextStyle.decodeEffect(style)
                    var fg = resolveColor(TextStyle.decodeForeColor(style), palette)
                    var bg = resolveColor(TextStyle.decodeBackColor(style), palette)
                    val inverse = ((effect and TextStyle.CHARACTER_ATTRIBUTE_INVERSE) != 0) xor reverseVideo
                    if (inverse) {
                        val tmp = fg
                        fg = bg
                        bg = tmp
                    }
                    val needsBg = bg != baseBgColor
                    if (needsBg) {
                        if (bgRunStart == -1) {
                            bgRunStart = col
                            bgRunColor = bg
                        } else if (bg != bgRunColor) {
                            bgPaint.color = bgRunColor
                            canvas.drawRect(bgRunStart * fontWidth, rowTopY, col * fontWidth, rowBottomY, bgPaint)
                            bgRunStart = col
                            bgRunColor = bg
                        }
                    } else if (bgRunStart != -1) {
                        bgPaint.color = bgRunColor
                        canvas.drawRect(bgRunStart * fontWidth, rowTopY, col * fontWidth, rowBottomY, bgPaint)
                        bgRunStart = -1
                    }
                }
                if (bgRunStart != -1) {
                    bgPaint.color = bgRunColor
                    canvas.drawRect(bgRunStart * fontWidth, rowTopY, viewVisibleColsEnd * fontWidth, rowBottomY, bgPaint)
                }

                // 光标绘制（Block / Underline / Bar）。
                val rowHasCursor = cursorVisible && externalRow == cursorRow && cursorCol in 0 until cols
                if (rowHasCursor) {
                    val cx = cursorCol * fontWidth
                    cursorPaint.color = cursorColor
                    when (cursorStyle) {
                        TerminalEmulator.TERMINAL_CURSOR_STYLE_UNDERLINE -> {
                            val h = max(2f, fontLineSpacing * 0.12f)
                            canvas.drawRect(cx, rowBottomY - h, cx + fontWidth, rowBottomY, cursorPaint)
                        }
                        TerminalEmulator.TERMINAL_CURSOR_STYLE_BAR -> {
                            val w = max(2f, fontWidth * 0.18f)
                            canvas.drawRect(cx, rowTopY, cx + w, rowBottomY, cursorPaint)
                        }
                        else -> {
                            canvas.drawRect(cx, rowTopY, cx + fontWidth, rowBottomY, cursorPaint)
                        }
                    }
                }

                // Pass 2: 绘制字符（纯 ASCII 连续 run 合批 + 宽字符/非 ASCII 严格按列锚定防错位）。
                var col = viewVisibleColsStart
                while (col < viewVisibleColsEnd) {
                    val startIdx = lineObj.findStartOfColumn(col)
                    if (startIdx >= spaceUsed) break

                    val style = lineObj.getStyle(col)
                    val effect = TextStyle.decodeEffect(style)
                    val firstChar = lineChars[startIdx]
                    val highSurrogate = Character.isHighSurrogate(firstChar) && startIdx + 1 < spaceUsed
                    val codePoint = if (highSurrogate) {
                        Character.toCodePoint(firstChar, lineChars[startIdx + 1])
                    } else {
                        firstChar.code
                    }
                    val charCols = max(1, WcWidth.width(codePoint))

                    // 计算当前单元格包含的所有 char（含代理对与后续零宽组合字符）。
                    var cellEnd = startIdx + if (highSurrogate) 2 else 1
                    while (cellEnd < spaceUsed) {
                        val nc = lineChars[cellEnd]
                        val nHigh = Character.isHighSurrogate(nc) && cellEnd + 1 < spaceUsed
                        val nCp = if (nHigh) Character.toCodePoint(nc, lineChars[cellEnd + 1]) else nc.code
                        if (WcWidth.width(nCp) > 0) break
                        cellEnd += if (nHigh) 2 else 1
                    }

                    val invisible = (effect and TextStyle.CHARACTER_ATTRIBUTE_INVISIBLE) != 0
                    if (invisible || (codePoint == ' '.code && cellEnd == startIdx + 1 &&
                            (effect and (TextStyle.CHARACTER_ATTRIBUTE_UNDERLINE or TextStyle.CHARACTER_ATTRIBUTE_STRIKETHROUGH)) == 0)
                    ) {
                        col += charCols
                        continue
                    }

                    val isBlockCursorHere = rowHasCursor && col == cursorCol &&
                        cursorStyle == TerminalEmulator.TERMINAL_CURSOR_STYLE_BLOCK
                    val fgColor = resolveFinalForeground(style, effect, reverseVideo, isBlockCursorHere, baseFgColor, baseBgColor, palette)
                    applyTextPaintStyle(effect, fgColor)

                    val isSimpleAscii = codePoint in 32..126 && charCols == 1 && cellEnd == startIdx + 1 && !isBlockCursorHere
                    if (isSimpleAscii) {
                        // 向右合并同样式、无光标、纯 ASCII 单宽字符，减少 drawText 调用次数。
                        var runEndCol = col + 1
                        var runEndIdx = cellEnd
                        while (runEndCol < viewVisibleColsEnd && runEndIdx < spaceUsed) {
                            if (rowHasCursor && runEndCol == cursorCol && cursorStyle == TerminalEmulator.TERMINAL_CURSOR_STYLE_BLOCK) break
                            if (lineObj.getStyle(runEndCol) != style) break
                            val nextIdx = lineObj.findStartOfColumn(runEndCol)
                            if (nextIdx != runEndIdx || nextIdx >= spaceUsed) break
                            val c = lineChars[nextIdx]
                            if (c.code !in 32..126) break
                            // 确保后面没有零宽组合字符。
                            if (nextIdx + 1 < spaceUsed) {
                                val peek = lineChars[nextIdx + 1]
                                val pHigh = Character.isHighSurrogate(peek) && nextIdx + 2 < spaceUsed
                                val pCp = if (pHigh) Character.toCodePoint(peek, lineChars[nextIdx + 2]) else peek.code
                                if (WcWidth.width(pCp) <= 0) break
                            }
                            runEndCol += 1
                            runEndIdx += 1
                        }
                        val x = col * fontWidth
                        canvas.drawText(lineChars, startIdx, runEndIdx - startIdx, x, baselineY, textPaint)
                        drawDecorations(canvas, effect, x, (runEndCol - col) * fontWidth, rowTopY, rowBottomY, baselineY)
                        col = runEndCol
                    } else {
                        // 非 ASCII / 中文 / Emoji / 框线符号：严格锚定在 col * fontWidth，必要时水平适配目标格宽。
                        val x = col * fontWidth
                        val targetWidth = charCols * fontWidth
                        val len = cellEnd - startIdx
                        val actualWidth = textPaint.measureText(lineChars, startIdx, len)
                        if (actualWidth > targetWidth * 1.03f && actualWidth > 0f) {
                            val scaleX = targetWidth / actualWidth
                            canvas.save()
                            canvas.scale(scaleX, 1f, x, baselineY)
                            canvas.drawText(lineChars, startIdx, len, x, baselineY, textPaint)
                            canvas.restore()
                        } else {
                            canvas.drawText(lineChars, startIdx, len, x, baselineY, textPaint)
                        }
                        drawDecorations(canvas, effect, x, targetWidth, rowTopY, rowBottomY, baselineY)
                        col += charCols
                    }
                }
            }

            canvas.restore()

            // 宽屏模式下底部绘制柔和水平滚动进度条。
            val maxX = maxHorizontalScrollPx()
            if (maxX > 1f) {
                val trackW = width - dp(24f)
                val ratio = (width.toFloat() / (width.toFloat() + maxX)).coerceIn(0.15f, 0.9f)
                val thumbW = trackW * ratio
                val progress = (scrollXPx / maxX).coerceIn(0f, 1f)
                val left = dp(12f) + (trackW - thumbW) * progress
                val barH = dp(2.5f)
                scrollIndicatorPaint.color = if (isDark) 0x55FFFFFF else 0x44000000
                canvas.drawRoundRect(
                    left,
                    height - barH - dp(2f),
                    left + thumbW,
                    height - dp(2f),
                    barH,
                    barH,
                    scrollIndicatorPaint,
                )
            }
        }
    }

    private fun resolveColor(encoded: Int, palette: IntArray): Int {
        if ((encoded and 0xFF000000.toInt()) == 0xFF000000.toInt()) return encoded
        return if (encoded in palette.indices) palette[encoded] else palette[TextStyle.COLOR_INDEX_FOREGROUND]
    }

    private fun resolveFinalForeground(
        style: Long,
        effect: Int,
        reverseVideo: Boolean,
        isBlockCursor: Boolean,
        baseFg: Int,
        baseBg: Int,
        palette: IntArray,
    ): Int {
        if (isBlockCursor) return baseBg
        var rawFore = TextStyle.decodeForeColor(style)
        val rawBack = TextStyle.decodeBackColor(style)
        val bold = (effect and TextStyle.CHARACTER_ATTRIBUTE_BOLD) != 0
        if (bold && rawFore in 0..7) {
            rawFore += 8
        }
        var fg = resolveColor(rawFore, palette)
        val bg = resolveColor(rawBack, palette)
        val inverse = ((effect and TextStyle.CHARACTER_ATTRIBUTE_INVERSE) != 0) xor reverseVideo
        if (inverse) fg = bg
        if ((effect and TextStyle.CHARACTER_ATTRIBUTE_DIM) != 0) {
            fg = Color.argb(170, Color.red(fg), Color.green(fg), Color.blue(fg))
        }
        return if (fg == 0) baseFg else fg
    }

    private fun applyTextPaintStyle(effect: Int, fgColor: Int) {
        textPaint.color = fgColor
        textPaint.isFakeBoldText = (effect and TextStyle.CHARACTER_ATTRIBUTE_BOLD) != 0
        textPaint.textSkewX = if ((effect and TextStyle.CHARACTER_ATTRIBUTE_ITALIC) != 0) -0.22f else 0f
    }

    private fun drawDecorations(
        canvas: Canvas,
        effect: Int,
        x: Float,
        widthPx: Float,
        rowTopY: Float,
        rowBottomY: Float,
        baselineY: Float,
    ) {
        if ((effect and TextStyle.CHARACTER_ATTRIBUTE_UNDERLINE) != 0) {
            val y = min(rowBottomY - 1f, baselineY + max(1.5f, fontLineSpacing * 0.08f))
            textPaint.strokeWidth = max(1f, fontLineSpacing * 0.06f)
            canvas.drawLine(x, y, x + widthPx, y, textPaint)
        }
        if ((effect and TextStyle.CHARACTER_ATTRIBUTE_STRIKETHROUGH) != 0) {
            val y = rowTopY + fontLineSpacing * 0.52f
            textPaint.strokeWidth = max(1f, fontLineSpacing * 0.06f)
            canvas.drawLine(x, y, x + widthPx, y, textPaint)
        }
    }
}
