package ai.youbrain.mobile.net

import ai.youbrain.mobile.crypto.Base64Url
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 绑定 127.0.0.1 的本地终端代理服务器：
 * - 同源提供离线打包的 xterm.js 终端页面与脚本资源（零外网依赖、无 CORS 问题）。
 * - 将 `/ws?deviceId=...` 的 WebSocket 流量直接桥接到对端加密隧道的 `target = "tty7"` `/api/deck/tty7/terminal`。
 */
class LocalTty7TerminalServer(
    private val scope: CoroutineScope,
    private val loadAsset: (name: String) -> ByteArray?,
    private val openRemoteTerminal: suspend (deviceId: String, listener: UpstreamWsListener) -> UpstreamWs,
) {
    private val serverSocket: ServerSocket
    val port: Int
    val origin: String
    private val stopped = AtomicBoolean(false)
    private var acceptJob: Job? = null

    companion object {
        private const val WS_MAGIC = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        private val ASSET_MIMES = mapOf(
            "/" to ("index.html" to "text/html; charset=utf-8"),
            "/index.html" to ("index.html" to "text/html; charset=utf-8"),
            "/xterm.js" to ("xterm.js" to "application/javascript; charset=utf-8"),
            "/xterm.css" to ("xterm.css" to "text/css; charset=utf-8"),
            "/addon-fit.js" to ("addon-fit.js" to "application/javascript; charset=utf-8"),
        )
    }

    init {
        val loopback = InetAddress.getByName("127.0.0.1")
        serverSocket = ServerSocket(0, 32, loopback)
        port = serverSocket.localPort
        origin = "http://127.0.0.1:$port"
        acceptJob = scope.launch(Dispatchers.IO) {
            while (isActive && !stopped.get()) {
                val client = try {
                    serverSocket.accept()
                } catch (_: IOException) {
                    break
                }
                launch(Dispatchers.IO) {
                    handleClient(client)
                }
            }
        }
    }

    fun terminalPageUrl(deviceId: String, pane: Int, fontSize: Int, isDark: Boolean): String {
        val encodedDevice = java.net.URLEncoder.encode(deviceId, "UTF-8")
        val theme = if (isDark) "dark" else "light"
        return "$origin/?deviceId=$encodedDevice&pane=$pane&fontSize=$fontSize&theme=$theme"
    }

    fun stop() {
        if (!stopped.compareAndSet(false, true)) return
        acceptJob?.cancel()
        runCatching { serverSocket.close() }
    }

    private suspend fun handleClient(socket: Socket) {
        try {
            socket.tcpNoDelay = true
            socket.soTimeout = 15_000
            val input = BufferedInputStream(socket.getInputStream())
            val output = socket.getOutputStream()

            while (!stopped.get() && !socket.isClosed) {
                val head = readHttpHead(input) ?: break
                val (method, rawPath, headers) = head
                val upgrade = headers.firstOrNull { it.first.equals("upgrade", ignoreCase = true) }?.second
                if (upgrade.equals("websocket", ignoreCase = true)) {
                    handleWebSocket(socket, input, output, rawPath, headers)
                    return
                }
                if (method != "GET") {
                    writeHttp(output, 405, "Method Not Allowed", "text/plain; charset=utf-8", "Method Not Allowed".toByteArray(), keepAlive = false)
                    break
                }
                val pathOnly = rawPath.substringBefore('?')
                val assetEntry = ASSET_MIMES[pathOnly]
                val body = assetEntry?.let { loadAsset(it.first) }
                if (assetEntry == null || body == null) {
                    writeHttp(output, 404, "Not Found", "text/plain; charset=utf-8", "Not Found".toByteArray(), keepAlive = false)
                    break
                }
                val keepAlive = !headers.any {
                    it.first.equals("connection", ignoreCase = true) && it.second.contains("close", ignoreCase = true)
                }
                writeHttp(output, 200, "OK", assetEntry.second, body, keepAlive = keepAlive)
                if (!keepAlive) break
            }
        } catch (_: Throwable) {
            // 连接关闭或异常退出
        } finally {
            runCatching { socket.close() }
        }
    }

    private class WsState {
        var opened = false
        val pending = ArrayList<Any>()
    }

    private suspend fun handleWebSocket(
        socket: Socket,
        input: InputStream,
        output: OutputStream,
        rawPath: String,
        headers: List<Pair<String, String>>,
    ) {
        val wsKey = headers.firstOrNull { it.first.equals("sec-websocket-key", ignoreCase = true) }?.second
        val deviceId = parseQueryParam(rawPath, "deviceId")
        if (wsKey.isNullOrBlank() || deviceId.isNullOrBlank()) {
            writeHttp(output, 400, "Bad Request", "text/plain; charset=utf-8", "Bad Request".toByteArray(), keepAlive = false)
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

        val wsState = WsState()
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
        fun flushPending() {
            val up = remoteWs ?: return
            val batch: List<Any>
            synchronized(wsState) {
                if (!wsState.opened || wsState.pending.isEmpty()) return
                batch = ArrayList(wsState.pending)
                wsState.pending.clear()
            }
            for (item in batch) {
                when (item) {
                    is String -> up.sendText(item)
                    is ByteArray -> up.sendBinary(item)
                }
            }
        }

        val listener = object : UpstreamWsListener {
            override fun onOpen() {
                synchronized(wsState) { wsState.opened = true }
                flushPending()
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
            openRemoteTerminal(deviceId, listener)
        } catch (t: Throwable) {
            val errObj = buildJsonObject {
                put("type", "error")
                put("message", t.message ?: "无法连接对端终端")
            }
            val errJson = Json.encodeToString(kotlinx.serialization.json.JsonObject.serializer(), errObj)
            outChannel.trySend(0x1 to errJson.toByteArray(Charsets.UTF_8))
            outChannel.close()
            writerJob.join()
            return
        }
        flushPending()

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
                            forwardClientPayload(wsState, remoteWs, frame.opcode, frame.payload)
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
                                forwardClientPayload(wsState, remoteWs, op, combined)
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

    private fun forwardClientPayload(
        wsState: WsState,
        remoteWs: UpstreamWs,
        opcode: Int,
        payload: ByteArray,
    ) {
        val item: Any = if (opcode == 0x1) String(payload, Charsets.UTF_8) else payload
        synchronized(wsState) {
            if (wsState.opened) {
                when (item) {
                    is String -> remoteWs.sendText(item)
                    is ByteArray -> remoteWs.sendBinary(item)
                }
            } else {
                wsState.pending.add(item)
            }
        }
    }

    private fun parseQueryParam(rawPath: String, key: String): String? {
        val query = rawPath.substringAfter('?', "")
        if (query.isEmpty()) return null
        for (pair in query.split('&')) {
            val idx = pair.indexOf('=')
            val k = if (idx == -1) pair else pair.substring(0, idx)
            if (k == key) {
                val rawVal = if (idx == -1) "" else pair.substring(idx + 1)
                return runCatching { URLDecoder.decode(rawVal, "UTF-8") }.getOrDefault(rawVal)
            }
        }
        return null
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
        val path = reqParts[1]
        val headers = ArrayList<Pair<String, String>>()
        for (i in 1 until lines.size) {
            val idx = lines[i].indexOf(':')
            if (idx > 0) {
                headers.add(lines[i].substring(0, idx).trim() to lines[i].substring(idx + 1).trim())
            }
        }
        return Triple(method, path, headers)
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

    private fun writeHttp(
        output: OutputStream,
        status: Int,
        statusText: String,
        contentType: String,
        body: ByteArray,
        keepAlive: Boolean,
    ) {
        val sb = StringBuilder()
        sb.append("HTTP/1.1 ").append(status).append(' ').append(statusText).append("\r\n")
        sb.append("Content-Type: ").append(contentType).append("\r\n")
        sb.append("Cache-Control: no-cache\r\n")
        sb.append("Content-Length: ").append(body.size).append("\r\n")
        if (keepAlive) {
            sb.append("Connection: keep-alive\r\n\r\n")
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
