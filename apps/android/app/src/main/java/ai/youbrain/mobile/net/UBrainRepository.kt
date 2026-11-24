package ai.youbrain.mobile.net

import android.content.Context
import android.webkit.CookieManager
import ai.youbrain.mobile.crypto.Base64Url
import ai.youbrain.mobile.crypto.Ed25519Identity
import ai.youbrain.mobile.data.AgentMessage
import ai.youbrain.mobile.data.AgentReadResponse
import ai.youbrain.mobile.data.AgentSendResponse
import ai.youbrain.mobile.data.AgentSessionResponse
import ai.youbrain.mobile.data.AgentSessionSummary
import ai.youbrain.mobile.data.AppStore
import ai.youbrain.mobile.data.CachedAgentSnapshot
import ai.youbrain.mobile.data.ConnectionState
import ai.youbrain.mobile.data.DeviceIdentityStore
import ai.youbrain.mobile.data.DispatchFollowupResponse
import ai.youbrain.mobile.data.DispatchListResponse
import ai.youbrain.mobile.data.DispatchProject
import ai.youbrain.mobile.data.DispatchRefreshResponse
import ai.youbrain.mobile.data.EnrollmentConfig
import ai.youbrain.mobile.data.MobilePushItem
import ai.youbrain.mobile.data.NoticeReplyResponse
import ai.youbrain.mobile.data.OutboxEntry
import ai.youbrain.mobile.data.PeerPinStore
import ai.youbrain.mobile.data.RdIceCandidate
import ai.youbrain.mobile.data.RdIceEventPayload
import ai.youbrain.mobile.data.RdIceServer
import ai.youbrain.mobile.data.RdOpenResult
import ai.youbrain.mobile.data.RdPeerEvent
import ai.youbrain.mobile.data.RdStateEventPayload
import ai.youbrain.mobile.data.RdTurnResponse
import ai.youbrain.mobile.data.RelayDevice
import ai.youbrain.mobile.data.RelayState
import ai.youbrain.mobile.data.T3StartResponse
import ai.youbrain.mobile.data.TaskBoard
import ai.youbrain.mobile.data.TaskReview
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

data class AgentUiState(
    val masterDeviceId: String? = null,
    val activeSessionId: String? = null,
    val sessions: List<AgentSessionSummary> = emptyList(),
    val defaultProject: DispatchProject? = null,
    val threadUrl: String? = null,
    val conversationState: String = "idle",
    val activity: String? = null,
    val quickInspectText: String? = null,
    val messages: List<AgentMessage> = emptyList(),
    val outbox: List<OutboxEntry> = emptyList(),
    val loading: Boolean = false,
    val sending: Boolean = false,
    val error: String? = null,
)

data class DeviceTodoState(
    val board: TaskBoard? = null,
    val loading: Boolean = false,
    val mutating: Boolean = false,
    val error: String? = null,
    val lastLoadedAt: Long = 0L,
)

enum class AppTab {
    AGENT,
    T3,
    TODOS,
    PUSHES,
    SETTINGS,
}

data class NavigationTarget(
    val tab: AppTab,
    val deviceId: String? = null,
    val threadUrl: String? = null,
    val seq: Long = 0L,
)

data class AppUiState(
    val enrolled: Boolean = false,
    val deviceId: String = "",
    val deviceName: String = "",
    val relayUrl: String = "",
    val publicKey: String = "",
    val publicKeyFingerprint: String = "",
    val connectionState: ConnectionState = ConnectionState.OFF,
    val connectionError: String? = null,
    val relayState: RelayState = RelayState(),
    val deviceAliases: Map<String, String> = emptyMap(),
    val pushes: List<MobilePushItem> = emptyList(),
    val unreadPushCount: Int = 0,
    val backgroundKeepAlive: Boolean = true,
    val pinnedPeers: Map<String, String> = emptyMap(),
    val agent: AgentUiState = AgentUiState(),
    val selectedTodoDeviceId: String? = null,
    val todoBoards: Map<String, DeviceTodoState> = emptyMap(),
    val navTarget: NavigationTarget? = null,
) {
    fun displayName(id: String, rawName: String): String {
        if (id == deviceId && deviceName.isNotBlank()) return deviceName
        return deviceAliases[id]?.takeIf { it.isNotBlank() } ?: rawName
    }

    fun displayName(device: RelayDevice): String = displayName(device.id, device.name)

    fun hasCustomAlias(id: String): Boolean = id != deviceId && !deviceAliases[id].isNullOrBlank()
}

class UBrainRepository(context: Context) {
    private val appContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    val appStore = AppStore(appContext)
    val identityStore = DeviceIdentityStore(appContext)
    val pinStore = PeerPinStore(File(appContext.filesDir, "dispatch_peers.json"))
    val assetCache = T3AssetCache(File(appContext.cacheDir, "t3_immutable_assets_v1"), scope)

    private val _uiState = MutableStateFlow(AppUiState())
    val uiState: StateFlow<AppUiState> = _uiState.asStateFlow()

    private val _rdEvents = MutableSharedFlow<RdPeerEvent>(extraBufferCapacity = 64)
    val rdEvents: SharedFlow<RdPeerEvent> = _rdEvents.asSharedFlow()

    var onNewLivePush: ((MobilePushItem) -> Unit)? = null

    private val t3Proxies = ConcurrentHashMap<String, LocalT3ProxyServer>()
    private val prewarmedT3 = ConcurrentHashMap.newKeySet<String>()
    private val optimisticSeq = AtomicInteger(1_000_000)

    @Volatile
    private var loadedMasterKey: String? = null

    private lateinit var identity: Ed25519Identity

    private val relayClient: RelayClient = RelayClient(
        scope = scope,
        onConnection = { state, error ->
            _uiState.update { it.copy(connectionState = state, connectionError = error) }
            if (state == ConnectionState.OK) {
                scope.launch {
                    pullMissedPushes()
                    refreshAgentOnConnect()
                }
            } else if (state == ConnectionState.ERROR || state == ConnectionState.OFF) {
                loadedMasterKey = null
                prewarmedT3.clear()
                tunnelClient.closeAll()
            }
        },
        onState = { state ->
            for (dev in state.devices) {
                if (!dev.online) {
                    tunnelClient.closeDeviceSession(dev.id)
                }
            }
            val masterId = resolveMasterDeviceId(state, appStore.getSelectedMasterDeviceId())
            _uiState.update { current ->
                current.copy(
                    relayState = state,
                    agent = current.agent.copy(masterDeviceId = masterId),
                )
            }
            val masterOnline = masterId != null && state.devices.any { it.id == masterId && it.online }
            if (masterId == null || !masterOnline) {
                loadedMasterKey = null
            } else if (loadedMasterKey != masterId && !_uiState.value.agent.loading) {
                loadedMasterKey = masterId
                scope.launch {
                    loadAgentSessions(masterId)
                }
            }
            val selfId = _uiState.value.deviceId
            val onlineViewPeers = state.devices.filter {
                it.id != selfId && it.online && it.enrolled == true && it.dispatch?.viewT3 == true
            }
            prewarmedT3.retainAll(onlineViewPeers.map { it.id }.toSet())
            val warmIds = onlineViewPeers
                .sortedByDescending { it.id == masterId }
                .take(2)
                .map { it.id }
                .filter { prewarmedT3.add(it) }
            if (warmIds.isNotEmpty()) {
                scope.launch {
                    // 避让连接建立初期的 hello/pushes/agent.session，再串行预握手常用设备隧道
                    delay(600L)
                    for (devId in warmIds) {
                        if (ensureT3Tunnel(devId).isSuccess) {
                            getOrCreateT3ProxyImmediate(devId)
                        } else {
                            prewarmedT3.remove(devId)
                        }
                    }
                }
            }
        },
        onPush = { item ->
            mergePushItem(item, notify = true)
        },
        onEvent = { event ->
            handleDispatchEvent(event)
        },
        onTun = { from, sid, data ->
            tunnelClient.onFrame(from, sid, data)
        },
    )

