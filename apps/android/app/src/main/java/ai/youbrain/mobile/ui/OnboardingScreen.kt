package ai.youbrain.mobile.ui

import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import ai.youbrain.mobile.ui.components.IosHairline
import ai.youbrain.mobile.ui.components.IosIcons
import ai.youbrain.mobile.ui.components.IosInsetGroup
import ai.youbrain.mobile.ui.components.IosRow
import ai.youbrain.mobile.ui.theme.IosTheme
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
    val c = IosTheme.colors

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

    Scaffold(
        containerColor = c.groupedBg,
        contentWindowInsets = WindowInsets(0, 0, 0, 0),
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .statusBarsPadding()
                .navigationBarsPadding()
                .imePadding()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 20.dp),
            verticalArrangement = Arrangement.spacedBy(20.dp),
        ) {
            Column(
                modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                Box(
                    modifier = Modifier
                        .size(68.dp)
                        .clip(RoundedCornerShape(18.dp))
                        .background(
                            Brush.linearGradient(
                                colors = listOf(Color(0xFF0A84FF), Color(0xFF5856D6)),
                            ),
                        ),
                    contentAlignment = Alignment.Center,
                ) {
                    Icon(
                        imageVector = IosIcons.BubbleSparkle,
                        contentDescription = null,
                        tint = Color.White,
                        modifier = Modifier.size(34.dp),
                    )
                }
                Text(
                    text = "U-Brain Mobile",
                    fontSize = 26.sp,
                    fontWeight = FontWeight.Bold,
                    color = c.label,
                )
                Text(
                    text = "端到端加密查看全部设备 T3、实时接收快捷回复推送，并与主控 Agent 持续会话派活。",
                    fontSize = 14.sp,
                    lineHeight = 20.sp,
                    color = c.secondaryLabel,
                    modifier = Modifier.padding(horizontal = 12.dp),
                )
            }

            IosInsetGroup(
                header = "快速配对",
                footer = "在任意已入网电脑打开 U-Brain「设置 → 接入 → Telegram → 添加手机 / 新设备」，复制配对串后点上方即可自动填入。",
            ) {
                IosRow(
                    title = "从剪贴板粘贴配对串",
                    icon = IosIcons.Bolt,
                    iconBg = c.orange,
                    showChevron = true,
                    showDivider = false,
                    onClick = if (busy) null else {
                        {
                            val clip = clipboard.getText()?.text.orEmpty()
                            val parsed = parsePairingUri(clip)
                            if (parsed != null) {
                                relayUrl = parsed.url
                                inviteCode = parsed.code
                                error = null
                            } else {
                                error = "剪贴板里不是有效的 ubrain://enroll?... 配对串"
                            }
                        }
                    },
                )
            }

            IosInsetGroup(header = "设备与中转信息") {
                IosFormFieldRow(
                    label = "中转地址",
                    value = relayUrl,
                    onValueChange = { relayUrl = it; error = null },
                    placeholder = "https://relay.example.com",
                    enabled = !busy,
                    showDivider = true,
                )
                IosFormFieldRow(
                    label = "邀请码",
                    value = inviteCode,
                    onValueChange = { inviteCode = it.uppercase().take(16); error = null },
                    placeholder = "8 位一次性邀请码",
                    enabled = !busy,
                    visualTransformation = PasswordVisualTransformation(),
                    showDivider = true,
                )
                IosFormFieldRow(
                    label = "本机名称",
                    value = deviceName,
                    onValueChange = { deviceName = it.take(40) },
                    placeholder = defaultDeviceName,
                    enabled = !busy,
                    showDivider = false,
                )
            }

            if (error != null) {
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(10.dp))
                        .background(c.red.copy(alpha = 0.12f))
                        .padding(horizontal = 14.dp, vertical = 10.dp),
                ) {
                    Text(
                        text = error!!,
                        color = c.red,
                        fontSize = 13.5.sp,
                        lineHeight = 18.sp,
                    )
                }
            }

            val canSubmit = !busy && relayUrl.isNotBlank() && inviteCode.isNotBlank()
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(50.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(if (canSubmit) c.blue else c.tertiaryFill)
                    .clickable(enabled = canSubmit) {
                        val submittedCode = inviteCode.trim()
                        val submittedUrl = relayUrl.trim()
                        val submittedName = deviceName.trim()
                        if (submittedUrl.isEmpty() || submittedCode.isEmpty()) {
                            error = "请填写中转地址和邀请码"
                            return@clickable
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
                contentAlignment = Alignment.Center,
            ) {
                if (busy) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(20.dp),
                        strokeWidth = 2.dp,
                        color = Color.White,
                    )
                } else {
                    Text(
                        text = "入网连接",
                        color = if (canSubmit) Color.White else c.secondaryLabel,
                        fontSize = 16.sp,
                        fontWeight = FontWeight.SemiBold,
                    )
                }
            }
        }
    }
}

@Composable
private fun IosFormFieldRow(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    enabled: Boolean,
    showDivider: Boolean,
    visualTransformation: VisualTransformation = VisualTransformation.None,
) {
    val c = IosTheme.colors
    Column(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .height(48.dp)
                .padding(horizontal = 14.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = label,
                fontSize = 15.sp,
                color = c.label,
                modifier = Modifier.width(76.dp),
            )
            Box(modifier = Modifier.weight(1f)) {
                if (value.isEmpty()) {
                    Text(
                        text = placeholder,
                        fontSize = 15.sp,
                        color = c.tertiaryLabel,
                        maxLines = 1,
                    )
                }
                BasicTextField(
                    value = value,
                    onValueChange = onValueChange,
                    enabled = enabled,
                    singleLine = true,
                    visualTransformation = visualTransformation,
                    textStyle = TextStyle(
                        fontSize = 15.sp,
                        color = if (enabled) c.label else c.secondaryLabel,
                    ),
                    cursorBrush = SolidColor(c.blue),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        }
        if (showDivider) {
            IosHairline(startIndent = 14.dp)
        }
    }
}
