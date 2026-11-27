package ai.youbrain.mobile.ui

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Surface
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import ai.youbrain.mobile.data.ConnectionState
import ai.youbrain.mobile.data.DevelopmentTask
import ai.youbrain.mobile.data.PendingTodoAttachment
import ai.youbrain.mobile.data.RelayDevice
import ai.youbrain.mobile.data.TaskBoard
import ai.youbrain.mobile.data.TaskImage
import ai.youbrain.mobile.data.TaskProject
import ai.youbrain.mobile.data.TaskReview
import ai.youbrain.mobile.net.AppUiState
import ai.youbrain.mobile.net.DeviceTodoState
import ai.youbrain.mobile.net.UBrainRepository
import ai.youbrain.mobile.ui.components.IosHairline
import ai.youbrain.mobile.ui.components.IosIconBadge
import ai.youbrain.mobile.ui.components.IosIcons
import ai.youbrain.mobile.ui.components.IosModalSheet
import ai.youbrain.mobile.ui.components.IosSegmentedControl
import ai.youbrain.mobile.ui.components.IosSwitch
import ai.youbrain.mobile.ui.components.IosTextField
import ai.youbrain.mobile.ui.theme.IosColors
import ai.youbrain.mobile.ui.theme.IosTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.util.UUID

private data class TodoBannerMessage(
    val text: String,
    val isError: Boolean,
)