    private val tunnelClient: TunnelClient = TunnelClient(
        scope = scope,
        selfDeviceId = { _uiState.value.deviceId },
        peerKey = { id -> _uiState.value.relayState.devices.firstOrNull { it.id == id }?.publicKey },
        pins = pinStore,
        dispatchOpen = { to, sid, epk, caps ->
            relayClient.dispatchCommand(
                to = to,
                kind = "t3.tunnel.open",
                args = buildJsonObject {
                    put("sid", sid)
                    put("epk", epk)
                    if (caps.isNotEmpty()) {
                        put("caps", JsonArray(caps.map { JsonPrimitive(it) }))
                    }
                },
                timeoutMs = 10_000L,
            )
        },
        sendTun = { to, sid, data, onDeliveryFailure ->
            relayClient.sendTun(to, sid, data, onDeliveryFailure)
        },
    )

    init {
        assetCache.loadSeedZipAsync {
            runCatching { appContext.assets.open("t3_boot_seed.zip") }.getOrNull()
        }
        val deviceId = identityStore.getOrCreateDeviceId()
        identity = identityStore.getOrCreateIdentity()
        val cachedPushes = appStore.loadCachedPushes()
        val savedEnrollment = identityStore.getEnrollment()
        val initialMasterId = appStore.getSelectedMasterDeviceId()
        val initialTodoDeviceId = appStore.getSelectedTodoDeviceId()
        val cachedTodoBoards = appStore.loadCachedTodoBoards().mapValues { (_, board) ->
            DeviceTodoState(board = board)
        }
        _uiState.value = AppUiState(
            enrolled = savedEnrollment != null,
            deviceId = savedEnrollment?.first?.deviceId ?: deviceId,
            deviceName = savedEnrollment?.first?.deviceName ?: identityStore.defaultDeviceName(),
            relayUrl = savedEnrollment?.first?.relayUrl ?: "",
            publicKey = identity.publicKey,
            publicKeyFingerprint = identity.shortFingerprint(),
            deviceAliases = appStore.getDeviceAliases(),
            pushes = cachedPushes,
            backgroundKeepAlive = appStore.isBackgroundKeepAliveEnabled(),
            pinnedPeers = pinStore.listPins(),
            agent = hydratedAgentState(initialMasterId),
            selectedTodoDeviceId = initialTodoDeviceId,
            todoBoards = cachedTodoBoards,
        )
        if (savedEnrollment != null) {
            startConnection(savedEnrollment.first, savedEnrollment.second)
        }
    }

    private fun hydratedAgentState(masterId: String?): AgentUiState {
        val snap = appStore.loadAgentSnapshot(masterId)
        return if (snap != null && masterId != null) {
            AgentUiState(
                masterDeviceId = masterId,
                activeSessionId = snap.activeSessionId,
                threadUrl = snap.threadUrl,
                sessions = snap.sessions,
                messages = snap.messages,
                outbox = snap.outbox,
            )
        } else {
            AgentUiState(masterDeviceId = masterId)
        }
    }

    private fun persistAgentSnapshot(agent: AgentUiState) {
        val masterId = agent.masterDeviceId ?: return
        appStore.saveAgentSnapshot(
            CachedAgentSnapshot(
                masterDeviceId = masterId,
                activeSessionId = agent.activeSessionId,
                threadUrl = agent.threadUrl,
                sessions = agent.sessions,
                messages = agent.messages,
                outbox = agent.outbox,
            ),
        )
    }

    private fun startConnection(config: EnrollmentConfig, token: String) {
        relayClient.start(
            relayUrl = config.relayUrl,
            token = token,
            deviceId = config.deviceId,
            deviceName = config.deviceName,
            identity = identity,
        )
    }

    fun reconnectNow() {
        loadedMasterKey = null
        prewarmedT3.clear()
        tunnelClient.closeAll()
        relayClient.reconnectNow()
    }

    fun reconnectIfDisconnected() {
        relayClient.reconnectIfDisconnected()
    }

    fun onAppForegrounded() {
        if (!_uiState.value.enrolled) return
        relayClient.reconnectIfDisconnected()
        if (_uiState.value.connectionState == ConnectionState.OK) {
            scope.launch {
                pullMissedPushes()
            }
        }
    }

    fun resolveDisplayName(id: String, rawName: String): String =
        _uiState.value.displayName(id, rawName)

    fun renameDevice(targetDeviceId: String, newName: String) {
        if (targetDeviceId == _uiState.value.deviceId) {
            val clean = newName
                .replace(Regex("[\\u0000-\\u001f]"), "")
                .trim()
                .ifEmpty { identityStore.defaultDeviceName() }
                .take(40)
            val updated = identityStore.updateEnrolledDeviceName(clean)
            _uiState.update { it.copy(deviceName = clean) }
            if (updated != null) {
                startConnection(updated.first, updated.second)
            }
        } else {
            val next = appStore.setDeviceAlias(targetDeviceId, newName)
            _uiState.update { it.copy(deviceAliases = next) }
        }
    }

    suspend fun enroll(relayUrl: String, code: String, name: String) {
        val cleanUrl = RelayClient.normalizeRelayUrl(relayUrl)
        val deviceId = identityStore.getOrCreateDeviceId()
        identity = identityStore.getOrCreateIdentity()
        val deviceName = name.trim().ifEmpty { identityStore.defaultDeviceName() }.take(40)
        val token = RelayClient.enroll(
            relayUrl = cleanUrl,
            code = code.trim(),
            deviceId = deviceId,
            name = deviceName,
            publicKey = identity.publicKey,
        )
        val config = EnrollmentConfig(relayUrl = cleanUrl, deviceId = deviceId, deviceName = deviceName)
        identityStore.saveEnrollment(config, token)
        _uiState.update {
            it.copy(
                enrolled = true,
                deviceId = deviceId,
                deviceName = deviceName,
                relayUrl = cleanUrl,
                publicKey = identity.publicKey,
                publicKeyFingerprint = identity.shortFingerprint(),
            )
        }
        startConnection(config, token)
    }

