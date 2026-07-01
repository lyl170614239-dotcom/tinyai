package com.tinyai.observability.idea

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

const val TINYAI_JETBRAINS_PLUGIN_VERSION = "0.1.3"
const val TINYAI_JETBRAINS_PLUGIN_NAME = "tinyai-observability-jetbrains-copilot"
const val DEFAULT_COLLECTOR_URL = "http://10.161.248.133:18080"

@Serializable
data class TinyAiEventBatch(
    @SerialName("client_id") val clientId: String,
    @SerialName("plugin_name") val pluginName: String,
    @SerialName("plugin_version") val pluginVersion: String,
    val username: String,
    @SerialName("user_id") val userId: String,
    @SerialName("user_email") val userEmail: String? = null,
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
    @SerialName("user_email") val userEmail: String? = null,
    @SerialName("user_display_name") val userDisplayName: String? = null,
    val team: String? = null,
    @SerialName("machine_id") val machineId: String? = null,
    @SerialName("host_hash") val hostHash: String? = null,
    val payload: Map<String, JsonElement>
)

data class TinyAiIdentity(
    val username: String,
    val userId: String,
    val userEmail: String?,
    val userDisplayName: String?,
    val team: String?,
    val machineId: String,
    val hostHash: String
)

data class ParsedCopilotTurn(
    val sessionId: String,
    val requestId: String,
    val responseId: String,
    val turnIndex: Int,
    val userText: String,
    val assistantText: String,
    val occurredAt: String,
    val sourceFile: String,
    val sourceOffset: Long
)
