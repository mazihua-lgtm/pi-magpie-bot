package app.pimagpie.bot

import android.app.Application
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.net.Uri
import android.os.Build
import android.speech.tts.TextToSpeech
import android.util.Base64
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.pimagpie.bot.data.Api
import app.pimagpie.bot.data.Approval
import app.pimagpie.bot.data.Attachment
import app.pimagpie.bot.data.Chat
import app.pimagpie.bot.data.Event
import app.pimagpie.bot.data.Message
import app.pimagpie.bot.data.ModelInfo
import app.pimagpie.bot.data.Note
import app.pimagpie.bot.data.Partial
import app.pimagpie.bot.data.Schedule
import app.pimagpie.bot.data.Vendor
import app.pimagpie.bot.ui.ThemeMode
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.Locale
import java.util.UUID

sealed interface Boot {
	/** The environment is being unpacked or the process is coming up. */
	data class Preparing(val firstRun: Boolean, val line: String, val percent: Int, val failed: Boolean) : Boot

	/** The process answers but has no model: it wants a key. */
	data object NeedsKey : Boot

	data object Ready : Boot
}

enum class Screen { Chat, Tasks, Memory, Settings }

/**
 * Everything the screens show, in one place, as Compose state: the chats, what
 * each has said, what is being written right now, and what waits on the user.
 */
class AppModel(application: Application) : AndroidViewModel(application) {
	val api = Api(application)
	private val prefs = application.getSharedPreferences("ui", 0)

	/** Never unpacked here before: an update re-unpacks on its own, a first run waits for the tap. */
	private val firstRun = !Payload.installed(application) && !Paths.mark(application).exists()

	var boot by mutableStateOf<Boot>(Boot.Preparing(firstRun, "", -1, false))
		private set
	var connected by mutableStateOf(false)
		private set
	var screen by mutableStateOf(Screen.Chat)

	val chats = mutableStateListOf<Chat>()
	/** The chat on screen; null is a new one not yet sent. */
	var current by mutableStateOf<String?>(null)
		private set
	val messages = mutableStateMapOf<String, List<Message>>()
	val partials = mutableStateMapOf<String, Partial>()
	val busy = mutableStateMapOf<String, Boolean>()
	val approvals = mutableStateListOf<Approval>()
	var loading by mutableStateOf(false)
		private set

	var models by mutableStateOf<List<ModelInfo>>(emptyList())
		private set
	var defaultModel by mutableStateOf<String?>(null)
		private set
	/** What the next new chat will use, picked before it exists. */
	var draftModel by mutableStateOf<String?>(null)
	var draftThinking by mutableStateOf(false)

	val attachments = mutableStateListOf<Attachment>()
	var themeMode by mutableStateOf(runCatching { ThemeMode.valueOf(prefs.getString("theme", "System")!!) }.getOrDefault(ThemeMode.System))
		private set

	var schedules by mutableStateOf<List<Schedule>>(emptyList())
		private set
	var notes by mutableStateOf<List<Note>>(emptyList())
		private set
	var vendors by mutableStateOf<List<Vendor>>(emptyList())
		private set

	private val notices = Channel<String>(Channel.BUFFERED)
	/** One-line messages for the snackbar. */
	val toasts = notices.receiveAsFlow()

	private var events: Job? = null
	private var tts: TextToSpeech? = null
	var speaking by mutableStateOf<String?>(null)
		private set

	init {
		Progress.listener = { line, percent ->
			// Posted from the unpacking thread.
			viewModelScope.launch(Dispatchers.Main) {
				val state = boot
				if (state is Boot.Preparing) boot = state.copy(line = line, percent = percent, failed = Progress.failed)
			}
		}
		if (!firstRun) start()
	}

	/** Unpack if needed, start the service, and wait until the process answers. */
	fun start() {
		val state = boot
		if (state is Boot.Preparing) boot = state.copy(failed = false, line = if (Progress.failed) "" else state.line)
		Progress.failed = false
		AssistantService.start(getApplication())
		viewModelScope.launch {
			// Ten minutes is a slow first run on an old phone.
			repeat(600) {
				val health = api.health()
				if (health != null) {
					if (health.optBoolean("ok", true)) ready() else needsKey()
					return@launch
				}
				if (Progress.failed) return@launch
				delay(1_000)
			}
			val now = boot
			if (now is Boot.Preparing) boot = now.copy(failed = true, line = getApplication<Application>().getString(R.string.setup_timeout))
		}
	}