    fun unenroll() {
        relayClient.stop()
        tunnelClient.closeAll()
        for (proxy in t3Proxies.values) proxy.stop()
        t3Proxies.clear()
        prewarmedT3.clear()
        loadedMasterKey = null
        identityStore.clearEnrollment()
        appStore.clearPushesAndSeq()
        _uiState.update {
            it.copy(
                enrolled = false,
                relayUrl = "",
                connectionState = ConnectionState.OFF,
                connectionError = null,
                relayState = RelayState(),
                pushes = emptyList(),
                unreadPushCount = 0,
                agent = AgentUiState(),
                selectedTodoDeviceId = null,
                todoBoards = emptyMap(),
            )
        }
    }

    fun setBackgroundKeepAlive(enabled: Boolean) {
        appStore.setBackgroundKeepAliveEnabled(enabled)
        _uiState.update { it.copy(backgroundKeepAlive = enabled) }
    }

    fun forgetPeerPin(deviceId: String) {
        pinStore.forget(deviceId)
        _uiState.update { it.copy(pinnedPeers = pinStore.listPins()) }
    }

    fun clearAllPins() {
        pinStore.clearAll()
        _uiState.update { it.copy(pinnedPeers = emptyMap()) }
    }

    fun navigateTo(tab: AppTab, deviceId: String? = null, threadUrl: String? = null) {
        _uiState.update {
            it.copy(
                unreadPushCount = if (tab == AppTab.PUSHES) 0 else it.unreadPushCount,
                navTarget = NavigationTarget(
                    tab = tab,
                    deviceId = deviceId,
                    threadUrl = threadUrl,
                    seq = System.nanoTime(),
                ),
            )
        }
    }

    fun markPushesRead() {
        _uiState.update { it.copy(unreadPushCount = 0) }
    }

    private fun resolveMasterDeviceId(state: RelayState, preferredId: String?): String? {
        val selfId = _uiState.value.deviceId
        val candidates = state.devices.filter { it.id != selfId && it.enrolled == true }
        if (preferredId != null && candidates.any { it.id == preferredId }) return preferredId
        val routerId = state.routerDeviceId
        if (!routerId.isNullOrBlank() && candidates.any { it.id == routerId }) return routerId
        val server = candidates.firstOrNull { it.online && it.dispatch?.role == "server" }
            ?: candidates.firstOrNull { it.dispatch?.role == "server" }
        if (server != null) return server.id
        return candidates.firstOrNull { it.online && it.dispatch?.enabled == true }?.id
    }

    fun selectMasterDevice(deviceId: String) {
        appStore.setSelectedMasterDeviceId(deviceId)
        loadedMasterKey = deviceId
        _uiState.update {
            it.copy(
                agent = hydratedAgentState(deviceId),
            )
        }
        scope.launch {
            loadAgentSessions(deviceId)
        }
    }

    fun dismissQuickInspect() {
        _uiState.update { it.copy(agent = it.agent.copy(quickInspectText = null)) }
    }

    fun runQuickDeviceInspect() {
        val state = _uiState.value
        val devices = state.relayState.devices.filter { it.id != state.deviceId && it.enrolled == true }
        val text = buildString {
            appendLine("⚡ 实时设备与项目快查（直读中转状态，零等待）")
            if (devices.isEmpty()) {
                append("暂未发现其他已入网设备。")
            } else {
                devices.forEach { d ->
                    val status = if (d.online) "● 在线" else "○ 离线"
                    val roleTag = if (d.dispatch?.role == "server") " · VPS 主控" else ""
                    val caps = buildList {
                        if (d.dispatch?.enabled == true) add("可派活(${d.dispatch.maxMode})")
                        if (d.dispatch?.viewT3 == true) add("可看 T3")
                    }.joinToString(" · ")
                    appendLine("- ${state.displayName(d)} [$status$roleTag]${if (caps.isNotEmpty()) "：$caps" else ""}")
                    val projs = d.dispatch?.projects.orEmpty()
                    if (projs.isNotEmpty()) {
                        appendLine("  可派项目：${projs.joinToString("、") { it.name }}")
                    }
                }
            }
        }.trim()
        _uiState.update { it.copy(agent = it.agent.copy(quickInspectText = text)) }
    }

    suspend fun runQuickOutboxInspect() {
        refreshOutboxList()
        val state = _uiState.value
        val outbox = state.agent.outbox
        val text = buildString {
            appendLine("📋 最近派活任务速览（${outbox.size} 项）")
            if (outbox.isEmpty()) {
                append("当前主控尚未派出任何跨设备任务。")
            } else {
                outbox.take(8).forEach { e ->
                    val st = when (e.status) {
                        "running", "sending" -> "执行中"
                        "waiting" -> "待处理"
                        "done" -> "已完成"
                        else -> "失败"
                    }
                    appendLine("- [${st}] ${state.displayName(e.to, e.deviceName)} · ${e.title}")
                    e.lastSummary?.takeIf { it.isNotBlank() }?.let {
                        appendLine("  ${it.replace("\n", " ").take(90)}")
                    }
                }
            }
        }.trim()
        _uiState.update { it.copy(agent = it.agent.copy(quickInspectText = text)) }
    }

    private suspend fun refreshAgentOnConnect() {
        val masterId = _uiState.value.agent.masterDeviceId
            ?: resolveMasterDeviceId(_uiState.value.relayState, appStore.getSelectedMasterDeviceId())
        if (masterId != null) {
            loadAgentSessions(masterId)
        }
    }

    suspend fun loadAgentSessions(
        masterId: String? = _uiState.value.agent.masterDeviceId,
        sessionId: String? = null,
        create: Boolean = false,
    ) {
        val target = masterId ?: return
        _uiState.update { it.copy(agent = it.agent.copy(loading = true, error = null)) }
        val args = buildJsonObject {
            if (sessionId != null) put("sessionId", sessionId)
            if (create) put("create", true)
        }
        when (val outcome = relayClient.dispatchCommand(target, "agent.session", args, timeoutMs = 20_000L)) {
            is CommandOutcome.Err -> {
                _uiState.update {
                    it.copy(agent = it.agent.copy(loading = false, error = outcome.error))
                }
            }
            is CommandOutcome.Ok -> {
                val el = outcome.result
                if (el == null) {
                    _uiState.update { it.copy(agent = it.agent.copy(loading = false)) }
                    return
                }
                val resp = runCatching { json.decodeFromJsonElement(AgentSessionResponse.serializer(), el) }.getOrNull()
                if (resp == null) {
                    _uiState.update { it.copy(agent = it.agent.copy(loading = false, error = "主控返回格式不兼容")) }
                    return
                }
                val bundled = resp.conversation
                var latestAgent: AgentUiState? = null
                _uiState.update { cur ->
                    val nextAgent = if (bundled != null) {
                        mergeConversationResponse(
                            cur = cur.agent.copy(
                                masterDeviceId = target,
                                activeSessionId = resp.activeSessionId,
                                sessions = resp.sessions,
                                defaultProject = resp.defaultProject,
                                loading = false,
                                error = null,
                            ),
                            resp = bundled,
                            incremental = false,
                        )
                    } else {
                        cur.agent.copy(
                            masterDeviceId = target,
                            activeSessionId = resp.activeSessionId,
                            sessions = resp.sessions,
                            defaultProject = resp.defaultProject,
                            loading = false,
                            error = null,
                        )
                    }
                    latestAgent = nextAgent
                    cur.copy(agent = nextAgent)
                }
                latestAgent?.let { persistAgentSnapshot(it) }
                if (bundled == null) {
                    readAgentConversation(target, resp.activeSessionId)
                }
            }
        }
    }

