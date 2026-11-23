package ai.youbrain.mobile.ui.markdown

private const val MAX_NESTING_DEPTH = 8

enum class TableAlignment {
    START,
    CENTER,
    END,
}

sealed interface MarkdownInline {
    data class Text(val text: String) : MarkdownInline
    data class Bold(val children: List<MarkdownInline>) : MarkdownInline
    data class Italic(val children: List<MarkdownInline>) : MarkdownInline
    data class Strikethrough(val children: List<MarkdownInline>) : MarkdownInline
    data class Code(val code: String) : MarkdownInline
    data class Link(val label: List<MarkdownInline>, val url: String) : MarkdownInline
    data object LineBreak : MarkdownInline
}

data class MarkdownListItem(
    val checked: Boolean? = null,
    val blocks: List<MarkdownBlock>,
)

sealed interface MarkdownBlock {
    data class Heading(val level: Int, val inlines: List<MarkdownInline>) : MarkdownBlock
    data class Paragraph(val inlines: List<MarkdownInline>) : MarkdownBlock
    data class CodeBlock(val language: String?, val code: String) : MarkdownBlock
    data class BlockQuote(val blocks: List<MarkdownBlock>) : MarkdownBlock
    data class BulletList(val items: List<MarkdownListItem>) : MarkdownBlock
    data class OrderedList(val startNumber: Int, val items: List<MarkdownListItem>) : MarkdownBlock
    data class Table(
        val headers: List<List<MarkdownInline>>,
        val alignments: List<TableAlignment>,
        val rows: List<List<List<MarkdownInline>>>,
    ) : MarkdownBlock
    data object ThematicBreak : MarkdownBlock
}

fun parseMarkdown(markdown: String): List<MarkdownBlock> {
    if (markdown.isBlank()) return emptyList()
    val normalized = markdown.replace("\r\n", "\n").replace('\r', '\n')
    return parseBlocks(normalized.lines(), depth = 0)
}

fun computeTableColumnWidths(
    naturalWidths: IntArray,
    availableWidthPx: Int,
    minColPx: Int,
    maxColPx: Int,
    comfortableMinPx: Int,
): IntArray {
    if (naturalWidths.isEmpty()) return IntArray(0)
    val safeAvail = availableWidthPx.coerceAtLeast(1)
    val safeMin = minColPx.coerceAtLeast(1)
    val safeMax = maxOf(safeMin, maxColPx)
    val clamped = IntArray(naturalWidths.size) { idx ->
        naturalWidths[idx].coerceIn(safeMin, safeMax)
    }
    if (clamped.size == 1) {
        val singleMin = safeMin.coerceAtMost(safeAvail)
        return intArrayOf(clamped[0].coerceIn(singleMin, safeAvail))
    }
    if (clamped.sum() <= safeAvail) {
        return clamped
    }
    if (clamped.size <= 3) {
        val result = IntArray(clamped.size)
        var lockedSum = 0
        val flexIndices = mutableListOf<Int>()
        for (idx in clamped.indices) {
            if (clamped[idx] <= comfortableMinPx) {
                result[idx] = clamped[idx]
                lockedSum += clamped[idx]
            } else {
                flexIndices.add(idx)
            }
        }
        val remaining = safeAvail - lockedSum
        if (flexIndices.isNotEmpty() && remaining > 0) {
            val flexSum = flexIndices.sumOf { clamped[it] }.coerceAtLeast(1)
            var assigned = 0
            var widestIdx = flexIndices[0]
            for (idx in flexIndices) {
                if (clamped[idx] > clamped[widestIdx]) widestIdx = idx
            }
            for (idx in flexIndices) {
                val share = (remaining.toLong() * clamped[idx] / flexSum).toInt()
                result[idx] = share
                assigned += share
            }
            result[widestIdx] += (remaining - assigned)
            if (flexIndices.all { result[it] >= comfortableMinPx }) {
                return result
            }
        }
    }
    return clamped
}

private data class FenceOpener(
    val fenceChar: Char,
    val fenceLen: Int,
    val indent: Int,
    val language: String?,
)

private data class ListMarker(
    val isOrdered: Boolean,
    val number: Int,
    val delimiter: Char,
    val leadingSpaces: Int,
    val contentStartIndex: Int,
)

