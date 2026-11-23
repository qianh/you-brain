package ai.youbrain.mobile.net

import ai.youbrain.mobile.crypto.Base64Url
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withTimeoutOrNull
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.zip.ZipInputStream

data class AssetMime(
    val mimeType: String,
    val encoding: String?,
    val contentTypeHeader: String,
)

data class CachedAsset(
    val path: String,
    val bytes: ByteArray,
    val mime: AssetMime,
)

/**
 * 跨设备共享的 T3 内容寻址静态资源（/assets/<name>-<hash>.<ext>）缓存与预拉取器：
 * - 文件名带不可变构建哈希，同版本 T3 在所有设备上字节完全一致；任意一台拉过即全设备通用。
 * - 先内存 LRU，再磁盘持久化；发现 Vite mapDeps 与 CSS 字体表后按并发信号量（20）一次性铺平预拉取。
 */
class T3AssetCache(
    private val cacheDir: File,
    private val scope: CoroutineScope,
) {
    companion object {
        private const val MAX_MEM_BYTES = 24 * 1024 * 1024L
        private const val MAX_SINGLE_MEM_BYTES = 8 * 1024 * 1024L
        private const val PRUNE_TRIGGER_FILES = 450
        private const val PRUNE_KEEP_FILES = 350

        private val IMMUTABLE_PATH_RE = Regex(
            "^/assets/.+-[A-Za-z0-9_-]{6,}\\.(?:js|mjs|css|woff2|woff|ttf|otf|wasm|svg|png|webp|jpg|jpeg|gif|ico)$",
            RegexOption.IGNORE_CASE,
        )

        private val EXTRACT_PATH_RE = Regex(
            """(?:^|["'(`=\s])(/?assets/[A-Za-z0-9._/-]+-[A-Za-z0-9_-]{6,}\.(?:js|mjs|css|woff2|woff|ttf|otf|wasm|svg|png|webp|jpg|jpeg|gif|ico))""",
            RegexOption.IGNORE_CASE,
        )

        fun isImmutableAssetPath(rawPath: String): Boolean {
            if (rawPath.contains('?') || rawPath.contains('#') || rawPath.contains("..")) return false
            return IMMUTABLE_PATH_RE.matches(rawPath)
        }

        fun inferMimeAndEncoding(path: String): AssetMime {
            val clean = path.substringBefore('?').substringBefore('#').lowercase()
            return when {
                clean.endsWith(".js") || clean.endsWith(".mjs") ->
                    AssetMime("text/javascript", "utf-8", "text/javascript; charset=utf-8")
                clean.endsWith(".css") ->
                    AssetMime("text/css", "utf-8", "text/css; charset=utf-8")
                clean.endsWith(".svg") ->
                    AssetMime("image/svg+xml", "utf-8", "image/svg+xml; charset=utf-8")
                clean.endsWith(".json") ->
                    AssetMime("application/json", "utf-8", "application/json; charset=utf-8")
                clean.endsWith(".wasm") ->
                    AssetMime("application/wasm", null, "application/wasm")
                clean.endsWith(".woff2") ->
                    AssetMime("font/woff2", null, "font/woff2")
                clean.endsWith(".woff") ->
                    AssetMime("font/woff", null, "font/woff")
                clean.endsWith(".ttf") ->
                    AssetMime("font/ttf", null, "font/ttf")
                clean.endsWith(".otf") ->
                    AssetMime("font/otf", null, "font/otf")
                clean.endsWith(".png") ->
                    AssetMime("image/png", null, "image/png")
                clean.endsWith(".webp") ->
                    AssetMime("image/webp", null, "image/webp")
                clean.endsWith(".jpg") || clean.endsWith(".jpeg") ->
                    AssetMime("image/jpeg", null, "image/jpeg")
                clean.endsWith(".gif") ->
                    AssetMime("image/gif", null, "image/gif")
                clean.endsWith(".ico") ->
                    AssetMime("image/x-icon", null, "image/x-icon")
                else ->
                    AssetMime("application/octet-stream", null, "application/octet-stream")
            }
        }

        fun extractImmutableAssetPaths(text: String): List<String> {
            val out = LinkedHashSet<String>()
            for (match in EXTRACT_PATH_RE.findAll(text)) {
                val raw = match.groupValues[1]
                val normalized = if (raw.startsWith("/")) raw else "/$raw"
                if (isImmutableAssetPath(normalized)) {
                    out.add(normalized)
                }
            }
            return out.toList()
        }
    }

    private val memLock = Any()
    private val memLru = LinkedHashMap<String, CachedAsset>(128, 0.75f, true)
    private var memBytes = 0L

    private val inflight = ConcurrentHashMap<String, CompletableDeferred<CachedAsset?>>()
    private val prefetchingKeys = ConcurrentHashMap.newKeySet<String>()
    private val pruning = AtomicBoolean(false)
    // 限制后台预拉取并发度，避免挤占实时认证、页面请求与 T3 WebSocket 的隧道帧窗口
    private val prefetchSemaphore = Semaphore(4)

    @Volatile
    var seedIndexHtml: String? = null
        private set

    @Volatile
    private var seedJob: Job? = null

    init {
        cacheDir.mkdirs()
    }

    fun loadSeedZipAsync(openStream: () -> InputStream?) {
        if (seedJob != null) return
        seedJob = scope.launch(Dispatchers.IO) {
            runCatching {
                openStream()?.use { stream ->
                    ZipInputStream(stream).use { zis ->
                        val buf = ByteArray(16 * 1024)
                        while (true) {
                            val entry = zis.nextEntry ?: break
                            if (entry.isDirectory) {
                                zis.closeEntry()
                                continue
                            }
                            val name = entry.name.trimStart('/')
                            val out = ByteArrayOutputStream(maxOf(1024, entry.size.toInt().coerceAtLeast(1024)))
                            while (true) {
                                val n = zis.read(buf)
                                if (n <= 0) break
                                out.write(buf, 0, n)
                            }
                            val bytes = out.toByteArray()
                            zis.closeEntry()
                            if (name == "index.html") {
                                seedIndexHtml = String(bytes, Charsets.UTF_8)
                            } else {
                                val assetPath = "/$name"
                                if (isImmutableAssetPath(assetPath) && bytes.isNotEmpty()) {
                                    putMem(
                                        CachedAsset(
                                            path = assetPath,
                                            bytes = bytes,
                                            mime = inferMimeAndEncoding(assetPath),
                                        ),
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    suspend fun awaitSeed() {
        val job = seedJob
        if (job != null && job.isActive) {
            withTimeoutOrNull(400L) { job.join() }
        }
    }

    private fun diskFile(path: String): File {
        val hex = Base64Url.sha256Hex(path.toByteArray(Charsets.UTF_8))
        return File(cacheDir, "$hex.bin")
    }

    private fun putMem(asset: CachedAsset) {
        if (asset.bytes.size > MAX_SINGLE_MEM_BYTES) return
        synchronized(memLock) {
            val prev = memLru.remove(asset.path)
            if (prev != null) memBytes -= prev.bytes.size.toLong()
            memLru[asset.path] = asset
            memBytes += asset.bytes.size.toLong()
            val it = memLru.entries.iterator()
            while (memBytes > MAX_MEM_BYTES && it.hasNext()) {
                val entry = it.next()
                memBytes -= entry.value.bytes.size.toLong()
                it.remove()
            }
        }
    }

    fun getCached(path: String): CachedAsset? {
        if (!isImmutableAssetPath(path)) return null
        synchronized(memLock) {
            memLru[path]?.let { return it }
        }
        val job = seedJob
        if (job != null && job.isActive) {
            runBlocking {
                withTimeoutOrNull(250L) { job.join() }
            }
            synchronized(memLock) {
                memLru[path]?.let { return it }
            }
        }
        val file = diskFile(path)
        if (!file.isFile || file.length() <= 0L) return null
        val bytes = runCatching { file.readBytes() }.getOrNull() ?: return null
        if (bytes.isEmpty()) return null
        runCatching { file.setLastModified(System.currentTimeMillis()) }
        val asset = CachedAsset(path = path, bytes = bytes, mime = inferMimeAndEncoding(path))
        putMem(asset)
        return asset
    }

    fun hasCached(path: String): Boolean {
        if (!isImmutableAssetPath(path)) return false
        synchronized(memLock) {
            if (memLru.containsKey(path)) return true
        }
        val file = diskFile(path)
        return file.isFile && file.length() > 0L
    }

    private fun writeDisk(path: String, bytes: ByteArray) {
        runCatching {
            cacheDir.mkdirs()
            val target = diskFile(path)
            val tmp = File(cacheDir, "${target.name}.${System.nanoTime()}.tmp")
            tmp.writeBytes(bytes)
            if (!tmp.renameTo(target)) {
                tmp.copyTo(target, overwrite = true)
                tmp.delete()
            }
        }
        schedulePruneIfNeeded()
    }

    private fun schedulePruneIfNeeded() {
        val list = cacheDir.list() ?: return
        if (list.size <= PRUNE_TRIGGER_FILES) return
        if (!pruning.compareAndSet(false, true)) return
        scope.launch(Dispatchers.IO) {
            try {
                val files = cacheDir.listFiles { f -> f.isFile && f.name.endsWith(".bin") } ?: return@launch
                if (files.size <= PRUNE_TRIGGER_FILES) return@launch
                val sorted = files.sortedBy { it.lastModified() }
                val toDelete = sorted.size - PRUNE_KEEP_FILES
                for (i in 0 until toDelete) {
                    runCatching { sorted[i].delete() }
                }
            } finally {
                pruning.set(false)
            }
        }
    }

    suspend fun getOrFetch(path: String, upstream: T3Upstream): CachedAsset? {
        if (!isImmutableAssetPath(path)) return null
        getCached(path)?.let { return it }

        val created = CompletableDeferred<CachedAsset?>()
        val existing = inflight.putIfAbsent(path, created)
        if (existing != null) {
            return existing.await()
        }

        return try {
            val resp = upstream.fetch(path, "GET", emptyList(), null)
            val ct = resp.headers
                .firstOrNull { it.first.equals("content-type", ignoreCase = true) }
                ?.second.orEmpty()
            if (resp.status == 200 && resp.body.isNotEmpty() && !ct.contains("text/html", ignoreCase = true)) {
                val asset = CachedAsset(
                    path = path,
                    bytes = resp.body,
                    mime = inferMimeAndEncoding(path),
                )
                writeDisk(path, resp.body)
                putMem(asset)
                created.complete(asset)
                asset
            } else {
                created.complete(null)
                null
            }
        } catch (t: Throwable) {
            created.complete(null)
            null
        } finally {
            inflight.remove(path, created)
        }
    }

    suspend fun prefetchFromHtml(html: String, upstream: T3Upstream) {
        val entryPaths = extractImmutableAssetPaths(html)
        if (entryPaths.isEmpty()) return
        val key = entryPaths.joinToString("|")
        if (!prefetchingKeys.add(key)) return

        try {
            val entryAssets = coroutineScope {
                entryPaths.map { p ->
                    async(Dispatchers.IO) {
                        prefetchSemaphore.withPermit {
                            runCatching { getOrFetch(p, upstream) }.getOrNull()
                        }
                    }
                }.awaitAll().filterNotNull()
            }

            val secondary = LinkedHashSet<String>()
            for (asset in entryAssets) {
                if (asset.mime.encoding != null && (asset.path.endsWith(".js", true) || asset.path.endsWith(".mjs", true) || asset.path.endsWith(".css", true))) {
                    val text = String(asset.bytes, Charsets.UTF_8)
                    for (sub in extractImmutableAssetPaths(text)) {
                        if (!hasCached(sub)) {
                            secondary.add(sub)
                        }
                    }
                }
            }
            if (secondary.isEmpty()) return

            val fetchedSecondary = coroutineScope {
                secondary.map { p ->
                    async(Dispatchers.IO) {
                        prefetchSemaphore.withPermit {
                            runCatching { getOrFetch(p, upstream) }.getOrNull()
                        }
                    }
                }.awaitAll().filterNotNull()
            }

            val cssLeaves = LinkedHashSet<String>()
            for (asset in fetchedSecondary) {
                if (asset.path.endsWith(".css", ignoreCase = true)) {
                    val cssText = String(asset.bytes, Charsets.UTF_8)
                    for (sub in extractImmutableAssetPaths(cssText)) {
                        if (!hasCached(sub)) {
                            cssLeaves.add(sub)
                        }
                    }
                }
            }
            if (cssLeaves.isNotEmpty()) {
                coroutineScope {
                    cssLeaves.map { p ->
                        async(Dispatchers.IO) {
                            prefetchSemaphore.withPermit {
                                runCatching { getOrFetch(p, upstream) }
                            }
                        }
                    }.awaitAll()
                }
            }
        } finally {
            prefetchingKeys.remove(key)
        }
    }
}
