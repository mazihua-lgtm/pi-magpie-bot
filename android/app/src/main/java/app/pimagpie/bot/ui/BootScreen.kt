package app.pimagpie.bot.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.pimagpie.bot.AppModel
import app.pimagpie.bot.Boot
import app.pimagpie.bot.Logs
import app.pimagpie.bot.Payload
import app.pimagpie.bot.R
import app.pimagpie.bot.data.Vendor

/** The first run, the start of every run, and a failure with a way out. */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
fun BootScreen(model: AppModel, state: Boot.Preparing) {
	val palette = LocalPalette.current
	val context = LocalContext.current
	var showLog by remember { mutableStateOf(false) }
	// The first run waits for the tap: it takes minutes and wants power and Wi-Fi.
	val waitingForTap = state.firstRun && !Payload.installed(context) && state.line.isEmpty() && !state.failed && state.percent < 0
	val pulse by rememberInfiniteTransition(label = "pulse").animateFloat(
		0.45f, 1f, infiniteRepeatable(tween(1100), RepeatMode.Reverse), label = "alpha",
	)

	Column(
		Modifier.fillMaxSize().background(palette.ground).statusBarsPadding().navigationBarsPadding().padding(horizontal = 28.dp),
		horizontalAlignment = Alignment.CenterHorizontally,
	) {
		Spacer(Modifier.weight(1f))
		Logo(
			72.dp,
			modifier = Modifier
				.alpha(if (waitingForTap || state.failed) 1f else pulse)
				.combinedClickable(onClick = {}, onLongClick = { showLog = !showLog }),
		)
		Spacer(Modifier.height(28.dp))
		Text(stringRes(R.string.app_name), style = MaterialTheme.typography.headlineMedium)
		Spacer(Modifier.height(10.dp))
		Text(
			when {
				waitingForTap -> "一个住在你手机里的 AI 助理。\n记得住你说过的事，到点会提醒你，能上网查最新消息。"
				state.failed -> state.line.ifBlank { "没能启动" }
				// "running" is the process being up, not the assistant answering yet.
				state.line.isNotBlank() && state.line != stringRes(R.string.running) -> state.line
				else -> stringRes(R.string.starting)
			},
			style = MaterialTheme.typography.bodyLarge.copy(color = if (state.failed) palette.danger else palette.muted, textAlign = TextAlign.Center),
		)
		Spacer(Modifier.height(28.dp))
		if (!waitingForTap && !state.failed) {
			if (state.percent in 0..100 && !Payload.installed(context)) {
				LinearProgressIndicator(
					progress = { state.percent / 100f },
					modifier = Modifier.fillMaxWidth(0.7f).height(3.dp).clip(RoundedCornerShape(2.dp)),
					color = palette.ink, trackColor = palette.line, drawStopIndicator = {},
				)
				Spacer(Modifier.height(10.dp))
				Text("${state.percent}%", style = MaterialTheme.typography.labelMedium.copy(color = palette.muted))
			} else {
				LinearProgressIndicator(Modifier.fillMaxWidth(0.4f).height(3.dp).clip(RoundedCornerShape(2.dp)), color = palette.ink, trackColor = palette.line)
			}
		}
		if (showLog) {
			Spacer(Modifier.height(16.dp))
			Text(
				Logs.tail(),
				style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace, color = palette.muted, fontSize = 10.sp),
				modifier = Modifier.weight(1f).fillMaxWidth().clip(RoundedCornerShape(12.dp)).background(palette.raised).verticalScroll(rememberScrollState()).padding(12.dp),
			)
		}
		Spacer(Modifier.weight(1f))
		if (waitingForTap) {
			Text(
				"第一次打开要准备运行环境，约 300 MB、几分钟。请连着网、插着电。",
				style = MaterialTheme.typography.bodySmall.copy(color = palette.faint, textAlign = TextAlign.Center),
			)
			Spacer(Modifier.height(16.dp))
		}
		if (waitingForTap || state.failed) {
			Button(
				onClick = { model.start() },
				modifier = Modifier.fillMaxWidth().height(54.dp),
				shape = RoundedCornerShape(27.dp),
				colors = ButtonDefaults.buttonColors(containerColor = palette.ink, contentColor = palette.onInk),
			) { Text(if (state.failed) "再试一次" else "开始", style = MaterialTheme.typography.titleMedium) }
			Spacer(Modifier.height(24.dp))
		} else {
			Spacer(Modifier.height(78.dp))
		}
	}
}

