package app.pimagpie.bot.ui

import android.content.Intent
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Alarm
import androidx.compose.material.icons.outlined.BatteryChargingFull
import androidx.compose.material.icons.outlined.Bookmark
import androidx.compose.material.icons.outlined.CalendarMonth
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Memory
import androidx.compose.material.icons.outlined.Repeat
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.pimagpie.bot.AppModel
import app.pimagpie.bot.BuildConfig
import app.pimagpie.bot.Logs
import app.pimagpie.bot.Screen
import app.pimagpie.bot.data.Note
import app.pimagpie.bot.data.Vendor
import java.util.Calendar

// Reminders ------------------------------------------------------------------

@Composable
fun TasksScreen(model: AppModel) {
	val palette = LocalPalette.current
	var adding by remember { mutableStateOf(false) }
	LaunchedEffect(Unit) { model.loadSchedules() }
	val titles = model.chats.associate { it.id to it.title }
	Column(Modifier.fillMaxSize().background(palette.ground).navigationBarsPadding()) {
		TopBar("提醒", onBack = { model.screen = Screen.Chat }) {
			IconButton(onClick = { adding = true }) { Icon(Icons.Outlined.Add, "新提醒") }
		}
		if (model.schedules.isEmpty()) {
			Empty(Icons.Outlined.Alarm, "还没有提醒", "在对话里说「明早 7 点叫我起床」，或者点右上角加一个。")
		}
		LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
			items(model.schedules, key = { it.id }) { schedule ->
				Row(
					Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(palette.raised).padding(start = 18.dp, top = 14.dp, bottom = 14.dp, end = 6.dp),
					verticalAlignment = Alignment.CenterVertically,
				) {
					Column(Modifier.weight(1f)) {
						Text(whenText(schedule.nextRunAt), style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold))
						Spacer(Modifier.height(4.dp))
						Text(schedule.text, style = MaterialTheme.typography.bodyMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
						val meta = listOfNotNull(everyText(schedule.everyMs), titles[schedule.chat]?.let { "来自「$it」" }).joinToString(" · ")
						if (meta.isNotEmpty()) {
							Spacer(Modifier.height(6.dp))
							Text(meta, style = MaterialTheme.typography.bodySmall.copy(color = palette.muted), maxLines = 1, overflow = TextOverflow.Ellipsis)
						}
					}
					IconButton(onClick = { model.deleteSchedule(schedule) }) { Icon(Icons.Outlined.Delete, "删除", tint = palette.muted) }
				}
			}
		}
	}
	if (adding) AddReminder(model) { adding = false }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AddReminder(model: AppModel, dismiss: () -> Unit) {
	val palette = LocalPalette.current
	var text by remember { mutableStateOf("") }
	var at by remember { mutableLongStateOf(System.currentTimeMillis() + 10 * 60_000L) }
	var every by remember { mutableStateOf<Long?>(null) }
	var pickingDate by remember { mutableStateOf(false) }
	var pickingTime by remember { mutableStateOf(false) }

	fun today(hour: Int, plusDays: Int = 0): Long = Calendar.getInstance().apply {
		add(Calendar.DAY_OF_YEAR, plusDays)
		set(Calendar.HOUR_OF_DAY, hour); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
	}.timeInMillis

	ModalBottomSheet(onDismissRequest = dismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = palette.raised, contentColor = palette.text) {
		Column(Modifier.padding(horizontal = 24.dp).padding(bottom = 24.dp).imePadding()) {
			Text("新提醒", style = MaterialTheme.typography.titleLarge)
			Spacer(Modifier.height(14.dp))
			OutlinedTextField(
				text, { text = it },
				placeholder = { Text("到点提醒我什么？") },
				shape = RoundedCornerShape(14.dp),
				colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = palette.ink, unfocusedBorderColor = palette.line),
				modifier = Modifier.fillMaxWidth(),
			)
			Spacer(Modifier.height(14.dp))
			Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
				val now = System.currentTimeMillis()
				Choice("10 分钟后", false) { at = System.currentTimeMillis() + 10 * 60_000L }
				Choice("1 小时后", false) { at = System.currentTimeMillis() + 60 * 60_000L }
				Choice("今晚 8 点", false) { at = today(20).let { if (it < now) today(20, 1) else it } }
				Choice("明早 8 点", false) { at = today(8, 1) }
			}
			Spacer(Modifier.height(12.dp))
			Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
				Field(Icons.Outlined.CalendarMonth, whenText(at).substringBeforeLast(' '), Modifier.weight(1f)) { pickingDate = true }
				Field(Icons.Outlined.Schedule, whenText(at).substringAfterLast(' '), Modifier.weight(1f)) { pickingTime = true }
			}
			Spacer(Modifier.height(12.dp))
			Row(verticalAlignment = Alignment.CenterVertically) {
				Icon(Icons.Outlined.Repeat, null, Modifier.size(18.dp), tint = palette.muted)
				Spacer(Modifier.width(8.dp))
				Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
					Choice("不重复", every == null) { every = null }
					Choice("每天", every == 86_400_000L) { every = 86_400_000L }
					Choice("每周", every == 7 * 86_400_000L) { every = 7 * 86_400_000L }
					Choice("每小时", every == 3_600_000L) { every = 3_600_000L }
				}
			}
			Spacer(Modifier.height(20.dp))
			Button(
				onClick = { model.addSchedule(text.trim(), at, every); dismiss() },
				enabled = text.isNotBlank() && at > System.currentTimeMillis(),
				modifier = Modifier.fillMaxWidth().height(52.dp),
				shape = RoundedCornerShape(26.dp),
				colors = ButtonDefaults.buttonColors(containerColor = palette.ink, contentColor = palette.onInk),
			) { Text("设好", style = MaterialTheme.typography.titleMedium) }
		}
	}

	if (pickingDate) {
		val state = rememberDatePickerState(initialSelectedDateMillis = at)
		DatePickerDialog(
			onDismissRequest = { pickingDate = false },
			confirmButton = {
				TextButton(onClick = {
					state.selectedDateMillis?.let { picked ->
						// The picker answers in UTC midnight; keep the time of day already chosen.
						val day = Calendar.getInstance(java.util.TimeZone.getTimeZone("UTC")).apply { timeInMillis = picked }
						at = Calendar.getInstance().apply {
							timeInMillis = at
							set(day.get(Calendar.YEAR), day.get(Calendar.MONTH), day.get(Calendar.DAY_OF_MONTH))
						}.timeInMillis
					}
					pickingDate = false
				}) { Text("好", color = palette.text) }
			},
		) { DatePicker(state) }
	}
	if (pickingTime) {
		val calendar = Calendar.getInstance().apply { timeInMillis = at }
		val state = rememberTimePickerState(calendar.get(Calendar.HOUR_OF_DAY), calendar.get(Calendar.MINUTE), is24Hour = true)
		AlertDialog(
			onDismissRequest = { pickingTime = false },
			containerColor = palette.raised,
			confirmButton = {
				TextButton(onClick = {
					at = Calendar.getInstance().apply {
						timeInMillis = at
						set(Calendar.HOUR_OF_DAY, state.hour); set(Calendar.MINUTE, state.minute); set(Calendar.SECOND, 0)
					}.timeInMillis
					pickingTime = false
				}) { Text("好", color = palette.text) }
			},
			text = { TimePicker(state) },
		)
	}
}

