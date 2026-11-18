package app.pimagpie.bot

/**
 * The shade's half of an approval card. Two cards can wait at once, and each
 * needs its own notification id: with one shared id the second card replaces
 * the first, and that first question can no longer be answered from the shade
 * at all - it is still waiting in the chat, five minutes away from expiring.
 */
object ApprovalCards {
	/** Well clear of the running notification (1) and the reminders (100 and up). */
	private const val BASE = 200_000
	/** Cards older than this are gone; a table that only grows is a leak. */
	private const val KEEP = 32
	private val cards = LinkedHashMap<String, Int>()
	private var next = 0

	/** The notification id for a card: the same one every time the card is asked again. */
	@Synchronized
	fun idFor(card: String): Int = cards.getOrPut(card) {
		if (cards.size >= KEEP) cards.remove(cards.keys.first())
		next += 1
		BASE + next
	}

	/** The card was answered and taken down, so its id is free again. */
	@Synchronized
	fun forget(card: String) {
		cards.remove(card)
	}

	/**
	 * The card comes down only when the answer reached the bot. If the POST did
	 * not arrive the buttons stay up: taking the card down would leave the bot
	 * waiting five minutes for an answer nobody can give any more.
	 */
	fun dismissAfter(status: Int): Boolean = status in 200..299
}
