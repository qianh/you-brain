package ai.youbrain.mobile.ui

import ai.youbrain.mobile.ui.markdown.MarkdownBlock
import ai.youbrain.mobile.ui.markdown.MarkdownInline
import ai.youbrain.mobile.ui.markdown.parseMarkdown

internal const val PUSH_PREVIEW_MAX_LINES = 2
private const val PREVIEW_BUFFER_LINES = 6

internal data class PushBodySummary(
    val previewText: String,
    val hasExtraOrRichContent: Boolean,
)

internal fun summarizePushBody(body: String, kind: String): PushBodySummary {
    val trimmed = body.trim()
    if (trimmed.isEmpty()) {
        return PushBodySummary(previewText = "", hasExtraOrRichContent = false)
    }

    if (kind == "tty7") {
        val nonEmptyLines = trimmed
            .lineSequence()
            .map { it.trimEnd() }
            .filter { it.isNotBlank() }
            .take(PREVIEW_BUFFER_LINES + 1)
            .toList()
        return PushBodySummary(
            previewText = nonEmptyLines.take(PREVIEW_BUFFER_LINES).joinToString("\n"),
            hasExtraOrRichContent = nonEmptyLines.size > PUSH_PREVIEW_MAX_LINES,
        )
    }

    val blocks = parseMarkdown(trimmed)
    if (blocks.isEmpty()) {
        return PushBodySummary(
            previewText = trimmed,
            hasExtraOrRichContent = trimmed.lines().count { it.isNotBlank() } > PUSH_PREVIEW_MAX_LINES,
        )
    }

    val lines = ArrayList<String>(PREVIEW_BUFFER_LINES)
    collectPreviewLines(blocks, lines, maxLines = PREVIEW_BUFFER_LINES)

    val isSinglePlainParagraph = blocks.size == 1 &&
        (blocks[0] as? MarkdownBlock.Paragraph)?.let { paragraph ->
            paragraph.inlines.all { it is MarkdownInline.Text }
        } == true

    val rawNonEmptyCount = trimmed.lineSequence().count { it.isNotBlank() }
    val hasExtraOrRich = !isSinglePlainParagraph ||
        lines.size > PUSH_PREVIEW_MAX_LINES ||
        rawNonEmptyCount > PUSH_PREVIEW_MAX_LINES

    return PushBodySummary(
        previewText = lines.joinToString("\n").ifBlank { trimmed },
        hasExtraOrRichContent = hasExtraOrRich,
    )
}

private fun collectPreviewLines(
    blocks: List<MarkdownBlock>,
    out: MutableList<String>,
    maxLines: Int,
) {
    for (block in blocks) {
        if (out.size >= maxLines) return
        when (block) {
            is MarkdownBlock.Heading -> {
                appendCleanedTextLines(flattenInlines(block.inlines), out, maxLines)
            }
            is MarkdownBlock.Paragraph -> {
                appendCleanedTextLines(flattenInlines(block.inlines), out, maxLines)
            }
            is MarkdownBlock.CodeBlock -> {
                for (codeLine in block.code.lineSequence()) {
                    if (out.size >= maxLines) break
                    val clean = codeLine.trim()
                    if (clean.isNotEmpty()) out.add(clean)
                }
            }
            is MarkdownBlock.BlockQuote -> {
                collectPreviewLines(block.blocks, out, maxLines)
            }
            is MarkdownBlock.BulletList -> {
                for (item in block.items) {
                    if (out.size >= maxLines) break
                    val itemLines = ArrayList<String>(2)
                    collectPreviewLines(item.blocks, itemLines, maxLines = 2)
                    if (itemLines.isNotEmpty()) {
                        out.add("• ${itemLines.first()}")
                        for (extra in itemLines.drop(1)) {
                            if (out.size >= maxLines) break
                            out.add(extra)
                        }
                    }
                }
            }
            is MarkdownBlock.OrderedList -> {
                block.items.forEachIndexed { idx, item ->
                    if (out.size >= maxLines) return
                    val itemLines = ArrayList<String>(2)
                    collectPreviewLines(item.blocks, itemLines, maxLines = 2)
                    if (itemLines.isNotEmpty()) {
                        out.add("${block.startNumber + idx}. ${itemLines.first()}")
                        for (extra in itemLines.drop(1)) {
                            if (out.size >= maxLines) break
                            out.add(extra)
                        }
                    }
                }
            }
            is MarkdownBlock.Table -> {
                val headerLine = block.headers
                    .map { flattenInlines(it).trim() }
                    .filter { it.isNotEmpty() }
                    .joinToString(" · ")
                if (headerLine.isNotEmpty() && out.size < maxLines) {
                    out.add(headerLine)
                }
                for (row in block.rows) {
                    if (out.size >= maxLines) break
                    val rowLine = row
                        .map { flattenInlines(it).trim() }
                        .filter { it.isNotEmpty() }
                        .joinToString(" · ")
                    if (rowLine.isNotEmpty()) out.add(rowLine)
                }
            }
            MarkdownBlock.ThematicBreak -> Unit
        }
    }
}

private fun appendCleanedTextLines(
    text: String,
    out: MutableList<String>,
    maxLines: Int,
) {
    for (line in text.lineSequence()) {
        if (out.size >= maxLines) return
        val clean = line.trim()
        if (clean.isNotEmpty()) {
            out.add(clean)
        }
    }
}

private fun flattenInlines(inlines: List<MarkdownInline>): String = buildString {
    appendInlines(inlines)
}

private fun StringBuilder.appendInlines(inlines: List<MarkdownInline>) {
    for (inline in inlines) {
        when (inline) {
            is MarkdownInline.Text -> append(inline.text)
            is MarkdownInline.Bold -> appendInlines(inline.children)
            is MarkdownInline.Italic -> appendInlines(inline.children)
            is MarkdownInline.Strikethrough -> appendInlines(inline.children)
            is MarkdownInline.Code -> append(inline.code)
            is MarkdownInline.Link -> {
                val start = length
                appendInlines(inline.label)
                if (length == start) append(inline.url)
            }
            MarkdownInline.LineBreak -> append('\n')
        }
    }
}
