package app.pimagpie.bot

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import org.json.JSONObject

/**
 * The two buttons on an approval notification. Answering from the shade is the
 * whole point: a card that waits for the user to open the app for five minutes
 * has usually expired by the time they see it.
 */
class ApprovalReceiver : BroadcastReceiver() {
	override fun onReceive(context: Context, intent: Intent) {
		if (intent.action != ACTION) return
		val id = intent.getStringExtra(EXTRA_ID) ?: return
		val allow = intent.getBooleanExtra(EXTRA_ALLOW, false)
		val pending = goAsync()
		Thread {
			try {
				val session = context.getSharedPreferences("bot", android.content.Context.MODE_PRIVATE).getString("sid", null)
				if (session != null) {
					val connection = java.net.URL("${Runner.BASE}/api/approvals/$id").openConnection() as java.net.HttpURLConnection
					connection.requestMethod = "POST"
					connection.setRequestProperty("Cookie", "sid=$session")
					connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
					connection.connectTimeout = 5_000
					connection.readTimeout = 10_000
					connection.doOutput = true
					connection.outputStream.use { it.write(JSONObject().put("allow", allow).toString().toByteArray()) }
					connection.responseCode
					connection.disconnect()
				}
			} catch (error: Exception) {
				Logs.add("[app] could not answer an approval: ${error.message}")
			} finally {
				pending.finish()
			}
		}.start()
		// The card is answered: take it down now, whatever the answer does.
		context.getSystemService(android.app.NotificationManager::class.java).cancel(NOTIFICATION)
	}

	companion object {
		const val ACTION = "app.pimagpie.bot.APPROVAL"
		const val EXTRA_ID = "id"
		const val EXTRA_ALLOW = "allow"
		const val NOTIFICATION = 90_001
	}
}
