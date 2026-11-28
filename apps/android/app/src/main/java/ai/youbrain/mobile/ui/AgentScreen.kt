package ai.youbrain.mobile.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.StartOffset
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.youbrain.mobile.data.AgentMessage
import ai.youbrain.mobile.data.OutboxEntry
import ai.youbrain.mobile.data.RelayDevice
import ai.youbrain.mobile.net.AppUiState
import ai.youbrain.mobile.net.UBrainRepository
import ai.youbrain.mobile.ui.components.IosHairline
import ai.youbrain.mobile.ui.components.IosIconBadge
import ai.youbrain.mobile.ui.components.IosIcons
import ai.youbrain.mobile.ui.components.IosModalSheet
import ai.youbrain.mobile.ui.components.IosTextField
import ai.youbrain.mobile.ui.markdown.MarkdownContent
import ai.youbrain.mobile.ui.theme.IosTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

@Composable
fun AgentScreen(
    state: AppUiState,
    repository: UBrainRepository,
    onOpenDeviceT3: (deviceId: String, threadUrl: String?) -> Unit,
) {
    val c = IosTheme.colors
    val scope = rememberCoroutineScope()
    val agent = state.agent
    val listState = rememberLazyListState()

    var input by remember { mutableStateOf("") }
    var showKanban by remember { mutableStateOf(false) }
    var showControlMenu by remember { mutableStateOf(false) }
    var showDirectDispatch by remember { mutableStateOf(false) }
    var followupTarget by remember { mutableStateOf<OutboxEntry?>(null) }
    var actionFeedback by remember { mutableStateOf<String?>(null) }
    var renameTarget by remember { mutableStateOf<RelayDevice?>(null) }
    var elapsedSeconds by remember { mutableIntStateOf(0) }

    val allEnrolledPeers = remember(state.relayState.devices, state.deviceId) {
        state.relayState.devices.filter { it.id != state.deviceId && it.enrolled == true }
    }
    val masterDevice = allEnrolledPeers.firstOrNull { it.id == agent.masterDeviceId }
    val activeSession = agent.sessions.firstOrNull { it.sessionId == agent.activeSessionId }
    val isBusy = agent.conversationState == "running" || agent.sending

    // 自适应高频增量轮询（650ms -> 900ms -> 1100ms -> 1400ms），兼顾实时反馈与低负载
    LaunchedEffect(agent.masterDeviceId, agent.activeSessionId, agent.conversationState) {
        val mId = agent.masterDeviceId ?: return@LaunchedEffect
        if (agent.conversationState != "running") return@LaunchedEffect
        val intervals = longArrayOf(650L, 900L, 1_100L, 1_400L)
        var step = 0
        while (isActive) {
            delay(intervals[minOf(step, intervals.lastIndex)])
            step++
            repository.readAgentConversation(mId, agent.activeSessionId, incremental = true)
        }
    }

    // 实时思考/执行耗时计时器
    LaunchedEffect(isBusy) {
        if (!isBusy) {
            elapsedSeconds = 0
            return@LaunchedEffect
        }
        elapsedSeconds = 0
        while (isActive) {
            delay(1_000L)
            elapsedSeconds += 1
        }
    }

    val imeBottom = WindowInsets.ime.getBottom(LocalDensity.current)
    LaunchedEffect(agent.messages.size, isBusy, imeBottom > 0) {
        val total = agent.messages.size + if (isBusy) 1 else 0
        if (total > 0) {
            listState.animateScrollToItem(total - 1)
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(c.groupedBg),
    ) {
        // 顶部精简控制条：左侧主控+会话合并胶囊（弹性截断），右侧固定动作组
        Column(modifier = Modifier.fillMaxWidth().background(c.chromeBg)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Box(modifier = Modifier.weight(1f)) {
                    val dotColor = if (masterDevice?.online == true) c.green else c.secondaryLabel
                    val masterLabel = masterDevice?.let { state.displayName(it) } ?: "未选择主控"
                    val sessionLabel = activeSession?.title ?: "默认会话"
                    Row(
                        modifier = Modifier
                            .height(32.dp)
                            .clip(CircleShape)
                            .background(c.tertiaryFill)
                            .clickable { showControlMenu = true }
                            .padding(horizontal = 11.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        Box(
                            modifier = Modifier
                                .size(7.dp)
                                .clip(CircleShape)
                                .background(dotColor),
                        )
                        Text(
                            text = "$masterLabel · $sessionLabel",
                            fontSize = 13.sp,
                            fontWeight = FontWeight.Medium,
                            color = c.label,
                            maxLines = 1,
                            softWrap = false,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f, fill = false),
                        )
                        Icon(
                            imageVector = IosIcons.ChevronDown,
                            contentDescription = null,
                            tint = c.secondaryLabel,
                            modifier = Modifier.size(13.dp),
                        )
                    }

                    DropdownMenu(
                        expanded = showControlMenu,
                        onDismissRequest = { showControlMenu = false },
                    ) {
                        Text(
                            text = "切换主控设备",
                            fontSize = 11.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = c.secondaryLabel,
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                        )
                        allEnrolledPeers.forEach { dev ->
                            val tag = if (dev.dispatch?.role == "server") " [VPS]" else ""
                            val dot = if (dev.online) "● " else "○ "
                            val picked = dev.id == agent.masterDeviceId
                            DropdownMenuItem(
                                text = { Text("${if (picked) "✓ " else ""}$dot${state.displayName(dev)}$tag") },
                                onClick = {
                                    showControlMenu = false
                                    repository.selectMasterDevice(dev.id)
                                },
                            )
                        }
                        if (masterDevice != null) {
                            DropdownMenuItem(
                                text = { Text("✎ 修改当前主控名称…") },
                                onClick = {
                                    showControlMenu = false
                                    renameTarget = masterDevice
                                },
                            )
                        }
                        HorizontalDivider()
                        Text(
                            text = "主控会话列表",
                            fontSize = 11.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = c.secondaryLabel,
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                        )
                        agent.sessions.forEach { s ->
                            DropdownMenuItem(
                                text = {
                                    val prefix = if (s.sessionId == agent.activeSessionId) "✓ " else ""
                                    Text("$prefix${s.title} (${s.status})")
                                },
                                onClick = {
                                    showControlMenu = false
                                    scope.launch {
                                        repository.loadAgentSessions(agent.masterDeviceId, sessionId = s.sessionId)
                                    }
                                },
                            )
                        }
                        DropdownMenuItem(
                            text = { Text("+ 新建主控会话") },
                            onClick = {
                                showControlMenu = false
                                scope.launch {
                                    repository.loadAgentSessions(agent.masterDeviceId, create = true)
                                }
                            },
                        )
                    }
                }

                Row(
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    HeaderPillButton(
                        label = "看板 ${agent.outbox.size}",
                        icon = IosIcons.Layers,
                        active = showKanban,
                        onClick = { showKanban = !showKanban },
                    )
                    HeaderPillButton(
                        label = "派活",
                        icon = IosIcons.Plus,
                        tinted = true,
                        onClick = { showDirectDispatch = true },
                    )
                    if (masterDevice?.dispatch?.viewT3 == true) {
                        Box(
                            modifier = Modifier
                                .size(30.dp)
                                .clip(CircleShape)
                                .background(c.tertiaryFill)
                                .clickable { onOpenDeviceT3(masterDevice.id, agent.threadUrl) },
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                imageVector = IosIcons.ExternalLink,
                                contentDescription = "打开 T3",
                                tint = c.blue,
                                modifier = Modifier.size(15.dp),
                            )
                        }
                    }
                }
            }

            // 极速直连指令条：设备/任务状态直接走中转或 Hub 读取（毫秒级），无需等 Agent 大模型
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(start = 12.dp, end = 12.dp, bottom = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(7.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                QuickChip(
                    icon = IosIcons.Bolt,
                    label = "设备快查",
                    accent = c.orange,
                    onClick = { repository.runQuickDeviceInspect() },
                )
                QuickChip(
                    icon = IosIcons.Layers,
                    label = "派活进展",
                    accent = c.blue,
                    onClick = { scope.launch { repository.runQuickOutboxInspect() } },
                )
                QuickChip(
                    icon = IosIcons.Refresh,
                    label = if (agent.loading) "同步中…" else "同步对话",
                    accent = c.indigo,
                    onClick = {
                        if (!agent.loading) {
                            scope.launch {
                                val res = repository.syncAgentNow()
                                actionFeedback = res.fold(
                                    onSuccess = { "✓ 对话与在线状态已同步" },
                                    onFailure = { "同步失败：${it.message}" },
                                )
                            }
                        }
                    },
                )
            }
            IosHairline()
        }

        // 错误 & 反馈条
        AnimatedVisibility(visible = agent.error != null) {
            agent.error?.let { err ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(c.red.copy(alpha = 0.12f))
                        .padding(horizontal = 14.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = err,
                        color = c.red,
                        fontSize = 12.5.sp,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }

        AnimatedVisibility(visible = actionFeedback != null) {
            actionFeedback?.let { tip ->
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .background(c.blue.copy(alpha = 0.1f))
                        .padding(horizontal = 14.dp, vertical = 7.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = tip,
                        color = c.blue,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Medium,
                        modifier = Modifier.weight(1f),
                    )
                    Text(
                        text = "好",
                        color = c.blue,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.SemiBold,
                        modifier = Modifier
                            .clip(RoundedCornerShape(6.dp))
                            .clickable { actionFeedback = null }
                            .padding(horizontal = 8.dp, vertical = 2.dp),
                    )
                }
            }
        }

        // 可折叠派活看板
        AnimatedVisibility(visible = showKanban) {
            Column(modifier = Modifier.fillMaxWidth()) {
                OutboxKanbanPanel(
                    entries = agent.outbox,
                    displayNameOf = { id, raw -> state.displayName(id, raw) },
                    onRefresh = { entry ->
                        scope.launch {
                            actionFeedback = repository.refreshDispatch(entry.dispatchId).fold(
                                onSuccess = { "✓ 已同步：${entry.title}" },
                                onFailure = { "刷新失败：${it.message}" },
                            )
                        }
                    },
                    onFollowup = { entry -> followupTarget = entry },
                    onOpenT3 = { entry -> onOpenDeviceT3(entry.to, entry.threadUrl) },
                    onRefreshAll = {
                        scope.launch {
                            actionFeedback = repository.refreshOutboxListResult().fold(
                                onSuccess = { count -> "✓ 派活列表已刷新（共 $count 项）" },
                                onFailure = { "刷新失败：${it.message}" },
                            )
                        }
                    },
                )
                IosHairline()
            }
        }

        // 秒查结果卡片（纯本地/直读反馈，零 LLM 排队）
        AnimatedVisibility(visible = agent.quickInspectText != null) {
            agent.quickInspectText?.let { inspectText ->
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 12.dp, vertical = 8.dp)
                        .clip(RoundedCornerShape(14.dp))
                        .background(c.cardBg)
                        .border(0.5.dp, c.receivedBubbleBorder, RoundedCornerShape(14.dp))
                        .padding(12.dp),
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = "实时速览",
                            fontSize = 12.5.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = c.blue,
                        )
                        Text(
                            text = "收起",
                            fontSize = 12.5.sp,
                            color = c.secondaryLabel,
                            modifier = Modifier
                                .clip(RoundedCornerShape(6.dp))
                                .clickable { repository.dismissQuickInspect() }
                                .padding(horizontal = 6.dp, vertical = 2.dp),
                        )
                    }
                    SelectionContainer {
                        Text(
                            text = inspectText,
                            fontSize = 13.sp,
                            lineHeight = 18.sp,
                            color = c.label,
                        )
                    }
                }
            }
        }

        // 持续对话区域（iMessage 气泡）
        BoxWithConstraints(modifier = Modifier.weight(1f).fillMaxWidth()) {
            val chatWidth = (maxWidth - 24.dp).coerceAtLeast(240.dp)
            val userMaxWidth = (chatWidth * 0.80f).coerceAtMost(360.dp)
            val assistantMaxWidth = (chatWidth * 0.92f).coerceAtMost(640.dp)

            when {
                agent.masterDeviceId == null -> {
                    Box(modifier = Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(16.dp))
                                .background(c.cardBg)
                                .padding(24.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            IosIconBadge(icon = IosIcons.Server, background = c.blue)
                            Text("等待发现主控设备…", fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = c.label)
                            Text(
                                text = "请确认 VPS 或电脑端 U-Brain daemon 已入网，并开启了「接收跨设备派活」。",
                                fontSize = 13.5.sp,
                                lineHeight = 19.sp,
                                color = c.secondaryLabel,
                                textAlign = TextAlign.Center,
                            )
                        }
                    }
                }
                agent.messages.isEmpty() && !agent.loading && !isBusy -> {
                    Box(modifier = Modifier.fillMaxSize().padding(24.dp), contentAlignment = Alignment.Center) {
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(18.dp))
                                .background(c.cardBg)
                                .padding(22.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            Box(
                                modifier = Modifier
                                    .size(48.dp)
                                    .clip(RoundedCornerShape(14.dp))
                                    .background(
                                        Brush.linearGradient(listOf(c.blue, c.indigo)),
                                    ),
                                contentAlignment = Alignment.Center,
                            ) {
                                Icon(
                                    imageVector = IosIcons.BubbleSparkle,
                                    contentDescription = null,
                                    tint = Color.White,
                                    modifier = Modifier.size(24.dp),
                                )
                            }
                            Text(
                                text = "主控编排会话已就绪",
                                fontSize = 17.sp,
                                fontWeight = FontWeight.SemiBold,
                                color = c.label,
                            )
                            Text(
                                text = "直接对话让主控统筹调度各设备任务；如只看在线设备列表或派活状态，点上方「设备快查」可零等待出结果。",
                                fontSize = 13.sp,
                                lineHeight = 18.sp,
                                color = c.secondaryLabel,
                                textAlign = TextAlign.Center,
                            )
                            Spacer(modifier = Modifier.height(2.dp))
                            Box(
                                modifier = Modifier
                                    .clip(CircleShape)
                                    .background(c.blue.copy(alpha = 0.12f))
                                    .clickable {
                                        input = "帮我梳理各在线设备当前可派活的项目与状态"
                                    }
                                    .padding(horizontal = 14.dp, vertical = 8.dp),
                            ) {
                                Text(
                                    text = "填入示例：让主控梳理各设备任务",
                                    fontSize = 13.sp,
                                    fontWeight = FontWeight.Medium,
                                    color = c.blue,
                                )
                            }
                        }
                    }
                }
                else -> {
                    LazyColumn(
                        state = listState,
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 14.dp),
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        items(agent.messages, key = { "${it.position}-${it.role}" }) { msg ->
                            IosChatBubble(
                                message = msg,
                                userMaxWidth = userMaxWidth,
                                assistantMaxWidth = assistantMaxWidth,
                            )
                        }
                        if (isBusy) {
                            item(key = "live-typing-indicator") {
                                LiveTypingBubble(
                                    stageText = agent.activity ?: "主控正在思考与调度…",
                                    elapsedSeconds = elapsedSeconds,
                                )
                            }
                        }
                    }
                }
            }
        }

        // 底部 iMessage 风格胶囊输入条
        Column(modifier = Modifier.fillMaxWidth().background(c.chromeBg)) {
            IosHairline()
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Box(
                    modifier = Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(20.dp))
                        .background(c.cardBg)
                        .border(0.5.dp, c.separator.copy(alpha = 0.6f), RoundedCornerShape(20.dp))
                        .padding(horizontal = 14.dp, vertical = 9.dp),
                ) {
                    if (input.isEmpty()) {
                        Text(
                            text = if (isBusy) "执行中可继续排队发指令…" else "向主控发送指令…",
                            fontSize = 15.sp,
                            color = c.secondaryLabel,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    BasicTextField(
                        value = input,
                        onValueChange = { input = it },
                        maxLines = 5,
                        textStyle = TextStyle(fontSize = 15.sp, lineHeight = 20.sp, color = c.label),
                        cursorBrush = SolidColor(c.blue),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }

                val canSend = input.isNotBlank() && agent.masterDeviceId != null && !agent.sending
                Box(
                    modifier = Modifier
                        .size(36.dp)
                        .clip(CircleShape)
                        .background(if (canSend) c.blue else c.tertiaryFill)
                        .clickable(enabled = canSend) {
                            val text = input.trim()
                            if (text.isEmpty()) return@clickable
                            input = ""
                            scope.launch {
                                repository.sendAgentMessage(text)
                            }
                        },
                    contentAlignment = Alignment.Center,
                ) {
                    if (agent.sending) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(16.dp),
                            strokeWidth = 2.dp,
                            color = Color.White,
                        )
                    } else {
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

    // 追问特定派活任务
    followupTarget?.let { entry ->
        val peerName = state.displayName(entry.to, entry.deviceName)
        var text by remember { mutableStateOf("") }
        var busy by remember { mutableStateOf(false) }
        IosModalSheet(
            title = "追问：${entry.title}",
            onDismiss = { followupTarget = null },
            confirmText = if (busy) "发送中…" else "发送追问",
            confirmEnabled = !busy && text.isNotBlank(),
            dismissEnabled = !busy,
            onConfirm = {
                busy = true
                scope.launch {
                    val res = repository.followupDispatch(entry.dispatchId, text.trim())
                    busy = false
                    followupTarget = null
                    actionFeedback = res.fold(
                        onSuccess = { "✓ 已向 $peerName 追加指令" },
                        onFailure = { "追问失败: ${it.message}" },
                    )
                }
            },
        ) {
            Text(
                text = "目标设备：$peerName",
                fontSize = 13.sp,
                color = c.secondaryLabel,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth(),
            )
            IosTextField(
                value = text,
                onValueChange = { text = it },
                placeholder = "输入要追加的说明或返工要求…",
                singleLine = false,
                maxLines = 4,
            )
        }
    }

    if (showDirectDispatch) {
        DirectDispatchDialog(
            devices = allEnrolledPeers.filter { it.online && it.dispatch?.enabled == true },
            nameOf = { dev -> state.displayName(dev) },
            onDismiss = { showDirectDispatch = false },
            onDispatch = { toId, projId, title, prompt, mode ->
                scope.launch {
                    val res = repository.startDirectT3Task(toId, projId, title, prompt, mode)
                    showDirectDispatch = false
                    actionFeedback = res.fold(
                        onSuccess = { "✓ 已派出任务（权限 ${it.mode}）" },
                        onFailure = { "派活失败: ${it.message}" },
                    )
                }
            },
        )
    }

    renameTarget?.let { dev ->
        RenameDeviceDialog(
            rawName = dev.name,
            currentDisplayName = state.displayName(dev),
            isSelf = false,
            hasAlias = state.hasCustomAlias(dev.id),
            onConfirm = { draft ->
                repository.renameDevice(dev.id, draft)
                renameTarget = null
            },
            onReset = {
                repository.renameDevice(dev.id, "")
                renameTarget = null
            },
            onDismiss = { renameTarget = null },
        )
    }
}

@Composable
private fun HeaderPillButton(
    label: String,
    icon: ImageVector,
    active: Boolean = false,
    tinted: Boolean = false,
    onClick: () -> Unit,
) {
    val c = IosTheme.colors
    val bg = when {
        active -> c.blue
        tinted -> c.blue.copy(alpha = if (c.isDark) 0.24f else 0.12f)
        else -> c.tertiaryFill
    }
    val fg = when {
        active -> Color.White
        tinted -> c.blue
        else -> c.label
    }
    Row(
        modifier = Modifier
            .height(30.dp)
            .clip(CircleShape)
            .background(bg)
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = fg,
            modifier = Modifier.size(13.dp),
        )
        Text(
            text = label,
            fontSize = 12.5.sp,
            fontWeight = FontWeight.Medium,
            color = fg,
            maxLines = 1,
            softWrap = false,
        )
    }
}

@Composable
private fun QuickChip(
    icon: ImageVector,
    label: String,
    accent: Color,
    onClick: () -> Unit,
) {
    val c = IosTheme.colors
    Row(
        modifier = Modifier
            .height(27.dp)
            .clip(CircleShape)
            .background(c.cardBg)
            .border(0.5.dp, c.separator.copy(alpha = 0.55f), CircleShape)
            .clickable(onClick = onClick)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = accent,
            modifier = Modifier.size(12.dp),
        )
        Text(
            text = label,
            fontSize = 12.sp,
            fontWeight = FontWeight.Medium,
            color = c.label,
            maxLines = 1,
            softWrap = false,
        )
    }
}