    private fun mergeConversationResponse(
        cur: AgentUiState,
        resp: AgentReadResponse,
        incremental: Boolean,
    ): AgentUiState {
        val sortedConfirmed = if (incremental) {
            val confirmed = cur.messages.filter { it.position < 1_000_000 }
            val byPos = LinkedHashMap<Int, AgentMessage>()
            for (m in confirmed) byPos[m.position] = m
            for (m in resp.messages) byPos[m.position] = m
            byPos.values.sortedBy { it.position }
        } else {
            resp.messages
        }
        val pendingOptimistic = if (resp.state == "running") {
            val confirmedUserTexts = sortedConfirmed
                .filter { it.role == "user" }
                .map { it.text }
                .toSet()
            cur.messages.filter {
                it.position >= 1_000_000 && !confirmedUserTexts.contains(it.text)
            }
        } else {
            emptyList()
        }
        val mergedMessages = sortedConfirmed + pendingOptimistic
        return cur.copy(
            activeSessionId = resp.sessionId ?: cur.activeSessionId,
            threadUrl = resp.threadUrl ?: cur.threadUrl,
            conversationState = resp.state,
            activity = resp.activity,
            messages = mergedMessages,
            outbox = resp.outbox,
            error = null,
        )
    }

    suspend fun readAgentConversation(
        masterId: String? = _uiState.value.agent.masterDeviceId,
        sessionId: String? = _uiState.value.agent.activeSessionId,
        incremental: Boolean = false,
    ) {
        val target = masterId ?: return
        val maxServerPos = if (incremental) {
            _uiState.value.agent.messages
                .filter { it.position < 1_000_000 }
                .maxOfOrNull { it.position }
        } else {
            null
        }
        val afterPos = if (maxServerPos != null && maxServerPos > 1) maxServerPos - 1 else null
        val args = buildJsonObject {
            if (sessionId != null) put("sessionId", sessionId)
            if (afterPos != null) put("afterPosition", afterPos)
            put("limit", 80)
        }
        when (val outcome = relayClient.dispatchCommand(target, "agent.read", args, timeoutMs = 25_000L)) {
            is CommandOutcome.Err -> {
                _uiState.update { it.copy(agent = it.agent.copy(error = outcome.error)) }
            }
            is CommandOutcome.Ok -> {
                val el = outcome.result ?: return
                val resp = runCatching { json.decodeFromJsonElement(AgentReadResponse.serializer(), el) }.getOrNull()
                    ?: return
                var updatedAgent: AgentUiState? = null
                _uiState.update { cur ->
                    val next = mergeConversationResponse(cur.agent, resp, incremental = afterPos != null)
                    updatedAgent = next
                    cur.copy(agent = next)
                }
                updatedAgent?.let { persistAgentSnapshot(it) }
            }
        }
    }

    suspend fun sendAgentMessage(text: String): Result<AgentSendResponse> {
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return Result.failure(IllegalArgumentException("消息不能为空"))
        val target = _uiState.value.agent.masterDeviceId
            ?: return Result.failure(IllegalStateException("没有找到在线的 VPS 主控设备"))

        val optimisticPos = optimisticSeq.getAndIncrement()
        _uiState.update {
            it.copy(
                agent = it.agent.copy(
                    sending = true,
                    error = null,
                    conversationState = "running",
                    messages = it.agent.messages + AgentMessage(
                        position = optimisticPos,
                        role = "user",
                        text = trimmed,
                    ),
                ),
            )
        }
        val args = buildJsonObject {
            put("text", trimmed)
            _uiState.value.agent.activeSessionId?.let { put("sessionId", it) }
            put("requestId", UUID.randomUUID().toString())
        }
        val outcome = relayClient.dispatchCommand(target, "agent.send", args, timeoutMs = 45_000L)
        return when (outcome) {
            is CommandOutcome.Err -> {
                _uiState.update {
                    it.copy(agent = it.agent.copy(sending = false, error = outcome.error))
                }
                Result.failure(IllegalStateException(outcome.error))
            }
            is CommandOutcome.Ok -> {
                val resp = outcome.result?.let {
                    runCatching { json.decodeFromJsonElement(AgentSendResponse.serializer(), it) }.getOrNull()
                }
                _uiState.update {
                    it.copy(
                        agent = it.agent.copy(
                            sending = false,
                            activeSessionId = resp?.sessionId ?: it.agent.activeSessionId,
                            threadUrl = resp?.threadUrl?.ifBlank { it.agent.threadUrl } ?: it.agent.threadUrl,
                            conversationState = "running",
                            activity = "已送达主控，正在思考与调度…",
                        ),
                    )
                }
                readAgentConversation(
                    target,
                    resp?.sessionId ?: _uiState.value.agent.activeSessionId,
                    incremental = true,
                )
                if (resp != null) Result.success(resp)
                else Result.failure(IllegalStateException("返回格式无效"))
            }
        }
    }

    suspend fun syncAgentNow(): Result<Unit> {
        if (!_uiState.value.enrolled) {
            return Result.failure(IllegalStateException("设备尚未入网"))
        }
        if (!relayClient.awaitConnected(8_000L)) {
            return Result.failure(IllegalStateException("连不上中转，请检查手机网络"))
        }
        runCatching { pullMissedPushes() }
        val masterId = _uiState.value.agent.masterDeviceId
            ?: resolveMasterDeviceId(_uiState.value.relayState, appStore.getSelectedMasterDeviceId())
            ?: return Result.failure(IllegalStateException("暂未发现在线的主控设备"))
        loadAgentSessions(masterId, _uiState.value.agent.activeSessionId)
        val err = _uiState.value.agent.error
        return if (err != null) Result.failure(IllegalStateException(err)) else Result.success(Unit)
    }

    suspend fun refreshOutboxListResult(): Result<Int> {
        if (!relayClient.awaitConnected(6_000L)) {
            return Result.failure(IllegalStateException("中转未连接"))
        }
        val target = _uiState.value.agent.masterDeviceId
            ?: resolveMasterDeviceId(_uiState.value.relayState, appStore.getSelectedMasterDeviceId())
            ?: return Result.failure(IllegalStateException("未选择主控设备"))
        return when (val outcome = relayClient.dispatchCommand(target, "dispatch.list", buildJsonObject { }, timeoutMs = 15_000L)) {
            is CommandOutcome.Err -> Result.failure(IllegalStateException(outcome.error))
            is CommandOutcome.Ok -> {
                val parsed = outcome.result?.let {
                    runCatching { json.decodeFromJsonElement(DispatchListResponse.serializer(), it) }.getOrNull()
                } ?: return Result.failure(IllegalStateException("看板返回格式无效"))
                _uiState.update { it.copy(agent = it.agent.copy(outbox = parsed.entries)) }
                Result.success(parsed.entries.size)
            }
        }
    }

