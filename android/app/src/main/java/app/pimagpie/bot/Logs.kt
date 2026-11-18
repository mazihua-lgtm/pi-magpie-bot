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

	/** Everything kept, for a report the user chooses to send. */
	@Synchronized
	fun all(): String = lines.joinToString("\n")

	/**
	 * A file to share when something is wrong: the log, and the few facts that
	 * make it readable to someone else. Written to the app's cache, handed out
	 * by the FileProvider; nothing is uploaded.
	 */
	fun export(context: android.content.Context): java.io.File {
		val dir = java.io.File(context.cacheDir, "diagnostics").apply { mkdirs() }
		val file = java.io.File(dir, "pimagpie-diagnostics.txt")
		val head = buildString {
			appendLine("喜鹊 ${app.pimagpie.bot.BuildConfig.VERSION_NAME} (${app.pimagpie.bot.BuildConfig.VERSION_CODE})")
			appendLine("Android ${android.os.Build.VERSION.RELEASE} / SDK ${android.os.Build.VERSION.SDK_INT} / ${android.os.Build.MODEL}")
			appendLine("环境已解包: ${Payload.installed(context)}")
			appendLine("时间: " + java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.CHINA).format(java.util.Date()))
			appendLine()
			appendLine("--- 日志（新的在最后） ---")
		}
		file.writeText(head + all())
		return file
	}
}
