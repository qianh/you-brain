package ai.youbrain.mobile

import ai.youbrain.mobile.data.DevelopmentTask
import ai.youbrain.mobile.data.RelayDevice
import ai.youbrain.mobile.data.TaskBoard
import ai.youbrain.mobile.data.TaskImage
import ai.youbrain.mobile.data.TaskReview
import ai.youbrain.mobile.data.TaskRun
import ai.youbrain.mobile.data.TaskWorktreeBlock
import ai.youbrain.mobile.ui.PROJECT_FILTER_ALL
import ai.youbrain.mobile.ui.PROJECT_FILTER_UNASSIGNED
import ai.youbrain.mobile.ui.TodoLogic
import ai.youbrain.mobile.ui.TodoStatusFilter
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class TodoLogicTest {
    private val json = Json { ignoreUnknownKeys = true; isLenient = true }

    @Test
    fun deserializesDaemonTaskBoardAndReview() {
        val boardRaw = """
            {
              "projects": [
                { "id": "proj-1", "name": "you-brain", "cwd": "/Users/hong/you-brain", "enabled": true }
              ],
              "tasks": [
                {
                  "id": "t-1",
                  "title": "Add mobile TODO",
                  "description": "Allow maintaining todos on phone",
                  "images": [{ "id": "img-1", "name": "shot.png", "mimeType": "image/png", "sizeBytes": 1234 }],
                  "projectId": "proj-1",
                  "priority": 1,
                  "status": "review",
                  "createdAt": "2026-04-01T10:00:00.000Z",
                  "updatedAt": "2026-04-01T11:00:00.000Z",
                  "run": {
                    "projectCwd": "/Users/hong/you-brain",
                    "threadId": "th-1",
                    "threadUrl": "http://127.0.0.1:3773/th-1",
                    "reviewSha": "abcdef1234567890",
                    "summary": "Implemented mobile TODO tab",
                    "branch": "task/mobile-todo",
                    "baseSha": "0000111122223333"
                  }
                },
                {
                  "id": "t-2",
                  "title": "Unassigned note",
                  "description": "",
                  "projectId": null,
                  "priority": 2,
                  "status": "failed",
                  "createdAt": "2026-04-01T09:00:00.000Z",
                  "updatedAt": "2026-04-01T09:30:00.000Z",
                  "worktreeBlock": { "uncommitted": 2, "untracked": 1 }
                }
              ],
              "connectionError": null
            }
        """.trimIndent()

        val board = json.decodeFromString(TaskBoard.serializer(), boardRaw)
        assertEquals(1, board.projects.size)
        assertEquals("you-brain", board.projects[0].name)
        assertTrue(board.projects[0].enabled)
        assertEquals(2, board.tasks.size)
        assertEquals(1, board.tasks[0].images.size)
        assertEquals("abcdef1234567890", board.tasks[0].run?.reviewSha)
        assertNull(board.tasks[1].projectId)
        assertEquals(2, board.tasks[1].worktreeBlock?.uncommitted)
        assertEquals(1, board.tasks[1].worktreeBlock?.untracked)

        val reviewRaw = """
            {
              "task": {
                "id": "t-1",
                "title": "Add mobile TODO",
                "projectId": "proj-1",
                "priority": 1,
                "status": "review",
                "createdAt": "2026-04-01T10:00:00.000Z",
                "updatedAt": "2026-04-01T11:00:00.000Z"
              },
              "headSha": "abcdef1234567890",
              "baseSha": "0000111122223333",
              "stat": "1 file changed, 10 insertions(+)",
              "diff": "+hello\n-world",
              "truncated": true
            }
        """.trimIndent()
        val review = json.decodeFromString(TaskReview.serializer(), reviewRaw)
        assertEquals("abcdef1", TodoLogic.shortSha(review.headSha))
        assertTrue(review.truncated)
        assertEquals("+hello\n-world", review.diff)
    }

    @Test
    fun countsFiltersAndSortsTasks() {
        val tasks = listOf(
            DevelopmentTask(id = "a", title = "A", projectId = "p1", priority = 2, status = "queued", createdAt = "2026-04-01T10:00:00Z"),
            DevelopmentTask(id = "b", title = "B", projectId = "p1", priority = 0, status = "queued", createdAt = "2026-04-01T12:00:00Z"),
            DevelopmentTask(id = "c", title = "C", projectId = "p1", priority = 1, status = "running", createdAt = "2026-04-01T08:00:00Z"),
            DevelopmentTask(id = "d", title = "D", projectId = "p1", priority = 1, status = "planning", createdAt = "2026-04-01T09:00:00Z"),
            DevelopmentTask(id = "e", title = "E", projectId = "p1", priority = 2, status = "review", createdAt = "2026-04-01T07:00:00Z"),
            DevelopmentTask(id = "f", title = "F", projectId = "p1", priority = 3, status = "failed", createdAt = "2026-04-01T06:00:00Z"),
            DevelopmentTask(id = "g", title = "G", projectId = null, priority = 1, status = "done", createdAt = "2026-04-01T05:00:00Z"),
        )

        val allCounts = TodoLogic.taskCounts(tasks, PROJECT_FILTER_ALL)
        assertEquals(7, allCounts.all)
        assertEquals(2, allCounts.queued)
        assertEquals(2, allCounts.active)
        assertEquals(1, allCounts.review)
        assertEquals(1, allCounts.failed)
        assertEquals(1, allCounts.done)

        val unassignedCounts = TodoLogic.taskCounts(tasks, PROJECT_FILTER_UNASSIGNED)
        assertEquals(1, unassignedCounts.all)
        assertEquals(1, unassignedCounts.done)

        val queuedSorted = TodoLogic.visibleTasks(tasks, "p1", TodoStatusFilter.QUEUED)
        assertEquals(listOf("b", "a"), queuedSorted.map { it.id })

        val activeSorted = TodoLogic.visibleTasks(tasks, "p1", TodoStatusFilter.ACTIVE)
        assertEquals(listOf("c", "d"), activeSorted.map { it.id })

        val projActive = TodoLogic.projectTasks(tasks, "p1")
        assertEquals(listOf("c", "d", "e", "f"), projActive.map { it.id })
        assertTrue(TodoLogic.hasActiveTasks(TaskBoard(tasks = tasks)))
        assertFalse(TodoLogic.hasActiveTasks(TaskBoard(tasks = queuedSorted)))
    }

    @Test
    fun formatsStatusLabelsWorktreeHintAndRelativeTime() {
        val mergedTask = DevelopmentTask(
            id = "1",
            title = "Merged",
            projectId = "p1",
            status = "done",
            completedManually = false,
            run = TaskRun(merged = true),
        )
        val manualDoneTask = DevelopmentTask(
            id = "2",
            title = "Manual",
            projectId = "p1",
            status = "done",
            completedManually = true,
        )
        val unassignedDoneTask = DevelopmentTask(
            id = "3",
            title = "Note",
            projectId = null,
            status = "done",
        )
        val blockedTask = DevelopmentTask(
            id = "4",
            title = "Blocked",
            projectId = "p1",
            status = "failed",
            worktreeBlock = TaskWorktreeBlock(uncommitted = 1, untracked = 2),
        )

        assertEquals("已合并", TodoLogic.taskStatusLabel(mergedTask))
        assertEquals("已完成", TodoLogic.taskStatusLabel(manualDoneTask))
        assertEquals("已完成", TodoLogic.taskStatusLabel(unassignedDoneTask))
        assertEquals("本轮已结束", TodoLogic.taskStatusLabel(blockedTask))
        assertEquals(
            "等待处理 1 个有未提交改动的文件和 2 个未跟踪文件。请在 T3 中确认后重新检查。",
            TodoLogic.taskWorktreeHint(blockedTask.worktreeBlock!!),
        )

        val now = Instant.parse("2026-04-01T12:00:00Z")
        assertEquals("刚刚", TodoLogic.formatRelativeIsoTime("2026-04-01T11:59:30Z", now))
        assertEquals("5 分钟前", TodoLogic.formatRelativeIsoTime("2026-04-01T11:55:00Z", now))
        assertEquals("2 小时前", TodoLogic.formatRelativeIsoTime("2026-04-01T10:00:00Z", now))
        assertEquals("3 天前", TodoLogic.formatRelativeIsoTime("2026-03-29T12:00:00Z", now))

        val totalReview = TodoLogic.totalReviewCount(
            mapOf(
                "dev-1" to TaskBoard(tasks = listOf(DevelopmentTask(id = "r1", title = "R1", status = "review"))),
                "dev-2" to TaskBoard(tasks = listOf(
                    DevelopmentTask(id = "r2", title = "R2", status = "review"),
                    DevelopmentTask(id = "q1", title = "Q1", status = "queued"),
                )),
                "dev-3" to null,
            ),
        )
        assertEquals(2, totalReview)
    }

    @Test
    fun resolvesUnifiedActiveDeviceAndFormatsAttachments() {
        val mac = RelayDevice(id = "dev-mac", name = "Mac", online = false, enrolled = true)
        val vps = RelayDevice(id = "dev-vps", name = "VPS", online = true, enrolled = true)
        val devices = listOf(vps, mac)

        // 显式选中的设备即使临时离线也保持不跳走
        assertEquals("dev-mac", TodoLogic.resolveActiveDeviceId("dev-mac", devices, "dev-vps"))
        // 未选时优先主控在线设备
        assertEquals("dev-vps", TodoLogic.resolveActiveDeviceId(null, devices, "dev-vps"))
        // 选中不存在的设备时回落首个在线设备
        assertEquals("dev-vps", TodoLogic.resolveActiveDeviceId("dev-gone", devices, null))

        assertEquals("512 B", TodoLogic.formatAttachmentSize(512L))
        assertEquals("2.0 KB", TodoLogic.formatAttachmentSize(2048L))
        assertEquals("2.5 MB", TodoLogic.formatAttachmentSize((2.5 * 1024 * 1024).toLong()))

        assertTrue(TaskImage(id = "1", name = "a.png", mimeType = "image/png", sizeBytes = 10).isImage)
        assertFalse(TaskImage(id = "2", name = "spec.pdf", mimeType = "application/pdf", sizeBytes = 10, kind = "file").isImage)
    }
}
