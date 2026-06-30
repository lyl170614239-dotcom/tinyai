package com.tinyai.observability.idea

import com.intellij.openapi.components.service
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity

class TinyAiStartupActivity : ProjectActivity, DumbAware {
    override suspend fun execute(project: Project) {
        project.service<TinyAiCopilotCollectorService>().start()
    }
}
