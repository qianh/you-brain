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
