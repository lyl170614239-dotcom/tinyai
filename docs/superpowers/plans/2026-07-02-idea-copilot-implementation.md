# IDEA Copilot Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete `plugins/idea-copilot` so IDEA uses JetBrains-local Copilot evidence but emits the same collector-facing Copilot turn semantics as the VS Code extension.

**Architecture:** Keep IDEA-specific discovery and parsing in `TinyAiCopilotLogScanner`, shared event semantics in `TinyAiCopilotCollectorService`, persistent dedupe state in `TinyAiSettings`, and collector transport in `TinyAiCollectorClient`. Add focused unit tests around these seams before expanding implementation.

**Tech Stack:** Kotlin 2.2.21, IntelliJ Platform Gradle Plugin 2.17.0, kotlinx.serialization-json, Java HttpClient, Python unittest for collector normalization.

---

## File Map

- Modify `plugins/idea-copilot/build.gradle.kts`
  Add JUnit 5 test dependencies and configure `useJUnitPlatform()`.
- Modify `plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiModels.kt`
  Add parsed turn metadata, source kind, upload result models, and persistent turn capture state.
- Modify `plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiUtil.kt`
  Add full SHA-256, text hash, JSON hash, private-network collector URL checks, and stable client/turn ID helpers.
- Modify `plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiCopilotLogScanner.kt`
  Fill richer parsed turn metadata and expose deterministic parser source kinds.
- Create `plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiCopilotLogParser.kt`
  Hold pure text parsing logic so unit tests do not need IntelliJ application services.
- Modify `plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiCopilotCollectorService.kt`
  Build `copilot.turn_snapshot.v1` payloads, skip acknowledged duplicate signatures, update turn state from upload results, and record scan diagnostics.
- Modify `plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiCollectorClient.kt`
  Validate collector security, parse batch responses, and return structured upload results.
- Modify `plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiSettings.kt`
  Persist turn capture state and scan diagnostics.
- Modify `plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiSettingsConfigurable.kt`
  Keep settings compatible and avoid exposing raw diagnostics in UI.
- Create `plugins/idea-copilot/src/test/kotlin/com/tinyai/observability/idea/TinyAiPayloadTest.kt`
  Test payload shape, stable IDs, signatures, and dedupe transitions.
- Create `plugins/idea-copilot/src/test/kotlin/com/tinyai/observability/idea/TinyAiCollectorClientTest.kt`
  Test collector response parsing and URL security.
- Create `plugins/idea-copilot/src/test/kotlin/com/tinyai/observability/idea/TinyAiCopilotLogScannerTest.kt`
  Test JSON/plain log pairing and source metadata.
- Modify `collector-server/tests/test_normalization.py`
  Add an IDEA-produced `copilot.turn_snapshot.v1` normalization sample.
- Modify `plugins/idea-copilot/README.md`
  Document aligned collector semantics, JetBrains-local source limitations, and diagnostics.

## Task 1: Enable IDEA Plugin Unit Tests

**Files:**
- Modify: `plugins/idea-copilot/build.gradle.kts`
- Create: `plugins/idea-copilot/src/test/kotlin/com/tinyai/observability/idea/TinyAiPayloadTest.kt`

- [ ] **Step 1: Write the first failing Kotlin test file**

Create `plugins/idea-copilot/src/test/kotlin/com/tinyai/observability/idea/TinyAiPayloadTest.kt`:

```kotlin
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
```

- [ ] **Step 2: Run the test task to verify it fails before test dependencies exist**

Run:

```bash
cd plugins/idea-copilot
./gradlew test --tests com.tinyai.observability.idea.TinyAiPayloadTest
```

Expected: FAIL during test compilation because JUnit Jupiter is not on the test classpath.

- [ ] **Step 3: Add JUnit 5 test dependencies and platform configuration**

Modify `plugins/idea-copilot/build.gradle.kts`:

