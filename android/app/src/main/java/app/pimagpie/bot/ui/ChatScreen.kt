package app.pimagpie.bot.ui

import android.app.Activity
import android.content.Intent
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.VolumeUp
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Alarm
import androidx.compose.material.icons.outlined.ArrowUpward
import androidx.compose.material.icons.outlined.Bookmark
import androidx.compose.material.icons.outlined.Build
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.EditNote
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Language
import androidx.compose.material.icons.outlined.Lightbulb
import androidx.compose.material.icons.outlined.Menu
import androidx.compose.material.icons.outlined.Mic
import androidx.compose.material.icons.outlined.Public
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Share
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.StopCircle
import androidx.compose.material.icons.rounded.KeyboardArrowDown
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.pimagpie.bot.AppModel
import app.pimagpie.bot.data.Approval
import app.pimagpie.bot.data.Message
import app.pimagpie.bot.data.Partial
import app.pimagpie.bot.data.ToolUse

/** One row of the list, newest first (the list is drawn bottom-up). */
private sealed interface Line {
	val key: String

	data class Said(val message: Message) : Line {
		override val key get() = message.id
	}

	data class Live(val partial: Partial?) : Line {
		override val key get() = "live"
	}

	data class Ask(val approval: Approval) : Line {
		override val key get() = "approval-${approval.id}"
	}
}

@Composable
fun ChatScreen(model: AppModel, onMenu: () -> Unit) {
	val palette = LocalPalette.current
	val chat = model.currentChat
	val key = model.current ?: AppModel.PENDING
	val messages = model.messages[key].orEmpty()
	val busy = model.busy[key] == true
	val partial = model.partials[key]
	val approvals = model.approvals.filter { it.chat == key }
	var picking by remember { mutableStateOf(false) }

	val rows = buildList<Line> {
		approvals.forEach { add(Line.Ask(it)) }
		if (busy) add(Line.Live(partial))
		messages.asReversed().forEach { add(Line.Said(it)) }
	}
	val list = rememberLazyListState()
	LaunchedEffect(model.current) { list.scrollToItem(0) }
	LaunchedEffect(rows.size) { if (list.firstVisibleItemIndex <= 1) list.animateScrollToItem(0) }

	Column(Modifier.fillMaxSize().background(palette.ground).statusBarsPadding().navigationBarsPadding().imePadding()) {
		// The bar: menu, the model in use (tap to change), and a new chat.
		Row(Modifier.fillMaxWidth().height(56.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
			IconButton(onClick = onMenu) { Icon(Icons.Outlined.Menu, "对话列表") }
			Box(Modifier.weight(1f), contentAlignment = Alignment.Center) {
				Column(horizontalAlignment = Alignment.CenterHorizontally) {
					Row(
						Modifier.clip(RoundedCornerShape(20.dp)).clickable { picking = true }.padding(horizontal = 12.dp, vertical = 6.dp),
						verticalAlignment = Alignment.CenterVertically,
					) {
						Text(
							model.modelFor(chat)?.name?.let(::shortModel) ?: "喜鹊",
							style = MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold),
							maxLines = 1, overflow = TextOverflow.Ellipsis,
							modifier = Modifier.widthIn(max = 200.dp),
						)
						Icon(Icons.Rounded.KeyboardArrowDown, null, Modifier.size(20.dp), tint = palette.muted)
					}
					if (!model.connected) Text("正在连接…", style = MaterialTheme.typography.labelMedium.copy(color = palette.faint, fontSize = 11.sp))
				}
			}
			IconButton(onClick = { model.newChat() }) { Icon(Icons.Outlined.EditNote, "新对话") }
		}

		Box(Modifier.weight(1f).fillMaxWidth()) {
			if (rows.isEmpty() && !model.loading) {
				Welcome(onPick = { model.send(it) })
			} else if (model.loading && rows.isEmpty()) {
				Centered(Modifier.fillMaxSize()) { CircularProgressIndicator(color = palette.muted, strokeWidth = 2.dp, modifier = Modifier.size(24.dp)) }
			} else {
				LazyColumn(
					state = list,
					reverseLayout = true,
					modifier = Modifier.fillMaxSize(),
					contentPadding = PaddingValues(start = 18.dp, end = 18.dp, top = 12.dp, bottom = 12.dp),
					verticalArrangement = Arrangement.spacedBy(18.dp, Alignment.Bottom),
				) {
					items(rows, key = { it.key }) { row ->
						when (row) {
							is Line.Said -> when {
								row.message.text.startsWith("⏰") -> Fired(row.message.text.removePrefix("⏰").trim())
								row.message.role == Message.Role.Assistant -> Answer(model, row.message)
								else -> UserBubble(model, row.message)
							}
							is Line.Live -> Live(row.partial)
							is Line.Ask -> ApprovalCard(row.approval, onAnswer = { allow -> model.answer(row.approval, allow) })
						}
					}
				}
			}
		}

		Composer(model, busy)
	}

	if (picking) ModelSheet(model) { picking = false }
}

