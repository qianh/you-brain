package ai.youbrain.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.youbrain.mobile.data.ConnectionState
import ai.youbrain.mobile.net.AppUiState
import ai.youbrain.mobile.net.UBrainRepository
import ai.youbrain.mobile.ui.components.IosHairline
import ai.youbrain.mobile.ui.components.IosIconBadge
import ai.youbrain.mobile.ui.components.IosIcons
import ai.youbrain.mobile.ui.components.IosInsetGroup
import ai.youbrain.mobile.ui.components.IosModalSheet
import ai.youbrain.mobile.ui.components.IosRow
import ai.youbrain.mobile.ui.components.IosSwitch
import ai.youbrain.mobile.ui.theme.IosTheme

@Composable
fun SettingsScreen(
    state: AppUiState,
    repository: UBrainRepository,
    onToggleBackgroundService: (Boolean) -> Unit,
    onUnenroll: () -> Unit,
) {
    val c = IosTheme.colors
    val clipboard = LocalClipboardManager.current
    var copiedTip by remember { mutableStateOf(false) }
    var confirmExit by remember { mutableStateOf(false) }
    var renameTarget by remember { mutableStateOf<Pair<String, String>?>(null) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(c.groupedBg)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalArrangement = Arrangement.spacedBy(20.dp),
    ) {
        val statusText = when (state.connectionState) {
            ConnectionState.OK -> "已连接"
            ConnectionState.CONNECTING -> "连接中"
            ConnectionState.ERROR -> "连接出错"
            ConnectionState.OFF -> "已断开"
        }
        IosInsetGroup(
            header = "本机身份与中转",
            footer = "手机入网后，可在任意电脑端 U-Brain「设置 → 接入 → 跨设备派活」对本手机点击「信任此设备」，即可自动同步到全部 Mac 与 VPS。",
        ) {
            IosRow(
                title = "连接状态",
                subtitle = state.relayUrl.ifBlank { null },
                value = statusText,
                icon = IosIcons.Server,
                iconBg = when (state.connectionState) {
                    ConnectionState.OK -> c.green
                    ConnectionState.CONNECTING -> c.orange
                    else -> c.red
                },
                showChevron = false,
                showDivider = true,
                onClick = { repository.reconnectNow() },
            )
            IosRow(
                title = "本机展示名称",
                value = state.deviceName,
                icon = IosIcons.Pencil,
                iconBg = c.blue,
                showChevron = true,
                showDivider = true,
                onClick = { renameTarget = state.deviceId to state.deviceName },
            )
            IosRow(
                title = if (copiedTip) "已复制本机公钥" else "复制本机公钥",
                value = state.publicKeyFingerprint,
                icon = IosIcons.Key,
                iconBg = c.indigo,
                showChevron = true,
                showDivider = true,
                onClick = {
                    clipboard.setText(AnnotatedString(state.publicKey))
                    copiedTip = true
                },
            )
            Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 10.dp)) {
                Text("设备 ID", fontSize = 12.sp, color = c.secondaryLabel)
                Spacer(modifier = Modifier.height(2.dp))
                SelectionContainer {
                    Text(
                        text = state.deviceId,
                        fontSize = 12.sp,
                        fontFamily = FontFamily.Monospace,
                        color = c.secondaryLabel,
                    )
                }
                if (state.connectionError != null) {
                    Spacer(modifier = Modifier.height(6.dp))
                    Text(
                        text = state.connectionError,
                        fontSize = 12.5.sp,
                        color = c.red,
                    )
                }
            }
        }

        IosInsetGroup(
            header = "通知与后台连接",
            footer = "开启后使用轻量前台服务维持 WebSocket 长连接并支持锁屏/通知栏快捷回复（约 30MB 内存）。",
        ) {
            IosRow(
                title = "后台常驻收推送",
                icon = IosIcons.Bell,
                iconBg = c.red,
                showChevron = false,
                showDivider = false,
                trailing = {
                    IosSwitch(
                        checked = state.backgroundKeepAlive,
                        onCheckedChange = { enabled ->
                            repository.setBackgroundKeepAlive(enabled)
                            onToggleBackgroundService(enabled)
                        },
                    )
                },
            )
        }

        IosInsetGroup(header = "同中转设备（${state.relayState.devices.size}）") {
            if (state.relayState.devices.isEmpty()) {
                IosRow(
                    title = "暂未发现其他设备",
                    showDivider = false,
                )
            } else {
                state.relayState.devices.forEachIndexed { idx, dev ->
                    val flags = buildList {
                        if (dev.id == state.deviceId) add("本机")
                        if (dev.dispatch?.role == "server") add("VPS 主控")
                        if (dev.dispatch?.viewT3 == true) add("可看 T3")
                        if (dev.dispatch?.enabled == true) add("可派活")
                    }.joinToString(" · ").ifEmpty { if (dev.enrolled == true) "已入网" else "未入网" }
                    val display = state.displayName(dev)
                    val titleLine = if (state.hasCustomAlias(dev.id)) "$display (${dev.name})" else display
                    val dotColor = if (dev.online) c.green else c.tertiaryLabel

                    Column(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { renameTarget = dev.id to dev.name },
                    ) {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = 14.dp, vertical = 10.dp),
                            verticalAlignment = Alignment.CenterVertically,
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                        ) {
                            IosIconBadge(
                                icon = if (dev.dispatch?.role == "server") IosIcons.Server else IosIcons.Laptop,
                                background = if (dev.online) c.blue else c.secondaryLabel,
                            )
                            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                                Row(
                                    verticalAlignment = Alignment.CenterVertically,
                                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                                ) {
                                    Box(
                                        modifier = Modifier
                                            .size(6.dp)
                                            .clip(CircleShape)
                                            .background(dotColor),
                                    )
                                    Text(
                                        text = titleLine,
                                        fontSize = 15.sp,
                                        fontWeight = FontWeight.Medium,
                                        color = c.label,
                                        maxLines = 1,
                                        overflow = TextOverflow.Ellipsis,
                                    )
                                }
                                Text(
                                    text = flags,
                                    fontSize = 12.5.sp,
                                    color = c.secondaryLabel,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                            Text(
                                text = "改名",
                                fontSize = 14.sp,
                                color = c.blue,
                            )
                        }
                        if (idx < state.relayState.devices.lastIndex) {
                            IosHairline(startIndent = 54.dp)
                        }
                    }
                }
            }
        }

        if (state.pinnedPeers.isNotEmpty()) {
            IosInsetGroup(
                header = "T3 隧道公钥固定",
                footer = "如果某台电脑重装了系统或重新初始化密钥，点击「忘记」即可重新固定其公钥。",
            ) {
                val entries = state.pinnedPeers.entries.toList()
                entries.forEachIndexed { idx, (id, pk) ->
                    val rawName = state.relayState.devices.firstOrNull { it.id == id }?.name ?: id
                    val name = state.displayName(id, rawName)
                    IosRow(
                        title = name,
                        value = "${pk.take(8)}… · 忘记",
                        icon = IosIcons.Shield,
                        iconBg = c.teal,
                        showDivider = idx < entries.lastIndex,
                        onClick = { repository.forgetPeerPin(id) },
                    )
                }
                if (entries.size > 1) {
                    IosHairline(startIndent = 54.dp)
                    IosRow(
                        title = "全部重置公钥固定",
                        destructive = true,
                        showDivider = false,
                        onClick = { repository.clearAllPins() },
                    )
                }
            }
        }

        IosInsetGroup {
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(48.dp)
                    .clickable { confirmExit = true },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = "退出入网并清除本机凭据",
                    color = c.red,
                    fontSize = 15.5.sp,
                    fontWeight = FontWeight.Medium,
                )
            }
        }

        Spacer(modifier = Modifier.height(8.dp))
    }

    if (confirmExit) {
        IosModalSheet(
            title = "确认退出入网？",
            onDismiss = { confirmExit = false },
            confirmText = "确认退出",
            confirmDestructive = true,
            onConfirm = {
                confirmExit = false
                onUnenroll()
            },
        ) {
            Text(
                text = "退出后将断开中转连接并清除本机保存的设备令牌与推送缓存，下次需用新邀请码重新入网。",
                fontSize = 13.5.sp,
                lineHeight = 19.sp,
                color = c.secondaryLabel,
                textAlign = TextAlign.Center,
            )
        }
    }

    renameTarget?.let { (targetId, rawName) ->
        RenameDeviceDialog(
            rawName = rawName,
            currentDisplayName = state.displayName(targetId, rawName),
            isSelf = targetId == state.deviceId,
            hasAlias = state.hasCustomAlias(targetId),
            onConfirm = { draft ->
                repository.renameDevice(targetId, draft)
                renameTarget = null
            },
            onReset = {
                repository.renameDevice(targetId, "")
                renameTarget = null
            },
            onDismiss = { renameTarget = null },
        )
    }
}
