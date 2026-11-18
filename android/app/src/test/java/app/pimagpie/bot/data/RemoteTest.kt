package app.pimagpie.bot.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** What the camera, or a person typing by hand, can hand to the pairing page. */
class RemoteTest {
	@Test
	fun `reads the QR link and strips the pair path from the base`() {
		val scanned = Remote.parse("http://192.168.1.9:8787/pair/A2B3C4")
		assertEquals("http://192.168.1.9:8787", scanned?.base)
		assertEquals("A2B3C4", scanned?.code)
	}

	@Test
	fun `accepts a bare address typed by hand, with no code`() {
		val scanned = Remote.parse("192.168.1.9:8787")
		assertEquals("http://192.168.1.9:8787", scanned?.base)
		assertNull(scanned?.code)

		// A default port stays off, so the base is not littered with :80.
		assertEquals("https://example.com", Remote.parse("https://example.com/pair/QWERTY")?.base)
	}

	@Test
	fun `lowercase codes come back uppercase`() {
		assertEquals("A2B3C4", Remote.parse("http://host:8787/pair/a2b3c4")?.code)
	}

	@Test
	fun `refuses anything that is not an http host`() {
		assertNull(Remote.parse(""))
		assertNull(Remote.parse("   "))
		assertNull(Remote.parse("file:///etc/passwd"))
		assertNull(Remote.parse("javascript:alert(1)"))
		assertNull(Remote.parse("http://"))
		assertNull(Remote.parse("http://host:99999/pair/ABC123"))
		// A bad code leaves the address usable but carries no code.
		assertNull(Remote.parse("http://host:8787/pair/bad!")?.code)
	}
}
