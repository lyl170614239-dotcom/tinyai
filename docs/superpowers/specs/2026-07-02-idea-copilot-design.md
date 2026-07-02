# IDEA Copilot Observability Design

Date: 2026-07-02

## Goal

Complete `plugins/idea-copilot` so the JetBrains plugin behaves like the VS Code Copilot observability plugin wherever the platform allows it. The only intentional major difference is the capture source: IDEA must read JetBrains/GitHub Copilot local evidence such as Nitrite databases and logs, while VS Code reads workspaceStorage chat session and transcript JSONL files.

## Current Findings

The IDEA plugin already has a working shell:

- `TinyAiStartupActivity` starts a project service.
- `TinyAiCopilotCollectorService` sends heartbeats, schedules scans, converts parsed turns to events, and uploads them.
- `TinyAiCopilotLogScanner` discovers JetBrains/Copilot candidate files, reads `copilot-agent-sessions-nitrite.db`, and falls back to heuristic log parsing.
- `TinyAiCollectorClient` sends collector batches to `/api/v1/events/batch`.
- Settings and Tools menu actions exist.

The VS Code Copilot plugin is more mature in the shared behavior:

- It emits `tool=copilot` `turn_snapshot` events using `copilot.turn_snapshot.v1`.
- It uses stable client/turn event IDs and content signatures.
- It tracks queued versus acknowledged turn state.
- It includes structured message hashes, turn metadata, source files, model/usage fields when available, diagnostics, and upload result handling.
- It has broader tests around collector normalization and upload behavior.

## Scope

Implement the recommended middle path: align shared observability semantics with VS Code while keeping IDEA-specific capture sources isolated.

In scope:

- Emit IDEA Copilot turns as `copilot.turn_snapshot.v1` payloads.
- Keep `tool=copilot` and the existing TinyAI collector batch shape.
- Preserve IDEA-specific Nitrite/log scanning behind scanner interfaces.
- Add stable turn signatures and acknowledgement-aware dedupe state.
- Add reliable upload basics: result parsing, retryable state, diagnostics, and security checks consistent with the runtime behavior.
- Add focused Kotlin tests and collector normalization tests.
- Update README to describe the aligned behavior and remaining platform limitations.

Out of scope for this pass:

- VS Code-only features such as chat participants, language model tools, and workspaceStorage parsing.
- IDEA editor delta attribution unless there is platform evidence strong enough to avoid attributing pre-existing user changes to Copilot.
- Hidden chain-of-thought capture. Only locally persisted visible text can be captured.
- Guessing unsupported JetBrains Copilot formats without samples.

## Architecture

Keep the existing four-layer shape:

1. `TinyAiStartupActivity`
   Starts the project-level collector service on project open.

2. `TinyAiCopilotCollectorService`
   Owns scheduling, scanner invocation, turn-to-event conversion, dedupe state, upload result handling, and heartbeat diagnostics.

3. `TinyAiCopilotLogScanner`
   Owns capture-source discovery and parsing only. It returns structured parsed turns with enough source metadata for event generation and dedupe.

4. `TinyAiCollectorClient`
   Owns collector URL validation, batch serialization, request execution, response parsing, fallback/retry classification, and last-error diagnostics.

This keeps platform-specific parsing separate from shared collector semantics.

## Data Model

Extend `ParsedCopilotTurn` so scanner output can produce a VS Code-compatible turn snapshot:

- `sessionId`
- `requestId`
- `responseId`
- `turnIndex`
- `attempt`
- `userText`
- `assistantText`
- `startedAt`
- `completedAt`
- `model`
- `sourceKind`
- `sourceFile`
- `sourceOffset`
- `sourceMtimeMs`
- `sourceSizeBytes`
- `parserVersion`

Add persistent turn capture state in `TinyAiSettings.StateData`:

- key: `turn:<sessionId>:<requestId>:<responseId>:<capability>`
- `eventId`
- `signature`
- `status`: `queued`, `acknowledged`, or `failed`
- `firstSeenAt`
- `lastAttemptAt`
- `acknowledgedAt`
- `errorCount`
- `lastError`

Existing file cursors stay separate from turn acknowledgement state. File cursors prevent repeated parsing; turn state prevents repeated uploads and allows retry handling.

## Event Payload

IDEA `turn_snapshot` payloads should match the collector-facing Copilot turn shape:

