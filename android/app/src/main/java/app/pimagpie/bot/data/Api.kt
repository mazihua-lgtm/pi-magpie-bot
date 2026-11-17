package app.pimagpie.bot.data

import android.content.Context
import app.pimagpie.bot.Runner
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.UUID

class ApiError(val status: Int, message: String) : IOException(message)

sealed interface Event {
	data class Said(val chat: String, val text: String) : Event
	data class Writing(val chat: String, val partial: Partial) : Event
	data class Status(val chat: String, val busy: Boolean) : Event
	data class Asked(val approval: Approval) : Event
	data class Answered(val chat: String, val id: String, val status: String) : Event
	data class ChatChanged(val chat: Chat) : Event
	data object Connected : Event
}

/**
 * The bot process on this phone, over the loopback. One owner per phone: the
 * session id is made here once and kept, and the notification watcher in
 * [app.pimagpie.bot.AssistantService] uses the same one.
 */
class Api(context: Context) {
	private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

	val session: String = prefs.getString(SESSION, null) ?: UUID.randomUUID().toString().also {
		prefs.edit().putString(SESSION, it).apply()
	}

	/** What `/healthz` says: null when nothing answers yet. */
	suspend fun health(): JSONObject? = withContext(Dispatchers.IO) {
		val connection = open("/healthz", 1_500)
		try {
			val code = connection.responseCode
			// The body rides the same socket whether it answered or not.
			val stream = if (code < 400) connection.inputStream else connection.errorStream
			val body = stream?.bufferedReader()?.readText().orEmpty()
			if (code == 200) runCatching { JSONObject(body) }.getOrDefault(JSONObject().put("ok", true)) else null
		} catch (_: Exception) {
			null
		} finally {
			connection.disconnect()
		}
	}

	suspend fun chats(): List<Chat> = get("/api/chats").optJSONArray("chats").objects().map(Chat::of)

	suspend fun createChat(): Chat = Chat.of(send("POST", "/api/chats", JSONObject()).getJSONObject("chat"))

	suspend fun updateChat(id: String, change: JSONObject): Chat =
		Chat.of(send("PATCH", "/api/chats/${path(id)}", change).getJSONObject("chat"))

	suspend fun deleteChat(id: String) {
		send("DELETE", "/api/chats/${path(id)}", null)
	}

	suspend fun messages(id: String): Triple<List<Message>, Boolean, Partial?> {
		val body = get("/api/chats/${path(id)}/messages")
		return Triple(
			body.optJSONArray("messages").objects().map(Message::of),
			body.optBoolean("busy"),
			body.optJSONObject("partial")?.let(Partial::of),
		)
	}

	/** Sends a message; `chat` null starts a new chat. Answers with the chat it went to. */
	suspend fun say(chat: String?, text: String, images: List<Attachment>): Chat {
		val body = JSONObject().put("text", text)
		if (images.isNotEmpty()) {
			body.put("images", JSONArray(images.map { JSONObject().put("data", it.data).put("mimeType", it.mimeType) }))
		}
		return Chat.of(send("POST", "/api/chats/${path(chat ?: "new")}/messages", body, readTimeout = 60_000).getJSONObject("chat"))
	}

	suspend fun stop(chat: String) {
		send("POST", "/api/chats/${path(chat)}/stop", JSONObject())
	}

	suspend fun answer(approval: String, allow: Boolean) {
		send("POST", "/api/approvals/${path(approval)}", JSONObject().put("allow", allow))
	}

	suspend fun models(): Pair<List<ModelInfo>, String?> {
		val body = get("/api/models")
		return body.optJSONArray("models").objects().map(ModelInfo::of) to body.optStringOrNull("default")
	}

	suspend fun setDefaultModel(model: String) {
		send("PUT", "/api/settings/model", JSONObject().put("model", model))
	}

	suspend fun schedules(): List<Schedule> = get("/api/schedules").optJSONArray("schedules").objects().map(Schedule::of)

	suspend fun addSchedule(chat: String, text: String, at: Long, everyMs: Long?): Schedule {
		val body = JSONObject().put("chat", chat).put("text", text).put("at", at)
		if (everyMs != null) body.put("everyMs", everyMs)
		return Schedule.of(send("POST", "/api/schedules", body).getJSONObject("schedule"))
	}

	suspend fun deleteSchedule(id: String) {
		send("DELETE", "/api/schedules/${path(id)}", null)
	}

	suspend fun notes(): List<Note> = get("/api/memory").optJSONArray("notes").objects().map(Note::of)

