package com.tinyai.observability.idea

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

const val TINYAI_JETBRAINS_PLUGIN_VERSION = "0.1.4"
const val TINYAI_JETBRAINS_PLUGIN_NAME = "tinyai-observability-jetbrains-copilot"
const val DEFAULT_COLLECTOR_URL = "http://10.161.248.133:18080"

@Serializable
data class TinyAiEventBatch(
    @SerialName("client_id") val clientId: String,
    @SerialName("plugin_name") val pluginName: String,
    @SerialName("plugin_version") val pluginVersion: String,
    val username: String,
    @SerialName("user_id") val userId: String,
    @SerialName("user_display_name") val userDisplayName: String? = null,
    val team: String? = null,
    @SerialName("machine_id") val machineId: String? = null,
    @SerialName("host_hash") val hostHash: String? = null,
    val events: List<TinyAiEvent>
)

@Serializable
data class TinyAiEvent(
    @SerialName("event_id") val eventId: String,
    @SerialName("task_id") val taskId: String,
    @SerialName("session_id") val sessionId: String? = null,
    val tool: String = "copilot",
    @SerialName("event_type") val eventType: String,
    @SerialName("occurred_at") val occurredAt: String,
    @SerialName("source_confidence") val sourceConfidence: String = "derived",
    val username: String,
    @SerialName("user_id") val userId: String,
    @SerialName("user_display_name") val userDisplayName: String? = null,
    val team: String? = null,
    @SerialName("machine_id") val machineId: String? = null,
    @SerialName("host_hash") val hostHash: String? = null,
    val payload: Map<String, JsonElement>
)

data class TinyAiIdentity(
    val username: String,
    val userId: String,
    val userDisplayName: String?,
    val team: String?,
    val machineId: String,
    val hostHash: String
)

@Serializable
data class TinyAiBatchUploadResult(
    val accepted: Int = 0,
    val duplicates: Int = 0,
    val failed: Int = 0,
    @SerialName("task_count") val taskCount: Int = 0,
    val events: List<TinyAiBatchEventResult> = emptyList(),
    val queued: Boolean = false
)

@Serializable
data class TinyAiBatchEventResult(
    @SerialName("event_id") val eventId: String,
    @SerialName("event_type") val eventType: String,
    val status: String,
    val reason: String? = null
)

data class TinyAiScanResult(
    val turns: List<ParsedCopilotTurn>,
    val filesScanned: Int,
    val parseErrorCount: Int
)

data class ParsedCopilotTurn(
    val sessionId: String,
    val requestId: String,
    val responseId: String,
    val turnIndex: Int,
    val attempt: Int = 1,
    val userText: String,
    val assistantText: String,
    val startedAt: String,
    val completedAt: String,
    val model: String? = null,
    val sourceKind: String,
    val sourceFile: String,
    val sourceOffset: Long,
    val sourceMtimeMs: Long,
    val sourceSizeBytes: Long,
    val parserVersion: String
) {
    constructor(
        sessionId: String,
        requestId: String,
        responseId: String,
        turnIndex: Int,
        userText: String,
        assistantText: String,
        occurredAt: String,
        sourceFile: String,
        sourceOffset: Long
    ) : this(
        sessionId = sessionId,
        requestId = requestId,
        responseId = responseId,
        turnIndex = turnIndex,
        attempt = 1,
        userText = userText,
        assistantText = assistantText,
        startedAt = occurredAt,
        completedAt = occurredAt,
        model = null,
        sourceKind = "jetbrains_copilot_log_heuristic",
        sourceFile = sourceFile,
        sourceOffset = sourceOffset,
        sourceMtimeMs = 0,
        sourceSizeBytes = 0,
        parserVersion = "jetbrains-copilot-log-heuristic-v1"
    )

    val occurredAt: String
        get() = completedAt

    fun signature(): String = sha256Short(
        listOf(
            requestId,
            responseId,
            textHash(userText),
            textHash(assistantText),
            sourceKind,
            sourceOffset.toString(),
            parserVersion,
            completedAt
        ).joinToString(":")
    )
}

data class TinyAiTurnCaptureState(
    var eventId: String = "",
    var signature: String = "",
    var status: String = "queued",
    var firstSeenAt: String = "",
    var lastAttemptAt: String = "",
    var acknowledgedAt: String? = null,
    var errorCount: Int = 0,
    var lastError: String? = null
) {
    fun isAcknowledged(candidateSignature: String): Boolean =
        status == "acknowledged" && signature == candidateSignature
}

data class TinyAiScanDiagnostics(
    var scannedAt: String = "",
    var filesScanned: Int = 0,
    var turnsParsed: Int = 0,
    var turnsUploaded: Int = 0,
    var parseErrorCount: Int = 0,
    var uploadErrorCount: Int = 0,
    var lastErrorCategory: String? = null
)
