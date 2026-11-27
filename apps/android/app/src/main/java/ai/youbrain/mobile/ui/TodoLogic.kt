package ai.youbrain.mobile.ui

import ai.youbrain.mobile.data.DevelopmentTask
import ai.youbrain.mobile.data.RelayDevice
import ai.youbrain.mobile.data.TaskBoard
import ai.youbrain.mobile.data.TaskWorktreeBlock
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

const val PROJECT_FILTER_ALL = "__all__"
const val PROJECT_FILTER_UNASSIGNED = "__unassigned__"

enum class TodoStatusFilter(val key: String, val label: String) {
    ALL("all", "全部"),
    QUEUED("queued", "待处理"),
    ACTIVE("active", "进行中"),
    REVIEW("review", "待核对"),
    FAILED("failed", "需要处理"),
    DONE("done", "已完成"),
}

data class TodoCounts(
    val all: Int = 0,
    val queued: Int = 0,
    val active: Int = 0,
    val review: Int = 0,
    val failed: Int = 0,
    val done: Int = 0,
)

object TodoLogic {
    fun isTaskActive(status: String): Boolean =
        status == "preparing" || status == "planning" || status == "running" || status == "merging"

    fun hasActiveTasks(board: TaskBoard?): Boolean =
        board?.tasks?.any { isTaskActive(it.status) } == true

    fun reviewCount(board: TaskBoard?): Int =
        board?.tasks?.count { it.status == "review" } ?: 0

    fun totalReviewCount(boards: Map<String, TaskBoard?>): Int =
        boards.values.sumOf { reviewCount(it) }

    fun matchesProject(task: DevelopmentTask, projectFilter: String): Boolean = when (projectFilter) {
        PROJECT_FILTER_ALL -> true
        PROJECT_FILTER_UNASSIGNED -> task.projectId == null
        else -> task.projectId == projectFilter
    }

    fun taskCounts(
        tasks: List<DevelopmentTask>,
        projectFilter: String = PROJECT_FILTER_ALL,
    ): TodoCounts {
        var all = 0
        var queued = 0
        var active = 0
        var review = 0
        var failed = 0
        var done = 0
        for (task in tasks) {
            if (!matchesProject(task, projectFilter)) continue
            all += 1
            when {
                isTaskActive(task.status) -> active += 1
                task.status == "queued" -> queued += 1
                task.status == "review" -> review += 1
                task.status == "failed" -> failed += 1
                task.status == "done" -> done += 1
            }
        }
        return TodoCounts(
            all = all,
            queued = queued,
            active = active,
            review = review,
            failed = failed,
            done = done,
        )
    }

    fun visibleTasks(
        tasks: List<DevelopmentTask>,
        projectFilter: String = PROJECT_FILTER_ALL,
        statusFilter: TodoStatusFilter = TodoStatusFilter.ALL,
    ): List<DevelopmentTask> = tasks
        .filter { task ->
            matchesProject(task, projectFilter) && when (statusFilter) {
                TodoStatusFilter.ALL -> true
                TodoStatusFilter.ACTIVE -> isTaskActive(task.status)
                TodoStatusFilter.QUEUED -> task.status == "queued"
                TodoStatusFilter.REVIEW -> task.status == "review"
                TodoStatusFilter.FAILED -> task.status == "failed"
                TodoStatusFilter.DONE -> task.status == "done"
            }
        }
        .sortedWith(
            compareBy<DevelopmentTask> { it.priority }
                .thenBy { it.createdAt },
        )

    fun projectTasks(tasks: List<DevelopmentTask>, projectId: String): List<DevelopmentTask> {
        fun rank(task: DevelopmentTask): Int = when (task.status) {
            "review" -> 1
            "failed" -> 2
            else -> 0
        }
        return tasks
            .filter { it.projectId == projectId && it.status != "queued" && it.status != "done" }
            .sortedBy(::rank)
    }

    fun projectQueuedCount(tasks: List<DevelopmentTask>, projectId: String): Int =
        tasks.count { it.projectId == projectId && it.status == "queued" }

    fun taskStatusLabel(task: DevelopmentTask): String {
        if (task.status == "failed" && task.worktreeBlock != null) return "本轮已结束"
        if (task.status == "done" && task.projectId != null && task.completedManually != true) {
            return "已合并"
        }
        return when (task.status) {
            "queued" -> "待处理"
            "preparing" -> "正在启动"
            "planning" -> "需求确认"
            "running" -> "T3 处理中"
            "review" -> "待人工核对"
            "merging" -> "合并中"
            "done" -> "已完成"
            "failed" -> "需要处理"
            else -> task.status
        }
    }

    fun taskWorktreeHint(block: TaskWorktreeBlock): String {
        val detail = when {
            block.uncommitted > 0 && block.untracked > 0 ->
                "等待处理 ${block.uncommitted} 个有未提交改动的文件和 ${block.untracked} 个未跟踪文件。"
            block.uncommitted > 0 ->
                "等待处理 ${block.uncommitted} 个有未提交改动的文件。"
            else ->
                "等待处理 ${block.untracked} 个未跟踪文件。"
        }
        return "${detail}请在 T3 中确认后重新检查。"
    }

    fun priorityBadge(priority: Int): String = "P${priority.coerceIn(0, 3)}"

    fun priorityFullLabel(priority: Int): String = when (priority.coerceIn(0, 3)) {
        0 -> "P0 · 紧急"
        1 -> "P1 · 高"
        2 -> "P2 · 普通"
        else -> "P3 · 低"
    }

    fun formatRelativeIsoTime(iso: String, now: Instant = Instant.now()): String {
        if (iso.isBlank()) return ""
        val parsed = runCatching { Instant.parse(iso) }.getOrNull() ?: return ""
        val sec = Duration.between(parsed, now).seconds
        if (sec < 60) return "刚刚"
        val min = sec / 60
        if (min < 60) return "${min} 分钟前"
        val hours = min / 60
        if (hours < 24) return "${hours} 小时前"
        val days = hours / 24
        if (days < 7) return "${days} 天前"
        return DateTimeFormatter.ofPattern("MM-dd HH:mm")
            .withZone(ZoneId.systemDefault())
            .format(parsed)
    }

    fun shortSha(sha: String?): String =
        sha?.trim()?.take(7).orEmpty()

    fun formatAttachmentSize(bytes: Long): String = when {
        bytes < 1024L -> "$bytes B"
        bytes < 1024L * 1024L -> {
            val kb = bytes / 1024.0
            if (bytes < 10L * 1024L) String.format(Locale.US, "%.1f KB", kb) else "${bytes / 1024L} KB"
        }
        else -> String.format(Locale.US, "%.1f MB", bytes / (1024.0 * 1024.0))
    }

    /** 统一解析当前设备：显式选中且仍在设备列表里时绝不跳走；未选时优先主控在线设备，其次首个在线设备。 */
    fun resolveActiveDeviceId(
        selectedDeviceId: String?,
        devices: List<RelayDevice>,
        masterDeviceId: String? = null,
    ): String? {
        if (!selectedDeviceId.isNullOrBlank() && devices.any { it.id == selectedDeviceId }) {
            return selectedDeviceId
        }
        val masterOnline = masterDeviceId?.takeIf { id ->
            devices.any { it.id == id && it.online }
        }
        return masterOnline ?: devices.firstOrNull { it.online }?.id ?: devices.firstOrNull()?.id
    }
}
