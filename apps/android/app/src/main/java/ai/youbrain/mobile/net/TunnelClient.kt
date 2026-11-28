package ai.youbrain.mobile.net

import ai.youbrain.mobile.crypto.Base64Url
import ai.youbrain.mobile.crypto.TunnelCipher
import ai.youbrain.mobile.crypto.TunnelCrypto
import ai.youbrain.mobile.data.PeerPinStore
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
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
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.zip.Deflater
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream

const val TUNNEL_WS_GZIP_CAP = "ws-gzip"
const val TUNNEL_TARGET_T3 = "t3"
const val TUNNEL_TARGET_TTY7 = "tty7"
const val TUNNEL_TTY7_HEADER = "x-ubrain-tty7"

private const val WS_GZIP_MIN_BYTES = 512
private const val WS_CHUNK_BYTES = 48 * 1024
private const val MAX_WS_MESSAGE_BYTES = 32 * 1024 * 1024
private const val HEAD_GET_TIMEOUT_MS = 12_000L
private const val HEAD_MUTATE_TIMEOUT_MS = 25_000L
private const val BODY_IDLE_TIMEOUT_MS = 20_000L
private const val BODY_MAX_TIMEOUT_MS = 90_000L
private const val WS_OPEN_TIMEOUT_MS = 10_000L
private const val PAIR_TIMEOUT_MS = 10_000L
// 比对端 10 分钟空闲清理提前 2 分钟关闭，避免命中服务端静默回收后的半死会话
private const val CLIENT_IDLE_SWEEP_MS = 8 * 60_000L

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
        target: String? = null,
    ): TunnelHttpResponse

    suspend fun openSocket(
        path: String,
        headers: List<Pair<String, String>>,
        listener: UpstreamWsListener,
        target: String? = null,
    ): UpstreamWs

    suspend fun pairCredential(): String?
}

internal sealed interface DecodedWsMessage {
    data class Text(val text: String) : DecodedWsMessage
    data class Binary(val bytes: ByteArray) : DecodedWsMessage
}

/**
 * 对齐 packages/core/src/dispatch/tunnel.ts 的 encodeWsFrames：
 * 支持 ws-gzip 压缩（level 1）及超过 48 KB 的分片（more: true），彻底消除大体积 T3 快照超出 160 KB 隧道单帧上限导致卡死的问题。
 */
internal fun encodeWsFrames(
    id: String,
    text: String?,
    binary: ByteArray?,
    wsGzip: Boolean,
): List<JsonObject> {
    val isText = text != null
    if (!wsGzip) {
        return listOf(
            buildJsonObject {
                put("k", "ws-msg")
                put("id", id)
                if (isText) put("text", text!!)
                else put("body", Base64Url.encodeStd(binary ?: ByteArray(0)))
            },
        )
    }
    val raw = if (isText) text!!.toByteArray(Charsets.UTF_8) else (binary ?: ByteArray(0))
    if (raw.size < WS_GZIP_MIN_BYTES && raw.size <= WS_CHUNK_BYTES) {
        return listOf(
            buildJsonObject {
                put("k", "ws-msg")
                put("id", id)
                if (isText) put("text", text!!)
                else put("body", Base64Url.encodeStd(raw))
            },
        )
    }
    val gz = if (raw.size >= WS_GZIP_MIN_BYTES) gzipFast(raw) else null
    val useGzip = gz != null && (gz.size + 16 < raw.size || (isText && raw.size > WS_CHUNK_BYTES))
    if (!useGzip && raw.size <= WS_CHUNK_BYTES) {
        return listOf(
            buildJsonObject {
                put("k", "ws-msg")
                put("id", id)
                if (isText) put("text", text!!)
                else put("body", Base64Url.encodeStd(raw))
            },
        )
    }
    val payload = if (useGzip) gz!! else raw
    val total = maxOf(1, (payload.size + WS_CHUNK_BYTES - 1) / WS_CHUNK_BYTES)
    val out = ArrayList<JsonObject>(total)
    for (index in 0 until total) {
        val start = index * WS_CHUNK_BYTES
        val end = minOf(payload.size, start + WS_CHUNK_BYTES)
        val encoded = Base64Url.encodeStd(payload.copyOfRange(start, end))
        val more = index < total - 1
        out.add(
            buildJsonObject {
                put("k", "ws-msg")
                put("id", id)
                if (isText) put("text", encoded) else put("body", encoded)
                if (useGzip) put("enc", "gzip")
                if (more) put("more", true)
            },
        )
    }
    return out
}

internal class WsReassembler {
    private val buffer = ByteArrayOutputStream()
    private var hasParts = false

