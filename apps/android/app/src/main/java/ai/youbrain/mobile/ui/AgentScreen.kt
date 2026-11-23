package ai.youbrain.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ai.youbrain.mobile.data.AgentMessage
import ai.youbrain.mobile.data.OutboxEntry
import ai.youbrain.mobile.data.RelayDevice
import ai.youbrain.mobile.net.AppUiState
import ai.youbrain.mobile.net.UBrainRepository
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

@Composable
fun AgentScreen(
    state: AppUiState,
    repository: UBrainRepository,
    onOpenDeviceT3: (deviceId: String, threadUrl: String?) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val agent = state.agent
    val listState = rememberLazyListState()

    var input by remember { mutableStateOf("") }
    var showKanban by remember { mutableStateOf(false) }
    var showDevicePicker by remember { mutableStateOf(false) }
    var showSessionPicker by remember { mutableStateOf(false) }
    var showDirectDispatch by remember { mutableStateOf(false) }
    var followupTarget by remember { mutableStateOf<OutboxEntry?>(null) }
    var actionFeedback by remember { mutableStateOf<String?>(null) }

    val allEnrolledPeers = remember(state.relayState.devices, state.deviceId) {
        state.relayState.devices.filter { it.id != state.deviceId && it.enrolled == true }
    }
    val masterDevice = allEnrolledPeers.firstOrNull { it.id == agent.masterDeviceId }

    // 主控正在执行时每 1.5 秒增量刷新对话与派活状态
    LaunchedEffect(agent.masterDeviceId, agent.activeSessionId, agent.conversationState) {
        val mId = agent.masterDeviceId ?: return@LaunchedEffect
        if (agent.conversationState != "running") return@LaunchedEffect
        while (isActive) {
            delay(1_500L)
            repository.readAgentConversation(mId, agent.activeSessionId, incremental = true)
        }
    }

    LaunchedEffect(agent.messages.size) {
        if (agent.messages.isNotEmpty()) {
            listState.animateScrollToItem(agent.messages.size - 1)
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        // 顶部主控设备与会话切换栏（左弹性截断，右操作按钮固定宽不被挤压）
        Surface(tonalElevation = 2.dp) {
            Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Box(modifier = Modifier.weight(1f)) {
                        AssistChip(
                            onClick = { showDevicePicker = true },
                            label = {
                                val onlineText = if (masterDevice?.online == true) "● " else "○ "
                                Text(
                                    text = "${onlineText}主控: ${masterDevice?.name ?: "未选择"} ▾",
                                    maxLines = 1,
                                    softWrap = false,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            },
                        )
                        DropdownMenu(
                            expanded = showDevicePicker,
                            onDismissRequest = { showDevicePicker = false },
                        ) {
                            allEnrolledPeers.forEach { dev ->
                                DropdownMenuItem(
                                    text = {
                                        val tag = if (dev.dispatch?.role == "server") " [VPS]" else ""
                                        val dot = if (dev.online) "● " else "○ "
                                        Text("$dot${dev.name}$tag")
                                    },
                                    onClick = {
                                        showDevicePicker = false
                                        repository.selectMasterDevice(dev.id)
                                    },
                                )
                            }
                        }
                    }

                    Row(
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        AssistChip(
                            onClick = { showKanban = !showKanban },
                            label = { Text("看板 (${agent.outbox.size})", maxLines = 1, softWrap = false) },
                        )
                        AssistChip(
                            onClick = { showDirectDispatch = true },
                            label = { Text("+ 派活", maxLines = 1, softWrap = false) },
                        )
                    }
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    Box(modifier = Modifier.weight(1f)) {
                        val activeSession = agent.sessions.firstOrNull { it.sessionId == agent.activeSessionId }
                        TextButton(
                            onClick = { showSessionPicker = true },
                            contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                        ) {
                            Text(
                                text = "会话: ${activeSession?.title ?: "默认主控"} ▾",
                                maxLines = 1,
                                softWrap = false,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                        DropdownMenu(
                            expanded = showSessionPicker,
                            onDismissRequest = { showSessionPicker = false },
                        ) {
                            agent.sessions.forEach { s ->
                                DropdownMenuItem(
                                    text = {
                                        val prefix = if (s.sessionId == agent.activeSessionId) "✓ " else ""
                                        Text("$prefix${s.title} (${s.status})")
                                    },
                                    onClick = {
                                        showSessionPicker = false
                                        scope.launch {
                                            repository.loadAgentSessions(agent.masterDeviceId, sessionId = s.sessionId)
                                        }
                                    },
                                )
                            }
                            HorizontalDivider()
                            DropdownMenuItem(
                                text = { Text("+ 新建主控会话") },
                                onClick = {
                                    showSessionPicker = false
                                    scope.launch {
                                        repository.loadAgentSessions(agent.masterDeviceId, create = true)
                                    }
                                },
                            )
                        }
                    }

                    Row(verticalAlignment = Alignment.CenterVertically) {
                        TextButton(
                            onClick = {
                                scope.launch {
                                    repository.loadAgentSessions(agent.masterDeviceId, agent.activeSessionId)
                                }
                            },
                            enabled = !agent.loading && agent.masterDeviceId != null,
                            contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                        ) {
                            Text("↻ 刷新", maxLines = 1, softWrap = false)
                        }
                        if (masterDevice?.dispatch?.viewT3 == true) {
                            TextButton(
                                onClick = { onOpenDeviceT3(masterDevice.id, agent.threadUrl) },
                                contentPadding = PaddingValues(horizontal = 8.dp, vertical = 4.dp),
                            ) {
                                Text("看 T3", maxLines = 1, softWrap = false)
                            }
                        }
                    }
                }
            }
        }

        if (agent.loading || agent.conversationState == "running") {
            LinearProgressIndicator(modifier = Modifier.fillMaxWidth())
        }

        if (agent.error != null) {
            Surface(color = MaterialTheme.colorScheme.errorContainer, modifier = Modifier.fillMaxWidth()) {
                Text(
                    text = agent.error,
                    color = MaterialTheme.colorScheme.onErrorContainer,
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
                )
            }
        }

        if (actionFeedback != null) {
            Surface(color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.fillMaxWidth()) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(
                        text = actionFeedback!!,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSecondaryContainer,
                        modifier = Modifier.weight(1f),
                    )
                    TextButton(onClick = { actionFeedback = null }) { Text("好", softWrap = false) }
                }
            }
        }

        // 可展开的派活任务看板
        if (showKanban) {
            OutboxKanbanPanel(
                entries = agent.outbox,
                onRefresh = { entry ->
                    scope.launch {
                        repository.refreshDispatch(entry.dispatchId).onFailure {
                            actionFeedback = "刷新失败: ${it.message}"
                        }
                    }
                },
                onFollowup = { entry -> followupTarget = entry },
                onOpenT3 = { entry -> onOpenDeviceT3(entry.to, entry.threadUrl) },
                onRefreshAll = { scope.launch { repository.refreshOutboxList() } },
            )
            HorizontalDivider()
        }

        // 持续对话消息流
        Box(modifier = Modifier.weight(1f).fillMaxWidth()) {
            if (agent.masterDeviceId == null) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Text(
                        text = "等待发现 VPS 主控设备…\n请确认 VPS daemon 已入网且开启接收派活。",
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(24.dp),
                    )
                }
            } else if (agent.messages.isEmpty() && !agent.loading) {
                Column(
                    modifier = Modifier.fillMaxSize().padding(24.dp),
                    verticalArrangement = Arrangement.Center,
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(
                        text = "VPS 主控调度会话已就绪",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Spacer(modifier = Modifier.height(6.dp))
                    Text(
                        text = "直接发指令让主控帮你检查各设备状态，或把开发任务派发到 Mac / VPS 执行。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(modifier = Modifier.height(12.dp))
                    OutlinedButton(onClick = { input = "查看当前所有在线设备和可派活项目，汇报给我" }) {
                        Text("试一试：查在线设备与项目")
                    }
                }
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(12.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    items(agent.messages, key = { "${it.position}-${it.role}" }) { msg ->
                        ChatBubble(message = msg)
                    }
                }
            }
        }

        // 底部输入框
        Surface(tonalElevation = 3.dp) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 8.dp),
                verticalAlignment = Alignment.Bottom,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it },
                    placeholder = {
                        Text(
                            if (agent.conversationState == "running") "执行中可继续排队发指令…" else "向 VPS 主控发送指令…",
                        )
                    },
                    maxLines = 5,
                    modifier = Modifier.weight(1f),
                )
                Button(
                    onClick = {
                        val text = input.trim()
                        if (text.isEmpty()) return@Button
                        input = ""
                        scope.launch {
                            repository.sendAgentMessage(text)
                        }
                    },
                    enabled = input.isNotBlank() && agent.masterDeviceId != null && !agent.sending,
                ) {
                    if (agent.sending) {
                        CircularProgressIndicator(modifier = Modifier.height(16.dp), strokeWidth = 2.dp)
                    } else {
                        Text("发送")
                    }
                }
            }
        }
    }

    // 追问特定派活任务弹窗
    followupTarget?.let { entry ->
        var text by remember { mutableStateOf("") }
        var busy by remember { mutableStateOf(false) }
        AlertDialog(
            onDismissRequest = { if (!busy) followupTarget = null },
            title = { Text("追问：${entry.title}") },
            text = {
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    label = { Text("追加指令到 ${entry.deviceName}") },
                    minLines = 2,
                    modifier = Modifier.fillMaxWidth(),
                )
            },
            confirmButton = {
                Button(
                    onClick = {
                        busy = true
                        scope.launch {
                            val res = repository.followupDispatch(entry.dispatchId, text.trim())
                            busy = false
                            followupTarget = null
                            actionFeedback = res.fold(
                                onSuccess = { "✓ 已向 ${entry.deviceName} 追加指令" },
                                onFailure = { "追问失败: ${it.message}" },
                            )
                        }
                    },
                    enabled = !busy && text.isNotBlank(),
                ) { Text("发送") }
            },
            dismissButton = {
                TextButton(onClick = { followupTarget = null }, enabled = !busy) { Text("取消") }
            },
        )
    }

    // 直接向任意在线设备派活弹窗
    if (showDirectDispatch) {
        DirectDispatchDialog(
            devices = allEnrolledPeers.filter { it.online && it.dispatch?.enabled == true },
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
}

@Composable
private fun ChatBubble(message: AgentMessage) {
    val isUser = message.role == "user"
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = if (isUser) Arrangement.End else Arrangement.Start,
    ) {
        Box(
            modifier = Modifier
                .widthIn(max = 310.dp)
                .clip(RoundedCornerShape(14.dp))
                .background(
                    if (isUser) MaterialTheme.colorScheme.primaryContainer
                    else MaterialTheme.colorScheme.surfaceVariant,
                )
                .padding(horizontal = 12.dp, vertical = 9.dp),
        ) {
            SelectionContainer {
                Text(
                    text = message.text,
                    color = if (isUser) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}

@Composable
private fun OutboxKanbanPanel(
    entries: List<OutboxEntry>,
    onRefresh: (OutboxEntry) -> Unit,
    onFollowup: (OutboxEntry) -> Unit,
    onOpenT3: (OutboxEntry) -> Unit,
    onRefreshAll: () -> Unit,
) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.6f),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(modifier = Modifier.fillMaxWidth().padding(10.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("派活看板", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                TextButton(onClick = onRefreshAll) { Text("刷新列表") }
            }
            if (entries.isEmpty()) {
                Text(
                    "暂无主控派出的任务",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(vertical = 8.dp),
                )
            } else {
                LazyColumn(
                    modifier = Modifier.fillMaxWidth().height(210.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(entries, key = { it.dispatchId }) { item ->
                        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                            Column(modifier = Modifier.padding(10.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.SpaceBetween,
                                ) {
                                    Text(
                                        text = "${item.deviceName} · ${item.title}",
                                        style = MaterialTheme.typography.labelLarge,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                        modifier = Modifier.weight(1f),
                                    )
                                    Spacer(modifier = Modifier.width(6.dp))
                                    Text(
                                        text = when (item.status) {
                                            "running", "sending" -> "执行中"
                                            "waiting" -> "待处理"
                                            "done" -> "已完成"
                                            else -> "失败"
                                        },
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.primary,
                                    )
                                }
                                if (!item.lastSummary.isNullOrBlank()) {
                                    Text(
                                        text = item.lastSummary.take(120),
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        maxLines = 2,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                                if (!item.error.isNullOrBlank()) {
                                    Text(
                                        text = item.error,
                                        style = MaterialTheme.typography.bodySmall,
                                        color = MaterialTheme.colorScheme.error,
                                    )
                                }
                                Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    TextButton(onClick = { onRefresh(item) }) { Text("刷新") }
                                    TextButton(onClick = { onFollowup(item) }) { Text("追问") }
                                    TextButton(onClick = { onOpenT3(item) }) { Text("打开 T3") }
                                }
                            }
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
    onDismiss: () -> Unit,
    onDispatch: (toId: String, projectId: String, title: String, prompt: String, mode: String) -> Unit,
) {
    var selectedDevice by remember { mutableStateOf(devices.firstOrNull()) }
    var selectedProject by remember(selectedDevice) {
        mutableStateOf(selectedDevice?.dispatch?.projects?.firstOrNull())
    }
    var title by remember { mutableStateOf("") }
    var prompt by remember { mutableStateOf("") }
    var mode by remember { mutableStateOf("auto") }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("直接向设备 T3 派活") },
        text = {
            if (devices.isEmpty()) {
                Text("当前没有在线且开启接收派活的设备")
            } else {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("目标设备", style = MaterialTheme.typography.labelMedium)
                    devices.forEach { dev ->
                        val picked = selectedDevice?.id == dev.id
                        Text(
                            text = "${if (picked) "● " else "○ "}${dev.name}",
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier
                                .fillMaxWidth()
                                .clickable { selectedDevice = dev }
                                .padding(vertical = 3.dp),
                        )
                    }
                    val projects = selectedDevice?.dispatch?.projects.orEmpty()
                    if (projects.isNotEmpty()) {
                        Text("目标项目", style = MaterialTheme.typography.labelMedium)
                        projects.take(6).forEach { p ->
                            val picked = selectedProject?.id == p.id
                            Text(
                                text = "${if (picked) "✓ " else "  "}${p.name}",
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clickable { selectedProject = p }
                                    .padding(vertical = 2.dp),
                            )
                        }
                    }
                    OutlinedTextField(
                        value = title,
                        onValueChange = { title = it },
                        label = { Text("任务标题（可选）") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedTextField(
                        value = prompt,
                        onValueChange = { prompt = it },
                        label = { Text("任务内容") },
                        minLines = 3,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Row(
                        modifier = Modifier.horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        listOf("auto-accept-edits", "auto", "full-access").forEach { m ->
                            AssistChip(
                                onClick = { mode = m },
                                label = { Text(if (mode == m) "✓ $m" else m, maxLines = 1, softWrap = false) },
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    val d = selectedDevice ?: return@Button
                    val p = selectedProject ?: return@Button
                    onDispatch(d.id, p.id, title, prompt, mode)
                },
                enabled = selectedDevice != null && selectedProject != null && prompt.isNotBlank(),
            ) { Text("派发") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text("取消") }
        },
    )
}
