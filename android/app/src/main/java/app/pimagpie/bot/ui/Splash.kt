package app.pimagpie.bot.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.scale
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The moment a cold start opens: the mark springs in, the name follows, the
 * line fades up and holds, then the whole layer fades away to reveal the real
 * screen already sitting underneath. The caller keeps the "already played"
 * flag in saved state, so this runs once per process — returning from the
 * background or rotating the phone does not replay it.
 *
 * Nothing here blocks the assistant: the service is starting behind this.
 */
@Composable
fun Splash(onDone: () -> Unit) {
	val palette = LocalPalette.current
	val scale = remember { Animatable(0.62f) }
	val fade = remember { Animatable(0f) }
	val line = remember { Animatable(0f) }

	LaunchedEffect(Unit) {
		launch { scale.animateTo(1f, spring(dampingRatio = 0.6f, stiffness = 240f)) }
		fade.animateTo(1f, tween(420))
		delay(280)
		launch { line.animateTo(1f, tween(360)) }
		// Hold the finished frame long enough to read the line.
		delay(1700)
		fade.animateTo(0f, tween(420))
		onDone()
	}

	Column(
		Modifier
			.fillMaxSize()
			.alpha(fade.value)
			.background(palette.ground)
			.statusBarsPadding()
			.navigationBarsPadding(),
		horizontalAlignment = Alignment.CenterHorizontally,
		verticalArrangement = Arrangement.Center,
	) {
		Logo(84.dp, modifier = Modifier.scale(scale.value))
		Spacer(Modifier.height(26.dp))
		Text("喜鹊", style = MaterialTheme.typography.headlineMedium)
		Spacer(Modifier.height(10.dp))
		Text(
			"喜鹊一叫，事儿有着落。",
			style = MaterialTheme.typography.bodyMedium.copy(color = palette.muted, textAlign = TextAlign.Center),
			modifier = Modifier.alpha(line.value),
		)
	}
}
