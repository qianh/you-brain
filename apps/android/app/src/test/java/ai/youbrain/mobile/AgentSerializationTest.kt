package ai.youbrain.mobile

import ai.youbrain.mobile.data.AgentMessage
import ai.youbrain.mobile.data.AgentSessionResponse
import ai.youbrain.mobile.data.AgentSessionSummary
import ai.youbrain.mobile.data.CachedAgentSnapshot
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class AgentSerializationTest {
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    @Test
    fun decodesLegacyAndBundledAgentSessionResponses() {
        val legacyRaw = """
            {
              "activeSessionId": "ag-1",
              "sessions": [{"sessionId": "ag-1", "title": "主控会话", "status": "idle"}],
              "defaultProject": {"id": "p-1", "name": "you-brain"}
            }
        """.trimIndent()
        val legacy = json.decodeFromString(AgentSessionResponse.serializer(), legacyRaw)
        assertEquals("ag-1", legacy.activeSessionId)
        assertNull(legacy.conversation)

        val bundledRaw = """
            {
              "activeSessionId": "ag-2",
              "sessions": [{"sessionId": "ag-2", "title": "主控", "status": "running"}],
              "conversation": {
                "sessionId": "ag-2",
                "title": "主控",
                "state": "running",
                "activity": "正在思考与调度…",
                "messages": [{"position": 1, "role": "user", "text": "查状态"}],
                "outbox": []
              }
            }
        """.trimIndent()
        val bundled = json.decodeFromString(AgentSessionResponse.serializer(), bundledRaw)
        assertEquals("ag-2", bundled.conversation?.sessionId)
        assertEquals("running", bundled.conversation?.state)
        assertEquals("正在思考与调度…", bundled.conversation?.activity)
        assertEquals(1, bundled.conversation?.messages?.size)
    }

    @Test
    fun roundTripsCachedAgentSnapshot() {
        val snap = CachedAgentSnapshot(
            masterDeviceId = "dev-vps",
            activeSessionId = "ag-9",
            sessions = listOf(AgentSessionSummary(sessionId = "ag-9", title = "主控", status = "idle")),
            messages = listOf(AgentMessage(position = 1, role = "assistant", text = "全部在线")),
        )
        val decoded = json.decodeFromString(CachedAgentSnapshot.serializer(), json.encodeToString(snap))
        assertEquals(snap, decoded)
    }
}