    suspend fun refreshOutboxList() {
        refreshOutboxListResult()
    }

    suspend fun refreshPushesNow(): Result<Int> {
        if (!_uiState.value.enrolled) {
            return Result.failure(IllegalStateException("设备尚未入网"))
        }
        if (!relayClient.awaitConnected(8_000L)) {
            return Result.failure(IllegalStateException("连不上中转，请检查网络"))
        }
        val pulledCount = pullMissedPushes()
        return Result.success(pulledCount)
    }

    suspend fun followupDispatch(dispatchId: String, prompt: String): Result<DispatchFollowupResponse> {
        val target = _uiState.value.agent.masterDeviceId
            ?: return Result.failure(IllegalStateException("未选择主控设备"))
        val args = buildJsonObject {
            put("dispatchId", dispatchId)
            put("prompt", prompt)
        }
        return when (val outcome = relayClient.dispatchCommand(target, "dispatch.followup", args, timeoutMs = 45_000L)) {
            is CommandOutcome.Err -> Result.failure(IllegalStateException(outcome.error))
            is CommandOutcome.Ok -> {
                val parsed = outcome.result?.let {
                    runCatching { json.decodeFromJsonElement(DispatchFollowupResponse.serializer(), it) }.getOrNull()
                }
                if (parsed == null) Result.failure(IllegalStateException("追问结果无效"))
                else if (!parsed.ok) Result.failure(IllegalStateException(parsed.error ?: "追问失败"))
                else {
                    refreshOutboxList()
                    Result.success(parsed)
                }
            }
        }
    }

    suspend fun refreshDispatch(dispatchId: String): Result<DispatchRefreshResponse> {
        val target = _uiState.value.agent.masterDeviceId
            ?: return Result.failure(IllegalStateException("未选择主控设备"))
        val outcome = relayClient.dispatchCommand(
            target,
            "dispatch.refresh",
            buildJsonObject { put("dispatchId", dispatchId) },
            timeoutMs = 45_000L,
        )
        return when (outcome) {
            is CommandOutcome.Err -> Result.failure(IllegalStateException(outcome.error))
            is CommandOutcome.Ok -> {
                val parsed = outcome.result?.let {
                    runCatching { json.decodeFromJsonElement(DispatchRefreshResponse.serializer(), it) }.getOrNull()
                }
                if (parsed == null) Result.failure(IllegalStateException("刷新结果无效"))
                else {
                    if (parsed.entry != null) {
                        _uiState.update { state ->
                            val updated = listOf(parsed.entry) + state.agent.outbox.filter { it.dispatchId != dispatchId }
                            state.copy(agent = state.agent.copy(outbox = updated))
                        }
                    }
                    Result.success(parsed)
                }
            }
        }
    }

    suspend fun startDirectT3Task(
        toDeviceId: String,
        projectId: String,
        title: String,
        prompt: String,
        mode: String = "auto",
    ): Result<T3StartResponse> {
        val dispatchId = "d-${UUID.randomUUID().toString().replace("-", "").take(16)}"
        val args = buildJsonObject {
            put("projectId", projectId)
            put("title", title.trim().ifEmpty { prompt.trim().take(32) })
            put("prompt", prompt)
            put("mode", mode)
            put("dispatchId", dispatchId)
        }
        return when (val outcome = relayClient.dispatchCommand(toDeviceId, "t3.start", args, timeoutMs = 45_000L)) {
            is CommandOutcome.Err -> Result.failure(IllegalStateException(outcome.error))
            is CommandOutcome.Ok -> {
                val parsed = outcome.result?.let {
                    runCatching { json.decodeFromJsonElement(T3StartResponse.serializer(), it) }.getOrNull()
                }
                if (parsed == null) Result.failure(IllegalStateException("派活返回格式无效"))
                else Result.success(parsed)
            }
        }
    }

    suspend fun replyToPush(item: MobilePushItem, text: String): Result<NoticeReplyResponse> {
        val token = item.replyToken?.takeIf { it.isNotBlank() }
            ?: return Result.failure(IllegalStateException("该消息不支持快捷回复"))
        val outcome = relayClient.dispatchCommand(
            to = item.deviceId,
            kind = "notice.reply",
            args = buildJsonObject {
                put("replyToken", token)
                put("text", text.trim())
            },
            timeoutMs = 25_000L,
        )
        return when (outcome) {
            is CommandOutcome.Err -> Result.failure(IllegalStateException(outcome.error))
            is CommandOutcome.Ok -> {
                val parsed = outcome.result?.let {
                    runCatching { json.decodeFromJsonElement(NoticeReplyResponse.serializer(), it) }.getOrNull()
                } ?: NoticeReplyResponse(ok = true, targetName = item.title)
                Result.success(parsed)
            }
        }
    }

    fun getOrCreateT3ProxyImmediate(deviceId: String): String =
        getOrCreateT3ProxyServer(deviceId).baseUrl

    suspend fun ensureT3Tunnel(deviceId: String): Result<Unit> {
        return try {
            tunnelClient.session(deviceId)
            _uiState.update { it.copy(pinnedPeers = pinStore.listPins()) }
            Result.success(Unit)
        } catch (t: Throwable) {
            Result.failure(t)
        }
    }

    suspend fun getOrStartT3ProxyUrl(deviceId: String): Result<String> {
        return ensureT3Tunnel(deviceId).map { getOrCreateT3ProxyImmediate(deviceId) }
    }

    suspend fun forceRefreshDeviceT3(deviceId: String): Result<String> {
        if (!_uiState.value.enrolled) {
            return Result.failure(IllegalStateException("设备尚未入网"))
        }
        if (!relayClient.awaitConnected(8_000L)) {
            return Result.failure(IllegalStateException("连不上中转，请检查手机网络"))
        }
        prewarmedT3.remove(deviceId)
        tunnelClient.forceResetSession(deviceId)
        val proxy = getOrCreateT3ProxyServer(deviceId)
        proxy.prepareForceRefresh()
        return ensureT3Tunnel(deviceId).map { proxy.baseUrl }
    }

