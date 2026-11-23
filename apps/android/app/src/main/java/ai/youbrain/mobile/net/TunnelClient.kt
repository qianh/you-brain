package ai.youbrain.mobile.net

import ai.youbrain.mobile.crypto.Base64Url
import ai.youbrain.mobile.crypto.TunnelCipher
import ai.youbrain.mobile.crypto.TunnelCrypto
import ai.youbrain.mobile.data.PeerPinStore
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.zip.GZIPInputStream

data class TunnelHttpResponse(
    val status: Int,
    val statusText: String,
    val headers: List<Pair<String, String>>,
    val body: ByteArray,
)

interface UpstreamWsListener {
    fun onOpen()
    fun onMessageText(text: String)
    fun onMessageBinary(bytes: ByteArray)
    fun onClose(code: Int, reason: String)
    fun onError()
}

interface UpstreamWs {
    fun sendText(text: String)
    fun sendBinary(bytes: ByteArray)
    fun close(code: Int = 1000, reason: String = "")
}

interface T3Upstream {
    suspend fun fetch(
        path: String,
        method: String,
        headers: List<Pair<String, String>>,
        body: ByteArray?,
    ): TunnelHttpResponse

    suspend fun openSocket(
        path: String,
        headers: List<Pair<String, String>>,
        listener: UpstreamWsListener,
    ): UpstreamWs

    suspend fun pairCredential(): String?
}

/**
 * 隧道加密通道：按计数器保序重组乱序帧，并在封装前校验不超出中转单帧上限。
 */
class TunnelChannel(
    private val cipher: TunnelCipher,
    private val sendCiphertext: suspend (String) -> Unit,
    private val onMessage: (JsonObject) -> Unit,
    private val onBroken: () -> Unit,
) {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val postMutex = Mutex()
    private var expected = 0L
    private val ahead = HashMap<Long, ByteArray>()

    @Volatile
    var lastUsed: Long = System.currentTimeMillis()
        private set

    fun receive(ciphertext: String) {
        val opened = try {
            cipher.open(ciphertext)
        } catch (_: Throwable) {
            onBroken()
            return
        }
        lastUsed = System.currentTimeMillis()
        synchronized(this) {
            if (opened.counter < expected || ahead.containsKey(opened.counter)) return
            ahead[opened.counter] = opened.plaintext
            if (ahead.size > 1024) {
                onBroken()
                return
            }
            while (true) {
                val next = ahead.remove(expected) ?: break
                expected += 1L
                val parsed = runCatching {
                    json.parseToJsonElement(String(next, Charsets.UTF_8)).jsonObject
                }.getOrNull()
                if (parsed == null) {
                    onBroken()
                    return
                }
                onMessage(parsed)
            }
        }
    }

    suspend fun post(message: JsonObject) {
        lastUsed = System.currentTimeMillis()
        val plain = json.encodeToString(JsonObject.serializer(), message).toByteArray(Charsets.UTF_8)
        // base64url(8B counter + plain + 16B GCM tag) 不能超过中转 TUN_FRAME_MAX_BYTES (160KB)
        val estimatedEncoded = ((plain.size + 24 + 2) / 3) * 4
        if (estimatedEncoded > TunnelCrypto.RELAY_FRAME_MAX) {
            throw IllegalStateException("隧道帧超过中转上限")
        }
        postMutex.withLock {
            val sealed = cipher.seal(plain)
            sendCiphertext(sealed)
        }
    }
}

