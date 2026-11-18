package app.pimagpie.bot.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The guide behind the key sheet. What this guards: a preset magpie does not
 * know (the row then offers no way to use what it advertises), a duplicate that
 * makes one vendor unreachable, and the two obvious typos.
 */
class FreeQuotaTest {
	@Test
	fun `every entry points at a distinct magpie preset`() {
		val presets = FreeQuota.entries.map { it.preset }
		assertEquals(presets.size, presets.toSet().size)
		assertFalse(presets.any { it.isBlank() })
	}

	@Test
	fun `every entry says something and is sorted for a reader in China`() {
		for (entry in FreeQuota.entries) {
			assertTrue(entry.name, entry.name.isNotBlank())
			assertTrue(entry.name, entry.note.isNotBlank())
		}
		// Rows reachable without a proxy come first; the page should not make
		// someone read past three dead ends to find one that works here.
		val firstIndirect = FreeQuota.entries.indexOfFirst { !it.direct }
		val lastDirect = FreeQuota.entries.indexOfLast { it.direct }
		if (firstIndirect >= 0 && lastDirect >= 0) assertTrue(lastDirect < firstIndirect)
	}

	@Test
	fun `every entry can send a person with no key to get one`() {
		// The section between "out of quota" and "paste a key" is useless if a
		// row has nowhere to go: the row offers 去注册 and it must open a page.
		for (entry in FreeQuota.entries) {
			assertTrue(entry.name, entry.signup.startsWith("https://"))
			assertTrue(entry.name, entry.signup.length > "https://".length)
		}
	}
}
