package au.com.rootcauseobd.fleet.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val AutelRed = Color(0xFFE0242F)
val AutelBlue = Color(0xFF2B7FFF)
val AutelGreen = Color(0xFF10B981)
val AutelAmber = Color(0xFFF59E0B)

private val NightCabColors = darkColorScheme(
    primary = AutelRed,
    secondary = AutelBlue,
    background = Color(0xFF0C0F14),
    surface = Color(0xFF151A22),
    onBackground = Color(0xFFF3F6FA),
    onSurface = Color(0xFFF3F6FA),
)

private val DaylightGlareColors = lightColorScheme(
    primary = Color(0xFFC81E28),
    secondary = Color(0xFF1D4ED8),
    background = Color(0xFFE6ECF3),
    surface = Color(0xFFFFFFFF),
    onBackground = Color(0xFF0F172A),
    onSurface = Color(0xFF0F172A),
)

@Composable
fun RootCauseAutelTheme(darkTheme: Boolean = true, content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = if (darkTheme) NightCabColors else DaylightGlareColors,
        content = content
    )
}