- `schema_version`: `copilot.turn_snapshot.v1`
- `session_id`
- `request_id`
- `response_id`
- `turn_index`
- `attempt`
- `source`: `jetbrains_copilot_nitrite` or `jetbrains_copilot_log_heuristic`
- `user_message`: `{ role, text, text_hash, source, occurred_at }`
- `assistant_message`: `{ role, text, text_hash, source, occurred_at }`
- `messages`: two top-level messages with `role`, `text`, `text_hash`, `source`, `source_key`, and `occurred_at`
- `turn`: `{ turn_index, request_id, response_id, attempt, status, started_at, completed_at }`
- `source_files.jetbrains_copilot`: source metadata plus parser version and capture limitations
- `model` and `resolved_model` when known
- `request_usage` and `usage_totals` when known, otherwise empty structures
- `include_text`: `true`
- `retention_policy`: `permanent`
- `project_name` and `project_path`

The collector already normalizes generic `tool=copilot` `turn_snapshot` payloads, so no separate IDEA tool name is needed.

## Scanning Strategy

Nitrite scanning remains the preferred path:

- Discover `copilot-agent-sessions-nitrite.db`.
- Copy the file to a temporary path before opening it read-only.
- Parse only records with clear user and assistant text.
- Use record IDs and created/completed timestamps for stable turn identity.

Heuristic log scanning remains conservative:

- Scan likely JetBrains and GitHub Copilot roots plus user-configured extra roots.
- Read incrementally by byte offset.
- Parse JSONL, JSON, log, and text files only when filenames include Copilot/AI/chat signals.
- Upload only paired user/assistant turns.
- Include parser limitations in `source_files` so downstream consumers understand confidence.

## Upload And Dedupe

Generate the turn event ID using the same principle as VS Code:

`sha256("copilot:turn:<clientId>:<sessionId>:<requestId>:<responseId>").slice(0, 32)`

Generate the turn signature from:

- `request_id`
- `response_id`
- user message hash
- assistant message hash
- source kind
- source offset or created time
- parser version
- completed timestamp

Before upload:

- Skip if the stored status is `acknowledged` with the same signature.
- Upload if the signature is new, queued, or failed.
- Mark attempted turns as `queued` before sending.

After upload:

- Mark `accepted` and `duplicate` events as `acknowledged`.
- Mark failed events as `failed` and increment `errorCount`.
- Keep enough error text for the manual action and heartbeat diagnostics.

Collector URL security should follow the runtime policy: localhost and private LAN HTTP are allowed for team testing; public collectors require HTTPS with a bearer token.

## Heartbeat And Diagnostics

Heartbeat payloads should include:

- plugin version
- scan interval
- auto-capture flag
- history-on-first-scan flag
- extra root count, not raw sensitive paths
- last scan timestamp
- files scanned
- turns parsed
- turns uploaded
- parse error count
- upload error count
- last error category

This mirrors VS Code diagnostics while avoiding sensitive path leakage.

## Testing

Add focused tests rather than broad end-to-end IDE UI tests:

- Kotlin tests for JSON/plain log parsing.
- Kotlin tests for Nitrite-like parsed records where possible without depending on live JetBrains Copilot.
- Kotlin tests for event payload shape, text hashes, stable IDs, signatures, and acknowledgement state transitions.
- Kotlin tests for collector client response parsing and collector URL security.
- Python collector normalization test with an IDEA-produced `copilot.turn_snapshot.v1` sample.

Verification commands:

- `./gradlew test`
- `./gradlew buildPlugin`
- targeted collector tests for normalization/ingest behavior affected by Copilot turn snapshots

## Risks

JetBrains Copilot local formats can change. The scanner must stay conservative, version parser output, and expose limitations.

IDEA may not persist the same tool-call and process-step detail that VS Code does. Missing fields should be empty arrays, not fabricated data.

Code-change attribution is risky without a turn-start baseline. This pass should avoid workspace diff attribution from IDEA until reliable evidence exists.

## Acceptance Criteria

- IDEA plugin emits `tool=copilot` `turn_snapshot` events with `copilot.turn_snapshot.v1` payloads.
- Collector normalization treats IDEA events like VS Code Copilot turns.
- Stable event IDs and signatures prevent duplicate uploads.
- Failed uploads remain retryable and acknowledged uploads are not resent.
- Heartbeat diagnostics describe scanner and upload health.
- Tests cover parser behavior, event generation, dedupe state, upload result handling, and collector normalization.
- README explains that IDEA shares collector semantics with VS Code but uses JetBrains-local capture sources.
