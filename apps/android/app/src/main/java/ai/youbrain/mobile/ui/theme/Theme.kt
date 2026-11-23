package ai.youbrain.mobile.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

@Immutable
data class IosColors(
    val isDark: Boolean,
    val groupedBg: Color,
    val cardBg: Color,
    val elevatedBg: Color,
    val chromeBg: Color,
    val tertiaryFill: Color,
    val quaternaryFill: Color,
    val blue: Color,
    val green: Color,
    val red: Color,
    val orange: Color,
    val indigo: Color,
    val teal: Color,
    val label: Color,
    val secondaryLabel: Color,
    val tertiaryLabel: Color,
    val separator: Color,
    val sentBubble: Color,
    val receivedBubble: Color,
    val receivedBubbleBorder: Color,
)

private val LightIosColors = IosColors(
    isDark = false,
    groupedBg = Color(0xFFF2F2F7),
    cardBg = Color(0xFFFFFFFF),
    elevatedBg = Color(0xFFFFFFFF),
    chromeBg = Color(0xF5F9F9FB),
    tertiaryFill = Color(0xFFE5E5EA),
    quaternaryFill = Color(0xFFEFEFF4),
    blue = Color(0xFF007AFF),
    green = Color(0xFF34C759),
    red = Color(0xFFFF3B30),
    orange = Color(0xFFFF9500),
    indigo = Color(0xFF5856D6),
    teal = Color(0xFF30B0C7),
    label = Color(0xFF000000),
    secondaryLabel = Color(0xFF8E8E93),
    tertiaryLabel = Color(0xFFC7C7CC),
    separator = Color(0xFFC6C6C8),
    sentBubble = Color(0xFF007AFF),
    receivedBubble = Color(0xFFFFFFFF),
    receivedBubbleBorder = Color(0xFFE5E5EA),
)

private val DarkIosColors = IosColors(
    isDark = true,
    groupedBg = Color(0xFF000000),
    cardBg = Color(0xFF1C1C1E),
    elevatedBg = Color(0xFF2C2C2E),
    chromeBg = Color(0xF5161618),
    tertiaryFill = Color(0xFF2C2C2E),
    quaternaryFill = Color(0xFF1C1C1E),
    blue = Color(0xFF0A84FF),
    green = Color(0xFF30D158),
    red = Color(0xFFFF453A),
    orange = Color(0xFFFF9F0A),
    indigo = Color(0xFF5E5CE6),
    teal = Color(0xFF40C8E0),
    label = Color(0xFFFFFFFF),
    secondaryLabel = Color(0xFF8E8E93),
    tertiaryLabel = Color(0xFF48484A),
    separator = Color(0xFF38383A),
    sentBubble = Color(0xFF0A84FF),
    receivedBubble = Color(0xFF1C1C1E),
    receivedBubbleBorder = Color(0xFF2C2C2E),
)

val LocalIosColors = staticCompositionLocalOf { LightIosColors }

object IosTheme {
    val colors: IosColors
        @Composable
        get() = LocalIosColors.current
}

private val LightColors = lightColorScheme(
    primary = LightIosColors.blue,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFDCEBFF),
    onPrimaryContainer = Color(0xFF003B7D),
    secondary = LightIosColors.green,
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFDDF7E4),
    onSecondaryContainer = Color(0xFF0C5B20),
    background = LightIosColors.groupedBg,
    onBackground = LightIosColors.label,
    surface = LightIosColors.cardBg,
    onSurface = LightIosColors.label,
    surfaceVariant = LightIosColors.tertiaryFill,
    onSurfaceVariant = LightIosColors.secondaryLabel,
    outline = LightIosColors.separator,
    error = LightIosColors.red,
    errorContainer = Color(0xFFFFE5E3),
    onErrorContainer = Color(0xFF8C140E),
)

private val DarkColors = darkColorScheme(
    primary = DarkIosColors.blue,
    onPrimary = Color.White,
    primaryContainer = Color(0xFF0A3264),
    onPrimaryContainer = Color(0xFFD6E9FF),
    secondary = DarkIosColors.green,
    onSecondary = Color.Black,
    secondaryContainer = Color(0xFF0D441B),
    onSecondaryContainer = Color(0xFFCFF7DA),
    background = DarkIosColors.groupedBg,
    onBackground = DarkIosColors.label,
    surface = DarkIosColors.cardBg,
    onSurface = DarkIosColors.label,
    surfaceVariant = DarkIosColors.tertiaryFill,
    onSurfaceVariant = DarkIosColors.secondaryLabel,
    outline = DarkIosColors.separator,
    error = DarkIosColors.red,
    errorContainer = Color(0xFF4D1411),
    onErrorContainer = Color(0xFFFFD8D5),
)

private val IosTypography = Typography(
    headlineLarge = TextStyle(fontSize = 30.sp, lineHeight = 36.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.4).sp),
    headlineMedium = TextStyle(fontSize = 24.sp, lineHeight = 30.sp, fontWeight = FontWeight.Bold, letterSpacing = (-0.3).sp),
    titleLarge = TextStyle(fontSize = 20.sp, lineHeight = 25.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.2).sp),
    titleMedium = TextStyle(fontSize = 17.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.2).sp),
    titleSmall = TextStyle(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.SemiBold, letterSpacing = (-0.1).sp),
    bodyLarge = TextStyle(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.Normal),
    bodyMedium = TextStyle(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.Normal),
    bodySmall = TextStyle(fontSize = 13.sp, lineHeight = 18.sp, fontWeight = FontWeight.Normal),
    labelLarge = TextStyle(fontSize = 15.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
    labelMedium = TextStyle(fontSize = 13.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium),
    labelSmall = TextStyle(fontSize = 11.sp, lineHeight = 13.sp, fontWeight = FontWeight.Medium),
)

@Composable
fun UBrainTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val iosColors = if (darkTheme) DarkIosColors else LightIosColors
    CompositionLocalProvider(LocalIosColors provides iosColors) {
        MaterialTheme(
            colorScheme = if (darkTheme) DarkColors else LightColors,
            typography = IosTypography,
            content = content,
        )
    }
}