    private fun getOrCreateT3ProxyServer(deviceId: String): LocalT3ProxyServer {
        t3Proxies[deviceId]?.let { return it }

        val digest = java.security.MessageDigest.getInstance("SHA-256")
            .digest(deviceId.toByteArray(Charsets.UTF_8))
        val u16 = ((digest[0].toInt() and 0xff) shl 8) or (digest[1].toInt() and 0xff)
        val stablePort = 20_000 + (u16 % 20_000)
        val hexPrefix = digest.take(4).joinToString("") { "%02x".format(it) }
        val cookiePrefix = "ubd${hexPrefix}_"

        val proxy = LocalT3ProxyServer(
            scope = scope,
            upstream = object : T3Upstream {
                override suspend fun fetch(
                    path: String,
                    method: String,
                    headers: List<Pair<String, String>>,
                    body: ByteArray?,
                ): TunnelHttpResponse {
                    val s1 = tunnelClient.session(deviceId)
                    return try {
                        s1.fetch(path, method, headers, body)
                    } catch (t: Throwable) {
                        val canRetry = s1.closed && (
                            method.equals("GET", ignoreCase = true) ||
                                method.equals("HEAD", ignoreCase = true) ||
                                path == "/api/auth/browser-session"
                            )
                        if (canRetry) {
                            tunnelClient.session(deviceId).fetch(path, method, headers, body)
                        } else {
                            throw t
                        }
                    }
                }

                override suspend fun openSocket(
                    path: String,
                    headers: List<Pair<String, String>>,
                    listener: UpstreamWsListener,
                ): UpstreamWs {
                    val s1 = tunnelClient.session(deviceId)
                    return try {
                        s1.openSocket(path, headers, listener)
                    } catch (t: Throwable) {
                        if (s1.closed) {
                            tunnelClient.session(deviceId).openSocket(path, headers, listener)
                        } else {
                            throw t
                        }
                    }
                }

                override suspend fun pairCredential(): String? {
                    val s1 = tunnelClient.session(deviceId)
                    val first = s1.pairCredential()
                    if (first != null) return first
                    return if (s1.closed) {
                        runCatching { tunnelClient.session(deviceId).pairCredential() }.getOrNull()
                    } else {
                        null
                    }
                }
            },
            cookiePrefix = cookiePrefix,
            preferredPort = stablePort,
            onSetCookies = { proxyOrigin, cookies ->
                runCatching {
                    val cm = CookieManager.getInstance()
                    cm.setAcceptCookie(true)
                    for (c in cookies) cm.setCookie(proxyOrigin, c)
                    cm.flush()
                }
            },
            assetCache = assetCache,
            cookieReader = { proxyOrigin ->
                runCatching { CookieManager.getInstance().getCookie(proxyOrigin) }.getOrNull()
            },
        )
        val raced = t3Proxies.putIfAbsent(deviceId, proxy)
        return if (raced != null) {
            proxy.stop()
            raced
        } else {
            proxy
        }
    }

    private suspend fun pullMissedPushes(): Int {
        val since = appStore.getLastPushSeq()
        val pulled = runCatching { relayClient.pullPushes(sinceSeq = since, limit = 100) }.getOrNull() ?: return 0
        for (item in pulled.items.sortedBy { it.seq }) {
            mergePushItem(item, notify = false)
        }
        if (pulled.latestSeq > since) {
            appStore.setLastPushSeq(pulled.latestSeq)
        }
        return pulled.items.size
    }

    private fun mergePushItem(item: MobilePushItem, notify: Boolean) {
        val isNew = item.seq > appStore.getLastPushSeq()
        appStore.setLastPushSeq(item.seq)
        _uiState.update { state ->
            if (state.pushes.any { it.seq == item.seq }) return@update state
            val next = (listOf(item) + state.pushes).sortedByDescending { it.seq }.take(300)
            appStore.saveCachedPushes(next)
            state.copy(
                pushes = next,
                unreadPushCount = if (notify) state.unreadPushCount + 1 else state.unreadPushCount,
            )
        }
        if (notify && isNew) {
            onNewLivePush?.invoke(item)
        }
    }

    private fun handleDispatchEvent(event: DispatchEventMsg) {
        if (event.kind == "rd.ice") {
            val payload = runCatching {
                json.decodeFromJsonElement(RdIceEventPayload.serializer(), event.data)
            }.getOrNull()
            if (payload != null && payload.candidates.isNotEmpty()) {
                _rdEvents.tryEmit(
                    RdPeerEvent.Ice(
                        from = event.from,
                        sessionId = payload.sessionId,
                        candidates = payload.candidates,
                    ),
                )
            }
            return
        }
        if (event.kind == "rd.state") {
            val payload = runCatching {
                json.decodeFromJsonElement(RdStateEventPayload.serializer(), event.data)
            }.getOrNull()
            if (payload != null) {
                _rdEvents.tryEmit(
                    RdPeerEvent.State(
                        from = event.from,
                        sessionId = payload.sessionId,
                        state = payload.state,
                        displays = payload.displays,
                        activeDisplayId = payload.activeDisplayId,
                        permissions = payload.permissions,
                        error = payload.error,
                    ),
                )
            }
            return
        }

        val masterId = _uiState.value.agent.masterDeviceId
        if (event.from != masterId) return
        val dataObj = event.data as? JsonObject ?: return
        when (event.kind) {
            "agent.status" -> {
                val sid = dataObj["sessionId"]?.jsonPrimitive?.contentOrNull
                val status = dataObj["status"]?.jsonPrimitive?.contentOrNull
                if (sid != null && sid == _uiState.value.agent.activeSessionId) {
                    if (status != null) {
                        val mapped = when (status) {
                            "completed", "ready", "done" -> "ready"
                            "waiting" -> "waiting"
                            "failed" -> "failed"
                            else -> "running"
                        }
                        _uiState.update {
                            it.copy(
                                agent = it.agent.copy(
                                    conversationState = mapped,
                                    activity = if (mapped == "ready" || mapped == "failed") null else it.agent.activity,
                                ),
                            )
                        }
                    }
                    scope.launch { readAgentConversation(masterId, sid, incremental = true) }
                }
            }
            "outbox.updated" -> {
                val updated = runCatching {
                    val existing = _uiState.value.agent.outbox.firstOrNull {
                        it.dispatchId == dataObj["dispatchId"]?.jsonPrimitive?.contentOrNull
                    }
                    OutboxEntry(
                        dispatchId = dataObj["dispatchId"]?.jsonPrimitive?.contentOrNull ?: return@runCatching null,
                        to = existing?.to ?: "",
                        deviceName = dataObj["deviceName"]?.jsonPrimitive?.contentOrNull ?: existing?.deviceName.orEmpty(),
                        projectId = existing?.projectId ?: "",
                        title = dataObj["title"]?.jsonPrimitive?.contentOrNull ?: existing?.title.orEmpty(),
                        mode = existing?.mode ?: "auto",
                        cmdId = existing?.cmdId ?: "",
                        threadId = existing?.threadId,
                        threadUrl = dataObj["threadUrl"]?.jsonPrimitive?.contentOrNull ?: existing?.threadUrl,
                        status = dataObj["status"]?.jsonPrimitive?.contentOrNull ?: existing?.status ?: "running",
                        error = dataObj["error"]?.jsonPrimitive?.contentOrNull,
                        createdAt = existing?.createdAt ?: 0L,
                        updatedAt = dataObj["updatedAt"]?.jsonPrimitive?.contentOrNull?.toLongOrNull()
                            ?: System.currentTimeMillis(),
                        lastSummary = dataObj["lastSummary"]?.jsonPrimitive?.contentOrNull ?: existing?.lastSummary,
                    )
                }.getOrNull()
                if (updated != null) {
                    _uiState.update { state ->
                        val next = (listOf(updated) + state.agent.outbox.filter { it.dispatchId != updated.dispatchId })
                            .sortedByDescending { it.updatedAt }
                        state.copy(agent = state.agent.copy(outbox = next))
                    }
                } else {
                    scope.launch { refreshOutboxList() }
                }
            }
        }
    }

