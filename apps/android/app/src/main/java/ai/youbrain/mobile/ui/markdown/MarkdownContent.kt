package ai.youbrain.mobile.ui.markdown

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.DisableSelection
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.LinkInteractionListener
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.youbrain.mobile.ui.components.IosIcons
import ai.youbrain.mobile.ui.theme.IosTheme
import kotlinx.coroutines.delay

private data class MarkdownStyleTokens(
    val textColor: Color,
    val secondaryText: Color,
    val linkColor: Color,
    val inlineCodeText: Color,
    val inlineCodeBg: Color,
)

@Composable
fun MarkdownContent(
    markdown: String,
    maxContentWidth: Dp,
    modifier: Modifier = Modifier,
) {
    val c = IosTheme.colors
    val blocks = remember(markdown) { parseMarkdown(markdown) }
    if (blocks.isEmpty()) {
        Text(
            text = markdown,
            color = c.label,
            fontSize = 15.sp,
            lineHeight = 22.sp,
            modifier = modifier,
        )
        return
    }
    MarkdownBlocksColumn(
        blocks = blocks,
        maxContentWidth = maxContentWidth,
        blockSpacing = 8.dp,
        listDepth = 0,
        modifier = modifier,
    )
}

@Composable
private fun MarkdownBlocksColumn(
    blocks: List<MarkdownBlock>,
    maxContentWidth: Dp,
    blockSpacing: Dp,
    listDepth: Int,
    modifier: Modifier = Modifier,
) {
    val c = IosTheme.colors
    val uriHandler = LocalUriHandler.current
    val inlineTokens = remember(c) {
        MarkdownStyleTokens(
            textColor = c.label,
            secondaryText = c.secondaryLabel,
            linkColor = c.blue,
            inlineCodeText = if (c.isDark) Color(0xFFE5E5EA) else Color(0xFF1C1C1E),
            inlineCodeBg = if (c.isDark) Color(0xFF2C2C2E) else Color(0xFFEFEFF4),
        )
    }

    Column(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(blockSpacing),
    ) {
        blocks.forEachIndexed { index, block ->
            when (block) {
                is MarkdownBlock.Heading -> MarkdownHeading(
                    block = block,
                    tokens = inlineTokens,
                    uriHandler = uriHandler,
                    addTopSpace = index > 0,
                )
                is MarkdownBlock.Paragraph -> {
                    val annotated = remember(block.inlines, inlineTokens) {
                        buildInlineAnnotatedString(
                            inlines = block.inlines,
                            tokens = inlineTokens,
                            codeFontSize = 13.5.sp,
                            uriHandler = uriHandler,
                        )
                    }
                    Text(
                        text = annotated,
                        color = inlineTokens.textColor,
                        fontSize = 15.sp,
                        lineHeight = 22.sp,
                    )
                }
                is MarkdownBlock.CodeBlock -> MarkdownCodeBlock(block = block)
                is MarkdownBlock.BlockQuote -> MarkdownBlockQuote(
                    block = block,
                    maxContentWidth = maxContentWidth,
                    listDepth = listDepth,
                )
                is MarkdownBlock.BulletList -> MarkdownList(
                    items = block.items,
                    orderedStart = null,
                    maxContentWidth = maxContentWidth,
                    listDepth = listDepth,
                )
                is MarkdownBlock.OrderedList -> MarkdownList(
                    items = block.items,
                    orderedStart = block.startNumber,
                    maxContentWidth = maxContentWidth,
                    listDepth = listDepth,
                )
                is MarkdownBlock.Table -> MarkdownTable(
                    table = block,
                    maxContentWidth = maxContentWidth,
                    tokens = inlineTokens,
                    uriHandler = uriHandler,
                )
                MarkdownBlock.ThematicBreak -> HorizontalDivider(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 4.dp),
                    thickness = 0.5.dp,
                    color = c.separator.copy(alpha = if (c.isDark) 0.7f else 0.55f),
                )
            }
        }
    }
}

