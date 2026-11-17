package app.pimagpie.bot.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Alarm
import androidx.compose.material.icons.outlined.Bookmark
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.EditNote
import androidx.compose.material.icons.outlined.PushPin
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.AlertDialog
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.pimagpie.bot.AppModel
import app.pimagpie.bot.Screen
import app.pimagpie.bot.data.Chat

@Composable
fun Drawer(model: AppModel, close: () -> Unit) {
	val palette = LocalPalette.current
	var query by remember { mutableStateOf("") }
	var acting by remember { mutableStateOf<Chat?>(null) }
	val now = System.currentTimeMillis()
	val shown = model.chats.filter { query.isBlank() || it.title.contains(query.trim(), ignoreCase = true) }
	val groups = shown.groupBy { chat ->
		when {
			chat.pinned -> "置顶"
			else -> when (val days = -dayDiff(now, chat.updatedAt)) {
				0 -> "今天"
				1 -> "昨天"
				in 2..7 -> "7 天内"
				in 8..30 -> "30 天内"
				else -> "更早"
			}
		}
	}

	Column(Modifier.fillMaxHeight().width(316.dp).background(palette.ground).statusBarsPadding().navigationBarsPadding()) {
		Row(
			Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 8.dp)
				.height(44.dp).clip(RoundedCornerShape(22.dp)).background(palette.raised).padding(horizontal = 14.dp),
			verticalAlignment = Alignment.CenterVertically,
		) {
			Icon(Icons.Outlined.Search, null, Modifier.size(18.dp), tint = palette.muted)
			Spacer(Modifier.width(8.dp))
			Box(Modifier.weight(1f)) {
				if (query.isEmpty()) Text("搜索对话", style = MaterialTheme.typography.bodyMedium.copy(color = palette.faint))
				BasicTextField(
					query, { query = it },
					singleLine = true,
					textStyle = MaterialTheme.typography.bodyMedium.copy(color = palette.text),
					cursorBrush = SolidColor(palette.text),
					modifier = Modifier.fillMaxWidth(),
				)
			}
			if (query.isNotEmpty()) Icon(Icons.Outlined.Close, "清除", Modifier.size(18.dp).clickable { query = "" }, tint = palette.muted)
		}

		Nav(Icons.Outlined.EditNote, "新对话") { model.newChat(); close() }
		Nav(Icons.Outlined.Alarm, "提醒") { model.screen = Screen.Tasks; close() }
		Nav(Icons.Outlined.Bookmark, "记忆") { model.screen = Screen.Memory; close() }

		LazyColumn(Modifier.weight(1f).padding(top = 6.dp)) {
			if (shown.isEmpty()) {
				item {
					Text(
						if (query.isBlank()) "还没有对话" else "没找到",
						style = MaterialTheme.typography.bodyMedium.copy(color = palette.faint),
						modifier = Modifier.padding(horizontal = 24.dp, vertical = 16.dp),
					)
				}
			}
			groups.forEach { (label, chats) ->
				item(key = "h-$label") { SectionLabel(label, Modifier.padding(start = 4.dp)) }
				items(chats, key = { it.id }) { chat ->
					ChatRow(chat, selected = chat.id == model.current, busy = model.busy[chat.id] == true, onClick = { model.open(chat.id); close() }, onLongClick = { acting = chat })
				}
			}
		}

		Row(
			Modifier.fillMaxWidth().clickable { model.screen = Screen.Settings; close() }.padding(horizontal = 20.dp, vertical = 14.dp),
			verticalAlignment = Alignment.CenterVertically,
		) {
			Box(Modifier.size(34.dp).clip(CircleShape).background(palette.raisedHigh), contentAlignment = Alignment.Center) { Logo(18.dp) }
			Spacer(Modifier.width(12.dp))
			Column(Modifier.weight(1f)) {
				Text("我的助理", style = MaterialTheme.typography.titleMedium)
				Row(verticalAlignment = Alignment.CenterVertically) {
					Box(Modifier.size(6.dp).clip(CircleShape).background(if (model.connected) palette.live else palette.faint))
					Spacer(Modifier.width(6.dp))
					Text(if (model.connected) "在这台手机上运行" else "连接中", style = MaterialTheme.typography.bodySmall.copy(color = palette.muted))
				}
			}
			Icon(Icons.Outlined.Settings, "设置", tint = palette.muted)
		}
	}

	acting?.let { chat -> ChatActions(model, chat) { acting = null } }
}

