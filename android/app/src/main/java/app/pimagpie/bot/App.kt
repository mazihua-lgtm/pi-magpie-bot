package app.pimagpie.bot

import android.app.Application

class App : Application() {
	override fun onCreate() {
		super.onCreate()
		instance = this
	}

	companion object {
		lateinit var instance: App
			private set

		/**
		 * Whether the chat is on screen. A message that lands while the user is
		 * reading it needs no notification; one that lands while they are away does.
		 */
		@Volatile
		var onScreen = false
	}
}
