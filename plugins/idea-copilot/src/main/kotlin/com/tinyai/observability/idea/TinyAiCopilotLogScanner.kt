package com.tinyai.observability.idea

import com.intellij.openapi.diagnostic.Logger
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.h2.mvstore.MVStore
import java.io.File
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.time.Instant
import kotlin.math.max

class TinyAiCopilotLogScanner(private val settings: TinyAiSettings) {
    private val log = Logger.getInstance(TinyAiCopilotLogScanner::class.java)
    private val json = Json { ignoreUnknownKeys = true }

    fun collectScanResult(): TinyAiScanResult {
        val files = candidateFiles()
        val turns = mutableListOf<ParsedCopilotTurn>()
        files.forEach { file ->
            turns += if (isNitriteAgentSessionFile(file.name)) {
                readNitriteAgentTurns(file)
            } else {
                readIncrementalTurns(file)
            }
        }
        return TinyAiScanResult(
            turns = turns,
            filesScanned = files.size,
            parseErrorCount = 0
        )
    }

    fun collectTurns(): List<ParsedCopilotTurn> = collectScanResult().turns

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
        roots += File(home, ".config/github-copilot")

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
        if (isNitriteAgentSessionFile(lower)) return true
        val hasKnownExtension = LOG_EXTENSIONS.any { lower.endsWith(it) }
        val hasCopilotSignal = LOG_NAME_SIGNALS.any { lower.contains(it) }
        return hasKnownExtension && hasCopilotSignal
    }

    private fun isNitriteAgentSessionFile(name: String): Boolean {
        return name.lowercase() == "copilot-agent-sessions-nitrite.db"
    }

    private fun readNitriteAgentTurns(file: File): List<ParsedCopilotTurn> {
        val state = settings.state
        val key = "${file.absolutePath}#nitrite-agent-turns"
        val previousCursor = state.cursors[key]
        val minCreatedAt = when {
            previousCursor == null && state.captureHistoryOnFirstScan -> 0L
            previousCursor == null -> Long.MAX_VALUE
            else -> previousCursor
        }
        var maxCreatedAt = previousCursor ?: 0L

        val tempFile = runCatching {
            Files.createTempFile("tinyai-copilot-agent-", ".mv.db").toFile().also { temp ->
                Files.copy(file.toPath(), temp.toPath(), StandardCopyOption.REPLACE_EXISTING)
            }
        }.getOrElse { error ->
            log.warn("Failed to snapshot Copilot Nitrite db ${file.absolutePath}", error)
            return emptyList()
        }

        return try {
            val parsed = mutableListOf<ParsedCopilotTurn>()
            MVStore.Builder().fileName(tempFile.absolutePath).readOnly().open().use { store ->
                if (!store.getMapNames().contains(NITRITE_AGENT_TURN_MAP)) return@use
                val turns = store.openMap<Any, Any>(NITRITE_AGENT_TURN_MAP)
                val docs = turns.values
                    .mapNotNull { it as? Map<*, *> }
                    .sortedBy { longField(it, "createdAt") ?: 0L }

                docs.forEachIndexed { index, doc ->
                    val createdAt = longField(doc, "createdAt") ?: return@forEachIndexed
                    maxCreatedAt = max(maxCreatedAt, createdAt)
                    if (createdAt <= minCreatedAt) return@forEachIndexed

                    parseNitriteTurn(file, doc, index + 1)?.let { parsed += it }
                }
            }

            state.cursors[key] = maxCreatedAt
            parsed
        } catch (error: Throwable) {
            log.warn("Failed to parse Copilot Nitrite db ${file.absolutePath}", error)
            emptyList()
        } finally {
            runCatching { tempFile.delete() }
        }
    }

    private fun parseNitriteTurn(file: File, doc: Map<*, *>, turnIndex: Int): ParsedCopilotTurn? {
        val turnId = stringField(doc, "id") ?: return null
        val sessionId = stringField(doc, "sessionId") ?: "idea-copilot-${sha256Short(file.parentFile?.name ?: file.absolutePath)}"
        val createdAt = longField(doc, "createdAt") ?: file.lastModified()
        val request = doc["request"] as? Map<*, *> ?: return null
        val response = doc["response"] as? Map<*, *> ?: return null
        if (stringField(request, "status")?.lowercase() !in setOf(null, "ok")) return null

        val userText = messageText(request)
        val assistantText = messageText(response)
        if (userText.isBlank() || assistantText.isBlank()) return null

        return ParsedCopilotTurn(
            sessionId = sessionId,
            requestId = turnId,
            responseId = sha256Short("response:$turnId:${createdAt}:${assistantText.take(128)}"),
            turnIndex = turnIndex,
            attempt = 1,
            userText = userText,
            assistantText = assistantText,
            startedAt = Instant.ofEpochMilli(createdAt).toString(),
            completedAt = Instant.ofEpochMilli(createdAt).toString(),
            model = null,
            sourceKind = "jetbrains_copilot_nitrite",
            sourceFile = file.absolutePath,
            sourceOffset = createdAt,
            sourceMtimeMs = file.lastModified(),
            sourceSizeBytes = file.length(),
            parserVersion = "jetbrains-copilot-nitrite-v1"
        )
    }

    private fun messageText(message: Map<*, *>): String {
        stringField(message, "stringContent")?.takeIf { it.isNotBlank() }?.let { return it }
        val contents = message["contents"] ?: return ""
        return markdownTexts(contents).joinToString("\n\n").trim()
    }

    private fun markdownTexts(value: Any?): List<String> {
        val root = when (value) {
            is JsonElement -> value
            is String -> parseJsonOrNull(value) ?: return emptyList()
            is Map<*, *> -> parseJsonOrNull(value.toString()) ?: return emptyList()
            else -> return emptyList()
        }
        val texts = mutableListOf<String>()
        collectMarkdownTexts(root, texts)
        return texts.distinct().filter { it.isNotBlank() }
    }

    private fun collectMarkdownTexts(element: JsonElement, texts: MutableList<String>) {
        when (element) {
            is JsonObject -> {
                val type = element["type"]?.jsonPrimitive?.contentOrNull
                if (type == "Markdown") {
                    val data = element["data"]?.jsonPrimitive?.contentOrNull
                    val dataObject = data?.let { parseJsonOrNull(it) } as? JsonObject
                    val text = dataObject?.get("text")?.jsonPrimitive?.contentOrNull
                    if (!text.isNullOrBlank()) texts += text
                    return
                }

                element["value"]?.jsonPrimitive?.contentOrNull
                    ?.let { parseJsonOrNull(it) }
                    ?.let { collectMarkdownTexts(it, texts) }
                element["data"]?.jsonPrimitive?.contentOrNull
                    ?.let { parseJsonOrNull(it) }
                    ?.let { collectMarkdownTexts(it, texts) }
                element.values.forEach { collectMarkdownTexts(it, texts) }
            }
            is JsonArray -> element.forEach { collectMarkdownTexts(it, texts) }
            else -> Unit
        }
    }

    private fun parseJsonOrNull(value: String): JsonElement? {
        return runCatching { json.parseToJsonElement(value) }.getOrNull()
    }

    private fun stringField(map: Map<*, *>, key: String): String? {
        return map[key]?.toString()?.takeIf { it.isNotBlank() && it != "null" }
    }

    private fun longField(map: Map<*, *>, key: String): Long? {
        return when (val value = map[key]) {
            is Number -> value.toLong()
            is String -> value.toLongOrNull()
            else -> null
        }
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
        return TinyAiCopilotLogParser.parseText(
            file = file,
            text = text,
            baseOffset = baseOffset,
            sourceMtimeMs = file.lastModified(),
            sourceSizeBytes = file.length()
        )
    }

    companion object {
        private const val MAX_FILES_PER_SCAN = 500L
        private const val MAX_BYTES_PER_FILE = 5L * 1024L * 1024L
        private const val NITRITE_AGENT_TURN_MAP = "com.github.copilot.agent.session.persistence.nitrite.entity.NtAgentTurn"
        private val LOG_EXTENSIONS = listOf(".jsonl", ".json", ".log", ".txt")
        private val LOG_NAME_SIGNALS = listOf("copilot", "github-copilot", "chat", "llm", "ai-assistant")
    }
}
