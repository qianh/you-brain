package ai.youbrain.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.youbrain.mobile.data.ActiveTerminalTarget
import ai.youbrain.mobile.data.ConnectionState
import ai.youbrain.mobile.data.RelayDevice
import ai.youbrain.mobile.data.Tty7Harness
import ai.youbrain.mobile.data.Tty7Session
import ai.youbrain.mobile.net.AppUiState
import ai.youbrain.mobile.net.UBrainRepository
import ai.youbrain.mobile.ui.components.IosHairline
import ai.youbrain.mobile.ui.components.IosIconBadge
import ai.youbrain.mobile.ui.components.IosIcons
import ai.youbrain.mobile.ui.components.IosModalSheet
import ai.youbrain.mobile.ui.components.IosTextField
import ai.youbrain.mobile.ui.theme.IosTheme
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

private const val ALL_DEVICES_FILTER = "__all__"

private val FALLBACK_HARNESSES = listOf(
    Tty7Harness("claude", "Claude Code"),
    Tty7Harness("codex", "Codex"),
    Tty7Harness("gemini", "Gemini CLI"),
    Tty7Harness("opencode", "OpenCode"),
    Tty7Harness("kimi", "Kimi Code"),
    Tty7Harness("grok", "Grok"),
    Tty7Harness("shell", "Shell"),
)

private data class SessionActionTarget(
    val device: RelayDevice,
    val session: Tty7Session,
)