private fun parseBlocks(lines: List<String>, depth: Int): List<MarkdownBlock> {
    if (lines.isEmpty()) return emptyList()
    if (depth >= MAX_NESTING_DEPTH) {
        val fallback = lines.joinToString("\n").trim()
        return if (fallback.isEmpty()) emptyList()
        else listOf(MarkdownBlock.Paragraph(parseInlines(fallback, depth)))
    }

    val blocks = mutableListOf<MarkdownBlock>()
    var i = 0
    while (i < lines.size) {
        val line = lines[i]
        if (line.isBlank()) {
            i++
            continue
        }

        // 1. Fenced code block
        val fence = parseFenceOpener(line)
        if (fence != null) {
            val codeLines = mutableListOf<String>()
            i++
            while (i < lines.size) {
                if (isFenceCloser(lines[i], fence.fenceChar, fence.fenceLen)) {
                    i++
                    break
                }
                codeLines.add(stripUpToSpaces(lines[i], fence.indent))
                i++
            }
            blocks.add(MarkdownBlock.CodeBlock(fence.language, codeLines.joinToString("\n")))
            continue
        }

        // 2. ATX Heading
        val heading = parseHeading(line)
        if (heading != null) {
            blocks.add(MarkdownBlock.Heading(heading.first, parseInlines(heading.second, depth)))
            i++
            continue
        }

        // 3. GFM Table (header + delimiter row)
        if (i + 1 < lines.size && canStartTable(lines[i], lines[i + 1])) {
            val tableResult = parseTable(lines, i, depth)
            if (tableResult != null) {
                blocks.add(tableResult.first)
                i = tableResult.second
                continue
            }
        }

        // 4. Thematic break (check before bullet list so "---" or "* * *" isn't a bullet)
        if (isThematicBreak(line)) {
            blocks.add(MarkdownBlock.ThematicBreak)
            i++
            continue
        }

        // 5. Blockquote
        if (isBlockQuoteLine(line)) {
            val innerLines = mutableListOf<String>()
            while (i < lines.size && isBlockQuoteLine(lines[i])) {
                innerLines.add(stripBlockQuotePrefix(lines[i]))
                i++
            }
            blocks.add(MarkdownBlock.BlockQuote(parseBlocks(innerLines, depth + 1)))
            continue
        }

        // 6. Bullet or Ordered List
        val listMarker = parseListMarker(line)
        if (listMarker != null) {
            val listResult = parseList(lines, i, listMarker, depth)
            blocks.add(listResult.first)
            i = listResult.second
            continue
        }

        // 7. Paragraph
        val paraLines = mutableListOf<String>()
        while (i < lines.size) {
            val cur = lines[i]
            if (cur.isBlank()) break
            if (paraLines.isNotEmpty()) {
                if (parseFenceOpener(cur) != null ||
                    parseHeading(cur) != null ||
                    isThematicBreak(cur) ||
                    isBlockQuoteLine(cur) ||
                    parseListMarker(cur) != null ||
                    (i + 1 < lines.size && canStartTable(cur, lines[i + 1]))
                ) {
                    break
                }
            }
            paraLines.add(cur)
            i++
        }
        if (paraLines.isNotEmpty()) {
            blocks.add(MarkdownBlock.Paragraph(parseParagraphLines(paraLines, depth)))
        }
    }
    return blocks
}

private fun parseParagraphLines(paraLines: List<String>, depth: Int): List<MarkdownInline> {
    if (paraLines.size == 1) {
        return parseInlines(paraLines[0].trimStart(), depth)
    }
    val combined = buildString {
        paraLines.forEachIndexed { idx, raw ->
            val line = raw.trimStart()
            val cleaned = if (idx < paraLines.lastIndex) stripHardBreakSuffix(line) else line
            append(cleaned)
            if (idx < paraLines.lastIndex) append('\n')
        }
    }
    return parseInlines(combined, depth)
}

private fun stripHardBreakSuffix(line: String): String {
    if (line.endsWith("  ")) {
        return line.trimEnd(' ')
    }
    if (line.endsWith("\\") && !isEscaped(line, line.length - 1)) {
        return line.dropLast(1)
    }
    return line
}

private fun countLeadingSpaces(line: String): Int {
    var count = 0
    while (count < line.length && line[count] == ' ') count++
    return count
}

private fun stripUpToSpaces(line: String, maxSpaces: Int): String {
    var idx = 0
    while (idx < line.length && idx < maxSpaces && line[idx] == ' ') idx++
    return line.substring(idx)
}

private fun parseFenceOpener(line: String): FenceOpener? {
    val indent = countLeadingSpaces(line)
    if (indent > 3 || indent >= line.length) return null
    val ch = line[indent]
    if (ch != '`' && ch != '~') return null
    var len = 0
    while (indent + len < line.length && line[indent + len] == ch) len++
    if (len < 3) return null
    val rest = line.substring(indent + len)
    if (ch == '`' && rest.contains('`')) return null
    val lang = rest.trim().split(' ', '\t').firstOrNull()?.takeIf { it.isNotEmpty() }
    return FenceOpener(fenceChar = ch, fenceLen = len, indent = indent, language = lang)
}

