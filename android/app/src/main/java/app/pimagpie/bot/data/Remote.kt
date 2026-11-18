package app.pimagpie.bot.data

import android.content.Context
import java.util.Locale

/**
 * Where the app talks to its assistant. By default it starts its own assistant
 * in proot and speaks to 127.0.0.1; after pairing it speaks to an assistant on
 * another machine instead. The session id and the signed auth cookie are what
 * the server recognises, so all of it lives here next to the Api that sends it.
 *
 * The address and auth are saved in plain SharedPreferences: this is the same
 * phone that holds the chats, and the auth is a cookie bound to this session,
 * not a password. Losing it only means pairing again.
 */
class Remote(context: Context) {
	private val prefs = context.getSharedPreferences("remote", Context.MODE_PRIVATE)

	enum class Mode { LOCAL, REMOTE }

	val mode: Mode
		get() = if (base.isBlank()) Mode.LOCAL else Mode.REMOTE

	/** Base URL without a trailing slash: the Api appends paths to it. */
	var base: String
		get() = prefs.getString(BASE, "")?.trim()?.trimEnd('/') ?: ""
		set(value) = prefs.edit().putString(BASE, value.trim().trimEnd('/')).apply()

	/** The signed cookie value (`auth=<hex>`), set after a successful exchange. */
	var auth: String
		get() = prefs.getString(AUTH, "") ?: ""
		set(value) = prefs.edit().putString(AUTH, value.trim()).apply()

	/** A short name for the drawer: the host from the base URL. */
	val label: String
		get() = runCatching { java.net.URL(base).host }.getOrDefault(base)

	fun disconnect() = prefs.edit().remove(BASE).remove(AUTH).apply()

	data class Scanned(val base: String, val code: String?)

	companion object {
		const val PREFS = "remote"
		const val BASE = "base"
		const val AUTH = "auth"

		/**
		 * Parse what the camera sees (or what someone pastes by hand). A QR holds
		 * `http://host:port/pair/CODE`; a hand-typed address may leave the code off
		 * and ask for it in the next field. Anything else is refused here, before
		 * it can become a request to an arbitrary host.
		 */
		fun parse(input: String): Scanned? {
			var text = input.trim()
			if (text.isEmpty() || text.length > 300) return null
			if (!text.contains("://")) text = "http://$text"
			val url = runCatching { java.net.URL(text) }.getOrNull() ?: return null
			if (url.protocol.lowercase(Locale.ROOT) !in setOf("http", "https")) return null
			if (url.host.isNullOrBlank()) return null
			if (url.port !in -1..65535) return null
			val parts = url.path.trim('/').split('/')
			val code = if (parts.size >= 2 && parts[parts.size - 2] == "pair") {
				parts.last().uppercase(Locale.ROOT).takeIf { it.matches(Regex("[A-Z0-9]{4,8}")) }
			} else null
			// Only keep the origin; a /pair/<code> path is not part of the base.
			val port = if (url.port > 0) ":${url.port}" else ""
			return Scanned("${url.protocol.lowercase(Locale.ROOT)}://${url.host}$port", code)
		}
	}
}
