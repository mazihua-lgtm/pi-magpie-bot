package app.pimagpie.bot

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.os.Build
import android.os.IBinder
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * The assistant runs here, and this is the whole of why the app exists: a
 * process that is still there at seven in the morning, with the phone locked.
 */
class AssistantService : Service() {
	@Volatile
	private var keepRunning = true
	private var bot: Process? = null
	private var worker: Thread? = null
	private var watcher: Thread? = null

	override fun onBind(intent: Intent?): IBinder? = null

	override fun onCreate() {
		super.onCreate()
		channel(CHANNEL_RUN, getString(R.string.running), NotificationManager.IMPORTANCE_LOW)
		channel(CHANNEL_ALERT, "提醒", NotificationManager.IMPORTANCE_HIGH)
		watchNetwork()
	}

	/**
	 * The root's resolver is a file this app writes, and it is written from the
	 * network the phone was on at the time. Moving from Wi-Fi to mobile data
	 * leaves an address that no longer answers, and then every lookup fails
	 * while the assistant still looks alive: it answers "the free pool may be
	 * used up" because that is what a failed request looks like from inside.
	 */
	private fun watchNetwork() {
		try {
			val connectivity = getSystemService(ConnectivityManager::class.java)
			connectivity.registerDefaultNetworkCallback(
				object : ConnectivityManager.NetworkCallback() {
					override fun onAvailable(network: Network) = refreshNameservers()
					override fun onLinkPropertiesChanged(network: Network, properties: LinkProperties) = refreshNameservers()
				},
			)
		} catch (error: Exception) {
			Logs.add("[app] could not watch the network: ${error.message}")
		}
	}

	private fun refreshNameservers() {
		try {
			nameservers()
			Logs.add("[app] 网络变了，DNS 已更新")
		} catch (error: Exception) {
			Logs.add("[app] could not refresh DNS: ${error.message}")
		}
	}

	override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
		if (intent?.action == ACTION_STOP) {
			stopSelf()
			return START_NOT_STICKY
		}

		// A restarted service (the system brought the process back) has nothing to
		// unpack: the marker on disk is what says whether there is anything to run.
		foreground(if (Payload.installed(this)) getString(R.string.starting) else getString(R.string.installing))

