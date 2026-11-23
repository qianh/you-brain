package ai.youbrain.mobile

import ai.youbrain.mobile.ui.markdown.MarkdownBlock
import ai.youbrain.mobile.ui.markdown.MarkdownInline
import ai.youbrain.mobile.ui.markdown.TableAlignment
import ai.youbrain.mobile.ui.markdown.computeTableColumnWidths
import ai.youbrain.mobile.ui.markdown.parseInlines
import ai.youbrain.mobile.ui.markdown.parseMarkdown
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownParserTest {

    @Test
    fun parsesScreenshotDeviceTableReply() {
        val reply = """
            当前有 **4** 台已入网设备在线，中转已连通。

            | 设备 | 状态 |
            |---|---|
            | V2436A | 在线，未开启接收派活 |
            | VPS 主控 | 在线，本机，接受派活（可派项目：root、project） |
            | qianhongdeMacBook-Air | 在线，接受派活 |
            | 我的 Mac | 在线，接受派活 |

            另外两台「模拟 Mac A / B」离线且未入网，不计入。
        """.trimIndent()

        val blocks = parseMarkdown(reply)
        assertEquals(3, blocks.size)

        val p1 = blocks[0] as MarkdownBlock.Paragraph
        assertEquals(
            listOf(
                MarkdownInline.Text("当前有 "),
                MarkdownInline.Bold(listOf(MarkdownInline.Text("4"))),
                MarkdownInline.Text(" 台已入网设备在线，中转已连通。"),
            ),
            p1.inlines,
        )

        val table = blocks[1] as MarkdownBlock.Table
        assertEquals(listOf(TableAlignment.START, TableAlignment.START), table.alignments)
        assertEquals(
            listOf(
                listOf(MarkdownInline.Text("设备")),
                listOf(MarkdownInline.Text("状态")),
            ),
            table.headers,
        )
        assertEquals(4, table.rows.size)
        assertEquals("V2436A", (table.rows[0][0].single() as MarkdownInline.Text).text)
        assertEquals(
            "在线，本机，接受派活（可派项目：root、project）",
            (table.rows[1][1].single() as MarkdownInline.Text).text,
        )
        assertEquals("我的 Mac", (table.rows[3][0].single() as MarkdownInline.Text).text)

        val p2 = blocks[2] as MarkdownBlock.Paragraph
        assertEquals(
            listOf(MarkdownInline.Text("另外两台「模拟 Mac A / B」离线且未入网，不计入。")),
            p2.inlines,
        )
    }

    @Test
    fun parsesTableAlignmentsEscapedPipesCodePipesAndJaggedRows() {
        val md = """
            设备 | 状态 | 数量
            :--- | :---: | ---:
            `a | b` | escaped \| pipe | 10
            short | onlyTwo
            extra | c2 | c3 | c4
        """.trimIndent()

        val blocks = parseMarkdown(md)
        assertEquals(1, blocks.size)
        val table = blocks[0] as MarkdownBlock.Table
        assertEquals(
            listOf(TableAlignment.START, TableAlignment.CENTER, TableAlignment.END),
            table.alignments,
        )
        assertEquals(3, table.headers.size)
        assertEquals(3, table.rows.size)
        assertEquals(listOf(MarkdownInline.Code("a | b")), table.rows[0][0])
        assertEquals(listOf(MarkdownInline.Text("escaped | pipe")), table.rows[0][1])
        assertEquals(listOf(MarkdownInline.Text("10")), table.rows[0][2])
        assertEquals(emptyList<MarkdownInline>(), table.rows[1][2])
        assertEquals(3, table.rows[2].size)
    }

    @Test
    fun parsesTableImmediatelyFollowingParagraphWithoutBlankLine() {
        val md = """
            结果如下：
            | 项 | 值 |
            | --- | --- |
            | CPU | 12% |
        """.trimIndent()

        val blocks = parseMarkdown(md)
        assertEquals(2, blocks.size)
        assertTrue(blocks[0] is MarkdownBlock.Paragraph)
        assertTrue(blocks[1] is MarkdownBlock.Table)
    }

    @Test
    fun preservesIntrawordUnderscoresWhileSupportingCjkBoldAndLinks() {
        val inlines = parseInlines(
            "检查 `t3_boot_seed.zip` 与 snake_case_name，共**「4」**台，详情见 [AgentScreen.kt](/abs/AgentScreen.kt:42) 或 https://example.com/a_b（已连通）。",
        )
        assertTrue(inlines.contains(MarkdownInline.Code("t3_boot_seed.zip")))
        assertTrue(
            inlines.any { it is MarkdownInline.Text && it.text.contains("snake_case_name") },
        )
        assertTrue(
            inlines.contains(MarkdownInline.Bold(listOf(MarkdownInline.Text("「4」")))),
        )
        val localLink = inlines.filterIsInstance<MarkdownInline.Link>()
            .first { it.url == "/abs/AgentScreen.kt:42" }
        assertEquals(listOf(MarkdownInline.Text("AgentScreen.kt")), localLink.label)
        val webLink = inlines.filterIsInstance<MarkdownInline.Link>()
            .first { it.url == "https://example.com/a_b" }
        assertEquals(listOf(MarkdownInline.Text("https://example.com/a_b")), webLink.label)
        assertTrue(inlines.last() is MarkdownInline.Text)
        assertEquals("（已连通）。", (inlines.last() as MarkdownInline.Text).text)
    }

    @Test
    fun parsesInlineEmphasisStrikethroughCodeEscapesAndImages() {
        val inlines = parseInlines(
            "***both*** *em* _u_ ~~old~~ `` inner `code` `` \\*escaped\\* ![图](https://img.test/a.png) <https://a.dev/x_(1)>",
        )
        assertTrue(
            inlines.contains(MarkdownInline.Bold(listOf(MarkdownInline.Italic(listOf(MarkdownInline.Text("both")))))),
        )
        assertTrue(inlines.contains(MarkdownInline.Italic(listOf(MarkdownInline.Text("em")))))
        assertTrue(inlines.contains(MarkdownInline.Italic(listOf(MarkdownInline.Text("u")))))
        assertTrue(inlines.contains(MarkdownInline.Strikethrough(listOf(MarkdownInline.Text("old")))))
        assertTrue(inlines.contains(MarkdownInline.Code("inner `code`")))
        assertTrue(inlines.any { it is MarkdownInline.Text && it.text.contains("*escaped*") })
        assertTrue(
            inlines.contains(MarkdownInline.Link(listOf(MarkdownInline.Text("图")), "https://img.test/a.png")),
        )
        assertTrue(
            inlines.contains(MarkdownInline.Link(listOf(MarkdownInline.Text("https://a.dev/x_(1)")), "https://a.dev/x_(1)")),
        )
    }

    @Test
    fun parsesHeadingsFencedCodeBlocksListsBlockquotesAndSeparators() {
        val md = """
            # 一级标题 ##
            ###### 六级
            #123 不是标题

            > 引用第一行
            > > 嵌套引用

            - [x] 已完成任务
            - [ ] 待办任务
              - 子项 A

            3. 第三步
            4. 第四步

            ---

            ```kotlin
            val x = 1
            ```

            ~~~json
            {"ok": true}
            ~~~
        """.trimIndent()

        val blocks = parseMarkdown(md)
        assertEquals(9, blocks.size)

        val h1 = blocks[0] as MarkdownBlock.Heading
        assertEquals(1, h1.level)
        assertEquals(listOf(MarkdownInline.Text("一级标题")), h1.inlines)

        val h6 = blocks[1] as MarkdownBlock.Heading
        assertEquals(6, h6.level)

        val notHeading = blocks[2] as MarkdownBlock.Paragraph
        assertEquals(listOf(MarkdownInline.Text("#123 不是标题")), notHeading.inlines)

        val quote = blocks[3] as MarkdownBlock.BlockQuote
        assertEquals(2, quote.blocks.size)
        assertTrue(quote.blocks[0] is MarkdownBlock.Paragraph)
        assertTrue(quote.blocks[1] is MarkdownBlock.BlockQuote)

        val bulletList = blocks[4] as MarkdownBlock.BulletList
        assertEquals(2, bulletList.items.size)
        assertEquals(true, bulletList.items[0].checked)
        assertEquals(false, bulletList.items[1].checked)
        assertEquals(2, bulletList.items[1].blocks.size)
        assertTrue(bulletList.items[1].blocks[1] is MarkdownBlock.BulletList)

        val orderedList = blocks[5] as MarkdownBlock.OrderedList
        assertEquals(3, orderedList.startNumber)
        assertEquals(2, orderedList.items.size)

        assertEquals(MarkdownBlock.ThematicBreak, blocks[6])

        val kotlinBlock = blocks[7] as MarkdownBlock.CodeBlock
        assertEquals("kotlin", kotlinBlock.language)
        assertEquals("val x = 1", kotlinBlock.code)

        val jsonBlock = blocks[8] as MarkdownBlock.CodeBlock
        assertEquals("json", jsonBlock.language)
        assertEquals("{\"ok\": true}", jsonBlock.code)
    }

    @Test
    fun emitsUnclosedStreamingCodeBlockAtEof() {
        val blocks = parseMarkdown("```ts\nconst ok = true")
        assertEquals(1, blocks.size)
        val code = blocks[0] as MarkdownBlock.CodeBlock
        assertEquals("ts", code.language)
        assertEquals("const ok = true", code.code)
    }

    @Test
    fun preservesParagraphLineBreaksAndHandlesMalformedMarkdownSafely() {
        val paraBlocks = parseMarkdown("状态：在线  \n延迟：12ms")
        assertEquals(1, paraBlocks.size)
        val para = paraBlocks[0] as MarkdownBlock.Paragraph
        assertEquals(
            listOf(
                MarkdownInline.Text("状态：在线"),
                MarkdownInline.LineBreak,
                MarkdownInline.Text("延迟：12ms"),
            ),
            para.inlines,
        )

        assertTrue(parseMarkdown("").isEmpty())
        assertTrue(parseMarkdown("   \n\t ").isEmpty())

        val malformed = parseMarkdown("**unclosed `tick [link](http://x")
        assertEquals(1, malformed.size)
        assertFalse((malformed[0] as MarkdownBlock.Paragraph).inlines.isEmpty())

        val deepQuotes = "> ".repeat(20) + "deep"
        val deepBlocks = parseMarkdown(deepQuotes)
        assertFalse(deepBlocks.isEmpty())
    }

    @Test
    fun computesResponsiveTableColumnWidths() {
        // Fits natively
        assertArrayEquals(
            intArrayOf(120, 180),
            computeTableColumnWidths(
                naturalWidths = intArrayOf(120, 180),
                availableWidthPx = 400,
                minColPx = 48,
                maxColPx = 220,
                comfortableMinPx = 88,
            ),
        )

        // 2-col table proportionally fitted to availableWidth without horizontal scroll
        val fittedTwoCol = computeTableColumnWidths(
            naturalWidths = intArrayOf(180, 320),
            availableWidthPx = 300,
            minColPx = 48,
            maxColPx = 220,
            comfortableMinPx = 88,
        )
        assertEquals(300, fittedTwoCol.sum())
        assertTrue(fittedTwoCol[0] >= 88 && fittedTwoCol[1] >= 88)

        // 2-col with one short locked column and one wide flexible column
        val lockedAndFlex = computeTableColumnWidths(
            naturalWidths = intArrayOf(64, 320),
            availableWidthPx = 260,
            minColPx = 48,
            maxColPx = 220,
            comfortableMinPx = 88,
        )
        assertArrayEquals(intArrayOf(64, 196), lockedAndFlex)

        // 4-col wide table falls back to clamped widths for smooth horizontal scrolling
        assertArrayEquals(
            intArrayOf(140, 160, 180, 200),
            computeTableColumnWidths(
                naturalWidths = intArrayOf(140, 160, 180, 200),
                availableWidthPx = 320,
                minColPx = 48,
                maxColPx = 220,
                comfortableMinPx = 88,
            ),
        )

        // Single-column clamp safety
        assertArrayEquals(
            intArrayOf(200),
            computeTableColumnWidths(
                naturalWidths = intArrayOf(350),
                availableWidthPx = 200,
                minColPx = 48,
                maxColPx = 220,
                comfortableMinPx = 88,
            ),
        )
    }
}
