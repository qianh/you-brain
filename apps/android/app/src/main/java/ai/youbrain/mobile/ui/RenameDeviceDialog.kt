package ai.youbrain.mobile.ui

import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.sp
import ai.youbrain.mobile.ui.components.IosModalSheet
import ai.youbrain.mobile.ui.components.IosTextField
import ai.youbrain.mobile.ui.theme.IosTheme

@Composable
fun RenameDeviceDialog(
    rawName: String,
    currentDisplayName: String,
    isSelf: Boolean,
    hasAlias: Boolean,
    onConfirm: (String) -> Unit,
    onReset: (() -> Unit)? = null,
    onDismiss: () -> Unit,
) {
    val c = IosTheme.colors
    var draft by remember(rawName, currentDisplayName) {
        mutableStateOf(currentDisplayName)
    }

    IosModalSheet(
        title = if (isSelf) "修改本机展示名称" else "修改设备展示名称",
        onDismiss = onDismiss,
        confirmText = "保存",
        onConfirm = { onConfirm(draft) },
        secondaryText = if (!isSelf && hasAlias && onReset != null) "恢复原名（$rawName）" else null,
        onSecondary = onReset,
    ) {
        Text(
            text = if (isSelf) {
                "保存后会重连中转并同步给所有电脑端；留空将恢复系统机型名。"
            } else {
                "仅在当前手机展示生效（对端原名：$rawName）。"
            },
            fontSize = 13.sp,
            lineHeight = 18.sp,
            color = c.secondaryLabel,
            textAlign = TextAlign.Center,
        )
        IosTextField(
            value = draft,
            onValueChange = { draft = it.take(40) },
            placeholder = rawName,
            singleLine = true,
            showClear = true,
        )
    }
}
