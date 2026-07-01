package com.tinyai.observability.idea

import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.util.concurrency.AppExecutorUtil
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

@Service(Service.Level.PROJECT)
class TinyAiCopilotCollectorService(private val project: Project) : Disposable {
    private val log = Logger.getInstance(TinyAiCopilotCollectorService::class.java)
    private val settings = TinyAiSettings.getInstance()
    private val client = TinyAiCollectorClient(settings)
    private val scanner = TinyAiCopilotLogScanner(settings)
    private var scheduledFuture: ScheduledFuture<*>? = null

    fun start() {
        if (scheduledFuture != null) return

        AppExecutorUtil.getAppScheduledExecutorService().execute {
            runCatching {
                client.sendHeartbeat(project.name)
                captureNow()
            }.onFailure { log.warn("TinyAI initial JetBrains capture failed", it) }
        }

        val intervalSeconds = settings.state.scanIntervalSeconds.coerceAtLeast(10).toLong()
        scheduledFuture = AppExecutorUtil.getAppScheduledExecutorService().scheduleWithFixedDelay(
            {
                runCatching { captureNow() }
                    .onFailure { log.warn("TinyAI scheduled JetBrains capture failed", it) }
            },
            intervalSeconds,
            intervalSeconds,
            TimeUnit.SECONDS
        )
    }

    fun captureNow(): Int {
        if (!settings.state.autoCaptureCopilotLogs) return 0

        val turns = scanner.collectTurns()
        if (turns.isEmpty()) return 0

        val events = turns.map { turnToEvent(it) }
        return if (client.send(events)) events.size else 0
    }

    fun sendHeartbeat(): Boolean = client.sendHeartbeat(project.name)

    fun lastSendError(): String? = client.lastError()

    private fun turnToEvent(turn: ParsedCopilotTurn): TinyAiEvent {
        val identity = settings.identity()
        val payload = buildJsonObject {
            put("schema_version", JsonPrimitive(1))
            put("source", JsonPrimitive("idea-copilot-log"))
            put("session_id", JsonPrimitive(turn.sessionId))
            put("request_id", JsonPrimitive(turn.requestId))
            put("response_id", JsonPrimitive(turn.responseId))
            put("turn_index", JsonPrimitive(turn.turnIndex))
            put("user_message", JsonPrimitive(turn.userText))
            put("assistant_message", JsonPrimitive(turn.assistantText))
            put("source_file", JsonPrimitive(turn.sourceFile))
            put("source_offset", JsonPrimitive(turn.sourceOffset))
            put("project_name", JsonPrimitive(project.name))
            put("project_path", JsonPrimitive(project.basePath ?: ""))
            put("parser", JsonPrimitive("jetbrains-copilot-log-heuristic-v1"))
            put("messages", buildJsonArray {
                add(buildJsonObject {
                    put("role", JsonPrimitive("user"))
                    put("content", JsonPrimitive(turn.userText))
                })
                add(buildJsonObject {
                    put("role", JsonPrimitive("assistant"))
                    put("content", JsonPrimitive(turn.assistantText))
                })
            })
        }

        return TinyAiEvent(
            eventId = stableEventId("idea-copilot:${turn.sourceFile}:${turn.sourceOffset}:${turn.requestId}:${turn.responseId}"),
            taskId = turn.requestId,
            sessionId = turn.sessionId,
            eventType = "turn_snapshot",
            occurredAt = turn.occurredAt,
            sourceConfidence = "derived",
            username = identity.username,
            userId = identity.userId,
            userEmail = identity.userEmail,
            userDisplayName = identity.userDisplayName,
            team = identity.team,
            machineId = identity.machineId,
            hostHash = identity.hostHash,
            payload = payload
        )
    }

    override fun dispose() {
        scheduledFuture?.cancel(false)
        scheduledFuture = null
    }
}
