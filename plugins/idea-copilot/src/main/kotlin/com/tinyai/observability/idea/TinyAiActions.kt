package com.tinyai.observability.idea

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.components.service
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.application.ApplicationManager

class CaptureCopilotLogsAction : AnAction(), DumbAware {
    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Capturing TinyAI Copilot Logs", false) {
            override fun run(indicator: ProgressIndicator) {
                val count = project.service<TinyAiCopilotCollectorService>().captureNow()
                val message = if (count > 0) {
                    "Uploaded $count Copilot turn snapshot(s)."
                } else {
                    "No new Copilot log turns found."
                }
                ApplicationManager.getApplication().invokeLater {
                    Messages.showInfoMessage(project, message, "TinyAI Observability")
                }
            }
        })
    }

    override fun update(event: AnActionEvent) {
        event.presentation.isEnabled = event.project != null
    }
}

class SendHeartbeatAction : AnAction(), DumbAware {
    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Sending TinyAI Heartbeat", false) {
            override fun run(indicator: ProgressIndicator) {
                val collector = project.service<TinyAiCopilotCollectorService>()
                val ok = collector.sendHeartbeat()
                val message = if (ok) {
                    "TinyAI heartbeat uploaded."
                } else {
                    val detail = collector.lastSendError()?.take(240)
                    if (detail.isNullOrBlank()) {
                        "TinyAI heartbeat failed. Check collector URL and IDE logs."
                    } else {
                        "TinyAI heartbeat failed: $detail"
                    }
                }
                ApplicationManager.getApplication().invokeLater {
                    Messages.showInfoMessage(project, message, "TinyAI Observability")
                }
            }
        })
    }

    override fun update(event: AnActionEvent) {
        event.presentation.isEnabled = event.project != null
    }
}
