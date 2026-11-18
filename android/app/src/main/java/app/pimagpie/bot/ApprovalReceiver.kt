package app.pimagpie.bot

import android.app.NotificationManager
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
		// Each card has its own notification, so answering one leaves the others up.
		val notification = ApprovalCards.idFor(id)
		val pending = goAsync()
		Thread {
			val status = try {
				val prefs = context.getSharedPreferences("bot", Context.MODE_PRIVATE)
				val session = prefs.getString("sid", null)
				if (session == null) {
					Logs.add("[app] could not answer an approval: no session")
					-1
				} else {
					val remote = app.pimagpie.bot.data.Remote(context)
					val base = remote.base.ifBlank { Runner.BASE }
					val cookie = listOf("sid=$session", remote.auth.ifBlank { null }).filterNotNull().joinToString("; ")
					val connection = java.net.URL("$base/api/approvals/$id").openConnection() as java.net.HttpURLConnection
					connection.requestMethod = "POST"
					connection.setRequestProperty("Cookie", cookie)
					if (remote.mode == app.pimagpie.bot.data.Remote.Mode.LOCAL) {
						connection.setRequestProperty("Authorization", "Bearer ${prefs.getString(app.pimagpie.bot.data.Api.TOKEN, "") ?: ""}")
					}
					connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
					connection.connectTimeout = 5_000
					connection.readTimeout = 10_000
					connection.doOutput = true
					connection.outputStream.use { it.write(JSONObject().put("allow", allow).toString().toByteArray()) }
					val code = connection.responseCode
					connection.disconnect()
					code
				}
			} catch (error: Exception) {
				Logs.add("[app] could not answer an approval: ${error.message}")
				-1
			}
			if (ApprovalCards.dismissAfter(status)) {
				context.getSystemService(NotificationManager::class.java).cancel(notification)
				ApprovalCards.forget(id)
			} else {
				Logs.add("[app] the answer did not reach the bot (HTTP $status); the card stays up to be pressed again")
			}
			pending.finish()
		}.start()
	}

	companion object {
		const val ACTION = "app.pimagpie.bot.APPROVAL"
		const val EXTRA_ID = "id"
		const val EXTRA_ALLOW = "allow"
	}
}
