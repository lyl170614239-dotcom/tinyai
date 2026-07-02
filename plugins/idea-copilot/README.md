# TinyAI Observability JetBrains Plugin

JetBrains plugin shell for TinyAI Observability.

Target IDE: IntelliJ Platform 2025.2+.

This plugin is separate from the VS Code extension. VS Code `.vsix` packages
cannot be installed in IDEA, but this plugin reuses the same TinyAI collector
event shape and focuses on JetBrains-local Copilot evidence.

## What It Does

- Sends `tool=copilot` plugin heartbeats to the TinyAI collector.
- Scans likely JetBrains/Copilot local log locations every 30 seconds.
- Lets users configure additional Copilot log roots in IDEA settings.
- Uploads inferred turns as `turn_snapshot` events with
  `schema_version=copilot.turn_snapshot.v1`.
- Tracks stable per-turn signatures and collector acknowledgements so accepted
  or duplicate events are not re-uploaded on later scans.

## Current Capture Scope

The first version is intentionally conservative because JetBrains Copilot local
log formats vary by IDE version and plugin version.

It scans:

```text
~/Library/Logs/JetBrains/**
~/Library/Application Support/JetBrains/**
~/.cache/JetBrains/**
~/.config/JetBrains/**
%LOCALAPPDATA%/JetBrains/**
%APPDATA%/JetBrains/**
```

and any extra directories configured in:

```text
Settings | Tools | TinyAI Observability | Extra Copilot log roots
```

Supported sources include:

- GitHub Copilot agent session Nitrite stores named
  `copilot-agent-sessions-nitrite.db`.
- Files containing `copilot`, `github-copilot`, `chat`, `llm`, or
  `ai-assistant` with `.jsonl`, `.log`, `.txt`, or `.json` extensions.

The collector-facing payload is intentionally aligned with the VS Code Copilot
extension's `turn_snapshot` contract: stable session/request/response IDs,
canonical `messages`, `turn`, `request_usage`, `usage_totals`, and source file
metadata. The local capture path is different, so IDEA events may omit details
that are not present in JetBrains-local artifacts, such as tool calls, token
usage, or exact model names.

## Build

```bash
cd plugins/idea-copilot
./gradlew buildPlugin
```

If Gradle cannot download the IntelliJ Platform distribution, build against a
locally installed JetBrains IDE:

```bash
./gradlew buildPlugin -PlocalIdePath="/Applications/IntelliJ IDEA.app"
```

The plugin zip will be under:

```text
plugins/idea-copilot/build/distributions/tinyai-observability-jetbrains-0.1.3.zip
```

## Install

In IDEA:

1. Open `Settings | Plugins`.
2. Choose `Install Plugin from Disk...`.
3. Select the generated plugin zip.
4. Restart IDEA.
5. Open `Settings | Tools | TinyAI Observability`.
6. Set name, optional email/user ID, collector URL, and optional Copilot log roots.

## Notes

- This is not a direct port of the VS Code extension. It is a JetBrains plugin
  shell that speaks the same TinyAI collector protocol and normalizes into the
  same Copilot turn timeline.
- If IDEA/GitHub Copilot does not persist chat transcripts locally, the plugin
  can still send heartbeats but cannot reconstruct chat turns until a log source
  is configured or parser support is added for the real local format.
- Once we collect real JetBrains Copilot log samples, add a precise parser in
  `TinyAiCopilotLogParser` or the Nitrite reader in `TinyAiCopilotLogScanner`.
