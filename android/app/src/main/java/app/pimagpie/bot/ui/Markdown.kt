package app.pimagpie.bot.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Done
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay

/**
 * Markdown as models write it: headings, lists, code, tables, quotes, links.
 * Written here rather than pulled in because it has to stay calm while the
 * text is still arriving - an unclosed fence or a half-written table is the
 * normal state of a streaming answer, not an error.
 */
sealed interface Block {
	data class Heading(val level: Int, val text: String) : Block
	data class Paragraph(val text: String) : Block
	data class Code(val language: String, val text: String) : Block
	data class Quote(val text: String) : Block
	data class Items(val ordered: Boolean, val start: Int, val items: List<Item>) : Block
	data class Table(val header: List<String>, val rows: List<List<String>>) : Block
	data object Rule : Block
}

data class Item(val depth: Int, val text: String, val checked: Boolean?)

private val fence = Regex("^\\s{0,3}(```|~~~)\\s*([\\w+#.-]*).*$")
private val heading = Regex("^\\s{0,3}(#{1,6})\\s+(.*?)\\s*#*\\s*$")
private val bullet = Regex("^(\\s*)([-*+])\\s+(.*)$")
private val numbered = Regex("^(\\s*)(\\d{1,9})[.)]\\s+(.*)$")
private val rule = Regex("^\\s{0,3}([-*_])(\\s*\\1){2,}\\s*$")
private val tableDivider = Regex("^\\s*\\|?\\s*:?-{2,}:?\\s*(\\|\\s*:?-{2,}:?\\s*)*\\|?\\s*$")
private val task = Regex("^\\[([ xX])]\\s+(.*)$")

fun parseMarkdown(source: String): List<Block> {
	val lines = source.replace("\r\n", "\n").split('\n')
	val blocks = mutableListOf<Block>()
	var i = 0
	val paragraph = StringBuilder()

	fun flush() {
		if (paragraph.isNotBlank()) blocks.add(Block.Paragraph(paragraph.toString().trim()))
		paragraph.clear()
	}

	while (i < lines.size) {
		val line = lines[i]
		val open = fence.matchEntire(line)
		if (open != null) {
			flush()
			val marker = open.groupValues[1]
			val body = StringBuilder()
			i++
			while (i < lines.size && !lines[i].trimStart().startsWith(marker)) {
				body.append(lines[i]).append('\n')
				i++
			}
			i++ // the closing fence, or past the end of a fence still being written
			blocks.add(Block.Code(open.groupValues[2], body.toString().trimEnd('\n')))
			continue
		}
		if (line.isBlank()) {
			flush()
			i++
			continue
		}
		val title = heading.matchEntire(line)
		if (title != null) {
			flush()
			blocks.add(Block.Heading(title.groupValues[1].length, title.groupValues[2]))
			i++
			continue
		}
		if (rule.matches(line) && paragraph.isEmpty()) {
			blocks.add(Block.Rule)
			i++
			continue
		}
		if (line.trimStart().startsWith(">")) {
			flush()
			val quote = StringBuilder()
			while (i < lines.size && lines[i].trimStart().startsWith(">")) {
				quote.append(lines[i].trimStart().removePrefix(">").removePrefix(" ")).append('\n')
				i++
			}
			blocks.add(Block.Quote(quote.toString().trim()))
			continue
		}
		if (line.contains('|') && i + 1 < lines.size && tableDivider.matches(lines[i + 1])) {
			flush()
			val header = cells(line)
			i += 2
			val rows = mutableListOf<List<String>>()
			while (i < lines.size && lines[i].contains('|') && lines[i].isNotBlank()) {
				rows.add(cells(lines[i]).let { row -> List(header.size) { row.getOrElse(it) { "" } } })
				i++
			}
			blocks.add(Block.Table(header, rows))
			continue
		}
		val listStart = bullet.matchEntire(line) ?: numbered.matchEntire(line)
		if (listStart != null && !(paragraph.isNotEmpty() && numbered.matches(line) && listStart.groupValues[2] != "1")) {
			flush()
			val ordered = numbered.matches(line)
			val start = if (ordered) listStart.groupValues[2].toIntOrNull() ?: 1 else 1
			val items = mutableListOf<Item>()
			while (i < lines.size) {
				val current = lines[i]
				val match = bullet.matchEntire(current) ?: numbered.matchEntire(current)
				if (match != null) {
					val depth = match.groupValues[1].replace("\t", "    ").length / 2
					val content = match.groupValues[3]
					val box = task.matchEntire(content)
					items.add(Item(depth.coerceAtMost(4), box?.groupValues?.get(2) ?: content, box?.let { it.groupValues[1] != " " }))
					i++
				} else if (current.isNotBlank() && current.startsWith("  ") && items.isNotEmpty()) {
					// A wrapped line of the item above.
					val last = items.removeAt(items.size - 1)
					items.add(last.copy(text = last.text + " " + current.trim()))
					i++
				} else {
					break
				}
			}
			blocks.add(Block.Items(ordered, start, items))
			continue
		}
		if (paragraph.isNotEmpty()) paragraph.append('\n')
		paragraph.append(line)
		i++
	}
	flush()
	return blocks
}

