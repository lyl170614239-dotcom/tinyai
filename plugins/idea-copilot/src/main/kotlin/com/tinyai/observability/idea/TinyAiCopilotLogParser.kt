package com.tinyai.observability.idea

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.time.Instant

internal object TinyAiCopilotLogParser {
    private val json = Json { ignoreUnknownKeys = true }

    fun parseText(
        file: File,
        text: String,
        baseOffset: Long,
        sourceMtimeMs: Long,
        sourceSizeBytes: Long
    ): List<ParsedCopilotTurn> {
        val sessionId = "idea-copilot-${sha256Short(file.absolutePath)}"
        val turns = mutableListOf<ParsedCopilotTurn>()
        var pendingUser: LogMessage? = null
        var offset = baseOffset

        text.lineSequence().forEach { line ->
            val message = parseLogLine(line, offset)
            when (message?.role) {
                Role.USER -> pendingUser = message
                Role.ASSISTANT -> {
                    val user = pendingUser
                    if (user != null && message.text.isNotBlank()) {
                        val stableSeed = "${file.absolutePath}:${user.offset}:${message.offset}:${user.text}:${message.text}"
                        turns += ParsedCopilotTurn(
                            sessionId = sessionId,
                            requestId = sha256Short("request:$stableSeed"),
                            responseId = sha256Short("response:$stableSeed"),
                            turnIndex = stableTurnIndex(user.offset),
                            attempt = 1,
                            userText = user.text,
                            assistantText = message.text,
                            startedAt = user.timestamp ?: Instant.ofEpochMilli(sourceMtimeMs).toString(),
                            completedAt = message.timestamp ?: user.timestamp ?: Instant.ofEpochMilli(sourceMtimeMs).toString(),
                            model = null,
                            sourceKind = "jetbrains_copilot_log_heuristic",
                            sourceFile = file.absolutePath,
                            sourceOffset = user.offset,
                            sourceMtimeMs = sourceMtimeMs,
                            sourceSizeBytes = sourceSizeBytes,
                            parserVersion = "jetbrains-copilot-log-heuristic-v1"
                        )
                        pendingUser = null
                    }
                }
                null -> Unit
            }

            offset += line.toByteArray(Charsets.UTF_8).size + 1
        }

        return turns
    }

    private fun stableTurnIndex(offset: Long): Int =
        ((offset / 64L) + 1L).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()

    private fun parseLogLine(line: String, offset: Long): LogMessage? {
        val trimmed = line.trim()
        if (trimmed.isEmpty()) return null
        parseJsonLogLine(trimmed, offset)?.let { return it }
        return parsePlainLogLine(trimmed, offset)
    }

    private fun parseJsonLogLine(line: String, offset: Long): LogMessage? {
        val element = runCatching { json.parseToJsonElement(line) }.getOrNull() ?: return null
        val obj = runCatching { element.jsonObject }.getOrNull() ?: return null
        val roleText = firstString(obj, ROLE_KEYS) ?: firstString(obj, TYPE_KEYS) ?: line
        val role = classifyRole(roleText) ?: return null
        val text = firstString(obj, TEXT_KEYS) ?: return null
        val timestamp = firstString(obj, TIMESTAMP_KEYS)
        return LogMessage(role = role, text = text, timestamp = timestamp, offset = offset)
    }

    private fun parsePlainLogLine(line: String, offset: Long): LogMessage? {
        USER_LINE_REGEX.find(line)?.let {
            return LogMessage(role = Role.USER, text = it.groupValues[2].trim(), timestamp = null, offset = offset)
        }
        ASSISTANT_LINE_REGEX.find(line)?.let {
            return LogMessage(role = Role.ASSISTANT, text = it.groupValues[2].trim(), timestamp = null, offset = offset)
        }
        return null
    }

    private fun firstString(obj: JsonObject, keys: List<String>): String? {
        keys.forEach { key ->
            val value = obj[key] ?: return@forEach
            val text = runCatching { value.jsonPrimitive.contentOrNull }.getOrNull()
            if (!text.isNullOrBlank()) return text
        }
        return null
    }

    private fun classifyRole(value: String): Role? {
        val lower = value.lowercase()
        return when {
            lower.contains("user") || lower.contains("prompt") || lower.contains("request") -> Role.USER
            lower.contains("assistant") || lower.contains("copilot") || lower.contains("response") ||
                lower.contains("completion") || lower.contains("answer") -> Role.ASSISTANT
            else -> null
        }
    }

    private data class LogMessage(
        val role: Role,
        val text: String,
        val timestamp: String?,
        val offset: Long
    )

    private enum class Role {
        USER,
        ASSISTANT
    }

    private val ROLE_KEYS = listOf("role", "author", "speaker", "from")
    private val TYPE_KEYS = listOf("type", "event", "kind", "name")
    private val TEXT_KEYS = listOf("text", "message", "content", "prompt", "answer", "response", "completion")
    private val TIMESTAMP_KEYS = listOf("timestamp", "time", "created_at", "createdAt", "occurred_at")
    private val USER_LINE_REGEX = Regex("""(?i)\b(user|prompt|request)\b\s*[:=]\s*(.+)$""")
    private val ASSISTANT_LINE_REGEX = Regex("""(?i)\b(assistant|copilot|response|answer|completion)\b\s*[:=]\s*(.+)$""")
}
