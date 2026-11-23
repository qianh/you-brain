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
import ai.youbrain.mobile.data.RelayDevice
import ai.youbrain.mobile.data.RelayState
import ai.youbrain.mobile.data.T3StartResponse
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
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
    val messages: List<AgentMessage> = emptyList(),
    val outbox: List<OutboxEntry> = emptyList(),
    val loading: Boolean = false,
    val sending: Boolean = false,
    val error: String? = null,
)

enum class AppTab {
    AGENT,
    T3,
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
    val pushes: List<MobilePushItem> = emptyList(),
    val unreadPushCount: Int = 0,
    val backgroundKeepAlive: Boolean = true,
    val pinnedPeers: Map<String, String> = emptyMap(),
    val agent: AgentUiState = AgentUiState(),
    val navTarget: NavigationTarget? = null,
)

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
            }
        },
        onState = { state ->
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
            val warmCandidates = onlineViewPeers
                .sortedByDescending { it.id == masterId }
                .take(4)
            for (dev in warmCandidates) {
                if (prewarmedT3.add(dev.id)) {
                    scope.launch {
                        runCatching {
                            val proxy = getOrCreateT3Proxy(dev.id)
                            proxy.warmup()
                        }.onFailure {
                            prewarmedT3.remove(dev.id)
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
        dispatchOpen = { to, sid, epk ->
            relayClient.dispatchCommand(
                to = to,
                kind = "t3.tunnel.open",
                args = buildJsonObject {
                    put("sid", sid)
                    put("epk", epk)
                },
                timeoutMs = 20_000L,
            )
        },
        sendTun = { to, sid, data ->
            relayClient.sendTun(to, sid, data)
        },
    )

    init {
        val deviceId = identityStore.getOrCreateDeviceId()
        identity = identityStore.getOrCreateIdentity()
        val cachedPushes = appStore.loadCachedPushes()
        val savedEnrollment = identityStore.getEnrollment()
        _uiState.value = AppUiState(
            enrolled = savedEnrollment != null,
            deviceId = savedEnrollment?.first?.deviceId ?: deviceId,
            deviceName = savedEnrollment?.first?.deviceName ?: identityStore.defaultDeviceName(),
            relayUrl = savedEnrollment?.first?.relayUrl ?: "",
            publicKey = identity.publicKey,
            publicKeyFingerprint = identity.shortFingerprint(),
            pushes = cachedPushes,
            backgroundKeepAlive = appStore.isBackgroundKeepAliveEnabled(),
            pinnedPeers = pinStore.listPins(),
            agent = AgentUiState(masterDeviceId = appStore.getSelectedMasterDeviceId()),
        )
        if (savedEnrollment != null) {
            startConnection(savedEnrollment.first, savedEnrollment.second)
        }
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
        relayClient.reconnectNow()
    }

    fun reconnectIfDisconnected() {
        relayClient.reconnectIfDisconnected()
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
                agent = AgentUiState(masterDeviceId = deviceId),
            )
        }
        scope.launch {
            loadAgentSessions(deviceId)
        }
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
                _uiState.update {
                    it.copy(
                        agent = it.agent.copy(
                            masterDeviceId = target,
                            activeSessionId = resp.activeSessionId,
                            sessions = resp.sessions,
                            defaultProject = resp.defaultProject,
                            loading = false,
                            error = null,
                        ),
                    )
                }
                readAgentConversation(target, resp.activeSessionId)
            }
        }
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
                _uiState.update { cur ->
                    val sortedConfirmed = if (afterPos != null) {
                        val confirmed = cur.agent.messages.filter { it.position < 1_000_000 }
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
                        cur.agent.messages.filter {
                            it.position >= 1_000_000 && !confirmedUserTexts.contains(it.text)
                        }
                    } else {
                        emptyList()
                    }
                    val mergedMessages = sortedConfirmed + pendingOptimistic
                    cur.copy(
                        agent = cur.agent.copy(
                            activeSessionId = resp.sessionId ?: cur.agent.activeSessionId,
                            threadUrl = resp.threadUrl,
                            conversationState = resp.state,
                            messages = mergedMessages,
                            outbox = resp.outbox,
                            error = null,
                        ),
                    )
                }
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
                        ),
                    )
                }
                readAgentConversation(target, resp?.sessionId ?: _uiState.value.agent.activeSessionId)
                if (resp != null) Result.success(resp)
                else Result.failure(IllegalStateException("返回格式无效"))
            }
        }
    }

    suspend fun refreshOutboxList() {
        val target = _uiState.value.agent.masterDeviceId ?: return
        val outcome = relayClient.dispatchCommand(target, "dispatch.list", buildJsonObject { }, timeoutMs = 20_000L)
        if (outcome is CommandOutcome.Ok && outcome.result != null) {
            val parsed = runCatching { json.decodeFromJsonElement(DispatchListResponse.serializer(), outcome.result) }.getOrNull()
            if (parsed != null) {
                _uiState.update { it.copy(agent = it.agent.copy(outbox = parsed.entries)) }
            }
        }
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

    suspend fun fetchImmutableT3Asset(deviceId: String, path: String): CachedAsset? =
        runCatching { assetCache.getOrFetch(path, tunnelClient.session(deviceId)) }.getOrNull()

    suspend fun getOrStartT3ProxyUrl(deviceId: String): Result<String> {
        return try {
            Result.success(getOrCreateT3Proxy(deviceId).baseUrl)
        } catch (t: Throwable) {
            Result.failure(t)
        }
    }

    private suspend fun getOrCreateT3Proxy(deviceId: String): LocalT3ProxyServer {
        // 先确保建立端到端加密隧道（失败时携带明确原因，不默默返回假地址）
        tunnelClient.session(deviceId)
        _uiState.update { it.copy(pinnedPeers = pinStore.listPins()) }
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
                ): TunnelHttpResponse = tunnelClient.session(deviceId).fetch(path, method, headers, body)

                override suspend fun openSocket(
                    path: String,
                    headers: List<Pair<String, String>>,
                    listener: UpstreamWsListener,
                ): UpstreamWs = tunnelClient.session(deviceId).openSocket(path, headers, listener)

                override suspend fun pairCredential(): String? =
                    tunnelClient.session(deviceId).pairCredential()
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
        )
        val raced = t3Proxies.putIfAbsent(deviceId, proxy)
        return if (raced != null) {
            proxy.stop()
            raced
        } else {
            proxy
        }
    }

    private suspend fun pullMissedPushes() {
        val since = appStore.getLastPushSeq()
        val pulled = runCatching { relayClient.pullPushes(sinceSeq = since, limit = 100) }.getOrNull() ?: return
        for (item in pulled.items.sortedBy { it.seq }) {
            mergePushItem(item, notify = false)
        }
        if (pulled.latestSeq > since) {
            appStore.setLastPushSeq(pulled.latestSeq)
        }
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
                        _uiState.update { it.copy(agent = it.agent.copy(conversationState = mapped)) }
                    }
                    scope.launch { readAgentConversation(masterId, sid) }
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
            it.id != _uiState.value.deviceId && it.enrolled == true && it.dispatch?.viewT3 == true
        }
}