	private suspend fun needsKey() {
		boot = Boot.NeedsKey
		vendors = runCatching { api.vendors() }.getOrDefault(emptyList())
		// The key page answers on the same port; once a key is in, the chat replaces it.
		while (viewModelScope.isActive && boot == Boot.NeedsKey) {
			delay(2_000)
			val health = api.health()
			if (health != null && health.optBoolean("ok", true)) ready()
		}
	}

	private fun ready() {
		boot = Boot.Ready
		viewModelScope.launch { refreshChats() }
		viewModelScope.launch { refreshModels() }
		listen()
	}

	private fun listen() {
		events?.cancel()
		events = viewModelScope.launch {
			while (isActive) {
				try {
					api.events().collect { handle(it) }
				} catch (_: Exception) {
					// The process restarts after a crash or an update: keep trying.
				}
				connected = false
				delay(1_500)
				if (api.health()?.optBoolean("ok", true) == false) {
					needsKey()
					return@launch
				}
			}
		}
	}

	private suspend fun handle(event: Event) {
		when (event) {
			Event.Connected -> {
				val first = !connected
				connected = true
				if (first) {
					// Whatever happened while the stream was down is in the transcript.
					refreshChats()
					current?.let { load(it) }
				}
			}
			is Event.Writing -> {
				partials[event.chat] = event.partial
				busy[event.chat] = true
			}
			is Event.Status -> {
				busy[event.chat] = event.busy
				if (!event.busy) {
					partials.remove(event.chat)
					if (messages.containsKey(event.chat)) load(event.chat)
					refreshChats()
				}
			}
			is Event.Said -> {
				val list = messages[event.chat]
				// `status` idle can come just before its answer, and the reload it
				// starts may already hold this line.
				if (list != null && list.takeLast(4).none { it.role == Message.Role.Assistant && it.text == event.text }) {
					messages[event.chat] = list + Message(UUID.randomUUID().toString(), Message.Role.Assistant, event.text, notice = true)
				}
				partials.remove(event.chat)
				if (chats.none { it.id == event.chat }) refreshChats()
			}
			is Event.Asked -> {
				approvals.removeAll { it.id == event.approval.id }
				approvals.add(event.approval)
			}
			is Event.Answered -> approvals.removeAll { it.id == event.id }
			is Event.ChatChanged -> upsert(event.chat)
		}
	}

	private fun upsert(chat: Chat) {
		val at = chats.indexOfFirst { it.id == chat.id }
		if (at >= 0) chats[at] = chat else chats.add(0, chat)
		sortChats()
	}

	private fun sortChats() {
		val sorted = chats.sortedWith(compareByDescending<Chat> { it.pinned }.thenByDescending { it.updatedAt })
		if (sorted != chats.toList()) {
			chats.clear()
			chats.addAll(sorted)
		}
	}

	suspend fun refreshChats() {
		runCatching { api.chats() }.onSuccess { list ->
			chats.clear()
			chats.addAll(list)
			sortChats()
			list.forEach { if (it.busy) busy[it.id] = true }
		}
	}

	private suspend fun refreshModels() {
		runCatching { api.models() }.onSuccess { (list, fallback) ->
			models = list
			defaultModel = fallback
		}
	}

	private suspend fun load(chat: String) {
		runCatching { api.messages(chat) }.onSuccess { (list, running, partial) ->
			// Lines the transcript does not keep (a notice that a run was cut off)
			// would vanish on reload; they stay at the end.
			val kept = messages[chat].orEmpty().filter { old -> old.notice && list.none { it.text.contains(old.text.trim()) } }
			messages[chat] = list + kept
			busy[chat] = running
			if (partial != null) partials[chat] = partial else if (!running) partials.remove(chat)
		}.onFailure { if (!messages.containsKey(chat)) say("这段对话没能读出来：${it.message}") }
	}

	fun open(chat: String?) {
		screen = Screen.Chat
		current = chat
		attachments.clear()
		if (chat != null) {
			viewModelScope.launch {
				if (!messages.containsKey(chat)) loading = true
				load(chat)
				loading = false
			}
		}
	}

	fun newChat() = open(null)

	val currentChat: Chat? get() = current?.let { id -> chats.firstOrNull { it.id == id } }

	fun modelFor(chat: Chat?): ModelInfo? {
		val id = if (chat == null) draftModel ?: defaultModel else chat.model ?: defaultModel
		return models.firstOrNull { it.id == id } ?: models.firstOrNull()
	}

	fun thinkingFor(chat: Chat?): Boolean = chat?.thinking ?: draftThinking