/** "deepseek/deepseek-chat" reads as "deepseek-chat" in a title bar. */
fun shortModel(name: String): String {
	val short = name.substringAfterLast('/').ifBlank { name }
	return if (short.equals("free", true) || short.endsWith("-free", true)) "免费模型" else short
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Welcome(onPick: (String) -> Unit) {
	val palette = LocalPalette.current
	val ideas = listOf(
		Triple(Icons.Outlined.Alarm, "十分钟后提醒我关火", "定时提醒"),
		Triple(Icons.Outlined.Public, "今天有什么重要新闻？", "联网搜索"),
		Triple(Icons.Outlined.Bookmark, "记住：我对花生过敏", "长期记忆"),
		Triple(Icons.Outlined.Lightbulb, "帮我想个周末带娃去哪的计划", "出主意"),
	)
	Column(Modifier.fillMaxSize().padding(horizontal = 20.dp), horizontalAlignment = Alignment.CenterHorizontally) {
		Spacer(Modifier.weight(1f))
		Logo(52.dp)
		Spacer(Modifier.height(18.dp))
		Text("有什么可以帮你？", style = MaterialTheme.typography.headlineMedium)
		Spacer(Modifier.weight(1f))
		FlowRow(
			Modifier.fillMaxWidth(),
			horizontalArrangement = Arrangement.spacedBy(10.dp),
			verticalArrangement = Arrangement.spacedBy(10.dp),
			maxItemsInEachRow = 2,
		) {
			ideas.forEach { (icon, text, kind) ->
				Column(
					Modifier
						.weight(1f)
						.height(96.dp)
						.clip(RoundedCornerShape(18.dp))
						.border(1.dp, palette.line, RoundedCornerShape(18.dp))
						.clickable { onPick(text) }
						.padding(14.dp),
				) {
					Row(verticalAlignment = Alignment.CenterVertically) {
						Icon(icon, null, Modifier.size(16.dp), tint = palette.muted)
						Spacer(Modifier.width(6.dp))
						Text(kind, style = MaterialTheme.typography.labelMedium.copy(color = palette.muted))
					}
					Spacer(Modifier.height(6.dp))
					Text(text, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
				}
			}
		}
		Spacer(Modifier.height(12.dp))
	}
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun UserBubble(model: AppModel, message: Message) {
	val palette = LocalPalette.current
	val clipboard = LocalClipboardManager.current
	val haptics = LocalHapticFeedback.current
	Column(Modifier.fillMaxWidth(), horizontalAlignment = Alignment.End) {
		if (message.images.isNotEmpty()) {
			Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(bottom = 6.dp)) {
				message.images.forEach { uri ->
					decodeDataUri(uri)?.let {
						Image(it, null, Modifier.size(120.dp).clip(RoundedCornerShape(14.dp)), contentScale = ContentScale.Crop)
					}
				}
			}
		}
		if (message.text.isNotBlank()) {
			Text(
				message.text,
				style = MaterialTheme.typography.bodyLarge,
				modifier = Modifier
					.widthIn(max = 320.dp)
					.clip(RoundedCornerShape(22.dp, 22.dp, 6.dp, 22.dp))
					.background(palette.raisedHigh)
					.combinedClickable(onClick = {}, onLongClick = {
						haptics.performHapticFeedback(HapticFeedbackType.LongPress)
						clipboard.setText(AnnotatedString(message.text))
						model.say("已复制")
					})
					.padding(horizontal = 16.dp, vertical = 10.dp)
					.alpha(if (message.local) 0.75f else 1f),
			)
		}
	}
}

/** A reminder coming due: an event in the chat, not a line of the conversation. */
@Composable
private fun Fired(text: String) {
	val palette = LocalPalette.current
	Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
		Row(
			Modifier.clip(RoundedCornerShape(16.dp)).border(1.dp, palette.line, RoundedCornerShape(16.dp)).padding(horizontal = 14.dp, vertical = 8.dp),
			verticalAlignment = Alignment.CenterVertically,
		) {
			Icon(Icons.Outlined.Alarm, null, Modifier.size(16.dp), tint = palette.text)
			Spacer(Modifier.width(8.dp))
			Text(text, style = MaterialTheme.typography.bodyMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
		}
	}
}

@Composable
private fun Answer(model: AppModel, message: Message) {
	val palette = LocalPalette.current
	val clipboard = LocalClipboardManager.current
	val context = LocalContext.current
	Column(Modifier.fillMaxWidth()) {
		if (message.thinking.isNotBlank()) Thinking(message.thinking, live = false)
		if (message.tools.isNotEmpty()) Tools(message.tools, live = false)
		SelectionContainer { Markdown(message.text) }
		if (message.text.isNotBlank()) Row(Modifier.padding(top = 2.dp).offset(x = (-8).dp), verticalAlignment = Alignment.CenterVertically) {
			Action(Icons.Outlined.ContentCopy, "复制") {
				clipboard.setText(AnnotatedString(message.text))
				model.say("已复制")
			}
			Action(Icons.Outlined.Share, "分享") {
				val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, message.text)
				context.startActivity(Intent.createChooser(send, "分享"))
			}
			Action(if (model.speaking == message.id) Icons.Outlined.StopCircle else Icons.AutoMirrored.Outlined.VolumeUp, "朗读") {
				model.speak(message.id, message.text)
			}
		}
	}
}

@Composable
private fun Action(icon: ImageVector, label: String, onClick: () -> Unit) {
	val palette = LocalPalette.current
	IconButton(onClick = onClick, modifier = Modifier.size(36.dp)) {
		Icon(icon, label, Modifier.size(17.dp), tint = palette.muted)
	}
}

@Composable
private fun Thinking(text: String, live: Boolean) {
	val palette = LocalPalette.current
	var open by rememberSaveable { mutableStateOf(false) }
	Column(Modifier.padding(bottom = 10.dp).animateContentSize()) {
		Row(
			Modifier.clip(RoundedCornerShape(10.dp)).clickable { open = !open }.padding(vertical = 4.dp, horizontal = 2.dp),
			verticalAlignment = Alignment.CenterVertically,
		) {
			Icon(Icons.Outlined.Lightbulb, null, Modifier.size(15.dp), tint = palette.muted)
			Spacer(Modifier.width(6.dp))
			Text(if (live) "正在思考" else "思考过程", style = MaterialTheme.typography.labelLarge.copy(color = palette.muted))
			Icon(if (open) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, null, Modifier.size(18.dp), tint = palette.muted)
		}
		if (open || live) {
			Row(Modifier.padding(top = 6.dp)) {
				Box(Modifier.width(2.dp).heightIn(min = 16.dp).background(palette.line))
				Spacer(Modifier.width(12.dp))
				Text(
					if (live && !open) text.takeLast(240) else text,
					style = MaterialTheme.typography.bodyMedium.copy(color = palette.muted),
					maxLines = if (live && !open) 4 else Int.MAX_VALUE,
					overflow = TextOverflow.Ellipsis,
				)
			}
		}
	}
}

/**
 * What the assistant did on the way to its answer. One line that says it in
 * words ("搜索了 4 次 · 看了 1 个网页"), opened on a tap; while it works, the
 * step it is on.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Tools(tools: List<ToolUse>, live: Boolean) {
	val palette = LocalPalette.current
	var open by rememberSaveable { mutableStateOf(false) }
	val running = tools.lastOrNull { !it.done }
	Column(Modifier.padding(bottom = 10.dp).animateContentSize()) {
		Row(
			Modifier.clip(RoundedCornerShape(12.dp)).background(palette.raised).clickable { open = !open }.padding(horizontal = 12.dp, vertical = 8.dp),
			verticalAlignment = Alignment.CenterVertically,
		) {
			if (live && running != null) {
				CircularProgressIndicator(Modifier.size(13.dp), color = palette.muted, strokeWidth = 1.5.dp)
			} else {
				Icon(toolIcon(tools.last().name), null, Modifier.size(15.dp), tint = palette.muted)
			}
			Spacer(Modifier.width(8.dp))
			Text(
				if (live && running != null) running.label else summary(tools),
				style = MaterialTheme.typography.labelLarge.copy(color = palette.muted),
				maxLines = 1, overflow = TextOverflow.Ellipsis,
				modifier = Modifier.weight(1f, fill = false),
			)
			Icon(if (open) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, null, Modifier.size(18.dp), tint = palette.muted)
		}
		if (open) {
			Column(Modifier.padding(start = 6.dp, top = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
				tools.forEach { tool ->
					Row(verticalAlignment = Alignment.CenterVertically) {
						if (!tool.done) CircularProgressIndicator(Modifier.size(12.dp), color = palette.muted, strokeWidth = 1.5.dp)
						else Icon(toolIcon(tool.name), null, Modifier.size(14.dp), tint = palette.faint)
						Spacer(Modifier.width(10.dp))
						Text(tool.label, style = MaterialTheme.typography.bodyMedium.copy(color = palette.muted), maxLines = 2, overflow = TextOverflow.Ellipsis)
					}
				}
			}
		}
	}
}

private fun summary(all: List<ToolUse>): String {
	// A line said on the way is already on screen; it is not a step.
	val tools = all.filter { it.name != "send_message" }
	if (tools.isEmpty()) return "发了一条消息"
	val searched = tools.count { it.name.startsWith("web_search") }
	val read = tools.count { it.name.startsWith("web_fetch") }
	val noted = tools.count { it.name == "memory_write" }
	val recalled = tools.count { it.name.startsWith("memory") } - noted
	val reminded = tools.count { it.name.contains("reminder") }
	val rest = tools.size - searched - read - noted - recalled - reminded
	return listOfNotNull(
		if (searched > 0) "搜索了 $searched 次" else null,
		if (read > 0) "看了 $read 个网页" else null,
		if (noted > 0) "记下了 $noted 件事" else null,
		if (recalled > 0) "翻了记忆" else null,
		if (reminded > 0) "设了提醒" else null,
		if (rest > 0) "用了 $rest 个工具" else null,
	).joinToString(" · ")
}

private fun toolIcon(name: String): ImageVector = when {
	name.startsWith("web_search") -> Icons.Outlined.Search
	name.startsWith("web_fetch") -> Icons.Outlined.Language
	name.startsWith("memory") -> Icons.Outlined.Bookmark
	name.contains("reminder") -> Icons.Outlined.Alarm
	name == "send_message" -> Icons.Outlined.Check
	else -> Icons.Outlined.Build
}

/** The answer as it is being written. */
@Composable
private fun Live(partial: Partial?) {
	Column(Modifier.fillMaxWidth()) {
		val thinking = partial?.thinking.orEmpty()
		if (thinking.isNotBlank()) Thinking(thinking, live = partial?.text.isNullOrBlank())
		if (partial != null && partial.tools.isNotEmpty()) Tools(partial.tools, live = true)
		if (partial == null || partial.text.isBlank()) {
			if (thinking.isBlank()) Dots()
		} else {
			Markdown(partial.text, streaming = true)
		}
	}
}

@Composable
private fun Dots() {
	val palette = LocalPalette.current
	val transition = rememberInfiniteTransition(label = "dots")
	Row(Modifier.padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
		repeat(3) { i ->
			val alpha by transition.animateFloat(
				0.2f, 1f,
				infiniteRepeatable(tween(600, delayMillis = i * 180), RepeatMode.Reverse),
				label = "dot$i",
			)
			Box(Modifier.size(7.dp).alpha(alpha).clip(CircleShape).background(palette.text))
		}
	}
}

@Composable
private fun ApprovalCard(approval: Approval, onAnswer: (Boolean) -> Unit) {
	val palette = LocalPalette.current
	Column(
		Modifier
			.fillMaxWidth()
			.clip(RoundedCornerShape(18.dp))
			.border(1.dp, palette.line, RoundedCornerShape(18.dp))
			.background(palette.raised)
			.padding(16.dp),
	) {
		Row(verticalAlignment = Alignment.CenterVertically) {
			Icon(Icons.Outlined.Shield, null, Modifier.size(18.dp), tint = palette.text)
			Spacer(Modifier.width(8.dp))
			Text("需要你同意", style = MaterialTheme.typography.titleMedium)
		}
		Spacer(Modifier.height(10.dp))
		Text(
			approval.action,
			style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace, fontSize = 13.sp),
			modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(10.dp)).background(palette.codeGround).padding(12.dp),
		)
		Spacer(Modifier.height(14.dp))
		Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
			OutlinedButton(
				onClick = { onAnswer(false) },
				modifier = Modifier.weight(1f).height(44.dp),
				shape = RoundedCornerShape(22.dp),
				border = androidx.compose.foundation.BorderStroke(1.dp, palette.line),
			) { Text("不行", color = palette.text) }
			Button(
				onClick = { onAnswer(true) },
				modifier = Modifier.weight(1f).height(44.dp),
				shape = RoundedCornerShape(22.dp),
				colors = ButtonDefaults.buttonColors(containerColor = palette.ink, contentColor = palette.onInk),
			) { Text("允许") }
		}
	}
}

