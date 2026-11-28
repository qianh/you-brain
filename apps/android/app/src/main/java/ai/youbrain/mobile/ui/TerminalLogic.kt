package ai.youbrain.mobile.ui

import ai.youbrain.mobile.data.DeviceTty7State
import ai.youbrain.mobile.data.MobilePushItem
import ai.youbrain.mobile.data.RelayDevice
import ai.youbrain.mobile.data.Tty7Session

data class CrossDeviceTerminalItem(
    val device: RelayDevice,
    val deviceDisplayName: String,
    val session: Tty7Session,
)

data class ProjectTerminalGroup(
    val projectName: String,
    val cwd: String,
    val sessions: List<Tty7Session>,
    val waitingCount: Int,
    val workingCount: Int,
)

object TerminalLogic {
    private val PANE_THREAD_REGEX = Regex("^pane:(\\d+)$")
    private val PANE_QUERY_REGEX = Regex("[?&]pane=(\\d+)")

    fun parsePaneFromPush(item: MobilePushItem): Int? {
        if (item.kind != "tty7") return null
        item.threadId?.trim()?.let { tid ->
            PANE_THREAD_REGEX.matchEntire(tid)?.groupValues?.getOrNull(1)?.toIntOrNull()?.let { return it }
        }
        item.link?.trim()?.let { link ->
            PANE_QUERY_REGEX.find(link)?.groupValues?.getOrNull(1)?.toIntOrNull()?.let { return it }
        }
        return null
    }

    fun projectName(cwd: String): String {
        val clean = cwd.trim().trimEnd('/', '\\')
        if (clean.isEmpty()) return "未分类"
        val slash = maxOf(clean.lastIndexOf('/'), clean.lastIndexOf('\\'))
        return if (slash >= 0 && slash < clean.lastIndex) clean.substring(slash + 1) else clean
    }

    /** 与桌面端 apps/web/src/pages/deck-tty7-sessions.ts 的 sessionTitle 口径保持一致。 */
    fun sessionTitle(session: Tty7Session): String {
        val label = session.tabLabel?.trim().orEmpty()
        val task = session.task?.trim().orEmpty()
        if (session.tabNamed == true && label.isNotEmpty()) return label
        if (task.isNotEmpty()) return task
        if (label.isNotEmpty()) return label
        val agent = session.agent?.trim().orEmpty()
        val dir = projectName(session.cwd)
        return if (agent.isNotEmpty()) "$agent · $dir" else "$dir #%d".format(session.pane)
    }

    fun isActiveSession(session: Tty7Session): Boolean {
        if (session.hibernated) return false
        return session.status == "waiting" || session.status == "working" || session.status == "done" || !session.agent.isNullOrBlank()
    }

    fun statusRank(status: String?, hibernated: Boolean): Int {
        if (hibernated) return 5
        return when (status) {
            "waiting" -> 0
            "working" -> 1
            "done" -> 2
            "idle" -> 3
            else -> 4
        }
    }

    fun statusLabel(status: String?, hibernated: Boolean): String {
        if (hibernated) return "已休眠"
        return when (status) {
            "waiting" -> "等你回复"
            "working" -> "运行中"
            "done" -> "已完成"
            "idle" -> "空闲"
            else -> "在线"
        }
    }

    fun matchesQuery(
        session: Tty7Session,
        deviceDisplayName: String,
        query: String,
    ): Boolean {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return true
        return sessionTitle(session).lowercase().contains(q) ||
            projectName(session.cwd).lowercase().contains(q) ||
            session.cwd.lowercase().contains(q) ||
            session.agent.orEmpty().lowercase().contains(q) ||
            session.model.orEmpty().lowercase().contains(q) ||
            session.statusMessage.orEmpty().lowercase().contains(q) ||
            deviceDisplayName.lowercase().contains(q) ||
            "%${session.pane}".contains(q)
    }

    fun buildCrossDeviceItems(
        devices: List<RelayDevice>,
        boards: Map<String, DeviceTty7State>,
        displayNameOf: (RelayDevice) -> String,
        query: String,
        activeOnly: Boolean,
    ): List<CrossDeviceTerminalItem> {
        val out = ArrayList<CrossDeviceTerminalItem>()
        for (dev in devices) {
            val sessions = boards[dev.id]?.data?.sessions.orEmpty()
            val name = displayNameOf(dev)
            for (s in sessions) {
                if (activeOnly && !isActiveSession(s)) continue
                if (!matchesQuery(s, name, query)) continue
                out.add(CrossDeviceTerminalItem(device = dev, deviceDisplayName = name, session = s))
            }
        }
        return out.sortedWith(
            compareBy<CrossDeviceTerminalItem> { statusRank(it.session.status, it.session.hibernated) }
                .thenBy { it.deviceDisplayName.lowercase() }
                .thenBy { projectName(it.session.cwd).lowercase() }
                .thenBy { it.session.pane },
        )
    }

    fun groupByProject(
        sessions: List<Tty7Session>,
        deviceDisplayName: String,
        query: String,
        activeOnly: Boolean,
    ): List<ProjectTerminalGroup> {
        val filtered = sessions.filter { s ->
            (!activeOnly || isActiveSession(s)) && matchesQuery(s, deviceDisplayName, query)
        }
        val grouped = LinkedHashMap<String, MutableList<Tty7Session>>()
        for (s in filtered) {
            val key = s.cwd.trim().trimEnd('/', '\\').ifEmpty { "未分类" }
            grouped.getOrPut(key) { ArrayList() }.add(s)
        }
        return grouped.entries.map { (cwdKey, list) ->
            val sorted = list.sortedWith(
                compareBy<Tty7Session> { statusRank(it.status, it.hibernated) }
                    .thenBy { it.pane },
            )
            ProjectTerminalGroup(
                projectName = projectName(cwdKey),
                cwd = cwdKey,
                sessions = sorted,
                waitingCount = sorted.count { !it.hibernated && it.status == "waiting" },
                workingCount = sorted.count { !it.hibernated && it.status == "working" },
            )
        }.sortedWith(
            compareByDescending<ProjectTerminalGroup> { it.waitingCount > 0 }
                .thenByDescending { it.workingCount > 0 }
                .thenBy { it.projectName.lowercase() },
        )
    }

    fun totalWaitingCount(boards: Map<String, DeviceTty7State>): Int =
        boards.values.sumOf { state ->
            state.data?.sessions.orEmpty().count { !it.hibernated && it.status == "waiting" }
        }
}
