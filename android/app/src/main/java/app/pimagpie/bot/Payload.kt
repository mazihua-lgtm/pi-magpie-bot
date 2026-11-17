package app.pimagpie.bot

import android.content.Context
import org.apache.commons.compress.archivers.tar.TarArchiveEntry
import org.apache.commons.compress.archivers.tar.TarArchiveInputStream
import java.io.BufferedInputStream
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.Paths as JPaths
import java.util.zip.GZIPInputStream

/**
 * The assistant is not installed from a store: the APK carries it. Unpacking
 * is the first thing that happens on a new phone, and the only slow part.
 */
object Payload {
	const val ASSET = "bootstrap.payload"

	/**
	 * Whether the unpacked copy belongs to this APK. A bare "it exists" check is
	 * not enough: filesDir survives an upgrade, so a new APK would otherwise keep
	 * running the old node, magpie and app code forever, and an update would look
	 * like it did nothing.
	 */
	fun installed(context: Context): Boolean {
		val mark = Paths.mark(context)
		if (!mark.exists()) return false
		return runCatching { mark.readText().trim() }.getOrNull() == stamp(context)
	}

	/** Identifies the payload: this build's version code. */
	private fun stamp(context: Context): String = runCatching {
		context.packageManager.getPackageInfo(context.packageName, 0).versionCode.toString()
	}.getOrDefault("unknown")

	fun unpack(context: Context, say: (percent: Int) -> Unit) {
		val files = context.filesDir
		Paths.mark(context).delete()
		// An upgrade unpacks over the previous copy. Left in place, files this
		// payload no longer ships would survive and the two versions would be
		// mixed - a new app against an old node, or the reverse. `data` is the
		// user's own and is never touched here.
		files.listFiles()
			?.filter { it.name == "sys" || it.name == "native" || it.name == "tmp" }
			?.forEach { it.deleteRecursively() }
		val total = try {
			context.assets.openFd(ASSET).use { it.length }
		} catch (_: IOException) {
			0L
		}

		var read = 0L
		var said = -1
		context.assets.open(ASSET).use { asset ->
			val counted = Counting(BufferedInputStream(asset, 1 shl 16)) { bytes ->
				read += bytes
				val percent = if (total > 0) (read * 100 / total).toInt() else -1
				if (percent != said) {
					said = percent
					say(percent)
				}
			}
			GZIPInputStream(counted).use { gzip ->
				TarArchiveInputStream(gzip).use { tar ->
					while (true) {
						val entry = tar.nextEntry ?: break
						write(files, entry, tar)
					}
				}
			}
		}

		// Written last, and carrying this build's version: a half-unpacked folder
		// is never mistaken for a finished one, and an upgrade is noticed.
		Paths.mark(context).writeText("${stamp(context)}\n")
	}

	private fun write(files: File, entry: TarArchiveEntry, input: InputStream) {
		val out = File(files, entry.name)
		// A tarball is data, and data does not get to write outside the folder it
		// was handed: a name that climbs out with ".." is the whole of path traversal.
		if (!out.canonicalPath.startsWith(files.canonicalPath + File.separator)) {
			throw IOException("the payload tried to unpack outside its folder: ${entry.name}")
		}

		if (entry.isDirectory) {
			out.mkdirs()
			return
		}

		out.parentFile?.mkdirs()
		if (entry.isSymbolicLink) {
			out.delete()
			Files.createSymbolicLink(out.toPath(), JPaths.get(entry.linkName))
			return
		}

		// pnpm points package files at one copy instead of duplicating them, and the
		// copy is already unpacked when the link arrives.
		if (entry.isLink) {
			val source = File(files, entry.linkName)
			out.delete()
			try {
				Files.createLink(out.toPath(), source.toPath())
				return
			} catch (_: Exception) {
				// A filesystem that will not link is a filesystem that gets a copy.
			}
			if (source.exists()) {
				source.copyTo(out, overwrite = true)
				return
			}
		}

		FileOutputStream(out).use { sink -> input.copyTo(sink, 1 shl 16) }
		// Executables are the point: node, proot, magpie.
		if (entry.mode and 0b001001001 != 0) out.setExecutable(true, false)
	}

	private class Counting(private val inner: InputStream, private val onRead: (Long) -> Unit) : InputStream() {
		override fun read(): Int = inner.read().also { if (it >= 0) onRead(1) }
		override fun read(bytes: ByteArray, offset: Int, length: Int): Int =
			inner.read(bytes, offset, length).also { if (it > 0) onRead(it.toLong()) }

		override fun close() = inner.close()
	}
}