@Composable
private fun IosChatBubble(
    message: AgentMessage,
    userMaxWidth: Dp,
    assistantMaxWidth: Dp,
) {
    val c = IosTheme.colors
    val isUser = message.role == "user"
    val bubbleShape = RoundedCornerShape(
        topStart = 18.dp,
        topEnd = 18.dp,
        bottomStart = if (isUser) 18.dp else 5.dp,
        bottomEnd = if (isUser) 5.dp else 18.dp,
    )
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
    ) {
        Box(
            modifier = Modifier
                .widthIn(max = if (isUser) userMaxWidth else assistantMaxWidth)
                .clip(bubbleShape)
                .background(if (isUser) c.sentBubble else c.receivedBubble)
                .then(
                    if (isUser) Modifier
                    else Modifier.border(0.5.dp, c.receivedBubbleBorder, bubbleShape),
                )
                .padding(horizontal = 14.dp, vertical = 10.dp),
        ) {
            SelectionContainer {
                if (isUser) {
                    Text(
                        text = message.text,
                        color = Color.White,
                        fontSize = 15.sp,
                        lineHeight = 21.sp,
                    )
                } else {
                    MarkdownContent(
                        markdown = message.text,
                        maxContentWidth = (assistantMaxWidth - 28.dp).coerceAtLeast(180.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun LiveTypingBubble(
    stageText: String,
    elapsedSeconds: Int,
) {
    val c = IosTheme.colors
    val transition = rememberInfiniteTransition(label = "typingDots")
    val dots = (0..2).map { idx ->
        transition.animateFloat(
            initialValue = 0.25f,
            targetValue = 1.0f,
            animationSpec = infiniteRepeatable(
                animation = tween(550),
                repeatMode = RepeatMode.Reverse,
                initialStartOffset = StartOffset(idx * 170),
            ),
            label = "dot$idx",
        )
    }
    val shape = RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp, bottomStart = 5.dp, bottomEnd = 18.dp)
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.Start,
    ) {
        Row(
            modifier = Modifier
                .clip(shape)
                .background(c.receivedBubble)
                .border(0.5.dp, c.receivedBubbleBorder, shape)
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                dots.forEach { alphaState ->
                    Box(
                        modifier = Modifier
                            .size(6.dp)
                            .alpha(alphaState.value)
                            .clip(CircleShape)
                            .background(c.blue),
                    )
                }
            }
            Text(
                text = if (elapsedSeconds > 0) "$stageText (${elapsedSeconds}s)" else stageText,
                fontSize = 13.sp,
                color = c.secondaryLabel,
            )
        }
    }
}

@Composable
private fun OutboxKanbanPanel(
    entries: List<OutboxEntry>,
    displayNameOf: (id: String, rawName: String) -> String,
    onRefresh: (OutboxEntry) -> Unit,
    onFollowup: (OutboxEntry) -> Unit,
    onOpenT3: (OutboxEntry) -> Unit,
    onRefreshAll: () -> Unit,
) {
    val c = IosTheme.colors
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(c.groupedBg)
            .padding(12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("派活看板", fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = c.secondaryLabel)
            Text(
                text = "刷新列表",
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                color = c.blue,
                modifier = Modifier
                    .clip(RoundedCornerShape(6.dp))
                    .clickable(onClick = onRefreshAll)
                    .padding(horizontal = 6.dp, vertical = 2.dp),
            )
        }
        if (entries.isEmpty()) {
            Text(
                text = "暂无主控派出的任务",
                fontSize = 13.sp,
                color = c.secondaryLabel,
                modifier = Modifier.padding(vertical = 8.dp),
            )
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxWidth().height(210.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                items(entries, key = { it.dispatchId }) { item ->
                    val statusColor = when (item.status) {
                        "done" -> c.green
                        "failed" -> c.red
                        "waiting" -> c.orange
                        else -> c.blue
                    }
                    val statusLabel = when (item.status) {
                        "running", "sending" -> "执行中"
                        "waiting" -> "待处理"
                        "done" -> "已完成"
                        else -> "失败"
                    }
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(12.dp))
                            .background(c.cardBg)
                            .padding(12.dp),
                        verticalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = "${displayNameOf(item.to, item.deviceName)} · ${item.title}",
                                fontSize = 14.sp,
                                fontWeight = FontWeight.SemiBold,
                                color = c.label,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                            Spacer(modifier = Modifier.width(6.dp))
                            Box(
                                modifier = Modifier
                                    .clip(CircleShape)
                                    .background(statusColor.copy(alpha = 0.14f))
                                    .padding(horizontal = 8.dp, vertical = 2.dp),
                            ) {
                                Text(
                                    text = statusLabel,
                                    fontSize = 11.sp,
                                    fontWeight = FontWeight.SemiBold,
                                    color = statusColor,
                                )
                            }
                        }
                        if (!item.lastSummary.isNullOrBlank()) {
                            Text(
                                text = item.lastSummary.take(120),
                                fontSize = 12.5.sp,
                                color = c.secondaryLabel,
                                maxLines = 2,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        if (!item.error.isNullOrBlank()) {
                            Text(
                                text = item.error,
                                fontSize = 12.5.sp,
                                color = c.red,
                            )
                        }
                        IosHairline()
                        Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                            Text(
                                text = "刷新",
                                fontSize = 13.sp,
                                fontWeight = FontWeight.Medium,
                                color = c.blue,
                                modifier = Modifier.clickable { onRefresh(item) },
                            )
                            Text(
                                text = "追问",
                                fontSize = 13.sp,
                                fontWeight = FontWeight.Medium,
                                color = c.blue,
                                modifier = Modifier.clickable { onFollowup(item) },
                            )
                            Text(
                                text = "打开 T3",
                                fontSize = 13.sp,
                                fontWeight = FontWeight.Medium,
                                color = c.blue,
                                modifier = Modifier.clickable { onOpenT3(item) },
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DirectDispatchDialog(
    devices: List<RelayDevice>,
    nameOf: (RelayDevice) -> String,
    onDismiss: () -> Unit,
    onDispatch: (toId: String, projectId: String, title: String, prompt: String, mode: String) -> Unit,
) {
    val c = IosTheme.colors
    var selectedDevice by remember { mutableStateOf(devices.firstOrNull()) }
    var selectedProject by remember(selectedDevice) {
        mutableStateOf(selectedDevice?.dispatch?.projects?.firstOrNull())
    }
    var title by remember { mutableStateOf("") }
    var prompt by remember { mutableStateOf("") }
    var mode by remember { mutableStateOf("auto") }

    IosModalSheet(
        title = "直接向设备 T3 派活",
        onDismiss = onDismiss,
        confirmText = "立即派发",
        confirmEnabled = selectedDevice != null && selectedProject != null && prompt.isNotBlank(),
        onConfirm = {
            val d = selectedDevice ?: return@IosModalSheet
            val p = selectedProject ?: return@IosModalSheet
            onDispatch(d.id, p.id, title, prompt, mode)
        },
    ) {
        if (devices.isEmpty()) {
            Text(
                text = "当前没有在线且开启接收派活的设备",
                fontSize = 14.sp,
                color = c.secondaryLabel,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp),
            )
        } else {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(330.dp)
                    .verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Text("目标设备", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = c.secondaryLabel)
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(10.dp))
                        .background(c.cardBg),
                ) {
                    devices.forEachIndexed { idx, dev ->
                        val picked = selectedDevice?.id == dev.id
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { selectedDevice = dev }
                                .padding(horizontal = 12.dp, vertical = 9.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.SpaceBetween,
                        ) {
                            Text(
                                text = nameOf(dev),
                                fontSize = 14.sp,
                                color = c.label,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                            if (picked) {
                                Icon(
                                    imageVector = IosIcons.Check,
                                    contentDescription = null,
                                    tint = c.blue,
                                    modifier = Modifier.size(16.dp),
                                )
                            }
                        }
                        if (idx < devices.lastIndex) IosHairline(startIndent = 12.dp)
                    }
                }

                val projects = selectedDevice?.dispatch?.projects.orEmpty()
                if (projects.isNotEmpty()) {
                    Text("目标项目", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = c.secondaryLabel)
                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(10.dp))
                            .background(c.cardBg),
                    ) {
                        val shown = projects.take(6)
                        shown.forEachIndexed { idx, p ->
                            val picked = selectedProject?.id == p.id
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { selectedProject = p }
                                    .padding(horizontal = 12.dp, vertical = 8.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.SpaceBetween,
                            ) {
                                Text(
                                    text = p.name,
                                    fontSize = 13.5.sp,
                                    color = c.label,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f),
                                )
                                if (picked) {
                                    Icon(
                                        imageVector = IosIcons.Check,
                                        contentDescription = null,
                                        tint = c.blue,
                                        modifier = Modifier.size(16.dp),
                                    )
                                }
                            }
                            if (idx < shown.lastIndex) IosHairline(startIndent = 12.dp)
                        }
                    }
                }

                IosTextField(
                    value = title,
                    onValueChange = { title = it },
                    placeholder = "任务标题（可选）",
                    singleLine = true,
                )
                IosTextField(
                    value = prompt,
                    onValueChange = { prompt = it },
                    placeholder = "输入要派给对方 T3 执行的具体任务内容…",
                    singleLine = false,
                    maxLines = 4,
                )

                Text("权限模式", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = c.secondaryLabel)
                Row(
                    modifier = Modifier.horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    listOf("auto-accept-edits", "auto", "full-access").forEach { m ->
                        val picked = mode == m
                        Box(
                            modifier = Modifier
                                .clip(CircleShape)
                                .background(if (picked) c.blue else c.tertiaryFill)
                                .clickable { mode = m }
                                .padding(horizontal = 12.dp, vertical = 6.dp),
                        ) {
                            Text(
                                text = m,
                                fontSize = 12.5.sp,
                                fontWeight = FontWeight.Medium,
                                color = if (picked) Color.White else c.label,
                                maxLines = 1,
                                softWrap = false,
                            )
                        }
                    }
                }
            }
        }
    }
}
