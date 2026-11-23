package ai.youbrain.mobile.ui

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import ai.youbrain.mobile.data.MobilePushItem
import ai.youbrain.mobile.net.AppUiState
import ai.youbrain.mobile.net.UBrainRepository
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

private val KIND_FILTERS = listOf(
    "all" to "全部",
    "t3" to "T3",
    "tty7" to "终端",
    "dispatch" to "派活",
    "reminder" to "提醒",
)

@Composable
fun PushCenterScreen(
    state: AppUiState,
    repository: UBrainRepository,
    onOpenDeviceT3: (deviceId: String, threadUrl: String?) -> Unit,
) {
    var filter by remember { mutableStateOf("all") }
    val filtered = remember(state.pushes, filter) {
        if (filter == "all") state.pushes
        else state.pushes.filter { it.kind == filter }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Surface(tonalElevation = 2.dp) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .horizontalScroll(rememberScrollState())
                    .padding(horizontal = 10.dp, vertical = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                KIND_FILTERS.forEach { (key, label) ->
                    FilterChip(
                        selected = filter == key,
                        onClick = { filter = key },
                        label = { Text(label) },
                    )
                }
            }
        }

        if (filtered.isEmpty()) {
            Box(modifier = Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text(
                    text = "暂无推送消息\n各台设备上的终端待回复、T3 完成/等待、跨设备派活进展和 U-Brain 提醒都会实时汇总到这里。",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(28.dp),
                )
            }
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(12.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                items(filtered, key = { it.seq }) { item ->
                    PushCard(
                        item = item,
                        canViewT3 = state.relayState.devices.any {
                            it.id == item.deviceId && it.dispatch?.viewT3 == true
                        },
                        repository = repository,
                        onOpenT3 = { onOpenDeviceT3(item.deviceId, item.link) },
                    )
                }
            }
        }
    }
}

@Composable
private fun PushCard(
    item: MobilePushItem,
    canViewT3: Boolean,
    repository: UBrainRepository,
    onOpenT3: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val timeText = remember(item.ts) {
        SimpleDateFormat("MM-dd HH:mm", Locale.getDefault()).format(Date(item.ts))
    }
    var replyOpen by remember { mutableStateOf(false) }
    var replyDraft by remember { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    var feedback by remember { mutableStateOf<String?>(null) }

    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(modifier = Modifier.fillMaxWidth().padding(14.dp)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = "${item.deviceName} · ${kindLabel(item.kind)}",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                    maxLines = 1,
                    softWrap = false,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    text = timeText,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    softWrap = false,
                )
            }
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = item.title,
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )
            if (item.body.isNotBlank()) {
                Spacer(modifier = Modifier.height(6.dp))
                SelectionContainer {
                    Text(
                        text = item.body,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }

            if (feedback != null) {
                Spacer(modifier = Modifier.height(6.dp))
                Text(
                    text = feedback!!,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.secondary,
                )
            }

            Spacer(modifier = Modifier.height(6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                if (!item.replyToken.isNullOrBlank()) {
                    TextButton(onClick = { replyOpen = !replyOpen }) {
                        Text(if (replyOpen) "收起回复" else "快捷回复")
                    }
                }
                if (canViewT3) {
                    TextButton(onClick = onOpenT3) {
                        Text("查看设备 T3")
                    }
                }
            }

            if (replyOpen) {
                Row(
                    modifier = Modifier.fillMaxWidth().padding(top = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    OutlinedTextField(
                        value = replyDraft,
                        onValueChange = { replyDraft = it },
                        placeholder = { Text("回复内容将直接发往原会话…") },
                        singleLine = true,
                        modifier = Modifier.weight(1f),
                    )
                    Button(
                        onClick = {
                            val text = replyDraft.trim()
                            if (text.isEmpty()) return@Button
                            sending = true
                            scope.launch {
                                val res = repository.replyToPush(item, text)
                                sending = false
                                res.fold(
                                    onSuccess = {
                                        replyDraft = ""
                                        replyOpen = false
                                        feedback = "✓ 已发送到 ${it.targetName.ifBlank { item.deviceName }}"
                                    },
                                    onFailure = {
                                        feedback = "回复失败：${it.message}"
                                    },
                                )
                            }
                        },
                        enabled = !sending && replyDraft.isNotBlank(),
                    ) { Text("发送") }
                }
            }
        }
    }
}

private fun kindLabel(kind: String): String = when (kind) {
    "t3" -> "T3 会话"
    "tty7" -> "终端会话"
    "dispatch" -> "跨设备派活"
    "reminder" -> "记忆提醒"
    else -> "通知"
}
