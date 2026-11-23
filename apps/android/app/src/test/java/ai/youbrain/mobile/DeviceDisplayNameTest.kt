package ai.youbrain.mobile

import ai.youbrain.mobile.data.RelayDevice
import ai.youbrain.mobile.net.AppUiState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeviceDisplayNameTest {
    @Test
    fun resolvesSelfNamePeerAliasesAndFallbacksCorrectly() {
        val state = AppUiState(
            enrolled = true,
            deviceId = "android-self",
            deviceName = "我的主力手机",
            deviceAliases = mapOf(
                "mac-air" to "主力 Air",
                "blank-alias" to "   ",
            ),
        )

        val selfDev = RelayDevice(id = "android-self", name = "OldPhoneModel")
        val macAir = RelayDevice(id = "mac-air", name = "qianhongdeMacBook-Air.local")
        val blankPeer = RelayDevice(id = "blank-alias", name = "Johns-MacBook-Pro-2.local")
        val vps = RelayDevice(id = "vps-1", name = "racknerd-828dca9")

        assertEquals("我的主力手机", state.displayName(selfDev))
        assertFalse(state.hasCustomAlias("android-self"))

        assertEquals("主力 Air", state.displayName(macAir))
        assertTrue(state.hasCustomAlias("mac-air"))

        assertEquals("Johns-MacBook-Pro-2.local", state.displayName(blankPeer))
        assertFalse(state.hasCustomAlias("blank-alias"))

        assertEquals("racknerd-828dca9", state.displayName(vps))
        assertFalse(state.hasCustomAlias("vps-1"))
    }
}