		if (worker == null) worker = Thread({ work() }, "assistant").also { it.start() }
		if (watcher == null) watcher = Thread({ watch() }, "reminders").also { it.start() }
		return START_STICKY
	}

	override fun onDestroy() {
		keepRunning = false
		bot?.let { process ->
			// proot holds the agent as its child; killing proot takes the tree.
			process.destroy()
		}
		super.onDestroy()
	}

	private fun work() {
		try {
			nameservers()
			// Unpack only when nothing is serving: a re-unpack deletes the very
			// directory an assistant that survived the last process is running
			// from, and "an assistant is already answering" would then keep a
			// limping old one alive forever while the new one never starts.
			if (!Payload.installed(this) && !answering()) {
				Progress.post(getString(R.string.installing), 0)
				Payload.unpack(this) { percent -> Progress.post(getString(R.string.installing), percent) }
				Logs.add("[app] the environment is unpacked")
			}

			while (keepRunning) runOnce()
		} catch (error: Throwable) {
			Logs.add("[app] ${error.javaClass.simpleName}: ${error.message}")
			android.util.Log.e("assistant", "the assistant could not start", error)
			Progress.failed(error)
			stopSelf()
		}
	}

	private fun runOnce() {
		val started = System.currentTimeMillis()
		// An assistant from a previous start may still be answering (proot survived
		// a force-stop, or this service was restarted while it ran). Starting a
		// second one lands on a busy port, exits, and loops every twenty seconds;
		// the one already running is what the user wants anyway.
		if (answering()) {
			Logs.add("[app] an assistant is already answering on ${Runner.BASE}; leaving it alone")
			Progress.post(getString(R.string.running), -1)
			foreground(getString(R.string.running))
			sleep(30_000)
			return
		}
		val process = try {
			ProcessBuilder(Runner.command(this))
				.directory(Paths.root(this))
				.redirectErrorStream(true)
				.apply {
					environment().clear()
					environment().putAll(Runner.environment(this@AssistantService))
				}
				.start()
		} catch (error: Exception) {
			Logs.add("[app] could not start the assistant: ${error.message}")
			// `failed` turns the raw exception into a sentence a person can act on
			// and puts the retry button back; posting the message alone shows an
			// English errno above a spinner that never stops.
			Progress.failed(error)
			sleep(10_000)
			return
		}

		bot = process
		Progress.post(getString(R.string.running), -1)
		foreground(getString(R.string.running))
		process.inputStream.bufferedReader().useLines { lines -> lines.forEach { Logs.add(it) } }
		val code = process.waitFor()
		bot = null
		if (!keepRunning) return

		Logs.add("[app] the assistant stopped (exit $code)")
		// A restart is about to happen by itself, so this is not a failure state:
		// it is the honest description of what the user is looking at.
		Progress.post(getString(R.string.failed_restart), -1)
		// A run that lasted a while ended of its own accord; one that dies at once
		// is a fault, and restarting it hot would only fill the log.
		sleep(if (System.currentTimeMillis() - started < 10_000) 20_000 else 2_000)
	}

	/**
	 * Reminders reach the page as they happen, so the page does not have to be
	 * open: the same stream is read here, and anything that is news rather than
	 * history becomes a notification.
	 */
	private fun watch() {
		while (keepRunning) {
			if (!listen()) sleep(3_000)
		}
	}

	private val alerted = HashMap<String, Long>()

	private fun listen(): Boolean {
		val session = getSharedPreferences(PREFS, MODE_PRIVATE).getString(SESSION, null) ?: return false
		val connection = URL("${Runner.BASE}/api/events?v=2").openConnection() as HttpURLConnection
		return try {
			connection.setRequestProperty("Cookie", "sid=$session")
			connection.setRequestProperty("Accept", "text/event-stream")
			connection.connectTimeout = 5_000
			connection.readTimeout = 0

			connection.inputStream.bufferedReader().useLines { lines ->
				var name = ""
				for (line in lines) {
					if (!keepRunning) return true
					when {
						line.startsWith("event:") -> name = line.removePrefix("event:").trim()
						line.startsWith("data:") -> {
							// Only news: answers, reminders, and questions that wait on the user.
							if (!App.onScreen) {
								val event = JSONObject(line.removePrefix("data:").trim())
								val chat = event.optString("chat")
								when (name) {
									"message" -> event.optString("text").takeIf { it.isNotEmpty() }?.let { alert(getString(R.string.app_name), it, chat) }
									"approval" -> {
										// The server replays every still-open card to each new
										// connection; a card is news once, not once per reconnect.
										val id = event.optString("id")
										val due = System.currentTimeMillis()
										if (id.isNotEmpty() && alerted.put(id, due) == null) alert("需要你同意", event.optString("action"), chat)
										alerted.entries.removeAll { due - it.value > 10 * 60_000 }
									}
								}
							}
						}
						line.isEmpty() -> name = ""
					}
				}
			}
			false
		} catch (_: Exception) {
			false
		} finally {
			connection.disconnect()
		}
	}

	private fun alert(title: String, text: String, chat: String) {
		val manager = getSystemService(NotificationManager::class.java)
		val open = PendingIntent.getActivity(
			this,
			chat.hashCode(),
			Intent(this, MainActivity::class.java)
				.putExtra(MainActivity.EXTRA_CHAT, chat)
				.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
			PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
		)
		val plain = text.replace(Regex("[*_`#>]"), "").trim()
		val notification = Notification.Builder(this, CHANNEL_ALERT)
			.setSmallIcon(R.drawable.ic_notify)
			.setContentTitle(title)
			.setContentText(plain)
			.setStyle(Notification.BigTextStyle().bigText(plain))
			.setAutoCancel(true)
			.setContentIntent(open)
			.build()
		manager.notify(ALERT_ID++, notification)
	}

	private fun foreground(text: String) {
		val open = PendingIntent.getActivity(
			this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
		)
		val notification = Notification.Builder(this, CHANNEL_RUN)
			.setSmallIcon(R.drawable.ic_notify)
			.setContentTitle(getString(R.string.app_name))
			.setContentText(text)
			.setOngoing(true)
			.setContentIntent(open)
			.build()
		if (Build.VERSION.SDK_INT >= 34) {
			startForeground(RUNNING_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
		} else {
			startForeground(RUNNING_ID, notification)
		}
	}

	private fun channel(id: String, name: String, importance: Int) {
		val manager = getSystemService(NotificationManager::class.java)
		if (manager.getNotificationChannel(id) == null) {
			manager.createNotificationChannel(NotificationChannel(id, name, importance))
		}
	}

	/**
	 * A proot has no resolver of its own: the phone's own name servers are written
	 * where glibc looks for them. Without this, nothing the agent calls resolves.
	 */
	private fun nameservers() {
		val lines = mutableListOf<String>()
		val connectivity = getSystemService(ConnectivityManager::class.java)
		for (network in connectivity.allNetworks) {
			val properties = connectivity.getLinkProperties(network) ?: continue
			for (server in properties.dnsServers) {
				val line = "nameserver ${server.hostAddress}"
				if (line !in lines) lines.add(line)
			}
		}
		// Nothing reachable answers with no network at all, and the two everyone in
		// China can reach are still better than an empty file when it comes back.
		if (lines.isEmpty()) {
			lines.add("nameserver 223.5.5.5")
			lines.add("nameserver 8.8.8.8")
		}
		Paths.resolv(this).writeText(lines.joinToString("\n", postfix = "\n"))
	}

	/** Whether something is already serving the chat on the loopback port. */
	private fun answering(): Boolean = try {
		val connection = URL("${Runner.BASE}/healthz").openConnection() as HttpURLConnection
		connection.connectTimeout = 1_000
		connection.readTimeout = 1_000
		val ok = connection.responseCode == 200
		connection.disconnect()
		ok
	} catch (_: Exception) {
		false
	}

	private fun sleep(ms: Long) {
		try {
			Thread.sleep(ms)
		} catch (_: InterruptedException) {
			Thread.currentThread().interrupt()
		}
	}

	companion object {
		const val ACTION_STOP = "app.pimagpie.bot.STOP"
		private const val CHANNEL_RUN = "running"
		private const val CHANNEL_ALERT = "reminders"
		private const val RUNNING_ID = 1
		private var ALERT_ID = 100
		private const val PREFS = app.pimagpie.bot.data.Api.PREFS
		private const val SESSION = app.pimagpie.bot.data.Api.SESSION

		fun start(context: Context) {
			context.startForegroundService(Intent(context, AssistantService::class.java))
		}
	}
}