@Composable
private fun Choice(label: String, on: Boolean, onClick: () -> Unit) {
	val palette = LocalPalette.current
	Text(
		label,
		style = MaterialTheme.typography.labelLarge.copy(color = if (on) palette.onInk else palette.text),
		modifier = Modifier
			.clip(RoundedCornerShape(18.dp))
			.background(if (on) palette.ink else palette.raisedHigh)
			.clickable(onClick = onClick)
			.padding(horizontal = 14.dp, vertical = 9.dp),
	)
}

@Composable
private fun Field(icon: ImageVector, label: String, modifier: Modifier, onClick: () -> Unit) {
	val palette = LocalPalette.current
	Row(
		modifier.clip(RoundedCornerShape(14.dp)).border(1.dp, palette.line, RoundedCornerShape(14.dp)).clickable(onClick = onClick).padding(horizontal = 14.dp, vertical = 14.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		Icon(icon, null, Modifier.size(18.dp), tint = palette.muted)
		Spacer(Modifier.width(8.dp))
		Text(label, style = MaterialTheme.typography.bodyLarge)
	}
}

// Memory ---------------------------------------------------------------------

@Composable
fun MemoryScreen(model: AppModel) {
	val palette = LocalPalette.current
	var editing by remember { mutableStateOf<Note?>(null) }
	LaunchedEffect(Unit) { model.loadNotes() }
	Column(Modifier.fillMaxSize().background(palette.ground).navigationBarsPadding()) {
		TopBar("记忆", onBack = { model.screen = Screen.Chat }) {
			IconButton(onClick = { editing = Note("", "") }) { Icon(Icons.Outlined.Add, "新记忆") }
		}
		Text(
			"助理记住的关于你的事。每段对话都能用到，你可以改，也可以删。",
			style = MaterialTheme.typography.bodySmall.copy(color = palette.muted),
			modifier = Modifier.padding(horizontal = 20.dp),
		)
		if (model.notes.isEmpty()) {
			Empty(Icons.Outlined.Bookmark, "还没记住什么", "在对话里说「记住：……」，它就会记下来。")
		}
		LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
			items(model.notes, key = { it.name }) { note ->
				Column(
					Modifier.fillMaxWidth().clip(RoundedCornerShape(18.dp)).background(palette.raised).clickable { editing = note }.padding(18.dp),
				) {
					Text(note.name, style = MaterialTheme.typography.titleMedium)
					Spacer(Modifier.height(4.dp))
					Text(note.content.trim(), style = MaterialTheme.typography.bodyMedium.copy(color = palette.muted), maxLines = 3, overflow = TextOverflow.Ellipsis)
				}
			}
		}
	}
	editing?.let { note -> NoteEditor(model, note) { editing = null } }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NoteEditor(model: AppModel, note: Note, dismiss: () -> Unit) {
	val palette = LocalPalette.current
	val fresh = note.name.isEmpty()
	var name by remember { mutableStateOf(note.name) }
	var content by remember { mutableStateOf(note.content) }
	val colors = OutlinedTextFieldDefaults.colors(focusedBorderColor = palette.ink, unfocusedBorderColor = palette.line)
	ModalBottomSheet(onDismissRequest = dismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = palette.raised, contentColor = palette.text) {
		Column(Modifier.padding(horizontal = 24.dp).padding(bottom = 24.dp).imePadding()) {
			Text(if (fresh) "新记忆" else "改记忆", style = MaterialTheme.typography.titleLarge)
			Spacer(Modifier.height(14.dp))
			if (fresh) {
				OutlinedTextField(name, { name = it }, placeholder = { Text("标题，比如「饮食」") }, singleLine = true, shape = RoundedCornerShape(14.dp), colors = colors, modifier = Modifier.fillMaxWidth())
				Spacer(Modifier.height(10.dp))
			}
			OutlinedTextField(
				content, { content = it },
				placeholder = { Text("要记住的内容") },
				shape = RoundedCornerShape(14.dp), colors = colors,
				modifier = Modifier.fillMaxWidth().heightIn(min = 140.dp, max = 320.dp),
			)
			Spacer(Modifier.height(18.dp))
			Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
				if (!fresh) {
					TextButton(onClick = { model.deleteNote(note); dismiss() }, modifier = Modifier.height(52.dp)) {
						Icon(Icons.Outlined.Delete, null, tint = palette.danger)
						Spacer(Modifier.width(6.dp))
						Text("删除", color = palette.danger)
					}
				}
				Button(
					onClick = { model.saveNote(name.trim(), content); dismiss() },
					enabled = name.isNotBlank() && content.isNotBlank(),
					modifier = Modifier.weight(1f).height(52.dp),
					shape = RoundedCornerShape(26.dp),
					colors = ButtonDefaults.buttonColors(containerColor = palette.ink, contentColor = palette.onInk),
				) { Text("保存", style = MaterialTheme.typography.titleMedium) }
			}
		}
	}
}

