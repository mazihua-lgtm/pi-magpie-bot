package app.pimagpie.bot.ui

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.LocalContentColor
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/**
 * Monochrome, the way the best chat apps look now: black (or white) ground,
 * one raised surface, hairline borders, and colour only where something needs
 * the eye - a link, an error, a running task.
 */
@Immutable
data class Palette(
	val ground: Color,
	val raised: Color,
	val raisedHigh: Color,
	val line: Color,
	val text: Color,
	val muted: Color,
	val faint: Color,
	/** The send button and anything "primary": the inverse of the ground. */
	val ink: Color,
	val onInk: Color,
	val link: Color,
	val danger: Color,
	val live: Color,
	val codeGround: Color,
	val dark: Boolean,
)

private val Dark = Palette(
	ground = Color(0xFF000000),
	raised = Color(0xFF141414),
	raisedHigh = Color(0xFF1F1F1F),
	line = Color(0xFF262626),
	text = Color(0xFFF2F2F2),
	muted = Color(0xFF9B9B9B),
	faint = Color(0xFF5E5E5E),
	ink = Color(0xFFFFFFFF),
	onInk = Color(0xFF000000),
	link = Color(0xFF7AB4FF),
	danger = Color(0xFFFF6B6B),
	live = Color(0xFF4ADE80),
	codeGround = Color(0xFF0E0E0E),
	dark = true,
)

private val Light = Palette(
	ground = Color(0xFFFFFFFF),
	raised = Color(0xFFF4F4F5),
	raisedHigh = Color(0xFFEAEAEC),
	line = Color(0xFFE4E4E7),
	text = Color(0xFF0A0A0A),
	muted = Color(0xFF6B6B70),
	faint = Color(0xFFA1A1AA),
	ink = Color(0xFF0A0A0A),
	onInk = Color(0xFFFFFFFF),
	link = Color(0xFF1D63D8),
	danger = Color(0xFFD93025),
	live = Color(0xFF16A34A),
	codeGround = Color(0xFFF6F6F7),
	dark = false,
)

val LocalPalette = staticCompositionLocalOf { Dark }

enum class ThemeMode { System, Dark, Light }

@Composable
fun AppTheme(mode: ThemeMode, content: @Composable () -> Unit) {
	val dark = when (mode) {
		ThemeMode.System -> isSystemInDarkTheme()
		ThemeMode.Dark -> true
		ThemeMode.Light -> false
	}
	val palette = if (dark) Dark else Light
	val scheme = if (dark) {
		darkColorScheme(
			primary = palette.ink, onPrimary = palette.onInk,
			background = palette.ground, onBackground = palette.text,
			surface = palette.ground, onSurface = palette.text,
			surfaceVariant = palette.raised, onSurfaceVariant = palette.muted,
			surfaceContainer = palette.raised, surfaceContainerHigh = palette.raisedHigh,
			surfaceContainerHighest = palette.raisedHigh, surfaceContainerLow = palette.raised,
			surfaceContainerLowest = palette.ground,
			outline = palette.line, outlineVariant = palette.line,
			error = palette.danger, secondaryContainer = palette.raisedHigh, onSecondaryContainer = palette.text,
		)
	} else {
		lightColorScheme(
			primary = palette.ink, onPrimary = palette.onInk,
			background = palette.ground, onBackground = palette.text,
			surface = palette.ground, onSurface = palette.text,
			surfaceVariant = palette.raised, onSurfaceVariant = palette.muted,
			surfaceContainer = palette.raised, surfaceContainerHigh = palette.raisedHigh,
			surfaceContainerHighest = palette.raisedHigh, surfaceContainerLow = palette.raised,
			surfaceContainerLowest = palette.ground,
			outline = palette.line, outlineVariant = palette.line,
			error = palette.danger, secondaryContainer = palette.raisedHigh, onSecondaryContainer = palette.text,
		)
	}
	// No colour in the styles: text takes it from where it sits (a button, a sheet).
	val base = TextStyle(fontFamily = FontFamily.Default)
	val type = Typography(
		headlineMedium = base.copy(fontSize = 26.sp, lineHeight = 34.sp, fontWeight = FontWeight.SemiBold),
		titleLarge = base.copy(fontSize = 20.sp, lineHeight = 28.sp, fontWeight = FontWeight.SemiBold),
		titleMedium = base.copy(fontSize = 16.sp, lineHeight = 24.sp, fontWeight = FontWeight.Medium),
		bodyLarge = base.copy(fontSize = 16.sp, lineHeight = 26.sp),
		bodyMedium = base.copy(fontSize = 14.sp, lineHeight = 21.sp),
		bodySmall = base.copy(fontSize = 12.sp, lineHeight = 17.sp),
		labelLarge = base.copy(fontSize = 14.sp, lineHeight = 20.sp, fontWeight = FontWeight.Medium),
		labelMedium = base.copy(fontSize = 12.sp, lineHeight = 16.sp, fontWeight = FontWeight.Medium),
	)
	MaterialTheme(colorScheme = scheme, typography = type) {
		CompositionLocalProvider(LocalPalette provides palette, LocalContentColor provides palette.text, content = content)
	}
}
