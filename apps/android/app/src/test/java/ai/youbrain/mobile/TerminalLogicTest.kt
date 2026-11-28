package ai.youbrain.mobile

import ai.youbrain.mobile.data.DeviceTty7State
import ai.youbrain.mobile.data.HelloDispatch
import ai.youbrain.mobile.data.MobilePushItem
import ai.youbrain.mobile.data.RelayDevice
import ai.youbrain.mobile.data.Tty7Session
import ai.youbrain.mobile.data.Tty7SessionsResponse
import ai.youbrain.mobile.ui.TerminalLogic
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TerminalLogicTest {
    private fun push(
        kind: String = "tty7",
        threadId: String? = null,
        link: String? = null,
    ) = MobilePushItem(
        seq = 1L,
        ts = 1L,
        deviceId = "dev-mac",
        deviceName = "MacBook",
        kind = kind,
        title = "终端等待回复",
        body = "是否继续？",
        threadId = threadId,
        link = link,
    )

    @Test
    fun parsePaneFromPush_extractsPaneFromThreadIdAndLink() {
        assertEquals(12, TerminalLogic.parsePaneFromPush(push(threadId = "pane:12")))
        assertEquals(7, TerminalLogic.parsePaneFromPush(push(link = "http://127.0.0.1:4789/deck?pane=7")))
        assertNull(TerminalLogic.parsePaneFromPush(push(kind = "t3", threadId = "pane:12")))
        assertNull(TerminalLogic.parsePaneFromPush(push(threadId = "invalid")))
    }

    @Test
    fun sessionTitle_matchesDesktopPriorityRules() {
        val manual = Tty7Session(
            pane = 1,
            tabLabel = "自定义名",
            tabNamed = true,
            task = "本轮任务",
            cwd = "/Users/me/app",
        )
        assertEquals("自定义名", TerminalLogic.sessionTitle(manual))

        val withTask = Tty7Session(
            pane = 2,
            tabLabel = "claude",
            tabNamed = false,
            task = "修复登录态",
            cwd = "/Users/me/app",
        )
        assertEquals("修复登录态", TerminalLogic.sessionTitle(withTask))

        val fallback = Tty7Session(
            pane = 3,
            agent = "Codex",
            cwd = "/Users/me/you-brain/",
        )
        assertEquals("Codex · you-brain", TerminalLogic.sessionTitle(fallback))
    }

    @Test
    fun buildCrossDeviceItems_prioritizesWaitingThenWorkingAndFiltersCorrectly() {
        val mac = RelayDevice(id = "mac", name = "MacBook", online = true, enrolled = true, dispatch = HelloDispatch(viewT3 = true))
        val vps = RelayDevice(id = "vps", name = "VPS", online = true, enrolled = true, dispatch = HelloDispatch(viewT3 = true))
        val boards = mapOf(
            "mac" to DeviceTty7State(
                data = Tty7SessionsResponse(
                    available = true,
                    sessions = listOf(
                        Tty7Session(pane = 1, tabLabel = "shell", cwd = "/tmp/a", status = "idle"),
                        Tty7Session(pane = 2, tabLabel = "claude", agent = "Claude", cwd = "/work/app", status = "working"),
                    ),
                ),
            ),
            "vps" to DeviceTty7State(
                data = Tty7SessionsResponse(
                    available = true,
                    sessions = listOf(
                        Tty7Session(pane = 5, tabLabel = "deploy", agent = "Codex", cwd = "/srv/api", status = "waiting"),
                        Tty7Session(pane = 6, tabLabel = "old", cwd = "/srv/old", hibernated = true, status = "waiting"),
                    ),
                ),
            ),
        )

        val all = TerminalLogic.buildCrossDeviceItems(
            devices = listOf(mac, vps),
            boards = boards,
            displayNameOf = { it.name },
            query = "",
            activeOnly = false,
        )
        assertEquals(listOf(5, 2, 1, 6), all.map { it.session.pane })
        assertEquals(1, TerminalLogic.totalWaitingCount(boards))

        val activeOnly = TerminalLogic.buildCrossDeviceItems(
            devices = listOf(mac, vps),
            boards = boards,
            displayNameOf = { it.name },
            query = "",
            activeOnly = true,
        )
        assertEquals(listOf(5, 2), activeOnly.map { it.session.pane })

        val searched = TerminalLogic.buildCrossDeviceItems(
            devices = listOf(mac, vps),
            boards = boards,
            displayNameOf = { it.name },
            query = "codex",
            activeOnly = false,
        )
        assertEquals(listOf(5), searched.map { it.session.pane })
    }

    @Test
    fun groupByProject_ordersGroupsWithWaitingAndWorkingFirst() {
        val sessions = listOf(
            Tty7Session(pane = 1, cwd = "/repo/alpha", status = "idle"),
            Tty7Session(pane = 2, cwd = "/repo/zeta", status = "waiting", agent = "Claude"),
            Tty7Session(pane = 3, cwd = "/repo/beta", status = "working", agent = "Codex"),
        )
        val groups = TerminalLogic.groupByProject(
            sessions = sessions,
            deviceDisplayName = "MacBook",
            query = "",
            activeOnly = false,
        )
        assertEquals(listOf("zeta", "beta", "alpha"), groups.map { it.projectName })
        assertEquals(1, groups[0].waitingCount)
        assertEquals(1, groups[1].workingCount)
    }
}