```kotlin
dependencies {
    intellijPlatform {
        val localIdePath = providers.gradleProperty("localIdePath").orNull?.trim()
        if (!localIdePath.isNullOrEmpty()) {
            local(localIdePath)
        } else {
            create(
                providers.gradleProperty("platformType").get(),
                providers.gradleProperty("platformVersion").get()
            )
        }
    }

    implementation("com.h2database:h2:2.3.232")
    implementation("org.dizitart:nitrite:4.3.3")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.9.0")

    testImplementation(kotlin("test"))
    testImplementation("org.junit.jupiter:junit-jupiter-api:5.11.4")
    testRuntimeOnly("org.junit.jupiter:junit-jupiter-engine:5.11.4")
}

tasks {
    test {
        useJUnitPlatform()
    }

    patchPluginXml {
        sinceBuild.set(providers.gradleProperty("pluginSinceBuild"))
    }

    named("instrumentCode") {
        enabled = false
    }
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run:

```bash
cd plugins/idea-copilot
./gradlew test --tests com.tinyai.observability.idea.TinyAiPayloadTest
```

Expected: PASS with `TinyAiPayloadTest`.

- [ ] **Step 5: Commit the test harness**

Run:

```bash
git add plugins/idea-copilot/build.gradle.kts plugins/idea-copilot/src/test/kotlin/com/tinyai/observability/idea/TinyAiPayloadTest.kt
git commit -m "Add JetBrains plugin test harness"
```

## Task 2: Add Shared Hashing, Client IDs, And Collector URL Security

**Files:**
- Modify: `plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiUtil.kt`
- Modify: `plugins/idea-copilot/src/test/kotlin/com/tinyai/observability/idea/TinyAiPayloadTest.kt`

- [ ] **Step 1: Extend the failing tests for stable IDs and URL policy**

Append these tests to `TinyAiPayloadTest`:

```kotlin
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
```

- [ ] **Step 2: Run the targeted tests and verify missing functions fail**

Run:

```bash
cd plugins/idea-copilot
./gradlew test --tests com.tinyai.observability.idea.TinyAiPayloadTest
```

Expected: FAIL with unresolved references for `copilotTurnEventId` and `isCollectorUploadAllowedForUrl`.

- [ ] **Step 3: Implement utility helpers**

Add these functions to `TinyAiUtil.kt`:

```kotlin
fun sha256(value: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
    return digest.joinToString("") { "%02x".format(it) }
}

fun textHash(value: String): String = sha256(value)

fun copilotClientId(identity: TinyAiIdentity): String =
    sha256Short("copilot:${identity.userId}:${identity.machineId}")

fun copilotTurnEventId(clientId: String, sessionId: String, requestId: String, responseId: String): String =
    sha256Short("copilot:turn:$clientId:$sessionId:$requestId:$responseId")

fun isCollectorUploadAllowedForUrl(baseUrl: String, token: String): Boolean {
    val uri = runCatching { java.net.URI.create(baseUrl.trim()) }.getOrNull() ?: return false
    val scheme = uri.scheme?.lowercase() ?: return false
    if (scheme == "https") return token.trim().isNotEmpty()
    if (scheme != "http") return false
    val host = uri.host?.lowercase() ?: return false
    if (host == "localhost" || host == "127.0.0.1" || host == "::1") return true
    val parts = host.split(".").mapNotNull { it.toIntOrNull() }
    if (parts.size != 4) return false
    if (parts[0] == 10) return true
    if (parts[0] == 192 && parts[1] == 168) return true
    if (parts[0] == 172 && parts[1] in 16..31) return true
    return false
}

fun assertCollectorUploadAllowed(baseUrl: String, token: String) {
    if (!isCollectorUploadAllowedForUrl(baseUrl, token)) {
        throw IllegalArgumentException("collector upload blocked: public collector requires HTTPS with a bearer token")
    }
}
```

Keep the existing `sha256Short` implementation or rewrite it to call `sha256(value).take(32)`.

- [ ] **Step 4: Run tests**

Run:

```bash
cd plugins/idea-copilot
./gradlew test --tests com.tinyai.observability.idea.TinyAiPayloadTest
```

Expected: PASS.

- [ ] **Step 5: Commit utilities**

Run:

```bash
git add plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiUtil.kt plugins/idea-copilot/src/test/kotlin/com/tinyai/observability/idea/TinyAiPayloadTest.kt
git commit -m "Add JetBrains Copilot telemetry ID helpers"
```

## Task 3: Expand Parsed Turn And Persistent Turn State

**Files:**
- Modify: `plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiModels.kt`
- Modify: `plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiSettings.kt`
- Modify: `plugins/idea-copilot/src/test/kotlin/com/tinyai/observability/idea/TinyAiPayloadTest.kt`

- [ ] **Step 1: Add failing tests for turn signatures and capture state**

Append to `TinyAiPayloadTest`:

```kotlin
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
```

- [ ] **Step 2: Run tests and verify constructor/signature failures**

Run:

```bash
cd plugins/idea-copilot
./gradlew test --tests com.tinyai.observability.idea.TinyAiPayloadTest
```

Expected: FAIL because `ParsedCopilotTurn` lacks new fields and `TinyAiTurnCaptureState` does not exist.

- [ ] **Step 3: Update models**

Replace `ParsedCopilotTurn` in `TinyAiModels.kt` with:

```kotlin
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
```

- [ ] **Step 4: Add persistent fields**

Add to `TinyAiSettings.StateData`:

```kotlin
var turnCaptureStates: MutableMap<String, TinyAiTurnCaptureState> = mutableMapOf(),
var lastScanDiagnostics: TinyAiScanDiagnostics = TinyAiScanDiagnostics()
```

- [ ] **Step 5: Run tests**

Run:

```bash
cd plugins/idea-copilot
./gradlew test --tests com.tinyai.observability.idea.TinyAiPayloadTest
```

Expected: PASS.

- [ ] **Step 6: Commit model state**

Run:

```bash
git add plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiModels.kt plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiSettings.kt plugins/idea-copilot/src/test/kotlin/com/tinyai/observability/idea/TinyAiPayloadTest.kt
git commit -m "Add JetBrains Copilot turn state models"
```

## Task 4: Preserve Source Metadata In The Scanner

**Files:**
- Create: `plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiCopilotLogParser.kt`
- Modify: `plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiCopilotLogScanner.kt`
- Create: `plugins/idea-copilot/src/test/kotlin/com/tinyai/observability/idea/TinyAiCopilotLogScannerTest.kt`

- [ ] **Step 1: Add failing scanner tests**

Create `TinyAiCopilotLogScannerTest.kt`:

```kotlin
package com.tinyai.observability.idea

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

