package app.pimagpie.bot.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.pimagpie.bot.data.FreeQuota
import app.pimagpie.bot.data.Vendor

/**
 * The page between "the free pool is out of quota" and "paste a key": which
 * vendors hand out an allowance, and how to get there. Every row carries its
 * own preset and signup address, so it opens the ordinary key sheet without
 * waiting on the vendor list and without advertising one magpie cannot add.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FreeQuotaSheet(onDismiss: () -> Unit, onPick: (Vendor) -> Unit) {
	val palette = LocalPalette.current
	val context = LocalContext.current
	ModalBottomSheet(onDismissRequest = onDismiss, containerColor = palette.ground, contentColor = palette.text) {
		LazyColumn(Modifier.padding(horizontal = 16.dp).padding(bottom = 24.dp)) {
			item {
				Text("免费额度怎么拿", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 8.dp, vertical = 8.dp))
				Text(
					"免费线路排队或者到量的时候，这几家注册就送额度。拿到 Key 回来填上，助理换个模型接着用。",
					style = MaterialTheme.typography.bodyMedium.copy(color = palette.muted),
					modifier = Modifier.padding(horizontal = 8.dp).padding(bottom = 12.dp),
				)
			}
			items(FreeQuota.entries, key = { it.preset }) { entry ->
				val vendor = Vendor(entry.preset, entry.name, entry.signup)
				Column(
					Modifier
						.fillMaxWidth()
						.padding(vertical = 4.dp)
						.clip(RoundedCornerShape(16.dp))
						.background(palette.raised)
						.padding(horizontal = 16.dp, vertical = 14.dp),
				) {
					Row(verticalAlignment = Alignment.CenterVertically) {
						Text(entry.name, style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
						Text(
							if (entry.direct) "国内直连" else "需要代理",
							style = MaterialTheme.typography.labelMedium.copy(color = palette.faint),
						)
					}
					Spacer(Modifier.height(4.dp))
					Text(entry.note, style = MaterialTheme.typography.bodySmall.copy(color = palette.muted))
					Row(Modifier.padding(top = 2.dp)) {
						TextButton(onClick = {
							runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(vendor.signupUrl))) }
						}) { Text("去注册", color = palette.link) }
						TextButton(onClick = { onPick(vendor) }) { Text("填 Key", color = palette.link) }
					}
				}
			}
		}
	}
}
