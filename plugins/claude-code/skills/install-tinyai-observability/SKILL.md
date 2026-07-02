---
name: install-tinyai-observability
description: Install, update, or verify the TinyAI Observability Claude Code plugin from the TinyAI Git marketplace repository. Use when the user provides the TinyAI Git URL, asks to install TinyAI observability, update the Claude plugin, check whether observability@tinyai is enabled, or make Claude Code telemetry upload to the TinyAI collector.
---

# Install TinyAI Observability for Claude Code

Use this skill when the user wants Claude Code to install or maintain the
TinyAI Observability plugin from Git.

Default Git marketplace:

```text
https://github.com/lyl170614239-dotcom/tinyai.git
```

## First install

Run these commands:

```bash
rm -rf /tmp/tinyai-observability-plugins
git clone --depth 1 --branch codex/plugin-marketplace https://github.com/lyl170614239-dotcom/tinyai.git /tmp/tinyai-observability-plugins
claude plugin validate /tmp/tinyai-observability-plugins/.claude-plugin/marketplace.json
claude plugin validate /tmp/tinyai-observability-plugins/plugins/claude-code/.claude-plugin/plugin.json
claude plugin marketplace add /tmp/tinyai-observability-plugins
claude plugin marketplace update tinyai
claude plugin install observability@tinyai
claude plugin marketplace list
```

Then repair legacy project MCP paths and remove older TinyAI Observability cache
versions. This prevents Claude Code from showing `observability@tinyai` as
installed while a project-level MCP entry still points at an old or deleted
runtime path.

```bash
python3 - <<'PY'
from pathlib import Path
import json
import shutil

home = Path.home()
claude_json = home / ".claude.json"
plugin_root = home / ".claude" / "plugins" / "cache" / "tinyai" / "observability"
if not plugin_root.exists():
    raise SystemExit(0)

candidates = []
for manifest in plugin_root.glob("*/.claude-plugin/plugin.json"):
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except Exception:
        continue
    version = str(data.get("version") or manifest.parent.name)
    runtime = manifest.parent / "runtime" / "dist" / "mcp-server.js"
    if runtime.exists():
        candidates.append((manifest.parent.stat().st_mtime, version, runtime))

if not candidates:
    raise SystemExit(0)

_, version, runtime = sorted(candidates)[-1]
current_install = runtime.parents[2]

updated = 0
if claude_json.exists():
    root = json.loads(claude_json.read_text(encoding="utf-8") or "{}")
    projects = root.get("projects") if isinstance(root.get("projects"), dict) else {}
    for project in projects.values():
        if not isinstance(project, dict):
            continue
        servers = project.get("mcpServers") if isinstance(project.get("mcpServers"), dict) else {}
        for name, server in servers.items():
            if not isinstance(server, dict):
                continue
            args = server.get("args") if isinstance(server.get("args"), list) else []
            is_tinyai = name == "tinyai-observability" or any(
                isinstance(value, str) and "/.claude/plugins/cache/tinyai/observability/" in value
                for value in args
            )
            if not is_tinyai:
                continue
            changed = False
            if name == "tinyai-observability" or any(
                isinstance(value, str) and "/.claude/plugins/cache/tinyai/observability/" in value
                for value in args
            ):
                server["args"] = [str(runtime)]
                changed = True
            env = server.get("env")
            if not isinstance(env, dict):
                env = {}
                server["env"] = env
            for key in ("TINYAI_OBS_PLUGIN_VERSION", "TINYAI_OBS_USER_EMAIL", "TINYAI_OBS_CLAUDE_USER_EMAIL"):
                if key in env:
                    env.pop(key, None)
                    changed = True
            if changed:
                updated += 1
    if updated:
        claude_json.write_text(json.dumps(root, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

removed = []
for child in plugin_root.iterdir():
    if child == current_install:
        continue
    if not child.is_dir():
        continue
    try:
        shutil.rmtree(child)
        removed.append(str(child))
    except Exception as exc:
        print(f"Could not remove old TinyAI Claude cache {child}: {exc}")

print(f"TinyAI Claude MCP config repaired: {version}; project entries updated: {updated}")
if removed:
    print("Removed old TinyAI Claude cache versions:")
    for path in removed:
        print(f"  {path}")
PY
```

If the `tinyai` marketplace already exists but points to an old local checkout
or stale cache, refresh the source first:

