package app.pimagpie.bot

/**
 * How long to wait before opening the event stream again. A phone that lost its
 * network must not spend the battery reconnecting every second and a half, and
 * one that just hiccuped must not wait half a minute afterwards: the wait
 * doubles up to half a minute, and the next stream that comes up puts it back
 * to where it started.
 */
class Backoff(private val first: Long = FIRST, private val limit: Long = LIMIT) {
	var wait: Long = first
		private set

	/** The stream dropped: wait twice as long next time, up to the limit. */
	fun failed() {
		wait = (wait * 2).coerceAtMost(limit)
	}

	/** The stream came up: a later drop starts from the shortest wait again. */
	fun succeeded() {
		wait = first
	}

	companion object {
		const val FIRST = 1_500L
		const val LIMIT = 30_000L
	}
}