@Composable
private fun Composer(model: AppModel, busy: Boolean) {
	val palette = LocalPalette.current
	val context = LocalContext.current
	val haptics = LocalHapticFeedback.current
	// A draft belongs to its chat: typed here, here when the user comes back,
	// and returned to its own chat when a send fails — not to whatever is open.
	var text by remember(model.current) { mutableStateOf("") }
	var pickedUp by remember { mutableStateOf(false) }
	LaunchedEffect(model.current) {
		val (saved, images) = model.draftFor(model.current)
		text = saved
		if (images.isNotEmpty()) model.attachments.addAll(images.take(4))
		pickedUp = true
	}
	LaunchedEffect(text, pickedUp) {
		if (pickedUp) model.saveDraft(model.current, text)
	}
	val chat = model.currentChat
	val info = model.modelFor(chat)
	val thinking = model.thinkingFor(chat)

	val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(4)) { uris -> model.attach(uris) }
	val canHear = remember {
		context.packageManager.queryIntentActivities(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH), 0).isNotEmpty()
	}
	val hear = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
		if (result.resultCode == Activity.RESULT_OK) {
			val heard = result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull().orEmpty()
			if (heard.isNotBlank()) text = if (text.isBlank()) heard else "$text $heard"
		}
	}

	Column(
		Modifier
			.fillMaxWidth()
			.padding(start = 12.dp, end = 12.dp, top = 4.dp, bottom = 10.dp)
			.clip(RoundedCornerShape(28.dp))
			.background(palette.raised)
			.border(1.dp, palette.line, RoundedCornerShape(28.dp))
			.padding(start = 8.dp, end = 8.dp, top = 8.dp, bottom = 8.dp),
	) {
		AnimatedVisibility(model.attachments.isNotEmpty(), enter = fadeIn(), exit = fadeOut()) {
			Row(Modifier.horizontalScroll(rememberScrollState()).padding(start = 6.dp, bottom = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
				model.attachments.forEach { attachment ->
					Box {
						decodeDataUri(attachment.dataUri)?.let {
							Image(it, null, Modifier.size(64.dp).clip(RoundedCornerShape(12.dp)), contentScale = ContentScale.Crop)
						}
						Box(
							Modifier.align(Alignment.TopEnd).padding(3.dp).size(20.dp).clip(CircleShape).background(palette.ground.copy(alpha = 0.75f))
								.clickable { model.attachments.remove(attachment) },
							contentAlignment = Alignment.Center,
						) { Icon(Icons.Outlined.Close, "移除", Modifier.size(13.dp), tint = palette.text) }
					}
				}
			}
		}
		Box(Modifier.fillMaxWidth().padding(horizontal = 10.dp, vertical = 6.dp)) {
			if (text.isEmpty()) Text("问点什么…", style = MaterialTheme.typography.bodyLarge.copy(color = palette.faint))
			BasicTextField(
				value = text,
				onValueChange = { text = it },
				textStyle = MaterialTheme.typography.bodyLarge.copy(color = palette.text),
				cursorBrush = SolidColor(palette.text),
				maxLines = 8,
				modifier = Modifier.fillMaxWidth(),
			)
		}
		Row(verticalAlignment = Alignment.CenterVertically) {
			Round(Icons.Outlined.Add, "图片", enabled = info?.vision != false) {
				if (info?.vision == false) model.say("${info.name} 看不了图，换个能看图的模型") else
					pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
			}
			if (info?.reasoning == true) {
				Spacer(Modifier.width(6.dp))
				Pill(Icons.Outlined.Lightbulb, "深度思考", on = thinking) { model.toggleThinking() }
			}
			Spacer(Modifier.weight(1f))
			if (canHear && text.isBlank() && !busy) {
				Round(Icons.Outlined.Mic, "说话") {
					hear.launch(
						Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
							.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
							.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN")
							.putExtra(RecognizerIntent.EXTRA_PROMPT, "请说"),
					)
				}
				Spacer(Modifier.width(6.dp))
			}
			val canSend = text.isNotBlank() || model.attachments.isNotEmpty()
			Box(
				Modifier
					.size(40.dp)
					.clip(CircleShape)
					.background(if (busy || canSend) palette.ink else palette.raisedHigh)
					.clickable(enabled = busy || canSend) {
						haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
						if (busy && !canSend) model.stop() else {
							model.send(text)
							text = ""
						}
					},
				contentAlignment = Alignment.Center,
			) {
				if (busy && !canSend) Icon(Icons.Rounded.Stop, "停止", Modifier.size(20.dp), tint = palette.onInk)
				else Icon(Icons.Outlined.ArrowUpward, "发送", Modifier.size(20.dp), tint = if (canSend) palette.onInk else palette.faint)
			}
		}
	}
}

