package ai.youbrain.mobile.ui

import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

data class ParsedPairingUri(val url: String, val code: String)

fun parsePairingUri(raw: String): ParsedPairingUri? {
    val trimmed = raw.trim()
    if (!trimmed.startsWith("ubrain://enroll", ignoreCase = true)) return null
    val uri = runCatching { Uri.parse(trimmed) }.getOrNull() ?: return null
    val url = uri.getQueryParameter("url")?.trim().orEmpty()
    val code = uri.getQueryParameter("code")?.trim().orEmpty()
    if (url.isEmpty() || code.isEmpty()) return null
    return ParsedPairingUri(url = url, code = code)
}

@Composable
fun OnboardingScreen(
    defaultDeviceName: String,
    initialPairingUri: String?,
    onEnroll: suspend (relayUrl: String, code: String, name: String) -> Unit,
) {
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current

    var relayUrl by remember { mutableStateOf("") }
    var inviteCode by remember { mutableStateOf("") }
    var deviceName by remember(defaultDeviceName) { mutableStateOf(defaultDeviceName) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    LaunchedEffect(initialPairingUri) {
        if (!initialPairingUri.isNullOrBlank()) {
            parsePairingUri(initialPairingUri)?.let { parsed ->
                relayUrl = parsed.url
                inviteCode = parsed.code
                error = null
            }
        }
    }

    Scaffold { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(20.dp)
                .verticalScroll(rememberScrollState()),
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            Spacer(modifier = Modifier.height(12.dp))
            Text(
                text = "U-Brain Mobile",
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.Bold,
            )
            Text(
                text = "连入自有中转，随时随地查看全部设备的 T3 页面、接收所有通知，并与 VPS 主控 Agent 持续会话派活。",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Card(
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
            ) {
                Column(
                    modifier = Modifier.padding(14.dp),
                    verticalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Text(
                        text = "快速配对",
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                    )
                    Text(
                        text = "在任意已入网电脑打开 U-Brain「设置 → 接入 → Telegram → 添加手机 / 新设备」，复制配对串后点下方粘贴即可自动填入。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    OutlinedButton(
                        onClick = {
                            val clip = clipboard.getText()?.text.orEmpty()
                            val parsed = parsePairingUri(clip)
                            if (parsed != null) {
                                relayUrl = parsed.url
                                inviteCode = parsed.code
                                error = null
                            } else {
                                error = "剪贴板里不是有效的 ubrain://enroll?... 配对串"
                            }
                        },
                        enabled = !busy,
                    ) {
                        Text("从剪贴板粘贴配对串")
                    }
                }
            }

            OutlinedTextField(
                value = relayUrl,
                onValueChange = { relayUrl = it; error = null },
                label = { Text("中转地址") },
                placeholder = { Text("https://relay.example.com") },
                singleLine = true,
                enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
            )

            OutlinedTextField(
                value = inviteCode,
                onValueChange = { inviteCode = it.uppercase().take(16); error = null },
                label = { Text("8 位一次性邀请码") },
                placeholder = { Text("提交后立即清空且不回显") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
            )

            OutlinedTextField(
                value = deviceName,
                onValueChange = { deviceName = it.take(40) },
                label = { Text("本机显示名称") },
                singleLine = true,
                enabled = !busy,
                modifier = Modifier.fillMaxWidth(),
            )

            if (error != null) {
                Text(
                    text = error!!,
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                )
            }

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.End,
            ) {
                Button(
                    onClick = {
                        val submittedCode = inviteCode.trim()
                        val submittedUrl = relayUrl.trim()
                        val submittedName = deviceName.trim()
                        if (submittedUrl.isEmpty() || submittedCode.isEmpty()) {
                            error = "请填写中转地址和邀请码"
                            return@Button
                        }
                        inviteCode = ""
                        busy = true
                        error = null
                        scope.launch {
                            try {
                                onEnroll(submittedUrl, submittedCode, submittedName)
                            } catch (t: Throwable) {
                                val raw = t.message ?: "入网失败"
                                error = raw.replace(submittedCode, "***")
                            } finally {
                                busy = false
                            }
                        }
                    },
                    enabled = !busy && relayUrl.isNotBlank() && inviteCode.isNotBlank(),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    if (busy) {
                        CircularProgressIndicator(
                            modifier = Modifier.height(18.dp),
                            strokeWidth = 2.dp,
                            color = MaterialTheme.colorScheme.onPrimary,
                        )
                    } else {
                        Text("入网连接")
                    }
                }
            }
        }
    }
}
