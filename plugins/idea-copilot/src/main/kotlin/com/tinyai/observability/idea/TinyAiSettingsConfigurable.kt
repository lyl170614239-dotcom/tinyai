package com.tinyai.observability.idea

import com.intellij.openapi.options.Configurable
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.dsl.builder.bindIntText
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.panel

class TinyAiSettingsConfigurable : Configurable {
    private val settings = TinyAiSettings.getInstance()
    private lateinit var panel: DialogPanel

    override fun getDisplayName(): String = "TinyAI Observability"

    override fun createComponent(): DialogPanel {
        val state = settings.state

        panel = panel {
            row("Collector URL") {
                textField()
                    .bindText(state::collectorUrl)
                    .comment("Default: $DEFAULT_COLLECTOR_URL")
            }
            row("Token") {
                passwordField().bindText(state::token)
            }
            row("Name") {
                textField().bindText(state::userName)
            }
            row("User ID") {
                textField()
                    .bindText(state::userId)
                    .comment("Optional. If empty, TinyAI uses name.")
            }
            row("Team") {
                textField().bindText(state::team)
            }
            row("Extra Copilot log roots") {
                textArea()
                    .bindText(state::extraLogRoots)
                    .comment("One absolute directory per line.")
            }
            row {
                checkBox("Auto-capture Copilot logs").bindSelected(state::autoCaptureCopilotLogs)
            }
            row {
                checkBox("Capture existing log history on first scan").bindSelected(state::captureHistoryOnFirstScan)
            }
            row("Scan interval seconds") {
                intTextField(range = 10..3600).bindIntText(state::scanIntervalSeconds)
            }
        }

        return panel
    }

    override fun isModified(): Boolean = panel.isModified()

    override fun apply() {
        panel.apply()
    }

    override fun reset() {
        panel.reset()
    }
}
