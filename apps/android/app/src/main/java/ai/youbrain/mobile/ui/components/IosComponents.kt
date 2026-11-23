package ai.youbrain.mobile.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import ai.youbrain.mobile.data.ConnectionState
import ai.youbrain.mobile.net.AppTab
import ai.youbrain.mobile.ui.theme.IosTheme

@Composable
fun IosHairline(modifier: Modifier = Modifier, startIndent: Dp = 0.dp) {
    HorizontalDivider(
        modifier = modifier.padding(start = startIndent),
        thickness = 0.5.dp,
        color = IosTheme.colors.separator.copy(alpha = if (IosTheme.colors.isDark) 0.7f else 0.55f),
    )
}

@Composable
fun IosNavigationBar(
    title: String,
    connectionState: ConnectionState,
    onReconnect: () -> Unit,
) {
    val c = IosTheme.colors
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(c.chromeBg),
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .statusBarsPadding()
                .height(44.dp)
                .padding(horizontal = 16.dp),
        ) {
            Text(
                text = title,
                fontSize = 17.sp,
                fontWeight = FontWeight.SemiBold,
                color = c.label,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.align(Alignment.Center),
            )

            val dotColor = when (connectionState) {
                ConnectionState.OK -> c.green
                ConnectionState.CONNECTING -> c.orange
                else -> c.red
            }
            val label = when (connectionState) {
                ConnectionState.OK -> "在线"
                ConnectionState.CONNECTING -> "连接中"
                else -> "重连"
            }
            Surface(
                shape = CircleShape,
                color = dotColor.copy(alpha = if (c.isDark) 0.18f else 0.12f),
                modifier = Modifier
                    .align(Alignment.CenterEnd)
                    .clip(CircleShape)
                    .clickable(onClick = onReconnect),
            ) {
                Row(
                    modifier = Modifier.padding(horizontal = 9.dp, vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(5.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .size(6.dp)
                            .clip(CircleShape)
                            .background(dotColor),
                    )
                    Text(
                        text = label,
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium,
                        color = dotColor,
                        maxLines = 1,
                        softWrap = false,
                    )
                }
            }
        }
        IosHairline()
    }
}

@Composable
fun IosTabBar(
    currentTab: AppTab,
    unreadCount: Int,
    onSelectTab: (AppTab) -> Unit,
) {
    val c = IosTheme.colors
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(c.chromeBg),
    ) {
        IosHairline()
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .height(52.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            IosTabItem(
                selected = currentTab == AppTab.AGENT,
                icon = IosIcons.BubbleSparkle,
                label = "主控",
                badgeCount = 0,
                onClick = { onSelectTab(AppTab.AGENT) },
                modifier = Modifier.weight(1f),
            )
            IosTabItem(
                selected = currentTab == AppTab.T3,
                icon = IosIcons.TerminalWindow,
                label = "T3",
                badgeCount = 0,
                onClick = { onSelectTab(AppTab.T3) },
                modifier = Modifier.weight(1f),
            )
            IosTabItem(
                selected = currentTab == AppTab.PUSHES,
                icon = IosIcons.Bell,
                label = "消息",
                badgeCount = unreadCount,
                onClick = { onSelectTab(AppTab.PUSHES) },
                modifier = Modifier.weight(1f),
            )
            IosTabItem(
                selected = currentTab == AppTab.SETTINGS,
                icon = IosIcons.Gear,
                label = "设置",
                badgeCount = 0,
                onClick = { onSelectTab(AppTab.SETTINGS) },
                modifier = Modifier.weight(1f),
            )
        }
    }
}

@Composable
private fun IosTabItem(
    selected: Boolean,
    icon: ImageVector,
    label: String,
    badgeCount: Int,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = IosTheme.colors
    val tint by animateColorAsState(
        targetValue = if (selected) c.blue else c.secondaryLabel,
        animationSpec = tween(150),
        label = "tabTint",
    )
    val interaction = remember { MutableInteractionSource() }
    Column(
        modifier = modifier
            .height(52.dp)
            .clickable(interactionSource = interaction, indication = null, onClick = onClick),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Box(contentAlignment = Alignment.TopEnd) {
            Icon(
                imageVector = icon,
                contentDescription = label,
                tint = tint,
                modifier = Modifier
                    .padding(horizontal = 8.dp, vertical = 1.dp)
                    .size(22.dp),
            )
            if (badgeCount > 0) {
                Box(
                    modifier = Modifier
                        .offset(x = (-1).dp, y = (-3).dp)
                        .defaultMinSize(minWidth = 16.dp, minHeight = 16.dp)
                        .clip(CircleShape)
                        .background(c.red)
                        .padding(horizontal = 4.dp),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(
                        text = if (badgeCount > 99) "99+" else "$badgeCount",
                        color = Color.White,
                        fontSize = 10.sp,
                        fontWeight = FontWeight.Bold,
                        maxLines = 1,
                    )
                }
            }
        }
        Spacer(modifier = Modifier.height(2.dp))
        Text(
            text = label,
            fontSize = 10.5.sp,
            fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
            color = tint,
            maxLines = 1,
        )
    }
}