    @Synchronized
    fun push(msg: JsonObject): DecodedWsMessage? {
        val isGzip = msg["enc"]?.jsonPrimitive?.contentOrNull == "gzip"
        val moreField = msg["more"]?.jsonPrimitive?.booleanOrNull
        val isMultipart = moreField != null || hasParts
        val textField = msg["text"]?.jsonPrimitive?.contentOrNull
        val bodyField = msg["body"]?.jsonPrimitive?.contentOrNull
        if (!isGzip && !isMultipart) {
            if (textField != null) return DecodedWsMessage.Text(textField)
            if (bodyField != null) return DecodedWsMessage.Binary(Base64Url.decodeStd(bodyField))
            return DecodedWsMessage.Text("")
        }
        val isText = textField != null
        val chunk = Base64Url.decodeStd(textField ?: bodyField.orEmpty())
        if (buffer.size() + chunk.size > MAX_WS_MESSAGE_BYTES) {
            buffer.reset()
            hasParts = false
            throw IllegalStateException("WebSocket 消息过大")
        }
        buffer.write(chunk)
        if (moreField == true) {
            hasParts = true
            return null
        }
        val joined = buffer.toByteArray()
        buffer.reset()
        hasParts = false
        val decoded = if (isGzip) gunzipLimited(joined, MAX_WS_MESSAGE_BYTES) else joined
        return if (isText) {
            DecodedWsMessage.Text(String(decoded, Charsets.UTF_8))
        } else {
            DecodedWsMessage.Binary(decoded)
        }
    }
}

private fun gzipFast(raw: ByteArray): ByteArray {
    val bos = ByteArrayOutputStream(minOf(raw.size, 8192))
    object : GZIPOutputStream(bos) {
        init {
            def.setLevel(Deflater.BEST_SPEED)
        }
    }.use { it.write(raw) }
    return bos.toByteArray()
}

