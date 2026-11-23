package ai.youbrain.mobile.net

import ai.youbrain.mobile.crypto.Base64Url
import ai.youbrain.mobile.crypto.CommandSigner
import ai.youbrain.mobile.crypto.Ed25519Identity
import ai.youbrain.mobile.data.ConnectionState
import ai.youbrain.mobile.data.MobilePushItem
import ai.youbrain.mobile.data.PushesPullResult
import ai.youbrain.mobile.data.RelayState
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

sealed class CommandOutcome {
    data class Ok(val result: JsonElement?) : CommandOutcome()
    data class Err(val error: String) : CommandOutcome()
}

data class DispatchEventMsg(
    val from: String,
    val dispatchId: String,
    val kind: String,
    val data: JsonElement,
)

class RelayClient(
    private val scope: CoroutineScope,
    private val onConnection: (ConnectionState, String?) -> Unit,
    private val onState: (RelayState) -> Unit,
    private val onPush: (MobilePushItem) -> Unit,
    private val onEvent: (DispatchEventMsg) -> Unit,
    private val onTun: (from: String, sid: String, data: String) -> Unit,
) {
    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .writeTimeout(20, TimeUnit.SECONDS)
        .build()

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    private var url: String = ""
    private var token: String = ""
    private var deviceId: String = ""
    private var deviceName: String = ""
    private var identity: Ed25519Identity? = null

    private val stopped = AtomicBoolean(true)
    private var socket: WebSocket? = null
    private var opened = false
    private var failures = 0
    private var lastSeen = 0L
    private var pingJob: Job? = null
    private var reconnectJob: Job? = null
    private val nextReqId = AtomicInteger(1)

    private val pendingReqs = ConcurrentHashMap<String, CompletableDeferred<JsonElement?>>()
    private val pendingCmds = ConcurrentHashMap<String, CompletableDeferred<CommandOutcome>>()
    private val frameChannel = Channel<String>(Channel.UNLIMITED)
    private val tunSemaphore = Semaphore(32)

    init {
        scope.launch(Dispatchers.Default) {
            for (raw in frameChannel) {
                runCatching { handleFrame(raw) }
            }
        }
    }

    companion object {
        private val RETRY_DELAYS = longArrayOf(2_000L, 5_000L, 15_000L, 30_000L, 60_000L)
        private const val PING_MS = 30_000L
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

        fun normalizeRelayUrl(raw: String): String {
            val trimmed = raw.trim().trimEnd('/')
            val parsed = runCatching { okhttp3.HttpUrl.Builder().let { java.net.URI(trimmed) } }.getOrNull()
                ?: throw IllegalArgumentException("中转地址格式不对，应形如 https://relay.example.com")
            val scheme = parsed.scheme?.lowercase() ?: ""
            val host = parsed.host?.lowercase() ?: ""
            val isLocal = host == "localhost" || host == "127.0.0.1"
            if (scheme != "https" && !(isLocal && scheme == "http")) {
                throw IllegalArgumentException("中转地址必须是 https://")
            }
            return trimmed
        }

        suspend fun enroll(
            relayUrl: String,
            code: String,
            deviceId: String,
            name: String,
            publicKey: String,
        ): String = withContext(Dispatchers.IO) {
            val cleanUrl = normalizeRelayUrl(relayUrl)
            val cleanCode = code.trim()
            require(cleanCode.isNotEmpty()) { "请填写邀请码" }
            val client = OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(15, TimeUnit.SECONDS)
                .build()
            val payload = buildJsonObject {
                put("code", cleanCode)
                put("deviceId", deviceId)
                put("name", name.take(40))
                put("publicKey", publicKey)
            }.toString()
            val req = Request.Builder()
                .url("$cleanUrl/enroll")
                .post(payload.toRequestBody(JSON_MEDIA))
                .build()
            val resp = try {
                client.newCall(req).execute()
            } catch (t: Throwable) {
                throw IllegalStateException("连不上中转：${t.message ?: "网络错误"}")
            }
            resp.use { response ->
                val text = response.body?.string().orEmpty()
                val obj = runCatching { Json.parseToJsonElement(text).jsonObject }.getOrNull()
                if (!response.isSuccessful) {
                    val serverMsg = obj?.get("error")?.jsonPrimitive?.contentOrNull ?: ""
                    val msg = when (response.code) {
                        400 -> serverMsg.ifBlank { "入网参数不合法" }
                        401, 403 -> serverMsg.ifBlank { "邀请码无效或已过期" }
                        409 -> "设备已入网，如需重入网请先在中转吊销该设备"
                        429 -> "尝试次数过多，请稍后重试"
                        else -> "中转入网失败（HTTP ${response.code}）"
                    }
                    throw IllegalStateException(msg)
                }
                val token = obj?.get("token")?.jsonPrimitive?.contentOrNull?.trim().orEmpty()
                if (token.isEmpty()) throw IllegalStateException("中转没有返回有效的设备令牌")
                token
            }
        }
    }

    @Synchronized
    fun start(
        relayUrl: String,
        token: String,
        deviceId: String,
        deviceName: String,
        identity: Ed25519Identity,
    ) {
        this.url = relayUrl.trimEnd('/')
        this.token = token
        this.deviceId = deviceId
        this.deviceName = deviceName
        this.identity = identity
        this.failures = 0
        stopped.set(false)
        teardownSocket()
        reconnectJob?.cancel()
        connectInternal()
    }

    @Synchronized
    fun stop() {
        stopped.set(true)
        reconnectJob?.cancel()
        reconnectJob = null
        teardownSocket()
        failAllPending("已断开中转")
        onConnection(ConnectionState.OFF, null)
    }

    @Synchronized
    fun reconnectNow() {
        if (stopped.get() || url.isBlank() || token.isBlank()) return
        failures = 0
        reconnectJob?.cancel()
        reconnectJob = null
        teardownSocket()
        failAllPending("正在切换网络重连")
        connectInternal()
    }

    @Synchronized
    fun reconnectIfDisconnected() {
        if (stopped.get() || url.isBlank() || token.isBlank()) return
        if (opened || (socket != null && failures == 0)) return
        reconnectNow()
    }

    private fun teardownSocket() {
        pingJob?.cancel()
        pingJob = null
        val old = socket
        socket = null
        opened = false
        runCatching { old?.close(1000, "bye") }
    }

    private fun failAllPending(reason: String) {
        for ((id, d) in pendingReqs) {
            if (pendingReqs.remove(id, d)) d.completeExceptionally(IllegalStateException(reason))
        }
        for ((id, d) in pendingCmds) {
            if (pendingCmds.remove(id, d)) d.complete(CommandOutcome.Err(reason))
        }
    }

    private fun connectInternal() {
        if (stopped.get()) return
        onConnection(ConnectionState.CONNECTING, null)
        val wsBase = url.replaceFirst(Regex("^http"), "ws")
        val encodedName = java.net.URLEncoder.encode(deviceName, "UTF-8")
        val encodedDev = java.net.URLEncoder.encode(deviceId, "UTF-8")
        val req = Request.Builder()
            .url("$wsBase/connect?device=$encodedDev&name=$encodedName")
            .header("Authorization", "Bearer $token")
            .build()

        lateinit var currentWs: WebSocket
        currentWs = httpClient.newWebSocket(
            req,
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    if (socket !== currentWs) {
                        webSocket.close(1000, "stale")
                        return
                    }
                    opened = true
                    failures = 0
                    lastSeen = System.currentTimeMillis()
                    onConnection(ConnectionState.OK, null)
                    startPingLoop(currentWs)
                    scope.launch {
                        runCatching { sendHello() }
                    }
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    if (socket !== currentWs) return
                    lastSeen = System.currentTimeMillis()
                    if (text == "pong") return
                    frameChannel.trySend(text)
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, reason)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    if (socket !== currentWs) return
                    handleSocketDrop(code)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    if (socket !== currentWs) return
                    val msg = if (opened) "和中转的连接断开了" else "连不上中转（${t.message ?: "请检查网络"}）"
                    handleLost(msg)
                }
            },
        )
        socket = currentWs
    }

    private fun startPingLoop(ws: WebSocket) {
        pingJob?.cancel()
        pingJob = scope.launch(Dispatchers.IO) {
            while (isActive && !stopped.get() && socket === ws) {
                delay(PING_MS)
                if (socket !== ws || stopped.get()) break
                if (System.currentTimeMillis() - lastSeen > (PING_MS * 2.5).toLong()) {
                    handleLost("中转心跳超时")
                    break
                }
                if (!ws.send("ping")) {
                    handleLost("中转连接已断开")
                    break
                }
            }
        }
    }

    private fun handleSocketDrop(code: Int) {
        when (code) {
            4001 -> {
                stopped.set(true)
                reconnectJob?.cancel()
                teardownSocket()
                failAllPending("这台设备已被中转吊销，请重新入网")
                onConnection(ConnectionState.ERROR, "这台设备已被中转吊销，请重新入网")
            }
            4000 -> handleLost("同一设备在别处连上了中转")
            else -> handleLost(if (opened) "和中转的连接断开了" else "无法连接中转")
        }
    }

    @Synchronized
    private fun handleLost(reason: String) {
        teardownSocket()
        failAllPending(reason)
        if (stopped.get()) return
        onConnection(ConnectionState.ERROR, reason)
        val waitMs = RETRY_DELAYS[minOf(failures, RETRY_DELAYS.size - 1)]
        failures += 1
        reconnectJob?.cancel()
        reconnectJob = scope.launch {
            delay(waitMs)
            if (!stopped.get()) connectInternal()
        }
    }

    private fun handleFrame(raw: String) {
        if (raw == "pong") return
        val obj = runCatching { json.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return
        when (obj["t"]?.jsonPrimitive?.contentOrNull) {
            "state" -> {
                val state = runCatching { json.decodeFromJsonElement(RelayState.serializer(), obj) }.getOrNull()
                if (state != null) onState(state)
            }
            "push" -> {
                val itemEl = obj["item"] ?: return
                val item = runCatching { json.decodeFromJsonElement(MobilePushItem.serializer(), itemEl) }.getOrNull()
                if (item != null) onPush(item)
            }
            "res" -> {
                val id = obj["id"]?.jsonPrimitive?.contentOrNull ?: return
                val deferred = pendingReqs.remove(id) ?: return
                val ok = obj["ok"]?.jsonPrimitive?.booleanOrNull == true
                if (ok) {
                    deferred.complete(obj["result"])
                } else {
                    val err = obj["error"]?.jsonPrimitive?.contentOrNull ?: "中转处理失败"
                    deferred.completeExceptionally(IllegalStateException(err))
                }
            }
            "cmdres" -> {
                val cmdId = obj["cmdId"]?.jsonPrimitive?.contentOrNull ?: return
                val deferred = pendingCmds.remove(cmdId) ?: return
                val ok = obj["ok"]?.jsonPrimitive?.booleanOrNull == true
                if (ok) {
                    deferred.complete(CommandOutcome.Ok(obj["result"]))
                } else {
                    val err = obj["error"]?.jsonPrimitive?.contentOrNull ?: "目标设备执行失败"
                    deferred.complete(CommandOutcome.Err(err))
                }
            }
            "event" -> {
                val from = obj["from"]?.jsonPrimitive?.contentOrNull ?: return
                val dispatchId = obj["dispatchId"]?.jsonPrimitive?.contentOrNull ?: return
                val kind = obj["kind"]?.jsonPrimitive?.contentOrNull ?: return
                val data = obj["data"] ?: JsonNull
                onEvent(DispatchEventMsg(from = from, dispatchId = dispatchId, kind = kind, data = data))
            }
            "tun" -> {
                val from = obj["from"]?.jsonPrimitive?.contentOrNull ?: return
                val sid = obj["sid"]?.jsonPrimitive?.contentOrNull ?: return
                val d = obj["d"]?.jsonPrimitive?.contentOrNull ?: return
                onTun(from, sid, d)
            }
        }
    }

    suspend fun request(
        op: String,
        params: Map<String, JsonElement> = emptyMap(),
        timeoutMs: Long = 20_000L,
    ): JsonElement? {
        val ws = socket ?: throw IllegalStateException("还没连上中转")
        if (!opened) throw IllegalStateException("中转正在连接中")
        val id = nextReqId.getAndIncrement().toString()
        val deferred = CompletableDeferred<JsonElement?>()
        pendingReqs[id] = deferred
        val frame = buildJsonObject {
            put("t", "req")
            put("id", id)
            put("op", op)
            for ((k, v) in params) put(k, v)
        }
        val sent = runCatching { ws.send(json.encodeToString(JsonObject.serializer(), frame)) }.getOrDefault(false)
        if (!sent) {
            pendingReqs.remove(id, deferred)
            throw IllegalStateException("发送中转请求失败")
        }
        return try {
            withTimeout(timeoutMs) { deferred.await() }
        } catch (t: Throwable) {
            pendingReqs.remove(id, deferred)
            throw t
        }
    }

    suspend fun sendHello(appVersion: String = "0.1.2") {
        val dispatch = buildJsonObject {
            put("enabled", false)
            put("t3", buildJsonObject { put("ready", false) })
            put("projects", kotlinx.serialization.json.JsonArray(emptyList()))
            put("maxMode", "auto")
            put("viewT3", false)
        }
        request(
            "hello",
            mapOf(
                "protocolVersion" to JsonPrimitive(1),
                "version" to JsonPrimitive(appVersion),
                "dispatch" to dispatch,
            ),
        )
    }

    suspend fun pullPushes(sinceSeq: Long, limit: Int = 100): PushesPullResult {
        val res = request(
            "pushes",
            mapOf(
                "sinceSeq" to JsonPrimitive(sinceSeq),
                "limit" to JsonPrimitive(limit),
            ),
        ) ?: return PushesPullResult()
        return json.decodeFromJsonElement(PushesPullResult.serializer(), res)
    }

    suspend fun dispatchCommand(
        to: String,
        kind: String,
        args: JsonElement,
        timeoutMs: Long = 45_000L,
    ): CommandOutcome {
        val id = identity ?: return CommandOutcome.Err("设备身份未就绪")
        if (socket == null || !opened) return CommandOutcome.Err("还没连上中转")

        val cmdId = "c-${UUID.randomUUID().toString().replace("-", "").take(18)}"
        val ts = System.currentTimeMillis()
        val nonce = Base64Url.newNonce(16)
        val cmd = buildJsonObject {
            put("kind", kind)
            put("args", args)
        }
        val sig = try {
            CommandSigner.signCommand(
                privateKeyOrSeedB64 = id.privateSeed,
                cmdId = cmdId,
                from = deviceId,
                to = to,
                ts = ts,
                nonce = nonce,
                cmd = cmd,
            )
        } catch (t: Throwable) {
            return CommandOutcome.Err(t.message ?: "签名失败")
        }

        val waiter = CompletableDeferred<CommandOutcome>()
        pendingCmds[cmdId] = waiter

        try {
            request(
                "cmd",
                mapOf(
                    "cmdId" to JsonPrimitive(cmdId),
                    "to" to JsonPrimitive(to),
                    "cmd" to cmd,
                    "ts" to JsonPrimitive(ts),
                    "nonce" to JsonPrimitive(nonce),
                    "sig" to JsonPrimitive(sig),
                ),
            )
        } catch (t: Throwable) {
            pendingCmds.remove(cmdId, waiter)
            return CommandOutcome.Err(t.message ?: "派活请求发送失败")
        }

        return try {
            withTimeout(timeoutMs) { waiter.await() }
        } catch (_: Throwable) {
            pendingCmds.remove(cmdId, waiter)
            CommandOutcome.Err("等待目标设备结果超时")
        }
    }

    suspend fun sendTun(to: String, sid: String, data: String) {
        val ws = socket ?: throw IllegalStateException("还没连上中转")
        if (!opened) throw IllegalStateException("中转正在连接中")
        tunSemaphore.acquire()
        val id = nextReqId.getAndIncrement().toString()
        val deferred = CompletableDeferred<JsonElement?>()
        pendingReqs[id] = deferred
        val frame = buildJsonObject {
            put("t", "req")
            put("id", id)
            put("op", "tun")
            put("to", to)
            put("sid", sid)
            put("d", data)
        }
        val sent = runCatching { ws.send(json.encodeToString(JsonObject.serializer(), frame)) }.getOrDefault(false)
        if (!sent) {
            pendingReqs.remove(id, deferred)
            tunSemaphore.release()
            throw IllegalStateException("发送隧道帧失败")
        }
        scope.launch {
            try {
                withTimeout(20_000L) { deferred.await() }
            } catch (_: Throwable) {
                pendingReqs.remove(id, deferred)
            } finally {
                tunSemaphore.release()
            }
        }
    }
}