private fun isFenceCloser(line: String, fenceChar: Char, minLen: Int): Boolean {
    val indent = countLeadingSpaces(line)
    if (indent > 3 || indent >= line.length) return false
    var len = 0
    while (indent + len < line.length && line[indent + len] == fenceChar) len++
    if (len < minLen) return false
    for (idx in (indent + len) until line.length) {
        val c = line[idx]
        if (c != ' ' && c != '\t') return false
    }
    return true
}

private fun parseHeading(line: String): Pair<Int, String>? {
    val indent = countLeadingSpaces(line)
    if (indent > 3 || indent >= line.length || line[indent] != '#') return null
    var level = 0
    while (indent + level < line.length && line[indent + level] == '#' && level <= 6) {
        level++
    }
    if (level !in 1..6) return null
    val afterHashIdx = indent + level
    if (afterHashIdx < line.length) {
        val next = line[afterHashIdx]
        if (next != ' ' && next != '\t') return null
    }
    var content = line.substring(afterHashIdx).trim()
    if (content.isNotEmpty() && content.endsWith('#')) {
        var end = content.length
        while (end > 0 && content[end - 1] == '#') end--
        if (end == 0) {
            content = ""
        } else if (content[end - 1] == ' ' || content[end - 1] == '\t') {
            content = content.substring(0, end).trimEnd()
        }
    }
    return level to content
}

private fun isThematicBreak(line: String): Boolean {
    val indent = countLeadingSpaces(line)
    if (indent > 3 || indent >= line.length) return false
    val marker = line[indent]
    if (marker != '-' && marker != '*' && marker != '_') return false
    var count = 0
    for (idx in indent until line.length) {
        when (val c = line[idx]) {
            marker -> count++
            ' ', '\t' -> Unit
            else -> return false
        }
    }
    return count >= 3
}

private fun isBlockQuoteLine(line: String): Boolean {
    val indent = countLeadingSpaces(line)
    return indent <= 3 && indent < line.length && line[indent] == '>'
}

private fun stripBlockQuotePrefix(line: String): String {
    val indent = countLeadingSpaces(line)
    var idx = indent + 1
    if (idx < line.length && (line[idx] == ' ' || line[idx] == '\t')) idx++
    return line.substring(idx)
}

private fun hasUnescapedPipe(line: String): Boolean {
    for (idx in line.indices) {
        if (line[idx] == '|' && !isEscaped(line, idx)) return true
    }
    return false
}

private fun canStartTable(headerLine: String, delimiterLine: String): Boolean {
    if (parseFenceOpener(headerLine) != null ||
        parseHeading(headerLine) != null ||
        isBlockQuoteLine(headerLine) ||
        isThematicBreak(headerLine)
    ) {
        return false
    }
    return hasUnescapedPipe(headerLine) && hasUnescapedPipe(delimiterLine)
}

private fun parseTable(
    lines: List<String>,
    startIndex: Int,
    depth: Int,
): Pair<MarkdownBlock.Table, Int>? {
    val alignments = parseTableDelimiterRow(lines[startIndex + 1]) ?: return null
    val headerCellsRaw = splitTableRow(lines[startIndex])
    if (headerCellsRaw.isEmpty() || headerCellsRaw.size != alignments.size) return null

    val headers = headerCellsRaw.map { parseInlines(it, depth) }
    val rows = mutableListOf<List<List<MarkdownInline>>>()
    var i = startIndex + 2
    while (i < lines.size) {
        val line = lines[i]
        if (line.isBlank() ||
            parseFenceOpener(line) != null ||
            parseHeading(line) != null ||
            isBlockQuoteLine(line) ||
            isThematicBreak(line) ||
            parseListMarker(line) != null ||
            !hasUnescapedPipe(line)
        ) {
            break
        }
        val rawCells = splitTableRow(line)
        val normalizedRow = List(headers.size) { colIdx ->
            val raw = rawCells.getOrNull(colIdx)
            if (raw.isNullOrEmpty()) emptyList() else parseInlines(raw, depth)
        }
        rows.add(normalizedRow)
        i++
    }
    return MarkdownBlock.Table(headers = headers, alignments = alignments, rows = rows) to i
}