@Composable
private fun MarkdownHeading(
    block: MarkdownBlock.Heading,
    tokens: MarkdownStyleTokens,
    uriHandler: UriHandler,
    addTopSpace: Boolean,
) {
    val (fontSize, lineHeight, weight, color, topPad) = when (block.level) {
        1 -> HeadingSpec(18.sp, 24.sp, FontWeight.Bold, tokens.textColor, if (addTopSpace) 4.dp else 0.dp)
        2 -> HeadingSpec(16.5.sp, 22.sp, FontWeight.Bold, tokens.textColor, if (addTopSpace) 4.dp else 0.dp)
        3 -> HeadingSpec(15.5.sp, 21.sp, FontWeight.SemiBold, tokens.textColor, if (addTopSpace) 2.dp else 0.dp)
        4 -> HeadingSpec(15.sp, 20.sp, FontWeight.SemiBold, tokens.textColor, 0.dp)
        5 -> HeadingSpec(14.sp, 19.sp, FontWeight.SemiBold, tokens.textColor, 0.dp)
        else -> HeadingSpec(14.sp, 19.sp, FontWeight.SemiBold, tokens.secondaryText, 0.dp)
    }
    val annotated = remember(block.inlines, tokens, fontSize) {
        buildInlineAnnotatedString(
            inlines = block.inlines,
            tokens = tokens,
            codeFontSize = (fontSize.value - 1.5f).sp,
            uriHandler = uriHandler,
        )
    }
    Text(
        text = annotated,
        style = TextStyle(
            color = color,
            fontSize = fontSize,
            lineHeight = lineHeight,
            fontWeight = weight,
        ),
        modifier = if (topPad > 0.dp) Modifier.padding(top = topPad) else Modifier,
    )
}

private data class HeadingSpec(
    val fontSize: TextUnit,
    val lineHeight: TextUnit,
    val weight: FontWeight,
    val color: Color,
    val topPad: Dp,
)

@Composable
private fun MarkdownCodeBlock(block: MarkdownBlock.CodeBlock) {
    val c = IosTheme.colors
    val clipboard = LocalClipboardManager.current
    var copied by remember(block.code) { mutableStateOf(false) }

    LaunchedEffect(copied) {
        if (copied) {
            delay(1_500L)
            copied = false
        }
    }

    val containerBg = if (c.isDark) Color(0xFF141416) else Color(0xFFF5F5F7)
    val headerBg = if (c.isDark) Color(0xFF1D1D20) else Color(0xFFECECF0)
    val borderColor = c.separator.copy(alpha = if (c.isDark) 0.65f else 0.55f)
    val shape = RoundedCornerShape(10.dp)

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(containerBg)
            .border(0.5.dp, borderColor, shape),
    ) {
        DisableSelection {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(headerBg)
                    .padding(horizontal = 11.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = block.language?.takeIf { it.isNotBlank() } ?: "代码",
                    fontFamily = FontFamily.Monospace,
                    fontSize = 11.5.sp,
                    color = c.secondaryLabel,
                )
                Text(
                    text = if (copied) "✓ 已复制" else "复制",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.Medium,
                    color = if (copied) c.green else c.blue,
                    modifier = Modifier
                        .clip(RoundedCornerShape(5.dp))
                        .clickable {
                            clipboard.setText(AnnotatedString(block.code))
                            copied = true
                        }
                        .padding(horizontal = 6.dp, vertical = 1.dp),
                )
            }
        }
        HorizontalDivider(thickness = 0.5.dp, color = borderColor)
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 12.dp, vertical = 10.dp),
        ) {
            Text(
                text = block.code,
                fontFamily = FontFamily.Monospace,
                fontSize = 13.sp,
                lineHeight = 18.5.sp,
                color = c.label,
                softWrap = false,
            )
        }
    }
}

@Composable
private fun MarkdownBlockQuote(
    block: MarkdownBlock.BlockQuote,
    maxContentWidth: Dp,
    listDepth: Int,
) {
    val c = IosTheme.colors
    val quoteBg = if (c.isDark) Color(0xFF252528) else Color(0xFFF7F7FA)
    val barColor = c.blue.copy(alpha = 0.55f)
    val innerWidth = (maxContentWidth - 22.dp).coerceAtLeast(160.dp)

    Column(
        modifier = Modifier
            .clip(RoundedCornerShape(8.dp))
            .background(quoteBg)
            .drawBehind {
                val barW = 3.dp.toPx()
                val radius = 1.5.dp.toPx()
                drawRoundRect(
                    color = barColor,
                    topLeft = Offset.Zero,
                    size = Size(barW, size.height),
                    cornerRadius = CornerRadius(radius, radius),
                )
            }
            .padding(start = 12.dp, end = 10.dp, top = 7.dp, bottom = 7.dp),
    ) {
        MarkdownBlocksColumn(
            blocks = block.blocks,
            maxContentWidth = innerWidth,
            blockSpacing = 6.dp,
            listDepth = listDepth,
        )
    }
}

