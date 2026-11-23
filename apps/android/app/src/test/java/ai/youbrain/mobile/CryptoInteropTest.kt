package ai.youbrain.mobile

import ai.youbrain.mobile.crypto.Base64Url
import ai.youbrain.mobile.crypto.CanonicalJson
import ai.youbrain.mobile.crypto.CommandSigner
import ai.youbrain.mobile.crypto.TunnelCrypto
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 与 packages/protocol (@you-brain/protocol) 直接产出的标准向量做逐字节互通校验。
 */
class CryptoInteropTest {
    private val alicePublicKey = "MCowBQYDK2VwAyEAnLeQolJzmu3ueYuNeHCH5xJ9e4SqEIMXao6_uqW8KC0"
    private val alicePrivateKey = "MC4CAQAwBQYDK2VwBCIEIHAipPtyzDzcsnsPyeCDGkp1IzY7KK-xiUB-L9kuWTGv"
    private val aliceSeedB64u = "cCKk-3LMPNyyew_J4IMaSnUjNjsor7GJQH4v2S5ZMa8"

    private val bobPublicKey = "MCowBQYDK2VwAyEAsY6k4d-Dm_lK7uG_xZ8A-AWXrD2HjdYMQIERtVo0dgc"
    private val bobPrivateKey = "MC4CAQAwBQYDK2VwBCIEIApctGqhSkMTMc7Z2Ltw6cOQWPF_zELJ-RE_siZlm-Z1"

    private val cmdId = "cmd_01JXYZ0001"
    private val from = "android-dev-1"
    private val to = "vps-master-1"
    private val ts = 1763850000000L
    private val nonce = "nonce_abc_123"

    private val cmdElement = buildJsonObject {
        put("kind", "agent.send")
        put("project", "you-brain")
        put("prompt", "你好，派发任务")
        put("sessionId", "sess-01")
        put("mode", "queue")
        put(
            "nested",
            buildJsonObject {
                put("z", 1)
                put(
                    "a",
                    buildJsonArray {
                        add(JsonPrimitive(true))
                        add(JsonNull)
                        add(JsonPrimitive("x"))
                    },
                )
            },
        )
    }

    private val expectedCanonical =
        """{"kind":"agent.send","mode":"queue","nested":{"a":[true,null,"x"],"z":1},"project":"you-brain","prompt":"你好，派发任务","sessionId":"sess-01"}"""

    private val expectedSigningString =
        "u-brain-cmd/1\ncmd_01JXYZ0001\nandroid-dev-1\nvps-master-1\n1763850000000\nnonce_abc_123\na1911a03dcbec489557a6d7b7fe6c3f973d1fc23c83bd76913e2747cbe6244bc"

    private val expectedCmdSig =
        "aU8sKgro5K2PXL-YkChKUr8ykoBfXrBq9eMFrlSCiRY7o9yxRq2UoOHJ5KvAktmejB4jGmPtYf1dS05Ue6W9AQ"

    private val sid = "sid_01JXYZ0002"
    private val initXPrivRaw = "961OBmOnUrYNeHJ6lubFU_w90F9YSd0hKEKqae4qvpg"
    private val initXPub = "v2HzAzcl-Y2p9Ab1RcAu2Rh3vZs2t7hs4Qd1Q6AI2U0"
    private val respXPrivRaw = "3w0gyem2unGtWXGp6j1TcvK6E7ZsPaNnnhfW5jyC65M"
    private val respXPub = "dG0BQPoVpEvWoUKWo8LXCQ4_AmpFCBTNvy9gmsH36VI"

    private val expectedTranscript =
        "u-brain-tunnel/1\nsid_01JXYZ0002\nandroid-dev-1\nvps-master-1\nv2HzAzcl-Y2p9Ab1RcAu2Rh3vZs2t7hs4Qd1Q6AI2U0\ndG0BQPoVpEvWoUKWo8LXCQ4_AmpFCBTNvy9gmsH36VI"
    private val expectedInitSig =
        "2nIuPS1Gs2PGhP70rf_KutCaD_1U65p-9XwVZwqKnyWVMVMj1jyqcLjYWlUPYbNz8DG5vxOzc6Z_V3jXFCa-Cw"
    private val expectedRespSig =
        "2dL4dy21FfWPy0zTYC_i6nWKTHzWal6AYc6wJHxhIbvZZrqWT_BY8bu_kLjhzNcLj_9bdmew_0Go7Fl_FXUoCA"

    private val expectedInitSealed0 =
        "AAAAAAAAAAD2TE60mPKt3zwbhRPqgfgFvabsch3xELCqNrtZwu2pcjqU4zo"
    private val expectedInitSealed1 =
        "AAAAAAAAAAEKd75JVKj1fRLY1nUKbQbGWhaK5bY"
    private val expectedRespSealed0 =
        "AAAAAAAAAABOmJa8Y3Dp3lsySzOxLT1Tz7G-GFqCZq679ucEw7Sxak7rRhwlJy09e2JnInUivtzjNLZOAlwhOw"

