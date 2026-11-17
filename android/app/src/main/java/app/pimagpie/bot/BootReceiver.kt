package app.pimagpie.bot

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** A phone that restarts should not lose its assistant, or its reminders with it. */
class BootReceiver : BroadcastReceiver() {
	override fun onReceive(context: Context, intent: Intent) {
		if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
		// "Installed" means the unpack stamp matches this build: after an update
		// that is false until the app is opened, but the old payload on disk can
		// still run, and a phone that reboots before the next open must not lose
		// its reminders. The service re-unpacks only once it has a moment alone.
		if (!Paths.mark(context).exists()) return
		AssistantService.start(context)
	}
}
