package ai.youbrain.mobile.crypto

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * 递归对 JSON 对象键按字典序排序且不输出空白，
 * 与 packages/protocol/src/dispatch.ts 的 canonicalJson 字节级对齐。
 */
object CanonicalJson {
    private val compactJson = Json {
        prettyPrint = false
        encodeDefaults = true
    }

    fun canonicalize(element: JsonElement): JsonElement = when (element) {
        is JsonNull, is JsonPrimitive -> element
        is JsonArray -> JsonArray(element.map(::canonicalize))
        is JsonObject -> {
            val sorted = sortedMapOf<String, JsonElement>()
            for ((k, v) in element) {
                sorted[k] = canonicalize(v)
            }
            JsonObject(sorted)
        }
    }

    fun stringify(element: JsonElement): String =
        compactJson.encodeToString(JsonElement.serializer(), canonicalize(element))
}