    fun viewT3Devices(): List<RelayDevice> =
        _uiState.value.relayState.devices.filter {
            it.id != _uiState.value.deviceId &&
                it.enrolled == true &&
                (it.dispatch?.viewT3 == true || it.dispatch?.remoteDesktop == true)
        }

    suspend fun fetchTurnIceServers(): List<RdIceServer> {
        val fallback = listOf(
            RdIceServer(
                urls = listOf(
                    "stun:stun.cloudflare.com:3478",
                    "stun:stun.miwifi.com:3478",
                    "stun:stun.qq.com:3478",
                    "stun:stun.l.google.com:19302",
                ),
            ),
        )
        val el = runCatching { relayClient.request("turn", timeoutMs = 6_000L) }.getOrNull() ?: return fallback
        val parsed = runCatching { json.decodeFromJsonElement(RdTurnResponse.serializer(), el) }.getOrNull()
        return parsed?.iceServers?.takeIf { it.isNotEmpty() } ?: fallback
    }

    suspend fun openRemoteDesktop(
        toDeviceId: String,
        offerSdp: String,
        quality: String = "hd",
        displayId: Int? = null,
        sessionId: String = "rd-" + UUID.randomUUID().toString().replace("-", "").take(20),
    ): Result<RdOpenResult> {
        if (!_uiState.value.enrolled) {
            return Result.failure(IllegalStateException("设备尚未入网"))
        }
        if (!relayClient.awaitConnected(8_000L)) {
            return Result.failure(IllegalStateException("连不上中转，请检查手机网络"))
        }
        val args = buildJsonObject {
            put("sessionId", sessionId)
            put("offerSdp", offerSdp)
            put("quality", quality)
            if (displayId != null && displayId >= 0) {
                put("displayId", displayId)
            }
        }
        return when (val outcome = relayClient.dispatchCommand(toDeviceId, "rd.open", args, timeoutMs = 45_000L)) {
            is CommandOutcome.Err -> Result.failure(IllegalStateException(outcome.error))
            is CommandOutcome.Ok -> {
                val el = outcome.result ?: return Result.failure(IllegalStateException("对端未返回桌面会话信息"))
                val parsed = runCatching { json.decodeFromJsonElement(RdOpenResult.serializer(), el) }.getOrNull()
                if (parsed == null) Result.failure(IllegalStateException("桌面会话响应格式不兼容"))
                else Result.success(parsed)
            }
        }
    }

    suspend fun sendRemoteDesktopIce(
        toDeviceId: String,
        sessionId: String,
        candidates: List<RdIceCandidate>,
    ): Result<Unit> {
        val batch = candidates.take(32)
        if (batch.isEmpty()) return Result.success(Unit)
        val args = buildJsonObject {
            put("sessionId", sessionId)
            put(
                "candidates",
                JsonArray(
                    batch.map { cand ->
                        buildJsonObject {
                            put("candidate", cand.candidate)
                            cand.sdpMid?.let { put("sdpMid", it) }
                            cand.sdpMLineIndex?.let { put("sdpMLineIndex", it) }
                            cand.usernameFragment?.let { put("usernameFragment", it) }
                        }
                    },
                ),
            )
        }
        return when (val outcome = relayClient.dispatchCommand(toDeviceId, "rd.ice", args, timeoutMs = 8_000L)) {
            is CommandOutcome.Err -> Result.failure(IllegalStateException(outcome.error))
            is CommandOutcome.Ok -> Result.success(Unit)
        }
    }

    fun closeRemoteDesktopAsync(toDeviceId: String, sessionId: String) {
        if (sessionId.isBlank()) return
        scope.launch {
            runCatching {
                relayClient.dispatchCommand(
                    to = toDeviceId,
                    kind = "rd.close",
                    args = buildJsonObject { put("sessionId", sessionId) },
                    timeoutMs = 5_000L,
                )
            }
        }
    }

    fun todoDevices(): List<RelayDevice> =
        _uiState.value.relayState.devices
            .filter { it.id != _uiState.value.deviceId && it.enrolled == true }
            .sortedWith(
                compareByDescending<RelayDevice> { it.online && it.dispatch?.enabled == true }
                    .thenByDescending { it.online }
                    .thenBy { _uiState.value.displayName(it).lowercase() },
            )

    fun selectTodoDevice(deviceId: String) {
        appStore.setSelectedTodoDeviceId(deviceId)
        _uiState.update { it.copy(selectedTodoDeviceId = deviceId) }
        val dev = _uiState.value.relayState.devices.firstOrNull { it.id == deviceId }
        if (dev?.online == true && _uiState.value.connectionState == ConnectionState.OK) {
            scope.launch { loadTodoBoard(deviceId, silent = false) }
        }
    }

    private fun updateDeviceTodoState(deviceId: String, transform: (DeviceTodoState) -> DeviceTodoState) {
        _uiState.update { cur ->
            val current = cur.todoBoards[deviceId] ?: DeviceTodoState()
            cur.copy(todoBoards = cur.todoBoards + (deviceId to transform(current)))
        }
    }

    private fun friendlyTodoError(raw: String): String = when {
        raw.contains("不支持的指令") -> "该设备的 U-Brain 版本尚未支持远程管理 TODO，请升级该设备客户端后再试。"
        raw.contains("本机没有开启接收派活") -> "该设备未开启「接收派活」，请在该设备「设置 → 集成」中开启后再试。"
        else -> raw
    }

    suspend fun loadTodoBoard(deviceId: String, silent: Boolean = false): Result<TaskBoard> {
        if (!_uiState.value.enrolled) {
            return Result.failure(IllegalStateException("设备尚未入网"))
        }
        if (!relayClient.awaitConnected(6_000L)) {
            val msg = "连不上中转，请检查手机网络"
            if (!silent) updateDeviceTodoState(deviceId) { it.copy(loading = false, error = msg) }
            return Result.failure(IllegalStateException(msg))
        }
        val dev = _uiState.value.relayState.devices.firstOrNull { it.id == deviceId }
        if (dev != null && !dev.online) {
            val msg = "该设备当前离线"
            if (!silent) updateDeviceTodoState(deviceId) { it.copy(loading = false, error = msg) }
            return Result.failure(IllegalStateException(msg))
        }
        if (!silent) {
            updateDeviceTodoState(deviceId) { it.copy(loading = true, error = null) }
        }
        return when (val outcome = relayClient.dispatchCommand(deviceId, "tasks.board", buildJsonObject { }, timeoutMs = 20_000L)) {
            is CommandOutcome.Err -> {
                val msg = friendlyTodoError(outcome.error)
                updateDeviceTodoState(deviceId) { it.copy(loading = false, error = msg) }
                Result.failure(IllegalStateException(msg))
            }
            is CommandOutcome.Ok -> {
                val parsed = outcome.result?.let {
                    runCatching { json.decodeFromJsonElement(TaskBoard.serializer(), it) }.getOrNull()
                }
                if (parsed == null) {
                    val msg = "设备返回的 TODO 数据格式无效"
                    updateDeviceTodoState(deviceId) { it.copy(loading = false, error = msg) }
                    Result.failure(IllegalStateException(msg))
                } else {
                    appStore.saveCachedTodoBoard(deviceId, parsed)
                    updateDeviceTodoState(deviceId) {
                        it.copy(
                            board = parsed,
                            loading = false,
                            error = null,
                            lastLoadedAt = System.currentTimeMillis(),
                        )
                    }
                    Result.success(parsed)
                }
            }
        }
    }