private fun parseTableDelimiterRow(line: String): List<TableAlignment>? {
    if (!hasUnescapedPipe(line)) return null
    val cells = splitTableRow(line)
    if (cells.isEmpty()) return null
    val alignments = ArrayList<TableAlignment>(cells.size)
    for (cell in cells) {
        if (cell.isEmpty()) return null
        val startsColon = cell.startsWith(':')
        val endsColon = cell.endsWith(':')
        val dashStart = if (startsColon) 1 else 0
        val dashEnd = if (endsColon) cell.length - 1 else cell.length
        if (dashEnd <= dashStart) return null
        for (k in dashStart until dashEnd) {
            if (cell[k] != '-') return null
        }
        val alignment = when {
            startsColon && endsColon -> TableAlignment.CENTER
            endsColon -> TableAlignment.END
            else -> TableAlignment.START
        }
        alignments.add(alignment)
    }
    return alignments
}

private fun splitTableRow(line: String): List<String> {
    val trimmed = line.trim()
    if (trimmed.isEmpty()) return emptyList()
    val start = if (trimmed.startsWith('|')) 1 else 0
    val end = if (trimmed.length > start && trimmed[trimmed.length - 1] == '|' && !isEscaped(trimmed, trimmed.length - 1)) {
        trimmed.length - 1
    } else {
        trimmed.length
    }
    val cells = mutableListOf<String>()
    val current = StringBuilder()
    var i = start
    while (i < end) {
        val c = trimmed[i]
        if (c == '\\' && i + 1 < end) {
            val next = trimmed[i + 1]
            if (next == '|') {
                current.append('|')
                i += 2
                continue
            }
            if (next == '\\') {
                current.append("\\\\")
                i += 2
                continue
            }
        }
        if (c == '`') {
            var tickLen = 0
            while (i + tickLen < end && trimmed[i + tickLen] == '`') tickLen++
            val closeIdx = findClosingBackticks(trimmed, i + tickLen, end, tickLen)
            if (closeIdx != -1) {
                current.append(trimmed, i, closeIdx + tickLen)
                i = closeIdx + tickLen
                continue
            }
            current.append(trimmed, i, i + tickLen)
            i += tickLen
            continue
        }
        if (c == '|') {
            cells.add(current.toString().trim())
            current.clear()
            i++
            continue
        }
        current.append(c)
        i++
    }
    cells.add(current.toString().trim())
    return cells
}

private fun parseListMarker(line: String): ListMarker? {
    val indent = countLeadingSpaces(line)
    if (indent > 3 || indent >= line.length) return null
    val ch = line[indent]
    if (ch == '-' || ch == '*' || ch == '+') {
        val nextIdx = indent + 1
        if (nextIdx < line.length && (line[nextIdx] == ' ' || line[nextIdx] == '\t')) {
            var contentStart = nextIdx
            while (contentStart < line.length && (line[contentStart] == ' ' || line[contentStart] == '\t')) {
                contentStart++
            }
            val effectiveContentStart = if (contentStart - nextIdx >= 5) nextIdx + 1 else contentStart
            return ListMarker(
                isOrdered = false,
                number = 0,
                delimiter = ch,
                leadingSpaces = indent,
                contentStartIndex = effectiveContentStart,
            )
        }
        return null
    }
    if (ch in '0'..'9') {
        var digitEnd = indent
        while (digitEnd < line.length && line[digitEnd] in '0'..'9' && (digitEnd - indent) < 9) {
            digitEnd++
        }
        if (digitEnd >= line.length) return null
        val delim = line[digitEnd]
        if (delim != '.' && delim != ')') return null
        val spaceIdx = digitEnd + 1
        if (spaceIdx >= line.length || (line[spaceIdx] != ' ' && line[spaceIdx] != '\t')) return null
        val num = line.substring(indent, digitEnd).toIntOrNull() ?: return null
        var contentStart = spaceIdx
        while (contentStart < line.length && (line[contentStart] == ' ' || line[contentStart] == '\t')) {
            contentStart++
        }
        val effectiveContentStart = if (contentStart - spaceIdx >= 5) spaceIdx + 1 else contentStart
        return ListMarker(
            isOrdered = true,
            number = num,
            delimiter = delim,
            leadingSpaces = indent,
            contentStartIndex = effectiveContentStart,
        )
    }
    return null
}

