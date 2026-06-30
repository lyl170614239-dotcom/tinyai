package com.tinyai.observability.idea

import com.intellij.openapi.diagnostic.Logger
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.io.File
import java.io.RandomAccessFile
import java.nio.file.Files
import java.time.Instant
import kotlin.math.max

class TinyAiCopilotLogScanner(private val settings: TinyAiSettings) {
    private val log = Logger.getInstance(TinyAiCopilotLogScanner::class.java)
    private val json = Json { ignoreUnknownKeys = true }

    fun collectTurns(): List<ParsedCopilotTurn> {
        val turns = mutableListOf<ParsedCopilotTurn>()
        candidateFiles().forEach { file ->
            turns += readIncrementalTurns(file)
        }
        return turns
    }

    private fun candidateFiles(): List<File> {
        val roots = candidateRoots()
        val files = mutableListOf<File>()

        roots.forEach { root ->
            if (!root.isDirectory) return@forEach

            val stream = runCatching { Files.walk(root.toPath(), 8) }.getOrNull() ?: return@forEach
            try {
                stream
                    .filter { Files.isRegularFile(it) }
                    .filter { isCandidateFile(it.fileName.toString()) }
                    .limit(MAX_FILES_PER_SCAN)
                    .forEach { files += it.toFile() }
            } finally {
                stream.close()
            }
        }

        return files.distinctBy { it.absolutePath }
            .sortedByDescending { it.lastModified() }
            .take(MAX_FILES_PER_SCAN.toInt())
    }

    private fun candidateRoots(): List<File> {
        val home = File(System.getProperty("user.home"))
        val roots = mutableListOf<File>()

        roots += File(home, "Library/Logs/JetBrains")
        roots += File(home, "Library/Application Support/JetBrains")
        roots += File(home, ".cache/JetBrains")
        roots += File(home, ".config/JetBrains")

        System.getenv("LOCALAPPDATA")?.let { roots += File(it, "JetBrains") }
        System.getenv("APPDATA")?.let { roots += File(it, "JetBrains") }

        settings.state.extraLogRoots
            .lineSequence()
            .map { it.trim() }
            .filter { it.isNotEmpty() }
            .mapTo(roots) { File(it) }

        return roots.distinctBy { it.absolutePath }
    }

    private fun isCandidateFile(name: String): Boolean {
        val lower = name.lowercase()
        val hasKnownExtension = LOG_EXTENSIONS.any { lower.endsWith(it) }
        val hasCopilotSignal = LOG_NAME_SIGNALS.any { lower.contains(it) }
        return hasKnownExtension && hasCopilotSignal
    }

    private fun readIncrementalTurns(file: File): List<ParsedCopilotTurn> {
        val state = settings.state
        val key = file.absolutePath
        val length = file.length()
        val previousCursor = state.cursors[key]

        val firstOffset = when {
            previousCursor == null && state.captureHistoryOnFirstScan -> 0L
            previousCursor == null -> length
            previousCursor > length -> 0L
            else -> previousCursor
        }
        val effectiveOffset = max(firstOffset, length - MAX_BYTES_PER_FILE)

        if (effectiveOffset >= length) {
            state.cursors[key] = length
            return emptyList()
        }

        val text = runCatching {
            RandomAccessFile(file, "r").use { raf ->
                raf.seek(effectiveOffset)
                val bytes = ByteArray((length - effectiveOffset).toInt())
                raf.readFully(bytes)
                String(bytes, Charsets.UTF_8)
            }
        }.getOrElse { error ->
            log.warn("Failed to read Copilot log file ${file.absolutePath}", error)
            state.cursors[key] = length
            return emptyList()
        }

        state.cursors[key] = length
        return parseTurns(file, text, effectiveOffset)
    }

    private fun parseTurns(
        file: File,
        text: String,
        baseOffset: Long
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
                            userText = user.text,
                            assistantText = message.text,
                            occurredAt = message.timestamp ?: user.timestamp ?: Instant.ofEpochMilli(file.lastModified()).toString(),
                            sourceFile = file.absolutePath,
                            sourceOffset = user.offset
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

    private fun stableTurnIndex(offset: Long): Int {
        return ((offset / 64L) + 1L).coerceAtMost(Int.MAX_VALUE.toLong()).toInt()
    }

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

    companion object {
        private const val MAX_FILES_PER_SCAN = 500L
        private const val MAX_BYTES_PER_FILE = 5L * 1024L * 1024L
        private val LOG_EXTENSIONS = listOf(".jsonl", ".json", ".log", ".txt")
        private val LOG_NAME_SIGNALS = listOf("copilot", "github-copilot", "chat", "llm", "ai-assistant")
        private val ROLE_KEYS = listOf("role", "author", "speaker", "from")
        private val TYPE_KEYS = listOf("type", "event", "kind", "name")
        private val TEXT_KEYS = listOf("text", "message", "content", "prompt", "answer", "response", "completion")
        private val TIMESTAMP_KEYS = listOf("timestamp", "time", "created_at", "createdAt", "occurred_at")
        private val USER_LINE_REGEX = Regex("""(?i)\b(user|prompt|request)\b\s*[:=]\s*(.+)$""")
        private val ASSISTANT_LINE_REGEX = Regex("""(?i)\b(assistant|copilot|response|answer|completion)\b\s*[:=]\s*(.+)$""")
    }
}
