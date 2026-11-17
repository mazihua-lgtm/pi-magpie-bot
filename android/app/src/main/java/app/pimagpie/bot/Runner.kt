package app.pimagpie.bot

import android.content.Context
import java.io.File
import java.util.TimeZone

/**
 * One process, started the same way every time: proot opens the root the APK
 * unpacked, node runs the agent inside it, and the agent opens the page the
 * WebView shows. The address is loopback, so nothing on the network can reach it.
 */
object Runner {
	const val PORT = 8787
	const val BASE = "http://127.0.0.1:$PORT"

	fun command(context: Context): List<String> {
		val native = Paths.native(context)
		return listOf(
			File(native, "proot").absolutePath,
			"-r", Paths.root(context).absolutePath,
			"-b", "/dev",
			"-b", "/proc",
			"-b", "/sys",
			"-b", "${Paths.data(context).absolutePath}:/data",
			"-b", "${Paths.resolv(context).absolutePath}:/etc/resolv.conf",
			"-w", "/app",
			"/opt/node/bin/node",
			"/app/apps/bot/src/main.ts",
		)
	}

	fun environment(context: Context): Map<String, String> {
		val native = Paths.native(context)
		return mapOf(
			"PROOT_LOADER" to File(native, "loader").absolutePath,
			"PROOT_TMP_DIR" to Paths.tmp(context).absolutePath,
			"PROOT_NO_SECCOMP" to "1",
			"LD_LIBRARY_PATH" to native.absolutePath,
			// Inside the root, so the paths are the ones the agent sees.
			"HOME" to "/data",
			"TMPDIR" to "/tmp",
			"PATH" to "/opt/node/bin:/usr/local/bin:/usr/bin:/bin",
			"MAGPIE_BIN" to "/opt/magpie/magpie",
			"MAGPIE_BASE_URL" to "http://127.0.0.1:3425",
			"WEB_HOST" to "127.0.0.1",
			"WEB_PORT" to PORT.toString(),
			"DATA_DIR" to "/data",
			"TZ" to TimeZone.getDefault().id,
		)
	}
}
