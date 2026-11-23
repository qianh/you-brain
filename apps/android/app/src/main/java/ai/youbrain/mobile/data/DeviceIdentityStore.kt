package ai.youbrain.mobile.data

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import ai.youbrain.mobile.crypto.Base64Url
import ai.youbrain.mobile.crypto.CommandSigner
import ai.youbrain.mobile.crypto.Ed25519Identity
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * 本机设备身份、Ed25519 密钥对与中转设备令牌存储。
 * 使用 Android Keystore AES-256-GCM 密钥对敏感字段（私钥种子与 ubd_ 令牌）加密后落盘。
 */
class DeviceIdentityStore(context: Context) {
    private val prefs = context.getSharedPreferences("ubrain_secure_identity", Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    companion object {
        private const val KEYSTORE_ALIAS = "ubrain_identity_wrap_key"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_SEED_ENC = "ed25519_seed_enc"
        private const val KEY_PUB = "ed25519_pub"
        private const val KEY_TOKEN_ENC = "relay_token_enc"
        private const val KEY_CONFIG = "enrollment_config"
    }

    @Synchronized
    fun getOrCreateDeviceId(): String {
        val existing = prefs.getString(KEY_DEVICE_ID, null)
        if (!existing.isNullOrBlank()) return existing
        val created = "android-" + UUID.randomUUID().toString().replace("-", "").take(16)
        prefs.edit().putString(KEY_DEVICE_ID, created).apply()
        return created
    }

    fun defaultDeviceName(): String {
        val model = (Build.MODEL ?: "Android").replace(Regex("[\\u0000-\\u001f]"), "").trim()
        return (if (model.isEmpty()) "Android" else model).take(40)
    }

    @Synchronized
    fun getOrCreateIdentity(): Ed25519Identity {
        val seedEnc = prefs.getString(KEY_SEED_ENC, null)
        val pub = prefs.getString(KEY_PUB, null)
        if (!seedEnc.isNullOrBlank() && !pub.isNullOrBlank()) {
            val seed = unsealSecret(seedEnc)
            if (!seed.isNullOrBlank()) {
                return Ed25519Identity(privateSeed = seed, publicKey = pub)
            }
        }
        val created = CommandSigner.generateIdentity()
        prefs.edit()
            .putString(KEY_SEED_ENC, sealSecret(created.privateSeed))
            .putString(KEY_PUB, created.publicKey)
            .apply()
        return created
    }

    @Synchronized
    fun saveEnrollment(config: EnrollmentConfig, token: String) {
        prefs.edit()
            .putString(KEY_DEVICE_ID, config.deviceId)
            .putString(KEY_CONFIG, json.encodeToString(config))
            .putString(KEY_TOKEN_ENC, sealSecret(token))
            .apply()
    }

    @Synchronized
    fun getEnrollment(): Pair<EnrollmentConfig, String>? {
        val configRaw = prefs.getString(KEY_CONFIG, null) ?: return null
        val tokenEnc = prefs.getString(KEY_TOKEN_ENC, null) ?: return null
        val token = unsealSecret(tokenEnc) ?: return null
        val config = runCatching { json.decodeFromString<EnrollmentConfig>(configRaw) }.getOrNull() ?: return null
        return config to token
    }

    @Synchronized
    fun clearEnrollment() {
        prefs.edit()
            .remove(KEY_CONFIG)
            .remove(KEY_TOKEN_ENC)
            .apply()
    }

    private fun getOrCreateWrapKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existing = ks.getKey(KEYSTORE_ALIAS, null) as? SecretKey
        if (existing != null) return existing
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(
                KEYSTORE_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build(),
        )
        return gen.generateKey()
    }

    private fun sealSecret(plain: String): String {
        val key = getOrCreateWrapKey()
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key)
        val iv = cipher.iv
        val ct = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return "${Base64Url.encode(iv)}:${Base64Url.encode(ct)}"
    }

    private fun unsealSecret(sealed: String): String? {
        return try {
            val parts = sealed.split(':')
            if (parts.size != 2) return null
            val iv = Base64Url.decode(parts[0])
            val ct = Base64Url.decode(parts[1])
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, getOrCreateWrapKey(), GCMParameterSpec(128, iv))
            String(cipher.doFinal(ct), Charsets.UTF_8)
        } catch (_: Throwable) {
            null
        }
    }
}