private fun parseList(
    lines: List<String>,
    startIndex: Int,
    firstMarker: ListMarker,
    depth: Int,
): Pair<MarkdownBlock, Int> {
    val items = mutableListOf<MarkdownListItem>()
    var i = startIndex
    var currentMarker = firstMarker

    while (i < lines.size) {
        val rawFirst = lines[i]
        val firstLineRest = if (currentMarker.contentStartIndex <= rawFirst.length) {
            rawFirst.substring(currentMarker.contentStartIndex)
        } else {
            ""
        }
        val (checked, itemFirstLine) = extractTaskCheckbox(firstLineRest)
        val itemLines = mutableListOf(itemFirstLine)
        val baseIndent = currentMarker.leadingSpaces
        val childIndent = currentMarker.contentStartIndex
        i++

        while (i < lines.size) {
            val line = lines[i]
            if (line.isBlank()) {
                var peek = i
                while (peek < lines.size && lines[peek].isBlank()) peek++
                if (peek >= lines.size) {
                    i = peek
                    break
                }
                val nextLine = lines[peek]
                val nextIndent = countLeadingSpaces(nextLine)
                if (nextIndent >= childIndent || nextIndent >= baseIndent + 2) {
                    while (i < peek) {
                        itemLines.add("")
                        i++
                    }
                    continue
                }
                val peekMarker = if (!isThematicBreak(nextLine)) parseListMarker(nextLine) else null
                if (peekMarker != null && isCompatibleListMarker(firstMarker, peekMarker)) {
                    i = peek
                }
                break
            }

            val lineIndent = countLeadingSpaces(line)
            if (lineIndent >= childIndent) {
                itemLines.add(stripUpToSpaces(line, childIndent))
                i++
                continue
            }
            if (lineIndent >= baseIndent + 2 && parseListMarker(line) != null) {
                itemLines.add(stripUpToSpaces(line, lineIndent))
                i++
                continue
            }

            if (parseFenceOpener(line) != null ||
                parseHeading(line) != null ||
                isThematicBreak(line) ||
                isBlockQuoteLine(line) ||
                parseListMarker(line) != null ||
                (i + 1 < lines.size && canStartTable(line, lines[i + 1]))
            ) {
                break
            }
            // Lazy continuation of item paragraph
            itemLines.add(line.trimStart())
            i++
        }

        items.add(MarkdownListItem(checked = checked, blocks = parseBlocks(itemLines, depth + 1)))

        if (i >= lines.size) break
        val nextLine = lines[i]
        if (nextLine.isBlank() || isThematicBreak(nextLine)) break
        val nextMarker = parseListMarker(nextLine) ?: break
        if (!isCompatibleListMarker(firstMarker, nextMarker)) break
        currentMarker = nextMarker
    }

    val block = if (firstMarker.isOrdered) {
        MarkdownBlock.OrderedList(startNumber = firstMarker.number, items = items)
    } else {
        MarkdownBlock.BulletList(items = items)
    }
    return block to i
}

private fun isCompatibleListMarker(first: ListMarker, next: ListMarker): Boolean {
    if (first.isOrdered != next.isOrdered) return false
    return if (first.isOrdered) first.delimiter == next.delimiter else true
}

private fun extractTaskCheckbox(line: String): Pair<Boolean?, String> {
    if (line.length >= 3 && line[0] == '[' && line[2] == ']') {
        val state = when (line[1]) {
            ' ' -> false
            'x', 'X' -> true
            else -> null
        }
        if (state != null) {
            if (line.length == 3) return state to ""
            if (line[3] == ' ' || line[3] == '\t') {
                return state to line.substring(4)
            }
        }
    }
    return null to line
}

fun parseInlines(input: String): List<MarkdownInline> = parseInlines(input, depth = 0)