class TinyAiCopilotLogScannerTest {
    @Test
    fun `parse text segment pairs plain user and assistant lines`() {
        val turns = TinyAiCopilotLogParser.parseText(
            file = File("/tmp/github-copilot.log"),
            text = "user: make a route\nassistant: added the route\n",
            baseOffset = 0,
            sourceMtimeMs = 1000,
            sourceSizeBytes = 42
        )

        assertEquals(1, turns.size)
        assertEquals("make a route", turns[0].userText)
        assertEquals("added the route", turns[0].assistantText)
        assertEquals("jetbrains_copilot_log_heuristic", turns[0].sourceKind)
        assertEquals("jetbrains-copilot-log-heuristic-v1", turns[0].parserVersion)
        assertEquals(1000, turns[0].sourceMtimeMs)
        assertEquals(42, turns[0].sourceSizeBytes)
    }

    @Test
    fun `parse text segment pairs json user and assistant lines`() {
        val text = """
            {"role":"user","text":"write tests","timestamp":"2026-07-02T01:00:00Z"}
            {"role":"assistant","text":"tests added","timestamp":"2026-07-02T01:00:02Z"}
        """.trimIndent() + "\n"

        val turns = TinyAiCopilotLogParser.parseText(
            file = File("/tmp/copilot.jsonl"),
            text = text,
            baseOffset = 0,
            sourceMtimeMs = 1000,
            sourceSizeBytes = text.length.toLong()
        )

        assertEquals(1, turns.size)
        assertEquals("write tests", turns[0].userText)
        assertEquals("tests added", turns[0].assistantText)
        assertEquals("2026-07-02T01:00:00Z", turns[0].startedAt)
        assertEquals("2026-07-02T01:00:02Z", turns[0].completedAt)
        assertTrue(turns[0].requestId.isNotBlank())
    }
}
```

- [ ] **Step 2: Run scanner tests and verify helper failure**

Run:

```bash
cd plugins/idea-copilot
./gradlew test --tests com.tinyai.observability.idea.TinyAiCopilotLogScannerTest
```

Expected: FAIL because `TinyAiCopilotLogParser` and new metadata fields are not wired.

- [ ] **Step 3: Create pure parser object**

Create `plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiCopilotLogParser.kt` with the same plain and JSON line parsing rules currently embedded in `TinyAiCopilotLogScanner`, but with no dependency on `TinyAiSettings` or IntelliJ services. Its public method is:

```kotlin
internal object TinyAiCopilotLogParser {
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
}
```

Move the existing `LogMessage`, `Role`, `parseLogLine`, `parseJsonLogLine`, `parsePlainLogLine`, `firstString`, `classifyRole`, and `stableTurnIndex` helpers from the scanner into this object.

- [ ] **Step 4: Update scanner parsed turn construction**

Update `TinyAiCopilotLogScanner` so:

- Nitrite turns use `sourceKind = "jetbrains_copilot_nitrite"`.
- Heuristic turns use `sourceKind = "jetbrains_copilot_log_heuristic"`.
- `startedAt` comes from the user timestamp when present.
- `completedAt` comes from assistant timestamp or file mtime fallback.
- `sourceMtimeMs = file.lastModified()`.
- `sourceSizeBytes = file.length()`.
- `parserVersion` is `jetbrains-copilot-nitrite-v1` or `jetbrains-copilot-log-heuristic-v1`.

Replace the body of `parseTurns` with:

```kotlin
return TinyAiCopilotLogParser.parseText(
    file = file,
    text: text,
    baseOffset: baseOffset,
    sourceMtimeMs: file.lastModified(),
    sourceSizeBytes: file.length()
)
```

Remove the old plain-log parsing helpers from `TinyAiCopilotLogScanner` after `TinyAiCopilotLogParser` owns them.

- [ ] **Step 5: Run scanner tests**

Run:

```bash
cd plugins/idea-copilot
./gradlew test --tests com.tinyai.observability.idea.TinyAiCopilotLogScannerTest
```

Expected: PASS.

- [ ] **Step 6: Commit scanner metadata**

Run:

```bash
git add plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiCopilotLogParser.kt plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiCopilotLogScanner.kt plugins/idea-copilot/src/test/kotlin/com/tinyai/observability/idea/TinyAiCopilotLogScannerTest.kt
git commit -m "Capture JetBrains Copilot source metadata"
```

## Task 5: Emit `copilot.turn_snapshot.v1` Payloads And Dedupe Acknowledged Turns

**Files:**
- Modify: `plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiCopilotCollectorService.kt`
- Modify: `plugins/idea-copilot/src/test/kotlin/com/tinyai/observability/idea/TinyAiPayloadTest.kt`

- [ ] **Step 1: Add failing payload shape tests**

Append to `TinyAiPayloadTest`:

```kotlin
    @Test
    fun `turn payload matches copilot turn snapshot shape`() {
        val turn = parsedTurn()
        val payload = TinyAiCopilotCollectorService.turnPayloadForTest(
            turn = turn,
            projectName = "demo",
            projectPath = "/repo/demo"
        )

        assertEquals("copilot.turn_snapshot.v1", payload["schema_version"]!!.jsonPrimitive.content)
        assertEquals("session-1", payload["session_id"]!!.jsonPrimitive.content)
        assertEquals("request-1", payload["request_id"]!!.jsonPrimitive.content)
        assertEquals("response-1", payload["response_id"]!!.jsonPrimitive.content)
        assertEquals("permanent", payload["retention_policy"]!!.jsonPrimitive.content)
        assertEquals(true, payload["include_text"]!!.jsonPrimitive.boolean)
        assertEquals("jetbrains_copilot_log_heuristic", payload["source"]!!.jsonPrimitive.content)

        val messages = payload["messages"]!!.jsonArray
        assertEquals("user", messages[0].jsonObject["role"]!!.jsonPrimitive.content)
        assertEquals(textHash("question"), messages[0].jsonObject["text_hash"]!!.jsonPrimitive.content)
        assertEquals("assistant", messages[1].jsonObject["role"]!!.jsonPrimitive.content)

        val turnObject = payload["turn"]!!.jsonObject
        assertEquals("completed", turnObject["status"]!!.jsonPrimitive.content)
        assertEquals("request-1", turnObject["request_id"]!!.jsonPrimitive.content)
    }
