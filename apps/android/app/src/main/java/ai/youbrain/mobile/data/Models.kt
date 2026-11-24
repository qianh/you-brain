package ai.youbrain.mobile.data

import kotlinx.serialization.Serializable

@Serializable
data class DispatchProject(
    val id: String,
    val name: String,
)

@Serializable
data class HelloT3Info(
    val ready: Boolean = false,
    val version: String? = null,
)

@Serializable
data class HelloDispatch(
    val enabled: Boolean = false,
    val t3: HelloT3Info = HelloT3Info(),
    val projects: List<DispatchProject> = emptyList(),
    val maxMode: String = "auto",
    val viewT3: Boolean? = null,
    val remoteDesktop: Boolean? = null,
    val role: String? = null,
)

@Serializable
data class RelayDevice(
    val id: String,
    val name: String,
    val online: Boolean = false,
    val enrolled: Boolean? = null,
    val publicKey: String? = null,
    val dispatch: HelloDispatch? = null,
)

@Serializable
data class RelayBoundChat(
    val name: String,
)

@Serializable
data class RelayBotInfo(
    val username: String = "",
    val name: String = "",
)

@Serializable
data class RelayState(
    val bot: RelayBotInfo? = null,
    val bound: RelayBoundChat? = null,
    val routerDeviceId: String? = null,
    val devices: List<RelayDevice> = emptyList(),
)

@Serializable
data class MobilePushItem(
    val seq: Long,
    val ts: Long,
    val deviceId: String,
    val deviceName: String,
    val kind: String,
    val status: String? = null,
    val title: String,
    val body: String,
    val link: String? = null,
    val threadId: String? = null,
    val replyToken: String? = null,
)

@Serializable
data class PushesPullResult(
    val items: List<MobilePushItem> = emptyList(),
    val latestSeq: Long = 0L,
)

@Serializable
data class AgentSessionSummary(
    val sessionId: String,
    val threadId: String? = null,
    val threadUrl: String? = null,
    val projectId: String? = null,
    val title: String = "主控会话",
    val status: String = "idle",
    val createdAt: Long = 0L,
    val updatedAt: Long = 0L,
)

@Serializable
data class AgentSessionResponse(
    val activeSessionId: String,
    val sessions: List<AgentSessionSummary> = emptyList(),
    val defaultProject: DispatchProject? = null,
    val conversation: AgentReadResponse? = null,
)

@Serializable
data class AgentSendResponse(
    val sessionId: String,
    val threadId: String,
    val threadUrl: String = "",
    val delivery: String = "started",
    val mode: String = "auto",
    val capped: Boolean = false,
)

@Serializable
data class AgentMessage(
    val position: Int,
    val role: String,
    val text: String,
    val runId: String? = null,
)

@Serializable
data class OutboxEntry(
    val dispatchId: String,
    val to: String,
    val deviceName: String,
    val projectId: String,
    val title: String,
    val mode: String,
    val cmdId: String,
    val threadId: String? = null,
    val threadUrl: String? = null,
    val status: String,
    val error: String? = null,
    val createdAt: Long = 0L,
    val updatedAt: Long = 0L,
    val lastSummary: String? = null,
)

@Serializable
data class AgentReadResponse(
    val sessionId: String? = null,
    val title: String = "主控会话",
    val threadId: String? = null,
    val threadUrl: String? = null,
    val state: String = "idle",
    val activity: String? = null,
    val messages: List<AgentMessage> = emptyList(),
    val outbox: List<OutboxEntry> = emptyList(),
)

@Serializable
data class CachedAgentSnapshot(
    val masterDeviceId: String,
    val activeSessionId: String? = null,
    val threadUrl: String? = null,
    val sessions: List<AgentSessionSummary> = emptyList(),
    val messages: List<AgentMessage> = emptyList(),
    val outbox: List<OutboxEntry> = emptyList(),
)

@Serializable
data class DispatchListResponse(
    val entries: List<OutboxEntry> = emptyList(),
)

@Serializable
data class DispatchFollowupResponse(
    val ok: Boolean,
    val dispatchId: String,
    val threadId: String? = null,
    val error: String? = null,
)

@Serializable
data class DispatchRefreshResponse(
    val ok: Boolean,
    val dispatchId: String,
    val state: String? = null,
    val summary: String? = null,
    val error: String? = null,
    val link: String? = null,
    val entry: OutboxEntry? = null,
)