private fun parseInlines(input: String, depth: Int): List<MarkdownInline> {
    if (input.isEmpty()) return emptyList()
    if (depth >= MAX_NESTING_DEPTH) return listOf(MarkdownInline.Text(input))

    val result = mutableListOf<MarkdownInline>()
    val textBuf = StringBuilder()

    fun flushText() {
        if (textBuf.isNotEmpty()) {
            val str = textBuf.toString()
            val last = result.lastOrNull()
            if (last is MarkdownInline.Text) {
                result[result.lastIndex] = MarkdownInline.Text(last.text + str)
            } else {
                result.add(MarkdownInline.Text(str))
            }
            textBuf.clear()
        }
    }

    fun emitNode(node: MarkdownInline) {
        flushText()
        result.add(node)
    }

    var i = 0
    while (i < input.length) {
        val ch = input[i]

        if (ch == '\n') {
            emitNode(MarkdownInline.LineBreak)
            i++
            continue
        }

        // Backslash escape for ASCII punctuation
        if (ch == '\\' && i + 1 < input.length && isAsciiPunctuation(input[i + 1])) {
            textBuf.append(input[i + 1])
            i += 2
            continue
        }

        // Multi-backtick inline code span
        if (ch == '`') {
            var tickLen = 0
            while (i + tickLen < input.length && input[i + tickLen] == '`') tickLen++
            val closeIdx = findClosingBackticks(input, i + tickLen, input.length, tickLen)
            if (closeIdx != -1) {
                var code = input.substring(i + tickLen, closeIdx).replace('\n', ' ')
                if (code.length >= 2 && code.startsWith(' ') && code.endsWith(' ') && code.any { it != ' ' }) {
                    code = code.substring(1, code.length - 1)
                }
                emitNode(MarkdownInline.Code(code))
                i = closeIdx + tickLen
                continue
            }
            textBuf.append(input, i, i + tickLen)
            i += tickLen
            continue
        }

        // Image ![alt](url) -> degrade cleanly to link or alt text
        if (ch == '!' && i + 1 < input.length && input[i + 1] == '[') {
            val parsed = parseBracketLink(input, bracketStart = i + 1)
            if (parsed != null) {
                val (altRaw, url, nextIdx) = parsed
                val displayAlt = altRaw.trim().ifEmpty { "图片" }
                if (url.isNotBlank()) {
                    emitNode(MarkdownInline.Link(listOf(MarkdownInline.Text(displayAlt)), url))
                } else {
                    textBuf.append(displayAlt)
                }
                i = nextIdx
                continue
            }
        }

        // Inline link [label](url)
        if (ch == '[') {
            val parsed = parseBracketLink(input, bracketStart = i)
            if (parsed != null) {
                val (labelRaw, url, nextIdx) = parsed
                if (url.isNotBlank()) {
                    val labelInlines = parseInlines(labelRaw, depth + 1)
                        .ifEmpty { listOf(MarkdownInline.Text(url)) }
                    emitNode(MarkdownInline.Link(labelInlines, url))
                    i = nextIdx
                    continue
                }
            }
        }

        // Angle-bracket autolink <https://...> / <http://...> / <mailto:...>
        if (ch == '<') {
            val autolink = parseAngleAutolink(input, i)
            if (autolink != null) {
                val (display, href, nextIdx) = autolink
                emitNode(MarkdownInline.Link(listOf(MarkdownInline.Text(display)), href))
                i = nextIdx
                continue
            }
        }

        // Bare URL autolink
        if (ch == 'h' && (i == 0 || !input[i - 1].isAsciiAlnum()) &&
            (input.startsWith("https://", i) || input.startsWith("http://", i))
        ) {
            val bareUrl = parseBareUrl(input, i)
            if (bareUrl != null) {
                val (url, nextIdx) = bareUrl
                emitNode(MarkdownInline.Link(listOf(MarkdownInline.Text(url)), url))
                i = nextIdx
                continue
            }
        }

        // Triple emphasis ***...***
        if (ch == '*' && input.startsWith("***", i)) {
            val closeIdx = findEmphasisCloser(
                input = input,
                startSearch = i + 3,
                marker = "***",
                requireWordBoundary = false,
            )
            if (closeIdx != -1) {
                val inner = input.substring(i + 3, closeIdx)
                val innerNodes = parseInlines(inner, depth + 1)
                emitNode(MarkdownInline.Bold(listOf(MarkdownInline.Italic(innerNodes))))
                i = closeIdx + 3
                continue
            }
        }

        // Bold **...** or __...__
        if ((ch == '*' && input.startsWith("**", i)) ||
            (ch == '_' && input.startsWith("__", i) && isWordBoundaryBefore(input, i))
        ) {
            val marker = if (ch == '*') "**" else "__"
            val closeIdx = findEmphasisCloser(
                input = input,
                startSearch = i + 2,
                marker = marker,
                requireWordBoundary = (ch == '_'),
            )
            if (closeIdx != -1) {
                val inner = input.substring(i + 2, closeIdx)
                emitNode(MarkdownInline.Bold(parseInlines(inner, depth + 1)))
                i = closeIdx + 2
                continue
            }
        }

        // Strikethrough ~~...~~
        if (ch == '~' && input.startsWith("~~", i)) {
            val closeIdx = findEmphasisCloser(
                input = input,
                startSearch = i + 2,
                marker = "~~",
                requireWordBoundary = false,
            )
            if (closeIdx != -1) {
                val inner = input.substring(i + 2, closeIdx)
                emitNode(MarkdownInline.Strikethrough(parseInlines(inner, depth + 1)))
                i = closeIdx + 2
                continue
            }
        }

        // Italic *...* or _..._
        if (ch == '*' || (ch == '_' && isWordBoundaryBefore(input, i))) {
            val closeIdx = findSingleEmphasisCloser(
                input = input,
                startSearch = i + 1,
                markerChar = ch,
                requireWordBoundary = (ch == '_'),
            )
            if (closeIdx != -1) {
                val inner = input.substring(i + 1, closeIdx)
                emitNode(MarkdownInline.Italic(parseInlines(inner, depth + 1)))
                i = closeIdx + 1
                continue
            }
            // If there was a longer unclosed run of '*' or '_', consume only one char if followed by others?
            // No, if '**foo' is unclosed, consuming '*' then '*' as literal is safe and won't loop.
        }

        textBuf.append(ch)
        i++
    }

    flushText()
    return result
}