@Composable
private fun MarkdownList(
    items: List<MarkdownListItem>,
    orderedStart: Int?,
    maxContentWidth: Dp,
    listDepth: Int,
) {
    val c = IosTheme.colors
    val innerWidth = (maxContentWidth - 24.dp).coerceAtLeast(160.dp)

    Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
        items.forEachIndexed { index, item ->
            Row(
                horizontalArrangement = Arrangement.spacedBy(7.dp),
                verticalAlignment = Alignment.Top,
            ) {
                if (item.checked != null) {
                    val checked = item.checked
                    Box(
                        modifier = Modifier
                            .padding(top = 3.dp)
                            .size(15.dp)
                            .clip(RoundedCornerShape(4.dp))
                            .background(if (checked) c.blue else Color.Transparent)
                            .border(
                                width = 1.2.dp,
                                color = if (checked) c.blue else c.secondaryLabel.copy(alpha = 0.7f),
                                shape = RoundedCornerShape(4.dp),
                            ),
                        contentAlignment = Alignment.Center,
                    ) {
                        if (checked) {
                            Icon(
                                imageVector = IosIcons.Check,
                                contentDescription = null,
                                tint = Color.White,
                                modifier = Modifier.size(11.dp),
                            )
                        }
                    }
                } else if (orderedStart != null) {
                    Text(
                        text = "${orderedStart + index}.",
                        fontSize = 14.sp,
                        lineHeight = 22.sp,
                        fontWeight = FontWeight.Medium,
                        color = c.secondaryLabel,
                        modifier = Modifier.widthIn(min = 20.dp),
                    )
                } else {
                    val bulletGlyph = when (listDepth % 3) {
                        0 -> "•"
                        1 -> "◦"
                        else -> "▪"
                    }
                    Text(
                        text = bulletGlyph,
                        fontSize = 15.sp,
                        lineHeight = 22.sp,
                        fontWeight = FontWeight.Bold,
                        color = c.secondaryLabel,
                        modifier = Modifier.padding(start = 2.dp),
                    )
                }

                MarkdownBlocksColumn(
                    blocks = item.blocks,
                    maxContentWidth = innerWidth,
                    blockSpacing = 4.dp,
                    listDepth = listDepth + 1,
                    modifier = Modifier.weight(1f, fill = false),
                )
            }
        }
    }
}

