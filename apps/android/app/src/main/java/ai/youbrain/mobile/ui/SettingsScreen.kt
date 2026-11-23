package ai.youbrain.mobile.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ai.youbrain.mobile.data.ConnectionState
import ai.youbrain.mobile.net.AppUiState
import ai.youbrain.mobile.net.UBrainRepository

@Composable
fun SettingsScreen(
    state: AppUiState,
    repository: UBrainRepository,
    onToggleBackgroundService: (Boolean) -> Unit,
    onUnenroll: () -> Unit,
) {
    val clipboard = LocalClipboardManager.current
    var copiedTip by remember { mutableStateOf(false) }
    var confirmExit by remember { mutableStateOf(false) }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(14.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        // 连接与本机身份
        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
            Column(modifier = Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("中转连接", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                    Text(
                        text = when (state.connectionState) {
                            ConnectionState.OK -> "● 已连接"
                            ConnectionState.CONNECTING -> "◌ 连接中"
                            ConnectionState.ERROR -> "✕ 出错"
                            ConnectionState.OFF -> "○ 已断开"
                        },
                        color = when (state.connectionState) {
                            ConnectionState.OK -> MaterialTheme.colorScheme.secondary
                            ConnectionState.ERROR -> MaterialTheme.colorScheme.error
                            else -> MaterialTheme.colorScheme.onSurfaceVariant
                        },
                        style = MaterialTheme.typography.labelLarge,
                    )
                }
                Text("中转地址: ${state.relayUrl}", style = MaterialTheme.typography.bodySmall)
                Text("设备名称: ${state.deviceName}", style = MaterialTheme.typography.bodySmall)
                SelectionContainer {
                    Text(
                        text = "设备 ID: ${state.deviceId}\n公钥指纹: ${state.publicKeyFingerprint}",
                        style = MaterialTheme.typography.bodySmall,
                        fontFamily = FontFamily.Monospace,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (state.connectionError != null) {
                    Text(
                        text = state.connectionError,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.error,
                    )
                }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    OutlinedButton(onClick = { repository.reconnectNow() }) { Text("立即重连") }
                    OutlinedButton(
                        onClick = {
                            clipboard.setText(AnnotatedString(state.publicKey))
                            copiedTip = true
                        },
                    ) { Text(if (copiedTip) "已复制公钥" else "复制公钥") }
                }
                Text(
                    text = "提示：手机入网后，可在任意电脑端 U-Brain「设置 → 接入 → 跨设备派活」里对本手机点击「信任此设备」，即可一次同步到同一云盘账号下的全部 Mac 与 VPS。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        // 后台保活
        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
            Row(
                modifier = Modifier.fillMaxWidth().padding(14.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("后台常驻收推送", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                    Text(
                        text = "使用轻量前台服务保持 WebSocket 长连接与通知栏快捷回复（内存约 30MB）",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Switch(
                    checked = state.backgroundKeepAlive,
                    onCheckedChange = { enabled ->
                        repository.setBackgroundKeepAlive(enabled)
                        onToggleBackgroundService(enabled)
                    },
                )
            }
        }

        // 在线设备总览
        Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
            Column(modifier = Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("同中转设备 (${state.relayState.devices.size})", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                state.relayState.devices.forEach { dev ->
                    val flags = buildList {
                        if (dev.id == state.deviceId) add("本机")
                        if (dev.dispatch?.role == "server") add("VPS 主控")
                        if (dev.dispatch?.viewT3 == true) add("可看 T3")
                        if (dev.dispatch?.enabled == true) add("可派活")
                    }
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text(
                            text = "${if (dev.online) "● " else "○ "}${dev.name}",
                            style = MaterialTheme.typography.bodySmall,
                            fontWeight = FontWeight.Medium,
                            maxLines = 1,
                            softWrap = false,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        Text(
                            text = flags.joinToString(" · ").ifEmpty { if (dev.enrolled == true) "已入网" else "未入网" },
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            maxLines = 1,
                            softWrap = false,
                        )
                    }
                }
            }
        }

        // 对端公钥固定管理
        if (state.pinnedPeers.isNotEmpty()) {
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                Column(modifier = Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("T3 隧道公钥固定", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                        TextButton(onClick = { repository.clearAllPins() }) { Text("全部重置") }
                    }
                    state.pinnedPeers.forEach { (id, pk) ->
                        val name = state.relayState.devices.firstOrNull { it.id == id }?.name ?: id
                        Row(
                            modifier = Modifier.fillMaxWidth(),
                            horizontalArrangement = Arrangement.SpaceBetween,
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text(
                                text = "$name (${pk.take(10)}…)",
                                style = MaterialTheme.typography.bodySmall,
                                modifier = Modifier.weight(1f),
                            )
                            TextButton(onClick = { repository.forgetPeerPin(id) }) { Text("忘记") }
                        }
                    }
                }
            }
        }

        Spacer(modifier = Modifier.height(4.dp))
        Button(
            onClick = { confirmExit = true },
            colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text("退出入网并清除本机凭据")
        }
    }

    if (confirmExit) {
        AlertDialog(
            onDismissRequest = { confirmExit = false },
            title = { Text("确认退出入网？") },
            text = { Text("退出后将断开中转连接并清除本机保存的设备令牌与推送缓存，下次需用新邀请码重新入网。") },
            confirmButton = {
                Button(
                    onClick = {
                        confirmExit = false
                        onUnenroll()
                    },
                    colors = ButtonDefaults.buttonColors(containerColor = MaterialTheme.colorScheme.error),
                ) { Text("确认退出") }
            },
            dismissButton = {
                TextButton(onClick = { confirmExit = false }) { Text("取消") }
            },
        )
    }
}