private fun cells(line: String): List<String> =
	line.trim().removePrefix("|").removeSuffix("|").split('|').map { it.trim() }

/** Inline marks: bold, italic, code, strikethrough, links, bare URLs. */
fun inline(text: String, palette: Palette): AnnotatedString = buildAnnotatedString {
	val code = SpanStyle(fontFamily = FontFamily.Monospace, background = palette.raisedHigh, fontSize = 14.sp)
	val linkStyle = TextLinkStyles(SpanStyle(color = palette.link, textDecoration = TextDecoration.None))
	var i = 0
	val n = text.length
	while (i < n) {
		val c = text[i]
		when {
			c == '\\' && i + 1 < n && text[i + 1] in "\\`*_{}[]()#+-.!|~>" -> {
				append(text[i + 1]); i += 2
			}
			c == '`' -> {
				val end = text.indexOf('`', i + 1)
				if (end > i) {
					withStyle(code) { append("\u2009" + text.substring(i + 1, end) + "\u2009") }
					i = end + 1
				} else { append(c); i++ }
			}
			(text.startsWith("**", i) || text.startsWith("__", i)) -> {
				val mark = text.substring(i, i + 2)
				val end = text.indexOf(mark, i + 2)
				if (end > i + 2) {
					withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(inline(text.substring(i + 2, end), palette)) }
					i = end + 2
				} else { append(mark); i += 2 }
			}
			text.startsWith("~~", i) -> {
				val end = text.indexOf("~~", i + 2)
				if (end > i + 2) {
					withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { append(inline(text.substring(i + 2, end), palette)) }
					i = end + 2
				} else { append("~~"); i += 2 }
			}
			(c == '*' || c == '_') && i + 1 < n && !text[i + 1].isWhitespace() &&
				(c == '*' || i == 0 || !text[i - 1].isLetterOrDigit()) -> {
				var end = text.indexOf(c, i + 1)
				while (end > 0 && c == '_' && end + 1 < n && text[end + 1].isLetterOrDigit()) end = text.indexOf(c, end + 1)
				if (end > i + 1 && !text[end - 1].isWhitespace()) {
					withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { append(inline(text.substring(i + 1, end), palette)) }
					i = end + 1
				} else { append(c); i++ }
			}
			c == '!' && text.startsWith("![", i) -> {
				// An image in an answer: there is nothing to fetch it with offline, so its alt text and link stand in.
				val close = text.indexOf("](", i)
				val end = if (close > 0) text.indexOf(')', close) else -1
				if (close > 0 && end > close) {
					val url = text.substring(close + 2, end)
					withLink(LinkAnnotation.Url(url, linkStyle)) { append(text.substring(i + 2, close).ifBlank { "图片" }) }
					i = end + 1
				} else { append(c); i++ }
			}
			c == '[' -> {
				val close = text.indexOf("](", i)
				val end = if (close > 0) text.indexOf(')', close) else -1
				if (close > 0 && end > close && !text.substring(i + 1, close).contains('\n')) {
					val url = text.substring(close + 2, end).trim().substringBefore(' ')
					withLink(LinkAnnotation.Url(url, linkStyle)) { append(inline(text.substring(i + 1, close), palette)) }
					i = end + 1
				} else { append(c); i++ }
			}
			text.startsWith("http://", i) || text.startsWith("https://", i) -> {
				var end = i
				while (end < n && !text[end].isWhitespace() && text[end] !in "<>\"'）)】」，。、；") end++
				while (end > i && text[end - 1] in ".,;:!?") end--
				val url = text.substring(i, end)
				withLink(LinkAnnotation.Url(url, linkStyle)) { append(url) }
				i = end
			}
			c == '<' && text.startsWith("<br", i) -> {
				val end = text.indexOf('>', i)
				if (end > 0) { append('\n'); i = end + 1 } else { append(c); i++ }
			}
			else -> { append(c); i++ }
		}
	}
}

