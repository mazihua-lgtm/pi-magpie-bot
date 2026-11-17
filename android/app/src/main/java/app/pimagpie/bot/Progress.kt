package app.pimagpie.bot

import java.io.IOException

/**
 * How the unpack is going, kept here rather than in the notification: the
 * screen may not be the thing that asked for it (a restart, a boot).
 */
object Progress {
	/** Shown on screen: a progress line, or the reason it stopped. */
	@Volatile
	var line: String = ""

	@Volatile
	var percent: Int = -1

	/** True once something failed; the screen offers a retry rather than a spinner. */
	@Volatile
	var failed: Boolean = false

	/** Whoever is on screen right now, if anyone is. */
	@Volatile
	var listener: ((String, Int) -> Unit)? = null

	fun post(text: String, progress: Int) {
		line = text
		percent = progress
		failed = false
		listener?.invoke(text, progress)
	}

	/**
	 * A failure a person can act on. The raw exception text ("write failed:
	 * ENOSPC") means nothing to the person holding the phone, so the cases that
	 * actually happen are turned into a sentence that says what to do.
	 */
	fun failed(error: Throwable) {
		val said = readable(error)
		line = said
		percent = -1
		failed = true
		listener?.invoke(said, -1)
	}

	private fun readable(error: Throwable): String {
		val text = (error.message ?: "") + " " + error.javaClass.simpleName
		return when {
			text.contains("ENOSPC", true) || text.contains("No space left", true) ->
				"手机存储不够了。需要大约 300 MB，清一些照片或视频再试。"
			text.contains("EACCES", true) || text.contains("Permission denied", true) ->
				"没有权限在这台手机上写入文件。重启手机后再试一次。"
			error is IOException && text.contains("payload", true) ->
				"安装包里的文件读不出来，可能是下载不完整。重新安装这个应用再试。"
			else -> "准备到一半停了：${(error.message ?: error.javaClass.simpleName).take(120)}"
		}
	}
}
