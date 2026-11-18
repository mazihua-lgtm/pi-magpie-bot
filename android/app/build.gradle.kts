plugins {
	id("com.android.application")
	id("org.jetbrains.kotlin.android")
	id("org.jetbrains.kotlin.plugin.compose")
}

android {
	namespace = "app.pimagpie.bot"
	compileSdk = 35

	defaultConfig {
		applicationId = "app.pimagpie.bot"
		// 8 is where a foreground service, a notification channel and proot's
		// ptrace all work without root.
		minSdk = 26
		// 28, not the newest: from 29 Android refuses to execute a file this app
		// unpacked into its own data directory, and the whole assistant is a proot
		// that starts node from there. Termux is pinned the same way.
		targetSdk = 28
		// Bump on every payload change: the app compares this against the marker
		// written when it last unpacked, and re-unpacks when they differ. Without
		// that, an updated APK keeps running the old node, magpie and bot code,
		// and an update looks like it did nothing.
		versionCode = 9
		versionName = "0.4.1"
		// The environment inside is linux-arm64: one payload, so one kind of phone.
		ndk { abiFilters += listOf("arm64-v8a") }
	}

	buildTypes {
		release {
			// On, for the icon set: without it every icon Material has ships in the
			// APK. The rules keep only what the payload reader needs by name.
			isMinifyEnabled = true
			proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
			// A key made here, not one from a store: the APK is handed out from
			// GitHub, and nothing about this app needs Play to sign it.
			signingConfig = signingConfigs.getByName("debug")
		}
	}

	compileOptions {
		sourceCompatibility = JavaVersion.VERSION_17
		targetCompatibility = JavaVersion.VERSION_17
	}

	kotlinOptions {
		jvmTarget = "17"
	}

	buildFeatures {
		compose = true
		buildConfig = true
	}

	lint {
		// 28 on purpose (see targetSdk above), and the APK is not for Play.
		disable += "ExpiredTargetSdkVersion"
	}

	androidResources {
		// The payload is already a gzip, and AAPT2 takes a `.gz` asset apart and
		// stores the tar inside it - three times the size, and no longer the file
		// the app asks for. The extension is opaque for that reason.
		noCompress += listOf("payload")
	}

	packaging {
		resources.excludes += listOf("META-INF/versions/9/OSGI-INF/MANIFEST.MF")
	}
}

dependencies {
	// A tarball reader that keeps symlinks, which is how node_modules holds the
	// workspace packages together.
	implementation("org.apache.commons:commons-compress:1.27.1")

	// The screens. Pinned to the last line that builds against SDK 35.
	implementation(platform("androidx.compose:compose-bom:2024.12.01"))
	implementation("androidx.compose.ui:ui")
	implementation("androidx.compose.foundation:foundation")
	implementation("androidx.compose.material3:material3")
	implementation("androidx.compose.material:material-icons-extended")
	implementation("androidx.activity:activity-compose:1.9.3")
	implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.7")
	implementation("androidx.lifecycle:lifecycle-runtime-compose:2.8.7")
	// FileProvider, for handing the diagnostics file to whatever app the user picks.
	implementation("androidx.core:core-ktx:1.15.0")
	implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.9.0")
	debugImplementation("androidx.compose.ui:ui-tooling")

	// QR scan for pairing to an assistant on another machine. Bundles its own
	// capture activity, so a phone without GMS (common here) still works.
	implementation("com.journeyapps:zxing-android-embedded:4.3.0")

	// The two pieces of phone-side logic that broke once: the reconnect wait and
	// the shade's notification ids. Both are plain Kotlin, so they are tested here
	// rather than on a device.
	testImplementation("junit:junit:4.13.2")
}
