package app.pimagpie.bot.ui

import android.graphics.BitmapFactory
import android.util.Base64
import android.util.LruCache
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.composed
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale

fun Modifier.clickableNoRipple(onClick: () -> Unit): Modifier = composed {
	clickable(remember { MutableInteractionSource() }, indication = null, onClick = onClick)
}

/** The mark: a π of three rounded bars, drawn so it is crisp at any size. */
@Composable
fun Logo(size: Dp, color: Color = LocalPalette.current.text, modifier: Modifier = Modifier) {
	Canvas(modifier.size(size)) {
		val u = this.size.width / 24f
		val r = CornerRadius(u * 1.1f)
		drawRoundRect(color, Offset(u * 3f, u * 5.5f), Size(u * 18f, u * 3.2f), r)
		drawRoundRect(color, Offset(u * 6.6f, u * 8f), Size(u * 3.2f, u * 11f), r)
		drawRoundRect(color, Offset(u * 14.4f, u * 8f), Size(u * 3.2f, u * 9f), r)
		drawRoundRect(color, Offset(u * 14.4f, u * 15.4f), Size(u * 5.4f, u * 3.2f), r)
	}
}

@Composable
fun TopBar(title: String, onBack: () -> Unit, actions: @Composable () -> Unit = {}) {
	Row(
		Modifier.fillMaxWidth().statusBarsPadding().height(56.dp).padding(horizontal = 4.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, "返回") }
		Text(title, style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold), modifier = Modifier.weight(1f))
		actions()
		Spacer(Modifier.width(4.dp))
	}
}

@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
	Text(
		text,
		style = MaterialTheme.typography.labelMedium.copy(color = LocalPalette.current.muted),
		modifier = modifier.padding(start = 20.dp, end = 20.dp, top = 18.dp, bottom = 6.dp),
	)
}

private val images = LruCache<String, ImageBitmap>(24)

/** A `data:` URI as a bitmap, decoded once. */
fun decodeDataUri(uri: String): ImageBitmap? {
	images.get(uri)?.let { return it }
	val comma = uri.indexOf(',')
	if (!uri.startsWith("data:") || comma < 0) return null
	return runCatching {
		val bytes = Base64.decode(uri.substring(comma + 1), Base64.DEFAULT)
		BitmapFactory.decodeByteArray(bytes, 0, bytes.size).asImageBitmap()
	}.getOrNull()?.also { images.put(uri, it) }
}

@Composable
fun Centered(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
	Box(modifier, contentAlignment = Alignment.Center) { content() }
}

/** "今天 18:30", "明天 07:00", "11月20日 周四 09:00". */
fun whenText(at: Long, now: Long = System.currentTimeMillis()): String {
	val day = dayDiff(now, at)
	val time = SimpleDateFormat("HH:mm", Locale.CHINA).format(Date(at))
	return when (day) {
		0 -> "今天 $time"
		1 -> "明天 $time"
		2 -> "后天 $time"
		-1 -> "昨天 $time"
		else -> SimpleDateFormat("M月d日 EEE HH:mm", Locale.CHINA).format(Date(at))
	}
}

fun dayDiff(from: Long, to: Long): Int {
	fun start(at: Long) = Calendar.getInstance().apply {
		timeInMillis = at
		set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
	}.timeInMillis
	return Math.round((start(to) - start(from)) / 86_400_000.0).toInt()
}

fun everyText(everyMs: Long?): String? = when {
	everyMs == null || everyMs <= 0 -> null
	everyMs % (7 * 86_400_000L) == 0L -> if (everyMs == 7 * 86_400_000L) "每周" else "每 ${everyMs / (7 * 86_400_000L)} 周"
	everyMs % 86_400_000L == 0L -> if (everyMs == 86_400_000L) "每天" else "每 ${everyMs / 86_400_000L} 天"
	everyMs % 3_600_000L == 0L -> if (everyMs == 3_600_000L) "每小时" else "每 ${everyMs / 3_600_000L} 小时"
	else -> "每 ${everyMs / 60_000L} 分钟"
}
