package app.pimagpie.bot

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.webkit.CookieManager
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import java.net.HttpURLConnection
import java.net.URL

/**
 * Two screens and nothing else: the chat this app is, and the wait while the
 * environment is unpacked. A first run that needs a terminal is not a first run
 * a beginner can do.
 */
class MainActivity : Activity() {
	private lateinit var stack: FrameLayout
	private lateinit var waiting: LinearLayout
	private lateinit var progressBar: ProgressBar
	private lateinit var status: TextView
	private lateinit var log: TextView
	private lateinit var start: Button
	private var web: WebView? = null
	private val handler = Handler(Looper.getMainLooper())

	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		build()
		askNotifications()

		if (Payload.installed(this)) {
			AssistantService.start(this)
			waitForAssistant()
		} else {
			showWaiting()
		}
	}

	override fun onResume() {
		super.onResume()
		App.onScreen = true
		Progress.listener = { text, percent -> handler.post { render(text, percent) } }
	}

	override fun onPause() {
		App.onScreen = false
		Progress.listener = null
		super.onPause()
	}

	private fun build() {
		stack = FrameLayout(this)
		waiting = LinearLayout(this).apply {
			orientation = LinearLayout.VERTICAL
			setBackgroundColor(Color.WHITE)
			setPadding(dp(24), dp(40), dp(24), dp(24))
		}

		val title = TextView(this).apply {
			text = getString(R.string.setup_title)
			setTextSize(TypedValue.COMPLEX_UNIT_SP, 26f)
			setTextColor(Color.parseColor("#1A1A1A"))
			setTypeface(typeface, Typeface.BOLD)
		}
		val body = TextView(this).apply {
			text = getString(R.string.setup_body)
			setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
			setTextColor(Color.parseColor("#444444"))
			setLineSpacing(dp(6).toFloat(), 1f)
			setPadding(0, dp(16), 0, dp(20))
		}
		progressBar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
			max = 100
			visibility = View.GONE
		}
		status = TextView(this).apply {
			text = ""
			setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
			setTextColor(Color.parseColor("#2F7CF6"))
			setPadding(0, dp(10), 0, dp(10))
		}
		log = TextView(this).apply {
			text = ""
			setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
			typeface = Typeface.MONOSPACE
			setTextColor(Color.parseColor("#666666"))
			setPadding(0, dp(8), 0, dp(8))
			visibility = View.GONE
		}
		val logBox = ScrollView(this).apply {
			addView(log, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
			visibility = View.GONE
			layoutParams = LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f)
		}
		start = Button(this).apply {
			text = getString(R.string.setup_button)
			setOnClickListener { begin() }
		}

		waiting.addView(title)
		waiting.addView(body)
		waiting.addView(progressBar, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT))
		waiting.addView(status)
		waiting.addView(logBox)
		waiting.addView(start, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(16) })

		// The log is for when something is wrong, not a thing to show a beginner.
		title.setOnLongClickListener {
			val showing = logBox.visibility == View.VISIBLE
			logBox.visibility = if (showing) View.GONE else View.VISIBLE
			if (!showing) log.text = Logs.tail()
			true
		}

		stack.addView(waiting, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
		setContentView(stack)

		if (Progress.line.isNotEmpty()) render(Progress.line, Progress.percent)
		else status.text = if (Payload.installed(this)) getString(R.string.starting) else ""
	}

	/** The button that starts everything: unpack, then run. */
	private fun begin() {
		start.visibility = View.GONE
		progressBar.visibility = View.VISIBLE
		progressBar.isIndeterminate = true
		status.text = getString(R.string.installing)
		AssistantService.start(this)
		waitForAssistant()
	}

	private fun showWaiting() {
		start.visibility = View.VISIBLE
	}

	private fun render(text: String, percent: Int) {
		status.text = text
		if (percent >= 0 && !Payload.installed(this)) {
			progressBar.visibility = View.VISIBLE
			progressBar.isIndeterminate = false
			progressBar.progress = percent
		}
		if (log.visibility == View.VISIBLE) log.text = Logs.tail()
	}

	/**
	 * Polls the loopback until something answers, then shows it. What answers may
	 * be the chat or the page that takes a key, and both belong in this window: a
	 * spinner in front of a page the phone is already serving is a dead end.
	 */
	private fun waitForAssistant() {
		progressBar.visibility = View.VISIBLE
		progressBar.isIndeterminate = true
		status.text = getString(R.string.starting)

		Thread {
			// Ten minutes is a slow first run on an old phone; past that something
			// is wrong, and the log is what says what.
			repeat(600) {
				if (isFinishing) return@Thread
				if (answers()) {
					val session = session()
					handler.post { showPage(session) }
					return@Thread
				}
				Thread.sleep(1_000)
			}
			handler.post { status.text = Logs.tail() }
		}.start()
	}

	/**
	 * One session for both of us: the page and the notification watcher have to be
	 * the same conversation, or a reminder would land in a room nobody is in. The
	 * server is asked first, so a session from before a reinstall is replaced
	 * rather than believed.
	 */
	private fun session(): String? {
		val prefs = getSharedPreferences("bot", MODE_PRIVATE)
		return try {
			val connection = URL("${Runner.BASE}/").openConnection() as HttpURLConnection
			connection.connectTimeout = 2_000
			connection.readTimeout = 2_000
			connection.requestMethod = "GET"
			connection.responseCode
			val header = connection.getHeaderFields()["Set-Cookie"]?.firstOrNull()
			connection.disconnect()
			val sid = header?.substringAfter("sid=", "")?.substringBefore(";")
			if (sid.isNullOrEmpty()) prefs.getString(AssistantService.SESSION, null)
			else {
				prefs.edit().putString(AssistantService.SESSION, sid).apply()
				sid
			}
		} catch (_: Exception) {
			prefs.getString(AssistantService.SESSION, null)
		}
	}

	private fun answers(): Boolean = try {
		val connection = URL("${Runner.BASE}/healthz").openConnection() as HttpURLConnection
		connection.connectTimeout = 1_000
		connection.readTimeout = 1_000
		val ok = connection.responseCode == 200
		connection.disconnect()
		ok
	} catch (_: Exception) {
		false
	}

	private fun showPage(session: String?) {
		if (web != null || isFinishing) return
		progressBar.visibility = View.GONE

		val view = WebView(this).apply {
			settings.javaScriptEnabled = true
			settings.domStorageEnabled = true
			settings.setSupportZoom(false)
			settings.builtInZoomControls = false
			settings.mediaPlaybackRequiresUserGesture = true
			setBackgroundColor(Color.WHITE)
			webViewClient = object : WebViewClient() {
				override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
					val url = request.url
					if (url.host == "127.0.0.1" || url.host == "localhost") return false
					// A link the user tapped belongs in the browser they trust.
					startActivity(Intent(Intent.ACTION_VIEW, url))
					return true
				}
			}
		}

		if (session != null) cookie(session)

		web = view
		stack.removeAllViews()
		stack.addView(view, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
		view.loadUrl(Runner.BASE)

		// The page that takes a key has no session yet; it gets one when the key
		// turns the chat on, and that is the moment this becomes the chat.
		if (session == null) follow()

		askBattery()
	}

	private fun cookie(session: String) {
		CookieManager.getInstance().apply {
			setAcceptCookie(true)
			setCookie(Runner.BASE, "sid=$session; Path=/")
			flush()
		}
	}

	/** Watches for the session the setup page has not given out yet. */
	private fun follow() {
		Thread {
			while (!isFinishing) {
				val session = session()
				if (session != null) {
					handler.post {
						cookie(session)
						web?.reload()
					}
					return@Thread
				}
				Thread.sleep(5_000)
			}
		}.start()
	}

	private fun askNotifications() {
		if (Build.VERSION.SDK_INT < 33) return
		if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
		requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
	}

	/**
	 * Asked once, in the user's own words: without it Android closes the assistant
	 * to save power, and a reminder that never came is worse than no reminder.
	 */
	private fun askBattery() {
		val prefs = getSharedPreferences("bot", MODE_PRIVATE)
		if (prefs.getBoolean("askedBattery", false)) return
		val power = getSystemService(PowerManager::class.java)
		if (power.isIgnoringBatteryOptimizations(packageName)) return
		prefs.edit().putBoolean("askedBattery", true).apply()
		try {
			startActivity(
				Intent(
					Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
					Uri.parse("package:$packageName"),
				),
			)
		} catch (_: Exception) {
			// A phone that does not offer it is a phone that will not be asked again.
		}
	}

	override fun onBackPressed() {
		val view = web
		if (view != null && view.canGoBack()) view.goBack() else super.onBackPressed()
	}

	private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