```bash
claude plugin marketplace remove tinyai
claude plugin marketplace add /tmp/tinyai-observability-plugins
claude plugin marketplace update tinyai
claude plugin install observability@tinyai
claude plugin marketplace list
```

Then run the legacy MCP/cache repair script from the first install section.

## Identity setup after install

After `claude plugin install observability@tinyai` succeeds, configure
the identity before telling the user installation is complete. Write both the
generic TinyAI identity and the Claude-specific identity. Claude and Codex are
separate plugins; use `TINYAI_OBS_CLAUDE_*` keys here, not
`TINYAI_OBS_CODEX_*`.

1. Before asking anything, inspect the user's original install request. If the
request already contains a clear name, treat that identity as confirmed and use
it directly. Common examples:

```text
我的姓名是张三
姓名=张三
name=Zhang San
```

If the identity is missing or ambiguous, read existing values:

```bash
env | grep '^TINYAI_OBS_USER_' || true
env | grep '^TINYAI_OBS_CLAUDE_USER_' || true
git config --global user.name || true
```

2. Only ask the user when the request did not provide a clear identity, or when
the detected identity looks unreliable. The prompt should be short:

```text
TinyAI 需要你的姓名用于监控台按人聚合。我检测到：姓名=<git user.name>。是否使用？如果不对，请告诉我正确姓名。
```

3. Write the confirmed identity to the TinyAI env file. Keep unrelated env
values, but replace old generic user identity and old Claude identity values:

```bash
mkdir -p "$HOME/.tinyai-observability"
TINYAI_ENV="$HOME/.tinyai-observability/tinyai-observability.env"
touch "$TINYAI_ENV"
grep -v -E '^(TINYAI_OBS_USER_|TINYAI_OBS_USERNAME=|TINYAI_OBS_CLAUDE_USER_|TINYAI_OBS_CLAUDE_USERNAME=)' "$TINYAI_ENV" > "$TINYAI_ENV.tmp" || true
cat >> "$TINYAI_ENV.tmp" <<'EOF'
TINYAI_OBS_USER_NAME="<confirmed-name>"
TINYAI_OBS_USER_DISPLAY_NAME="<confirmed-name>"
TINYAI_OBS_USERNAME="<confirmed-name>"
TINYAI_OBS_USER_ID="<confirmed-name>"
TINYAI_OBS_CLAUDE_USER_NAME="<confirmed-name>"
TINYAI_OBS_CLAUDE_USER_DISPLAY_NAME="<confirmed-name>"
TINYAI_OBS_CLAUDE_USERNAME="<confirmed-name>"
TINYAI_OBS_CLAUDE_USER_ID="<confirmed-name>"
EOF
mv "$TINYAI_ENV.tmp" "$TINYAI_ENV"
```

Do not collect or write email fields. Set both `TINYAI_OBS_USER_ID` and
`TINYAI_OBS_CLAUDE_USER_ID` to the confirmed name. Do not leave the user as
`user` or `unknown` unless the user explicitly refuses to provide a name.

4. Run the collector smoke test below. Do not claim installation succeeded if
the smoke test fails.

5. Ask the user to restart Claude Code or reload the VS Code Claude Code panel
so the plugin process reloads the env file.

## Collector smoke test after install

Run this smoke test after writing identity and before telling the user the
installation is complete. It verifies both collector reachability and TinyAI
ingest acceptance by posting one `plugin_heartbeat` event.