private fun findClosingBackticks(s: String, start: Int, end: Int, tickLen: Int): Int {
    var i = start
    while (i < end) {
        if (s[i] == '`') {
            var run = 0
            while (i + run < end && s[i + run] == '`') run++
            if (run == tickLen) return i
            i += run
        } else {
            i++
        }
    }
    return -1
}

private fun parseBracketLink(input: String, bracketStart: Int): Triple<String, String, Int>? {
    if (bracketStart >= input.length || input[bracketStart] != '[') return null
    var i = bracketStart + 1
    var bracketDepth = 1
    while (i < input.length && bracketDepth > 0) {
        val c = input[i]
        if (c == '\\' && i + 1 < input.length) {
            i += 2
            continue
        }
        if (c == '`') {
            var tickLen = 0
            while (i + tickLen < input.length && input[i + tickLen] == '`') tickLen++
            val closeTick = findClosingBackticks(input, i + tickLen, input.length, tickLen)
            if (closeTick != -1) {
                i = closeTick + tickLen
                continue
            }
            i += tickLen
            continue
        }
        if (c == '[') bracketDepth++
        else if (c == ']') bracketDepth--
        if (bracketDepth == 0) break
        i++
    }
    if (bracketDepth != 0 || i >= input.length) return null
    val closeBracket = i
    if (closeBracket + 1 >= input.length || input[closeBracket + 1] != '(') return null

    var p = closeBracket + 2
    while (p < input.length && (input[p] == ' ' || input[p] == '\t')) p++
    if (p >= input.length) return null

    val urlBuf = StringBuilder()
    if (input[p] == '<') {
        p++
        while (p < input.length && input[p] != '>' && input[p] != '\n') {
            if (input[p] == '\\' && p + 1 < input.length && isAsciiPunctuation(input[p + 1])) {
                urlBuf.append(input[p + 1])
                p += 2
            } else {
                urlBuf.append(input[p])
                p++
            }
        }
        if (p >= input.length || input[p] != '>') return null
        p++
    } else {
        var parenDepth = 0
        while (p < input.length) {
            val c = input[p]
            if (c == '\n' || c == ' ' || c == '\t') break
            if (c == '\\' && p + 1 < input.length && isAsciiPunctuation(input[p + 1])) {
                urlBuf.append(input[p + 1])
                p += 2
                continue
            }
            if (c == '(') {
                parenDepth++
                urlBuf.append(c)
                p++
                continue
            }
            if (c == ')') {
                if (parenDepth == 0) break
                parenDepth--
                urlBuf.append(c)
                p++
                continue
            }
            urlBuf.append(c)
            p++
        }
        if (parenDepth != 0) return null
    }

    while (p < input.length && (input[p] == ' ' || input[p] == '\t' || input[p] == '\n')) p++
    if (p < input.length && (input[p] == '"' || input[p] == '\'')) {
        val quote = input[p]
        p++
        while (p < input.length && input[p] != quote) {
            if (input[p] == '\\' && p + 1 < input.length) p += 2 else p++
        }
        if (p >= input.length) return null
        p++
        while (p < input.length && (input[p] == ' ' || input[p] == '\t' || input[p] == '\n')) p++
    }
    if (p >= input.length || input[p] != ')') return null

    val labelRaw = input.substring(bracketStart + 1, closeBracket)
    return Triple(labelRaw, urlBuf.toString().trim(), p + 1)
}

private fun parseAngleAutolink(input: String, start: Int): Triple<String, String, Int>? {
    val closeIdx = input.indexOf('>', start + 1)
    if (closeIdx == -1) return null
    val inner = input.substring(start + 1, closeIdx)
    if (inner.isEmpty() || inner.any { it.isWhitespace() || it == '<' }) return null
    return when {
        inner.startsWith("https://", ignoreCase = true) || inner.startsWith("http://", ignoreCase = true) ->
            Triple(inner, inner, closeIdx + 1)
        inner.startsWith("mailto:", ignoreCase = true) && inner.contains('@') ->
            Triple(inner.removePrefix("mailto:"), inner, closeIdx + 1)
        else -> null
    }
}

