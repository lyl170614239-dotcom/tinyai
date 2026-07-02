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
}
