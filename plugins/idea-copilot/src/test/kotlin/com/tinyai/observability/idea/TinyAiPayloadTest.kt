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
        assertEquals(false, isCollectorUploadAllowedForUrl("http://example.com", ""))
        assertEquals(true, isCollectorUploadAllowedForUrl("https://example.com", "token"))
    }
}