@Composable
fun TodoScreen(
    state: AppUiState,
    repository: UBrainRepository,
    isVisibleTab: Boolean,
    onOpenDeviceT3: (deviceId: String, threadUrl: String?) -> Unit,
) {
    val c = IosTheme.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val devices = remember(state.relayState.devices, state.deviceId, state.deviceAliases) {
        repository.managedDevices()
    }

    val activeDeviceId = remember(state.selectedDeviceId, state.agent.masterDeviceId, devices) {
        TodoLogic.resolveActiveDeviceId(state.selectedDeviceId, devices, state.agent.masterDeviceId)
    }
    val activeDevice = remember(activeDeviceId, devices) {
        devices.firstOrNull { it.id == activeDeviceId }
    }
    val activeDeviceName = activeDevice?.let { state.displayName(it) }.orEmpty()
    val deviceState = activeDeviceId?.let { state.todoBoards[it] } ?: DeviceTodoState()
    val board = deviceState.board

    var innerTab by remember { mutableStateOf("tasks") }
    var statusFilter by remember(activeDeviceId) { mutableStateOf(TodoStatusFilter.ALL) }
    var projectFilter by remember(activeDeviceId) { mutableStateOf(PROJECT_FILTER_ALL) }
    var expandedTaskIds by remember(activeDeviceId) { mutableStateOf(setOf<String>()) }
    var launchingTaskId by remember(activeDeviceId) { mutableStateOf<String?>(null) }
    var downloadingAttachmentId by remember(activeDeviceId) { mutableStateOf<String?>(null) }

    var renameDevice by remember { mutableStateOf<RelayDevice?>(null) }
    var editorTarget by remember(activeDeviceId) { mutableStateOf<Pair<Boolean, DevelopmentTask?>?>(null) }
    var reviewingTask by remember(activeDeviceId) { mutableStateOf<DevelopmentTask?>(null) }
    var completingTask by remember(activeDeviceId) { mutableStateOf<DevelopmentTask?>(null) }
    var startingProject by remember(activeDeviceId) { mutableStateOf<TaskProject?>(null) }
    var banner by remember { mutableStateOf<TodoBannerMessage?>(null) }

    fun showBanner(text: String, isError: Boolean = false) {
        banner = TodoBannerMessage(text = text, isError = isError)
    }

    LaunchedEffect(banner) {
        val current = banner ?: return@LaunchedEffect
        if (!current.isError) {
            delay(3_500L)
            if (banner == current) banner = null
        }
    }

    // 首次进入或切换设备时自动拉取最新看板
    LaunchedEffect(isVisibleTab, activeDeviceId, activeDevice?.online, state.connectionState) {
        if (!isVisibleTab) return@LaunchedEffect
        val devId = activeDeviceId ?: return@LaunchedEffect
        if (state.connectionState != ConnectionState.OK) return@LaunchedEffect
        if (activeDevice?.online != true) return@LaunchedEffect
        repository.loadTodoBoard(devId, silent = board != null)
    }

    // 仅在可见、在线且存在进行中任务时，温和轮询（10s）以避免触及 relay 限流
    val hasActive = TodoLogic.hasActiveTasks(board)
    LaunchedEffect(isVisibleTab, activeDeviceId, activeDevice?.online, state.connectionState, hasActive) {
        if (!isVisibleTab || !hasActive) return@LaunchedEffect
        val devId = activeDeviceId ?: return@LaunchedEffect
        if (state.connectionState != ConnectionState.OK || activeDevice?.online != true) return@LaunchedEffect
        while (true) {
            delay(10_000L)
            val latest = state.todoBoards[devId]
            if (latest?.mutating != true) {
                repository.loadTodoBoard(devId, silent = true)
            }
        }
    }

    val canWrite = activeDevice != null &&
        activeDevice.online &&
        state.connectionState == ConnectionState.OK &&
        !deviceState.mutating

    val canViewT3 = activeDevice?.dispatch?.viewT3 == true

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(c.groupedBg),
    ) {
        // 顶部设备胶囊切换栏 + 刷新 + 新建按钮
        Column(modifier = Modifier.fillMaxWidth().background(c.chromeBg)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(44.dp)
                    .padding(horizontal = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                if (devices.isEmpty()) {
                    Text(
                        text = "暂无已入网设备",
                        fontSize = 13.sp,
                        color = c.secondaryLabel,
                        modifier = Modifier.weight(1f),
                    )
                } else {
                    Row(
                        modifier = Modifier
                            .weight(1f)
                            .horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        devices.forEach { dev ->
                            val isSelected = dev.id == activeDeviceId
                            val cachedBoard = state.todoBoards[dev.id]?.board
                            val devReview = TodoLogic.reviewCount(cachedBoard)
                            val devQueued = cachedBoard?.tasks?.count { it.status == "queued" } ?: 0
                            DeviceTodoPill(
                                name = state.displayName(dev),
                                online = dev.online,
                                selected = isSelected,
                                reviewCount = devReview,
                                queuedCount = devQueued,
                                onClick = {
                                    if (isSelected) {
                                        renameDevice = dev
                                    } else {
                                        repository.selectDevice(dev.id)
                                    }
                                },
                            )
                        }
                    }

                    if (activeDeviceId != null) {
                        Box(
                            modifier = Modifier
                                .size(28.dp)
                                .clip(CircleShape)
                                .background(c.tertiaryFill)
                                .clickable(enabled = !deviceState.loading) {
                                    scope.launch {
                                        val res = repository.loadTodoBoard(activeDeviceId, silent = false)
                                        res.onFailure { showBanner(it.message ?: "刷新失败", isError = true) }
                                    }
                                },
                            contentAlignment = Alignment.Center,
                        ) {
                            if (deviceState.loading) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(14.dp),
                                    strokeWidth = 1.8.dp,
                                    color = c.blue,
                                )
                            } else {
                                Icon(
                                    imageVector = IosIcons.Refresh,
                                    contentDescription = "刷新",
                                    tint = c.blue,
                                    modifier = Modifier.size(15.dp),
                                )
                            }
                        }

                        Box(
                            modifier = Modifier
                                .size(28.dp)
                                .clip(CircleShape)
                                .background(if (canWrite) c.blue else c.tertiaryFill)
                                .clickable(enabled = canWrite) {
                                    editorTarget = Pair(true, null)
                                },
                            contentAlignment = Alignment.Center,
                        ) {
                            Icon(
                                imageVector = IosIcons.Plus,
                                contentDescription = "新建 TODO",
                                tint = if (canWrite) Color.White else c.secondaryLabel,
                                modifier = Modifier.size(16.dp),
                            )
                        }
                    }
                }
            }
            if (deviceState.loading || deviceState.mutating) {
                LinearProgressIndicator(
                    modifier = Modifier.fillMaxWidth().height(2.dp),
                    color = c.blue,
                    trackColor = Color.Transparent,
                )
            } else {
                IosHairline()
            }
        }

        // 操作反馈提示条
        banner?.let { msg ->
            TodoAlertStrip(
                text = msg.text,
                tint = if (msg.isError) c.red else c.green,
                onDismiss = { banner = null },
                modifier = Modifier.padding(horizontal = 14.dp, vertical = 8.dp),
            )
        }

        // 主体内容
        when {
            devices.isEmpty() -> {
                TodoEmptyCard(
                    icon = IosIcons.Checklist,
                    iconBg = c.blue,
                    title = "暂无可管理 TODO 的设备",
                    subtitle = "先让你的电脑或服务器入网并开启「接收派活」，就能在这里直接查看和维护各设备的开发 TODO。",
                )
            }
            activeDeviceId == null || activeDevice == null -> {
                TodoEmptyCard(
                    icon = IosIcons.Checklist,
                    iconBg = c.blue,
                    title = "请选择一个设备",
                    subtitle = "点击上方设备胶囊即可查看它的 TODO 列表。",
                )
            }
            board == null && deviceState.loading -> {
                Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        CircularProgressIndicator(
                            modifier = Modifier.size(26.dp),
                            strokeWidth = 2.4.dp,
                            color = c.blue,
                        )
                        Text(
                            text = "正在读取 ${state.displayName(activeDevice)} 的 TODO…",
                            fontSize = 13.5.sp,
                            color = c.secondaryLabel,
                        )
                    }
                }
            }
            board == null && !activeDevice.online -> {
                TodoEmptyCard(
                    icon = IosIcons.Laptop,
                    iconBg = c.secondaryLabel,
                    title = "${state.displayName(activeDevice)} 当前离线",
                    subtitle = "设备在线且开启「接收派活」后，即可查看与维护它的开发 TODO。",
                )
            }
            board == null && deviceState.error != null -> {
                TodoErrorCard(
                    deviceName = state.displayName(activeDevice),
                    error = deviceState.error,
                    loading = deviceState.loading,
                    onRetry = {
                        scope.launch { repository.loadTodoBoard(activeDeviceId, silent = false) }
                    },
                )
            }
            board == null -> {
                TodoEmptyCard(
                    icon = IosIcons.Checklist,
                    iconBg = c.blue,
                    title = "尚未加载 TODO",
                    subtitle = "点击下方按钮从 ${state.displayName(activeDevice)} 拉取 TODO 列表。",
                    actionLabel = "立即拉取",
                    onAction = {
                        scope.launch { repository.loadTodoBoard(activeDeviceId, silent = false) }
                    },
                )
            }
            else -> {
                val counts = remember(board.tasks, projectFilter) {
                    TodoLogic.taskCounts(board.tasks, projectFilter)
                }
                val visible = remember(board.tasks, projectFilter, statusFilter) {
                    TodoLogic.visibleTasks(board.tasks, projectFilter, statusFilter)
                }
                val projectMap = remember(board.projects) {
                    board.projects.associateBy { it.id }
                }

                // 若当前选中的 projectFilter 不再存在，自动回到全部
                LaunchedEffect(board.projects, projectFilter) {
                    if (
                        projectFilter != PROJECT_FILTER_ALL &&
                        projectFilter != PROJECT_FILTER_UNASSIGNED &&
                        board.projects.none { it.id == projectFilter }
                    ) {
                        projectFilter = PROJECT_FILTER_ALL
                    }
                }

                // 顶部离线/错误提示条（展示缓存数据时）
                if (!activeDevice.online) {
                    TodoAlertStrip(
                        text = "${state.displayName(activeDevice)} 当前离线，正显示缓存数据（只读）。",
                        tint = c.orange,
                        modifier = Modifier.padding(start = 14.dp, end = 14.dp, top = 8.dp),
                    )
                } else if (!deviceState.error.isNullOrBlank()) {
                    TodoAlertStrip(
                        text = deviceState.error,
                        tint = c.red,
                        modifier = Modifier.padding(start = 14.dp, end = 14.dp, top = 8.dp),
                    )
                }

                if (!board.connectionError.isNullOrBlank()) {
                    TodoAlertStrip(
                        text = "T3 连接需要处理：${board.connectionError}",
                        tint = c.orange,
                        modifier = Modifier.padding(start = 14.dp, end = 14.dp, top = 8.dp),
                    )
                }

                // 任务 / 项目分段切换
                IosSegmentedControl(
                    items = listOf(
                        "tasks" to "任务 (${board.tasks.size})",
                        "projects" to "项目 (${board.projects.size})",
                    ),
                    selectedKey = innerTab,
                    onSelect = { innerTab = it },
                    modifier = Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                )

                if (innerTab == "tasks") {
                    TasksTabContent(
                        board = board,
                        counts = counts,
                        visibleTasks = visible,
                        projectMap = projectMap,
                        statusFilter = statusFilter,
                        projectFilter = projectFilter,
                        expandedTaskIds = expandedTaskIds,
                        launchingTaskId = launchingTaskId,
                        downloadingAttachmentId = downloadingAttachmentId,
                        canWrite = canWrite,
                        canViewT3 = canViewT3,
                        onSelectStatus = { statusFilter = it },
                        onSelectProject = { projectFilter = it },
                        onToggleExpand = { id ->
                            expandedTaskIds = if (expandedTaskIds.contains(id)) {
                                expandedTaskIds - id
                            } else {
                                expandedTaskIds + id
                            }
                        },
                        onCreateNew = { editorTarget = Pair(true, null) },
                        onEdit = { task -> editorTarget = Pair(false, task) },
                        onOpenAttachment = { task, image ->
                            scope.launch {
                                downloadingAttachmentId = image.id
                                try {
                                    val res = repository.downloadTodoAttachment(activeDeviceId, task.id, image)
                                    res.fold(
                                        onSuccess = { file ->
                                            val opened = openTodoAttachmentFile(context, file, image.mimeType)
                                            if (!opened) {
                                                showBanner("没有可打开「${image.name}」的应用", isError = true)
                                            }
                                        },
                                        onFailure = { err ->
                                            showBanner(err.message ?: "下载附件失败", isError = true)
                                        },
                                    )
                                } finally {
                                    if (downloadingAttachmentId == image.id) downloadingAttachmentId = null
                                }
                            }
                        },
                        onStart = { task ->
                            scope.launch {
                                launchingTaskId = task.id
                                try {
                                    val res = repository.startTodo(activeDeviceId, task.id)
                                    res.fold(
                                        onSuccess = { showBanner("已启动「${task.title}」") },
                                        onFailure = { showBanner(it.message ?: "启动失败", isError = true) },
                                    )
                                } finally {
                                    launchingTaskId = null
                                }
                            }
                        },
                        onRetry = { task ->
                            scope.launch {
                                launchingTaskId = task.id
                                try {
                                    val res = repository.retryTodo(activeDeviceId, task.id)
                                    res.fold(
                                        onSuccess = { showBanner("已重新检查「${task.title}」") },
                                        onFailure = { showBanner(it.message ?: "重试失败", isError = true) },
                                    )
                                } finally {
                                    launchingTaskId = null
                                }
                            }
                        },
                        onReview = { task -> reviewingTask = task },
                        onComplete = { task -> completingTask = task },
                        onOpenT3 = { threadUrl -> onOpenDeviceT3(activeDeviceId, threadUrl) },
                    )
                } else {
                    ProjectsTabContent(
                        board = board,
                        canWrite = canWrite,
                        onToggleProject = { project, nextEnabled ->
                            if (nextEnabled) {
                                startingProject = project
                            } else {
                                scope.launch {
                                    val res = repository.toggleTodoProject(activeDeviceId, project.id, false)
                                    res.fold(
                                        onSuccess = { showBanner("已暂停「${project.name}」自动处理") },
                                        onFailure = { showBanner(it.message ?: "操作失败", isError = true) },
                                    )
                                }
                            }
                        },
                        onOpenProjectTasks = { project ->
                            projectFilter = project.id
                            statusFilter = TodoStatusFilter.ALL
                            innerTab = "tasks"
                        },
                    )
                }
            }
        }
    }

    // 重命名设备弹窗
    renameDevice?.let { dev ->
        RenameDeviceDialog(
            rawName = dev.name,
            currentDisplayName = state.displayName(dev),
            isSelf = false,
            hasAlias = state.hasCustomAlias(dev.id),
            onConfirm = { draft ->
                repository.renameDevice(dev.id, draft)
                renameDevice = null
            },
            onReset = {
                repository.renameDevice(dev.id, "")
                renameDevice = null
            },
            onDismiss = { renameDevice = null },
        )
    }

    // 新建 / 编辑 TODO 弹窗
    editorTarget?.let { (isNew, editingTask) ->
        val devId = activeDeviceId ?: return@let
        val defaultProjectId = if (isNew) {
            when (projectFilter) {
                PROJECT_FILTER_ALL, PROJECT_FILTER_UNASSIGNED -> null
                else -> projectFilter
            }
        } else {
            editingTask?.projectId
        }
        TodoEditorDialog(
            isNew = isNew,
            deviceName = activeDeviceName,
            task = editingTask,
            defaultProjectId = defaultProjectId,
            projects = board?.projects.orEmpty(),
            saving = deviceState.mutating,
            onDismiss = { editorTarget = null },
            onSubmit = { title, desc, selectedProjectId, newName, newCwd, priority, retainImageIds, attachments ->
                scope.launch {
                    val res = if (isNew || editingTask == null) {
                        repository.createTodo(
                            deviceId = devId,
                            title = title,
                            description = desc,
                            projectId = selectedProjectId,
                            newProjectName = newName,
                            newProjectCwd = newCwd,
                            priority = priority,
                            attachments = attachments,
                        )
                    } else {
                        repository.updateTodo(
                            deviceId = devId,
                            id = editingTask.id,
                            title = title,
                            description = desc,
                            projectId = selectedProjectId,
                            newProjectName = newName,
                            newProjectCwd = newCwd,
                            priority = priority,
                            retainImageIds = retainImageIds,
                            attachments = attachments,
                        )
                    }
                    res.fold(
                        onSuccess = {
                            editorTarget = null
                            showBanner(if (isNew) "TODO 已创建" else "TODO 已保存")
                        },
                        onFailure = { err ->
                            showBanner(err.message ?: "保存失败", isError = true)
                        },
                    )
                }
            },
        )
    }

    // 核对变更 & 合并 / 退回弹窗
    reviewingTask?.let { task ->
        val devId = activeDeviceId ?: return@let
        TodoReviewDialog(
            deviceId = devId,
            deviceName = activeDeviceName,
            task = task,
            repository = repository,
            canWrite = canWrite,
            canViewT3 = canViewT3,
            onOpenT3 = { url ->
                reviewingTask = null
                onOpenDeviceT3(devId, url)
            },
            onApproved = { nextBoard ->
                val updated = nextBoard.tasks.firstOrNull { it.id == task.id }
                reviewingTask = null
                if (updated != null && updated.status != "done") {
                    showBanner("develop 已有新提交，与任务有冲突，已交回 T3 解决；完成后需要重新核对。")
                } else {
                    showBanner("任务已合并并推送 develop。")
                }
            },
            onRejected = {
                reviewingTask = null
                showBanner("已将反馈交给 T3，修改后需要重新核对。")
            },
            onDismiss = { reviewingTask = null },
        )
    }

    // 手动完成确认弹窗
    completingTask?.let { task ->
        val devId = activeDeviceId ?: return@let
        IosModalSheet(
            title = "手动完成",
            onDismiss = { completingTask = null },
            confirmText = "确认完成",
            confirmEnabled = !deviceState.mutating,
            onConfirm = {
                scope.launch {
                    val res = repository.completeTodo(devId, task.id)
                    res.fold(
                        onSuccess = {
                            completingTask = null
                            showBanner("任务已标记为完成")
                        },
                        onFailure = { err ->
                            completingTask = null
                            showBanner(err.message ?: "操作失败", isError = true)
                        },
                    )
                }
            },
        ) {
            Text(
                text = "「${task.title}」",
                fontSize = 14.5.sp,
                fontWeight = FontWeight.Medium,
                color = c.label,
            )
            Text(
                text = "只把任务标记为已完成，不合并代码、不停止 T3 会话。若项目已开启自动处理，后续任务可能继续领取。",
                fontSize = 13.sp,
                lineHeight = 18.sp,
                color = c.secondaryLabel,
            )
        }
    }

    // 开启项目自动处理确认弹窗
    startingProject?.let { project ->
        val devId = activeDeviceId ?: return@let
        IosModalSheet(
            title = "启动自动处理",
            onDismiss = { startingProject = null },
            confirmText = "启动",
            confirmEnabled = !deviceState.mutating,
            onConfirm = {
                scope.launch {
                    val res = repository.toggleTodoProject(devId, project.id, true)
                    res.fold(
                        onSuccess = {
                            startingProject = null
                            showBanner("已开启「${project.name}」自动处理")
                        },
                        onFailure = { err ->
                            startingProject = null
                            showBanner(err.message ?: "操作失败", isError = true)
                        },
                    )
                }
            },
        ) {
            Text(
                text = project.name,
                fontSize = 14.5.sp,
                fontWeight = FontWeight.Medium,
                color = c.label,
            )
            Text(
                text = "启动后将自动领取该项目优先级最高的 TODO，在独立分支中交给 T3 处理。每项任务均须你核对并确认后，才会合并到 develop 并继续下一项。",
                fontSize = 13.sp,
                lineHeight = 18.sp,
                color = c.secondaryLabel,
            )
        }
    }
}

