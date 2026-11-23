package ai.youbrain.mobile.ui.components

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.dp

object IosIcons {
    private val strokeBrush = SolidColor(Color.Black)

    val BubbleSparkle: ImageVector by lazy {
        strokeIcon("BubbleSparkle", strokeWidth = 1.75f) {
            // Rounded chat bubble
            moveTo(4.5f, 6.5f)
            curveTo(4.5f, 5.12f, 5.62f, 4f, 7f, 4f)
            lineTo(17f, 4f)
            curveTo(18.38f, 4f, 19.5f, 5.12f, 19.5f, 6.5f)
            lineTo(19.5f, 14f)
            curveTo(19.5f, 15.38f, 18.38f, 16.5f, 17f, 16.5f)
            lineTo(10.5f, 16.5f)
            lineTo(6.5f, 20f)
            lineTo(6.5f, 16.5f)
            curveTo(5.4f, 16.5f, 4.5f, 15.6f, 4.5f, 14.5f)
            close()
            // Four-point sparkle inside bubble
            moveTo(12f, 7.2f)
            lineTo(12.75f, 9.45f)
            lineTo(15f, 10.2f)
            lineTo(12.75f, 10.95f)
            lineTo(12f, 13.2f)
            lineTo(11.25f, 10.95f)
            lineTo(9f, 10.2f)
            lineTo(11.25f, 9.45f)
            close()
        }
    }

    val TerminalWindow: ImageVector by lazy {
        strokeIcon("TerminalWindow", strokeWidth = 1.75f) {
            // Rounded window frame
            moveTo(3.5f, 6.5f)
            curveTo(3.5f, 5.12f, 4.62f, 4f, 6f, 4f)
            lineTo(18f, 4f)
            curveTo(19.38f, 4f, 20.5f, 5.12f, 20.5f, 6.5f)
            lineTo(20.5f, 17.5f)
            curveTo(20.5f, 18.88f, 19.38f, 20f, 18f, 20f)
            lineTo(6f, 20f)
            curveTo(4.62f, 20f, 3.5f, 18.88f, 3.5f, 17.5f)
            close()
            // Prompt chevron >
            moveTo(7.5f, 9.5f)
            lineTo(10.5f, 12f)
            lineTo(7.5f, 14.5f)
            // Cursor _
            moveTo(12.5f, 14.5f)
            lineTo(16.5f, 14.5f)
        }
    }

    val Bell: ImageVector by lazy {
        strokeIcon("Bell", strokeWidth = 1.75f) {
            moveTo(18f, 14.5f)
            lineTo(19.2f, 16.5f)
            lineTo(4.8f, 16.5f)
            lineTo(6f, 14.5f)
            lineTo(6f, 10f)
            curveTo(6f, 6.69f, 8.69f, 4f, 12f, 4f)
            curveTo(15.31f, 4f, 18f, 6.69f, 18f, 10f)
            close()
            moveTo(10f, 18.2f)
            curveTo(10.4f, 19.2f, 11.15f, 19.8f, 12f, 19.8f)
            curveTo(12.85f, 19.8f, 13.6f, 19.2f, 14f, 18.2f)
        }
    }

    val Gear: ImageVector by lazy {
        strokeIcon("Gear", strokeWidth = 1.7f) {
            // Outer ring octagon-like gear + center circle
            moveTo(12f, 8.5f)
            curveTo(13.93f, 8.5f, 15.5f, 10.07f, 15.5f, 12f)
            curveTo(15.5f, 13.93f, 13.93f, 15.5f, 12f, 15.5f)
            curveTo(10.07f, 15.5f, 8.5f, 13.93f, 8.5f, 12f)
            curveTo(8.5f, 10.07f, 10.07f, 8.5f, 12f, 8.5f)
            // Outer teeth ring
            moveTo(12f, 3f)
            lineTo(13.1f, 5.2f)
            lineTo(15.5f, 4.4f)
            lineTo(16.2f, 6.8f)
            lineTo(18.7f, 6.9f)
            lineTo(18.3f, 9.4f)
            lineTo(20.6f, 10.8f)
            lineTo(19.5f, 12f)
            lineTo(20.6f, 13.2f)
            lineTo(18.3f, 14.6f)
            lineTo(18.7f, 17.1f)
            lineTo(16.2f, 17.2f)
            lineTo(15.5f, 19.6f)
            lineTo(13.1f, 18.8f)
            lineTo(12f, 21f)
            lineTo(10.9f, 18.8f)
            lineTo(8.5f, 19.6f)
            lineTo(7.8f, 17.2f)
            lineTo(5.3f, 17.1f)
            lineTo(5.7f, 14.6f)
            lineTo(3.4f, 13.2f)
            lineTo(4.5f, 12f)
            lineTo(3.4f, 10.8f)
            lineTo(5.7f, 9.4f)
            lineTo(5.3f, 6.9f)
            lineTo(7.8f, 6.8f)
            lineTo(8.5f, 4.4f)
            lineTo(10.9f, 5.2f)
            close()
        }
    }

