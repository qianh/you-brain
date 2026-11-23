package ai.youbrain.mobile.crypto

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

object Base64Url {
    private val urlEncoder = Base64.getUrlEncoder().withoutPadding()
    private val urlDecoder = Base64.getUrlDecoder()
    private val stdEncoder = Base64.getEncoder()
    private val stdDecoder = Base64.getDecoder()
    private val random = SecureRandom()

    fun encode(bytes: ByteArray): String = urlEncoder.encodeToString(bytes)

    fun decode(value: String): ByteArray = urlDecoder.decode(value)

    fun encodeStd(bytes: ByteArray): String = stdEncoder.encodeToString(bytes)

    fun decodeStd(value: String): ByteArray = stdDecoder.decode(value)

    fun sha256Hex(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        val out = StringBuilder(digest.size * 2)
        for (b in digest) {
            val v = b.toInt() and 0xff
            if (v < 0x10) out.append('0')
            out.append(v.toString(16))
        }
        return out.toString()
    }

    fun newNonce(byteCount: Int = 16): String {
        val bytes = ByteArray(byteCount)
        random.nextBytes(bytes)
        return encode(bytes)
    }
}