```

- [ ] **Step 2: Run payload tests and verify helper failure**

Run:

```bash
cd plugins/idea-copilot
./gradlew test --tests com.tinyai.observability.idea.TinyAiPayloadTest
```

Expected: FAIL because `turnPayloadForTest` does not exist and existing payload uses primitive string messages.

- [ ] **Step 3: Implement payload builder**

In `TinyAiCopilotCollectorService`, extract payload creation into an internal pure function:

```kotlin
internal fun buildTurnPayload(turn: ParsedCopilotTurn, projectName: String, projectPath: String): Map<String, JsonElement> {
    val userHash = textHash(turn.userText)
    val assistantHash = textHash(turn.assistantText)
    return buildJsonObject {
        put("schema_version", JsonPrimitive("copilot.turn_snapshot.v1"))
        put("session_id", JsonPrimitive(turn.sessionId))
        put("request_id", JsonPrimitive(turn.requestId))
        put("response_id", JsonPrimitive(turn.responseId))
        put("turn_index", JsonPrimitive(turn.turnIndex))
        put("attempt", JsonPrimitive(turn.attempt))
        put("source", JsonPrimitive(turn.sourceKind))
        put("user_message", buildJsonObject {
            put("role", JsonPrimitive("user"))
            put("text", JsonPrimitive(turn.userText))
            put("text_hash", JsonPrimitive(userHash))
            put("source", JsonPrimitive(turn.sourceKind))
            put("occurred_at", JsonPrimitive(turn.startedAt))
        })
        put("assistant_message", buildJsonObject {
            put("role", JsonPrimitive("assistant"))
            put("text", JsonPrimitive(turn.assistantText))
            put("text_hash", JsonPrimitive(assistantHash))
            put("source", JsonPrimitive(turn.sourceKind))
            put("occurred_at", JsonPrimitive(turn.completedAt))
        })
        put("messages", buildJsonArray {
            add(buildJsonObject {
                put("role", JsonPrimitive("user"))
                put("text", JsonPrimitive(turn.userText))
                put("text_hash", JsonPrimitive(userHash))
                put("source", JsonPrimitive(turn.sourceKind))
                put("source_key", JsonPrimitive("${turn.requestId}:user"))
                put("occurred_at", JsonPrimitive(turn.startedAt))
            })
            add(buildJsonObject {
                put("role", JsonPrimitive("assistant"))
                put("text", JsonPrimitive(turn.assistantText))
                put("text_hash", JsonPrimitive(assistantHash))
                put("source", JsonPrimitive(turn.sourceKind))
                put("source_key", JsonPrimitive("${turn.requestId}:${turn.responseId}:assistant"))
                put("occurred_at", JsonPrimitive(turn.completedAt))
            })
        })
        put("turn", buildJsonObject {
            put("turn_index", JsonPrimitive(turn.turnIndex))
            put("request_id", JsonPrimitive(turn.requestId))
            put("response_id", JsonPrimitive(turn.responseId))
            put("attempt", JsonPrimitive(turn.attempt))
            put("status", JsonPrimitive("completed"))
            put("started_at", JsonPrimitive(turn.startedAt))
            put("completed_at", JsonPrimitive(turn.completedAt))
        })
        put("source_files", buildJsonObject {
            put("jetbrains_copilot", buildJsonObject {
                put("path", JsonPrimitive(turn.sourceFile))
                put("mtime_ms", JsonPrimitive(turn.sourceMtimeMs))
                put("size_bytes", JsonPrimitive(turn.sourceSizeBytes))
                put("read_offset", JsonPrimitive(turn.sourceOffset))
                put("parser_version", JsonPrimitive(turn.parserVersion))
                put("capture_limitations", JsonPrimitive("Captured from JetBrains-local Copilot persisted evidence. Tool calls and hidden reasoning are included only if the local source persisted them."))
            })
        })
        turn.model?.let {
            put("model", JsonPrimitive(it))
            put("resolved_model", JsonPrimitive(it))
        }
        put("request_usage", buildJsonArray {})
        put("usage_totals", buildJsonObject {})
        put("include_text", JsonPrimitive(true))
        put("retention_policy", JsonPrimitive("permanent"))
        put("project_name", JsonPrimitive(projectName))
        put("project_path", JsonPrimitive(projectPath))
    }
}
```

Add test access in a companion object:

```kotlin
companion object {
    internal fun turnPayloadForTest(turn: ParsedCopilotTurn, projectName: String, projectPath: String): Map<String, JsonElement> =
        buildTurnPayload(turn, projectName, projectPath)
}
```

- [ ] **Step 4: Update event creation and dedupe**

In `turnToEvent`, use:

```kotlin
val clientId = copilotClientId(identity)
val eventId = copilotTurnEventId(clientId, turn.sessionId, turn.requestId, turn.responseId)
val taskId = "copilot-local-${turn.sessionId}".take(64)
val payload = buildTurnPayload(turn, project.name, project.basePath ?: "")
```

Before building upload batches in `captureNow`, filter turns:

```kotlin
val state = settings.state
val uploadable = turns.filter { turn ->
    val key = turnStateKey(turn)
    !state.turnCaptureStates[key]?.isAcknowledged(turn.signature()).orFalse()
}
```

Use a local helper:

```kotlin
private fun Boolean?.orFalse(): Boolean = this == true
private fun turnStateKey(turn: ParsedCopilotTurn): String =
    "turn:${turn.sessionId}:${turn.requestId}:${turn.responseId}:jetbrains-copilot-v1"
