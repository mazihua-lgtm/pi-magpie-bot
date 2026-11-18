package app.pimagpie.bot.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import app.pimagpie.bot.AppModel

/**
 * Anything OpenAI-compatible: a relay someone subscribes to, a vendor the list
 * has never heard of, a model server on the home network. Three fields and a
 * key are enough, because that is what magpie needs to add a vendor of its own.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CustomProviderSheet(model: AppModel, onDismiss: () -> Unit) {
	val palette = LocalPalette.current
	var name by remember { mutableStateOf("") }
	var url by remember { mutableStateOf("") }
	var models by remember { mutableStateOf("") }
	var key by remember { mutableStateOf("") }
	var error by remember { mutableStateOf<String?>(null) }
	var working by remember { mutableStateOf(false) }
	val ready = name.isNotBlank() && url.isNotBlank() && models.isNotBlank() && !working

	ModalBottomSheet(
		onDismissRequest = onDismiss,
		sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
		containerColor = palette.raised,
		contentColor = palette.text,
	) {
		Column(
			Modifier
				.padding(horizontal = 24.dp)
				.padding(bottom = 24.dp)
				.imePadding()
				.verticalScroll(rememberScrollState()),
		) {
			Row(verticalAlignment = Alignment.CenterVertically) {
				Icon(Icons.Outlined.Tune, null, tint = palette.muted)
				Spacer(Modifier.size(10.dp))
				Text("接入自己的接口", style = MaterialTheme.typography.titleLarge)
			}
			Spacer(Modifier.height(8.dp))
			Text(
				"只要对方是 OpenAI 兼容接口就行：中转站、公司的私有部署、家里电脑上的模型都算。模型名照对方文档写，多个用逗号隔开。",
				style = MaterialTheme.typography.bodyMedium.copy(color = palette.muted),
			)
			Spacer(Modifier.height(16.dp))
			Field("名字", name, { name = it; error = null }, "给它在列表里显示的名字，比如「家里的显卡」")
			Spacer(Modifier.height(10.dp))
			Field("接口地址", url, { url = it; error = null }, "https://api.example.com/v1", keyboard = KeyboardType.Uri)
			Spacer(Modifier.height(10.dp))
			Field("模型", models, { models = it; error = null }, "gpt-5, claude-sonnet-5-5")
			Spacer(Modifier.height(10.dp))
			Field("Key", key, { key = it; error = null }, "magpie 要求必填；真不要 key 就填 none", keyboard = KeyboardType.Password, secret = true)
			if (error != null) {
				Spacer(Modifier.height(8.dp))
				Text(error!!, style = MaterialTheme.typography.bodySmall.copy(color = palette.danger))
			}
			Spacer(Modifier.height(16.dp))
			Button(
				onClick = {
					working = true
					model.addCustomProvider(name, url, models, key) { failed ->
						working = false
						if (failed == null) onDismiss() else error = failed
					}
				},
				enabled = ready,
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
private fun Field(
	label: String,
	value: String,
	onChange: (String) -> Unit,
	hint: String,
	keyboard: KeyboardType = KeyboardType.Text,
	secret: Boolean = false,
) {
	val palette = LocalPalette.current
	OutlinedTextField(
		value = value,
		onValueChange = onChange,
		label = { Text(label) },
		placeholder = { Text(hint, style = MaterialTheme.typography.bodySmall.copy(color = palette.faint)) },
		singleLine = true,
		keyboardOptions = KeyboardOptions(keyboardType = keyboard),
		visualTransformation = if (secret) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
		shape = RoundedCornerShape(14.dp),
		colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = palette.ink, unfocusedBorderColor = palette.line),
		modifier = Modifier.fillMaxWidth().background(palette.raised),
	)
}