    val ArrowUp: ImageVector by lazy {
        strokeIcon("ArrowUp", strokeWidth = 2.2f) {
            moveTo(12f, 18.5f)
            lineTo(12f, 5.5f)
            moveTo(6.5f, 11f)
            lineTo(12f, 5.5f)
            lineTo(17.5f, 11f)
        }
    }

    val ChevronRight: ImageVector by lazy {
        strokeIcon("ChevronRight", strokeWidth = 2.0f) {
            moveTo(9f, 6f)
            lineTo(15f, 12f)
            lineTo(9f, 18f)
        }
    }

    val ChevronDown: ImageVector by lazy {
        strokeIcon("ChevronDown", strokeWidth = 2.0f) {
            moveTo(6.5f, 9.5f)
            lineTo(12f, 15f)
            lineTo(17.5f, 9.5f)
        }
    }

    val Refresh: ImageVector by lazy {
        strokeIcon("Refresh", strokeWidth = 1.9f) {
            moveTo(19f, 12f)
            curveTo(19f, 15.87f, 15.87f, 19f, 12f, 19f)
            curveTo(8.13f, 19f, 5f, 15.87f, 5f, 12f)
            curveTo(5f, 8.13f, 8.13f, 5f, 12f, 5f)
            curveTo(14.5f, 5f, 16.7f, 6.3f, 17.95f, 8.3f)
            moveTo(18.5f, 4.8f)
            lineTo(18.3f, 8.6f)
            lineTo(14.5f, 8.4f)
        }
    }

    val Plus: ImageVector by lazy {
        strokeIcon("Plus", strokeWidth = 2.0f) {
            moveTo(12f, 5.5f)
            lineTo(12f, 18.5f)
            moveTo(5.5f, 12f)
            lineTo(18.5f, 12f)
        }
    }

    val Pencil: ImageVector by lazy {
        strokeIcon("Pencil", strokeWidth = 1.8f) {
            moveTo(15.8f, 4.8f)
            lineTo(19.2f, 8.2f)
            lineTo(8.4f, 19f)
            lineTo(4.5f, 19.5f)
            lineTo(5f, 15.6f)
            close()
            moveTo(13.4f, 7.2f)
            lineTo(16.8f, 10.6f)
        }
    }

    val Check: ImageVector by lazy {
        strokeIcon("Check", strokeWidth = 2.2f) {
            moveTo(5.5f, 12.5f)
            lineTo(10f, 17f)
            lineTo(18.5f, 7.5f)
        }
    }

    val Bolt: ImageVector by lazy {
        strokeIcon("Bolt", strokeWidth = 1.85f) {
            moveTo(13.5f, 3.5f)
            lineTo(6.5f, 13f)
            lineTo(12f, 13f)
            lineTo(10.5f, 20.5f)
            lineTo(17.5f, 11f)
            lineTo(12f, 11f)
            close()
        }
    }

    val Layers: ImageVector by lazy {
        strokeIcon("Layers", strokeWidth = 1.75f) {
            moveTo(12f, 4f)
            lineTo(20f, 8.5f)
            lineTo(12f, 13f)
            lineTo(4f, 8.5f)
            close()
            moveTo(4f, 12.5f)
            lineTo(12f, 17f)
            lineTo(20f, 12.5f)
            moveTo(4f, 16.5f)
            lineTo(12f, 21f)
            lineTo(20f, 16.5f)
        }
    }

    val ExternalLink: ImageVector by lazy {
        strokeIcon("ExternalLink", strokeWidth = 1.85f) {
            moveTo(14f, 5f)
            lineTo(19f, 5f)
            lineTo(19f, 10f)
            moveTo(19f, 5f)
            lineTo(11f, 13f)
            moveTo(18f, 14f)
            lineTo(18f, 18f)
            curveTo(18f, 19.1f, 17.1f, 20f, 16f, 20f)
            lineTo(6f, 20f)
            curveTo(4.9f, 20f, 4f, 19.1f, 4f, 18f)
            lineTo(4f, 8f)
            curveTo(4f, 6.9f, 4.9f, 6f, 6f, 6f)
            lineTo(10f, 6f)
        }
    }