    @Test
    fun canonicalJsonAndCommandSigningMatchesProtocolExactly() {
        assertEquals(expectedCanonical, CanonicalJson.stringify(cmdElement))
        assertEquals(expectedSigningString, CommandSigner.signingString(cmdId, from, to, ts, nonce, cmdElement))
        assertEquals(alicePublicKey, CommandSigner.derivePublicKeyFromSeed(alicePrivateKey))
        assertEquals(alicePublicKey, CommandSigner.derivePublicKeyFromSeed(aliceSeedB64u))

        // PKCS8 与 32 字节 raw seed 两种格式都必须生成与 Node crypto 完全一致的签名
        assertEquals(expectedCmdSig, CommandSigner.signCommand(alicePrivateKey, cmdId, from, to, ts, nonce, cmdElement))
        assertEquals(expectedCmdSig, CommandSigner.signCommand(aliceSeedB64u, cmdId, from, to, ts, nonce, cmdElement))

        assertTrue(CommandSigner.verifyCommand(alicePublicKey, cmdId, from, to, ts, nonce, cmdElement, expectedCmdSig))
        assertFalse(CommandSigner.verifyCommand(bobPublicKey, cmdId, from, to, ts, nonce, cmdElement, expectedCmdSig))

        val tamperedCmd = Json.parseToJsonElement(expectedCanonical.replace("queue", "run"))
        assertFalse(CommandSigner.verifyCommand(alicePublicKey, cmdId, from, to, ts, nonce, tamperedCmd, expectedCmdSig))
        assertFalse(CommandSigner.verifyCommand(alicePublicKey, cmdId, from, to, ts + 1, nonce, cmdElement, expectedCmdSig))
    }

    @Test
    fun tunnelTranscriptSignaturesAndCipherVectorsMatchProtocol() {
        val transcript = TunnelCrypto.tunnelTranscript(sid, from, to, initXPub, respXPub)
        assertEquals(expectedTranscript, transcript)

        assertEquals(expectedInitSig, CommandSigner.signText(alicePrivateKey, transcript))
        assertEquals(expectedRespSig, CommandSigner.signText(bobPrivateKey, transcript))
        assertTrue(TunnelCrypto.verifyTranscript(alicePublicKey, transcript, expectedInitSig))
        assertTrue(TunnelCrypto.verifyTranscript(bobPublicKey, transcript, expectedRespSig))
        assertFalse(TunnelCrypto.verifyTranscript(alicePublicKey, transcript, expectedRespSig))

        val initPriv = X25519PrivateKeyParameters(Base64Url.decode(initXPrivRaw), 0)
        val respPriv = X25519PrivateKeyParameters(Base64Url.decode(respXPrivRaw), 0)

        val initCipher = TunnelCrypto.deriveCipher(initPriv, respXPub, sid, role = "initiator")
        val respCipher = TunnelCrypto.deriveCipher(respPriv, initXPub, sid, role = "responder")

        // deterministic counter=0/1 + deterministic nonceOf(header) 应逐字节一致
        assertEquals(expectedInitSealed0, initCipher.seal("hello from initiator".toByteArray(Charsets.UTF_8)))
        assertEquals(expectedInitSealed1, initCipher.seal(byteArrayOf(0, 1, 2, -2, -1)))

        val f0 = respCipher.open(expectedInitSealed0)
        assertEquals(0L, f0.counter)
        assertEquals("hello from initiator", String(f0.plaintext, Charsets.UTF_8))

        val f1 = respCipher.open(expectedInitSealed1)
        assertEquals(1L, f1.counter)
        assertArrayEquals(byteArrayOf(0, 1, 2, -2, -1), f1.plaintext)

        val r0 = initCipher.open(expectedRespSealed0)
        assertEquals(0L, r0.counter)
        assertEquals("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok", String(r0.plaintext, Charsets.UTF_8))

        // 篡改任一字节都必须被 GCM 认证标签拒绝
        val raw = Base64Url.decode(expectedRespSealed0)
        raw[raw.size - 1] = (raw[raw.size - 1].toInt() xor 0x01).toByte()
        val corrupted = Base64Url.encode(raw)
        assertThrows(Exception::class.java) {
            initCipher.open(corrupted)
        }
    }

    @Test
    fun freshKeyPairAndEphemeralRoundtrip() {
        val id = CommandSigner.generateIdentity()
        assertEquals(id.publicKey, CommandSigner.derivePublicKeyFromSeed(id.privateSeed))
        val sig = CommandSigner.signCommand(id.privateSeed, "c1", "d1", "d2", 123L, "n1", cmdElement)
        assertTrue(CommandSigner.verifyCommand(id.publicKey, "c1", "d1", "d2", 123L, "n1", cmdElement, sig))

        val a = TunnelCrypto.newEphemeral()
        val b = TunnelCrypto.newEphemeral()
        val cA = TunnelCrypto.deriveCipher(a.privateKey, b.publicKey, "sid-roundtrip", role = "initiator")
        val cB = TunnelCrypto.deriveCipher(b.privateKey, a.publicKey, "sid-roundtrip", role = "responder")

        val payload = "双向端到端加密消息 🚀".toByteArray(Charsets.UTF_8)
        val sealed = cA.seal(payload)
        val opened = cB.open(sealed)
        assertEquals(0L, opened.counter)
        assertArrayEquals(payload, opened.plaintext)

        val reply = cB.seal("ack".toByteArray(Charsets.UTF_8))
        assertEquals("ack", String(cA.open(reply).plaintext, Charsets.UTF_8))
    }
}