```bash
TINYAI_ENV="$HOME/.tinyai-observability/tinyai-observability.env"
set -a
. "$TINYAI_ENV"
set +a

COLLECTOR_URL="${TINYAI_OBS_CLAUDE_COLLECTOR_URL:-${TINYAI_OBS_COLLECTOR_URL:-http://10.161.248.133:18080}}"
COLLECTOR_URL="${COLLECTOR_URL%/}"
HEALTH_URL="$COLLECTOR_URL/api/v1/health"
BATCH_URL="$COLLECTOR_URL/api/v1/events/batch"

if ! curl -fsS "$HEALTH_URL" >/tmp/tinyai-claude-health.json; then
  echo "TinyAI Claude smoke test failed: collector health is unreachable: $HEALTH_URL" >&2
  exit 1
fi

PLUGIN_VERSION="$(python3 - <<'PY'
from pathlib import Path
import json

root = Path.home() / ".claude" / "plugins" / "cache" / "tinyai" / "observability"
candidates = []
for manifest in root.glob("*/.claude-plugin/plugin.json"):
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
    except Exception:
        continue
    version = str(data.get("version") or manifest.parent.name)
    runtime = manifest.parent / "runtime" / "dist" / "mcp-server.js"
    if runtime.exists():
        candidates.append((manifest.parent.stat().st_mtime, version))

print(sorted(candidates)[-1][1] if candidates else "")
PY
)"
export TINYAI_OBS_PLUGIN_VERSION="${PLUGIN_VERSION:-unknown}"

python3 - "$TINYAI_ENV" > /tmp/tinyai-claude-smoke.json <<'PY'
import hashlib
import json
import os
import platform
import socket
import sys
import time
from datetime import datetime, timezone

def env(name, default=None):
    value = os.environ.get(name)
    if value is None or value == "":
        return default
    return value

username = env("TINYAI_OBS_CLAUDE_USER_NAME") or env("TINYAI_OBS_USER_NAME") or env("TINYAI_OBS_USERNAME") or "unknown"
user_id = env("TINYAI_OBS_CLAUDE_USER_ID") or env("TINYAI_OBS_USER_ID") or username
display_name = env("TINYAI_OBS_CLAUDE_USER_DISPLAY_NAME") or env("TINYAI_OBS_USER_DISPLAY_NAME") or username
plugin_version = env("TINYAI_OBS_PLUGIN_VERSION", "unknown")
machine = platform.node() or socket.gethostname() or "unknown"
host_hash = hashlib.sha256(machine.encode("utf-8")).hexdigest()[:32]
event_id = hashlib.sha256(f"claude-install-smoke:{machine}:{time.time()}".encode("utf-8")).hexdigest()[:32]
occurred_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
payload = {
    "client_id": f"claude-install-smoke-{host_hash}",
    "plugin_name": "tinyai-observability-claude",
    "plugin_version": plugin_version,
    "username": username,
    "user_id": user_id,
    "user_display_name": display_name,
    "machine_id": machine,
    "host_hash": host_hash,
    "events": [
        {
            "event_id": event_id,
            "task_id": "claude-install-smoke",
            "session_id": None,
            "tool": "claude",
            "event_type": "plugin_heartbeat",
            "occurred_at": occurred_at,
            "source_confidence": "direct",
            "username": username,
            "user_id": user_id,
            "user_display_name": display_name,
            "machine_id": machine,
            "host_hash": host_hash,
            "payload": {
                "smoke_test": True,
                "source": "install-tinyai-observability",
                "env_file": sys.argv[1],
            },
        }
    ],
}
print(json.dumps(payload, ensure_ascii=False))
PY

if [ -n "${TINYAI_OBS_TOKEN:-}" ]; then
  curl -fsS -X POST "$BATCH_URL" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TINYAI_OBS_TOKEN" \
    --data-binary @/tmp/tinyai-claude-smoke.json \
    >/tmp/tinyai-claude-smoke-response.json
else
  curl -fsS -X POST "$BATCH_URL" \
    -H "Content-Type: application/json" \
    --data-binary @/tmp/tinyai-claude-smoke.json \
    >/tmp/tinyai-claude-smoke-response.json
fi

SMOKE_STATUS=$?
if [ "$SMOKE_STATUS" -ne 0 ]; then
  echo "TinyAI Claude smoke test failed: collector rejected heartbeat: $BATCH_URL" >&2
  cat /tmp/tinyai-claude-smoke-response.json 2>/dev/null || true
  exit "$SMOKE_STATUS"
fi

echo "TinyAI Claude smoke test passed: collector accepted plugin_heartbeat."
```

## Update

```bash
claude plugin marketplace update tinyai
claude plugin install observability@tinyai
claude plugin marketplace list
```

## Verify

1. `claude plugin marketplace list` should show the `tinyai` marketplace.
2. The env file should contain both `TINYAI_OBS_USER_NAME` and
   `TINYAI_OBS_CLAUDE_USER_NAME`.
3. The collector smoke test should pass and create a `tool=claude`
   `plugin_heartbeat`.
4. Restart Claude Code or reload the VS Code Claude Code panel.
5. Ask a simple question in Claude Code.
6. Check the TinyAI dashboard for a `tool=claude` session under the confirmed user.

## Notes

- If the Git repository is private, the teammate must have GitHub HTTPS access.
- The plugin default collector is the LAN collector configured in the repo
  runtime defaults. A user-level env file can override it:
  `~/.tinyai-observability/tinyai-observability.env`.
- Installing this Claude plugin does not install the VS Code Copilot extension
  or the Codex plugin; those are separate surfaces.