@Composable
private fun Nav(icon: ImageVector, label: String, onClick: () -> Unit) {
	val palette = LocalPalette.current
	Row(
		Modifier.fillMaxWidth().padding(horizontal = 8.dp).clip(RoundedCornerShape(14.dp)).clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 12.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		Icon(icon, null, Modifier.size(21.dp), tint = palette.text)
		Spacer(Modifier.width(14.dp))
		Text(label, style = MaterialTheme.typography.titleMedium)
	}
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ChatRow(chat: Chat, selected: Boolean, busy: Boolean, onClick: () -> Unit, onLongClick: () -> Unit) {
	val palette = LocalPalette.current
	Row(
		Modifier
			.fillMaxWidth()
			.padding(horizontal = 8.dp)
			.clip(RoundedCornerShape(14.dp))
			.background(if (selected) palette.raised else palette.ground)
			.combinedClickable(onClick = onClick, onLongClick = onLongClick)
			.padding(horizontal = 14.dp, vertical = 11.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		Text(chat.title, style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
		if (busy) Box(Modifier.padding(start = 8.dp).size(6.dp).clip(CircleShape).background(palette.live))
	}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatActions(model: AppModel, chat: Chat, dismiss: () -> Unit) {
	val palette = LocalPalette.current
	var renaming by remember { mutableStateOf(false) }
	var deleting by remember { mutableStateOf(false) }
	if (!renaming && !deleting) {
		ModalBottomSheet(onDismissRequest = dismiss, containerColor = palette.raised, contentColor = palette.text) {
			Column(Modifier.padding(bottom = 24.dp)) {
				Text(chat.title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
				SheetRow(Icons.Outlined.Edit, "重命名") { renaming = true }
				SheetRow(Icons.Outlined.PushPin, if (chat.pinned) "取消置顶" else "置顶") { model.pin(chat); dismiss() }
				SheetRow(Icons.Outlined.Delete, "删除", danger = true) { deleting = true }
			}
		}
	}
	if (renaming) {
		var title by remember { mutableStateOf(chat.title) }
		AlertDialog(
			onDismissRequest = dismiss,
			containerColor = palette.raised,
			title = { Text("重命名") },
			text = {
				OutlinedTextField(
					title, { title = it }, singleLine = true, shape = RoundedCornerShape(12.dp),
					colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = palette.ink, unfocusedBorderColor = palette.line),
				)
			},
			confirmButton = { TextButton(onClick = { model.rename(chat, title); dismiss() }) { Text("好", color = palette.text) } },
			dismissButton = { TextButton(onClick = dismiss) { Text("取消", color = palette.muted) } },
		)
	}
	if (deleting) {
		AlertDialog(
			onDismissRequest = dismiss,
			containerColor = palette.raised,
			title = { Text("删除这段对话？") },
			text = { Text("对话和它设的提醒都会删掉，记忆不受影响。", color = palette.muted) },
			confirmButton = { TextButton(onClick = { model.delete(chat); dismiss() }) { Text("删除", color = palette.danger) } },
			dismissButton = { TextButton(onClick = dismiss) { Text("取消", color = palette.muted) } },
		)
	}
}

@Composable
fun SheetRow(icon: ImageVector, label: String, danger: Boolean = false, onClick: () -> Unit) {
	val palette = LocalPalette.current
	val color = if (danger) palette.danger else palette.text
	Row(
		Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 24.dp, vertical = 15.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		Icon(icon, null, Modifier.size(20.dp), tint = color)
		Spacer(Modifier.width(16.dp))
		Text(label, style = MaterialTheme.typography.bodyLarge.copy(color = color))
	}
}
