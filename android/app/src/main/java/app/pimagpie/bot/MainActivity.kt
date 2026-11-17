package app.pimagpie.bot

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DrawerValue
import androidx.compose.material3.ModalNavigationDrawer
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.rememberDrawerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.unit.dp
import androidx.core.view.WindowCompat
import app.pimagpie.bot.ui.AppTheme
import app.pimagpie.bot.ui.BootScreen
import app.pimagpie.bot.ui.ChatScreen
import app.pimagpie.bot.ui.Drawer
import app.pimagpie.bot.ui.KeyScreen
import app.pimagpie.bot.ui.LocalPalette
import app.pimagpie.bot.ui.MemoryScreen
import app.pimagpie.bot.ui.SettingsScreen
import app.pimagpie.bot.ui.TasksScreen
import kotlinx.coroutines.launch

/**
 * The app is this one window: the wait while the environment comes up, then the
 * chat, its list, and the pages beside it. The assistant itself runs in
 * [AssistantService]; this only talks to it.
 */
class MainActivity : ComponentActivity() {
	private val model: AppModel by viewModels()

	override fun onCreate(savedInstanceState: Bundle?) {
		enableEdgeToEdge(
			statusBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
			navigationBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
		)
		super.onCreate(savedInstanceState)
		askNotifications()
		openFrom(intent)
		setContent {
			AppTheme(model.themeMode) { Root(model) }
		}
	}

	override fun onNewIntent(intent: Intent) {
		super.onNewIntent(intent)
		openFrom(intent)
	}

	/** A notification names the chat it came from. */
	private fun openFrom(intent: Intent?) {
		val chat = intent?.getStringExtra(EXTRA_CHAT) ?: return
		model.open(chat)
	}

	override fun onResume() {
		super.onResume()
		App.onScreen = true
	}

	override fun onPause() {
		App.onScreen = false
		super.onPause()
	}

	private fun askNotifications() {
		if (Build.VERSION.SDK_INT < 33) return
		if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
		requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
	}

	/**
	 * Asked once: without it Android closes the assistant to save power, and a
	 * reminder that never came is worse than no reminder.
	 */
	fun askBattery() {
		val prefs = getSharedPreferences("bot", MODE_PRIVATE)
		if (prefs.getBoolean("askedBattery", false)) return
		val power = getSystemService(PowerManager::class.java)
		if (power.isIgnoringBatteryOptimizations(packageName)) return
		prefs.edit().putBoolean("askedBattery", true).apply()
		runCatching {
			startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
		}
	}

	companion object {
		const val EXTRA_CHAT = "chat"
	}
}

@Composable
private fun Root(model: AppModel) {
	val palette = LocalPalette.current
	// The bars' icons follow the app's own theme, which may differ from the system's.
	val view = LocalView.current
	SideEffect {
		val window = (view.context as? android.app.Activity)?.window ?: return@SideEffect
		WindowCompat.getInsetsController(window, view).apply {
			isAppearanceLightStatusBars = !palette.dark
			isAppearanceLightNavigationBars = !palette.dark
		}
	}
	val snackbar = remember { SnackbarHostState() }
	LaunchedEffect(Unit) {
		model.toasts.collect {
			snackbar.currentSnackbarData?.dismiss()
			snackbar.showSnackbar(it)
		}
	}
	Box(Modifier.fillMaxSize().background(palette.ground)) {
		AnimatedContent(
			targetState = when (model.boot) {
				is Boot.Preparing -> 0
				Boot.NeedsKey -> 1
				Boot.Ready -> 2
			},
			transitionSpec = { fadeIn() togetherWith fadeOut() },
			label = "boot",
		) { stage ->
			when (stage) {
				0 -> (model.boot as? Boot.Preparing)?.let { BootScreen(model, it) }
				1 -> KeyScreen(model)
				else -> Main(model)
			}
		}
		SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().imePadding().padding(start = 16.dp, end = 16.dp, bottom = 96.dp)) {
			Snackbar(shape = RoundedCornerShape(14.dp), containerColor = palette.ink, contentColor = palette.onInk) { Text(it.visuals.message) }
		}
	}
}

@Composable
private fun Main(model: AppModel) {
	val drawer = rememberDrawerState(DrawerValue.Closed)
	val scope = rememberCoroutineScope()
	val activity = LocalContext.current as? MainActivity
	LaunchedEffect(Unit) { activity?.askBattery() }

	BackHandler(drawer.isOpen) { scope.launch { drawer.close() } }
	BackHandler(!drawer.isOpen && model.screen != Screen.Chat) { model.screen = Screen.Chat }

	ModalNavigationDrawer(
		drawerState = drawer,
		gesturesEnabled = model.screen == Screen.Chat || drawer.isOpen,
		drawerContent = { Drawer(model) { scope.launch { drawer.close() } } },
	) {
		AnimatedContent(model.screen, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "screen") { screen ->
			when (screen) {
				Screen.Chat -> ChatScreen(model, onMenu = { scope.launch { drawer.open() } })
				Screen.Tasks -> TasksScreen(model)
				Screen.Memory -> MemoryScreen(model)
				Screen.Settings -> SettingsScreen(model)
			}
		}
	}
}