// Settings -------------------------------------------------------------------

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(model: AppModel) {
	val palette = LocalPalette.current
	val context = LocalContext.current
	var choosingModel by remember { mutableStateOf(false) }
	var choosingVendor by remember { mutableStateOf(false) }
	var vendor by remember { mutableStateOf<Vendor?>(null) }
	var showLog by remember { mutableStateOf(false) }
	val power = remember { context.getSystemService(PowerManager::class.java) }
	var unrestricted by remember { mutableStateOf(power.isIgnoringBatteryOptimizations(context.packageName)) }

	Column(Modifier.fillMaxSize().background(palette.ground).navigationBarsPadding()) {
		TopBar("设置", onBack = { model.screen = Screen.Chat })
		Column(Modifier.verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
			SectionLabel("外观")
			Row(Modifier.padding(horizontal = 16.dp).fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(palette.raised).padding(4.dp)) {
				listOf(ThemeMode.System to "跟随系统", ThemeMode.Dark to "深色", ThemeMode.Light to "浅色").forEach { (mode, label) ->
					val on = model.themeMode == mode
					Box(
						Modifier.weight(1f).clip(RoundedCornerShape(12.dp)).background(if (on) palette.raisedHigh else palette.raised).clickable { model.setTheme(mode) }.padding(vertical = 11.dp),
						contentAlignment = Alignment.Center,
					) { Text(label, style = MaterialTheme.typography.labelLarge.copy(color = if (on) palette.text else palette.muted)) }
				}
			}

			SectionLabel("模型")
			Group {
				Item(Icons.Outlined.Memory, "默认模型", model.models.firstOrNull { it.id == model.defaultModel }?.name?.let(::shortModel) ?: "自动") { choosingModel = true }
				Item(Icons.Outlined.Key, "添加模型服务商", "填自己的 API Key，用更强的模型") { model.loadVendors(); choosingVendor = true }
			}

			SectionLabel("后台")
			Group {
				Item(
					Icons.Outlined.BatteryChargingFull, "不受省电限制",
					if (unrestricted) "已允许，提醒能按时到" else "未允许：手机可能把助理关掉，提醒会迟到",
				) {
					runCatching {
						context.startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}")))
					}.onFailure { context.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)) }
					unrestricted = power.isIgnoringBatteryOptimizations(context.packageName)
				}
				Item(Icons.Outlined.Alarm, "提醒", "查看、删除到点的提醒") { model.screen = Screen.Tasks }
				Item(Icons.Outlined.Bookmark, "记忆", "助理记住的关于你的事") { model.screen = Screen.Memory }
			}

			SectionLabel("关于")
			Group {
				Item(Icons.Outlined.Info, "版本", "${BuildConfig.VERSION_NAME} · 数据只在这台手机上", arrow = false) {}
				Item(Icons.Outlined.Terminal, "运行日志", "出问题时给开发者看") { showLog = true }
			}
		}
	}

	if (choosingModel) {
		ModalBottomSheet(onDismissRequest = { choosingModel = false }, containerColor = palette.raised, contentColor = palette.text) {
			LazyColumn(Modifier.padding(bottom = 24.dp)) {
				item { Text("默认模型", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp)) }
				items(model.models, key = { it.id }) { info ->
					Row(
						Modifier.fillMaxWidth().clickable { model.setDefault(info.id); choosingModel = false }.padding(horizontal = 24.dp, vertical = 15.dp),
						verticalAlignment = Alignment.CenterVertically,
					) {
						Text(shortModel(info.name), style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
						if (info.id == model.defaultModel) Icon(Icons.Outlined.Check, null)
					}
				}
			}
		}
	}
	if (choosingVendor) {
		ModalBottomSheet(onDismissRequest = { choosingVendor = false }, containerColor = palette.ground, contentColor = palette.text) {
			LazyColumn(Modifier.padding(horizontal = 16.dp).padding(bottom = 24.dp)) {
				item { Text("选一家服务商", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 8.dp, vertical = 8.dp)) }
				items(model.vendors, key = { it.preset }) { item -> VendorRow(item) { vendor = item; choosingVendor = false } }
			}
		}
	}
	vendor?.let { KeySheet(model, it) { vendor = null } }
	if (showLog) {
		AlertDialog(
			onDismissRequest = { showLog = false },
			containerColor = palette.raised,
			confirmButton = { TextButton(onClick = { showLog = false }) { Text("关闭", color = palette.text) } },
			title = { Text("运行日志") },
			text = {
				Text(
					Logs.tail(),
					style = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace, fontSize = 10.sp),
					modifier = Modifier.heightIn(max = 420.dp).verticalScroll(rememberScrollState()),
				)
			},
		)
	}
}

