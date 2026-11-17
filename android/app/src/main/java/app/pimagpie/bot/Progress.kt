package app.pimagpie.bot

/**
 * How the unpack is going, kept here rather than in the notification: the
 * screen may not be the thing that asked for it (a restart, a boot).
 */
object Progress {
	@Volatile
	var line: String = ""

	@Volatile
	var percent: Int = -1

	@Volatile
	var failure: String? = null

	/** Whoever is on screen right now, if anyone is. */
	@Volatile
	var listener: ((String, Int) -> Unit)? = null

	fun post(text: String, progress: Int) {
		line = text
		percent = progress
		listener?.invoke(text, progress)
	}

	fun failed(error: Throwable) {
		failure = error.message ?: error.javaClass.simpleName
		post(line, -1)
	}
}