	fun send(text: String) {
		val body = text.trim()
		if (body.isEmpty() && attachments.isEmpty()) return
		val images = attachments.toList()
		attachments.clear()
		val chat = current
		val local = Message("local-${UUID.randomUUID()}", Message.Role.User, body, images = images.map { it.dataUri }, local = true)
		val key = chat ?: PENDING
		messages[key] = messages[key].orEmpty() + local
		busy[key] = true
		viewModelScope.launch {
			try {
				val target = if (chat == null && (draftModel != null || draftThinking)) {
					val made = api.createChat()
					val change = JSONObject()
					draftModel?.let { change.put("model", it) }
					if (draftThinking) change.put("thinking", true)
					api.updateChat(made.id, change)
				} else {
					null
				}
				val sent = api.say(target?.id ?: chat, body, images)
				if (chat == null) {
					messages[sent.id] = messages.remove(PENDING).orEmpty()
					busy.remove(PENDING)
					busy[sent.id] = true
					draftModel = null
					draftThinking = false
					if (current == null) current = sent.id
				}
				upsert(sent.copy(busy = true))
			} catch (error: Exception) {
				busy[key] = false
				messages[key] = messages[key].orEmpty().filterNot { it.id == local.id }
				attachments.addAll(images)
				say("没发出去：${error.message}")
				restoreDraft = body
			}
		}
	}

	/** Text handed back to the composer when sending failed. */
	var restoreDraft by mutableStateOf<String?>(null)

	fun stop() {
		val chat = current ?: return
		viewModelScope.launch { runCatching { api.stop(chat) }.onFailure { say("停不下来：${it.message}") } }
	}

	fun answer(approval: Approval, allow: Boolean) {
		approvals.remove(approval)
		viewModelScope.launch {
			runCatching { api.answer(approval.id, allow) }.onFailure {
				approvals.add(approval)
				say("没答上：${it.message}")
			}
		}
	}

	fun chooseModel(model: String) {
		val chat = currentChat
		if (chat == null) {
			draftModel = model
			if (models.firstOrNull { it.id == model }?.reasoning != true) draftThinking = false
			return
		}
		change(chat.id, JSONObject().put("model", model))
	}

	fun toggleThinking() {
		val chat = currentChat
		if (chat == null) draftThinking = !draftThinking else change(chat.id, JSONObject().put("thinking", !chat.thinking))
	}

	fun rename(chat: Chat, title: String) = change(chat.id, JSONObject().put("title", title.trim().ifEmpty { chat.title }))

	fun pin(chat: Chat) = change(chat.id, JSONObject().put("pinned", !chat.pinned))

	private fun change(id: String, body: JSONObject) {
		viewModelScope.launch {
			runCatching { api.updateChat(id, body) }.onSuccess(::upsert).onFailure { say("没改成：${it.message}") }
		}
	}

	fun delete(chat: Chat) {
		chats.removeAll { it.id == chat.id }
		messages.remove(chat.id)
		if (current == chat.id) current = null
		viewModelScope.launch {
			runCatching { api.deleteChat(chat.id) }.onFailure {
				say("没删掉：${it.message}")
				refreshChats()
			}
		}
	}

	fun setDefault(model: String) {
		defaultModel = model
		viewModelScope.launch { runCatching { api.setDefaultModel(model) }.onFailure { say("没设上：${it.message}") } }
	}

	fun setTheme(mode: ThemeMode) {
		themeMode = mode
		prefs.edit().putString("theme", mode.name).apply()
	}

	// Images ----------------------------------------------------------------

	fun attach(uris: List<Uri>) {
		viewModelScope.launch {
			for (uri in uris.take(4 - attachments.size)) {
				val image = withContext(Dispatchers.IO) { runCatching { encode(uri) }.getOrNull() }
				if (image == null) say("这张图读不出来") else attachments.add(image)
			}
		}
	}