@Composable
fun TerminalDeckScreen(
    state: AppUiState,
    repository: UBrainRepository,
    isVisibleTab: Boolean,
    preferredFilterDeviceId: String?,
    preferredFilterSeq: Long,
    onOpenTerminal: (ActiveTerminalTarget) -> Unit,
    onOpenRemoteDesktop: (RelayDevice) -> Unit,
) {
    val c = IosTheme.colors
    val scope = rememberCoroutineScope()

    val devices = remember(state.relayState.devices, state.deviceId, state.deviceAliases) {
        repository.managedDevices()
    }
    var filterDeviceId by remember { mutableStateOf(ALL_DEVICES_FILTER) }
    var searchQuery by remember { mutableStateOf("") }
    var activeOnly by remember { mutableStateOf(false) }
    var refreshing by remember { mutableStateOf(false) }
    var feedback by remember { mutableStateOf<Pair<String, Boolean>?>(null) }

    var renameDevice by remember { mutableStateOf<RelayDevice?>(null) }
    var renameSessionTarget by remember { mutableStateOf<SessionActionTarget?>(null) }
    var deleteSessionTarget by remember { mutableStateOf<SessionActionTarget?>(null) }
    var createDialogDefaults by remember { mutableStateOf<Pair<String?, String>?>(null) }

    LaunchedEffect(preferredFilterSeq) {
        if (preferredFilterSeq > 0L && !preferredFilterDeviceId.isNullOrBlank()) {
            filterDeviceId = preferredFilterDeviceId
        }
    }

    LaunchedEffect(devices) {
        if (filterDeviceId != ALL_DEVICES_FILTER && devices.none { it.id == filterDeviceId }) {
            filterDeviceId = ALL_DEVICES_FILTER
        }
    }

    // 视图可见时立即刷新并静默轮询各在线设备终端会话
    LaunchedEffect(isVisibleTab, state.connectionState, filterDeviceId, devices.size) {
        if (!isVisibleTab || state.connectionState != ConnectionState.OK) return@LaunchedEffect
        if (filterDeviceId == ALL_DEVICES_FILTER) {
            repository.refreshAllTty7Sessions(silent = false)
        } else {
            val dev = devices.firstOrNull { it.id == filterDeviceId }
            if (dev?.online == true && dev.dispatch?.viewT3 == true) {
                val hasData = state.tty7Boards[dev.id]?.data != null
                repository.loadTty7Sessions(dev.id, silent = hasData)
            }
        }
        while (isActive) {
            delay(7_000L)
            if (filterDeviceId == ALL_DEVICES_FILTER) {
                repository.refreshAllTty7Sessions(silent = true)
            } else {
                val dev = devices.firstOrNull { it.id == filterDeviceId }
                if (dev?.online == true && dev.dispatch?.viewT3 == true) {
                    repository.loadTty7Sessions(dev.id, silent = true)
                }
            }
        }
    }

    fun triggerRefresh() {
        if (refreshing) return
        scope.launch {
            refreshing = true
            try {
                if (filterDeviceId == ALL_DEVICES_FILTER) {
                    repository.refreshAllTty7Sessions(silent = false)
                } else {
                    repository.loadTty7Sessions(filterDeviceId, silent = false)
                }
            } finally {
                refreshing = false
            }
        }
    }

    val onlineViewDevices = remember(devices) {
        devices.filter { it.online && it.dispatch?.viewT3 == true }
    }
    val totalSessionsCount = remember(devices, state.tty7Boards) {
        devices.sumOf { state.tty7Boards[it.id]?.data?.sessions?.size ?: 0 }
    }
    val totalWaiting = remember(state.tty7Boards) {
        TerminalLogic.totalWaitingCount(state.tty7Boards)
    }

    val isAllMode = filterDeviceId == ALL_DEVICES_FILTER
    val selectedDevice = if (isAllMode) null else devices.firstOrNull { it.id == filterDeviceId }

    val crossDeviceItems = remember(devices, state.tty7Boards, state.deviceAliases, searchQuery, activeOnly) {
        TerminalLogic.buildCrossDeviceItems(
            devices = devices,
            boards = state.tty7Boards,
            displayNameOf = { state.displayName(it) },
            query = searchQuery,
            activeOnly = activeOnly,
        )
    }

    val selectedDeviceGroups = remember(selectedDevice, state.tty7Boards, state.deviceAliases, searchQuery, activeOnly) {
        val dev = selectedDevice ?: return@remember emptyList()
        val sessions = state.tty7Boards[dev.id]?.data?.sessions.orEmpty()
        TerminalLogic.groupByProject(
            sessions = sessions,
            deviceDisplayName = state.displayName(dev),
            query = searchQuery,
            activeOnly = activeOnly,
        )
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(c.groupedBg),
    ) {
        // 顶部设备胶囊栏（全部 + 各设备）+ 右侧固定新建与刷新按钮
        Column(modifier = Modifier.fillMaxWidth().background(c.chromeBg)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(42.dp)
                    .padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Row(
                    modifier = Modifier
                        .weight(1f)
                        .horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // 「全部」汇总胶囊
                    Row(
                        modifier = Modifier
                            .height(28.dp)
                            .clip(CircleShape)
                            .background(if (isAllMode) c.blue else c.tertiaryFill)
                            .clickable { filterDeviceId = ALL_DEVICES_FILTER }
                            .padding(horizontal = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(5.dp),
                    ) {
                        Text(
                            text = if (totalSessionsCount > 0) "全部 ($totalSessionsCount)" else "全部",
                            fontSize = 12.5.sp,
                            fontWeight = if (isAllMode) FontWeight.SemiBold else FontWeight.Medium,
                            color = if (isAllMode) Color.White else c.label,
                            softWrap = false,
                        )
                        if (totalWaiting > 0) {
                            Box(
                                modifier = Modifier
                                    .clip(CircleShape)
                                    .background(if (isAllMode) Color.White.copy(alpha = 0.25f) else c.orange)
                                    .padding(horizontal = 5.dp, vertical = 0.5.dp),
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    text = "$totalWaiting",
                                    fontSize = 10.sp,
                                    fontWeight = FontWeight.Bold,
                                    color = Color.White,
                                )
                            }
                        }
                    }

                    devices.forEach { dev ->
                        val isSelected = dev.id == filterDeviceId
                        val devBoard = state.tty7Boards[dev.id]
                        val devWaiting = devBoard?.data?.sessions.orEmpty().count { !it.hibernated && it.status == "waiting" }
                        val pillBg = if (isSelected) c.blue else c.tertiaryFill
                        val textColor = if (isSelected) Color.White else c.label
                        val dotColor = when {
                            isSelected && dev.online -> Color(0xFF9DF7B2)
                            isSelected -> Color.White.copy(alpha = 0.65f)
                            dev.online -> c.green
                            else -> c.secondaryLabel
                        }
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(3.dp),
                        ) {
                            Row(
                                modifier = Modifier
                                    .height(28.dp)
                                    .widthIn(max = 172.dp)
                                    .clip(CircleShape)
                                    .background(pillBg)
                                    .clickable {
                                        if (isSelected) {
                                            renameDevice = dev
                                        } else {
                                            filterDeviceId = dev.id
                                            repository.selectDevice(dev.id)
                                        }
                                    }
                                    .padding(horizontal = 10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(5.dp),
                            ) {
                                Box(
                                    modifier = Modifier
                                        .size(6.dp)
                                        .clip(CircleShape)
                                        .background(dotColor),
                                )
                                Text(
                                    text = state.displayName(dev),
                                    fontSize = 12.5.sp,
                                    fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Medium,
                                    color = textColor,
                                    maxLines = 1,
                                    softWrap = false,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f, fill = false),
                                )
                                if (devWaiting > 0) {
                                    Box(
                                        modifier = Modifier
                                            .clip(CircleShape)
                                            .background(if (isSelected) Color.White.copy(alpha = 0.25f) else c.orange)
                                            .padding(horizontal = 4.dp),
                                    ) {
                                        Text(
                                            text = "$devWaiting",
                                            fontSize = 10.sp,
                                            fontWeight = FontWeight.Bold,
                                            color = Color.White,
                                        )
                                    }
                                }
                            }
                            if (dev.online && dev.dispatch?.remoteDesktop == true) {
                                Box(
                                    modifier = Modifier
                                        .size(28.dp)
                                        .clip(CircleShape)
                                        .background(if (isSelected) c.blue.copy(alpha = 0.16f) else c.tertiaryFill)
                                        .clickable {
                                            repository.selectDevice(dev.id)
                                            onOpenRemoteDesktop(dev)
                                        },
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Icon(
                                        imageVector = IosIcons.ScreenShare,
                                        contentDescription = "桌面画面协同：${state.displayName(dev)}",
                                        tint = c.blue,
                                        modifier = Modifier.size(14.dp),
                                    )
                                }
                            }
                        }
                    }
                }

                // 新建终端会话按钮
                if (onlineViewDevices.isNotEmpty()) {
                    Box(
                        modifier = Modifier
                            .size(28.dp)
                            .clip(CircleShape)
                            .background(c.blue.copy(alpha = 0.14f))
                            .clickable {
                                val defaultDev = selectedDevice?.takeIf { it.online && it.dispatch?.viewT3 == true }?.id
                                    ?: onlineViewDevices.firstOrNull()?.id
                                createDialogDefaults = defaultDev to ""
                            },
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            imageVector = IosIcons.Plus,
                            contentDescription = "新建终端会话",
                            tint = c.blue,
                            modifier = Modifier.size(15.dp),
                        )
                    }
                }

                // 手动刷新按钮
                Box(
                    modifier = Modifier
                        .size(28.dp)
                        .clip(CircleShape)
                        .background(c.tertiaryFill)
                        .clickable(enabled = !refreshing) { triggerRefresh() },
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
                            contentDescription = "刷新终端会话",
                            tint = c.blue,
                            modifier = Modifier.size(15.dp),
                        )
                    }
                }
            }

            // 搜索框 + 「只看活跃」过滤条
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 12.dp, end = 12.dp, bottom = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                IosTextField(
                    value = searchQuery,
                    onValueChange = { searchQuery = it },
                    placeholder = "搜索设备、项目、会话或 Agent…",
                    singleLine = true,
                    showClear = true,
                    contentPadding = PaddingValues(horizontal = 10.dp, vertical = 7.dp),
                    modifier = Modifier.weight(1f),
                )
                Box(
                    modifier = Modifier
                        .height(34.dp)
                        .clip(RoundedCornerShape(10.dp))
                        .background(if (activeOnly) c.blue else c.tertiaryFill)
                        .clickable { activeOnly = !activeOnly }
                        .padding(horizontal = 10.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = "只看活跃",
                        fontSize = 12.5.sp,
                        fontWeight = FontWeight.Medium,
                        color = if (activeOnly) Color.White else c.label,
                        softWrap = false,
                    )
                }
            }
            IosHairline()
        }

        // 操作反馈提示条
        feedback?.let { (msg, isError) ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background((if (isError) c.red else c.green).copy(alpha = 0.14f))
                    .padding(horizontal = 12.dp, vertical = 7.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = msg,
                    fontSize = 12.5.sp,
                    color = if (isError) c.red else c.green,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = "关闭",
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = if (isError) c.red else c.green,
                    modifier = Modifier.clickable { feedback = null }.padding(start = 8.dp),
                )
            }
        }

        // 主内容区
        if (state.connectionState != ConnectionState.OK && totalSessionsCount == 0) {
            TerminalEmptyCard(
                title = if (state.connectionState == ConnectionState.CONNECTING) "正在连接中转…" else "中转未连接",
                subtitle = state.connectionError ?: "连接恢复后将自动拉取各在线设备的终端会话。",
                actionLabel = "立即重连",
                onAction = { repository.reconnectNow() },
            )
        } else if (devices.isEmpty()) {
            TerminalEmptyCard(
                title = "暂无已入网设备",
                subtitle = "请先在电脑端 U-Brain 登录并入网，开启「允许远程查看 T3/终端」后即可在此管理各设备的终端会话。",
            )
        } else if (isAllMode) {
            val anyLoading = onlineViewDevices.any { state.tty7Boards[it.id]?.loading == true }
            if (crossDeviceItems.isEmpty() && anyLoading) {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.4.dp, color = c.blue)
                        Text("正在同步各设备终端会话…", fontSize = 13.5.sp, color = c.secondaryLabel)
                    }
                }
            } else if (crossDeviceItems.isEmpty()) {
                val hint = when {
                    onlineViewDevices.isEmpty() -> "当前没有在线且开启「允许远程查看 T3/终端」的设备。"
                    searchQuery.isNotBlank() || activeOnly -> "没有匹配当前筛选条件的终端会话。"
                    else -> "各在线设备当前还没有运行中的 tty7 终端会话，点击右上角「+」可以直接新建。"
                }
                TerminalEmptyCard(
                    title = "暂无终端会话",
                    subtitle = hint,
                    actionLabel = if (onlineViewDevices.isNotEmpty() && searchQuery.isBlank() && !activeOnly) "新建会话" else "刷新",
                    onAction = {
                        if (onlineViewDevices.isNotEmpty() && searchQuery.isBlank() && !activeOnly) {
                            createDialogDefaults = onlineViewDevices.first().id to ""
                        } else {
                            triggerRefresh()
                        }
                    },
                )
            } else {
                val unavailableDevices = onlineViewDevices.filter { dev ->
                    val b = state.tty7Boards[dev.id]
                    b?.error != null || (b?.data != null && !b.data.available)
                }
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    items(
                        items = crossDeviceItems,
                        key = { "${it.device.id}:${it.session.pane}" },
                    ) { item ->
                        TerminalSessionCard(
                            session = item.session,
                            deviceDisplayName = item.deviceDisplayName,
                            showDeviceBadge = true,
                            onClick = {
                                onOpenTerminal(
                                    ActiveTerminalTarget(
                                        deviceId = item.device.id,
                                        pane = item.session.pane,
                                        title = TerminalLogic.sessionTitle(item.session),
                                    ),
                                )
                            },
                            onRename = { renameSessionTarget = SessionActionTarget(item.device, item.session) },
                            onDelete = { deleteSessionTarget = SessionActionTarget(item.device, item.session) },
                        )
                    }

                    if (unavailableDevices.isNotEmpty()) {
                        item(key = "unavailable-hint") {
                            val summary = unavailableDevices.joinToString("、") { dev ->
                                val b = state.tty7Boards[dev.id]
                                val reason = b?.error ?: b?.data?.detail?.ifBlank { "未启动 tty7" } ?: "不可用"
                                "${state.displayName(dev)}（$reason）"
                            }
                            Text(
                                text = "部分在线设备未获取到终端：$summary",
                                fontSize = 11.5.sp,
                                lineHeight = 16.sp,
                                color = c.secondaryLabel,
                                modifier = Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp),
                            )
                        }
                    }
                }
            }
        } else {
            val dev = selectedDevice!!
            val devBoard = state.tty7Boards[dev.id]
            val devName = state.displayName(dev)
            when {
                !dev.online -> TerminalEmptyCard(
                    title = "$devName 当前离线",
                    subtitle = "设备重新上线后将自动恢复终端会话列表。",
                )
                dev.dispatch?.viewT3 != true -> TerminalEmptyCard(
                    title = "未开放远程查看权限",
                    subtitle = "请在 $devName 的 U-Brain「设置 → 跨设备派活」中开启「允许远程查看我的 T3」后再试。",
                )
                devBoard?.loading == true && devBoard.data == null -> Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center,
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        CircularProgressIndicator(modifier = Modifier.size(24.dp), strokeWidth = 2.4.dp, color = c.blue)
                        Text("正在获取 $devName 的终端会话…", fontSize = 13.5.sp, color = c.secondaryLabel)
                    }
                }
                devBoard?.error != null && devBoard.data == null -> TerminalEmptyCard(
                    title = "无法获取终端会话",
                    subtitle = devBoard.error,
                    actionLabel = "重试",
                    onAction = { triggerRefresh() },
                )
                devBoard?.data != null && !devBoard.data.available -> TerminalEmptyCard(
                    title = "$devName 未运行 tty7",
                    subtitle = devBoard.data.detail.ifBlank { "未检测到 tty7 终端服务，请确认该设备已安装并启动 tty7。" },
                    actionLabel = "重新检测",
                    onAction = { triggerRefresh() },
                )
                selectedDeviceGroups.isEmpty() -> TerminalEmptyCard(
                    title = "暂无匹配的终端会话",
                    subtitle = if (searchQuery.isNotBlank() || activeOnly) {
                        "清空搜索词或关闭「只看活跃」可查看该设备的全部终端会话。"
                    } else {
                        "$devName 当前没有打开的 tty7 会话，点击下方按钮即可新建。"
                    },
                    actionLabel = "在此设备新建会话",
                    onAction = { createDialogDefaults = dev.id to "" },
                )
                else -> {
                    LazyColumn(
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        items(selectedDeviceGroups, key = { it.cwd }) { group ->
                            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .padding(horizontal = 4.dp),
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                                ) {
                                    Text(
                                        text = group.projectName,
                                        fontSize = 13.sp,
                                        fontWeight = FontWeight.SemiBold,
                                        color = c.label,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                        modifier = Modifier.weight(1f, fill = false),
                                    )
                                    if (group.waitingCount > 0) {
                                        StatusPill(text = "待回复 ${group.waitingCount}", color = c.orange)
                                    }
                                    if (group.workingCount > 0) {
                                        StatusPill(text = "运行 ${group.workingCount}", color = c.blue)
                                    }
                                    Spacer(modifier = Modifier.weight(1f))
                                    Text(
                                        text = "+ 新建",
                                        fontSize = 12.sp,
                                        fontWeight = FontWeight.Medium,
                                        color = c.blue,
                                        modifier = Modifier
                                            .clip(RoundedCornerShape(6.dp))
                                            .clickable {
                                                createDialogDefaults = dev.id to group.cwd
                                            }
                                            .padding(horizontal = 6.dp, vertical = 2.dp),
                                    )
                                }
                                group.sessions.forEach { session ->
                                    TerminalSessionCard(
                                        session = session,
                                        deviceDisplayName = devName,
                                        showDeviceBadge = false,
                                        onClick = {
                                            onOpenTerminal(
                                                ActiveTerminalTarget(
                                                    deviceId = dev.id,
                                                    pane = session.pane,
                                                    title = TerminalLogic.sessionTitle(session),
                                                ),
                                            )
                                        },
                                        onRename = { renameSessionTarget = SessionActionTarget(dev, session) },
                                        onDelete = { deleteSessionTarget = SessionActionTarget(dev, session) },
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // 设备改名弹窗
    renameDevice?.let { dev ->
        RenameDeviceDialog(
            rawName = dev.name,
            currentDisplayName = state.displayName(dev),
            isSelf = false,
            hasAlias = state.hasCustomAlias(dev.id),
            onConfirm = { newName ->
                repository.renameDevice(dev.id, newName)
                renameDevice = null
            },
            onReset = {
                repository.renameDevice(dev.id, "")
                renameDevice = null
            },
            onDismiss = { renameDevice = null },
        )
    }

    // 重命名会话弹窗
    renameSessionTarget?.let { target ->
        var draft by remember(target) {
            mutableStateOf(target.session.tabLabel?.trim().orEmpty().ifEmpty { TerminalLogic.sessionTitle(target.session) })
        }
        var saving by remember { mutableStateOf(false) }
        IosModalSheet(
            title = "重命名终端会话",
            onDismiss = { renameSessionTarget = null },
            confirmText = if (saving) "保存中…" else "保存",
            confirmEnabled = !saving,
            dismissEnabled = !saving,
            onConfirm = {
                saving = true
                scope.launch {
                    val res = repository.renameTty7Session(target.device.id, target.session.pane, draft)
                    saving = false
                    renameSessionTarget = null
                    feedback = res.fold(
                        onSuccess = { "✓ 已更新会话名称" to false },
                        onFailure = { (it.message ?: "重命名失败") to true },
                    )
                }
            },
        ) {
            Text(
                text = "${state.displayName(target.device)} · %${target.session.pane}（留空可恢复默认标题）",
                fontSize = 12.5.sp,
                color = c.secondaryLabel,
            )
            IosTextField(
                value = draft,
                onValueChange = { draft = it.take(80) },
                placeholder = "输入新名称",
                singleLine = true,
                enabled = !saving,
                showClear = true,
            )
        }
    }

    // 关闭会话二次确认弹窗
    deleteSessionTarget?.let { target ->
        var deleting by remember { mutableStateOf(false) }
        IosModalSheet(
            title = "关闭终端会话？",
            onDismiss = { deleteSessionTarget = null },
            confirmText = if (deleting) "关闭中…" else "确认关闭",
            confirmDestructive = true,
            confirmEnabled = !deleting,
            dismissEnabled = !deleting,
            onConfirm = {
                deleting = true
                scope.launch {
                    val res = repository.deleteTty7Session(target.device.id, target.session.pane)
                    deleting = false
                    deleteSessionTarget = null
                    feedback = res.fold(
                        onSuccess = { "✓ 已关闭会话 %${target.session.pane}" to false },
                        onFailure = { (it.message ?: "关闭失败") to true },
                    )
                }
            },
        ) {
            Text(
                text = "将终止 ${state.displayName(target.device)} 上的会话「${TerminalLogic.sessionTitle(target.session)}」（%${target.session.pane}），正在运行的进程也会退出。",
                fontSize = 13.5.sp,
                lineHeight = 19.sp,
                color = c.secondaryLabel,
                textAlign = TextAlign.Center,
            )
        }
    }

    // 新建终端会话弹窗
    createDialogDefaults?.let { (initialDevId, initialCwd) ->
        CreateTerminalSessionDialog(
            state = state,
            devices = onlineViewDevices,
            initialDeviceId = initialDevId,
            initialCwd = initialCwd,
            onDismiss = { createDialogDefaults = null },
            onCreate = { devId, cwd, harness ->
                scope.launch {
                    val res = repository.startTty7Session(devId, cwd, harness)
                    res.fold(
                        onSuccess = { started ->
                            createDialogDefaults = null
                            onOpenTerminal(
                                ActiveTerminalTarget(
                                    deviceId = devId,
                                    pane = started.pane,
                                    title = TerminalLogic.projectName(cwd),
                                ),
                            )
                        },
                        onFailure = { err ->
                            feedback = (err.message ?: "新建会话失败") to true
                        },
                    )
                }
            },
        )
    }
}

@Composable
private fun TerminalSessionCard(
    session: Tty7Session,
    deviceDisplayName: String,
    showDeviceBadge: Boolean,
    onClick: () -> Unit,
    onRename: () -> Unit,
    onDelete: () -> Unit,
) {
    val c = IosTheme.colors
    var menuExpanded by remember { mutableStateOf(false) }

    val statusColor = when {
        session.hibernated -> c.secondaryLabel
        session.status == "waiting" -> c.orange
        session.status == "working" -> c.blue
        session.status == "done" -> c.green
        else -> c.secondaryLabel
    }
    val statusText = TerminalLogic.statusLabel(session.status, session.hibernated)
    val title = TerminalLogic.sessionTitle(session)
    val project = TerminalLogic.projectName(session.cwd)

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(c.cardBg)
            .border(
                width = if (!session.hibernated && session.status == "waiting") 1.dp else 0.5.dp,
                color = if (!session.hibernated && session.status == "waiting") {
                    c.orange.copy(alpha = 0.6f)
                } else {
                    c.separator.copy(alpha = 0.4f)
                },
                shape = RoundedCornerShape(14.dp),
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 13.dp, vertical = 11.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            StatusPill(text = statusText, color = statusColor)

            if (showDeviceBadge) {
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .background(c.tertiaryFill)
                        .padding(horizontal = 6.dp, vertical = 2.dp),
                ) {
                    Text(
                        text = deviceDisplayName,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Medium,
                        color = c.label,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }

            session.agent?.takeIf { it.isNotBlank() }?.let { agent ->
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(6.dp))
                        .background(c.blue.copy(alpha = 0.12f))
                        .padding(horizontal = 6.dp, vertical = 2.dp),
                ) {
                    Text(
                        text = agent,
                        fontSize = 11.sp,
                        fontWeight = FontWeight.Medium,
                        color = c.blue,
                        maxLines = 1,
                    )
                }
            }

            Spacer(modifier = Modifier.weight(1f))

            Text(
                text = "%${session.pane}",
                fontSize = 11.sp,
                fontFamily = FontFamily.Monospace,
                color = c.secondaryLabel,
            )

            Box {
                Box(
                    modifier = Modifier
                        .size(24.dp)
                        .clip(CircleShape)
                        .background(c.tertiaryFill)
                        .clickable { menuExpanded = true },
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = "⋯",
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Bold,
                        color = c.secondaryLabel,
                    )
                }
                DropdownMenu(
                    expanded = menuExpanded,
                    onDismissRequest = { menuExpanded = false },
                ) {
                    DropdownMenuItem(
                        text = { Text("重命名") },
                        onClick = {
                            menuExpanded = false
                            onRename()
                        },
                    )
                    DropdownMenuItem(
                        text = { Text("关闭会话", color = c.red) },
                        onClick = {
                            menuExpanded = false
                            onDelete()
                        },
                    )
                }
            }
        }

        Text(
            text = title,
            fontSize = 15.sp,
            fontWeight = FontWeight.SemiBold,
            color = c.label,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
        )

        if (!session.statusMessage.isNullOrBlank()) {
            Text(
                text = session.statusMessage,
                fontSize = 12.5.sp,
                lineHeight = 17.sp,
                color = if (session.status == "waiting") c.orange else c.secondaryLabel,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }

        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            Text(
                text = if (session.cwd.isNotBlank()) "$project · ${session.cwd}" else project,
                fontSize = 11.5.sp,
                fontFamily = FontFamily.Monospace,
                color = c.secondaryLabel,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            session.model?.takeIf { it.isNotBlank() }?.let { model ->
                Text(
                    text = model,
                    fontSize = 11.sp,
                    color = c.tertiaryLabel,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun StatusPill(text: String, color: Color) {
    Row(
        modifier = Modifier
            .clip(CircleShape)
            .background(color.copy(alpha = 0.14f))
            .padding(horizontal = 7.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Box(
            modifier = Modifier
                .size(6.dp)
                .clip(CircleShape)
                .background(color),
        )
        Text(
            text = text,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            color = color,
            softWrap = false,
        )
    }
}

@Composable
private fun TerminalEmptyCard(
    title: String,
    subtitle: String,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    val c = IosTheme.colors
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
            IosIconBadge(icon = IosIcons.TerminalWindow, background = c.blue)
            Text(title, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = c.label, textAlign = TextAlign.Center)
            Text(
                text = subtitle,
                fontSize = 13.5.sp,
                lineHeight = 19.sp,
                color = c.secondaryLabel,
                textAlign = TextAlign.Center,
            )
            if (actionLabel != null && onAction != null) {
                Spacer(modifier = Modifier.height(2.dp))
                Box(
                    modifier = Modifier
                        .clip(CircleShape)
                        .background(c.blue)
                        .clickable(onClick = onAction)
                        .padding(horizontal = 18.dp, vertical = 9.dp),
                ) {
                    Text(actionLabel, fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = Color.White)
                }
            }
        }
    }
}

@Composable
private fun CreateTerminalSessionDialog(
    state: AppUiState,
    devices: List<RelayDevice>,
    initialDeviceId: String?,
    initialCwd: String,
    onDismiss: () -> Unit,
    onCreate: (deviceId: String, cwd: String, harness: String) -> Unit,
) {
    val c = IosTheme.colors
    var pickedDeviceId by remember(initialDeviceId, devices) {
        mutableStateOf(
            initialDeviceId?.takeIf { id -> devices.any { it.id == id } } ?: devices.firstOrNull()?.id.orEmpty(),
        )
    }
    var cwd by remember(initialCwd) { mutableStateOf(initialCwd) }
    val devBoard = state.tty7Boards[pickedDeviceId]?.data
    val harnesses = remember(devBoard) {
        devBoard?.harnesses?.takeIf { it.isNotEmpty() } ?: FALLBACK_HARNESSES
    }
    var pickedHarness by remember(harnesses) {
        mutableStateOf(harnesses.firstOrNull()?.id ?: "claude")
    }
    val suggestedCwds = remember(devBoard) {
        devBoard?.sessions.orEmpty()
            .map { it.cwd.trim() }
            .filter { it.isNotEmpty() }
            .distinct()
            .take(6)
    }

    IosModalSheet(
        title = "新建终端会话",
        onDismiss = onDismiss,
        confirmText = "创建并打开",
        confirmEnabled = pickedDeviceId.isNotBlank() && cwd.trim().isNotEmpty(),
        onConfirm = {
            onCreate(pickedDeviceId, cwd.trim(), pickedHarness)
        },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 420.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("目标设备", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = c.secondaryLabel)
            Row(
                modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                devices.forEach { dev ->
                    val selected = dev.id == pickedDeviceId
                    Box(
                        modifier = Modifier
                            .clip(CircleShape)
                            .background(if (selected) c.blue else c.tertiaryFill)
                            .clickable { pickedDeviceId = dev.id }
                            .padding(horizontal = 11.dp, vertical = 6.dp),
                    ) {
                        Text(
                            text = state.displayName(dev),
                            fontSize = 12.5.sp,
                            fontWeight = FontWeight.Medium,
                            color = if (selected) Color.White else c.label,
                            softWrap = false,
                        )
                    }
                }
            }

            Text("工作目录（目标设备绝对路径）", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = c.secondaryLabel)
            IosTextField(
                value = cwd,
                onValueChange = { cwd = it },
                placeholder = "/Users/you/project",
                singleLine = true,
                showClear = true,
            )

            if (suggestedCwds.isNotEmpty()) {
                Row(
                    modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    suggestedCwds.forEach { path ->
                        Box(
                            modifier = Modifier
                                .clip(RoundedCornerShape(8.dp))
                                .background(c.tertiaryFill)
                                .clickable { cwd = path }
                                .padding(horizontal = 9.dp, vertical = 5.dp),
                        ) {
                            Text(
                                text = TerminalLogic.projectName(path),
                                fontSize = 12.sp,
                                color = c.blue,
                                softWrap = false,
                            )
                        }
                    }
                }
            }

            Text("启动工具", fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = c.secondaryLabel)
            Row(
                modifier = Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                harnesses.forEach { h ->
                    val selected = h.id == pickedHarness
                    Box(
                        modifier = Modifier
                            .clip(CircleShape)
                            .background(if (selected) c.blue else c.tertiaryFill)
                            .clickable { pickedHarness = h.id }
                            .padding(horizontal = 11.dp, vertical = 6.dp),
                    ) {
                        Text(
                            text = h.label,
                            fontSize = 12.5.sp,
                            fontWeight = FontWeight.Medium,
                            color = if (selected) Color.White else c.label,
                            softWrap = false,
                        )
                    }
                }
            }
        }
    }
}