@Composable
fun IosSegmentedControl(
    items: List<Pair<String, String>>,
    selectedKey: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = IosTheme.colors
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(34.dp)
            .clip(RoundedCornerShape(9.dp))
            .background(c.tertiaryFill.copy(alpha = if (c.isDark) 0.9f else 0.75f))
            .padding(2.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        items.forEach { (key, label) ->
            val selected = key == selectedKey
            val thumbBg = if (selected) {
                if (c.isDark) Color(0xFF636366) else Color.White
            } else {
                Color.Transparent
            }
            Box(
                modifier = Modifier
                    .weight(1f)
                    .height(30.dp)
                    .then(
                        if (selected) {
                            Modifier.shadow(
                                elevation = if (c.isDark) 0.dp else 1.5.dp,
                                shape = RoundedCornerShape(7.dp),
                            )
                        } else {
                            Modifier
                        },
                    )
                    .clip(RoundedCornerShape(7.dp))
                    .background(thumbBg)
                    .clickable { onSelect(key) },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = label,
                    fontSize = 13.sp,
                    fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                    color = if (selected) c.label else c.secondaryLabel,
                    maxLines = 1,
                    softWrap = false,
                )
            }
        }
    }
}

@Composable
fun IosInsetGroup(
    header: String? = null,
    footer: String? = null,
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    val c = IosTheme.colors
    Column(modifier = modifier.fillMaxWidth()) {
        if (!header.isNullOrBlank()) {
            Text(
                text = header,
                fontSize = 12.5.sp,
                fontWeight = FontWeight.Medium,
                color = c.secondaryLabel,
                modifier = Modifier.padding(start = 14.dp, end = 14.dp, bottom = 6.dp),
            )
        }
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(c.cardBg),
            content = content,
        )
        if (!footer.isNullOrBlank()) {
            Text(
                text = footer,
                fontSize = 12.sp,
                lineHeight = 16.sp,
                color = c.secondaryLabel,
                modifier = Modifier.padding(start = 14.dp, end = 14.dp, top = 6.dp),
            )
        }
    }
}

@Composable
fun IosIconBadge(
    icon: ImageVector,
    background: Color,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier = modifier
            .size(28.dp)
            .clip(RoundedCornerShape(7.dp))
            .background(background),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = Color.White,
            modifier = Modifier.size(16.dp),
        )
    }
}