@Composable
fun Markdown(source: String, modifier: Modifier = Modifier, streaming: Boolean = false) {
	val palette = LocalPalette.current
	val blocks = remember(source) { parseMarkdown(source) }
	val body = MaterialTheme.typography.bodyLarge
	Column(modifier, verticalArrangement = Arrangement.spacedBy(10.dp)) {
		blocks.forEachIndexed { index, block ->
			val last = streaming && index == blocks.lastIndex
			when (block) {
				is Block.Heading -> Text(
					inline(block.text, palette),
					style = when (block.level) {
						1 -> MaterialTheme.typography.titleLarge.copy(fontSize = 21.sp)
						2 -> MaterialTheme.typography.titleLarge.copy(fontSize = 19.sp)
						else -> MaterialTheme.typography.titleMedium.copy(fontWeight = FontWeight.SemiBold)
					},
					modifier = Modifier.padding(top = if (index == 0) 0.dp else 6.dp),
				)
				is Block.Paragraph -> Text(withCaret(inline(block.text, palette), last), style = body)
				is Block.Code -> CodeBlock(block.language, block.text)
				is Block.Quote -> Row(Modifier.height(IntrinsicSize.Min)) {
					Box(Modifier.width(3.dp).fillMaxHeight().clip(RoundedCornerShape(2.dp)).background(palette.line))
					Spacer(Modifier.width(12.dp))
					Text(inline(block.text, palette), style = body.copy(color = palette.muted))
				}
				is Block.Items -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
					var number = block.start
					block.items.forEach { item ->
						Row(Modifier.padding(start = (item.depth * 18).dp)) {
							val mark = when {
								item.checked == true -> "☑"
								item.checked == false -> "☐"
								block.ordered && item.depth == 0 -> "${number++}."
								item.depth == 0 -> "•"
								else -> "◦"
							}
							Text(mark, style = body.copy(color = palette.muted), modifier = Modifier.widthIn(min = 22.dp))
							Text(inline(item.text, palette), style = body)
						}
					}
				}
				is Block.Table -> Table(block)
				Block.Rule -> Box(Modifier.fillMaxWidth().height(1.dp).background(palette.line))
			}
		}
		if (streaming && blocks.isEmpty()) Text(withCaret(AnnotatedString(""), true), style = body)
	}
}

private fun withCaret(text: AnnotatedString, on: Boolean): AnnotatedString =
	if (!on) text else buildAnnotatedString { append(text); append(" ●") }

@Composable
private fun CodeBlock(language: String, code: String) {
	val palette = LocalPalette.current
	val clipboard = LocalClipboardManager.current
	var copied by remember { mutableStateOf(false) }
	LaunchedEffect(copied) {
		if (copied) {
			delay(1_500)
			copied = false
		}
	}
	Column(
		Modifier
			.fillMaxWidth()
			.clip(RoundedCornerShape(12.dp))
			.border(1.dp, palette.line, RoundedCornerShape(12.dp))
			.background(palette.codeGround),
	) {
		Row(
			Modifier.fillMaxWidth().background(palette.raised).padding(start = 14.dp, end = 6.dp, top = 4.dp, bottom = 4.dp),
			verticalAlignment = Alignment.CenterVertically,
		) {
			Text(language.ifBlank { "code" }, style = MaterialTheme.typography.labelMedium.copy(color = palette.muted), modifier = Modifier.weight(1f))
			Row(
				Modifier.clip(RoundedCornerShape(8.dp)).clickableNoRipple {
					clipboard.setText(AnnotatedString(code))
					copied = true
				}.padding(horizontal = 8.dp, vertical = 6.dp),
				verticalAlignment = Alignment.CenterVertically,
			) {
				Icon(if (copied) Icons.Outlined.Done else Icons.Outlined.ContentCopy, null, Modifier.size(14.dp), tint = palette.muted)
				Spacer(Modifier.width(4.dp))
				Text(if (copied) "已复制" else "复制", style = MaterialTheme.typography.labelMedium.copy(color = palette.muted))
			}
		}
		Text(
			code,
			style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace, fontSize = 13.sp, lineHeight = 20.sp),
			modifier = Modifier.horizontalScroll(rememberScrollState()).padding(14.dp),
			softWrap = false,
		)
	}
}

@Composable
private fun Table(table: Block.Table) {
	val palette = LocalPalette.current
	val style = MaterialTheme.typography.bodyMedium
	val rows = listOf(table.header) + table.rows
	// One width per column, from its longest cell: a CJK character is about
	// twice a Latin one, and rows must line up.
	val widths = table.header.indices.map { column ->
		val longest = rows.maxOf { row -> row.getOrElse(column) { "" }.sumOf { if (it.code > 0x2E80) 2.0 else 1.0 } }
		(longest * 8.5 + 28).coerceIn(64.0, 240.0).dp
	}
	Box(
		Modifier
			.clip(RoundedCornerShape(10.dp))
			.border(1.dp, palette.line, RoundedCornerShape(10.dp))
			.horizontalScroll(rememberScrollState()),
	) {
		Column(Modifier.width(IntrinsicSize.Max)) {
			rows.forEachIndexed { r, row ->
				Row(Modifier.background(if (r == 0) palette.raised else palette.ground)) {
					widths.forEachIndexed { c, width ->
						Text(
							inline(row.getOrElse(c) { "" }, palette),
							style = if (r == 0) style.copy(fontWeight = FontWeight.SemiBold) else style,
							modifier = Modifier.width(width).padding(horizontal = 12.dp, vertical = 8.dp),
						)
					}
				}
				if (r < table.rows.size) Box(Modifier.fillMaxWidth().height(1.dp).background(palette.line))
			}
		}
	}
}