class TunnelSession(
    val deviceId: String,
    private val scope: CoroutineScope,
    cipher: TunnelCipher,
    sendCiphertext: suspend (String) -> Unit,
    private val onClosedCallback: () -> Unit,
) : T3Upstream {
    @Volatile
    var closed = false
        private set

    private val channel = TunnelChannel(
        cipher = cipher,
        sendCiphertext = sendCiphertext,
        onMessage = { handle(it) },
        onBroken = { close(notify = false) },
    )

    private val nextId = AtomicInteger(1)
    private val httpStreams = ConcurrentHashMap<String, HttpStreamState>()
    private val wsStreams = ConcurrentHashMap<String, SessionWs>()
    private val pairWaiters = ConcurrentHashMap<String, CompletableDeferred<String?>>()

    private class HttpStreamState(
        val deferred: CompletableDeferred<TunnelHttpResponse>,
    ) {
        var status: Int = 200
        var statusText: String = "OK"
        var headers: List<Pair<String, String>> = emptyList()
        var gzip: Boolean = false
        var headReceived: Boolean = false
        val buffer = ByteArrayOutputStream()
    }

    private inner class SessionWs(
        private val id: String,
        private val listener: UpstreamWsListener,
    ) : UpstreamWs {
        @Volatile
        var wsClosed = false

        override fun sendText(text: String) {
            if (closed || wsClosed) return
            scope.launch {
                runCatching {
                    channel.post(
                        buildJsonObject {
                            put("k", "ws-msg")
                            put("id", id)
                            put("text", text)
                        },
                    )
                }.onFailure { failWs() }
            }
        }

        override fun sendBinary(bytes: ByteArray) {
            if (closed || wsClosed) return
            scope.launch {
                runCatching {
                    channel.post(
                        buildJsonObject {
                            put("k", "ws-msg")
                            put("id", id)
                            put("body", Base64Url.encodeStd(bytes))
                        },
                    )
                }.onFailure { failWs() }
            }
        }

        override fun close(code: Int, reason: String) {
            if (wsClosed) return
            wsClosed = true
            wsStreams.remove(id)
            scope.launch {
                runCatching {
                    channel.post(
                        buildJsonObject {
                            put("k", "ws-close")
                            put("id", id)
                            put("code", code)
                            put("reason", reason)
                        },
                    )
                }
            }
            listener.onClose(code, reason)
        }

        fun onOpened() = listener.onOpen()

        fun onRemoteMsg(msg: JsonObject) {
            val text = msg["text"]?.jsonPrimitive?.contentOrNull
            if (text != null) {
                listener.onMessageText(text)
                return
            }
            val bodyB64 = msg["body"]?.jsonPrimitive?.contentOrNull
            if (bodyB64 != null) {
                listener.onMessageBinary(Base64Url.decodeStd(bodyB64))
            }
        }

        fun failWs() {
            if (wsClosed) return
            wsClosed = true
            wsStreams.remove(id)
            listener.onError()
            listener.onClose(1011, "T3 连接中断")
        }

        fun closeRemote(code: Int, reason: String) {
            if (wsClosed) return
            wsClosed = true
            wsStreams.remove(id)
            listener.onClose(code, reason)
        }
    }

    fun lastUsed(): Long = channel.lastUsed

    fun receiveFrame(data: String) = channel.receive(data)

    override suspend fun fetch(
        path: String,
        method: String,
        headers: List<Pair<String, String>>,
        body: ByteArray?,
    ): TunnelHttpResponse {
        if (closed) throw IllegalStateException("隧道已关闭")
        val id = nextId.getAndIncrement().toString()
        val deferred = CompletableDeferred<TunnelHttpResponse>()
        httpStreams[id] = HttpStreamState(deferred)

        val rawHeaders = buildJsonArray {
            for ((k, v) in headers) {
                add(buildJsonArray { add(JsonPrimitive(k)); add(JsonPrimitive(v)) })
            }
        }
        val chunks = if (body != null && body.isNotEmpty()) {
            val list = ArrayList<ByteArray>()
            var offset = 0
            while (offset < body.size) {
                val end = minOf(body.size, offset + TunnelCrypto.CHUNK_BYTES)
                list.add(body.copyOfRange(offset, end))
                offset = end
            }
            list
        } else {
            emptyList()
        }

        try {
            val first = chunks.firstOrNull()
            channel.post(
                buildJsonObject {
                    put("k", "req")
                    put("id", id)
                    put("method", method)
                    put("path", path)
                    put("headers", rawHeaders)
                    if (first != null) put("body", Base64Url.encodeStd(first))
                    put("end", chunks.size <= 1)
                },
            )
            for (i in 1 until chunks.size) {
                channel.post(
                    buildJsonObject {
                        put("k", "body")
                        put("id", id)
                        put("body", Base64Url.encodeStd(chunks[i]))
                        put("end", i == chunks.size - 1)
                    },
                )
            }
            return withTimeout(60_000L) { deferred.await() }
        } catch (t: Throwable) {
            httpStreams.remove(id)
            throw t
        }
    }

    override suspend fun openSocket(
        path: String,
        headers: List<Pair<String, String>>,
        listener: UpstreamWsListener,
    ): UpstreamWs {
        if (closed) throw IllegalStateException("隧道已关闭")
        val id = nextId.getAndIncrement().toString()
        val ws = SessionWs(id, listener)
        wsStreams[id] = ws
        val rawHeaders = buildJsonArray {
            for ((k, v) in headers) {
                add(buildJsonArray { add(JsonPrimitive(k)); add(JsonPrimitive(v)) })
            }
        }
        try {
            channel.post(
                buildJsonObject {
                    put("k", "ws-open")
                    put("id", id)
                    put("path", path)
                    put("headers", rawHeaders)
                },
            )
        } catch (t: Throwable) {
            ws.failWs()
            throw t
        }
        return ws
    }

    override suspend fun pairCredential(): String? {
        if (closed) return null
        val id = nextId.getAndIncrement().toString()
        val deferred = CompletableDeferred<String?>()
        pairWaiters[id] = deferred
        return try {
            channel.post(
                buildJsonObject {
                    put("k", "pair")
                    put("id", id)
                },
            )
            withTimeout(15_000L) { deferred.await() }
        } catch (_: Throwable) {
            pairWaiters.remove(id)
            null
        }
    }

    private fun handle(msg: JsonObject) {
        val kind = msg["k"]?.jsonPrimitive?.contentOrNull ?: return
        if (kind == "bye") {
            close(notify = false)
            return
        }
        val id = msg["id"]?.jsonPrimitive?.contentOrNull ?: return
        when (kind) {
            "head" -> {
                val stream = httpStreams[id] ?: return
                stream.status = msg["status"]?.jsonPrimitive?.intOrNull ?: 200
                stream.statusText = msg["statusText"]?.jsonPrimitive?.contentOrNull ?: ""
                stream.gzip = msg["enc"]?.jsonPrimitive?.contentOrNull == "gzip"
                val hdrs = ArrayList<Pair<String, String>>()
                msg["headers"]?.jsonArray?.forEach { pairEl ->
                    val arr = pairEl as? JsonArray ?: return@forEach
                    val k = arr.getOrNull(0)?.jsonPrimitive?.contentOrNull ?: return@forEach
                    val v = arr.getOrNull(1)?.jsonPrimitive?.contentOrNull ?: ""
                    hdrs.add(k to v)
                }
                stream.headers = hdrs
                stream.headReceived = true
                if (stream.status == 204 || stream.status == 205 || stream.status == 304 || stream.status in 100..199) {
                    httpStreams.remove(id)
                    stream.deferred.complete(TunnelHttpResponse(stream.status, stream.statusText, stream.headers, ByteArray(0)))
                }
            }
            "chunk" -> {
                val stream = httpStreams[id] ?: return
                val bodyB64 = msg["body"]?.jsonPrimitive?.contentOrNull.orEmpty()
                if (bodyB64.isNotEmpty()) {
                    stream.buffer.write(Base64Url.decodeStd(bodyB64))
                }
                val end = msg["end"]?.jsonPrimitive?.booleanOrNull == true
                if (end) {
                    httpStreams.remove(id)
                    val rawBytes = stream.buffer.toByteArray()
                    val decoded = try {
                        if (stream.gzip && rawBytes.isNotEmpty()) {
                            GZIPInputStream(ByteArrayInputStream(rawBytes)).use { it.readBytes() }
                        } else {
                            rawBytes
                        }
                    } catch (t: Throwable) {
                        stream.deferred.completeExceptionally(t)
                        return
                    }
                    stream.deferred.complete(
                        TunnelHttpResponse(stream.status, stream.statusText, stream.headers, decoded),
                    )
                }
            }
            "err" -> {
                val errMsg = msg["message"]?.jsonPrimitive?.contentOrNull ?: "对端 T3 出错"
                httpStreams.remove(id)?.deferred?.completeExceptionally(IllegalStateException(errMsg))
                wsStreams[id]?.failWs()
                pairWaiters.remove(id)?.complete(null)
            }
            "ws-ok" -> wsStreams[id]?.onOpened()
            "ws-msg" -> wsStreams[id]?.onRemoteMsg(msg)
            "ws-close" -> {
                val code = msg["code"]?.jsonPrimitive?.intOrNull ?: 1000
                val reason = msg["reason"]?.jsonPrimitive?.contentOrNull.orEmpty()
                wsStreams[id]?.closeRemote(code, reason)
            }
            "pair-res" -> {
                val cred = msg["credential"]?.jsonPrimitive?.contentOrNull
                pairWaiters.remove(id)?.complete(cred)
            }
        }
    }

    fun close(notify: Boolean = true) {
        if (closed) return
        closed = true
        if (notify) {
            scope.launch {
                runCatching { channel.post(buildJsonObject { put("k", "bye") }) }
            }
        }
        for ((_, s) in httpStreams) {
            s.deferred.completeExceptionally(IllegalStateException("隧道已关闭"))
        }
        httpStreams.clear()
        for ((_, ws) in wsStreams.toMap()) {
            ws.closeRemote(1011, "隧道已关闭")
        }
        wsStreams.clear()
        for ((_, p) in pairWaiters) {
            p.complete(null)
        }
        pairWaiters.clear()
        onClosedCallback()
    }
}

