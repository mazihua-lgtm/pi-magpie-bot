plugins {
	id("com.android.application")
	id("org.jetbrains.kotlin.android")
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
		versionCode = 1
		versionName = "0.1.0"
		// The environment inside is linux-arm64: one payload, so one kind of phone.
		ndk { abiFilters += listOf("arm64-v8a") }
	}

	buildTypes {
		release {
			isMinifyEnabled = false
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
	// The one dependency: a tarball reader that keeps symlinks, which is how
	// node_modules holds the workspace packages together.
	implementation("org.apache.commons:commons-compress:1.27.1")
}