@Composable
private fun DeviceTodoPill(
    name: String,
    online: Boolean,
    selected: Boolean,
    reviewCount: Int,
    queuedCount: Int,
    onClick: () -> Unit,
) {
    val c = IosTheme.colors
    val pillBg = if (selected) c.blue else c.tertiaryFill
    val textColor = if (selected) Color.White else c.label
    val dotColor = when {
        selected && online -> Color(0xFF9DF7B2)
        selected -> Color.White.copy(alpha = 0.65f)
        online -> c.green
        else -> c.secondaryLabel
    }
    Row(
        modifier = Modifier
            .height(28.dp)
            .widthIn(max = 186.dp)
            .clip(CircleShape)
            .background(pillBg)
            .clickable(onClick = onClick)
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
            text = name,
            fontSize = 12.5.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
            color = textColor,
            maxLines = 1,
            softWrap = false,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        if (reviewCount > 0) {
            Box(
                modifier = Modifier
                    .clip(CircleShape)
                    .background(if (selected) Color.White.copy(alpha = 0.24f) else c.orange)
                    .padding(horizontal = 5.dp, vertical = 1.dp),
            ) {
                Text(
                    text = "$reviewCount",
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    color = Color.White,
                    maxLines = 1,
                )
            }
        } else if (queuedCount > 0 && !selected) {
            Text(
                text = "$queuedCount",
                fontSize = 11.sp,
                color = c.secondaryLabel,
                maxLines = 1,
            )
        }
        if (selected) {
            Icon(
                imageVector = IosIcons.Pencil,
                contentDescription = "改名",
                tint = Color.White.copy(alpha = 0.85f),
                modifier = Modifier.size(11.dp),
            )
        }
    }
}