class TunnelClient(
    private val scope: CoroutineScope,
    private val selfDeviceId: () -> String,
    private val peerKey: (String) -> String?,
    private val pins: PeerPinStore,
    private val dispatchOpen: suspend (to: String, sid: String, epk: String) -> CommandOutcome,
    private val sendTun: suspend (to: String, sid: String, data: String) -> Unit,
) {
    private val mutex = Mutex()
    private val sessions = ConcurrentHashMap<String, TunnelSession>()
    private val bySid = ConcurrentHashMap<String, TunnelSession>()
    private val opening = HashMap<String, CompletableDeferred<TunnelSession>>()
    private var sweeperJob: Job? = null

    suspend fun session(deviceId: String): TunnelSession {
        val existing = sessions[deviceId]
        if (existing != null && !existing.closed) return existing

        val waitOrCreate: Pair<Boolean, CompletableDeferred<TunnelSession>> = mutex.withLock {
            val again = sessions[deviceId]
            if (again != null && !again.closed) {
                return again
            }
            val inflight = opening[deviceId]
            if (inflight != null) {
                false to inflight
            } else {
                val created = CompletableDeferred<TunnelSession>()
                opening[deviceId] = created
                true to created
            }
        }
        val (isLeader, deferred) = waitOrCreate
        if (!isLeader) return deferred.await()

        return try {
            val opened = openInternal(deviceId)
            deferred.complete(opened)
            opened
        } catch (t: Throwable) {
            deferred.completeExceptionally(t)
            throw t
        } finally {
            mutex.withLock {
                opening.remove(deviceId, deferred)
            }
        }
    }

    private suspend fun openInternal(deviceId: String): TunnelSession {
        val sid = Base64Url.newNonce(12)
        val ephemeral = TunnelCrypto.newEphemeral()
        val outcome = dispatchOpen(deviceId, sid, ephemeral.publicKey)
        if (outcome is CommandOutcome.Err) throw IllegalStateException(outcome.error)
        val resultObj = (outcome as CommandOutcome.Ok).result?.jsonObject
            ?: throw IllegalStateException("对端握手应答格式无效")
        val respEpk = resultObj["epk"]?.jsonPrimitive?.contentOrNull
            ?: throw IllegalStateException("对端握手缺少 epk")
        val sig = resultObj["sig"]?.jsonPrimitive?.contentOrNull
            ?: throw IllegalStateException("对端握手缺少签名")

        val pinnedPub = pins.resolve(deviceId, peerKey(deviceId))
        val transcript = TunnelCrypto.tunnelTranscript(
            sid = sid,
            initiator = selfDeviceId(),
            responder = deviceId,
            initiatorKey = ephemeral.publicKey,
            responderKey = respEpk,
        )
        if (!TunnelCrypto.verifyTranscript(pinnedPub, transcript, sig)) {
            throw IllegalStateException("对端 T3 隧道握手验签失败，已拒绝连接")
        }

        val cipher = TunnelCrypto.deriveCipher(
            privateKey = ephemeral.privateKey,
            peerPublicKeyB64 = respEpk,
            sid = sid,
            role = "initiator",
        )
        val key = "$deviceId\u0000$sid"
        lateinit var session: TunnelSession
        session = TunnelSession(
            deviceId = deviceId,
            scope = scope,
            cipher = cipher,
            sendCiphertext = { data -> sendTun(deviceId, sid, data) },
            onClosedCallback = {
                sessions.remove(deviceId, session)
                bySid.remove(key)
            },
        )
        sessions[deviceId] = session
        bySid[key] = session
        startSweeper()
        return session
    }

    fun onFrame(from: String, sid: String, data: String) {
        bySid["$from\u0000$sid"]?.receiveFrame(data)
    }

    fun closeAll() {
        sweeperJob?.cancel()
        sweeperJob = null
        for (session in sessions.values.toList()) {
            session.close(notify = false)
        }
        sessions.clear()
        bySid.clear()
    }

    private fun startSweeper() {
        if (sweeperJob?.isActive == true) return
        sweeperJob = scope.launch(Dispatchers.Default) {
            while (isActive) {
                delay(60_000L)
                val now = System.currentTimeMillis()
                for (session in sessions.values.toList()) {
                    if (now - session.lastUsed() > 10 * 60_000L) {
                        session.close(notify = true)
                    }
                }
                if (sessions.isEmpty()) break
            }
        }
    }
}