```

- [ ] **Step 5: Run payload tests**

Run:

```bash
cd plugins/idea-copilot
./gradlew test --tests com.tinyai.observability.idea.TinyAiPayloadTest
```

Expected: PASS.

- [ ] **Step 6: Commit payload alignment**

Run:

```bash
git add plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiCopilotCollectorService.kt plugins/idea-copilot/src/test/kotlin/com/tinyai/observability/idea/TinyAiPayloadTest.kt
git commit -m "Align JetBrains Copilot turn payloads"
```

## Task 6: Parse Collector Batch Results And Update Turn State

**Files:**
- Modify: `plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiCollectorClient.kt`
- Modify: `plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiCopilotCollectorService.kt`
- Modify: `plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiModels.kt`
- Create: `plugins/idea-copilot/src/test/kotlin/com/tinyai/observability/idea/TinyAiCollectorClientTest.kt`

- [ ] **Step 1: Add failing client response tests**

Create `TinyAiCollectorClientTest.kt`:

```kotlin
package com.tinyai.observability.idea

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class TinyAiCollectorClientTest {
    @Test
    fun `parse upload result accepts accepted duplicate and failed statuses`() {
        val json = """
            {
              "accepted": 1,
              "duplicates": 1,
              "failed": 1,
              "task_count": 2,
              "events": [
                {"event_id":"e1","event_type":"turn_snapshot","status":"accepted"},
                {"event_id":"e2","event_type":"turn_snapshot","status":"duplicate"},
                {"event_id":"e3","event_type":"turn_snapshot","status":"failed","reason":"schema_error"}
              ]
            }
        """.trimIndent()

        val result = TinyAiCollectorClient.parseUploadResultForTest(json)
        assertEquals(1, result.accepted)
        assertEquals(1, result.duplicates)
        assertEquals(1, result.failed)
        assertEquals("schema_error", result.events[2].reason)
    }
}
```

- [ ] **Step 2: Run client tests and verify missing model/helper failure**

Run:

```bash
cd plugins/idea-copilot
./gradlew test --tests com.tinyai.observability.idea.TinyAiCollectorClientTest
```

Expected: FAIL because upload result models and parser helper do not exist.

- [ ] **Step 3: Add serializable upload result models**

Add to `TinyAiModels.kt`:

```kotlin
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
```

- [ ] **Step 4: Change collector client send return type**

Change `TinyAiCollectorClient.send(events: List<TinyAiEvent>): Boolean` to:

```kotlin
fun send(events: List<TinyAiEvent>): TinyAiBatchUploadResult
```

Use `TinyAiBatchUploadResult(accepted = 0, failed = events.size, queued = true)` for retryable transport failures. On HTTP 2xx, parse the body:

```kotlin
private fun parseUploadResult(body: String): TinyAiBatchUploadResult =
    json.decodeFromString<TinyAiBatchUploadResult>(body)