@Composable
private fun TasksTabContent(
    board: TaskBoard,
    counts: TodoCounts,
    visibleTasks: List<DevelopmentTask>,
    projectMap: Map<String, TaskProject>,
    statusFilter: TodoStatusFilter,
    projectFilter: String,
    expandedTaskIds: Set<String>,
    launchingTaskId: String?,
    downloadingAttachmentId: String?,
    canWrite: Boolean,
    canViewT3: Boolean,
    onSelectStatus: (TodoStatusFilter) -> Unit,
    onSelectProject: (String) -> Unit,
    onToggleExpand: (String) -> Unit,
    onCreateNew: () -> Unit,
    onEdit: (DevelopmentTask) -> Unit,
    onOpenAttachment: (DevelopmentTask, TaskImage) -> Unit,
    onStart: (DevelopmentTask) -> Unit,
    onRetry: (DevelopmentTask) -> Unit,
    onReview: (DevelopmentTask) -> Unit,
    onComplete: (DevelopmentTask) -> Unit,
    onOpenT3: (String) -> Unit,
) {
    val c = IosTheme.colors

    Column(modifier = Modifier.fillMaxSize()) {
        // 状态筛选条
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .padding(horizontal = 14.dp, vertical = 2.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            val statusChips = buildList {
                add(Triple(TodoStatusFilter.ALL, "全部", counts.all))
                add(Triple(TodoStatusFilter.QUEUED, "待处理", counts.queued))
                add(Triple(TodoStatusFilter.ACTIVE, "进行中", counts.active))
                add(Triple(TodoStatusFilter.REVIEW, "待核对", counts.review))
                if (counts.failed > 0 || statusFilter == TodoStatusFilter.FAILED) {
                    add(Triple(TodoStatusFilter.FAILED, "需要处理", counts.failed))
                }
                add(Triple(TodoStatusFilter.DONE, "已完成", counts.done))
            }
            statusChips.forEach { (filter, label, count) ->
                val selected = statusFilter == filter
                val accent = when (filter) {
                    TodoStatusFilter.REVIEW -> c.orange
                    TodoStatusFilter.FAILED -> c.red
                    TodoStatusFilter.DONE -> c.green
                    else -> c.blue
                }
                FilterChipPill(
                    label = "$label $count",
                    selected = selected,
                    accent = accent,
                    onClick = { onSelectStatus(filter) },
                )
            }
        }

        // 项目筛选条
        val hasUnassigned = remember(board.tasks) { board.tasks.any { it.projectId == null } }
        if (board.projects.isNotEmpty() || hasUnassigned) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 14.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                FilterChipPill(
                    label = "全部项目",
                    selected = projectFilter == PROJECT_FILTER_ALL,
                    accent = c.indigo,
                    onClick = { onSelectProject(PROJECT_FILTER_ALL) },
                )
                if (hasUnassigned || projectFilter == PROJECT_FILTER_UNASSIGNED) {
                    FilterChipPill(
                        label = "未关联项目",
                        selected = projectFilter == PROJECT_FILTER_UNASSIGNED,
                        accent = c.indigo,
                        onClick = { onSelectProject(PROJECT_FILTER_UNASSIGNED) },
                    )
                }
                board.projects.forEach { project ->
                    FilterChipPill(
                        label = project.name,
                        selected = projectFilter == project.id,
                        accent = c.indigo,
                        onClick = { onSelectProject(project.id) },
                    )
                }
            }
        }

        if (visibleTasks.isEmpty()) {
            val isEmptyBoard = board.tasks.isEmpty()
            TodoEmptyCard(
                icon = IosIcons.Checklist,
                iconBg = c.blue,
                title = if (isEmptyBoard) "把下一件事交给 T3" else "没有符合筛选条件的 TODO",
                subtitle = if (isEmptyBoard) {
                    "创建 TODO 后可逐项启动，也可在「项目」中开启自动处理。"
                } else {
                    "可以切换上方状态或项目筛选条件查看其他任务。"
                },
                actionLabel = if (isEmptyBoard && canWrite) "新建 TODO" else null,
                onAction = if (isEmptyBoard && canWrite) onCreateNew else null,
            )
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(start = 14.dp, end = 14.dp, top = 4.dp, bottom = 20.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(visibleTasks, key = { it.id }) { task ->
                    val project = task.projectId?.let { projectMap[it] }
                    TodoTaskCard(
                        task = task,
                        projectName = when {
                            task.projectId == null -> "未关联项目"
                            project != null -> project.name
                            else -> "项目暂不可用"
                        },
                        expanded = expandedTaskIds.contains(task.id),
                        launching = launchingTaskId == task.id,
                        downloadingAttachmentId = downloadingAttachmentId,
                        canWrite = canWrite,
                        canViewT3 = canViewT3,
                        onToggleExpand = { onToggleExpand(task.id) },
                        onOpenAttachment = { image -> onOpenAttachment(task, image) },
                        onStart = { onStart(task) },
                        onEdit = { onEdit(task) },
                        onReview = { onReview(task) },
                        onRetry = { onRetry(task) },
                        onComplete = { onComplete(task) },
                        onOpenT3 = onOpenT3,
                    )
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TodoTaskCard(
    task: DevelopmentTask,
    projectName: String,
    expanded: Boolean,
    launching: Boolean,
    downloadingAttachmentId: String?,
    canWrite: Boolean,
    canViewT3: Boolean,
    onToggleExpand: () -> Unit,
    onOpenAttachment: (TaskImage) -> Unit,
    onStart: () -> Unit,
    onEdit: () -> Unit,
    onReview: () -> Unit,
    onRetry: () -> Unit,
    onComplete: () -> Unit,
    onOpenT3: (String) -> Unit,
) {
    val c = IosTheme.colors
    val priorityColor = priorityColor(task.priority, c)
    val statusColor = statusColor(task, c)
    val statusLabel = TodoLogic.taskStatusLabel(task)
    val relTime = remember(task.updatedAt) { TodoLogic.formatRelativeIsoTime(task.updatedAt) }
    val threadUrl = task.run?.threadUrl?.takeIf { it.isNotBlank() }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(13.dp))
            .background(c.cardBg)
            .clickable(onClick = onToggleExpand)
            .padding(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        // 顶部状态 + 优先级 + 时间
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            BadgePill(
                text = TodoLogic.priorityBadge(task.priority),
                color = priorityColor,
            )
            BadgePill(
                text = statusLabel,
                color = statusColor,
                showDot = TodoLogic.isTaskActive(task.status),
            )
            Spacer(modifier = Modifier.weight(1f))
            if (relTime.isNotEmpty()) {
                Text(
                    text = relTime,
                    fontSize = 11.5.sp,
                    color = c.secondaryLabel,
                    maxLines = 1,
                )
            }
        }

        // 标题
        Text(
            text = task.title,
            fontSize = 15.5.sp,
            lineHeight = 21.sp,
            fontWeight = FontWeight.SemiBold,
            color = c.label,
        )

        // 说明文本（点击卡片展开/收起）
        if (task.description.isNotBlank()) {
            Text(
                text = task.description,
                fontSize = 13.5.sp,
                lineHeight = 19.sp,
                color = c.secondaryLabel,
                maxLines = if (expanded) Int.MAX_VALUE else 3,
                overflow = TextOverflow.Ellipsis,
            )
        }

        // 项目 / 分支 / 桌面附图元信息
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            MetaChip(icon = IosIcons.Folder, text = projectName)
            val branch = task.run?.branch?.takeIf { it.isNotBlank() }
            if (branch != null) {
                MetaChip(text = branch, monospace = true)
            }
            if (task.images.isNotEmpty()) {
                task.images.forEach { attachment ->
                    val loadingThis = downloadingAttachmentId == attachment.id
                    Row(
                        modifier = Modifier
                            .clip(RoundedCornerShape(6.dp))
                            .background(c.blue.copy(alpha = if (c.isDark) 0.22f else 0.12f))
                            .clickable(enabled = !loadingThis) { onOpenAttachment(attachment) }
                            .padding(horizontal = 7.dp, vertical = 3.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        if (loadingThis) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(10.dp),
                                strokeWidth = 1.5.dp,
                                color = c.blue,
                            )
                        } else {
                            Icon(
                                imageVector = IosIcons.ExternalLink,
                                contentDescription = null,
                                tint = c.blue,
                                modifier = Modifier.size(11.dp),
                            )
                        }
                        Text(
                            text = attachment.name,
                            fontSize = 11.5.sp,
                            color = c.blue,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.widthIn(max = 180.dp),
                        )
                    }
                }
            }
        }

        // 处理摘要
        val summary = task.run?.summary?.trim().orEmpty()
        if (summary.isNotEmpty() && (task.status == "review" || task.status == "done" || expanded)) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(9.dp))
                    .background(c.quaternaryFill)
                    .padding(horizontal = 10.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(3.dp),
            ) {
                Text(
                    text = "处理摘要",
                    fontSize = 11.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = c.secondaryLabel,
                )
                Text(
                    text = summary,
                    fontSize = 12.5.sp,
                    lineHeight = 17.sp,
                    color = c.label,
                    maxLines = if (expanded) Int.MAX_VALUE else 4,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }

        // 工作树阻断或错误提示
        val alertText = when {
            task.worktreeBlock != null -> TodoLogic.taskWorktreeHint(task.worktreeBlock)
            !task.error.isNullOrBlank() -> task.error
            else -> null
        }
        if (alertText != null) {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(9.dp))
                    .background(c.red.copy(alpha = if (c.isDark) 0.18f else 0.10f))
                    .padding(horizontal = 10.dp, vertical = 7.dp),
            ) {
                Text(
                    text = alertText,
                    fontSize = 12.5.sp,
                    lineHeight = 17.sp,
                    color = c.red,
                )
            }
        }

        // 操作按钮栏
        val hasAnyAction = when (task.status) {
            "queued", "review", "failed" -> true
            "done" -> threadUrl != null && canViewT3
            else -> true
        }
        if (hasAnyAction) {
            IosHairline()
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier.fillMaxWidth(),
            ) {
                when (task.status) {
                    "queued" -> {
                        TaskActionButton(
                            label = if (launching) "启动中…" else "开始",
                            icon = IosIcons.Play,
                            bg = c.blue,
                            fg = Color.White,
                            enabled = canWrite && !launching,
                            loading = launching,
                            onClick = onStart,
                        )
                        TaskActionButton(
                            label = "编辑",
                            icon = IosIcons.Pencil,
                            bg = c.tertiaryFill,
                            fg = c.label,
                            enabled = canWrite,
                            onClick = onEdit,
                        )
                        TaskActionButton(
                            label = "完成",
                            icon = IosIcons.Check,
                            bg = c.tertiaryFill,
                            fg = c.secondaryLabel,
                            enabled = canWrite,
                            onClick = onComplete,
                        )
                    }
                    "review" -> {
                        TaskActionButton(
                            label = "核对变更",
                            icon = IosIcons.Checklist,
                            bg = c.orange,
                            fg = Color.White,
                            enabled = canWrite,
                            onClick = onReview,
                        )
                        if (threadUrl != null && canViewT3) {
                            TaskActionButton(
                                label = "打开 T3",
                                icon = IosIcons.ExternalLink,
                                bg = c.tertiaryFill,
                                fg = c.blue,
                                enabled = true,
                                onClick = { onOpenT3(threadUrl) },
                            )
                        }
                        TaskActionButton(
                            label = "手动完成",
                            icon = IosIcons.Check,
                            bg = c.tertiaryFill,
                            fg = c.secondaryLabel,
                            enabled = canWrite,
                            onClick = onComplete,
                        )
                    }
                    "failed" -> {
                        TaskActionButton(
                            label = if (launching) "处理中…" else "重试",
                            icon = IosIcons.Refresh,
                            bg = c.blue,
                            fg = Color.White,
                            enabled = canWrite && !launching,
                            loading = launching,
                            onClick = onRetry,
                        )
                        if (threadUrl != null && canViewT3) {
                            TaskActionButton(
                                label = "打开 T3",
                                icon = IosIcons.ExternalLink,
                                bg = c.tertiaryFill,
                                fg = c.blue,
                                enabled = true,
                                onClick = { onOpenT3(threadUrl) },
                            )
                        }
                        TaskActionButton(
                            label = "手动完成",
                            icon = IosIcons.Check,
                            bg = c.tertiaryFill,
                            fg = c.secondaryLabel,
                            enabled = canWrite,
                            onClick = onComplete,
                        )
                    }
                    "done" -> {
                        if (threadUrl != null && canViewT3) {
                            TaskActionButton(
                                label = "打开 T3",
                                icon = IosIcons.ExternalLink,
                                bg = c.tertiaryFill,
                                fg = c.blue,
                                enabled = true,
                                onClick = { onOpenT3(threadUrl) },
                            )
                        }
                    }
                    else -> {
                        if (threadUrl != null && canViewT3) {
                            TaskActionButton(
                                label = "在 T3 中查看",
                                icon = IosIcons.ExternalLink,
                                bg = c.blue.copy(alpha = if (c.isDark) 0.22f else 0.12f),
                                fg = c.blue,
                                enabled = true,
                                onClick = { onOpenT3(threadUrl) },
                            )
                        }
                        TaskActionButton(
                            label = "手动完成",
                            icon = IosIcons.Check,
                            bg = c.tertiaryFill,
                            fg = c.secondaryLabel,
                            enabled = canWrite,
                            onClick = onComplete,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ProjectsTabContent(
    board: TaskBoard,
    canWrite: Boolean,
    onToggleProject: (TaskProject, Boolean) -> Unit,
    onOpenProjectTasks: (TaskProject) -> Unit,
) {
    val c = IosTheme.colors
    if (board.projects.isEmpty()) {
        TodoEmptyCard(
            icon = IosIcons.Folder,
            iconBg = c.indigo,
            title = "暂无 T3 项目",
            subtitle = "先在该设备的 T3 中添加项目，或者在新建 TODO 时直接创建新项目。",
        )
        return
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(start = 14.dp, end = 14.dp, top = 2.dp, bottom = 20.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            Text(
                text = "按优先级领取 → 独立分支处理 → 人工核对 → 合并并推送 develop。点击项目卡片可查看该项目下的 TODO。",
                fontSize = 12.sp,
                lineHeight = 16.sp,
                color = c.secondaryLabel,
                modifier = Modifier.padding(horizontal = 4.dp, vertical = 2.dp),
            )
        }
        items(board.projects, key = { it.id }) { project ->
            val runningTasks = TodoLogic.projectTasks(board.tasks, project.id)
            val queuedCount = TodoLogic.projectQueuedCount(board.tasks, project.id)
            val headTask = runningTasks.firstOrNull()
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(13.dp))
                    .background(c.cardBg)
                    .clickable { onOpenProjectTasks(project) }
                    .padding(horizontal = 14.dp, vertical = 12.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    IosIconBadge(
                        icon = IosIcons.Folder,
                        background = if (project.enabled) c.green else c.indigo,
                    )
                    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(
                            text = project.name,
                            fontSize = 15.5.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = c.label,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        if (project.cwd.isNotBlank()) {
                            Text(
                                text = project.cwd,
                                fontSize = 11.5.sp,
                                color = c.secondaryLabel,
                                fontFamily = FontFamily.Monospace,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                    IosSwitch(
                        checked = project.enabled,
                        onCheckedChange = { next ->
                            if (canWrite) onToggleProject(project, next)
                        },
                    )
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    BadgePill(
                        text = if (project.enabled) "自动处理已开启" else "已暂停领取",
                        color = if (project.enabled) c.green else c.secondaryLabel,
                    )
                    Text(
                        text = if (queuedCount > 0) "${queuedCount} 项待领取" else "队列为空",
                        fontSize = 12.sp,
                        color = c.secondaryLabel,
                    )
                    if (runningTasks.size > 1) {
                        Text(
                            text = "· ${runningTasks.size} 项进行中",
                            fontSize = 12.sp,
                            color = c.blue,
                        )
                    }
                }

                if (headTask != null) {
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clip(RoundedCornerShape(8.dp))
                            .background(c.quaternaryFill)
                            .padding(horizontal = 10.dp, vertical = 7.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        BadgePill(
                            text = TodoLogic.taskStatusLabel(headTask),
                            color = statusColor(headTask, c),
                        )
                        Text(
                            text = headTask.title,
                            fontSize = 12.5.sp,
                            color = c.label,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TodoEditorDialog(
    isNew: Boolean,
    deviceName: String,
    task: DevelopmentTask?,
    defaultProjectId: String?,
    projects: List<TaskProject>,
    saving: Boolean,
    onDismiss: () -> Unit,
    onSubmit: (
        title: String,
        description: String,
        projectId: String?,
        newProjectName: String?,
        newProjectCwd: String?,
        priority: Int,
        retainImageIds: List<String>?,
        attachments: List<PendingTodoAttachment>,
    ) -> Unit,
) {
    val c = IosTheme.colors
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var title by remember(task?.id, isNew) { mutableStateOf(task?.title.orEmpty()) }
    var description by remember(task?.id, isNew) { mutableStateOf(task?.description.orEmpty()) }
    var priority by remember(task?.id, isNew) { mutableIntStateOf(task?.priority ?: 2) }
    var createNewProject by remember(task?.id, isNew) { mutableStateOf(false) }
    var selectedProjectId by remember(task?.id, isNew, defaultProjectId) {
        mutableStateOf(if (isNew) defaultProjectId else task?.projectId)
    }
    var newProjectName by remember(task?.id, isNew) { mutableStateOf("") }
    var newProjectCwd by remember(task?.id, isNew) { mutableStateOf("") }
    var retainedImages by remember(task?.id, isNew) {
        mutableStateOf(if (isNew) emptyList() else task?.images.orEmpty())
    }
    var newAttachments by remember(task?.id, isNew) {
        mutableStateOf<List<PendingTodoAttachment>>(emptyList())
    }
    var readingFiles by remember(task?.id, isNew) { mutableStateOf(false) }
    var attachmentError by remember(task?.id, isNew) { mutableStateOf<String?>(null) }

    val totalAttachments = retainedImages.size + newAttachments.size

    val filePicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenMultipleDocuments(),
    ) { uris: List<Uri> ->
        if (uris.isEmpty()) return@rememberLauncherForActivityResult
        scope.launch {
            readingFiles = true
            attachmentError = null
            val remaining = 4 - (retainedImages.size + newAttachments.size)
            if (remaining <= 0) {
                attachmentError = "每个 TODO 最多可添加 4 个附件。"
                readingFiles = false
                return@launch
            }
            val picked = ArrayList<PendingTodoAttachment>()
            var errMsg: String? = null
            if (uris.size > remaining) {
                errMsg = "每个 TODO 最多可添加 4 个附件，已截取前 $remaining 个。"
            }
            for (uri in uris.take(remaining)) {
                val read = withContext(Dispatchers.IO) { readPickedTodoAttachment(context, uri) }
                read.fold(
                    onSuccess = { picked.add(it) },
                    onFailure = { errMsg = it.message ?: "读取文件失败" },
                )
            }
            if (picked.isNotEmpty()) {
                newAttachments = newAttachments + picked
            }
            attachmentError = errMsg
            readingFiles = false
        }
    }

    val canSubmit = !saving &&
        !readingFiles &&
        title.trim().isNotEmpty() &&
        (!createNewProject || newProjectName.trim().isNotEmpty())

    val sheetTitle = buildString {
        append(if (isNew) "新建 TODO" else "编辑 TODO")
        if (deviceName.isNotBlank()) append(" · $deviceName")
    }

    IosModalSheet(
        title = sheetTitle,
        onDismiss = onDismiss,
        confirmText = when {
            saving && newAttachments.isNotEmpty() -> "上传中…"
            saving -> "保存中…"
            isNew -> "创建"
            else -> "保存"
        },
        confirmEnabled = canSubmit,
        dismissEnabled = !saving && !readingFiles,
        onConfirm = {
            onSubmit(
                title.trim(),
                description.trim(),
                if (createNewProject) null else selectedProjectId,
                if (createNewProject) newProjectName.trim() else null,
                if (createNewProject) newProjectCwd.trim().takeIf { it.isNotEmpty() } else null,
                priority,
                if (isNew) null else retainedImages.map { it.id },
                newAttachments,
            )
        },
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .heightIn(max = 460.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            FieldLabel("任务标题")
            IosTextField(
                value = title,
                onValueChange = { title = it },
                placeholder = "需要完成什么？",
                singleLine = true,
                enabled = !saving,
                showClear = true,
            )

            FieldLabel("任务说明与验收要求")
            IosTextField(
                value = description,
                onValueChange = { description = it },
                placeholder = "描述预期行为，以及如何核对结果。",
                singleLine = false,
                maxLines = 6,
                enabled = !saving,
            )

            FieldLabel("附件文件（最多 4 个，单个 ≤ 10 MB）")
            if (retainedImages.isNotEmpty() || newAttachments.isNotEmpty()) {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    retainedImages.forEach { existing ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(8.dp))
                                .background(c.tertiaryFill)
                                .padding(horizontal = 10.dp, vertical = 7.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text(
                                text = existing.name,
                                fontSize = 12.5.sp,
                                color = c.label,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                            Text(
                                text = TodoLogic.formatAttachmentSize(existing.sizeBytes),
                                fontSize = 11.5.sp,
                                color = c.secondaryLabel,
                            )
                            Icon(
                                imageVector = IosIcons.Close,
                                contentDescription = "移除附件",
                                tint = c.secondaryLabel,
                                modifier = Modifier
                                    .size(14.dp)
                                    .clickable(enabled = !saving) {
                                        retainedImages = retainedImages.filterNot { it.id == existing.id }
                                        attachmentError = null
                                    },
                            )
                        }
                    }
                    newAttachments.forEach { item ->
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .clip(RoundedCornerShape(8.dp))
                                .background(c.blue.copy(alpha = if (c.isDark) 0.18f else 0.10f))
                                .padding(horizontal = 10.dp, vertical = 7.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Text(
                                text = item.name,
                                fontSize = 12.5.sp,
                                color = c.label,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.weight(1f),
                            )
                            Text(
                                text = TodoLogic.formatAttachmentSize(item.sizeBytes),
                                fontSize = 11.5.sp,
                                color = c.blue,
                            )
                            Icon(
                                imageVector = IosIcons.Close,
                                contentDescription = "移除附件",
                                tint = c.secondaryLabel,
                                modifier = Modifier
                                    .size(14.dp)
                                    .clickable(enabled = !saving) {
                                        newAttachments = newAttachments.filterNot { it.localId == item.localId }
                                        attachmentError = null
                                    },
                            )
                        }
                    }
                }
            }
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                Box(
                    modifier = Modifier
                        .clip(RoundedCornerShape(8.dp))
                        .background(if (!saving && !readingFiles && totalAttachments < 4) c.tertiaryFill else c.quaternaryFill)
                        .clickable(enabled = !saving && !readingFiles && totalAttachments < 4) {
                            filePicker.launch(arrayOf("*/*"))
                        }
                        .padding(horizontal = 12.dp, vertical = 7.dp),
                ) {
                    Text(
                        text = if (readingFiles) "读取文件中…" else "+ 添加文件 / 图片 ($totalAttachments/4)",
                        fontSize = 12.5.sp,
                        fontWeight = FontWeight.Medium,
                        color = if (!saving && !readingFiles && totalAttachments < 4) c.blue else c.secondaryLabel,
                    )
                }
            }
            if (!attachmentError.isNullOrBlank()) {
                Text(
                    text = attachmentError!!,
                    fontSize = 12.sp,
                    color = c.red,
                )
            }

            FieldLabel("优先级")
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                listOf(0 to "P0 紧急", 1 to "P1 高", 2 to "P2 普通", 3 to "P3 低").forEach { (p, label) ->
                    val selected = priority == p
                    val pColor = priorityColor(p, c)
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .height(32.dp)
                            .clip(RoundedCornerShape(8.dp))
                            .background(if (selected) pColor else c.tertiaryFill)
                            .clickable(enabled = !saving) { priority = p },
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = label,
                            fontSize = 11.5.sp,
                            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                            color = if (selected) Color.White else c.label,
                            maxLines = 1,
                        )
                    }
                }
            }

            FieldLabel("关联项目")
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                FilterChipPill(
                    label = "未关联项目",
                    selected = !createNewProject && selectedProjectId == null,
                    accent = c.blue,
                    onClick = {
                        if (!saving) {
                            createNewProject = false
                            selectedProjectId = null
                        }
                    },
                )
                projects.forEach { proj ->
                    FilterChipPill(
                        label = proj.name,
                        selected = !createNewProject && selectedProjectId == proj.id,
                        accent = c.blue,
                        onClick = {
                            if (!saving) {
                                createNewProject = false
                                selectedProjectId = proj.id
                            }
                        },
                    )
                }
                FilterChipPill(
                    label = "+ 新建项目",
                    selected = createNewProject,
                    accent = c.indigo,
                    onClick = {
                        if (!saving) {
                            createNewProject = true
                            selectedProjectId = null
                        }
                    },
                )
            }

            if (createNewProject) {
                IosTextField(
                    value = newProjectName,
                    onValueChange = { newProjectName = it },
                    placeholder = "新项目名称（保存后在目标设备 T3 创建）",
                    singleLine = true,
                    enabled = !saving,
                )
                IosTextField(
                    value = newProjectCwd,
                    onValueChange = { newProjectCwd = it },
                    placeholder = "已有代码目录绝对路径（可选，留空自动新建）",
                    singleLine = true,
                    enabled = !saving,
                )
            }
        }
    }
}

private const val MAX_PICKED_TODO_FILE_BYTES = 10 * 1024 * 1024

private fun readPickedTodoAttachment(context: Context, uri: Uri): Result<PendingTodoAttachment> = runCatching {
    var name = uri.lastPathSegment?.substringAfterLast('/')?.trim().orEmpty()
    var declaredSize = -1L
    runCatching {
        context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)
            ?.use { cursor ->
                if (cursor.moveToFirst()) {
                    val nameIdx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    val sizeIdx = cursor.getColumnIndex(OpenableColumns.SIZE)
                    if (nameIdx >= 0 && !cursor.isNull(nameIdx)) name = cursor.getString(nameIdx)
                    if (sizeIdx >= 0 && !cursor.isNull(sizeIdx)) declaredSize = cursor.getLong(sizeIdx)
                }
            }
    }
    if (name.isBlank()) name = "attachment"
    if (declaredSize > MAX_PICKED_TODO_FILE_BYTES) {
        error("文件「$name」超过 10 MB 限制")
    }
    val mimeType = context.contentResolver.getType(uri)?.trim().orEmpty().ifBlank { "application/octet-stream" }
    val bytes = context.contentResolver.openInputStream(uri)?.use { input ->
        val out = ByteArrayOutputStream()
        val buf = ByteArray(32 * 1024)
        var total = 0
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            total += n
            if (total > MAX_PICKED_TODO_FILE_BYTES) error("文件「$name」超过 10 MB 限制")
            out.write(buf, 0, n)
        }
        out.toByteArray()
    } ?: error("无法读取文件「$name」")
    if (bytes.isEmpty()) error("文件「$name」为空，无法上传")
    PendingTodoAttachment(
        localId = UUID.randomUUID().toString(),
        name = name,
        mimeType = mimeType,
        bytes = bytes,
    )
}

private fun openTodoAttachmentFile(context: Context, file: java.io.File, mimeType: String): Boolean {
    return runCatching {
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.rdfiles", file)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, mimeType.ifBlank { "*/*" })
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        context.startActivity(intent)
        true
    }.getOrDefault(false)
}

@Composable
private fun TodoReviewDialog(
    deviceId: String,
    deviceName: String,
    task: DevelopmentTask,
    repository: UBrainRepository,
    canWrite: Boolean,
    canViewT3: Boolean,
    onOpenT3: (String) -> Unit,
    onApproved: (TaskBoard) -> Unit,
    onRejected: () -> Unit,
    onDismiss: () -> Unit,
) {
    val c = IosTheme.colors
    val scope = rememberCoroutineScope()
    var loading by remember(task.id) { mutableStateOf(true) }
    var loadError by remember(task.id) { mutableStateOf<String?>(null) }
    var review by remember(task.id) { mutableStateOf<TaskReview?>(null) }
    var acknowledged by remember(task.id) { mutableStateOf(false) }
    var showRejectBox by remember(task.id) { mutableStateOf(false) }
    var feedback by remember(task.id) { mutableStateOf("") }
    var submitting by remember(task.id) { mutableStateOf(false) }
    var actionError by remember(task.id) { mutableStateOf<String?>(null) }
    var reloadNonce by remember(task.id) { mutableIntStateOf(0) }

    LaunchedEffect(deviceId, task.id, reloadNonce) {
        loading = true
        loadError = null
        val res = repository.reviewTodo(deviceId, task.id)
        res.fold(
            onSuccess = {
                review = it
                loading = false
            },
            onFailure = {
                loadError = it.message ?: "无法读取变更内容"
                loading = false
            },
        )
    }

    Dialog(
        onDismissRequest = { if (!submitting) onDismiss() },
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(
            shape = RoundedCornerShape(16.dp),
            color = if (c.isDark) Color(0xFF1C1C1E) else Color(0xFFF9F9FB),
            tonalElevation = 0.dp,
            shadowElevation = 12.dp,
            modifier = Modifier
                .fillMaxWidth()
                .fillMaxHeight(0.88f)
                .padding(horizontal = 14.dp),
        ) {
            Column(modifier = Modifier.fillMaxSize()) {
                // 标题栏
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 16.dp, vertical = 12.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(
                            text = "核对任务变更",
                            fontSize = 16.5.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = c.label,
                        )
                        Text(
                            text = task.title,
                            fontSize = 12.5.sp,
                            color = c.secondaryLabel,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                    }
                    Box(
                        modifier = Modifier
                            .size(28.dp)
                            .clip(CircleShape)
                            .background(c.tertiaryFill)
                            .clickable(enabled = !submitting, onClick = onDismiss),
                        contentAlignment = Alignment.Center,
                    ) {
                        Icon(
                            imageVector = IosIcons.Close,
                            contentDescription = "关闭",
                            tint = c.secondaryLabel,
                            modifier = Modifier.size(14.dp),
                        )
                    }
                }
                IosHairline()

                when {
                    loading -> {
                        Box(modifier = Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                            Column(
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                CircularProgressIndicator(
                                    modifier = Modifier.size(26.dp),
                                    strokeWidth = 2.4.dp,
                                    color = c.blue,
                                )
                                Text(
                                    text = "正在读取任务分支的变更…",
                                    fontSize = 13.sp,
                                    color = c.secondaryLabel,
                                )
                            }
                        }
                    }
                    loadError != null -> {
                        Column(
                            modifier = Modifier
                                .weight(1f)
                                .fillMaxWidth()
                                .padding(20.dp),
                            horizontalAlignment = Alignment.CenterHorizontally,
                            verticalArrangement = Arrangement.Center,
                        ) {
                            Text(
                                text = loadError ?: "读取失败",
                                fontSize = 14.sp,
                                color = c.red,
                                textAlign = TextAlign.Center,
                            )
                            Spacer(modifier = Modifier.height(12.dp))
                            TaskActionButton(
                                label = "重试",
                                icon = IosIcons.Refresh,
                                bg = c.blue,
                                fg = Color.White,
                                enabled = true,
                                onClick = { reloadNonce += 1 },
                            )
                        }
                    }
                    review != null -> {
                        val rev = review!!
                        val revTask = rev.task
                        val threadUrl = revTask.run?.threadUrl?.takeIf { it.isNotBlank() }

                        Column(
                            modifier = Modifier
                                .weight(1f)
                                .fillMaxWidth()
                                .verticalScroll(rememberScrollState())
                                .padding(horizontal = 16.dp, vertical = 12.dp),
                            verticalArrangement = Arrangement.spacedBy(10.dp),
                        ) {
                            // 分支与提交信息
                            Column(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(10.dp))
                                    .background(c.cardBg)
                                    .padding(10.dp),
                                verticalArrangement = Arrangement.spacedBy(4.dp),
                            ) {
                                revTask.run?.branch?.takeIf { it.isNotBlank() }?.let { branch ->
                                    Text(
                                        text = "任务分支：$branch",
                                        fontSize = 12.sp,
                                        fontFamily = FontFamily.Monospace,
                                        color = c.label,
                                    )
                                }
                                Text(
                                    text = "提交：${TodoLogic.shortSha(rev.baseSha)} → ${TodoLogic.shortSha(rev.headSha)}",
                                    fontSize = 12.sp,
                                    fontFamily = FontFamily.Monospace,
                                    color = c.secondaryLabel,
                                )
                                if (threadUrl != null && canViewT3) {
                                    Spacer(modifier = Modifier.height(4.dp))
                                    TaskActionButton(
                                        label = "在 T3 中查看完整会话",
                                        icon = IosIcons.ExternalLink,
                                        bg = c.blue.copy(alpha = if (c.isDark) 0.22f else 0.12f),
                                        fg = c.blue,
                                        enabled = true,
                                        onClick = { onOpenT3(threadUrl) },
                                    )
                                }
                            }

                            // 处理摘要
                            FieldLabel("处理摘要")
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(10.dp))
                                    .background(c.cardBg)
                                    .padding(10.dp),
                            ) {
                                Text(
                                    text = revTask.run?.summary?.takeIf { it.isNotBlank() }
                                        ?: "暂无摘要，请打开 T3 查看处理过程与测试结果。",
                                    fontSize = 13.sp,
                                    lineHeight = 18.sp,
                                    color = c.label,
                                )
                            }

                            // 文件变更统计
                            if (rev.stat.isNotBlank()) {
                                FieldLabel("文件变更")
                                Box(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clip(RoundedCornerShape(10.dp))
                                        .background(c.cardBg)
                                        .horizontalScroll(rememberScrollState())
                                        .padding(10.dp),
                                ) {
                                    Text(
                                        text = rev.stat.trimEnd(),
                                        fontSize = 11.5.sp,
                                        lineHeight = 16.sp,
                                        fontFamily = FontFamily.Monospace,
                                        color = c.label,
                                    )
                                }
                            }

                            // 代码差异
                            if (rev.diff.isNotBlank()) {
                                FieldLabel("代码差异")
                                if (rev.truncated) {
                                    TodoAlertStrip(
                                        text = "差异较长，此处仅显示部分内容。请在 T3 中核对完整变更后再确认。",
                                        tint = c.orange,
                                    )
                                }
                                DiffCodeBlock(diff = rev.diff)
                            }

                            // 人工核对确认勾选
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .clip(RoundedCornerShape(10.dp))
                                    .background(c.cardBg)
                                    .clickable(enabled = !submitting) { acknowledged = !acknowledged }
                                    .padding(horizontal = 12.dp, vertical = 10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                                horizontalArrangement = Arrangement.spacedBy(10.dp),
                            ) {
                                Box(
                                    modifier = Modifier
                                        .size(20.dp)
                                        .clip(RoundedCornerShape(6.dp))
                                        .background(if (acknowledged) c.blue else Color.Transparent)
                                        .border(
                                            width = 1.5.dp,
                                            color = if (acknowledged) c.blue else c.secondaryLabel,
                                            shape = RoundedCornerShape(6.dp),
                                        ),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    if (acknowledged) {
                                        Icon(
                                            imageVector = IosIcons.Check,
                                            contentDescription = null,
                                            tint = Color.White,
                                            modifier = Modifier.size(13.dp),
                                        )
                                    }
                                }
                                Text(
                                    text = "我已核对变更和验收结果，确认可以合并。",
                                    fontSize = 13.5.sp,
                                    lineHeight = 18.sp,
                                    color = c.label,
                                )
                            }

                            // 退回修改反馈区
                            if (showRejectBox) {
                                FieldLabel("需要修改的内容")
                                IosTextField(
                                    value = feedback,
                                    onValueChange = { feedback = it },
                                    placeholder = "说明尚未达到的要求，T3 会在原任务中继续修改。",
                                    singleLine = false,
                                    maxLines = 4,
                                    enabled = !submitting,
                                )
                            }

                            if (!actionError.isNullOrBlank()) {
                                TodoAlertStrip(text = actionError!!, tint = c.red)
                            }
                        }

                        IosHairline()
                        Column(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 16.dp, vertical = 12.dp),
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            Box(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .height(42.dp)
                                    .clip(RoundedCornerShape(10.dp))
                                    .background(if (acknowledged && canWrite && !submitting) c.green else c.tertiaryFill)
                                    .clickable(enabled = acknowledged && canWrite && !submitting) {
                                        scope.launch {
                                            submitting = true
                                            actionError = null
                                            val res = repository.approveTodo(deviceId, task.id, rev.headSha)
                                            submitting = false
                                            res.fold(
                                                onSuccess = { onApproved(it) },
                                                onFailure = { actionError = it.message ?: "合并失败" },
                                            )
                                        }
                                    },
                                contentAlignment = Alignment.Center,
                            ) {
                                Text(
                                    text = if (submitting) {
                                        "处理中…"
                                    } else if (deviceName.isNotBlank()) {
                                        "确认并合并到 $deviceName 的 develop"
                                    } else {
                                        "确认并合并到 develop"
                                    },
                                    fontSize = 15.sp,
                                    fontWeight = FontWeight.SemiBold,
                                    color = if (acknowledged && canWrite && !submitting) Color.White else c.secondaryLabel,
                                )
                            }

                            if (!showRejectBox) {
                                Box(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .height(38.dp)
                                        .clip(RoundedCornerShape(10.dp))
                                        .background(c.tertiaryFill)
                                        .clickable(enabled = canWrite && !submitting) {
                                            showRejectBox = true
                                        },
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Text(
                                        text = "退回 T3 修改",
                                        fontSize = 14.sp,
                                        fontWeight = FontWeight.Medium,
                                        color = c.red,
                                    )
                                }
                            } else {
                                Row(
                                    modifier = Modifier.fillMaxWidth(),
                                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                                ) {
                                    Box(
                                        modifier = Modifier
                                            .weight(1f)
                                            .height(38.dp)
                                            .clip(RoundedCornerShape(10.dp))
                                            .background(c.tertiaryFill)
                                            .clickable(enabled = !submitting) { showRejectBox = false },
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        Text("取消退回", fontSize = 14.sp, color = c.label)
                                    }
                                    val canReject = canWrite && !submitting && feedback.trim().isNotEmpty()
                                    Box(
                                        modifier = Modifier
                                            .weight(1.4f)
                                            .height(38.dp)
                                            .clip(RoundedCornerShape(10.dp))
                                            .background(if (canReject) c.red else c.tertiaryFill)
                                            .clickable(enabled = canReject) {
                                                scope.launch {
                                                    submitting = true
                                                    actionError = null
                                                    val res = repository.rejectTodo(deviceId, task.id, feedback)
                                                    submitting = false
                                                    res.fold(
                                                        onSuccess = { onRejected() },
                                                        onFailure = { actionError = it.message ?: "退回失败" },
                                                    )
                                                }
                                            },
                                        contentAlignment = Alignment.Center,
                                    ) {
                                        Text(
                                            text = "发送修改反馈",
                                            fontSize = 14.sp,
                                            fontWeight = FontWeight.SemiBold,
                                            color = if (canReject) Color.White else c.secondaryLabel,
                                        )
                                    }
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
private fun DiffCodeBlock(diff: String) {
    val c = IosTheme.colors
    val lines = remember(diff) { diff.lines().take(500) }
    val hasMore = remember(diff) { diff.lines().size > 500 }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(if (c.isDark) Color(0xFF121214) else Color(0xFFFAFAFC))
            .border(0.5.dp, c.separator.copy(alpha = 0.5f), RoundedCornerShape(10.dp))
            .horizontalScroll(rememberScrollState())
            .padding(vertical = 6.dp),
    ) {
        lines.forEach { line ->
            val bg = when {
                line.startsWith("+") && !line.startsWith("+++") -> c.green.copy(alpha = if (c.isDark) 0.16f else 0.12f)
                line.startsWith("-") && !line.startsWith("---") -> c.red.copy(alpha = if (c.isDark) 0.16f else 0.12f)
                line.startsWith("@@") -> c.blue.copy(alpha = if (c.isDark) 0.14f else 0.08f)
                else -> Color.Transparent
            }
            val fg = when {
                line.startsWith("+") && !line.startsWith("+++") -> c.green
                line.startsWith("-") && !line.startsWith("---") -> c.red
                line.startsWith("@@") -> c.blue
                line.startsWith("diff ") || line.startsWith("+++") || line.startsWith("---") -> c.secondaryLabel
                else -> c.label
            }
            Text(
                text = line.ifEmpty { " " },
                fontSize = 11.sp,
                lineHeight = 15.5.sp,
                fontFamily = FontFamily.Monospace,
                color = fg,
                softWrap = false,
                modifier = Modifier
                    .background(bg)
                    .padding(horizontal = 8.dp),
            )
        }
        if (hasMore) {
            Text(
                text = "… 仅展示前 500 行差异，请在 T3 中查看完整内容",
                fontSize = 11.sp,
                color = c.secondaryLabel,
                modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
            )
        }
    }
}

@Composable
private fun FilterChipPill(
    label: String,
    selected: Boolean,
    accent: Color,
    onClick: () -> Unit,
) {
    val c = IosTheme.colors
    Box(
        modifier = Modifier
            .height(28.dp)
            .clip(CircleShape)
            .background(if (selected) accent else c.cardBg)
            .border(
                width = 0.5.dp,
                color = if (selected) Color.Transparent else c.separator.copy(alpha = 0.45f),
                shape = CircleShape,
            )
            .clickable(onClick = onClick)
            .padding(horizontal = 11.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = label,
            fontSize = 12.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
            color = if (selected) Color.White else c.label,
            maxLines = 1,
            softWrap = false,
        )
    }
}

@Composable
private fun BadgePill(
    text: String,
    color: Color,
    showDot: Boolean = false,
) {
    val c = IosTheme.colors
    Row(
        modifier = Modifier
            .clip(CircleShape)
            .background(color.copy(alpha = if (c.isDark) 0.22f else 0.12f))
            .padding(horizontal = 8.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (showDot) {
            Box(
                modifier = Modifier
                    .size(5.dp)
                    .clip(CircleShape)
                    .background(color),
            )
        }
        Text(
            text = text,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            color = color,
            maxLines = 1,
        )
    }
}

@Composable
private fun MetaChip(
    text: String,
    icon: ImageVector? = null,
    monospace: Boolean = false,
) {
    val c = IosTheme.colors
    Row(
        modifier = Modifier
            .clip(RoundedCornerShape(6.dp))
            .background(c.quaternaryFill)
            .padding(horizontal = 7.dp, vertical = 3.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (icon != null) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = c.secondaryLabel,
                modifier = Modifier.size(12.dp),
            )
        }
        Text(
            text = text,
            fontSize = 11.5.sp,
            fontFamily = if (monospace) FontFamily.Monospace else FontFamily.Default,
            color = c.secondaryLabel,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun TaskActionButton(
    label: String,
    icon: ImageVector,
    bg: Color,
    fg: Color,
    enabled: Boolean,
    loading: Boolean = false,
    onClick: () -> Unit,
) {
    val c = IosTheme.colors
    val actualBg = if (enabled) bg else c.tertiaryFill.copy(alpha = 0.65f)
    val actualFg = if (enabled) fg else c.secondaryLabel.copy(alpha = 0.7f)
    Row(
        modifier = Modifier
            .height(30.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(actualBg)
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        if (loading) {
            CircularProgressIndicator(
                modifier = Modifier.size(12.dp),
                strokeWidth = 1.6.dp,
                color = actualFg,
            )
        } else {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = actualFg,
                modifier = Modifier.size(13.dp),
            )
        }
        Text(
            text = label,
            fontSize = 12.5.sp,
            fontWeight = FontWeight.Medium,
            color = actualFg,
            maxLines = 1,
        )
    }
}

@Composable
private fun FieldLabel(text: String) {
    Text(
        text = text,
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        color = IosTheme.colors.secondaryLabel,
    )
}

@Composable
private fun TodoAlertStrip(
    text: String,
    tint: Color,
    modifier: Modifier = Modifier,
    onDismiss: (() -> Unit)? = null,
) {
    val c = IosTheme.colors
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(tint.copy(alpha = if (c.isDark) 0.20f else 0.12f))
            .padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = text,
            fontSize = 12.5.sp,
            lineHeight = 17.sp,
            color = tint,
            modifier = Modifier.weight(1f),
        )
        if (onDismiss != null) {
            Icon(
                imageVector = IosIcons.Close,
                contentDescription = "关闭",
                tint = tint,
                modifier = Modifier
                    .size(15.dp)
                    .clickable(onClick = onDismiss),
            )
        }
    }
}

@Composable
private fun TodoEmptyCard(
    icon: ImageVector,
    iconBg: Color,
    title: String,
    subtitle: String,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    val c = IosTheme.colors
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(16.dp))
                .background(c.cardBg)
                .padding(horizontal = 20.dp, vertical = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            IosIconBadge(icon = icon, background = iconBg)
            Text(
                text = title,
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                color = c.label,
                textAlign = TextAlign.Center,
            )
            Text(
                text = subtitle,
                fontSize = 13.sp,
                lineHeight = 18.sp,
                color = c.secondaryLabel,
                textAlign = TextAlign.Center,
            )
            if (actionLabel != null && onAction != null) {
                Spacer(modifier = Modifier.height(4.dp))
                Box(
                    modifier = Modifier
                        .height(38.dp)
                        .clip(RoundedCornerShape(10.dp))
                        .background(c.blue)
                        .clickable(onClick = onAction)
                        .padding(horizontal = 20.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = actionLabel,
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = Color.White,
                    )
                }
            }
        }
    }
}

@Composable
private fun TodoErrorCard(
    deviceName: String,
    error: String,
    loading: Boolean,
    onRetry: () -> Unit,
) {
    val c = IosTheme.colors
    Box(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        contentAlignment = Alignment.Center,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(16.dp))
                .background(c.cardBg)
                .padding(horizontal = 20.dp, vertical = 24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            IosIconBadge(icon = IosIcons.Checklist, background = c.red)
            Text(
                text = "无法加载 $deviceName 的 TODO",
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                color = c.label,
                textAlign = TextAlign.Center,
            )
            Text(
                text = error,
                fontSize = 13.sp,
                lineHeight = 18.sp,
                color = c.secondaryLabel,
                textAlign = TextAlign.Center,
            )
            Spacer(modifier = Modifier.height(4.dp))
            Box(
                modifier = Modifier
                    .height(38.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(c.blue)
                    .clickable(enabled = !loading, onClick = onRetry)
                    .padding(horizontal = 20.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = if (loading) "重试中…" else "重新加载",
                    fontSize = 14.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = Color.White,
                )
            }
        }
    }
}

private fun priorityColor(priority: Int, c: IosColors): Color = when (priority.coerceIn(0, 3)) {
    0 -> c.red
    1 -> c.orange
    2 -> c.blue
    else -> c.secondaryLabel
}

private fun statusColor(task: DevelopmentTask, c: IosColors): Color = when (task.status) {
    "queued" -> c.secondaryLabel
    "preparing", "planning", "running" -> c.blue
    "merging" -> c.indigo
    "review" -> c.orange
    "done" -> c.green
    "failed" -> c.red
    else -> c.secondaryLabel
}
