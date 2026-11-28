plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.kotlin.plugin.serialization")
}

android {
    namespace = "au.com.rootcauseobd.fleet"
    compileSdk = 37

    defaultConfig {
        applicationId = "au.com.rootcauseobd.fleet"
        minSdk = 26
        targetSdk = 35
        versionCode = 2
        versionName = "0.2.0"
        // RootCause cloud API the sign-in screen starts with. Release builds take it from
        // -Prootcause.cloudApiUrl=https://... (or gradle.properties); the user can still edit it.
        buildConfigField(
            "String",
            "DEFAULT_CLOUD_API_URL",
            "\"${(project.findProperty("rootcause.cloudApiUrl") as String?) ?: ""}\""
        )
    }

    buildTypes {
        debug {
            // The Android emulator reaches the host's `just dev` API at 10.0.2.2 (cleartext allowed
            // for that host only in network_security_config.xml).
            buildConfigField("String", "DEFAULT_CLOUD_API_URL", "\"http://10.0.2.2:8000\"")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.10.01")
    implementation(composeBom)
    implementation("androidx.activity:activity-compose:1.9.3")
    implementation("androidx.core:core-ktx:1.15.0")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material3:material3-window-size-class")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    // Ed25519 verification of the plan licence on every supported Android version (minSdk 26).
    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")

    testImplementation("junit:junit:4.13.2")
}