@Serializable
data class T3StartResponse(
    val threadId: String,
    val threadUrl: String,
    val mode: String,
    val capped: Boolean,
)

@Serializable
data class NoticeReplyResponse(
    val ok: Boolean = true,
    val targetName: String = "",
)

enum class ConnectionState {
    OFF,
    CONNECTING,
    OK,
    ERROR,
}

@Serializable
data class EnrollmentConfig(
    val relayUrl: String,
    val deviceId: String,
    val deviceName: String,
)

@Serializable
data class TaskProject(
    val id: String,
    val name: String,
    val cwd: String = "",
    val enabled: Boolean = false,
)

@Serializable
data class TaskImage(
    val id: String,
    val name: String,
    val mimeType: String = "",
    val sizeBytes: Long = 0L,
)

@Serializable
data class TaskWorktreeBlock(
    val uncommitted: Int = 0,
    val untracked: Int = 0,
)

@Serializable
data class TaskRun(
    val projectCwd: String = "",
    val requestId: String? = null,
    val threadId: String? = null,
    val threadUrl: String? = null,
    val reviewSha: String? = null,
    val summary: String = "",
    val error: String? = null,
    val branch: String? = null,
    val worktreePath: String? = null,
    val baseSha: String? = null,
    val merged: Boolean? = null,
)

@Serializable
data class DevelopmentTask(
    val id: String,
    val title: String,
    val description: String = "",
    val images: List<TaskImage> = emptyList(),
    val projectId: String? = null,
    val priority: Int = 2,
    val status: String = "queued",
    val createdAt: String = "",
    val updatedAt: String = "",
    val run: TaskRun? = null,
    val manual: Boolean? = null,
    val completedManually: Boolean? = null,
    val error: String? = null,
    val worktreeBlock: TaskWorktreeBlock? = null,
)

@Serializable
data class TaskBoard(
    val projects: List<TaskProject> = emptyList(),
    val tasks: List<DevelopmentTask> = emptyList(),
    val connectionError: String? = null,
)

@Serializable
data class TaskReview(
    val task: DevelopmentTask,
    val headSha: String,
    val baseSha: String,
    val stat: String = "",
    val diff: String = "",
    val truncated: Boolean = false,
)

@Serializable
data class RdIceServer(
    val urls: List<String> = emptyList(),
    val username: String? = null,
    val credential: String? = null,
)

@Serializable
data class RdTurnResponse(
    val iceServers: List<RdIceServer> = emptyList(),
    val ttl: Int = 3600,
)

@Serializable
data class RdIceCandidate(
    val candidate: String,
    val sdpMid: String? = null,
    val sdpMLineIndex: Int? = null,
    val usernameFragment: String? = null,
)

@Serializable
data class RdDisplayInfo(
    val id: Int,
    val name: String,
    val width: Int,
    val height: Int,
    val scaleFactor: Double = 2.0,
    val primary: Boolean = false,
)

@Serializable
data class RdPermissions(
    val screenRecording: Boolean = true,
    val accessibility: Boolean = true,
)

@Serializable
data class RdOpenResult(
    val sessionId: String,
    val answerSdp: String,
    val displays: List<RdDisplayInfo> = emptyList(),
    val activeDisplayId: Int = 0,
    val permissions: RdPermissions = RdPermissions(),
)

@Serializable
data class RdIceEventPayload(
    val sessionId: String,
    val candidates: List<RdIceCandidate> = emptyList(),
)

@Serializable
data class RdStateEventPayload(
    val sessionId: String,
    val state: String,
    val displays: List<RdDisplayInfo>? = null,
    val activeDisplayId: Int? = null,
    val permissions: RdPermissions? = null,
    val error: String? = null,
)

sealed interface RdPeerEvent {
    val from: String
    val sessionId: String

    data class Ice(
        override val from: String,
        override val sessionId: String,
        val candidates: List<RdIceCandidate>,
    ) : RdPeerEvent

    data class State(
        override val from: String,
        override val sessionId: String,
        val state: String,
        val displays: List<RdDisplayInfo>? = null,
        val activeDisplayId: Int? = null,
        val permissions: RdPermissions? = null,
        val error: String? = null,
    ) : RdPeerEvent
}