    val Close: ImageVector by lazy {
        strokeIcon("Close", strokeWidth = 2.0f) {
            moveTo(6.5f, 6.5f)
            lineTo(17.5f, 17.5f)
            moveTo(17.5f, 6.5f)
            lineTo(6.5f, 17.5f)
        }
    }

    val Server: ImageVector by lazy {
        strokeIcon("Server", strokeWidth = 1.75f) {
            moveTo(4.5f, 5f)
            curveTo(4.5f, 4.17f, 5.17f, 3.5f, 6f, 3.5f)
            lineTo(18f, 3.5f)
            curveTo(18.83f, 3.5f, 19.5f, 4.17f, 19.5f, 5f)
            lineTo(19.5f, 9f)
            curveTo(19.5f, 9.83f, 18.83f, 10.5f, 18f, 10.5f)
            lineTo(6f, 10.5f)
            curveTo(5.17f, 10.5f, 4.5f, 9.83f, 4.5f, 9f)
            close()
            moveTo(4.5f, 15f)
            curveTo(4.5f, 14.17f, 5.17f, 13.5f, 6f, 13.5f)
            lineTo(18f, 13.5f)
            curveTo(18.83f, 13.5f, 19.5f, 14.17f, 19.5f, 15f)
            lineTo(19.5f, 19f)
            curveTo(19.5f, 19.83f, 18.83f, 20.5f, 18f, 20.5f)
            lineTo(6f, 20.5f)
            curveTo(5.17f, 20.5f, 4.5f, 19.83f, 4.5f, 19f)
            close()
            moveTo(8f, 7f)
            lineTo(8.1f, 7f)
            moveTo(8f, 17f)
            lineTo(8.1f, 17f)
        }
    }

    val Laptop: ImageVector by lazy {
        strokeIcon("Laptop", strokeWidth = 1.75f) {
            moveTo(5.5f, 6.5f)
            curveTo(5.5f, 5.67f, 6.17f, 5f, 7f, 5f)
            lineTo(17f, 5f)
            curveTo(17.83f, 5f, 18.5f, 5.67f, 18.5f, 6.5f)
            lineTo(18.5f, 15f)
            lineTo(5.5f, 15f)
            close()
            moveTo(3f, 18f)
            lineTo(21f, 18f)
        }
    }

    val Key: ImageVector by lazy {
        strokeIcon("Key", strokeWidth = 1.8f) {
            moveTo(14.5f, 9.5f)
            curveTo(14.5f, 11.71f, 12.71f, 13.5f, 10.5f, 13.5f)
            curveTo(8.29f, 13.5f, 6.5f, 11.71f, 6.5f, 9.5f)
            curveTo(6.5f, 7.29f, 8.29f, 5.5f, 10.5f, 5.5f)
            curveTo(12.71f, 5.5f, 14.5f, 7.29f, 14.5f, 9.5f)
            close()
            moveTo(13.5f, 12.5f)
            lineTo(19.5f, 18.5f)
            moveTo(16.5f, 15.5f)
            lineTo(18.5f, 13.5f)
        }
    }

    val Shield: ImageVector by lazy {
        strokeIcon("Shield", strokeWidth = 1.8f) {
            moveTo(12f, 3.8f)
            lineTo(19f, 6.5f)
            lineTo(19f, 11.8f)
            curveTo(19f, 16f, 15.9f, 19.2f, 12f, 20.5f)
            curveTo(8.1f, 19.2f, 5f, 16f, 5f, 11.8f)
            lineTo(5f, 6.5f)
            close()
            moveTo(9.5f, 12f)
            lineTo(11.3f, 13.8f)
            lineTo(15f, 10f)
        }
    }

    private inline fun strokeIcon(
        name: String,
        strokeWidth: Float = 1.8f,
        block: androidx.compose.ui.graphics.vector.PathBuilder.() -> Unit,
    ): ImageVector = ImageVector.Builder(
        name = name,
        defaultWidth = 24.dp,
        defaultHeight = 24.dp,
        viewportWidth = 24f,
        viewportHeight = 24f,
    ).path(
        fill = null,
        stroke = strokeBrush,
        strokeLineWidth = strokeWidth,
        strokeLineCap = StrokeCap.Round,
        strokeLineJoin = StrokeJoin.Round,
        pathBuilder = block,
    ).build()
}