```

Add test helper:

```kotlin
companion object {
    internal fun parseUploadResultForTest(body: String): TinyAiBatchUploadResult =
        Json { ignoreUnknownKeys = true }.decodeFromString(body)
}
```

Call `assertCollectorUploadAllowed(settings.normalizedCollectorUrl(), settings.state.token)` before creating the request.

- [ ] **Step 5: Update service upload state handling**

In `TinyAiCopilotCollectorService.captureNow()`:

```kotlin
val eventsById = uploadable.associateBy { turn ->
    copilotTurnEventId(copilotClientId(settings.identity()), turn.sessionId, turn.requestId, turn.responseId)
}
val events = uploadable.map { turnToEvent(it) }
markQueued(uploadable, events)
val result = client.send(events)
applyUploadResult(result, eventsById)
return result.accepted + result.duplicates
```

Implement:

```kotlin
private fun markQueued(turns: List<ParsedCopilotTurn>, events: List<TinyAiEvent>) {
    val now = nowIso()
    turns.zip(events).forEach { (turn, event) ->
        val key = turnStateKey(turn)
        val current = settings.state.turnCaptureStates[key]
        settings.state.turnCaptureStates[key] = TinyAiTurnCaptureState(
            eventId = event.eventId,
            signature = turn.signature(),
            status = "queued",
            firstSeenAt = current?.firstSeenAt?.takeIf { it.isNotBlank() } ?: now,
            lastAttemptAt = now,
            acknowledgedAt = current?.acknowledgedAt,
            errorCount = current?.errorCount ?: 0,
            lastError = current?.lastError
        )
    }
}

private fun applyUploadResult(result: TinyAiBatchUploadResult, eventsById: Map<String, ParsedCopilotTurn>) {
    val now = nowIso()
    result.events.forEach { eventResult ->
        val turn = eventsById[eventResult.eventId] ?: return@forEach
        val key = turnStateKey(turn)
        val current = settings.state.turnCaptureStates[key] ?: TinyAiTurnCaptureState(
            eventId = eventResult.eventId,
            signature = turn.signature(),
            firstSeenAt = now,
            lastAttemptAt = now
        )
        if (eventResult.status == "accepted" || eventResult.status == "duplicate") {
            current.status = "acknowledged"
            current.acknowledgedAt = now
            current.lastError = null
        } else {
            current.status = "failed"
            current.errorCount += 1
            current.lastError = eventResult.reason ?: "upload_failed"
        }
        settings.state.turnCaptureStates[key] = current
    }
}
```

`accepted` and `duplicate` mark `status = "acknowledged"` and set `acknowledgedAt = nowIso()`. `failed` increments `errorCount` and stores `reason`.

- [ ] **Step 6: Run client and payload tests**

Run:

```bash
cd plugins/idea-copilot
./gradlew test --tests com.tinyai.observability.idea.TinyAiCollectorClientTest --tests com.tinyai.observability.idea.TinyAiPayloadTest
```

Expected: PASS.

- [ ] **Step 7: Commit upload result handling**

Run:

```bash
git add plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiCollectorClient.kt plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiCopilotCollectorService.kt plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiModels.kt plugins/idea-copilot/src/test/kotlin/com/tinyai/observability/idea/TinyAiCollectorClientTest.kt
git commit -m "Track JetBrains Copilot upload acknowledgements"
```

## Task 7: Add Heartbeat Diagnostics Without Sensitive Paths

**Files:**
- Modify: `plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiCollectorClient.kt`
- Modify: `plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiCopilotCollectorService.kt`
- Modify: `plugins/idea-copilot/src/test/kotlin/com/tinyai/observability/idea/TinyAiPayloadTest.kt`

- [ ] **Step 1: Add failing heartbeat diagnostics test**

Append to `TinyAiPayloadTest`:

```kotlin
    @Test
    fun `heartbeat diagnostics include counts but not raw extra roots`() {
        val diagnostics = TinyAiScanDiagnostics(
            scannedAt = "2026-07-02T01:00:00Z",
            filesScanned = 3,
            turnsParsed = 2,
            turnsUploaded = 1,
            parseErrorCount = 0,
            uploadErrorCount = 1,
            lastErrorCategory = "network_error"
        )

        val payload = TinyAiCollectorClient.heartbeatPayloadForTest(
            projectName = "demo",
            autoCapture = true,
            captureHistory = true,
            scanIntervalSeconds = 30,
            extraRootCount = 2,
            diagnostics = diagnostics
        )

        assertEquals(2, payload["extra_root_count"]!!.jsonPrimitive.int)
        assertEquals(null, payload["configured_extra_roots"])
        assertEquals("network_error", payload["diagnostics"]!!.jsonObject["last_error_category"]!!.jsonPrimitive.content)
    }
