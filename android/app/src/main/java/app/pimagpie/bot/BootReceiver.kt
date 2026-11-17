package app.pimagpie.bot

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** A phone that restarts should not lose its assistant, or its reminders with it. */
class BootReceiver : BroadcastReceiver() {
	override fun onReceive(context: Context, intent: Intent) {
		if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
		if (!Payload.installed(context)) return
		AssistantService.start(context)
	}
}
