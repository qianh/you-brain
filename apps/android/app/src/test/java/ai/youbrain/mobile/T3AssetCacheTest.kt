package ai.youbrain.mobile

import ai.youbrain.mobile.net.T3AssetCache
import ai.youbrain.mobile.net.T3Upstream
import ai.youbrain.mobile.net.TunnelHttpResponse
import ai.youbrain.mobile.net.UpstreamWs
import ai.youbrain.mobile.net.UpstreamWsListener
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.nio.file.Files
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class T3AssetCacheTest {
    private class StubAssetUpstream(
        private val files: Map<String, Pair<String, ByteArray>>,
        private val delayMs: Long = 0L,
    ) : T3Upstream {
        val hits = ConcurrentHashMap<String, AtomicInteger>()

        override suspend fun fetch(
            path: String,
            method: String,
            headers: List<Pair<String, String>>,
            body: ByteArray?,
            target: String?,
        ): TunnelHttpResponse {
            hits.computeIfAbsent(path) { AtomicInteger(0) }.incrementAndGet()
            if (delayMs > 0) delay(delayMs)
            val entry = files[path]
                ?: return TunnelHttpResponse(404, "Not Found", emptyList(), ByteArray(0))
            return TunnelHttpResponse(
                status = 200,
                statusText = "OK",
                headers = listOf("Content-Type" to entry.first),
                body = entry.second,
            )
        }

        override suspend fun openSocket(
            path: String,
            headers: List<Pair<String, String>>,
            listener: UpstreamWsListener,
            target: String?,
        ): UpstreamWs = throw UnsupportedOperationException()

        override suspend fun pairCredential(): String? = null
    }

    @Test
    fun isImmutableAssetPathAndMimeInference() {
        assertTrue(T3AssetCache.isImmutableAssetPath("/assets/index-Bf8EyXcJ.js"))
        assertTrue(T3AssetCache.isImmutableAssetPath("/assets/main-bddhXQeo.css"))
        assertTrue(T3AssetCache.isImmutableAssetPath("/assets/inter-latin-wght-normal-Dx4kXJAl.woff2"))
        assertTrue(T3AssetCache.isImmutableAssetPath("/assets/nested/chunk-Ab12Cd34.wasm"))

        assertFalse(T3AssetCache.isImmutableAssetPath("/assets/app.js"))
        assertFalse(T3AssetCache.isImmutableAssetPath("/assets/index-Bf8EyXcJ.js?v=1"))
        assertFalse(T3AssetCache.isImmutableAssetPath("/assets/../secret-123456.js"))
        assertFalse(T3AssetCache.isImmutableAssetPath("/index.html"))

        val jsMime = T3AssetCache.inferMimeAndEncoding("/assets/index-Bf8EyXcJ.js")
        assertEquals("text/javascript", jsMime.mimeType)
        assertEquals("utf-8", jsMime.encoding)
        assertEquals("text/javascript; charset=utf-8", jsMime.contentTypeHeader)

        val cssMime = T3AssetCache.inferMimeAndEncoding("/assets/main-bddhXQeo.css")
        assertEquals("text/css", cssMime.mimeType)
        assertEquals("utf-8", cssMime.encoding)

        val fontMime = T3AssetCache.inferMimeAndEncoding("/assets/inter-latin-Dx4kXJAl.woff2")
        assertEquals("font/woff2", fontMime.mimeType)
        assertNull(fontMime.encoding)
    }

    @Test
    fun extractsViteMapDepsAndCssFontAssets() {
        val sample = """
            <html><head>
            <script type="module" crossorigin src="/assets/index-Bf8EyXcJ.js"></script>
            </head></html>
            const __vite__mapDeps=(i,d=(m.f=["assets/main-BN8wt5wy.js","assets/rolldown-runtime-COiEfhsA.js"]));
            @font-face{src:url(/assets/inter-latin-wght-normal-Dx4kXJAl.woff2) format("woff2")}
        """.trimIndent()

        val extracted = T3AssetCache.extractImmutableAssetPaths(sample)
        assertEquals(
            listOf(
                "/assets/index-Bf8EyXcJ.js",
                "/assets/main-BN8wt5wy.js",
                "/assets/rolldown-runtime-COiEfhsA.js",
                "/assets/inter-latin-wght-normal-Dx4kXJAl.woff2",
            ),
            extracted,
        )
    }

    @Test
    fun getOrFetchPersistsToDiskDeduplicatesInflightAndRejectsHtmlFallback() {
        val dir = Files.createTempDirectory("t3-cache-test-").toFile()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            val cache1 = T3AssetCache(dir, scope)
            val upstream = StubAssetUpstream(
                files = mapOf(
                    "/assets/main-BN8wt5wy.js" to ("text/javascript" to "console.log('ok');".toByteArray()),
                    "/assets/missing-Ab12Cd34.js" to ("text/html; charset=utf-8" to "<html>fallback</html>".toByteArray()),
                ),
                delayMs = 40L,
            )

            runBlocking {
                // 5 路并发同一个哈希资源只应回源拉取 1 次
                val results = (1..5).map {
                    async(Dispatchers.IO) { cache1.getOrFetch("/assets/main-BN8wt5wy.js", upstream) }
                }.awaitAll()
                assertTrue(results.all { it != null && String(it.bytes) == "console.log('ok');" })
                assertEquals(1, upstream.hits["/assets/main-BN8wt5wy.js"]?.get())

                // text/html 回退页绝不能污染静态资源缓存
                val htmlFallback = cache1.getOrFetch("/assets/missing-Ab12Cd34.js", upstream)
                assertNull(htmlFallback)
                assertFalse(cache1.hasCached("/assets/missing-Ab12Cd34.js"))
            }

            // 模拟重新启动 App：全新 T3AssetCache 实例直接从磁盘命中（全设备共享，不再走网络）
            val cache2 = T3AssetCache(dir, scope)
            val diskHit = cache2.getCached("/assets/main-BN8wt5wy.js")
            assertNotNull(diskHit)
            assertEquals("console.log('ok');", String(diskHit!!.bytes))
            assertEquals("text/javascript", diskHit.mime.mimeType)
        } finally {
            scope.cancel()
            dir.deleteRecursively()
        }
    }

    @Test
    fun prefetchFromHtmlWarmsEntryAndTransitiveChunksInParallel() {
        val dir = Files.createTempDirectory("t3-prefetch-test-").toFile()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            val cache = T3AssetCache(dir, scope)
            val entryJs = """const __vite__mapDeps=["assets/main-BN8wt5wy.js","assets/main-bddhXQeo.css"];"""
            val mainJs = """export const ok = true;"""
            val mainCss = """@font-face{src:url(/assets/inter-latin-Dx4kXJAl.woff2)}"""
            val fontBytes = byteArrayOf(1, 2, 3, 4)

            val upstream = StubAssetUpstream(
                files = mapOf(
                    "/assets/index-Bf8EyXcJ.js" to ("text/javascript" to entryJs.toByteArray()),
                    "/assets/main-BN8wt5wy.js" to ("text/javascript" to mainJs.toByteArray()),
                    "/assets/main-bddhXQeo.css" to ("text/css" to mainCss.toByteArray()),
                    "/assets/inter-latin-Dx4kXJAl.woff2" to ("font/woff2" to fontBytes),
                ),
            )
            val html = """<!doctype html><html><head><script type="module" src="/assets/index-Bf8EyXcJ.js"></script></head></html>"""

            runBlocking {
                cache.prefetchFromHtml(html, upstream)
            }

            assertTrue(cache.hasCached("/assets/index-Bf8EyXcJ.js"))
            assertTrue(cache.hasCached("/assets/main-BN8wt5wy.js"))
            assertTrue(cache.hasCached("/assets/main-bddhXQeo.css"))
            assertTrue(cache.hasCached("/assets/inter-latin-Dx4kXJAl.woff2"))
            assertEquals(1, upstream.hits["/assets/index-Bf8EyXcJ.js"]?.get())
            assertEquals(1, upstream.hits["/assets/main-BN8wt5wy.js"]?.get())
            assertEquals(1, upstream.hits["/assets/main-bddhXQeo.css"]?.get())
            assertEquals(1, upstream.hits["/assets/inter-latin-Dx4kXJAl.woff2"]?.get())
        } finally {
            scope.cancel()
            dir.deleteRecursively()
        }
    }

    @Test
    fun loadSeedZipLoadsIndexHtmlAndImmutableAssetsIntoMemory() {
        val dir = Files.createTempDirectory("t3-seed-test-").toFile()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
        try {
            val zipBytes = ByteArrayOutputStream().use { bos ->
                ZipOutputStream(bos).use { zos ->
                    zos.putNextEntry(ZipEntry("index.html"))
                    zos.write("<html><head></head><body>seed</body></html>".toByteArray())
                    zos.closeEntry()

                    zos.putNextEntry(ZipEntry("assets/index-Bf8EyXcJ.js"))
                    zos.write("console.log('seed-js');".toByteArray())
                    zos.closeEntry()

                    zos.putNextEntry(ZipEntry("assets/main-bddhXQeo.css"))
                    zos.write("body{color:red}".toByteArray())
                    zos.closeEntry()
                }
                bos.toByteArray()
            }

            val cache = T3AssetCache(dir, scope)
            cache.loadSeedZipAsync { ByteArrayInputStream(zipBytes) }

            val jsAsset = cache.getCached("/assets/index-Bf8EyXcJ.js")
            assertNotNull(jsAsset)
            assertEquals("console.log('seed-js');", String(jsAsset!!.bytes))
            assertEquals("text/javascript", jsAsset.mime.mimeType)

            val cssAsset = cache.getCached("/assets/main-bddhXQeo.css")
            assertNotNull(cssAsset)
            assertEquals("text/css", cssAsset!!.mime.mimeType)

            assertTrue(cache.seedIndexHtml?.contains("<body>seed</body>") == true)
        } finally {
            scope.cancel()
            dir.deleteRecursively()
        }
    }
}
