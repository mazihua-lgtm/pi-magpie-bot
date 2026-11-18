package app.pimagpie.bot.ui

import android.Manifest
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.QrCodeScanner
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import app.pimagpie.bot.AppModel
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions

/**
 * Connect this phone to an assistant on another machine. The QR on the
 * computer's chat page carries a one-time code; scanning it (or pasting the
 * link by hand, for a phone with no camera) trades that code for a signed
 * session. Nothing here stores the password.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PairSheet(model: AppModel, onDismiss: () -> Unit) {
	val palette = LocalPalette.current
	val context = LocalContext.current
	var manual by remember { mutableStateOf("") }
	var working by remember { mutableStateOf(false) }
	var error by remember { mutableStateOf<String?>(null) }

	fun connect(link: String) {
		working = true
		error = null
		model.pair(link) { failed ->
			working = false
			if (failed == null) {
				Toast.makeText(context, "连上了", Toast.LENGTH_SHORT).show()
				onDismiss()
			} else {
				// Keep the reason on screen: a toast vanishes before anyone can
				// read a long error on a phone.
				error = failed
			}
		}
	}

	val scan = rememberLauncherForActivityResult(ScanContract()) { result ->
		val text = result.contents
		if (!text.isNullOrBlank()) connect(text)
	}
	val askCamera = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
		if (granted) scan.launch(ScanOptions().apply { setDesiredBarcodeFormats(ScanOptions.QR_CODE); setPrompt("对准电脑上的二维码"); setBeepEnabled(false) })
		else Toast.makeText(context, "要扫码得先给相机权限；也可以手动贴链接", Toast.LENGTH_LONG).show()
	}

	ModalBottomSheet(onDismissRequest = onDismiss, containerColor = palette.ground, contentColor = palette.text) {
		Column(Modifier.padding(horizontal = 20.dp).padding(bottom = 24.dp).imePadding()) {
			Text("连接远程助理", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(vertical = 8.dp))
			Text(
				"在电脑上的喜鹊网页点「配对手机」，扫它的二维码；这台手机以后就连那台电脑上的助理，不用在自己这儿跑模型。两台设备要在同一个 WiFi。",
				style = MaterialTheme.typography.bodyMedium.copy(color = palette.muted),
			)
			Spacer(Modifier.height(16.dp))
			Row(
				Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).background(palette.raised).clickable {
					askCamera.launch(Manifest.permission.CAMERA)
				}.padding(horizontal = 16.dp, vertical = 16.dp),
				verticalAlignment = Alignment.CenterVertically,
			) {
				Icon(Icons.Outlined.QrCodeScanner, null, tint = palette.ink)
				Spacer(Modifier.padding(horizontal = 8.dp))
				Column {
					Text("扫一扫", style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold))
					Text("打开相机，对准电脑屏幕", style = MaterialTheme.typography.bodySmall.copy(color = palette.muted))
				}
			}
			Spacer(Modifier.height(12.dp))
			Text("没有相机？把二维码里的链接贴过来：", style = MaterialTheme.typography.bodySmall.copy(color = palette.muted))
			Spacer(Modifier.height(8.dp))
			OutlinedTextField(
				value = manual,
				onValueChange = { manual = it },
				placeholder = { Text("http://192.168.1.9:8787/pair/ABC123") },
				singleLine = true,
				shape = RoundedCornerShape(14.dp),
				colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = palette.ink, unfocusedBorderColor = palette.line),
				modifier = Modifier.fillMaxWidth(),
			)
			Spacer(Modifier.height(10.dp))
			TextButton(
				onClick = { if (manual.isNotBlank() && !working) connect(manual) },
				enabled = manual.isNotBlank() && !working,
				modifier = Modifier.align(Alignment.End),
			) { Text(if (working) "连接中…" else "连接", color = palette.link) }
			if (error != null) {
				Spacer(Modifier.height(6.dp))
				Text(error!!, style = MaterialTheme.typography.bodySmall.copy(color = palette.danger))
			}
			Text(
				"配对码 5 分钟有效、用一次就作废。二维码里不含密码。",
				style = MaterialTheme.typography.bodySmall.copy(color = palette.faint),
				modifier = Modifier.padding(top = 10.dp),
			)
		}
	}
}
