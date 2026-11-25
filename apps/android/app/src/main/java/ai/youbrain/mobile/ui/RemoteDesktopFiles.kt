package ai.youbrain.mobile.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.SystemClock
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Base64
import androidx.core.content.FileProvider
import java.io.ByteArrayInputStream
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.util.UUID
import java.util.concurrent.Executors
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

data class RdTransferItem(
    val id: String,
    val name: String,
    val size: Long,
    val transferred: Long,
    val upload: Boolean,
    /** queued / active / done / error / cancelled */
    val status: String,
    val message: String? = null,
)

data class RdRemoteFile(val path: String, val name: String, val size: Long)

/**
 * 远程桌面 `file` 数据通道的原生侧：上传读源、下载落盘、剪贴板图片收发。
 * 二进制数据经 WebView 里的 JS 搬运（base64），JS 回调运行在 JavaBridge 线程，
 * 这里所有状态都在 [lock] 内修改，调用 JS 一律切回主线程。
 */
class RdFileTransfers(
    private val context: Context,
    private val mainHandler: Handler,
    private val onItems: (List<RdTransferItem>) -> Unit,
    private val onMessage: (String) -> Unit,
) {
    private class Job(
        var item: RdTransferItem,
        val path: String? = null,
        val dest: String? = null,
        val open: (() -> InputStream)? = null,
        val clipboardImage: Boolean = false,
        val hidden: Boolean = false,
        val onDone: ((String?) -> Unit)? = null,
    ) {
        var input: InputStream? = null
        var output: OutputStream? = null
        var outputUri: Uri? = null
        var outputFile: File? = null
    }

    private val lock = Any()
    private val json = Json { ignoreUnknownKeys = true }
    private val io = Executors.newSingleThreadExecutor()
    private val jobs = ArrayList<Job>()
    private var uploading: Job? = null
    private var downloading: Job? = null
    private var js: ((String) -> Unit)? = null
    private var lastEmitMs = 0L

    /** 远端剪贴板图片写入本机后的 URI，用于本机剪贴板监听时跳过回声。 */
    @Volatile
    var lastClipboardImageUri: Uri? = null
        private set

    /** 文件通道已打开：绑定 JS 执行器并开始排队的任务。 */
    fun attach(evalJs: (String) -> Unit) {
        synchronized(lock) { js = evalJs }
        pump()
    }

    /** 会话断开：未完成的任务全部失败。 */
    fun detach(reason: String) {
        val callbacks = ArrayList<Pair<Job, String>>()
        synchronized(lock) {
            js = null
            for (job in jobs) {
                if (job.item.status == "queued" || job.item.status == "active") {
                    closeJob(job, deletePartial = true)
                    job.item = job.item.copy(status = "error", message = reason)
                    callbacks.add(job to reason)
                }
            }
            uploading = null
            downloading = null
            pruneHidden()
        }
        callbacks.forEach { (job, msg) -> job.onDone?.invoke(msg) }
        emit(force = true)
    }

    fun shutdown() {
        detach("已退出远程桌面")
        io.shutdown()
    }

    fun clearFinished() {
        synchronized(lock) {
            jobs.removeAll { it.item.status == "done" || it.item.status == "error" || it.item.status == "cancelled" }
        }
        emit(force = true)
    }

    fun cancel(id: String) {
        val job: Job
        synchronized(lock) {
            job = jobs.firstOrNull { it.item.id == id } ?: return
            if (job.item.status != "queued" && job.item.status != "active") return
            val wasActive = job.item.status == "active"
            closeJob(job, deletePartial = true)
            job.item = job.item.copy(status = "cancelled")
            if (uploading === job) uploading = null
            if (downloading === job) downloading = null
            if (wasActive) runJs("window.__rdFileCancel && window.__rdFileCancel(${q(id)});")
        }
        job.onDone?.invoke("已取消")
        emit(force = true)
        pump()
    }

    // ---- 上传 ----

    /** 从文件选择器上传到远端「下载」文件夹。 */
    fun uploadUris(uris: List<Uri>) {
        io.execute {
            for (uri in uris) {
                val (name, size) = queryNameAndSize(uri)
                if (size < 0) {
                    onMessage("无法读取「$name」的大小，已跳过")
                    continue
                }
                enqueueUpload(name, size, dest = null, open = {
                    context.contentResolver.openInputStream(uri) ?: error("无法打开文件")
                })
            }
        }
    }

    /** 把本机图片写进远端剪贴板；完成回调参数为 null 表示成功。 */
    fun uploadClipboardImage(uri: Uri, onDone: (String?) -> Unit) {
        io.execute {
            val bytes = runCatching {
                context.contentResolver.openInputStream(uri)?.use { readLimited(it, RD_CLIPBOARD_IMAGE_MAX_BYTES) }
            }.getOrElse { err ->
                mainHandler.post { onDone(err.message ?: "读取图片失败") }
                return@execute
            }
            if (bytes == null || bytes.isEmpty()) {
                mainHandler.post { onDone("读取图片失败") }
                return@execute
            }
            val mime = context.contentResolver.getType(uri).orEmpty()
            val name = if (mime == "image/png") "clipboard.png" else "clipboard"
            enqueueUpload(name, bytes.size.toLong(), dest = "clipboard", hidden = true, open = { ByteArrayInputStream(bytes) }) { err ->
                mainHandler.post { onDone(err) }
            }
        }
    }

    private fun enqueueUpload(
        name: String,
        size: Long,
        dest: String?,
        hidden: Boolean = false,
        open: () -> InputStream,
        onDone: ((String?) -> Unit)? = null,
    ) {
        val item = RdTransferItem(newId(), name, size, 0, upload = true, status = "queued")
        synchronized(lock) { jobs.add(Job(item, dest = dest, open = open, hidden = hidden, onDone = onDone)) }
        emit(force = true)
        pump()
    }

    /** JS 拉取下一段上传数据：返回 base64；空串表示结束；以 `!` 开头表示出错。 */
    fun readUploadChunk(id: String): String {
        synchronized(lock) {
            val job = uploading ?: return "!上传已取消"
            if (job.item.id != id || job.item.status != "active") return "!上传已取消"
            return try {
                val input = job.input ?: job.open!!.invoke().also { job.input = it }
                val buf = ByteArray(UPLOAD_READ_BYTES)
                var filled = 0
                while (filled < buf.size) {
                    val n = input.read(buf, filled, buf.size - filled)
                    if (n < 0) break
                    filled += n
                }
                if (filled == 0) "" else Base64.encodeToString(buf, 0, filled, Base64.NO_WRAP)
            } catch (err: Throwable) {
                "!" + (err.message ?: "读取文件失败")
            }
        }
    }

    // ---- 下载 ----

    fun download(file: RdRemoteFile) {
        val item = RdTransferItem(newId(), file.name, file.size, 0, upload = false, status = "queued")
        synchronized(lock) { jobs.add(Job(item, path = file.path)) }
        emit(force = true)
        pump()
    }

    /** 取回远端剪贴板图片并写进本机剪贴板。 */
    fun fetchClipboardImage(onDone: (String?) -> Unit) {
        val item = RdTransferItem(newId(), "clipboard.png", 0, 0, upload = false, status = "queued")
        synchronized(lock) {
            // 同一时间只保留一个待取的剪贴板图片
            jobs.removeAll { it.clipboardImage && it.item.status == "queued" }
            jobs.add(Job(item, path = RD_CLIPBOARD_IMAGE_PATH, clipboardImage = true, hidden = true, onDone = { err ->
                mainHandler.post { onDone(err) }
            }))
        }
        pump()
    }

    fun onDownloadChunk(id: String, b64: String) {
        var failed: Job? = null
        synchronized(lock) {
            val job = downloading ?: return
            if (job.item.id != id || job.item.status != "active") return
            val out = job.output ?: return
            try {
                val bytes = Base64.decode(b64, Base64.DEFAULT)
                out.write(bytes)
                job.item = job.item.copy(transferred = job.item.transferred + bytes.size)
            } catch (err: Throwable) {
                failJob(job, err.message ?: "写入文件失败", notifyHost = true)
                failed = job
            }
        }
        val job = failed
        if (job == null) {
            emit(force = false)
            return
        }
        job.onDone?.invoke(job.item.message)
        synchronized(lock) { pruneHidden() }
        emit(force = true)
        pump()
    }

    /** `file` 通道上的 JSON 帧。 */
    fun onFileFrame(raw: String) {
        val obj = runCatching { json.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return
        val type = obj.str("t") ?: return
        val id = obj.str("id") ?: return
        var finished: Job? = null
        var result: String? = null
        synchronized(lock) {
            val up = uploading
            if (up != null && up.item.id == id) {
                when (type) {
                    "ack" -> obj["received"]?.jsonPrimitive?.longOrNull?.let {
                        up.item = up.item.copy(transferred = maxOf(up.item.transferred, it))
                    }
                    "saved" -> {
                        closeJob(up, deletePartial = false)
                        up.item = up.item.copy(status = "done", transferred = up.item.size, message = obj.str("path"))
                        uploading = null
                        finished = up
                    }
                    "error" -> {
                        closeJob(up, deletePartial = false)
                        result = obj.str("message") ?: "上传失败"
                        up.item = up.item.copy(status = "error", message = result)
                        uploading = null
                        finished = up
                    }
                }
                return@synchronized
            }
            val down = downloading
            if (down == null || down.item.id != id) return@synchronized
            when (type) {
                "meta" -> {
                    val name = obj.str("name")?.takeIf { it.isNotBlank() } ?: down.item.name
                    val size = obj["size"]?.jsonPrimitive?.longOrNull ?: down.item.size
                    down.item = down.item.copy(name = name, size = size)
                    try {
                        openTarget(down)
                    } catch (err: Throwable) {
                        result = err.message ?: "无法创建本地文件"
                        failJob(down, result!!, notifyHost = true)
                        finished = down
                    }
                }
                "done" -> {
                    try {
                        finishTarget(down)
                        down.item = down.item.copy(status = "done", transferred = down.item.size)
                    } catch (err: Throwable) {
                        result = err.message ?: "保存失败"
                        closeJob(down, deletePartial = true)
                        down.item = down.item.copy(status = "error", message = result)
                    }
                    downloading = null
                    finished = down
                }
                "error" -> {
                    result = obj.str("message") ?: "下载失败"
                    closeJob(down, deletePartial = true)
                    down.item = down.item.copy(status = "error", message = result)
                    downloading = null
                    finished = down
                }
            }
        }
        finished?.let { job ->
            job.onDone?.invoke(if (job.item.status == "done") null else (result ?: job.item.message ?: "传输失败"))
            if (!job.hidden && !job.item.upload && job.item.status == "done") {
                onMessage("已保存「${job.item.name}」到${job.item.message ?: "下载"}")
            }
            synchronized(lock) { pruneHidden() }
            emit(force = true)
            pump()
        } ?: emit(force = type == "meta")
    }

    // ---- 内部 ----

    private fun pump() {
        synchronized(lock) {
            if (js == null) return
            if (uploading == null) {
                jobs.firstOrNull { it.item.upload && it.item.status == "queued" }?.let { job ->
                    job.item = job.item.copy(status = "active")
                    uploading = job
                    val dest = job.dest?.let { q(it) } ?: "null"
                    runJs("window.__rdFilePut && window.__rdFilePut(${q(job.item.id)}, ${q(job.item.name)}, ${job.item.size}, $dest);")
                }
            }
            if (downloading == null) {
                jobs.firstOrNull { !it.item.upload && it.item.status == "queued" }?.let { job ->
                    job.item = job.item.copy(status = "active")
                    downloading = job
                    runJs("window.__rdFileGet && window.__rdFileGet(${q(job.item.id)}, ${q(job.path.orEmpty())});")
                }
            }
        }
        emit(force = true)
    }

    private fun openTarget(job: Job) {
        if (job.clipboardImage) {
            val dir = File(context.cacheDir, "rd-clipboard").apply { mkdirs() }
            dir.listFiles()?.forEach { it.delete() }
            val file = File(dir, "remote-${System.currentTimeMillis()}.png")
            job.outputFile = file
            job.output = file.outputStream().buffered()
            return
        }
        val name = job.item.name.ifBlank { "file" }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.RELATIVE_PATH, "${Environment.DIRECTORY_DOWNLOADS}/U-Brain")
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val uri = context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
                ?: error("无法在下载目录创建文件")
            job.outputUri = uri
            job.output = context.contentResolver.openOutputStream(uri) ?: error("无法写入下载目录")
            job.item = job.item.copy(message = "「下载/U-Brain」")
        } else {
            val dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS) ?: File(context.filesDir, "downloads")
            dir.mkdirs()
            var file = File(dir, name)
            var n = 1
            while (file.exists()) {
                val dot = name.lastIndexOf('.')
                file = if (dot > 0) File(dir, "${name.substring(0, dot)} ($n)${name.substring(dot)}") else File(dir, "$name ($n)")
                n += 1
            }
            job.outputFile = file
            job.output = file.outputStream().buffered()
            job.item = job.item.copy(message = "应用下载目录")
        }
    }

    private fun finishTarget(job: Job) {
        job.output?.flush()
        job.output?.close()
        job.output = null
        if (job.clipboardImage) {
            val file = job.outputFile ?: error("图片未保存")
            if (file.length() == 0L) error("远端剪贴板图片为空")
            val uri = FileProvider.getUriForFile(context, "${context.packageName}.rdfiles", file)
            lastClipboardImageUri = uri
            mainHandler.post {
                val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                cm?.setPrimaryClip(ClipData.newUri(context.contentResolver, "U-Brain 远端图片", uri))
            }
            return
        }
        job.outputUri?.let { uri ->
            val values = ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }
            context.contentResolver.update(uri, values, null, null)
        }
    }

    private fun failJob(job: Job, message: String, notifyHost: Boolean) {
        closeJob(job, deletePartial = true)
        job.item = job.item.copy(status = "error", message = message)
        if (uploading === job) uploading = null
        if (downloading === job) downloading = null
        if (notifyHost) runJs("window.__rdFileCancel && window.__rdFileCancel(${q(job.item.id)});")
    }

    private fun closeJob(job: Job, deletePartial: Boolean) {
        runCatching { job.input?.close() }
        job.input = null
        runCatching { job.output?.close() }
        job.output = null
        if (deletePartial) {
            job.outputUri?.let { uri -> runCatching { context.contentResolver.delete(uri, null, null) } }
            job.outputFile?.let { runCatching { it.delete() } }
            job.outputUri = null
            job.outputFile = null
        }
    }

    private fun pruneHidden() {
        jobs.removeAll { it.hidden && it.item.status != "queued" && it.item.status != "active" }
    }

    private fun emit(force: Boolean) {
        val now = SystemClock.uptimeMillis()
        val snapshot: List<RdTransferItem>
        synchronized(lock) {
            if (!force && now - lastEmitMs < 200L) return
            lastEmitMs = now
            snapshot = jobs.filter { !it.hidden }.map { it.item }
        }
        mainHandler.post { onItems(snapshot) }
    }

    private fun runJs(script: String) {
        val runner = js ?: return
        mainHandler.post { runner(script) }
    }

    private fun queryNameAndSize(uri: Uri): Pair<String, Long> {
        var name = uri.lastPathSegment?.substringAfterLast('/') ?: "file"
        var size = -1L
        runCatching {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)
                ?.use { c ->
                    if (c.moveToFirst()) {
                        val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        val si = c.getColumnIndex(OpenableColumns.SIZE)
                        if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni)
                        if (si >= 0 && !c.isNull(si)) size = c.getLong(si)
                    }
                }
        }
        if (size < 0) {
            size = runCatching {
                context.contentResolver.openAssetFileDescriptor(uri, "r")?.use { it.length }
            }.getOrNull() ?: -1L
        }
        return name to size
    }

    private fun readLimited(input: InputStream, limit: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(64 * 1024)
        while (true) {
            val n = input.read(buf)
            if (n < 0) break
            out.write(buf, 0, n)
            if (out.size() > limit) error("图片超过 20MB，无法写入远端剪贴板")
        }
        return out.toByteArray()
    }

    private fun JsonObject.str(key: String): String? = this[key]?.jsonPrimitive?.contentOrNull

    private fun q(value: String): String = JsonPrimitive(value).toString()

    private fun newId(): String = "a" + UUID.randomUUID().toString().replace("-", "").take(20)

    private companion object {
        const val UPLOAD_READ_BYTES = 256 * 1024
    }
}