    private suspend fun mutateTodoBoard(
        deviceId: String,
        kind: String,
        args: JsonObject,
        timeoutMs: Long = 35_000L,
    ): Result<TaskBoard> {
        if (!relayClient.awaitConnected(6_000L)) {
            return Result.failure(IllegalStateException("连不上中转，请检查手机网络"))
        }
        updateDeviceTodoState(deviceId) { it.copy(mutating = true) }
        return try {
            when (val outcome = relayClient.dispatchCommand(deviceId, kind, args, timeoutMs = timeoutMs)) {
                is CommandOutcome.Err -> Result.failure(IllegalStateException(friendlyTodoError(outcome.error)))
                is CommandOutcome.Ok -> {
                    val parsed = outcome.result?.let {
                        runCatching { json.decodeFromJsonElement(TaskBoard.serializer(), it) }.getOrNull()
                    }
                    if (parsed == null) {
                        Result.failure(IllegalStateException("设备返回的 TODO 数据格式无效"))
                    } else {
                        appStore.saveCachedTodoBoard(deviceId, parsed)
                        updateDeviceTodoState(deviceId) {
                            it.copy(
                                board = parsed,
                                error = null,
                                lastLoadedAt = System.currentTimeMillis(),
                            )
                        }
                        Result.success(parsed)
                    }
                }
            }
        } finally {
            updateDeviceTodoState(deviceId) { it.copy(mutating = false) }
        }
    }

    suspend fun createTodo(
        deviceId: String,
        title: String,
        description: String,
        projectId: String?,
        newProjectName: String? = null,
        newProjectCwd: String? = null,
        priority: Int = 2,
    ): Result<TaskBoard> {
        val cleanTitle = title.trim()
        if (cleanTitle.isEmpty()) return Result.failure(IllegalArgumentException("请填写任务标题"))
        val args = buildJsonObject {
            put("title", cleanTitle)
            if (description.trim().isNotEmpty()) put("description", description.trim())
            val newName = newProjectName?.trim().orEmpty()
            if (newName.isNotEmpty()) {
                put(
                    "newProject",
                    buildJsonObject {
                        put("name", newName)
                        val cleanCwd = newProjectCwd?.trim().orEmpty()
                        if (cleanCwd.isNotEmpty()) put("cwd", cleanCwd)
                    },
                )
            } else if (!projectId.isNullOrBlank()) {
                put("projectId", projectId)
            } else {
                put("projectId", JsonNull)
            }
            put("priority", priority.coerceIn(0, 3))
        }
        return mutateTodoBoard(deviceId, "tasks.create", args)
    }

    suspend fun updateTodo(
        deviceId: String,
        id: String,
        title: String,
        description: String,
        projectId: String?,
        newProjectName: String? = null,
        newProjectCwd: String? = null,
        priority: Int = 2,
    ): Result<TaskBoard> {
        val cleanTitle = title.trim()
        if (cleanTitle.isEmpty()) return Result.failure(IllegalArgumentException("请填写任务标题"))
        val args = buildJsonObject {
            put("id", id)
            put("title", cleanTitle)
            put("description", description.trim())
            val newName = newProjectName?.trim().orEmpty()
            if (newName.isNotEmpty()) {
                put(
                    "newProject",
                    buildJsonObject {
                        put("name", newName)
                        val cleanCwd = newProjectCwd?.trim().orEmpty()
                        if (cleanCwd.isNotEmpty()) put("cwd", cleanCwd)
                    },
                )
            } else if (!projectId.isNullOrBlank()) {
                put("projectId", projectId)
            } else {
                put("projectId", JsonNull)
            }
            put("priority", priority.coerceIn(0, 3))
        }
        return mutateTodoBoard(deviceId, "tasks.update", args)
    }

    suspend fun toggleTodoProject(deviceId: String, projectId: String, enabled: Boolean): Result<TaskBoard> =
        mutateTodoBoard(
            deviceId,
            "tasks.action",
            buildJsonObject {
                put("action", "project")
                put("projectId", projectId)
                put("enabled", enabled)
            },
        )

    suspend fun startTodo(deviceId: String, id: String): Result<TaskBoard> =
        mutateTodoBoard(
            deviceId,
            "tasks.action",
            buildJsonObject {
                put("action", "start")
                put("id", id)
            },
            timeoutMs = 45_000L,
        )

    suspend fun completeTodo(deviceId: String, id: String): Result<TaskBoard> =
        mutateTodoBoard(
            deviceId,
            "tasks.action",
            buildJsonObject {
                put("action", "complete")
                put("id", id)
            },
        )

    suspend fun retryTodo(deviceId: String, id: String): Result<TaskBoard> =
        mutateTodoBoard(
            deviceId,
            "tasks.action",
            buildJsonObject {
                put("action", "retry")
                put("id", id)
            },
            timeoutMs = 45_000L,
        )

    suspend fun approveTodo(deviceId: String, id: String, reviewSha: String): Result<TaskBoard> =
        mutateTodoBoard(
            deviceId,
            "tasks.action",
            buildJsonObject {
                put("action", "approve")
                put("id", id)
                put("reviewSha", reviewSha)
            },
            timeoutMs = 90_000L,
        )

    suspend fun rejectTodo(deviceId: String, id: String, feedback: String): Result<TaskBoard> {
        val clean = feedback.trim()
        if (clean.isEmpty()) return Result.failure(IllegalArgumentException("请填写需要修改的内容"))
        return mutateTodoBoard(
            deviceId,
            "tasks.action",
            buildJsonObject {
                put("action", "reject")
                put("id", id)
                put("feedback", clean)
            },
            timeoutMs = 45_000L,
        )
    }

    suspend fun reviewTodo(deviceId: String, id: String): Result<TaskReview> {
        if (!relayClient.awaitConnected(6_000L)) {
            return Result.failure(IllegalStateException("连不上中转，请检查手机网络"))
        }
        return when (
            val outcome = relayClient.dispatchCommand(
                deviceId,
                "tasks.review",
                buildJsonObject { put("id", id) },
                timeoutMs = 30_000L,
            )
        ) {
            is CommandOutcome.Err -> Result.failure(IllegalStateException(friendlyTodoError(outcome.error)))
            is CommandOutcome.Ok -> {
                val parsed = outcome.result?.let {
                    runCatching { json.decodeFromJsonElement(TaskReview.serializer(), it) }.getOrNull()
                }
                if (parsed == null) Result.failure(IllegalStateException("无法解析变更内容"))
                else Result.success(parsed)
            }
        }
    }
}