/** No model yet: pick a provider and paste a key, without leaving the app. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun KeyScreen(model: AppModel) {
	val palette = LocalPalette.current
	var picked by remember { mutableStateOf<Vendor?>(null) }
	Column(Modifier.fillMaxSize().background(palette.ground).statusBarsPadding().navigationBarsPadding()) {
		Column(Modifier.padding(horizontal = 24.dp, vertical = 28.dp)) {
			Logo(40.dp)
			Spacer(Modifier.height(20.dp))
			Text("接入一个模型", style = MaterialTheme.typography.headlineMedium)
			Spacer(Modifier.height(8.dp))
			Text(
				"免费线路这会儿用不了。选一家模型服务商，填上它的 API Key，助理就能开口。Key 只存在这台手机上。",
				style = MaterialTheme.typography.bodyMedium.copy(color = palette.muted),
			)
		}
		if (model.vendors.isEmpty()) {
			Centered(Modifier.fillMaxWidth().padding(32.dp)) { CircularProgressIndicator(color = palette.ink, strokeWidth = 2.dp) }
		}
		LazyColumn(Modifier.weight(1f), contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 16.dp)) {
			items(model.vendors, key = { it.preset }) { vendor ->
				VendorRow(vendor) { picked = vendor }
			}
		}
	}
	picked?.let { vendor -> KeySheet(model, vendor) { picked = null } }
}

@Composable
fun VendorRow(vendor: Vendor, onClick: () -> Unit) {
	val palette = LocalPalette.current
	Row(
		Modifier
			.fillMaxWidth()
			.padding(vertical = 4.dp)
			.clip(RoundedCornerShape(16.dp))
			.background(palette.raised)
			.clickable(onClick = onClick)
			.padding(horizontal = 18.dp, vertical = 16.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		Box(Modifier.size(36.dp).clip(RoundedCornerShape(10.dp)).background(palette.raisedHigh), contentAlignment = Alignment.Center) {
			Text(vendor.name.take(1), style = MaterialTheme.typography.titleMedium)
		}
		Spacer(Modifier.width(14.dp))
		Text(vendor.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
		Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null, tint = palette.faint)
	}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun KeySheet(model: AppModel, vendor: Vendor, onDismiss: () -> Unit) {
	val palette = LocalPalette.current
	val context = LocalContext.current
	var key by remember { mutableStateOf("") }
	var error by remember { mutableStateOf<String?>(null) }
	var working by remember { mutableStateOf(false) }
	ModalBottomSheet(
		onDismissRequest = onDismiss,
		sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
		containerColor = palette.raised,
		contentColor = palette.text,
	) {
		Column(Modifier.padding(horizontal = 24.dp).padding(bottom = 24.dp).imePadding()) {
			Row(verticalAlignment = Alignment.CenterVertically) {
				Icon(Icons.Outlined.Key, null, tint = palette.muted)
				Spacer(Modifier.width(10.dp))
				Text("填入 ${vendor.name} 的 API Key", style = MaterialTheme.typography.titleLarge)
			}
			Spacer(Modifier.height(16.dp))
			OutlinedTextField(
				value = key,
				onValueChange = { key = it; error = null },
				placeholder = { Text("sk-…") },
				singleLine = true,
				visualTransformation = PasswordVisualTransformation(),
				keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
				isError = error != null,
				supportingText = error?.let { { Text(it) } },
				shape = RoundedCornerShape(14.dp),
				colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = palette.ink, unfocusedBorderColor = palette.line),
				modifier = Modifier.fillMaxWidth(),
			)
			if (vendor.signupUrl.isNotBlank()) {
				TextButton(onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(vendor.signupUrl))) }) {
					Text("还没有 Key？去 ${vendor.name} 申请", color = palette.link)
				}
			}
			Spacer(Modifier.height(12.dp))
			Button(
				onClick = {
					working = true
					model.addKey(vendor, key) { failed ->
						working = false
						if (failed == null) onDismiss() else error = failed
					}
				},
				enabled = key.isNotBlank() && !working,
				modifier = Modifier.fillMaxWidth().height(52.dp),
				shape = RoundedCornerShape(26.dp),
				colors = ButtonDefaults.buttonColors(containerColor = palette.ink, contentColor = palette.onInk),
			) {
				if (working) CircularProgressIndicator(Modifier.size(20.dp), color = palette.onInk, strokeWidth = 2.dp)
				else Text("连接", style = MaterialTheme.typography.titleMedium)
			}
		}
	}
}

@Composable
fun stringRes(id: Int): String = LocalContext.current.getString(id)
