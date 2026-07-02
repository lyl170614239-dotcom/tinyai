package com.tinyai.observability.idea

import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.util.concurrency.AppExecutorUtil
import kotlinx.serialization.json.JsonElement
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

        val scan = scanner.collectScanResult()
        val scannedAt = nowIso()
        if (scan.turns.isEmpty()) {
            updateDiagnostics(scan, TinyAiBatchUploadResult(), scannedAt, null)
            return 0
        }

        val identity = settings.identity()
        val clientId = copilotClientId(identity)
        val uploadable = scan.turns
            .map { turn ->
                val eventId = copilotTurnEventId(clientId, turn.sessionId, turn.requestId, turn.responseId)
                Triple(turn, eventId, turn.signature())
            }
            .filter { (_, eventId, signature) ->
                settings.state.turnCaptureStates[eventId]?.isAcknowledged(signature) != true
            }

        if (uploadable.isEmpty()) {
            updateDiagnostics(scan, TinyAiBatchUploadResult(duplicates = scan.turns.size), scannedAt, null)
            return 0
        }

        uploadable.forEach { (_, eventId, signature) ->
            markQueued(eventId, signature, scannedAt)
        }

        val events = uploadable.map { (turn, eventId, _) -> turnToEvent(turn, identity, eventId) }
        val result = client.send(events)
        applyUploadResult(events, result, scannedAt)
        updateDiagnostics(scan, result, scannedAt, client.lastError())
        return result.accepted + result.duplicates
    }

    fun sendHeartbeat(): Boolean = client.sendHeartbeat(project.name)

    fun lastSendError(): String? = client.lastError()

    private fun turnToEvent(
        turn: ParsedCopilotTurn,
        identity: TinyAiIdentity,
        eventId: String
    ): TinyAiEvent {
        val payload = buildTurnPayload(
            turn = turn,
            projectName = project.name,
            projectPath = project.basePath ?: ""
        )

        return TinyAiEvent(
            eventId = eventId,
            taskId = "copilot-local-${turn.sessionId}".take(64),
            sessionId = turn.sessionId,
            eventType = "turn_snapshot",
            occurredAt = turn.occurredAt,
            sourceConfidence = "derived",
            username = identity.username,
            userId = identity.userId,
            userDisplayName = identity.userDisplayName,
            team = identity.team,
            machineId = identity.machineId,
            hostHash = identity.hostHash,
            payload = payload
        )
    }

    private fun markQueued(eventId: String, signature: String, now: String) {
        val existing = settings.state.turnCaptureStates[eventId]
        settings.state.turnCaptureStates[eventId] = TinyAiTurnCaptureState(
            eventId = eventId,
            signature = signature,
            status = "queued",
            firstSeenAt = existing?.firstSeenAt?.takeIf { it.isNotBlank() } ?: now,
            lastAttemptAt = now,
            acknowledgedAt = existing?.acknowledgedAt,
            errorCount = existing?.errorCount ?: 0,
            lastError = null
        )
    }

    private fun applyUploadResult(events: List<TinyAiEvent>, result: TinyAiBatchUploadResult, now: String) {
        val resultByEventId = result.events.associateBy { it.eventId }
        events.forEach { event ->
            val state = settings.state.turnCaptureStates[event.eventId] ?: return@forEach
            val item = resultByEventId[event.eventId]
            val status = item?.status?.lowercase()
            if (status in setOf("accepted", "duplicate", "duplicated") || (item == null && result.failed == 0 && !result.queued)) {
                state.status = "acknowledged"
                state.acknowledgedAt = now
                state.lastError = null
                return@forEach
            }

            state.status = if (result.queued) "queued" else "failed"
            state.errorCount += 1
            state.lastError = item?.reason ?: client.lastError() ?: "collector did not acknowledge event"
        }
    }

    private fun updateDiagnostics(
        scan: TinyAiScanResult,
        result: TinyAiBatchUploadResult,
        scannedAt: String,
        lastError: String?
    ) {
        settings.state.lastScanDiagnostics = TinyAiScanDiagnostics(
            scannedAt = scannedAt,
            filesScanned = scan.filesScanned,
            turnsParsed = scan.turns.size,
            turnsUploaded = result.accepted + result.duplicates,
            parseErrorCount = scan.parseErrorCount,
            uploadErrorCount = result.failed,
            lastErrorCategory = errorCategory(lastError)
        )
    }

    private fun errorCategory(error: String?): String? {
        if (error.isNullOrBlank()) return null
        return when {
            error.startsWith("HTTP ") -> "http"
            error.contains("blocked", ignoreCase = true) -> "security"
            error.contains("timeout", ignoreCase = true) -> "timeout"
            else -> "network"
        }
    }

    override fun dispose() {
        scheduledFuture?.cancel(false)
        scheduledFuture = null
    }

    companion object {
        internal fun buildTurnPayload(
            turn: ParsedCopilotTurn,
            projectName: String,
            projectPath: String
        ): Map<String, JsonElement> = buildJsonObject {
            put("schema_version", JsonPrimitive("copilot.turn_snapshot.v1"))
            put("source", JsonPrimitive("idea-copilot-log"))
            put("session_id", JsonPrimitive(turn.sessionId))
            put("request_id", JsonPrimitive(turn.requestId))
            put("response_id", JsonPrimitive(turn.responseId))
            put("turn_index", JsonPrimitive(turn.turnIndex))
            put("attempt", JsonPrimitive(turn.attempt))
            put("started_at", JsonPrimitive(turn.startedAt))
            put("completed_at", JsonPrimitive(turn.completedAt))
            put("project_name", JsonPrimitive(projectName))
            put("project_path", JsonPrimitive(projectPath))
            put("include_text", JsonPrimitive(true))
            put("retention_policy", JsonPrimitive("permanent"))
            turn.model?.let {
                put("model", JsonPrimitive(it))
                put("resolved_model", JsonPrimitive(it))
            }
            put("source_files", buildJsonObject {
                put("jetbrains_copilot", buildJsonObject {
                    put("path", JsonPrimitive(turn.sourceFile))
                    put("offset", JsonPrimitive(turn.sourceOffset))
                    put("mtime_ms", JsonPrimitive(turn.sourceMtimeMs))
                    put("size_bytes", JsonPrimitive(turn.sourceSizeBytes))
                    put("source_kind", JsonPrimitive(turn.sourceKind))
                    put("parser_version", JsonPrimitive(turn.parserVersion))
                    put("capture_limitations", JsonPrimitive("Derived from local JetBrains Copilot artifacts; tool calls and token usage may be unavailable."))
                })
            })
            put("turn", buildJsonObject {
                put("turn_index", JsonPrimitive(turn.turnIndex))
                put("request_id", JsonPrimitive(turn.requestId))
                put("response_id", JsonPrimitive(turn.responseId))
                put("attempt", JsonPrimitive(turn.attempt))
                put("status", JsonPrimitive("completed"))
                put("started_at", JsonPrimitive(turn.startedAt))
                put("completed_at", JsonPrimitive(turn.completedAt))
            })
            put("user_message", buildJsonObject {
                put("role", JsonPrimitive("user"))
                put("text", JsonPrimitive(turn.userText))
                put("text_hash", JsonPrimitive(textHash(turn.userText)))
                put("source", JsonPrimitive(turn.sourceKind))
                put("occurred_at", JsonPrimitive(turn.startedAt))
            })
            put("assistant_message", buildJsonObject {
                put("role", JsonPrimitive("assistant"))
                put("text", JsonPrimitive(turn.assistantText))
                put("text_hash", JsonPrimitive(textHash(turn.assistantText)))
                put("source", JsonPrimitive(turn.sourceKind))
                put("occurred_at", JsonPrimitive(turn.completedAt))
            })
            put("messages", buildJsonArray {
                add(buildJsonObject {
                    put("role", JsonPrimitive("user"))
                    put("text", JsonPrimitive(turn.userText))
                    put("text_hash", JsonPrimitive(textHash(turn.userText)))
                    put("source", JsonPrimitive(turn.sourceKind))
                    put("source_key", JsonPrimitive("${turn.requestId}:user"))
                    put("occurred_at", JsonPrimitive(turn.startedAt))
                })
                add(buildJsonObject {
                    put("role", JsonPrimitive("assistant"))
                    put("text", JsonPrimitive(turn.assistantText))
                    put("text_hash", JsonPrimitive(textHash(turn.assistantText)))
                    put("source", JsonPrimitive(turn.sourceKind))
                    put("source_key", JsonPrimitive("${turn.requestId}:${turn.responseId}:assistant"))
                    put("occurred_at", JsonPrimitive(turn.completedAt))
                })
            })
            put("request_usage", buildJsonArray { })
            put("usage_totals", buildJsonObject { })
        }

        fun turnPayloadForTest(
            turn: ParsedCopilotTurn,
            projectName: String = "Test Project",
            projectPath: String = "/tmp/test-project"
        ): Map<String, JsonElement> = buildTurnPayload(turn, projectName, projectPath)
    }
}