@Composable
private fun MarkdownTable(
    table: MarkdownBlock.Table,
    maxContentWidth: Dp,
    tokens: MarkdownStyleTokens,
    uriHandler: UriHandler,
) {
    val colCount = table.headers.size
    if (colCount == 0) return

    val c = IosTheme.colors
    val shape = RoundedCornerShape(10.dp)
    val tableBg = if (c.isDark) Color(0xFF1C1C1E) else Color.White
    val headerBg = if (c.isDark) Color(0xFF2C2C2E) else Color(0xFFF5F5F8)
    val evenRowBg = if (c.isDark) Color(0xFF232326) else Color(0xFFFAFAFC)
    val borderColor = c.separator.copy(alpha = if (c.isDark) 0.65f else 0.55f)
    val colDividerColor = c.separator.copy(alpha = if (c.isDark) 0.45f else 0.35f)
    val totalRows = 1 + table.rows.size
    val dividerCount = (colCount - 1).coerceAtLeast(0)

    Box(
        modifier = Modifier
            .clip(shape)
            .background(tableBg)
            .border(0.5.dp, borderColor, shape)
            .horizontalScroll(rememberScrollState()),
    ) {
        key(totalRows, colCount) {
            Layout(
                content = {
                    // Group 1: Row backgrounds + bottom hairlines
                    for (r in 0 until totalRows) {
                        val rowBg = when {
                            r == 0 -> headerBg
                            r % 2 == 0 -> evenRowBg
                            else -> Color.Transparent
                        }
                        val showBottomHairline = r < totalRows - 1
                        val hairlineThickness = if (r == 0) 1.dp else 0.5.dp
                        Box(
                            modifier = Modifier
                                .background(rowBg)
                                .drawBehind {
                                    if (showBottomHairline) {
                                        val strokePx = hairlineThickness.toPx()
                                        drawRect(
                                            color = borderColor,
                                            topLeft = Offset(0f, size.height - strokePx),
                                            size = Size(size.width, strokePx),
                                        )
                                    }
                                },
                        )
                    }

                    // Group 2: Vertical column dividers
                    repeat(dividerCount) {
                        Box(modifier = Modifier.background(colDividerColor))
                    }

                    // Group 3: Table cells (header row + body rows)
                    for (r in 0 until totalRows) {
                        val isHeader = (r == 0)
                        val rowCells = if (isHeader) table.headers else table.rows[r - 1]
                        for (col in 0 until colCount) {
                            val align = table.alignments.getOrElse(col) { TableAlignment.START }
                            val boxAlign = when (align) {
                                TableAlignment.START -> Alignment.CenterStart
                                TableAlignment.CENTER -> Alignment.Center
                                TableAlignment.END -> Alignment.CenterEnd
                            }
                            val textAlign = when (align) {
                                TableAlignment.START -> TextAlign.Start
                                TableAlignment.CENTER -> TextAlign.Center
                                TableAlignment.END -> TextAlign.End
                            }
                            val cellInlines = rowCells.getOrElse(col) { emptyList() }
                            val cellAnnotated = remember(cellInlines, tokens) {
                                buildInlineAnnotatedString(
                                    inlines = cellInlines,
                                    tokens = tokens,
                                    codeFontSize = 12.5.sp,
                                    uriHandler = uriHandler,
                                )
                            }
                            Box(
                                modifier = Modifier.padding(horizontal = 10.dp, vertical = 7.dp),
                                contentAlignment = boxAlign,
                            ) {
                                Text(
                                    text = cellAnnotated,
                                    style = TextStyle(
                                        color = tokens.textColor,
                                        fontSize = 13.5.sp,
                                        lineHeight = 19.sp,
                                        fontWeight = if (isHeader) FontWeight.SemiBold else FontWeight.Normal,
                                        textAlign = textAlign,
                                    ),
                                )
                            }
                        }
                    }
                },
            ) { measurables, constraints ->
                val rowBgMeasurables = measurables.subList(0, totalRows)
                val colDividerMeasurables = measurables.subList(totalRows, totalRows + dividerCount)
                val cellMeasurables = measurables.subList(totalRows + dividerCount, measurables.size)

                val minColPx = 48.dp.roundToPx()
                val maxColPx = maxOf(minColPx, maxOf(220.dp, maxContentWidth * 0.65f).roundToPx())
                val comfortableMinPx = 88.dp.roundToPx()
                val maxContentPx = maxContentWidth.roundToPx().coerceAtLeast(1)
                val availablePx = if (constraints.hasBoundedWidth) {
                    minOf(maxContentPx, constraints.maxWidth)
                } else {
                    maxContentPx
                }

                val naturalWidths = IntArray(colCount) { col ->
                    var maxW = 0
                    for (r in 0 until totalRows) {
                        val w = cellMeasurables[r * colCount + col].maxIntrinsicWidth(Constraints.Infinity)
                        if (w > maxW) maxW = w
                    }
                    maxW
                }

                val colWidths = computeTableColumnWidths(
                    naturalWidths = naturalWidths,
                    availableWidthPx = availablePx,
                    minColPx = minColPx,
                    maxColPx = maxColPx,
                    comfortableMinPx = comfortableMinPx,
                )

                val cellPlaceables = Array(totalRows) { r ->
                    Array(colCount) { col ->
                        cellMeasurables[r * colCount + col].measure(
                            Constraints(
                                minWidth = colWidths[col],
                                maxWidth = colWidths[col],
                                minHeight = 0,
                                maxHeight = Constraints.Infinity,
                            ),
                        )
                    }
                }

                val rowHeights = IntArray(totalRows) { r ->
                    var maxH = 0
                    for (col in 0 until colCount) {
                        val h = cellPlaceables[r][col].height
                        if (h > maxH) maxH = h
                    }
                    maxH
                }

                val totalTableWidth = colWidths.sum()
                val totalTableHeight = rowHeights.sum()

                val rowBgPlaceables = List(totalRows) { r ->
                    rowBgMeasurables[r].measure(Constraints.fixed(totalTableWidth, rowHeights[r]))
                }
                val dividerWidthPx = maxOf(1, 0.5.dp.roundToPx())
                val colDividerPlaceables = List(dividerCount) { cIdx ->
                    colDividerMeasurables[cIdx].measure(Constraints.fixed(dividerWidthPx, totalTableHeight))
                }

                val layoutWidth = totalTableWidth.coerceIn(constraints.minWidth, constraints.maxWidth)
                val layoutHeight = totalTableHeight.coerceIn(constraints.minHeight, constraints.maxHeight)

                layout(layoutWidth, layoutHeight) {
                    var y = 0
                    for (r in 0 until totalRows) {
                        rowBgPlaceables[r].placeRelative(0, y)
                        y += rowHeights[r]
                    }

                    var dividerX = 0
                    for (col in 0 until dividerCount) {
                        dividerX += colWidths[col]
                        colDividerPlaceables[col].placeRelative((dividerX - dividerWidthPx / 2).coerceAtLeast(0), 0)
                    }

                    var rowY = 0
                    for (r in 0 until totalRows) {
                        var colX = 0
                        val rowH = rowHeights[r]
                        for (col in 0 until colCount) {
                            val placeable = cellPlaceables[r][col]
                            val cellY = rowY + (rowH - placeable.height) / 2
                            placeable.placeRelative(colX, cellY)
                            colX += colWidths[col]
                        }
                        rowY += rowH
                    }
                }
            }
        }
    }
}