```

- [ ] **Step 2: Run payload tests and verify helper failure**

Run:

```bash
cd plugins/idea-copilot
./gradlew test --tests com.tinyai.observability.idea.TinyAiPayloadTest
```

Expected: FAIL because `heartbeatPayloadForTest` does not exist.

- [ ] **Step 3: Extract heartbeat payload builder**

In `TinyAiCollectorClient`, build heartbeat payload with:

```kotlin
internal fun buildHeartbeatPayload(
    projectName: String?,
    autoCapture: Boolean,
    captureHistory: Boolean,
    scanIntervalSeconds: Int,
    extraRootCount: Int,
    diagnostics: TinyAiScanDiagnostics
): Map<String, JsonElement> = buildJsonObject {
    put("schema_version", JsonPrimitive(1))
    put("source", JsonPrimitive("idea-plugin"))
    put("activation", JsonPrimitive("heartbeat"))
    put("project_name", JsonPrimitive(projectName ?: ""))
    put("auto_capture_copilot_logs", JsonPrimitive(autoCapture))
    put("capture_history_on_first_scan", JsonPrimitive(captureHistory))
    put("scan_interval_seconds", JsonPrimitive(scanIntervalSeconds))
    put("extra_root_count", JsonPrimitive(extraRootCount))
    put("diagnostics", buildJsonObject {
        put("scanned_at", JsonPrimitive(diagnostics.scannedAt))
        put("files_scanned", JsonPrimitive(diagnostics.filesScanned))
        put("turns_parsed", JsonPrimitive(diagnostics.turnsParsed))
        put("turns_uploaded", JsonPrimitive(diagnostics.turnsUploaded))
        put("parse_error_count", JsonPrimitive(diagnostics.parseErrorCount))
        put("upload_error_count", JsonPrimitive(diagnostics.uploadErrorCount))
        diagnostics.lastErrorCategory?.let { put("last_error_category", JsonPrimitive(it)) }
    })
}
```

Use `settings.state.lastScanDiagnostics` in `sendHeartbeat`.

- [ ] **Step 4: Update scan diagnostics after capture**

In `captureNow`, set `settings.state.lastScanDiagnostics` on every scan with counts for files scanned if available. If scanner does not yet expose file count, add `lastCandidateFileCount` to scanner or return a `TinyAiScanResult(turns, filesScanned, parseErrorCount)` instead of a bare list. Prefer `TinyAiScanResult` for clarity:

```kotlin
data class TinyAiScanResult(
    val turns: List<ParsedCopilotTurn>,
    val filesScanned: Int,
    val parseErrorCount: Int
)
```

- [ ] **Step 5: Run tests**

Run:

```bash
cd plugins/idea-copilot
./gradlew test --tests com.tinyai.observability.idea.TinyAiPayloadTest
```

Expected: PASS.

- [ ] **Step 6: Commit diagnostics**

Run:

```bash
git add plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiCollectorClient.kt plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiCopilotCollectorService.kt plugins/idea-copilot/src/main/kotlin/com/tinyai/observability/idea/TinyAiModels.kt plugins/idea-copilot/src/test/kotlin/com/tinyai/observability/idea/TinyAiPayloadTest.kt
git commit -m "Add JetBrains Copilot heartbeat diagnostics"
```

## Task 8: Prove Collector Normalization Compatibility

**Files:**
- Modify: `collector-server/tests/test_normalization.py`

- [ ] **Step 1: Add failing normalization sample test**

Add to `NormalizationTests`:

```python
    def test_idea_copilot_turn_snapshot_normalizes_like_copilot_turn(self):
        payload = {
            "schema_version": "copilot.turn_snapshot.v1",
            "session_id": "idea-session",
            "request_id": "idea-request-1",
            "response_id": "idea-response-1",
            "turn_index": 1,
            "attempt": 1,
            "source": "jetbrains_copilot_nitrite",
            "messages": [
                {
                    "role": "user",
                    "text": "实现 IDEA 插件",
                    "text_hash": "u",
                    "source": "jetbrains_copilot_nitrite",
                    "source_key": "idea-request-1:user",
                    "occurred_at": "2026-07-02T01:00:00Z",
                },
                {
                    "role": "assistant",
                    "text": "已经实现",
                    "text_hash": "a",
                    "source": "jetbrains_copilot_nitrite",
                    "source_key": "idea-request-1:idea-response-1:assistant",
                    "occurred_at": "2026-07-02T01:00:02Z",
                },
            ],
            "turn": {
                "turn_index": 1,
                "request_id": "idea-request-1",
                "response_id": "idea-response-1",
                "attempt": 1,
                "status": "completed",
                "started_at": "2026-07-02T01:00:00Z",
                "completed_at": "2026-07-02T01:00:02Z",
            },
            "source_files": {
                "jetbrains_copilot": {
                    "path": "/Users/test/Library/Application Support/JetBrains/copilot-agent-sessions-nitrite.db",
                    "mtime_ms": 1782990000000,
                    "size_bytes": 2048,
                    "read_offset": 100,
                    "parser_version": "jetbrains-copilot-nitrite-v1",
                    "capture_limitations": "Captured from JetBrains-local Copilot persisted evidence.",
                }
            },
            "request_usage": [],
            "usage_totals": {},
            "include_text": True,
            "retention_policy": "permanent",
        }

        normalized = normalize_event(self.event(event_type="turn_snapshot"), payload)

        self.assertEqual(normalized["adapter"], "copilot_turn_snapshot_v1")
        self.assertEqual(normalized["session"]["session_id"], "idea-session")
        self.assertEqual(normalized["turns"][0]["request_id"], "idea-request-1")
        self.assertEqual(
            [(message["role"], message["content"]) for message in normalized["messages"]],
            [("user", "实现 IDEA 插件"), ("assistant", "已经实现")],
        )
        self.assertEqual(normalized["messages"][0]["request_id"], "idea-request-1")
        self.assertEqual(normalized["messages"][1]["response_id"], "idea-response-1")
