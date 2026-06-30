plugins {
    id("java")
    id("org.jetbrains.kotlin.jvm") version "2.2.21"
    id("org.jetbrains.kotlin.plugin.serialization") version "2.2.21"
    id("org.jetbrains.intellij.platform")
}

group = providers.gradleProperty("pluginGroup").get()
version = providers.gradleProperty("pluginVersion").get()

kotlin {
    jvmToolchain(21)
}

dependencies {
    intellijPlatform {
        val localIdePath = providers.gradleProperty("localIdePath").orNull?.trim()
        if (!localIdePath.isNullOrEmpty()) {
            local(localIdePath)
        } else {
            create(
                providers.gradleProperty("platformType").get(),
                providers.gradleProperty("platformVersion").get()
            )
        }
    }

    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")
}

intellijPlatform {
    pluginConfiguration {
        name = providers.gradleProperty("pluginName")
        version = providers.gradleProperty("pluginVersion")
        ideaVersion {
            sinceBuild = providers.gradleProperty("pluginSinceBuild")
        }
    }

    publishing {
        token = providers.gradleProperty("intellijPlatformPublishingToken")
        channels = listOf(providers.gradleProperty("pluginReleaseChannel").getOrElse("default"))
        hidden = providers.gradleProperty("pluginReleaseHidden")
            .map { it.toBoolean() }
            .getOrElse(true)
    }
}

tasks {
    patchPluginXml {
        sinceBuild.set(providers.gradleProperty("pluginSinceBuild"))
    }

    named("instrumentCode") {
        enabled = false
    }
}
