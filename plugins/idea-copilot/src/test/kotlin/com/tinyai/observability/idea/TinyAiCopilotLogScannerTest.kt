package com.tinyai.observability.idea

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class TinyAiCopilotLogScannerTest {
    @Test
    fun `plain user and assistant lines become a turn snapshot`() {
        val file = File("/tmp/github-copilot.log")
        val turns = TinyAiCopilotLogParser.parseText(
            file = file,
            text = """
                user: explain this method
                assistant: it validates collector settings
            """.trimIndent(),
            baseOffset = 128,
            sourceMtimeMs = 1_788_182_400_000,
            sourceSizeBytes = 512
        )

        assertEquals(1, turns.size)
        val turn = turns.single()
        assertEquals("explain this method", turn.userText)
        assertEquals("it validates collector settings", turn.assistantText)
        assertEquals("jetbrains_copilot_log_heuristic", turn.sourceKind)
        assertEquals("jetbrains-copilot-log-heuristic-v1", turn.parserVersion)
        assertEquals(128, turn.sourceOffset)
        assertEquals(512, turn.sourceSizeBytes)
    }

    @Test
    fun `json role lines preserve timestamps and source metadata`() {
        val file = File("/tmp/copilot-chat.jsonl")
        val turns = TinyAiCopilotLogParser.parseText(
            file = file,
            text = """
                {"role":"user","text":"add tests","timestamp":"2026-07-02T01:00:00Z"}
                {"role":"assistant","text":"tests added","timestamp":"2026-07-02T01:00:03Z"}
            """.trimIndent(),
            baseOffset = 0,
            sourceMtimeMs = 1_788_182_400_000,
            sourceSizeBytes = 1024
        )

        assertEquals(1, turns.size)
        val turn = turns.single()
        assertEquals("2026-07-02T01:00:00Z", turn.startedAt)
        assertEquals("2026-07-02T01:00:03Z", turn.completedAt)
        assertEquals("add tests", turn.userText)
        assertEquals("tests added", turn.assistantText)
        assertTrue(turn.requestId.isNotBlank())
        assertTrue(turn.responseId.isNotBlank())
    }
}
