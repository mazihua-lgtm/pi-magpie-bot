package app.pimagpie.bot

import android.content.Context
import java.io.File

/** Where the assistant keeps itself: one private folder, nothing on the sdcard. */
object Paths {
	/** The Linux root the agent runs inside: node, the code, magpie. */
	fun root(context: Context) = File(context.filesDir, "sys")

	/** Its own things - the conversation, the reminders, magpie's keys. Survives upgrades. */
	fun data(context: Context) = mkdirs(File(context.filesDir, "data"))

	/** proot and the libraries it needs, outside the root it opens. */
	fun native(context: Context) = File(context.filesDir, "native")

	/** proot unpacks a helper here, so it has to be somewhere it may write. */
	fun tmp(context: Context) = mkdirs(File(context.filesDir, "tmp"))

	/**
	 * glibc asks the filesystem for name servers, and there is no such file to
	 * ask inside a proot: a real one is written and bound over it.
	 */
	fun resolv(context: Context) = File(context.filesDir, "resolv.conf")

	/** Written last, so a half-unpacked folder is never mistaken for a finished one. */
	fun mark(context: Context) = File(context.filesDir, "installed")

	private fun mkdirs(file: File): File {
		file.mkdirs()
		return file
	}
}