```

- [ ] **Step 2: Run targeted collector test**

Run:

```bash
python -m unittest collector-server.tests.test_normalization.NormalizationTests.test_idea_copilot_turn_snapshot_normalizes_like_copilot_turn
```

Expected: PASS. The payload must normalize through the existing `copilot_turn_snapshot_v1` adapter; this plan does not add an IDEA-specific adapter.

- [ ] **Step 3: Run broader normalization tests**

Run:

```bash
python -m unittest collector-server.tests.test_normalization
```

Expected: PASS.

- [ ] **Step 4: Commit collector compatibility test**

Run:

```bash
git add collector-server/tests/test_normalization.py
git commit -m "Test IDEA Copilot turn normalization"
```

## Task 9: Update README And Run Full Verification

**Files:**
- Modify: `plugins/idea-copilot/README.md`

- [ ] **Step 1: Update README capture scope**

Edit `plugins/idea-copilot/README.md` so `What It Does` says:

```markdown
- Sends `tool=copilot` plugin heartbeats to the TinyAI collector.
- Scans JetBrains/GitHub Copilot local evidence every 30 seconds.
- Emits completed turns as `copilot.turn_snapshot.v1`, matching the VS Code Copilot collector-facing schema.
- Tracks stable turn signatures so accepted or duplicate collector responses are not resent.
- Lets users configure additional Copilot log roots in JetBrains settings.
```

Add a note:

```markdown
IDEA and VS Code share collector semantics, not capture internals. VS Code reads `workspaceStorage` chat/transcript JSONL files. This plugin reads JetBrains-local Copilot evidence such as `copilot-agent-sessions-nitrite.db` and conservative log pairs. Hidden model reasoning and tool calls are included only when the local JetBrains source persists them.
```

- [ ] **Step 2: Run IDEA plugin tests**

Run:

```bash
cd plugins/idea-copilot
./gradlew test
```

Expected: PASS.

- [ ] **Step 3: Build the plugin**

Run:

```bash
cd plugins/idea-copilot
./gradlew buildPlugin
```

Expected: PASS and a zip under `plugins/idea-copilot/build/distributions/`.

- [ ] **Step 4: Run collector normalization tests**

Run:

```bash
python -m unittest collector-server.tests.test_normalization
```

Expected: PASS.

- [ ] **Step 5: Review staged scope**

Run:

```bash
git status --short
git diff -- plugins/idea-copilot collector-server/tests/test_normalization.py
```

Expected: only files from this plan are modified for the final implementation commits. Pre-existing unrelated worktree changes remain unstaged.

- [ ] **Step 6: Commit README**

Run:

```bash
git add plugins/idea-copilot/README.md
git commit -m "Document JetBrains Copilot schema alignment"
```

## Self-Review

Spec coverage:

- `copilot.turn_snapshot.v1` payloads: Task 5 and Task 8.
- `tool=copilot` and collector batch shape: Task 5 and Task 6.
- IDEA-specific Nitrite/log scanning isolation: Task 4.
- Stable signatures and acknowledgement-aware dedupe: Task 3, Task 5, Task 6.
- Reliable upload basics and security checks: Task 2 and Task 6.
- Heartbeat diagnostics without raw paths: Task 7.
- Kotlin tests and collector normalization tests: Tasks 1, 4, 5, 6, 7, 8.
- README update: Task 9.

Placeholder scan:

- The plan contains no placeholder markers or intentionally deferred implementation steps.
- Every code-changing step names exact files and gives concrete commands.

Type consistency:

- `ParsedCopilotTurn.signature()` is introduced before payload/dedupe tasks use it.
- `TinyAiBatchUploadResult` and `TinyAiBatchEventResult` are introduced before client/service upload state handling uses them.
- `TinyAiScanDiagnostics` is introduced before heartbeat diagnostics uses it.
