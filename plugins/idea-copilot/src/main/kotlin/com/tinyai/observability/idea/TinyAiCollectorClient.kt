package com.tinyai.observability.idea

import com.intellij.openapi.diagnostic.Logger
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

class TinyAiCollectorClient(private val settings: TinyAiSettings) {
    private val log = Logger.getInstance(TinyAiCollectorClient::class.java)
    private val json = Json {
        encodeDefaults = true
        ignoreUnknownKeys = true
    }
    @Volatile
    private var lastErrorMessage: String? = null
    private val httpClient = HttpClient.newBuilder()
        .version(HttpClient.Version.HTTP_1_1)
        .connectTimeout(Duration.ofSeconds(5))
        .build()

    fun send(events: List<TinyAiEvent>): TinyAiBatchUploadResult {
        if (events.isEmpty()) return TinyAiBatchUploadResult()
        lastErrorMessage = null

        val identity = settings.identity()
        val batch = TinyAiEventBatch(
            clientId = copilotClientId(identity),
            pluginName = TINYAI_JETBRAINS_PLUGIN_NAME,
            pluginVersion = TINYAI_JETBRAINS_PLUGIN_VERSION,
            username = identity.username,
            userId = identity.userId,
            userDisplayName = identity.userDisplayName,
            team = identity.team,
            machineId = identity.machineId,
            hostHash = identity.hostHash,
            events = events
        )

        return runCatching {
            val state = settings.state
            val collectorUrl = settings.normalizedCollectorUrl()
            assertCollectorUploadAllowed(collectorUrl, state.token)
            val requestBuilder = HttpRequest.newBuilder()
                .uri(URI.create("$collectorUrl/api/v1/events/batch"))
                .version(HttpClient.Version.HTTP_1_1)
                .timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json.encodeToString(batch)))

            cleanIdentity(state.token)?.let { token ->
                requestBuilder.header("Authorization", "Bearer $token")
            }

            val response = httpClient.send(requestBuilder.build(), HttpResponse.BodyHandlers.ofString())
            if (response.statusCode() in 200..299) {
                parseUploadResult(response.body())
            } else {
                lastErrorMessage = "HTTP ${response.statusCode()}: ${response.body()}"
                log.warn("TinyAI collector returned $lastErrorMessage")
                failedUploadResult(events, queued = false)
            }
        }.getOrElse { error ->
            lastErrorMessage = error.message ?: error.javaClass.simpleName
            log.warn("Failed to send TinyAI events", error)
            failedUploadResult(events, queued = true)
        }
    }

    fun lastError(): String? = lastErrorMessage

    fun sendHeartbeat(projectName: String?): Boolean {
        val identity = settings.identity()
        val occurredAt = nowIso()
        val event = TinyAiEvent(
            eventId = randomEventId(),
            taskId = "idea-copilot-heartbeat",
            eventType = "plugin_heartbeat",
            occurredAt = occurredAt,
            sourceConfidence = "direct",
            username = identity.username,
            userId = identity.userId,
            userDisplayName = identity.userDisplayName,
            team = identity.team,
            machineId = identity.machineId,
            hostHash = identity.hostHash,
            payload = heartbeatPayload(settings.state, projectName)
        )

        val result = send(listOf(event))
        return result.accepted + result.duplicates > 0 && result.failed == 0
    }

    private fun parseUploadResult(body: String): TinyAiBatchUploadResult =
        json.decodeFromString(TinyAiBatchUploadResult.serializer(), body)

    private fun failedUploadResult(events: List<TinyAiEvent>, queued: Boolean): TinyAiBatchUploadResult =
        TinyAiBatchUploadResult(
            failed = events.size,
            taskCount = events.map { it.taskId }.distinct().size,
            queued = queued
        )

    companion object {
        fun parseUploadResultForTest(body: String): TinyAiBatchUploadResult {
            val json = Json {
                encodeDefaults = true
                ignoreUnknownKeys = true
            }
            return json.decodeFromString(TinyAiBatchUploadResult.serializer(), body)
        }

        fun heartbeatPayloadForTest(state: TinyAiSettings.StateData, projectName: String?): Map<String, JsonElement> =
            heartbeatPayload(state, projectName)

        private fun heartbeatPayload(state: TinyAiSettings.StateData, projectName: String?): Map<String, JsonElement> {
            val diagnostics = state.lastScanDiagnostics
            return buildJsonObject {
                put("schema_version", JsonPrimitive(1))
                put("source", JsonPrimitive("idea-plugin"))
                put("activation", JsonPrimitive("heartbeat"))
                put("project_name", JsonPrimitive(projectName ?: ""))
                put("auto_capture_copilot_logs", JsonPrimitive(state.autoCaptureCopilotLogs))
                put("capture_history_on_first_scan", JsonPrimitive(state.captureHistoryOnFirstScan))
                put("extra_root_count", JsonPrimitive(configuredExtraRootCount(state.extraLogRoots)))
                put("scan_interval_seconds", JsonPrimitive(state.scanIntervalSeconds))
                put("diagnostics", buildJsonObject {
                    put("scanned_at", JsonPrimitive(diagnostics.scannedAt))
                    put("files_scanned", JsonPrimitive(diagnostics.filesScanned))
                    put("turns_parsed", JsonPrimitive(diagnostics.turnsParsed))
                    put("turns_uploaded", JsonPrimitive(diagnostics.turnsUploaded))
                    put("parse_error_count", JsonPrimitive(diagnostics.parseErrorCount))
                    put("upload_error_count", JsonPrimitive(diagnostics.uploadErrorCount))
                    diagnostics.lastErrorCategory?.let { put("last_error_category", JsonPrimitive(it)) }
                })
            }
        }

        private fun configuredExtraRootCount(value: String): Int =
            value.lineSequence().map { it.trim() }.count { it.isNotEmpty() }
    }
}
