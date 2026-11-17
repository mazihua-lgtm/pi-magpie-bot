package app.pimagpie.bot.data

import org.json.JSONArray
import org.json.JSONObject

/** What the bot process says, in the shapes of docs/app-api.md. */

data class Chat(
	val id: String,
	val title: String,
	val createdAt: Long,
	val updatedAt: Long,
	val pinned: Boolean,
	val model: String?,
	val thinking: Boolean,
	val busy: Boolean,
) {
	companion object {
		fun of(json: JSONObject) = Chat(
			id = json.getString("id"),
			title = json.optString("title").ifBlank { "新对话" },
			createdAt = json.optLong("createdAt"),
			updatedAt = json.optLong("updatedAt"),
			pinned = json.optBoolean("pinned"),
			model = json.optStringOrNull("model"),
			thinking = json.optBoolean("thinking"),
			busy = json.optBoolean("busy"),
		)
	}
}

data class ToolUse(val name: String, val label: String, val done: Boolean = true) {
	companion object {
		fun of(json: JSONObject) = ToolUse(
			name = json.optString("name"),
			label = json.optString("label").ifBlank { json.optString("name") },
			done = json.optBoolean("done", true),
		)
	}
}

data class Message(
	val id: String,
	val role: Role,
	val text: String,
	val thinking: String = "",
	val images: List<String> = emptyList(),
	val tools: List<ToolUse> = emptyList(),
	val at: Long = 0,
	/** Sent from here and not yet seen in the transcript. */
	val local: Boolean = false,
	/** Something the bot said that is not an answer: a reminder, a notice. */
	val notice: Boolean = false,
) {
	enum class Role { User, Assistant }

	companion object {
		fun of(json: JSONObject) = Message(
			id = json.optString("id"),
			role = if (json.optString("role") == "user") Role.User else Role.Assistant,
			text = json.optString("text"),
			thinking = json.optString("thinking"),
			images = json.optJSONArray("images").strings(),
			tools = json.optJSONArray("tools").objects().map(ToolUse::of),
			at = json.optLong("at"),
		)
	}
}

/** The answer being written. */
data class Partial(val text: String, val thinking: String, val tools: List<ToolUse>) {
	companion object {
		fun of(json: JSONObject) = Partial(
			text = json.optString("text"),
			thinking = json.optString("thinking"),
			tools = json.optJSONArray("tools").objects().map(ToolUse::of),
		)
	}
}

data class Approval(val chat: String, val id: String, val action: String, val expiresAt: Long) {
	companion object {
		fun of(json: JSONObject) = Approval(
			chat = json.optString("chat"),
			id = json.getString("id"),
			action = json.optString("action"),
			expiresAt = json.optLong("expiresAt"),
		)
	}
}

data class ModelInfo(val id: String, val name: String, val reasoning: Boolean, val vision: Boolean) {
	companion object {
		fun of(json: JSONObject) = ModelInfo(
			id = json.getString("id"),
			name = json.optString("name").ifBlank { json.getString("id") },
			reasoning = json.optBoolean("reasoning"),
			vision = json.optBoolean("vision"),
		)
	}
}

data class Schedule(val id: String, val chat: String, val text: String, val nextRunAt: Long, val everyMs: Long?) {
	companion object {
		fun of(json: JSONObject) = Schedule(
			id = json.getString("id"),
			chat = json.optString("chat"),
			text = json.optString("text"),
			nextRunAt = json.optLong("nextRunAt"),
			everyMs = if (json.isNull("everyMs") || !json.has("everyMs")) null else json.optLong("everyMs"),
		)
	}
}

data class Note(val name: String, val content: String) {
	companion object {
		fun of(json: JSONObject) = Note(json.getString("name"), json.optString("content"))
	}
}

data class Vendor(val preset: String, val name: String, val signupUrl: String) {
	companion object {
		fun of(json: JSONObject) = Vendor(
			preset = json.getString("preset"),
			name = json.optString("name").ifBlank { json.getString("preset") },
			signupUrl = json.optString("signupUrl"),
		)
	}
}

/** An image picked for the next message, already shrunk and encoded. */
data class Attachment(val data: String, val mimeType: String) {
	val dataUri: String get() = "data:$mimeType;base64,$data"
}

fun JSONObject.optStringOrNull(key: String): String? =
	if (!has(key) || isNull(key)) null else optString(key).ifEmpty { null }

fun JSONArray?.objects(): List<JSONObject> =
	if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }

fun JSONArray?.strings(): List<String> =
	if (this == null) emptyList() else (0 until length()).mapNotNull { optString(it).ifEmpty { null } }
