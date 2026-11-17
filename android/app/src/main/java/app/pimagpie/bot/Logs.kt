package app.pimagpie.bot

import android.util.Log

/**
 * What the assistant printed, kept where the screen can show it when something
 * is wrong - and in logcat too, because the screen cannot be read over a cable.
 */
object Logs {
	private const val TAG = "assistant"
	private const val LIMIT = 400
	private val lines = ArrayDeque<String>()

	@Synchronized
	fun add(line: String) {
		lines.addLast(line)
		while (lines.size > LIMIT) lines.removeFirst()
		Log.i(TAG, line)
	}

	@Synchronized
	fun tail(count: Int = 30): String = lines.takeLast(count).joinToString("\n")
}