private fun parseBareUrl(input: String, start: Int): Pair<String, Int>? {
    var end = start
    while (end < input.length) {
        val c = input[end]
        if (c.isWhitespace() || c == '<' || c == '>' || c == '"' || c == '\'' || c == '`' ||
            c in CJK_STOP_PUNCTUATION
        ) {
            break
        }
        end++
    }
    var trimmedEnd = end
    while (trimmedEnd > start) {
        val tail = input[trimmedEnd - 1]
        val shouldTrim = when (tail) {
            '.', ',', ';', ':', '!', '?', ']' -> true
            ')' -> {
                val slice = input.substring(start, trimmedEnd)
                slice.count { it == ')' } > slice.count { it == '(' }
            }
            else -> false
        }
        if (!shouldTrim) break
        trimmedEnd--
    }
    val url = input.substring(start, trimmedEnd)
    val schemeLen = if (url.startsWith("https://")) 8 else 7
    if (url.length <= schemeLen) return null
    val hostChar = url[schemeLen]
    if (!hostChar.isAsciiAlnum() && hostChar != '[') return null
    return url to trimmedEnd
}

private fun findEmphasisCloser(
    input: String,
    startSearch: Int,
    marker: String,
    requireWordBoundary: Boolean,
): Int {
    if (startSearch >= input.length || input[startSearch].isWhitespace()) return -1
    var i = startSearch
    while (i <= input.length - marker.length) {
        val c = input[i]
        if (c == '\\' && i + 1 < input.length) {
            i += 2
            continue
        }
        if (c == '`') {
            var tickLen = 0
            while (i + tickLen < input.length && input[i + tickLen] == '`') tickLen++
            val closeTick = findClosingBackticks(input, i + tickLen, input.length, tickLen)
            if (closeTick != -1) {
                i = closeTick + tickLen
                continue
            }
            i += tickLen
            continue
        }
        if (input.startsWith(marker, i) && i > startSearch && !input[i - 1].isWhitespace()) {
            val afterIdx = i + marker.length
            if (!requireWordBoundary || isWordBoundaryAfter(input, afterIdx)) {
                return i
            }
        }
        i++
    }
    return -1
}

private fun findSingleEmphasisCloser(
    input: String,
    startSearch: Int,
    markerChar: Char,
    requireWordBoundary: Boolean,
): Int {
    if (startSearch >= input.length || input[startSearch].isWhitespace()) return -1
    var i = startSearch
    while (i < input.length) {
        val c = input[i]
        if (c == '\\' && i + 1 < input.length) {
            i += 2
            continue
        }
        if (c == '`') {
            var tickLen = 0
            while (i + tickLen < input.length && input[i + tickLen] == '`') tickLen++
            val closeTick = findClosingBackticks(input, i + tickLen, input.length, tickLen)
            if (closeTick != -1) {
                i = closeTick + tickLen
                continue
            }
            i += tickLen
            continue
        }
        if (c == markerChar) {
            var run = 0
            while (i + run < input.length && input[i + run] == markerChar) run++
            // Skip exact double markers (e.g. inner **bold** inside *italic **bold** italic*),
            // while allowing single '*' or triple '***' (closing inner ** and outer *).
            if (run == 2) {
                i += 2
                continue
            }
            val matchPos = i + run - 1
            if (matchPos > startSearch && !input[matchPos - 1].isWhitespace()) {
                if (!requireWordBoundary || isWordBoundaryAfter(input, matchPos + 1)) {
                    return matchPos
                }
            }
            i += run
            continue
        }
        i++
    }
    return -1
}

private fun isWordBoundaryBefore(s: String, index: Int): Boolean =
    index == 0 || !s[index - 1].isAsciiAlnum()

private fun isWordBoundaryAfter(s: String, indexAfter: Int): Boolean =
    indexAfter >= s.length || !s[indexAfter].isAsciiAlnum()

private fun Char.isAsciiAlnum(): Boolean =
    this in 'a'..'z' || this in 'A'..'Z' || this in '0'..'9'

private fun isEscaped(s: String, index: Int): Boolean {
    var backslashes = 0
    var i = index - 1
    while (i >= 0 && s[i] == '\\') {
        backslashes++
        i--
    }
    return backslashes % 2 == 1
}

private fun isAsciiPunctuation(c: Char): Boolean =
    c in "\\`*_{}[]()#+-.!~|"

private val CJK_STOP_PUNCTUATION = setOf(
    '。', '，', '；', '：', '、', '！', '？',
    '（', '）', '「', '」', '『', '』', '【', '】', '《', '》',
    '“', '”', '‘', '’',
)
