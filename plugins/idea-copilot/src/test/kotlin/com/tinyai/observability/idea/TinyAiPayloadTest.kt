package com.tinyai.observability.idea

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Test
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

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

    @Test
    fun `turn snapshot payload carries canonical message and source fields`() {
        val turn = parsedTurn()
        val payload = TinyAiCopilotCollectorService.turnPayloadForTest(turn)

        assertEquals("copilot.turn_snapshot.v1", payload["schema_version"]?.jsonPrimitive?.content)
        assertEquals("session-1", payload["session_id"]?.jsonPrimitive?.content)
        assertEquals("request-1", payload["request_id"]?.jsonPrimitive?.content)
        assertEquals("response-1", payload["response_id"]?.jsonPrimitive?.content)
        assertEquals(true, payload["include_text"]?.jsonPrimitive?.boolean)
        assertEquals("permanent", payload["retention_policy"]?.jsonPrimitive?.content)

        val turnObject = payload["turn"]!!.jsonObject
        assertEquals(1, turnObject["turn_index"]?.jsonPrimitive?.int)
        assertEquals("completed", turnObject["status"]?.jsonPrimitive?.content)

        val messages = payload["messages"]!!.jsonArray
        assertEquals("user", messages[0].jsonObject["role"]?.jsonPrimitive?.content)
        assertEquals("question", messages[0].jsonObject["text"]?.jsonPrimitive?.content)
        assertEquals(textHash("question"), messages[0].jsonObject["text_hash"]?.jsonPrimitive?.content)
        assertEquals("assistant", messages[1].jsonObject["role"]?.jsonPrimitive?.content)
        assertEquals("answer", messages[1].jsonObject["text"]?.jsonPrimitive?.content)

        val source = payload["source_files"]!!.jsonObject["jetbrains_copilot"]!!.jsonObject
        assertEquals("/tmp/copilot.log", source["path"]?.jsonPrimitive?.content)
        assertEquals("jetbrains-copilot-log-heuristic-v1", source["parser_version"]?.jsonPrimitive?.content)
    }

    @Test
    fun `heartbeat payload reports diagnostics without raw extra roots`() {
        val state = TinyAiSettings.StateData(
            extraLogRoots = "/private/a\n/private/b\n",
            scanIntervalSeconds = 45,
            lastScanDiagnostics = TinyAiScanDiagnostics(
                scannedAt = "2026-07-02T01:00:00Z",
                filesScanned = 3,
                turnsParsed = 2,
                turnsUploaded = 1,
                parseErrorCount = 0,
                uploadErrorCount = 1,
                lastErrorCategory = "http"
            )
        )
        val payload = TinyAiCollectorClient.heartbeatPayloadForTest(state, "Project")

        assertEquals("Project", payload["project_name"]?.jsonPrimitive?.content)
        assertEquals(2, payload["extra_root_count"]?.jsonPrimitive?.int)
        assertEquals(45, payload["scan_interval_seconds"]?.jsonPrimitive?.int)
        assertNull(payload["configured_extra_roots"])
        val diagnostics = payload["diagnostics"]!!.jsonObject
        assertEquals(3, diagnostics["files_scanned"]?.jsonPrimitive?.int)
        assertEquals("http", diagnostics["last_error_category"]?.jsonPrimitive?.content)
    }

    @Test
    fun `batch upload result parser keeps per event statuses`() {
        val result = TinyAiCollectorClient.parseUploadResultForTest(
            """
            {
              "accepted": 1,
              "duplicates": 1,
              "failed": 1,
              "task_count": 2,
              "queued": false,
              "events": [
                {"event_id":"a","event_type":"turn_snapshot","status":"accepted"},
                {"event_id":"b","event_type":"turn_snapshot","status":"duplicate"},
                {"event_id":"c","event_type":"turn_snapshot","status":"failed","reason":"bad payload"}
              ]
            }
            """.trimIndent()
        )

        assertEquals(1, result.accepted)
        assertEquals(1, result.duplicates)
        assertEquals(1, result.failed)
        assertEquals(2, result.taskCount)
        assertEquals(3, result.events.size)
        assertNotNull(result.events.single { it.eventId == "c" }.reason)
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