private fun buildInlineAnnotatedString(
    inlines: List<MarkdownInline>,
    tokens: MarkdownStyleTokens,
    codeFontSize: TextUnit,
    uriHandler: UriHandler,
): AnnotatedString = buildAnnotatedString {
    appendInlines(
        inlines = inlines,
        tokens = tokens,
        codeFontSize = codeFontSize,
        uriHandler = uriHandler,
    )
}

private fun AnnotatedString.Builder.appendInlines(
    inlines: List<MarkdownInline>,
    tokens: MarkdownStyleTokens,
    codeFontSize: TextUnit,
    uriHandler: UriHandler,
) {
    for (node in inlines) {
        when (node) {
            is MarkdownInline.Text -> append(node.text)
            is MarkdownInline.Bold -> {
                val tag = pushStyle(SpanStyle(fontWeight = FontWeight.Bold))
                appendInlines(node.children, tokens, codeFontSize, uriHandler)
                pop(tag)
            }
            is MarkdownInline.Italic -> {
                val tag = pushStyle(SpanStyle(fontStyle = FontStyle.Italic))
                appendInlines(node.children, tokens, codeFontSize, uriHandler)
                pop(tag)
            }
            is MarkdownInline.Strikethrough -> {
                val tag = pushStyle(
                    SpanStyle(
                        textDecoration = TextDecoration.LineThrough,
                        color = tokens.secondaryText,
                    ),
                )
                appendInlines(node.children, tokens, codeFontSize, uriHandler)
                pop(tag)
            }
            is MarkdownInline.Code -> {
                val tag = pushStyle(
                    SpanStyle(
                        fontFamily = FontFamily.Monospace,
                        fontSize = codeFontSize,
                        color = tokens.inlineCodeText,
                        background = tokens.inlineCodeBg,
                    ),
                )
                append(node.code)
                pop(tag)
            }
            is MarkdownInline.Link -> {
                val openable = isWebOrMailUrl(node.url)
                if (openable) {
                    val linkTag = pushLink(
                        LinkAnnotation.Url(
                            url = node.url,
                            styles = TextLinkStyles(
                                style = SpanStyle(
                                    color = tokens.linkColor,
                                    textDecoration = TextDecoration.Underline,
                                ),
                            ),
                            linkInteractionListener = LinkInteractionListener {
                                runCatching { uriHandler.openUri(node.url) }
                            },
                        ),
                    )
                    appendInlines(node.label, tokens, codeFontSize, uriHandler)
                    pop(linkTag)
                } else {
                    val styleTag = pushStyle(
                        SpanStyle(
                            color = tokens.linkColor,
                            fontWeight = FontWeight.Medium,
                        ),
                    )
                    appendInlines(node.label, tokens, codeFontSize, uriHandler)
                    pop(styleTag)
                }
            }
            MarkdownInline.LineBreak -> append('\n')
        }
    }
}

private fun isWebOrMailUrl(url: String): Boolean {
    val lower = url.trim().lowercase()
    return lower.startsWith("https://") ||
        lower.startsWith("http://") ||
        lower.startsWith("mailto:")
}
