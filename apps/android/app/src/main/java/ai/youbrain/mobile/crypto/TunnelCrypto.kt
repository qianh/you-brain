package ai.youbrain.mobile.crypto

import org.bouncycastle.crypto.agreement.X25519Agreement
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

data class TunnelEphemeral(
    val publicKey: String,
    val privateKey: X25519PrivateKeyParameters,
)

data class OpenedFrame(
    val counter: Long,
    val plaintext: ByteArray,
)

/**
 * 端到端加密 T3 隧道密码学实现（对齐 packages/protocol/src/tunnel.ts）：
 * X25519 + HKDF-SHA256 + AES-256-GCM（12 字节 nonce = 4 零字节 || 8 字节大端计数器，header 作 AAD）。
 */
class TunnelCipher(
    private val sendKey: ByteArray,
    private val recvKey: ByteArray,
) {
    private var counter: Long = 0L

    @Synchronized
    fun seal(plaintext: ByteArray): String {
        val current = counter++
        val header = ByteBuffer.allocate(8).order(ByteOrder.BIG_ENDIAN).putLong(current).array()
        val nonce = ByteArray(12)
        System.arraycopy(header, 0, nonce, 4, 8)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(sendKey, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(header)
        val bodyAndTag = cipher.doFinal(plaintext)
        val frame = ByteArray(8 + bodyAndTag.size)
        System.arraycopy(header, 0, frame, 0, 8)
        System.arraycopy(bodyAndTag, 0, frame, 8, bodyAndTag.size)
        return Base64Url.encode(frame)
    }

    @Synchronized
    fun open(data: String): OpenedFrame {
        val bytes = Base64Url.decode(data)
        require(bytes.size >= 8 + 16) { "隧道帧太短" }
        val header = bytes.copyOfRange(0, 8)
        val frameCounter = ByteBuffer.wrap(header).order(ByteOrder.BIG_ENDIAN).long
        val nonce = ByteArray(12)
        System.arraycopy(header, 0, nonce, 4, 8)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(recvKey, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD(header)
        val plaintext = cipher.doFinal(bytes, 8, bytes.size - 8)
        return OpenedFrame(counter = frameCounter, plaintext = plaintext)
    }
}

object TunnelCrypto {
    const val CHUNK_BYTES = 64 * 1024
    const val RELAY_FRAME_MAX = 160 * 1024
    private val INFO_BYTES = "u-brain-t3-tunnel/1".toByteArray(Charsets.UTF_8)

    fun newEphemeral(): TunnelEphemeral {
        val priv = X25519PrivateKeyParameters(SecureRandom())
        val pub = priv.generatePublicKey()
        return TunnelEphemeral(
            publicKey = Base64Url.encode(pub.encoded),
            privateKey = priv,
        )
    }

    fun tunnelTranscript(
        sid: String,
        initiator: String,
        responder: String,
        initiatorKey: String,
        responderKey: String,
    ): String = listOf(
        "u-brain-tunnel/1",
        sid,
        initiator,
        responder,
        initiatorKey,
        responderKey,
    ).joinToString("\n")

    fun verifyTranscript(
        spkiPublicKeyB64: String,
        transcript: String,
        sigB64: String,
    ): Boolean = CommandSigner.verifyText(spkiPublicKeyB64, transcript, sigB64)

    fun deriveCipher(
        privateKey: X25519PrivateKeyParameters,
        peerPublicKeyB64: String,
        sid: String,
        role: String = "initiator",
    ): TunnelCipher {
        val peerRaw = Base64Url.decode(peerPublicKeyB64)
        require(peerRaw.size == 32) { "无效的 X25519 临时公钥" }
        val peerPub = X25519PublicKeyParameters(peerRaw, 0)
        val agreement = X25519Agreement()
        agreement.init(privateKey)
        val shared = ByteArray(agreement.agreementSize)
        agreement.calculateAgreement(peerPub, shared, 0)

        val keys = hkdfSha256(
            ikm = shared,
            salt = sid.toByteArray(Charsets.UTF_8),
            info = INFO_BYTES,
            length = 64,
        )
        val forward = keys.copyOfRange(0, 32)
        val backward = keys.copyOfRange(32, 64)
        return if (role == "initiator") {
            TunnelCipher(sendKey = forward, recvKey = backward)
        } else {
            TunnelCipher(sendKey = backward, recvKey = forward)
        }
    }

    fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        val actualSalt = if (salt.isEmpty()) ByteArray(32) else salt
        val prk = hmacSha256(actualSalt, ikm)
        val out = ByteArray(length)
        var t = ByteArray(0)
        var offset = 0
        var counter = 1
        while (offset < length) {
            val mac = Mac.getInstance("HmacSHA256")
            mac.init(SecretKeySpec(prk, "HmacSHA256"))
            mac.update(t)
            mac.update(info)
            mac.update(counter.toByte())
            t = mac.doFinal()
            val copyLen = minOf(t.size, length - offset)
            System.arraycopy(t, 0, out, offset, copyLen)
            offset += copyLen
            counter += 1
        }
        return out
    }

    private fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(key, "HmacSHA256"))
        return mac.doFinal(data)
    }
}