	/** Shrunk to what a model looks at anyway, so a 12 MP photo is not 6 MB of base64. */
	private fun encode(uri: Uri): Attachment {
		val resolver = getApplication<Application>().contentResolver
		val bitmap: Bitmap = if (Build.VERSION.SDK_INT >= 28) {
			ImageDecoder.decodeBitmap(ImageDecoder.createSource(resolver, uri)) { decoder, info, _ ->
				val longest = maxOf(info.size.width, info.size.height)
				if (longest > MAX_SIDE) {
					val scale = MAX_SIDE.toFloat() / longest
					decoder.setTargetSize((info.size.width * scale).toInt(), (info.size.height * scale).toInt())
				}
				decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
			}
		} else {
			val raw = resolver.openInputStream(uri)!!.use { BitmapFactory.decodeStream(it) }
			val longest = maxOf(raw.width, raw.height)
			if (longest <= MAX_SIDE) raw else Bitmap.createScaledBitmap(raw, raw.width * MAX_SIDE / longest, raw.height * MAX_SIDE / longest, true)
		}
		val out = ByteArrayOutputStream()
		bitmap.compress(Bitmap.CompressFormat.JPEG, 85, out)
		return Attachment(Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP), "image/jpeg")
	}

	// Reading aloud -----------------------------------------------------------

	fun speak(id: String, text: String) {
		if (speaking == id) {
			tts?.stop()
			speaking = null
			return
		}
		val plain = text.replace(Regex("```[\\s\\S]*?```"), "（代码略）").replace(Regex("[*_`#>|]"), "")
		val engine = tts
		if (engine != null) {
			engine.speak(plain, TextToSpeech.QUEUE_FLUSH, null, id)
			speaking = id
			return
		}
		tts = TextToSpeech(getApplication()) { status ->
			if (status != TextToSpeech.SUCCESS) {
				say("这台手机没有可用的朗读引擎")
				tts = null
				return@TextToSpeech
			}
			tts?.language = Locale.CHINA
			tts?.setOnUtteranceProgressListener(object : android.speech.tts.UtteranceProgressListener() {
				override fun onStart(utteranceId: String?) {}
				override fun onDone(utteranceId: String?) { if (speaking == utteranceId) speaking = null }
				@Deprecated("Deprecated in Java")
				override fun onError(utteranceId: String?) { if (speaking == utteranceId) speaking = null }
			})
			tts?.speak(plain, TextToSpeech.QUEUE_FLUSH, null, id)
			speaking = id
		}
	}

	// Tasks, memory, providers ------------------------------------------------

	fun loadSchedules() {
		viewModelScope.launch { runCatching { api.schedules() }.onSuccess { schedules = it }.onFailure { say("提醒没读出来：${it.message}") } }
	}

	fun addSchedule(text: String, at: Long, everyMs: Long?) {
		viewModelScope.launch {
			try {
				// A reminder belongs to a chat: the one on screen, else a fresh one.
				val chat = current ?: chats.firstOrNull()?.id ?: api.createChat().also(::upsert).id
				api.addSchedule(chat, text, at, everyMs)
				schedules = api.schedules()
				say("提醒已设好")
			} catch (error: Exception) {
				say("没设上：${error.message}")
			}
		}
	}

	fun deleteSchedule(schedule: Schedule) {
		schedules = schedules - schedule
		viewModelScope.launch { runCatching { api.deleteSchedule(schedule.id) }.onFailure { say("没删掉：${it.message}"); loadSchedules() } }
	}

	fun loadNotes() {
		viewModelScope.launch { runCatching { api.notes() }.onSuccess { notes = it }.onFailure { say("记忆没读出来：${it.message}") } }
	}

	fun saveNote(name: String, content: String) {
		viewModelScope.launch {
			runCatching { api.saveNote(name, content) }.onSuccess { loadNotes() }.onFailure { say("没存上：${it.message}") }
		}
	}

	fun deleteNote(note: Note) {
		notes = notes - note
		viewModelScope.launch { runCatching { api.deleteNote(note.name) }.onFailure { say("没删掉：${it.message}"); loadNotes() } }
	}

	fun loadVendors() {
		viewModelScope.launch { runCatching { api.vendors() }.onSuccess { vendors = it } }
	}

	/** Adds a provider key; the process restarts to load its models. */
	fun addKey(vendor: Vendor, key: String, done: (String?) -> Unit) {
		viewModelScope.launch {
			try {
				val note = if (boot == Boot.NeedsKey) api.setupKey(vendor.preset, key.trim()) else api.addProvider(vendor.preset, key.trim())
				done(null)
				say(note.ifBlank { "已添加 ${vendor.name}，助理正在重启…" })
				delay(4_000)
				refreshModels()
			} catch (error: Exception) {
				done(error.message ?: "没加上")
			}
		}
	}

	fun say(text: String) {
		notices.trySend(text)
	}

	override fun onCleared() {
		Progress.listener = null
		tts?.shutdown()
		super.onCleared()
	}

	companion object {
		const val PENDING = "__pending__"
		private const val MAX_SIDE = 1568
	}
}