private fun gunzipLimited(compressed: ByteArray, maxBytes: Int): ByteArray {
    if (compressed.isEmpty()) return ByteArray(0)
    GZIPInputStream(ByteArrayInputStream(compressed)).use { gis ->
        val out = ByteArrayOutputStream(minOf(maxBytes, maxOf(1024, compressed.size * 3)))
        val buf = ByteArray(16 * 1024)
        while (true) {
            val n = gis.read(buf)
            if (n <= 0) break
            if (out.size() + n > maxBytes) {
                throw IllegalStateException("解压数据超出上限")
            }
            out.write(buf, 0, n)
        }
        return out.toByteArray()
    }
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

    @Volatile
    var lastReceived: Long = System.currentTimeMillis()
        private set

    fun receive(ciphertext: String) {
        val opened = try {
            cipher.open(ciphertext)
        } catch (_: Throwable) {
            onBroken()
            return
        }
        val now = System.currentTimeMillis()
        lastUsed = now
        lastReceived = now
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
    val wsGzip: Boolean = false,
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
        val headDeferred: CompletableDeferred<Unit> = CompletableDeferred(),
        val bodyDeferred: CompletableDeferred<TunnelHttpResponse> = CompletableDeferred(),
    ) {
        @Volatile
        var status: Int = 200
        @Volatile
        var statusText: String = "OK"
        @Volatile
        var headers: List<Pair<String, String>> = emptyList()
        @Volatile
        var gzip: Boolean = false
        @Volatile
        var lastChunkAt: Long = System.currentTimeMillis()
        val buffer = ByteArrayOutputStream()
    }

    private inner class SessionWs(
        private val id: String,
        private val listener: UpstreamWsListener,
    ) : UpstreamWs {
        @Volatile
        var wsClosed = false
        private val openedFlag = AtomicBoolean(false)
        private val inbound = WsReassembler()
        private val outboundQueue = Channel<JsonObject>(Channel.UNLIMITED)
        private val senderJob: Job
        private var openWatchdogJob: Job? = null

        init {
            senderJob = scope.launch {
                for (frame in outboundQueue) {
                    if (closed || wsClosed) break
                    try {
                        channel.post(frame)
                    } catch (_: Throwable) {
                        failWs()
                        break
                    }
                }
            }
        }

        fun startOpenWatchdog(sentAt: Long) {
            openWatchdogJob = scope.launch {
                delay(WS_OPEN_TIMEOUT_MS)
                if (!openedFlag.get() && !wsClosed && !closed) {
                    if (channel.lastReceived < sentAt) {
                        this@TunnelSession.close(notify = false)
                    } else {
                        failWs()
                    }
                }
            }
        }

        override fun sendText(text: String) {
            if (closed || wsClosed) return
            val frames = encodeWsFrames(id = id, text = text, binary = null, wsGzip = wsGzip)
            for (frame in frames) {
                outboundQueue.trySend(frame)
            }
        }

        override fun sendBinary(bytes: ByteArray) {
            if (closed || wsClosed) return
            val frames = encodeWsFrames(id = id, text = null, binary = bytes, wsGzip = wsGzip)
            for (frame in frames) {
                outboundQueue.trySend(frame)
            }
        }

        override fun close(code: Int, reason: String) {
            if (wsClosed) return
            wsClosed = true
            openWatchdogJob?.cancel()
            outboundQueue.close()
            senderJob.cancel()
            wsStreams.remove(id)
            if (!closed) {
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
            }
            listener.onClose(code, reason)
        }

        fun onOpened() {
            if (wsClosed) return
            if (openedFlag.compareAndSet(false, true)) {
                openWatchdogJob?.cancel()
                listener.onOpen()
            }
        }

        fun onRemoteMsg(msg: JsonObject) {
            if (wsClosed) return
            val decoded = try {
                inbound.push(msg)
            } catch (_: Throwable) {
                failWs()
                return
            } ?: return
            when (decoded) {
                is DecodedWsMessage.Text -> listener.onMessageText(decoded.text)
                is DecodedWsMessage.Binary -> listener.onMessageBinary(decoded.bytes)
            }
        }

        fun failWs() {
            if (wsClosed) return
            wsClosed = true
            openWatchdogJob?.cancel()
            outboundQueue.close()
            senderJob.cancel()
            wsStreams.remove(id)
            listener.onError()
            listener.onClose(1011, "T3 连接中断")
        }

        fun closeRemote(code: Int, reason: String) {
            if (wsClosed) return
            wsClosed = true
            openWatchdogJob?.cancel()
            outboundQueue.close()
            senderJob.cancel()
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
        target: String?,
    ): TunnelHttpResponse {
        if (closed) throw IllegalStateException("隧道已关闭")
        val id = nextId.getAndIncrement().toString()
        val stream = HttpStreamState()
        httpStreams[id] = stream

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

        val sentAt = System.currentTimeMillis()
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
                    if (target != null && target != TUNNEL_TARGET_T3) put("target", target)
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

            val headTimeout = if (method.equals("GET", ignoreCase = true) || method.equals("HEAD", ignoreCase = true)) {
                HEAD_GET_TIMEOUT_MS
            } else {
                HEAD_MUTATE_TIMEOUT_MS
            }
            val gotHead = withTimeoutOrNull(headTimeout) {
                stream.headDeferred.await()
                true
            } ?: false
            if (!gotHead) {
                if (channel.lastReceived < sentAt) {
                    close(notify = false)
                }
                throw IllegalStateException(
                    if (target == TUNNEL_TARGET_TTY7) "对端终端服务响应超时" else "对端 T3 响应超时",
                )
            }

            stream.lastChunkAt = System.currentTimeMillis()
            while (true) {
                val completed = withTimeoutOrNull(2_000L) { stream.bodyDeferred.await() }
                if (completed != null) return completed
                val now = System.currentTimeMillis()
                if (now - stream.lastChunkAt > BODY_IDLE_TIMEOUT_MS || now - sentAt > BODY_MAX_TIMEOUT_MS) {
                    if (channel.lastReceived < stream.lastChunkAt) {
                        close(notify = false)
                    }
                    throw IllegalStateException(
                        if (target == TUNNEL_TARGET_TTY7) "对端终端响应体传输超时" else "对端 T3 响应体传输超时",
                    )
                }
            }
        } catch (t: Throwable) {
            httpStreams.remove(id)
            throw t
        }
    }

    override suspend fun openSocket(
        path: String,
        headers: List<Pair<String, String>>,
        listener: UpstreamWsListener,
        target: String?,
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
        val sentAt = System.currentTimeMillis()
        try {
            channel.post(
                buildJsonObject {
                    put("k", "ws-open")
                    put("id", id)
                    put("path", path)
                    put("headers", rawHeaders)
                    if (target != null && target != TUNNEL_TARGET_T3) put("target", target)
                },
            )
            ws.startOpenWatchdog(sentAt)
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
        val sentAt = System.currentTimeMillis()
        return try {
            channel.post(
                buildJsonObject {
                    put("k", "pair")
                    put("id", id)
                },
            )
            withTimeout(PAIR_TIMEOUT_MS) { deferred.await() }
        } catch (_: Throwable) {
            pairWaiters.remove(id)
            if (channel.lastReceived < sentAt) {
                close(notify = false)
            }
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
                stream.lastChunkAt = System.currentTimeMillis()
                stream.headDeferred.complete(Unit)
                if (stream.status == 204 || stream.status == 205 || stream.status == 304 || stream.status in 100..199) {
                    httpStreams.remove(id)
                    stream.bodyDeferred.complete(
                        TunnelHttpResponse(stream.status, stream.statusText, stream.headers, ByteArray(0)),
                    )
                }
            }
            "chunk" -> {
                val stream = httpStreams[id] ?: return
                stream.lastChunkAt = System.currentTimeMillis()
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
                            gunzipLimited(rawBytes, MAX_WS_MESSAGE_BYTES)
                        } else {
                            rawBytes
                        }
                    } catch (t: Throwable) {
                        stream.headDeferred.completeExceptionally(t)
                        stream.bodyDeferred.completeExceptionally(t)
                        return
                    }
                    stream.headDeferred.complete(Unit)
                    stream.bodyDeferred.complete(
                        TunnelHttpResponse(stream.status, stream.statusText, stream.headers, decoded),
                    )
                }
            }
            "err" -> {
                val errMsg = msg["message"]?.jsonPrimitive?.contentOrNull ?: "对端 T3 出错"
                httpStreams.remove(id)?.let { s ->
                    val ex = IllegalStateException(errMsg)
                    s.headDeferred.completeExceptionally(ex)
                    s.bodyDeferred.completeExceptionally(ex)
                }
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
        val closedEx = IllegalStateException("隧道已关闭")
        for ((_, s) in httpStreams) {
            s.headDeferred.completeExceptionally(closedEx)
            s.bodyDeferred.completeExceptionally(closedEx)
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
    private val dispatchOpen: suspend (to: String, sid: String, epk: String, caps: List<String>) -> CommandOutcome,
    private val sendTun: suspend (to: String, sid: String, data: String, onDeliveryFailure: (Throwable) -> Unit) -> Unit,
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
            if (inflight != null && inflight.isActive) {
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
            val opened = openWithRetry(deviceId)
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

    private suspend fun openWithRetry(deviceId: String): TunnelSession {
        return try {
            openInternal(deviceId)
        } catch (firstErr: Throwable) {
            val msg = firstErr.message.orEmpty()
            if (msg.contains("超时")) {
                openInternal(deviceId)
            } else {
                throw firstErr
            }
        }
    }

    private suspend fun openInternal(deviceId: String): TunnelSession {
        val sid = Base64Url.newNonce(12)
        val ephemeral = TunnelCrypto.newEphemeral()
        val outcome = dispatchOpen(deviceId, sid, ephemeral.publicKey, listOf(TUNNEL_WS_GZIP_CAP))
        if (outcome is CommandOutcome.Err) throw IllegalStateException(outcome.error)
        val resultObj = (outcome as CommandOutcome.Ok).result?.jsonObject
            ?: throw IllegalStateException("对端握手应答格式无效")
        val respEpk = resultObj["epk"]?.jsonPrimitive?.contentOrNull
            ?: throw IllegalStateException("对端握手缺少 epk")
        val sig = resultObj["sig"]?.jsonPrimitive?.contentOrNull
            ?: throw IllegalStateException("对端握手缺少签名")
        val wsGzip = (resultObj["caps"] as? JsonArray)?.any {
            it.jsonPrimitive.contentOrNull == TUNNEL_WS_GZIP_CAP
        } == true

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
            wsGzip = wsGzip,
            sendCiphertext = { data ->
                sendTun(deviceId, sid, data) {
                    session.close(notify = false)
                }
            },
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

    fun closeDeviceSession(deviceId: String) {
        sessions.remove(deviceId)?.close(notify = false)
    }

    suspend fun forceResetSession(deviceId: String) {
        val oldSession = mutex.withLock {
            opening.remove(deviceId)?.completeExceptionally(IllegalStateException("正在重新建立 T3 隧道"))
            sessions.remove(deviceId)
        }
        oldSession?.close(notify = true)
    }

    fun closeAll() {
        sweeperJob?.cancel()
        sweeperJob = null
        val snapshot = sessions.values.toList()
        sessions.clear()
        bySid.clear()
        for (session in snapshot) {
            session.close(notify = false)
        }
    }

    private fun startSweeper() {
        if (sweeperJob?.isActive == true) return
        sweeperJob = scope.launch(Dispatchers.Default) {
            while (isActive) {
                delay(60_000L)
                val now = System.currentTimeMillis()
                for (session in sessions.values.toList()) {
                    if (now - session.lastUsed() > CLIENT_IDLE_SWEEP_MS) {
                        session.close(notify = true)
                    }
                }
                if (sessions.isEmpty()) break
            }
        }
    }
}