@Composable
fun IosRow(
    title: String,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    value: String? = null,
    icon: ImageVector? = null,
    iconBg: Color = IosTheme.colors.blue,
    destructive: Boolean = false,
    showChevron: Boolean = false,
    showDivider: Boolean = true,
    onClick: (() -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    val c = IosTheme.colors
    val rowModifier = if (onClick != null) {
        modifier.fillMaxWidth().clickable(onClick = onClick)
    } else {
        modifier.fillMaxWidth()
    }
    Column(modifier = rowModifier) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .defaultMinSize(minHeight = 46.dp)
                .padding(horizontal = 14.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            if (icon != null) {
                IosIconBadge(icon = icon, background = iconBg)
            }
            Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    text = title,
                    fontSize = 15.5.sp,
                    fontWeight = FontWeight.Normal,
                    color = if (destructive) c.red else c.label,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                if (!subtitle.isNullOrBlank()) {
                    Text(
                        text = subtitle,
                        fontSize = 12.5.sp,
                        lineHeight = 16.sp,
                        color = c.secondaryLabel,
                    )
                }
            }
            if (!value.isNullOrBlank()) {
                Text(
                    text = value,
                    fontSize = 14.sp,
                    color = c.secondaryLabel,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            trailing?.invoke()
            if (showChevron) {
                Icon(
                    imageVector = IosIcons.ChevronRight,
                    contentDescription = null,
                    tint = c.tertiaryLabel,
                    modifier = Modifier.size(16.dp),
                )
            }
        }
        if (showDivider) {
            IosHairline(startIndent = if (icon != null) 54.dp else 14.dp)
        }
    }
}

@Composable
fun IosSwitch(
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = IosTheme.colors
    val trackColor by animateColorAsState(
        targetValue = if (checked) c.green else c.tertiaryFill,
        animationSpec = tween(180),
        label = "switchTrack",
    )
    val thumbOffset by animateDpAsState(
        targetValue = if (checked) 20.dp else 0.dp,
        animationSpec = tween(180),
        label = "switchThumb",
    )
    Box(
        modifier = modifier
            .size(width = 51.dp, height = 31.dp)
            .clip(CircleShape)
            .background(trackColor)
            .clickable(
                interactionSource = remember { MutableInteractionSource() },
                indication = null,
            ) { onCheckedChange(!checked) }
            .padding(2.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        Box(
            modifier = Modifier
                .offset(x = thumbOffset)
                .size(27.dp)
                .shadow(2.dp, CircleShape)
                .clip(CircleShape)
                .background(Color.White),
        )
    }
}

@Composable
fun IosTextField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    singleLine: Boolean = true,
    maxLines: Int = if (singleLine) 1 else 5,
    enabled: Boolean = true,
    visualTransformation: VisualTransformation = VisualTransformation.None,
    contentPadding: PaddingValues = PaddingValues(horizontal = 12.dp, vertical = 10.dp),
    showClear: Boolean = false,
) {
    val c = IosTheme.colors
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(10.dp))
            .background(if (c.isDark) Color(0xFF2C2C2E) else Color(0xFFF2F2F7))
            .border(0.5.dp, c.separator.copy(alpha = 0.45f), RoundedCornerShape(10.dp))
            .padding(contentPadding),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(modifier = Modifier.weight(1f)) {
            if (value.isEmpty()) {
                Text(
                    text = placeholder,
                    fontSize = 15.sp,
                    color = c.secondaryLabel,
                    maxLines = if (singleLine) 1 else 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            BasicTextField(
                value = value,
                onValueChange = onValueChange,
                enabled = enabled,
                singleLine = singleLine,
                maxLines = maxLines,
                visualTransformation = visualTransformation,
                textStyle = TextStyle(
                    fontSize = 15.sp,
                    color = if (enabled) c.label else c.secondaryLabel,
                ),
                cursorBrush = SolidColor(c.blue),
                modifier = Modifier.fillMaxWidth(),
            )
        }
        if (showClear && value.isNotEmpty() && enabled) {
            Spacer(modifier = Modifier.width(6.dp))
            Box(
                modifier = Modifier
                    .size(18.dp)
                    .clip(CircleShape)
                    .background(c.secondaryLabel.copy(alpha = 0.35f))
                    .clickable { onValueChange("") },
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = IosIcons.Close,
                    contentDescription = "清除",
                    tint = Color.White,
                    modifier = Modifier.size(11.dp),
                )
            }
        }
    }
}

@Composable
fun IosModalSheet(
    title: String,
    onDismiss: () -> Unit,
    confirmText: String,
    onConfirm: () -> Unit,
    confirmEnabled: Boolean = true,
    confirmDestructive: Boolean = false,
    secondaryText: String? = null,
    onSecondary: (() -> Unit)? = null,
    dismissText: String = "取消",
    dismissEnabled: Boolean = true,
    content: @Composable ColumnScope.() -> Unit,
) {
    val c = IosTheme.colors
    Dialog(
        onDismissRequest = { if (dismissEnabled) onDismiss() },
        properties = DialogProperties(usePlatformDefaultWidth = false),
    ) {
        Surface(
            shape = RoundedCornerShape(16.dp),
            color = if (c.isDark) Color(0xFF1C1C1E) else Color(0xFFF9F9FB),
            tonalElevation = 0.dp,
            shadowElevation = 12.dp,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp),
        ) {
            Column(modifier = Modifier.fillMaxWidth()) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 18.dp, vertical = 18.dp),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    Text(
                        text = title,
                        fontSize = 17.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = c.label,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    content()
                }
                IosHairline()
                if (secondaryText != null && onSecondary != null) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(46.dp)
                            .clickable(enabled = dismissEnabled, onClick = onSecondary),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = secondaryText,
                            fontSize = 16.sp,
                            fontWeight = FontWeight.Medium,
                            color = c.blue,
                        )
                    }
                    IosHairline()
                }
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(46.dp),
                ) {
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .height(46.dp)
                            .clickable(enabled = dismissEnabled, onClick = onDismiss),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = dismissText,
                            fontSize = 16.sp,
                            fontWeight = FontWeight.Normal,
                            color = if (dismissEnabled) c.blue else c.tertiaryLabel,
                        )
                    }
                    Box(
                        modifier = Modifier
                            .width(0.5.dp)
                            .height(46.dp)
                            .background(c.separator.copy(alpha = 0.6f)),
                    )
                    Box(
                        modifier = Modifier
                            .weight(1f)
                            .height(46.dp)
                            .clickable(enabled = confirmEnabled, onClick = onConfirm),
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(
                            text = confirmText,
                            fontSize = 16.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = when {
                                !confirmEnabled -> c.tertiaryLabel
                                confirmDestructive -> c.red
                                else -> c.blue
                            },
                        )
                    }
                }
            }
        }
    }
}
