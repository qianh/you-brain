package ai.youbrain.mobile.crypto

import kotlinx.serialization.json.JsonElement
import org.bouncycastle.crypto.params.Ed25519PrivateKeyParameters
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import java.security.SecureRandom

data class Ed25519Identity(
    /** 32 字节原始私钥种子（base64url） */
    val privateSeed: String,
    /** SPKI DER 公钥（base64url，形如 MCowBQYDK2VwAyEA...） */
    val publicKey: String,
) {
    fun shortFingerprint(): String =
        Base64Url.sha256Hex(Base64Url.decode(publicKey)).take(12)
}

/**
 * u-brain-cmd/1 指令签名与验签（严格对齐 packages/protocol/src/dispatch.ts）。
 */
object CommandSigner {
    const val PROTOCOL_VERSION = 1

    // ASN.1 SPKI DER 前缀：30 2a 30 05 06 03 2b 65 70 03 21 00
    private val ED25519_SPKI_PREFIX = byteArrayOf(
        0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
    )

    // ASN.1 PKCS8 DER 前缀：30 2e 02 01 00 30 05 06 03 2b 65 70 04 22 04 20
    private val ED25519_PKCS8_PREFIX = byteArrayOf(
        0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
    )

    fun generateIdentity(): Ed25519Identity {
        val priv = Ed25519PrivateKeyParameters(SecureRandom())
        val pub = priv.generatePublicKey()
        return Ed25519Identity(
            privateSeed = Base64Url.encode(priv.encoded),
            publicKey = encodeSpkiPublicKey(pub.encoded),
        )
    }

    fun derivePublicKeyFromSeed(seedB64: String): String {
        val priv = parsePrivateKey(seedB64)
        return encodeSpkiPublicKey(priv.generatePublicKey().encoded)
    }

    fun signingString(
        cmdId: String,
        from: String,
        to: String,
        ts: Long,
        nonce: String,
        cmd: JsonElement,
    ): String {
        val digest = Base64Url.sha256Hex(CanonicalJson.stringify(cmd).toByteArray(Charsets.UTF_8))
        return listOf(
            "u-brain-cmd/$PROTOCOL_VERSION",
            cmdId,
            from,
            to,
            ts.toString(),
            nonce,
            digest,
        ).joinToString("\n")
    }

    fun signCommand(
        privateKeyOrSeedB64: String,
        cmdId: String,
        from: String,
        to: String,
        ts: Long,
        nonce: String,
        cmd: JsonElement,
    ): String {
        val text = signingString(cmdId, from, to, ts, nonce, cmd)
        return signText(privateKeyOrSeedB64, text)
    }

    fun verifyCommand(
        spkiPublicKeyB64: String,
        cmdId: String,
        from: String,
        to: String,
        ts: Long,
        nonce: String,
        cmd: JsonElement,
        sigB64: String,
    ): Boolean {
        return try {
            val text = signingString(cmdId, from, to, ts, nonce, cmd)
            verifyText(spkiPublicKeyB64, text, sigB64)
        } catch (_: Throwable) {
            false
        }
    }

    fun signText(privateKeyOrSeedB64: String, text: String): String {
        val priv = parsePrivateKey(privateKeyOrSeedB64)
        val signer = Ed25519Signer()
        signer.init(true, priv)
        val payload = text.toByteArray(Charsets.UTF_8)
        signer.update(payload, 0, payload.size)
        return Base64Url.encode(signer.generateSignature())
    }

    fun verifyText(spkiPublicKeyB64: String, text: String, sigB64: String): Boolean {
        return try {
            val pub = parsePublicKey(spkiPublicKeyB64)
            val sig = Base64Url.decode(sigB64)
            val signer = Ed25519Signer()
            signer.init(false, pub)
            val payload = text.toByteArray(Charsets.UTF_8)
            signer.update(payload, 0, payload.size)
            signer.verifySignature(sig)
        } catch (_: Throwable) {
            false
        }
    }

    private fun encodeSpkiPublicKey(raw32: ByteArray): String {
        require(raw32.size == 32) { "Ed25519 公钥长度必须为 32 字节" }
        return Base64Url.encode(ED25519_SPKI_PREFIX + raw32)
    }

    private fun parsePublicKey(spkiB64: String): Ed25519PublicKeyParameters {
        val der = Base64Url.decode(spkiB64)
        require(der.size == ED25519_SPKI_PREFIX.size + 32) { "无效的 Ed25519 SPKI 公钥长度" }
        for (i in ED25519_SPKI_PREFIX.indices) {
            require(der[i] == ED25519_SPKI_PREFIX[i]) { "无效的 Ed25519 SPKI 公钥头" }
        }
        return Ed25519PublicKeyParameters(der, ED25519_SPKI_PREFIX.size)
    }

    private fun parsePrivateKey(privateKeyOrSeedB64: String): Ed25519PrivateKeyParameters {
        val raw = Base64Url.decode(privateKeyOrSeedB64)
        return when (raw.size) {
            32 -> Ed25519PrivateKeyParameters(raw, 0)
            ED25519_PKCS8_PREFIX.size + 32 -> {
                for (i in ED25519_PKCS8_PREFIX.indices) {
                    require(raw[i] == ED25519_PKCS8_PREFIX[i]) { "无效的 Ed25519 PKCS8 私钥" }
                }
                Ed25519PrivateKeyParameters(raw, ED25519_PKCS8_PREFIX.size)
            }
            else -> throw IllegalArgumentException("无效的 Ed25519 私钥长度: ${raw.size}")
        }
    }
}
