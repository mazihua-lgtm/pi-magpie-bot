package app.pimagpie.bot

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The shade's half of an approval card. Two cards waiting at once must have two
 * notifications; with one shared id the second replaced the first and that
 * question could no longer be answered from the shade.
 */
class ApprovalCardsTest {
	@Test
	fun `two cards waiting at once get two notifications`() {
		val first = ApprovalCards.idFor("card-one")
		val second = ApprovalCards.idFor("card-two")
		assertNotEquals(first, second)

		// The same card asked again is still the same notification, not a third.
		assertEquals(first, ApprovalCards.idFor("card-one"))
		ApprovalCards.forget("card-one")
		ApprovalCards.forget("card-two")
	}

	@Test
	fun `an answered card gives its id back`() {
		val first = ApprovalCards.idFor("card-three")
		ApprovalCards.forget("card-three")
		assertNotEquals(first, ApprovalCards.idFor("card-three"))
		ApprovalCards.forget("card-three")
	}

	@Test
	fun `the card comes down only when the answer reached the bot`() {
		assertTrue(ApprovalCards.dismissAfter(200))
		assertTrue(ApprovalCards.dismissAfter(204))
		assertFalse(ApprovalCards.dismissAfter(500))
		assertFalse(ApprovalCards.dismissAfter(404))
		// Nothing was sent at all.
		assertFalse(ApprovalCards.dismissAfter(-1))
		assertFalse(ApprovalCards.dismissAfter(0))
	}
}