@Composable
private fun Group(content: @Composable () -> Unit) {
	val palette = LocalPalette.current
	Column(Modifier.padding(horizontal = 16.dp).fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(palette.raised)) { content() }
}

@Composable
private fun Item(icon: ImageVector, title: String, detail: String, arrow: Boolean = true, onClick: () -> Unit) {
	val palette = LocalPalette.current
	Row(
		Modifier.fillMaxWidth().clickable(enabled = arrow, onClick = onClick).padding(horizontal = 16.dp, vertical = 14.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		Icon(icon, null, Modifier.size(22.dp), tint = palette.text)
		Spacer(Modifier.width(14.dp))
		Column(Modifier.weight(1f)) {
			Text(title, style = MaterialTheme.typography.bodyLarge)
			Text(detail, style = MaterialTheme.typography.bodySmall.copy(color = palette.muted))
		}
		if (arrow) Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null, tint = palette.faint)
	}
}

@Composable
private fun Empty(icon: ImageVector, title: String, detail: String) {
	val palette = LocalPalette.current
	Column(Modifier.fillMaxWidth().padding(horizontal = 40.dp, vertical = 64.dp), horizontalAlignment = Alignment.CenterHorizontally) {
		Icon(icon, null, Modifier.size(40.dp), tint = palette.faint)
		Spacer(Modifier.height(14.dp))
		Text(title, style = MaterialTheme.typography.titleMedium)
		Spacer(Modifier.height(6.dp))
		Text(detail, style = MaterialTheme.typography.bodyMedium.copy(color = palette.muted, textAlign = androidx.compose.ui.text.style.TextAlign.Center))
	}
}