@Composable
private fun Round(icon: ImageVector, label: String, enabled: Boolean = true, onClick: () -> Unit) {
	val palette = LocalPalette.current
	Box(
		Modifier.size(40.dp).clip(CircleShape).border(1.dp, palette.line, CircleShape).clickable(onClick = onClick),
		contentAlignment = Alignment.Center,
	) { Icon(icon, label, Modifier.size(20.dp), tint = if (enabled) palette.text else palette.faint) }
}

@Composable
private fun Pill(icon: ImageVector, label: String, on: Boolean, onClick: () -> Unit) {
	val palette = LocalPalette.current
	Row(
		Modifier
			.height(40.dp)
			.clip(RoundedCornerShape(20.dp))
			.background(if (on) palette.ink else palette.raised)
			.border(1.dp, if (on) palette.ink else palette.line, RoundedCornerShape(20.dp))
			.clickable(onClick = onClick)
			.padding(horizontal = 14.dp),
		verticalAlignment = Alignment.CenterVertically,
	) {
		Icon(icon, null, Modifier.size(17.dp), tint = if (on) palette.onInk else palette.text)
		Spacer(Modifier.width(6.dp))
		Text(label, style = MaterialTheme.typography.labelLarge.copy(color = if (on) palette.onInk else palette.text))
	}
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ModelSheet(model: AppModel, onDismiss: () -> Unit) {
	val palette = LocalPalette.current
	val chat = model.currentChat
	val chosen = model.modelFor(chat)?.id
	ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = palette.raised, contentColor = palette.text) {
		Column(Modifier.padding(bottom = 24.dp)) {
			Text("选择模型", style = MaterialTheme.typography.titleLarge, modifier = Modifier.padding(horizontal = 24.dp, vertical = 8.dp))
			Text(
				if (chat == null) "新对话会用它" else "只改这段对话；默认模型在设置里改",
				style = MaterialTheme.typography.bodySmall.copy(color = palette.muted),
				modifier = Modifier.padding(horizontal = 24.dp),
			)
			Spacer(Modifier.height(8.dp))
			if (model.models.isEmpty()) {
				Text("还没读到模型列表", style = MaterialTheme.typography.bodyMedium.copy(color = palette.muted), modifier = Modifier.padding(24.dp))
			}
			LazyColumn(Modifier.heightIn(max = 460.dp)) {
				items(model.models, key = { it.id }) { info ->
					Row(
						Modifier.fillMaxWidth().clickable { model.chooseModel(info.id); onDismiss() }.padding(horizontal = 24.dp, vertical = 14.dp),
						verticalAlignment = Alignment.CenterVertically,
					) {
						Column(Modifier.weight(1f)) {
							Text(shortModel(info.name), style = MaterialTheme.typography.titleMedium)
							val traits = buildList {
								if (info.id == model.defaultModel) add("默认")
								if (info.reasoning) add("会深度思考")
								if (info.vision) add("能看图")
							}
							if (traits.isNotEmpty()) {
								Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
									traits.forEach { trait ->
										Text(
											trait,
											style = MaterialTheme.typography.labelMedium.copy(color = palette.muted),
											modifier = Modifier.clip(RoundedCornerShape(6.dp)).background(palette.raisedHigh).padding(horizontal = 6.dp, vertical = 2.dp),
										)
									}
								}
							}
						}
						if (info.id == chosen) Icon(Icons.Outlined.Check, "当前", tint = palette.text)
					}
				}
			}
		}
	}
}
