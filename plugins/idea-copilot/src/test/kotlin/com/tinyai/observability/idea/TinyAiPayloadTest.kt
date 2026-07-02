package com.tinyai.observability.idea

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class TinyAiPayloadTest {
    @Test
    fun `sha256Short remains stable`() {
        assertEquals(
            "2cf24dba5fb0a30e26e83b2ac5b9e29e",
            sha256Short("hello")
        )
    }

    @Test
    fun `stable copilot turn event id uses client session request and response`() {
        assertEquals(
            sha256Short("copilot:turn:client-1:session-1:request-1:response-1"),
            copilotTurnEventId("client-1", "session-1", "request-1", "response-1")
        )
    }

    @Test
    fun `public http collector requires token`() {
        assertEquals(true, isCollectorUploadAllowedForUrl("http://127.0.0.1:18080", ""))
        assertEquals(true, isCollectorUploadAllowedForUrl("http://10.1.2.3:18080", ""))
        assertEquals(false, isCollectorUploadAllowedForUrl("http://10.foo.2.3.4", ""))
        assertEquals(false, isCollectorUploadAllowedForUrl("http://10.1.2.999", ""))
        assertEquals(false, isCollectorUploadAllowedForUrl("http://example.com", ""))
        assertEquals(true, isCollectorUploadAllowedForUrl("https://example.com", "token"))
    }

    @Test
    fun `turn signature changes when assistant text changes`() {
        val first = parsedTurn(assistant = "first answer")
        val second = parsedTurn(assistant = "second answer")
        assertEquals(false, first.signature() == second.signature())
    }

    @Test
    fun `acknowledged state with same signature is skipped`() {
        val state = TinyAiTurnCaptureState(
            eventId = "event-1",
            signature = "sig-1",
            status = "acknowledged",
            firstSeenAt = "2026-07-02T00:00:00Z",
            lastAttemptAt = "2026-07-02T00:00:00Z",
            acknowledgedAt = "2026-07-02T00:00:01Z",
            errorCount = 0,
            lastError = null
        )
        assertEquals(true, state.isAcknowledged("sig-1"))
        assertEquals(false, state.isAcknowledged("sig-2"))
    }

    private fun parsedTurn(assistant: String = "answer") = ParsedCopilotTurn(
        sessionId = "session-1",
        requestId = "request-1",
        responseId = "response-1",
        turnIndex = 1,
        attempt = 1,
        userText = "question",
        assistantText = assistant,
        startedAt = "2026-07-02T01:00:00Z",
        completedAt = "2026-07-02T01:00:02Z",
        model = null,
        sourceKind = "jetbrains_copilot_log_heuristic",
        sourceFile = "/tmp/copilot.log",
        sourceOffset = 12,
        sourceMtimeMs = 1000,
        sourceSizeBytes = 2000,
        parserVersion = "jetbrains-copilot-log-heuristic-v1"
    )
}
