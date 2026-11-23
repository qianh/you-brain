package ai.youbrain.mobile.net

import ai.youbrain.mobile.crypto.Base64Url
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * 绑定 127.0.0.1 的本地 HTTP/1.1 + RFC 6455 WebSocket 代理：
 * - 将 Android WebView 发向回环地址的流量转进端到端加密的 T3 隧道。
 * - 自动执行 pair 凭据登录，并按设备前缀隔离 Cookie，去掉 X-Frame-Options / frame-ancestors。
 */
class LocalT3ProxyServer(
    private val scope: CoroutineScope,
    private val upstream: T3Upstream,
    private val cookiePrefix: String,
    preferredPort: Int = 0,
    private val onSetCookies: (proxyOrigin: String, setCookies: List<String>) -> Unit = { _, _ -> },
    private val assetCache: T3AssetCache? = null,
) {
    private val serverSocket: ServerSocket
    val port: Int
    val baseUrl: String
    val origin: String

    private val stopped = AtomicBoolean(false)
    private val authVerifiedUntil = AtomicLong(0L)
    @Volatile
    private var cachedRootHtml: ByteArray? = null
    @Volatile
    private var cachedRootAt: Long = 0L
    private var acceptJob: Job? = null
    @Volatile
    private var pairFailedAt: Long = 0L

    companion object {
        private const val INJECT_PATH = "/__ubrain_t3_inject.js"
        private const val INJECT_JS = "/* u-brain mobile proxy */\n"
        private const val VIRTUAL_ORIGIN = "http://t3.tunnel"
        private const val PAIR_RETRY_MS = 30_000L
        private const val AUTH_CACHE_MS = 10 * 60_000L
        private const val WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

        private val HOP_HEADERS = setOf(
            "connection",
            "keep-alive",
            "proxy-connection",
            "transfer-encoding",
            "upgrade",
            "te",
            "trailer",
            "host",
            "accept-encoding",
            "content-length",
        )
        private val WS_SKIP_HEADERS = HOP_HEADERS + setOf(
            "sec-websocket-key",
            "sec-websocket-version",
            "sec-websocket-extensions",
            "sec-websocket-accept",
        )

        fun prefixSetCookie(setCookie: String, prefix: String): String? {
            val parts = setCookie.split(';')
            val first = parts.firstOrNull() ?: return null
            val eq = first.indexOf('=')
            if (eq <= 0) return null
            val name = first.substring(0, eq).trim()
            if (name.isEmpty()) return null
            if (name.startsWith("__Host-", ignoreCase = true) || name.startsWith("__Secure-", ignoreCase = true)) {
                return null
            }
            val value = first.substring(eq + 1)
            val attrs = ArrayList<String>()
            for (i in 1 until parts.size) {
                val p = parts[i].trim()
                if (p.isEmpty()) continue
                val attrEq = p.indexOf('=')
                val attrName = (if (attrEq == -1) p else p.substring(0, attrEq)).trim().lowercase()
                if (attrName == "domain") continue
                attrs.add(p)
            }
            val head = "$prefix$name=$value"
            return if (attrs.isEmpty()) head else "$head; ${attrs.joinToString("; ")}"
        }

        fun stripCookiePrefix(cookieHeader: String, prefix: String): String {
            val kept = ArrayList<String>()
            for (part in cookieHeader.split(';')) {
                val trimmed = part.trim()
                if (trimmed.isEmpty()) continue
                val eq = trimmed.indexOf('=')
                if (eq <= 0) continue
                val name = trimmed.substring(0, eq).trim()
                if (!name.startsWith(prefix)) continue
                val rawName = name.substring(prefix.length)
                if (rawName.isEmpty()) continue
                val value = trimmed.substring(eq + 1)
                kept.add("$rawName=$value")
            }
            return kept.joinToString("; ")
        }

        fun stripFrameAncestors(csp: String): String? {
            val rest = csp.split(';')
                .map { it.trim() }
                .filter { it.isNotEmpty() && !it.matches(Regex("^frame-ancestors(?:\\s.*)?$", RegexOption.IGNORE_CASE)) }
            return if (rest.isEmpty()) null else rest.joinToString("; ")
        }

        fun injectHtml(html: String): String {
            val tag = """<script src="$INJECT_PATH"></script>"""
            val idx = Regex("</head>", RegexOption.IGNORE_CASE).find(html)?.range?.first
            return if (idx == null) "$tag$html" else html.substring(0, idx) + tag + html.substring(idx)
        }
    }

    init {
        val loopback = InetAddress.getByName("127.0.0.1")
        serverSocket = try {
            ServerSocket(preferredPort, 64, loopback)
        } catch (_: IOException) {
            ServerSocket(0, 64, loopback)
        }
        port = serverSocket.localPort
        origin = "http://127.0.0.1:$port"
        baseUrl = "$origin/"
        acceptJob = scope.launch(Dispatchers.IO) {
            while (isActive && !stopped.get()) {
                val client = try {
                    serverSocket.accept()
                } catch (_: IOException) {
                    break
                }
                launch(Dispatchers.IO) {
                    handleConnection(client)
                }
            }
        }
    }

    fun stop() {
        if (!stopped.compareAndSet(false, true)) return
        acceptJob?.cancel()
        runCatching { serverSocket.close() }
    }

    suspend fun warmup() {
        val now = System.currentTimeMillis()
        var pairedCookies: List<String> = emptyList()
        val response = coroutineScope {
            val respJob = async { upstream.fetch("/", "GET", listOf("Accept" to "text/html"), null) }
            val pairJob = async { if (now >= authVerifiedUntil.get()) autoPair(emptyList()) else emptyList() }
            val fetched = respJob.await()
            val ct = fetched.headers
                .firstOrNull { it.first.equals("content-type", ignoreCase = true) }
                ?.second.orEmpty()
            pairedCookies = if (ct.contains("text/html", ignoreCase = true)) {
                pairJob.await()
            } else {
                pairJob.cancel()
                emptyList()
            }
            fetched
        }
        if (pairedCookies.isNotEmpty()) {
            onSetCookies(origin, pairedCookies)
        }
        val ct = response.headers.firstOrNull { it.first.equals("content-type", ignoreCase = true) }?.second.orEmpty()
        if (response.status in 200..299 && ct.contains("text/html", ignoreCase = true)) {
            val rawHtmlText = String(response.body, Charsets.UTF_8)
            val finalHtmlBytes = injectHtml(rawHtmlText).toByteArray(Charsets.UTF_8)
            if (System.currentTimeMillis() < authVerifiedUntil.get()) {
                cachedRootHtml = finalHtmlBytes
                cachedRootAt = System.currentTimeMillis()
            }
            assetCache?.prefetchFromHtml(rawHtmlText, upstream)
        }
    }

    private suspend fun refreshRootHtml() {
        val response = upstream.fetch("/", "GET", listOf("Accept" to "text/html"), null)
        val ct = response.headers.firstOrNull { it.first.equals("content-type", ignoreCase = true) }?.second.orEmpty()
        if (response.status == 401 || response.status == 403) {
            authVerifiedUntil.set(0L)
            cachedRootHtml = null
            return
        }
        if (response.status in 200..299 && ct.contains("text/html", ignoreCase = true)) {
            val rawHtmlText = String(response.body, Charsets.UTF_8)
            val finalHtmlBytes = injectHtml(rawHtmlText).toByteArray(Charsets.UTF_8)
            if (System.currentTimeMillis() < authVerifiedUntil.get()) {
                cachedRootHtml = finalHtmlBytes
                cachedRootAt = System.currentTimeMillis()
            }
            assetCache?.let { cache ->
                scope.launch(Dispatchers.IO) { cache.prefetchFromHtml(rawHtmlText, upstream) }
            }
        }
    }

    private suspend fun handleConnection(socket: Socket) {
        try {
            socket.tcpNoDelay = true
            socket.soTimeout = 30_000
            val input = BufferedInputStream(socket.getInputStream())
            val output = socket.getOutputStream()

            while (!stopped.get() && !socket.isClosed) {
                val head = readHttpHead(input) ?: break
                val (method, path, rawHeaders) = head
                val upgrade = rawHeaders.firstOrNull { it.first.equals("upgrade", ignoreCase = true) }?.second
                if (upgrade.equals("websocket", ignoreCase = true)) {
                    handleWebSocket(socket, input, output, path, rawHeaders)
                    return
                }

                val clientWantsClose = rawHeaders.any {
                    it.first.equals("connection", ignoreCase = true) && it.second.contains("close", ignoreCase = true)
                }
                val keepAlive = !clientWantsClose && !stopped.get()

                if (path == INJECT_PATH) {
                    val bytes = INJECT_JS.toByteArray(Charsets.UTF_8)
                    writeHttpResponse(
                        output,
                        200,
                        "OK",
                        listOf(
                            "Content-Type" to "text/javascript; charset=utf-8",
                            "Cache-Control" to "no-store",
                        ),
                        bytes,
                        keepAlive = keepAlive,
                    )
                    if (!keepAlive) break
                    continue
                }

                if (method == "GET" && assetCache != null && T3AssetCache.isImmutableAssetPath(path)) {
                    val cached = assetCache.getOrFetch(path, upstream)
                    if (cached != null) {
                        writeHttpResponse(
                            output,
                            200,
                            "OK",
                            listOf(
                                "Content-Type" to cached.mime.contentTypeHeader,
                                "Cache-Control" to "public, max-age=31536000, immutable",
                                "Access-Control-Allow-Origin" to "*",
                            ),
                            cached.bytes,
                            keepAlive = keepAlive,
                        )
                        if (!keepAlive) break
                        continue
                    }
                }

                val isForceReload = rawHeaders.any {
                    (it.first.equals("cache-control", ignoreCase = true) &&
                        (it.second.contains("no-cache", ignoreCase = true) || it.second.contains("max-age=0", ignoreCase = true))) ||
                        it.first.equals("pragma", ignoreCase = true)
                }
                if (method == "GET" && path == "/" && !isForceReload && System.currentTimeMillis() < authVerifiedUntil.get()) {
                    val fastHtml = cachedRootHtml
                    if (fastHtml != null) {
                        writeHttpResponse(
                            output,
                            200,
                            "OK",
                            listOf(
                                "Content-Type" to "text/html; charset=utf-8",
                                "Cache-Control" to "no-cache",
                            ),
                            fastHtml,
                            keepAlive = keepAlive,
                        )
                        if (System.currentTimeMillis() - cachedRootAt > 15_000L) {
                            scope.launch(Dispatchers.IO) { runCatching { refreshRootHtml() } }
                        }
                        if (!keepAlive) break
                        continue
                    }
                }

                val body = readRequestBody(input, rawHeaders)
                val fwdHeaders = forwardHeaders(rawHeaders, HOP_HEADERS)
                val isNavGet = method.equals("GET", ignoreCase = true) && isNavigation(rawHeaders)
                var pairedCookies: List<String> = emptyList()
                val response = try {
                    if (isNavGet && System.currentTimeMillis() >= authVerifiedUntil.get()) {
                        coroutineScope {
                            val respJob = async { upstream.fetch(path, method, fwdHeaders, body) }
                            val pairJob = async { autoPair(fwdHeaders) }
                            val fetched = respJob.await()
                            val ct = fetched.headers
                                .firstOrNull { it.first.equals("content-type", ignoreCase = true) }
                                ?.second.orEmpty()
                            pairedCookies = if (ct.contains("text/html", ignoreCase = true)) {
                                pairJob.await()
                            } else {
                                pairJob.cancel()
                                emptyList()
                            }
                            fetched
                        }
                    } else {
                        upstream.fetch(path, method, fwdHeaders, body)
                    }
                } catch (t: Throwable) {
                    val msg = ("对端设备的 T3 没有响应：${t.message ?: "连接失败"}").toByteArray(Charsets.UTF_8)
                    writeHttpResponse(
                        output,
                        502,
                        "Bad Gateway",
                        listOf("Content-Type" to "text/plain; charset=utf-8"),
                        msg,
                        keepAlive = false,
                    )
                    break
                }

                if (response.status == 401 || response.status == 403) {
                    authVerifiedUntil.set(0L)
                    cachedRootHtml = null
                }

                val outHeaders = responseHeaders(response.headers)
                val contentType = response.headers.firstOrNull { it.first.equals("content-type", ignoreCase = true) }?.second.orEmpty()
                val isHtml = contentType.contains("text/html", ignoreCase = true)
                for (cookie in pairedCookies) {
                    outHeaders.add("Set-Cookie" to cookie)
                }
                val setCookies = outHeaders.filter { it.first.equals("set-cookie", ignoreCase = true) }.map { it.second }
                if (setCookies.isNotEmpty()) {
                    onSetCookies(origin, setCookies)
                }
                val finalBody = if (method.equals("GET", ignoreCase = true) && isHtml) {
                    val rawHtmlText = String(response.body, Charsets.UTF_8)
                    val finalHtmlBytes = injectHtml(rawHtmlText).toByteArray(Charsets.UTF_8)
                    if (response.status in 200..299) {
                        assetCache?.let { cache ->
                            scope.launch(Dispatchers.IO) { cache.prefetchFromHtml(rawHtmlText, upstream) }
                        }
                        if (path == "/" && System.currentTimeMillis() < authVerifiedUntil.get()) {
                            cachedRootHtml = finalHtmlBytes
                            cachedRootAt = System.currentTimeMillis()
                        }
                    }
                    finalHtmlBytes
                } else {
                    response.body
                }
                writeHttpResponse(
                    output,
                    response.status,
                    response.statusText.ifBlank { "OK" },
                    outHeaders,
                    finalBody,
                    keepAlive = keepAlive,
                )
                if (!keepAlive) break
            }
            runCatching { socket.close() }
        } catch (_: Throwable) {
            runCatching { socket.close() }
        }
    }

    private fun isNavigation(headers: List<Pair<String, String>>): Boolean {
        val dest = headers.firstOrNull { it.first.equals("sec-fetch-dest", ignoreCase = true) }?.second
        if (dest != null) return dest == "document" || dest == "iframe"
        val accept = headers.firstOrNull { it.first.equals("accept", ignoreCase = true) }?.second.orEmpty()
        return accept.contains("text/html", ignoreCase = true)
    }

    private suspend fun autoPair(fwdHeaders: List<Pair<String, String>>): List<String> {
        val now = System.currentTimeMillis()
        if (now < authVerifiedUntil.get()) return emptyList()
        if (now - pairFailedAt < PAIR_RETRY_MS) return emptyList()
        return try {
            val hasExistingCookie = fwdHeaders.any {
                it.first.equals("cookie", ignoreCase = true) && it.second.isNotBlank()
            }
            if (hasExistingCookie) {
                val session = upstream.fetch("/api/auth/session", "GET", fwdHeaders, null)
                if (session.status in 200..299) {
                    val jsonObj = Json.parseToJsonElement(String(session.body, Charsets.UTF_8)).jsonObject
                    if (jsonObj["authenticated"]?.jsonPrimitive?.booleanOrNull == true) {
                        authVerifiedUntil.set(System.currentTimeMillis() + AUTH_CACHE_MS)
                        return emptyList()
                    }
                }
            }

            val credential = upstream.pairCredential() ?: error("没有拿到配对凭据")
            val payload = """{"credential":"${credential.replace("\"", "\\\"")}"}""".toByteArray(Charsets.UTF_8)
            val paired = upstream.fetch(
                "/api/auth/browser-session",
                "POST",
                listOf("Content-Type" to "application/json", "Origin" to VIRTUAL_ORIGIN),
                payload,
            )
            if (paired.status !in 200..299) error("换取登录失败 ${paired.status}")
            authVerifiedUntil.set(System.currentTimeMillis() + AUTH_CACHE_MS)
            val result = ArrayList<String>()
            for ((k, v) in paired.headers) {
                if (k.equals("set-cookie", ignoreCase = true)) {
                    prefixSetCookie(v, cookiePrefix)?.let { result.add(it) }
                }
            }
            result
        } catch (_: Throwable) {
            pairFailedAt = System.currentTimeMillis()
            emptyList()
        }
    }

    private fun forwardHeaders(
        source: List<Pair<String, String>>,
        skip: Set<String>,
    ): List<Pair<String, String>> {
        val out = ArrayList<Pair<String, String>>()
        val cookies = ArrayList<String>()
        for ((key, value) in source) {
            val lower = key.lowercase()
            if (skip.contains(lower)) continue
            if (lower == "cookie") {
                val stripped = stripCookiePrefix(value, cookiePrefix)
                if (stripped.isNotEmpty()) cookies.add(stripped)
                continue
            }
            if ((lower == "origin" || lower == "referer") && value.startsWith(origin)) {
                out.add(key to (VIRTUAL_ORIGIN + value.substring(origin.length)))
                continue
            }
            out.add(key to value)
        }
        if (cookies.isNotEmpty()) {
            out.add("Cookie" to cookies.joinToString("; "))
        }
        return out
    }

    private fun responseHeaders(source: List<Pair<String, String>>): MutableList<Pair<String, String>> {
        val out = ArrayList<Pair<String, String>>()
        for ((key, value) in source) {
            val lower = key.lowercase()
            if (HOP_HEADERS.contains(lower) || lower == "content-encoding" || lower == "x-frame-options") continue
            if (lower == "set-cookie") {
                prefixSetCookie(value, cookiePrefix)?.let { out.add("Set-Cookie" to it) }
                continue
            }
            if (lower == "content-security-policy") {
                stripFrameAncestors(value)?.let { out.add(key to it) }
                continue
            }
            if (lower == "location" && value.startsWith(VIRTUAL_ORIGIN)) {
                out.add(key to (origin + value.substring(VIRTUAL_ORIGIN.length)))
                continue
            }
            out.add(key to value)
        }
        return out
    }

    private class WsRelayState {
        var opened = false
        val pending = ArrayList<Any>()
    }

    private suspend fun handleWebSocket(
        socket: Socket,
        input: BufferedInputStream,
        output: OutputStream,
        path: String,
        rawHeaders: List<Pair<String, String>>,
    ) {
        val wsKey = rawHeaders.firstOrNull { it.first.equals("sec-websocket-key", ignoreCase = true) }?.second?.trim()
        if (wsKey.isNullOrEmpty()) {
            writeHttpResponse(
                output,
                400,
                "Bad Request",
                emptyList(),
                "Missing Sec-WebSocket-Key".toByteArray(),
                keepAlive = false,
            )
            socket.close()
            return
        }
        val accept = Base64Url.encodeStd(
            MessageDigest.getInstance("SHA-1").digest((wsKey + WS_MAGIC).toByteArray(Charsets.UTF_8)),
        )
        val handshake = buildString {
            append("HTTP/1.1 101 Switching Protocols\r\n")
            append("Upgrade: websocket\r\n")
            append("Connection: Upgrade\r\n")
            append("Sec-WebSocket-Accept: $accept\r\n\r\n")
        }
        synchronized(output) {
            output.write(handshake.toByteArray(Charsets.US_ASCII))
            output.flush()
        }

        socket.soTimeout = 0
        val fwdHeaders = forwardHeaders(rawHeaders, WS_SKIP_HEADERS)
        val wsState = WsRelayState()
        val outChannel = Channel<Pair<Int, ByteArray>>(Channel.UNLIMITED)
        val writerJob = scope.launch(Dispatchers.IO) {
            for ((op, bytes) in outChannel) {
                writeWsFrame(output, op, bytes)
                if (op == 0x8) {
                    runCatching { socket.close() }
                    break
                }
            }
        }
        var remoteWs: UpstreamWs? = null

        val listener = object : UpstreamWsListener {
            override fun onOpen() {
                synchronized(wsState) {
                    wsState.opened = true
                    for (item in wsState.pending) {
                        when (item) {
                            is String -> remoteWs?.sendText(item)
                            is ByteArray -> remoteWs?.sendBinary(item)
                        }
                    }
                    wsState.pending.clear()
                }
            }

            override fun onMessageText(text: String) {
                outChannel.trySend(0x1 to text.toByteArray(Charsets.UTF_8))
            }

            override fun onMessageBinary(bytes: ByteArray) {
                outChannel.trySend(0x2 to bytes)
            }

            override fun onClose(code: Int, reason: String) {
                val reasonBytes = reason.toByteArray(Charsets.UTF_8)
                val payload = ByteBuffer.allocate(2 + reasonBytes.size)
                    .putShort(code.toShort())
                    .put(reasonBytes)
                    .array()
                outChannel.trySend(0x8 to payload)
                outChannel.close()
            }

            override fun onError() {
                outChannel.close()
                runCatching { socket.close() }
            }
        }

        remoteWs = try {
            upstream.openSocket(path, fwdHeaders, listener)
        } catch (_: Throwable) {
            outChannel.close()
            writerJob.cancel()
            runCatching { socket.close() }
            return
        }

        var fragOpcode = -1
        val fragBuffer = ByteArrayOutputStream()
        try {
            while (!socket.isClosed) {
                val frame = readWsFrame(input) ?: break
                when (frame.opcode) {
                    0x8 -> {
                        remoteWs.close(1000, "")
                        break
                    }
                    0x9 -> outChannel.trySend(0xA to frame.payload)
                    0xA -> Unit
                    0x1, 0x2 -> {
                        if (frame.fin) {
                            dispatchClientWsPayload(wsState, remoteWs, frame.opcode, frame.payload)
                        } else {
                            fragOpcode = frame.opcode
                            fragBuffer.reset()
                            fragBuffer.write(frame.payload)
                        }
                    }
                    0x0 -> {
                        if (fragOpcode != -1) {
                            fragBuffer.write(frame.payload)
                            if (frame.fin) {
                                val combined = fragBuffer.toByteArray()
                                val op = fragOpcode
                                fragOpcode = -1
                                fragBuffer.reset()
                                dispatchClientWsPayload(wsState, remoteWs, op, combined)
                            }
                        }
                    }
                }
            }
        } finally {
            outChannel.close()
            writerJob.cancel()
            remoteWs.close(1000, "")
            runCatching { socket.close() }
        }
    }

    private fun dispatchClientWsPayload(
        wsState: WsRelayState,
        remoteWs: UpstreamWs,
        opcode: Int,
        payload: ByteArray,
    ) {
        val msg: Any = if (opcode == 0x1) String(payload, Charsets.UTF_8) else payload
        synchronized(wsState) {
            if (wsState.opened) {
                when (msg) {
                    is String -> remoteWs.sendText(msg)
                    is ByteArray -> remoteWs.sendBinary(msg)
                }
            } else {
                wsState.pending.add(msg)
            }
        }
    }

    private data class WsFrame(val fin: Boolean, val opcode: Int, val payload: ByteArray)

    private fun readWsFrame(input: InputStream): WsFrame? {
        val b0 = input.read()
        if (b0 == -1) return null
        val b1 = input.read()
        if (b1 == -1) return null
        val fin = (b0 and 0x80) != 0
        val opcode = b0 and 0x0f
        val masked = (b1 and 0x80) != 0
        var len = (b1 and 0x7f).toLong()
        if (len == 126L) {
            val hi = input.read()
            val lo = input.read()
            if (hi == -1 || lo == -1) return null
            len = ((hi shl 8) or lo).toLong()
        } else if (len == 127L) {
            val buf = readExact(input, 8) ?: return null
            len = ByteBuffer.wrap(buf).long
        }
        if (len < 0 || len > 16 * 1024 * 1024) return null
        val mask = if (masked) (readExact(input, 4) ?: return null) else null
        val payload = readExact(input, len.toInt()) ?: return null
        if (mask != null) {
            for (i in payload.indices) {
                payload[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()
            }
        }
        return WsFrame(fin, opcode, payload)
    }

    private fun writeWsFrame(output: OutputStream, opcode: Int, payload: ByteArray) {
        try {
            synchronized(output) {
                output.write(0x80 or (opcode and 0x0f))
                val len = payload.size
                when {
                    len <= 125 -> output.write(len)
                    len <= 65535 -> {
                        output.write(126)
                        output.write((len ushr 8) and 0xff)
                        output.write(len and 0xff)
                    }
                    else -> {
                        output.write(127)
                        output.write(ByteBuffer.allocate(8).putLong(len.toLong()).array())
                    }
                }
                output.write(payload)
                output.flush()
            }
        } catch (_: IOException) {
            // 连接已关闭
        }
    }

    private fun readHttpHead(input: InputStream): Triple<String, String, List<Pair<String, String>>>? {
        val headerBytes = ByteArrayOutputStream()
        var matched = 0
        while (true) {
            val b = input.read()
            if (b == -1) return null
            headerBytes.write(b)
            if (headerBytes.size() > 64 * 1024) return null
            matched = when (matched) {
                0 -> if (b == '\r'.code) 1 else 0
                1 -> if (b == '\n'.code) 2 else if (b == '\r'.code) 1 else 0
                2 -> if (b == '\r'.code) 3 else 0
                3 -> if (b == '\n'.code) 4 else if (b == '\r'.code) 1 else 0
                else -> 0
            }
            if (matched == 4) break
        }
        val text = String(headerBytes.toByteArray(), Charsets.ISO_8859_1)
        val lines = text.split("\r\n").filter { it.isNotEmpty() }
        if (lines.isEmpty()) return null
        val reqParts = lines[0].split(' ', limit = 3)
        if (reqParts.size < 2) return null
        val method = reqParts[0].uppercase()
        val rawTarget = reqParts[1]
        val path = if (rawTarget.startsWith("http://") || rawTarget.startsWith("https://")) {
            val uri = java.net.URI(rawTarget)
            (uri.rawPath.ifEmpty { "/" }) + (uri.rawQuery?.let { "?$it" } ?: "")
        } else {
            rawTarget
        }
        val headers = ArrayList<Pair<String, String>>()
        for (i in 1 until lines.size) {
            val idx = lines[i].indexOf(':')
            if (idx > 0) {
                headers.add(lines[i].substring(0, idx).trim() to lines[i].substring(idx + 1).trim())
            }
        }
        return Triple(method, path, headers)
    }

    private fun readRequestBody(input: InputStream, headers: List<Pair<String, String>>): ByteArray? {
        val te = headers.firstOrNull { it.first.equals("transfer-encoding", ignoreCase = true) }?.second.orEmpty()
        if (te.contains("chunked", ignoreCase = true)) {
            val out = ByteArrayOutputStream()
            while (true) {
                val sizeLine = readLineCrlf(input) ?: break
                val semi = sizeLine.indexOf(';')
                val hexLen = (if (semi == -1) sizeLine else sizeLine.substring(0, semi)).trim()
                val chunkSize = hexLen.toIntOrNull(16) ?: break
                if (chunkSize == 0) {
                    // consume trailing headers until empty line
                    while (true) {
                        val trailer = readLineCrlf(input) ?: break
                        if (trailer.isEmpty()) break
                    }
                    break
                }
                val chunk = readExact(input, chunkSize) ?: break
                out.write(chunk)
                readLineCrlf(input)
            }
            return out.toByteArray()
        }
        val len = headers.firstOrNull { it.first.equals("content-length", ignoreCase = true) }?.second?.toIntOrNull() ?: 0
        if (len <= 0) return null
        return readExact(input, len)
    }

    private fun readLineCrlf(input: InputStream): String? {
        val buf = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b == -1) return null
            if (b == '\n'.code) break
            if (b != '\r'.code) buf.write(b)
        }
        return String(buf.toByteArray(), Charsets.ISO_8859_1)
    }

    private fun readExact(input: InputStream, count: Int): ByteArray? {
        val buf = ByteArray(count)
        var off = 0
        while (off < count) {
            val n = input.read(buf, off, count - off)
            if (n <= 0) return null
            off += n
        }
        return buf
    }

    private fun writeHttpResponse(
        output: OutputStream,
        status: Int,
        statusText: String,
        headers: List<Pair<String, String>>,
        body: ByteArray,
        keepAlive: Boolean = true,
    ) {
        val sb = StringBuilder()
        sb.append("HTTP/1.1 ").append(status).append(' ').append(statusText).append("\r\n")
        for ((k, v) in headers) {
            sb.append(k).append(": ").append(v).append("\r\n")
        }
        sb.append("Content-Length: ").append(body.size).append("\r\n")
        if (keepAlive) {
            sb.append("Connection: keep-alive\r\nKeep-Alive: timeout=30\r\n\r\n")
        } else {
            sb.append("Connection: close\r\n\r\n")
        }
        synchronized(output) {
            output.write(sb.toString().toByteArray(Charsets.ISO_8859_1))
            if (body.isNotEmpty()) output.write(body)
            output.flush()
        }
    }
}
