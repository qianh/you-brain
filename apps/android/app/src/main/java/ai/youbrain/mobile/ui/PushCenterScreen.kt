package ai.youbrain.mobile.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.youbrain.mobile.data.MobilePushItem
import ai.youbrain.mobile.net.AppUiState
import ai.youbrain.mobile.net.UBrainRepository
import ai.youbrain.mobile.ui.components.IosHairline
import ai.youbrain.mobile.ui.components.IosIconBadge
import ai.youbrain.mobile.ui.components.IosIcons
import ai.youbrain.mobile.ui.components.IosSegmentedControl
import ai.youbrain.mobile.ui.markdown.MarkdownContent
import ai.youbrain.mobile.ui.theme.IosTheme
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private val KIND_FILTERS = listOf(
    "all" to "全部",
    "t3" to "T3",
    "tty7" to "终端",
    "dispatch" to "派活",
    "reminder" to "提醒",
)

@Composable
fun PushCenterScreen(
    state: AppUiState,
    repository: UBrainRepository,
    onOpenDeviceT3: (deviceId: String, threadUrl: String?) -> Unit,
    onOpenDeviceTerminal: (deviceId: String, pane: Int?, title: String) -> Unit = { _, _, _ -> },
) {
    val c = IosTheme.colors
    val scope = rememberCoroutineScope()
    val screenWidthDp = LocalConfiguration.current.screenWidthDp.dp
    val markdownMaxWidth = (screenWidthDp - 56.dp).coerceAtLeast(180.dp)
    var filter by remember { mutableStateOf("all") }
    var refreshing by remember { mutableStateOf(false) }
    var expandedSeqs by remember { mutableStateOf(setOf<Long>()) }
    val filtered = remember(state.pushes, filter) {
        if (filter == "all") state.pushes
        else state.pushes.filter { it.kind == filter }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(c.groupedBg),
    ) {
        Column(modifier = Modifier.fillMaxWidth().background(c.chromeBg)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                IosSegmentedControl(
                    items = KIND_FILTERS,
                    selectedKey = filter,
                    onSelect = { filter = it },
                    modifier = Modifier.weight(1f),
                )
                Box(
                    modifier = Modifier
                        .size(30.dp)
                        .clip(CircleShape)
                        .background(c.tertiaryFill)
                        .clickable(enabled = !refreshing) {
                            refreshing = true
                            scope.launch {
                                repository.refreshPushesNow()
                                refreshing = false
                            }
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    if (refreshing) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(14.dp),
                            strokeWidth = 1.8.dp,
                            color = c.blue,
                        )
                    } else {
                        Icon(
                            imageVector = IosIcons.Refresh,
                            contentDescription = "刷新通知",
                            tint = c.blue,
                            modifier = Modifier.size(15.dp),
                        )
                    }
                }
            }
            IosHairline()
        }

        if (filtered.isEmpty()) {
            Box(
                modifier = Modifier.fillMaxSize().padding(24.dp),
                contentAlignment = Alignment.Center,
            ) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(16.dp))
                        .background(c.cardBg)
                        .padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    IosIconBadge(icon = IosIcons.Bell, background = c.orange)
                    Text("暂无通知", fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = c.label)
                    Text(
                        text = "各台设备上的终端待回复、T3 完成/等待、跨设备派活进展和 U-Brain 提醒都会实时汇总到这里。",
                        fontSize = 13.5.sp,
                        lineHeight = 19.sp,
                        color = c.secondaryLabel,
                        textAlign = TextAlign.Center,
                    )
                }
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(14.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(filtered, key = { it.seq }) { item ->
                    val isExpanded = item.seq in expandedSeqs
                    PushCard(
                        item = item,
                        expanded = isExpanded,
                        onToggleExpand = {
                            expandedSeqs = if (isExpanded) {
                                expandedSeqs - item.seq
                            } else {
                                expandedSeqs + item.seq
                            }
                        },
                        deviceDisplayName = state.displayName(item.deviceId, item.deviceName),
                        canViewT3 = state.relayState.devices.any {
                            it.id == item.deviceId && it.dispatch?.viewT3 == true
                        },
                        markdownMaxWidth = markdownMaxWidth,
                        repository = repository,
                        onOpenT3 = { onOpenDeviceT3(item.deviceId, item.link) },
                        onOpenTerminal = {
                            onOpenDeviceTerminal(
                                item.deviceId,
                                TerminalLogic.parsePaneFromPush(item),
                                item.title.removePrefix("⏳ ").removePrefix("✅ ").trim(),
                            )
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun PushCard(
    item: MobilePushItem,
    expanded: Boolean,
    onToggleExpand: () -> Unit,
    deviceDisplayName: String,
    canViewT3: Boolean,
    markdownMaxWidth: Dp,
    repository: UBrainRepository,
    onOpenT3: () -> Unit,
    onOpenTerminal: () -> Unit,
) {
    val c = IosTheme.colors
    val scope = rememberCoroutineScope()
    val timeText = remember(item.ts) {
        SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(item.ts))
    }
    val bodySummary = remember(item.body, item.kind) {
        summarizePushBody(item.body, item.kind)
    }
    val hasBody = bodySummary.previewText.isNotEmpty()
    var titleOverflowed by remember(item.seq, item.title) { mutableStateOf(false) }
    var previewOverflowed by remember(item.seq, item.body) { mutableStateOf(false) }
    val canExpand = expanded ||
        titleOverflowed ||
        (hasBody && (bodySummary.hasExtraOrRichContent || previewOverflowed))
    val chevronRotation by animateFloatAsState(
        targetValue = if (expanded) 180f else 0f,
        label = "pushCardChevron",
    )

    var replyOpen by remember { mutableStateOf(false) }
    var replyDraft by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var feedback by remember { mutableStateOf<String?>(null) }

    val badgeColor = kindColor(item.kind)
    val badgeIcon = kindIcon(item.kind)

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(c.cardBg)
            .then(
                if (!expanded && canExpand) {
                    Modifier.clickable(onClick = onToggleExpand)
                } else {
                    Modifier
                },
            )
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .then(
                    if (expanded) {
                        Modifier
                            .clip(RoundedCornerShape(8.dp))
                            .clickable(onClick = onToggleExpand)
                    } else {
                        Modifier
                    },
                ),
            verticalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Box(
                    modifier = Modifier
                        .size(22.dp)
                        .clip(RoundedCornerShape(6.dp))
                        .background(badgeColor),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = badgeIcon,
                        contentDescription = null,
                        tint = Color.White,
                        modifier = Modifier.size(13.dp),
                    )
                }
                Text(
                    text = "$deviceDisplayName · ${kindLabel(item.kind)}",
                    fontSize = 12.5.sp,
                    fontWeight = FontWeight.Medium,
                    color = c.secondaryLabel,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = timeText,
                    fontSize = 12.sp,
                    color = c.secondaryLabel,
                    softWrap = false,
                )
                if (canExpand) {
                    Icon(
                        imageVector = IosIcons.ChevronDown,
                        contentDescription = if (expanded) "收起消息" else "展开消息",
                        tint = c.secondaryLabel,
                        modifier = Modifier
                            .size(14.dp)
                            .rotate(chevronRotation),
                    )
                }
            }

            Text(
                text = item.title,
                fontSize = 15.5.sp,
                lineHeight = 21.sp,
                fontWeight = FontWeight.SemiBold,
                color = c.label,
                maxLines = if (expanded) Int.MAX_VALUE else 2,
                overflow = TextOverflow.Ellipsis,
                onTextLayout = { result ->
                    if (!expanded && result.hasVisualOverflow) {
                        titleOverflowed = true
                    }
                },
            )
        }

        if (hasBody) {
            if (expanded) {
                SelectionContainer {
                    if (item.kind == "tty7") {
                        val termBg = if (c.isDark) Color(0xFF141416) else Color(0xFFF5F5F7)
                        val termBorder = c.separator.copy(alpha = if (c.isDark) 0.65f else 0.55f)
                        val termShape = RoundedCornerShape(10.dp)
                        Box(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(termShape)
                                .background(termBg)
                                .border(0.5.dp, termBorder, termShape)
                                .padding(horizontal = 11.dp, vertical = 9.dp),
                        ) {
                            Text(
                                text = item.body.trim(),
                                fontFamily = FontFamily.Monospace,
                                fontSize = 12.5.sp,
                                lineHeight = 18.sp,
                                color = c.label,
                            )
                        }
                    } else {
                        MarkdownContent(
                            markdown = item.body,
                            maxContentWidth = markdownMaxWidth,
                            modifier = Modifier.fillMaxWidth(),
                        )
                    }
                }
            } else {
                Text(
                    text = bodySummary.previewText,
                    fontSize = 13.5.sp,
                    lineHeight = 19.sp,
                    color = c.secondaryLabel,
                    maxLines = PUSH_PREVIEW_MAX_LINES,
                    overflow = TextOverflow.Ellipsis,
                    onTextLayout = { result ->
                        if (result.hasVisualOverflow) {
                            previewOverflowed = true
                        }
                    },
                )
            }
        }

        if (feedback != null) {
            Text(
                text = feedback!!,
                fontSize = 12.5.sp,
                color = if (feedback!!.startsWith("✓")) c.green else c.red,
                fontWeight = FontWeight.Medium,
            )
        }

        val hasReply = !item.replyToken.isNullOrBlank()
        if (hasReply || canViewT3 || canExpand) {
            IosHairline()
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (hasReply) {
                    Text(
                        text = if (replyOpen) "收起回复" else "快捷回复",
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Medium,
                        color = c.blue,
                        modifier = Modifier
                            .clip(RoundedCornerShape(6.dp))
                            .clickable { replyOpen = !replyOpen }
                            .padding(horizontal = 4.dp, vertical = 2.dp),
                    )
                }
                if (canViewT3) {
                    val isTty7 = item.kind == "tty7"
                    Text(
                        text = if (isTty7) "打开终端" else "打开设备 T3",
                        fontSize = 14.sp,
                        fontWeight = FontWeight.Medium,
                        color = c.blue,
                        modifier = Modifier
                            .clip(RoundedCornerShape(6.dp))
                            .clickable(onClick = if (isTty7) onOpenTerminal else onOpenT3)
                            .padding(horizontal = 4.dp, vertical = 2.dp),
                    )
                }
                Spacer(modifier = Modifier.weight(1f))
                if (canExpand) {
                    Row(
                        modifier = Modifier
                            .clip(RoundedCornerShape(6.dp))
                            .clickable(onClick = onToggleExpand)
                            .padding(horizontal = 4.dp, vertical = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(3.dp),
                    ) {
                        Text(
                            text = if (expanded) "收起" else "展开",
                            fontSize = 13.5.sp,
                            fontWeight = FontWeight.Medium,
                            color = c.blue,
                        )
                        Icon(
                            imageVector = IosIcons.ChevronDown,
                            contentDescription = null,
                            tint = c.blue,
                            modifier = Modifier
                                .size(13.dp)
                                .rotate(chevronRotation),
                        )
                    }
                }
            }
        }

        if (replyOpen) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(top = 2.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(18.dp))
                        .background(if (c.isDark) Color(0xFF2C2C2E) else Color(0xFFF2F2F7))
                        .border(0.5.dp, c.separator.copy(alpha = 0.5f), RoundedCornerShape(18.dp))
                        .padding(horizontal = 14.dp, vertical = 9.dp),
                ) {
                    if (replyDraft.isEmpty()) {
                        Text(
                            text = "输入回复直达原会话…",
                            fontSize = 14.sp,
                            color = c.secondaryLabel,
                            maxLines = 1,
                        )
                    }
                    BasicTextField(
                        value = replyDraft,
                        onValueChange = { replyDraft = it },
                        singleLine = true,
                        textStyle = TextStyle(fontSize = 14.sp, color = c.label),
                        cursorBrush = SolidColor(c.blue),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                val canSend = !sending && replyDraft.isNotBlank()
                Box(
                    modifier = Modifier
                        .size(34.dp)
                        .clip(CircleShape)
                        .background(if (canSend) c.blue else c.tertiaryFill)
                        .clickable(enabled = canSend) {
                            val text = replyDraft.trim()
                            if (text.isEmpty()) return@clickable
                            sending = true
                            scope.launch {
                                val res = repository.replyToPush(item, text)
                                sending = false
                                res.fold(
                                    onSuccess = {
                                        replyDraft = ""
                                        replyOpen = false
                                        feedback = "✓ 已发送到 ${it.targetName.ifBlank { deviceDisplayName }}"
                                    },
                                    onFailure = {
                                        feedback = "回复失败：${it.message}"
                                    },
                                )
                            }
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = IosIcons.ArrowUp,
                        contentDescription = "发送",
                        tint = if (canSend) Color.White else c.secondaryLabel,
                        modifier = Modifier.size(18.dp),
                    )
                }
            }
        }
    }
}

private fun kindLabel(kind: String): String = when (kind) {
    "t3" -> "T3 会话"
    "tty7" -> "终端会话"
    "dispatch" -> "跨设备派活"
    "reminder" -> "记忆提醒"
    else -> "通知"
}

@Composable
private fun kindColor(kind: String): Color = when (kind) {
    "t3" -> IosTheme.colors.indigo
    "tty7" -> Color(0xFF3A3A3C)
    "dispatch" -> IosTheme.colors.blue
    "reminder" -> IosTheme.colors.orange
    else -> IosTheme.colors.teal
}

private fun kindIcon(kind: String): ImageVector = when (kind) {
    "t3" -> IosIcons.TerminalWindow
    "tty7" -> IosIcons.Laptop
    "dispatch" -> IosIcons.Layers
    else -> IosIcons.Bell
}