	suspend fun saveNote(name: String, content: String) {
		send("PUT", "/api/memory/${path(name)}", JSONObject().put("content", content))
	}

	suspend fun deleteNote(name: String) {
		send("DELETE", "/api/memory/${path(name)}", null)
	}

	suspend fun vendors(): List<Vendor> = get("/api/providers").optJSONArray("vendors").objects().map(Vendor::of)

	suspend fun addProvider(preset: String, key: String): String =
		send("POST", "/api/providers", JSONObject().put("preset", preset).put("key", key)).optString("note")

	/** The key page the bot serves when it has no model at all. */
	suspend fun setupKey(preset: String, key: String): String =
		send("POST", "/api/setup/key", JSONObject().put("preset", preset).put("key", key), readTimeout = 90_000).optString("note")

	/**
	 * The live stream for every chat of this phone. Ends when the connection
	 * does; whoever collects it reconnects.
	 */
	fun events(): Flow<Event> = callbackFlow {
		val connection = open("/api/events?v=2", 5_000)
		connection.readTimeout = 60_000 // keep-alives come every 20 s
		connection.setRequestProperty("Accept", "text/event-stream")
		// `disconnect` before the connection is up is a no-op, and the reader
		// thread would then hold a stream nobody wants. One flag closes it either way.
		val closed = java.util.concurrent.atomic.AtomicBoolean(false)
		val reader = Thread {
			try {
				if (connection.responseCode != 200) throw ApiError(connection.responseCode, "events")
				trySend(Event.Connected)
				var name = ""
				val data = StringBuilder()
				connection.inputStream.bufferedReader().useLines { lines ->
					for (line in lines) {
						if (closed.get()) return@useLines
						when {
							line.startsWith("event:") -> name = line.removePrefix("event:").trim()
							line.startsWith("data:") -> data.append(line.removePrefix("data:").trimStart())
							line.isEmpty() -> {
								if (data.isNotEmpty()) parse(name, data.toString())?.let { trySend(it) }
								name = ""
								data.clear()
							}
						}
					}
				}
				close()
			} catch (error: Exception) {
				close(error)
			}
		}
		reader.isDaemon = true
		reader.start()
		awaitClose {
			closed.set(true)
			connection.disconnect()
		}
	}.flowOn(Dispatchers.IO)

	private fun parse(name: String, data: String): Event? {
		val json = runCatching { JSONObject(data) }.getOrNull() ?: return null
		val chat = json.optString("chat")
		return when (name) {
			"message" -> Event.Said(chat, json.optString("text"))
			"partial" -> Event.Writing(chat, Partial.of(json))
			"status" -> Event.Status(chat, json.optBoolean("busy"))
			"approval" -> Event.Asked(Approval.of(json))
			"approval_done" -> Event.Answered(chat, json.optString("id"), json.optString("status"))
			"chat" -> Event.ChatChanged(Chat.of(json))
			else -> null
		}
	}

	private suspend fun get(path: String): JSONObject = send("GET", path, null)

	private suspend fun send(method: String, path: String, body: JSONObject?, readTimeout: Int = 20_000): JSONObject =
		withContext(Dispatchers.IO) {
			val connection = open(path, 5_000)
			try {
				// HttpURLConnection refuses PATCH outright; the server takes the override.
				if (method == "PATCH") {
					connection.requestMethod = "POST"
					connection.setRequestProperty("X-HTTP-Method-Override", "PATCH")
				} else {
					connection.requestMethod = method
				}
				connection.readTimeout = readTimeout
				if (body != null) {
					connection.doOutput = true
					connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
					connection.outputStream.use { it.write(body.toString().toByteArray()) }
				}
				val status = connection.responseCode
				val stream = if (status < 400) connection.inputStream else connection.errorStream
				val text = stream?.bufferedReader()?.readText().orEmpty()
				val json = runCatching { JSONObject(text) }.getOrDefault(JSONObject())
				if (status >= 400) throw ApiError(status, json.optString("error").ifBlank { "出错了（$status）" })
				json
			} finally {
				connection.disconnect()
			}
		}

	private fun open(path: String, timeout: Int): HttpURLConnection {
		val connection = URL("${Runner.BASE}$path").openConnection() as HttpURLConnection
		connection.connectTimeout = timeout
		connection.readTimeout = timeout
		connection.setRequestProperty("Cookie", "sid=$session")
		connection.useCaches = false
		return connection
	}

	private fun path(segment: String): String = URLEncoder.encode(segment, "UTF-8").replace("+", "%20")

	companion object {
		const val PREFS = "bot"
		const val SESSION = "sid"
	}
}
