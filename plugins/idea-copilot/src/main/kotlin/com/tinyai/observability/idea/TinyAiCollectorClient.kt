package com.tinyai.observability.idea

import com.intellij.openapi.diagnostic.Logger
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration

class TinyAiCollectorClient(private val settings: TinyAiSettings) {
    private val log = Logger.getInstance(TinyAiCollectorClient::class.java)
    private val json = Json { encodeDefaults = false }
    private val httpClient = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        .build()

    fun send(events: List<TinyAiEvent>): Boolean {
        if (events.isEmpty()) return true

        val identity = settings.identity()
        val batch = TinyAiEventBatch(
            clientId = sha256Short("idea-copilot:${identity.userId}:${identity.machineId}"),
            pluginName = TINYAI_JETBRAINS_PLUGIN_NAME,
            pluginVersion = TINYAI_JETBRAINS_PLUGIN_VERSION,
            username = identity.username,
            userId = identity.userId,
            userEmail = identity.userEmail,
            userDisplayName = identity.userDisplayName,
            team = identity.team,
            machineId = identity.machineId,
            hostHash = identity.hostHash,
            events = events
        )

        return runCatching {
            val state = settings.state
            val requestBuilder = HttpRequest.newBuilder()
                .uri(URI.create("${settings.normalizedCollectorUrl()}/api/v1/events/batch"))
                .timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json.encodeToString(batch)))

            cleanIdentity(state.token)?.let { token ->
                requestBuilder.header("Authorization", "Bearer $token")
            }

            val response = httpClient.send(requestBuilder.build(), HttpResponse.BodyHandlers.ofString())
            if (response.statusCode() in 200..299) {
                true
            } else {
                log.warn("TinyAI collector returned HTTP ${response.statusCode()}: ${response.body()}")
                false
            }
        }.getOrElse { error ->
            log.warn("Failed to send TinyAI events", error)
            false
        }
    }

    fun sendHeartbeat(projectName: String?): Boolean {
        val identity = settings.identity()
        val state = settings.state
        val occurredAt = nowIso()
        val event = TinyAiEvent(
            eventId = randomEventId(),
            taskId = "idea-copilot-heartbeat",
            eventType = "plugin_heartbeat",
            occurredAt = occurredAt,
            sourceConfidence = "direct",
            username = identity.username,
            userId = identity.userId,
            userEmail = identity.userEmail,
            userDisplayName = identity.userDisplayName,
            team = identity.team,
            machineId = identity.machineId,
            hostHash = identity.hostHash,
            payload = mapOf(
                "schema_version" to JsonPrimitive(1),
                "source" to JsonPrimitive("idea-plugin"),
                "activation" to JsonPrimitive("heartbeat"),
                "project_name" to JsonPrimitive(projectName ?: ""),
                "auto_capture_copilot_logs" to JsonPrimitive(state.autoCaptureCopilotLogs),
                "capture_history_on_first_scan" to JsonPrimitive(state.captureHistoryOnFirstScan),
                "configured_extra_roots" to JsonPrimitive(state.extraLogRoots)
            )
        )

        return send(listOf(event))
    }
}
