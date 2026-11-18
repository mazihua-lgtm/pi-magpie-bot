package app.pimagpie.bot

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The wait between reconnects. The bug this guards: a stream that came up did
 * not put the wait back to where it started, so one outage left the app
 * reconnecting every half minute for the rest of the day.
 */
class BackoffTest {
	@Test
	fun `starts at a second and a half`() {
		assertEquals(1_500L, Backoff().wait)
	}

	@Test
	fun `doubles on every drop and stops at half a minute`() {
		val backoff = Backoff()
		backoff.failed()
		assertEquals(3_000L, backoff.wait)
		backoff.failed()
		assertEquals(6_000L, backoff.wait)
		for (step in 0 until 10) backoff.failed()
		assertEquals(30_000L, backoff.wait)
	}

	@Test
	fun `a stream that came up puts the wait back to a second and a half`() {
		val backoff = Backoff()
		for (step in 0 until 6) backoff.failed()
		assertEquals(30_000L, backoff.wait)

		backoff.succeeded()
		assertEquals(1_500L, backoff.wait)

		// The drop after a good connection is a hiccup, not the outage again.
		backoff.failed()
		assertEquals(3_000L, backoff.wait)
	}
}
