---
name: install-tinyai-observability
description: Install, update, or verify the TinyAI Observability Codex plugin from the TinyAI Git marketplace repository. Use when the user provides the TinyAI Git URL, asks to install TinyAI observability in Codex, update the Codex plugin, check whether observability@tinyai is enabled, or make Codex telemetry upload to the TinyAI collector.
---

# Install TinyAI Observability for Codex

Use this skill when the user wants Codex to install or maintain the TinyAI
Observability plugin from Git.

Default Git marketplace:

```text
https://github.com/lyl170614239-dotcom/tinyai.git
```

Default branch:

```text
codex/plugin-marketplace
```

## First install

Run these commands:

```bash
codex plugin marketplace add https://github.com/lyl170614239-dotcom/tinyai.git --ref codex/plugin-marketplace --sparse .agents/plugins --sparse plugins/codex/plugins/observability
codex plugin add observability@tinyai
codex plugin list
```

Then repair any legacy TinyAI MCP block in `~/.codex/config.toml`. Older local
installs may keep a hard-coded runtime path even after `codex plugin add`
upgrades the marketplace plugin. If the hard-coded path points to a removed
cache directory, Codex will show the plugin as enabled but the MCP process will
not start, so no Codex session data is uploaded.

```bash
python3 - <<'PY'
from pathlib import Path
import json
import re

home = Path.home()
config = home / ".codex" / "config.toml"
plugin_root = home / ".codex" / "plugins" / "cache" / "tinyai" / "observability"
if not config.exists() or not plugin_root.exists():
    raise SystemExit(0)

candidates = []
for manifest in plugin_root.glob("*/.codex-plugin/plugin.json"):
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
text = config.read_text(encoding="utf-8")

begin = "# BEGIN TinyAI Codex Observability MCP"
end = "# END TinyAI Codex Observability MCP"
block = f'''{begin}
[mcp_servers.tinyai_observability]
type = "stdio"
command = "node"
args = ["{runtime}"]
startup_timeout_sec = 60

[mcp_servers.tinyai_observability.env]
TINYAI_OBS_TOOL = "codex"
TINYAI_OBS_ENV_FILE = "{home / ".tinyai-observability" / "tinyai-observability.env"}"
TINYAI_OBS_PLUGIN_VERSION = "{version}"
TINYAI_OBS_CAPTURE_CONVERSATION_TEXT = "true"
TINYAI_OBS_AUTO_CAPTURE_CONVERSATION = "true"
{end}'''

pattern = re.compile(re.escape(begin) + r".*?" + re.escape(end), re.S)
if pattern.search(text):
    updated = pattern.sub(block, text)
else:
    updated = text.rstrip() + "\n\n" + block + "\n"

if updated != text:
    config.write_text(updated, encoding="utf-8")
    print(f"TinyAI Codex MCP config repaired: {version}")
else:
    print(f"TinyAI Codex MCP config already current: {version}")
PY
```

If this Codex version does not support `--sparse`, retry the marketplace add
without it:

```bash
codex plugin marketplace add https://github.com/lyl170614239-dotcom/tinyai.git --ref codex/plugin-marketplace
codex plugin add observability@tinyai
codex plugin list
```

## Identity setup after install

After `codex plugin list` confirms `observability@tinyai` is enabled, configure
the identity before telling the user installation is complete. Write both the
generic TinyAI identity and the Codex-specific identity. Codex and Claude are
separate plugins; use `TINYAI_OBS_CODEX_*` keys here, not
`TINYAI_OBS_CLAUDE_*`.

1. Before asking anything, inspect the user's original install request. If the
request already contains a clear name and/or email, treat that identity as
confirmed and use it directly. Common examples:

```text
我的姓名是张三，邮箱是 zhangsan@example.com
姓名=张三 邮箱=zhangsan@example.com
name=Zhang San email=zhangsan@example.com
```

If the request contains a clear name but no email, use the name and only ask
whether an email should be added. If the identity is missing or ambiguous, read
existing values:

```bash
env | grep '^TINYAI_OBS_USER_' || true
env | grep '^TINYAI_OBS_CODEX_USER_' || true
git config --global user.name || true
git config --global user.email || true
```

2. Only ask the user when the request did not provide a clear identity, or when
the detected identity looks unreliable. The prompt should be short:

```text
TinyAI 需要你的姓名用于监控台按人聚合。我检测到：姓名=<git user.name>，邮箱=<git user.email>。是否使用？如果不对，请告诉我正确姓名/邮箱。
```

3. Write the confirmed identity to the TinyAI env file. Keep unrelated env
values, but replace old generic user identity and old Codex identity values:

```bash
mkdir -p "$HOME/.tinyai-observability"
TINYAI_ENV="$HOME/.tinyai-observability/tinyai-observability.env"
touch "$TINYAI_ENV"
grep -v -E '^(TINYAI_OBS_USER_|TINYAI_OBS_USERNAME=|TINYAI_OBS_CODEX_USER_|TINYAI_OBS_CODEX_USERNAME=)' "$TINYAI_ENV" > "$TINYAI_ENV.tmp" || true
cat >> "$TINYAI_ENV.tmp" <<'EOF'
TINYAI_OBS_USER_NAME="<confirmed-name>"
TINYAI_OBS_USER_DISPLAY_NAME="<confirmed-name>"
TINYAI_OBS_USERNAME="<confirmed-name>"
TINYAI_OBS_USER_EMAIL="<confirmed-email>"
TINYAI_OBS_USER_ID="<confirmed-email-or-name>"
TINYAI_OBS_CODEX_USER_NAME="<confirmed-name>"
TINYAI_OBS_CODEX_USER_DISPLAY_NAME="<confirmed-name>"
TINYAI_OBS_CODEX_USERNAME="<confirmed-name>"
TINYAI_OBS_CODEX_USER_EMAIL="<confirmed-email>"
TINYAI_OBS_CODEX_USER_ID="<confirmed-email-or-name>"
EOF
mv "$TINYAI_ENV.tmp" "$TINYAI_ENV"
```

If the email is unknown, omit both `TINYAI_OBS_USER_EMAIL` and
`TINYAI_OBS_CODEX_USER_EMAIL`, then set both `TINYAI_OBS_USER_ID` and
`TINYAI_OBS_CODEX_USER_ID` to the confirmed name. Do not leave the user as
`user` or `unknown` unless the user explicitly refuses to provide a name.

4. Run the collector smoke test below. Do not claim collector connectivity
succeeded if the smoke test fails.

5. Ask the user to restart Codex or open a new Codex session so the plugin MCP
process reloads the env file. The smoke test only proves that the collector can
accept data; it does not prove that Codex has loaded the MCP server. Real
conversation capture starts only after a fresh Codex session initializes the
MCP server and uploads a `plugin_heartbeat` whose payload contains `"mcp": true`.

## Collector smoke test after install

Run this smoke test after writing identity and before telling the user to
restart Codex. It verifies collector reachability and TinyAI ingest acceptance
by posting one `plugin_heartbeat` event.

This is an install smoke heartbeat, not a real MCP heartbeat. It must include
`install_smoke: true` and `mcp: false` so the dashboard and DB can distinguish
it from a fresh Codex session that has actually loaded the plugin MCP server.

```bash
TINYAI_ENV="$HOME/.tinyai-observability/tinyai-observability.env"
set -a
. "$TINYAI_ENV"
set +a

COLLECTOR_URL="${TINYAI_OBS_CODEX_COLLECTOR_URL:-${TINYAI_OBS_COLLECTOR_URL:-http://10.161.248.133:18080}}"
COLLECTOR_URL="${COLLECTOR_URL%/}"
HEALTH_URL="$COLLECTOR_URL/api/v1/health"
BATCH_URL="$COLLECTOR_URL/api/v1/events/batch"

if ! curl -fsS "$HEALTH_URL" >/tmp/tinyai-codex-health.json; then
  echo "TinyAI Codex smoke test failed: collector health is unreachable: $HEALTH_URL" >&2
  exit 1
fi

PLUGIN_VERSION="${TINYAI_OBS_PLUGIN_VERSION:-}"
if [ -z "$PLUGIN_VERSION" ]; then
  PLUGIN_VERSION="$(python3 - <<'PY'
from pathlib import Path
import json

root = Path.home() / ".codex" / "plugins" / "cache" / "tinyai" / "observability"
candidates = []
for manifest in root.glob("*/.codex-plugin/plugin.json"):
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
fi
export TINYAI_OBS_PLUGIN_VERSION="${PLUGIN_VERSION:-unknown}"

python3 - "$TINYAI_ENV" > /tmp/tinyai-codex-smoke.json <<'PY'
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

username = env("TINYAI_OBS_CODEX_USER_NAME") or env("TINYAI_OBS_USER_NAME") or env("TINYAI_OBS_USERNAME") or "unknown"
email = env("TINYAI_OBS_CODEX_USER_EMAIL") or env("TINYAI_OBS_USER_EMAIL")
user_id = env("TINYAI_OBS_CODEX_USER_ID") or env("TINYAI_OBS_USER_ID") or email or username
display_name = env("TINYAI_OBS_CODEX_USER_DISPLAY_NAME") or env("TINYAI_OBS_USER_DISPLAY_NAME") or username
plugin_version = env("TINYAI_OBS_PLUGIN_VERSION", "unknown")
machine = platform.node() or socket.gethostname() or "unknown"
host_hash = hashlib.sha256(machine.encode("utf-8")).hexdigest()[:32]
event_id = hashlib.sha256(f"codex-install-smoke:{machine}:{time.time()}".encode("utf-8")).hexdigest()[:32]
occurred_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
payload = {
    "client_id": f"codex-install-smoke-{host_hash}",
    "plugin_name": "tinyai-observability-codex",
    "plugin_version": plugin_version,
    "username": username,
    "user_id": user_id,
    "user_email": email,
    "user_display_name": display_name,
    "machine_id": machine,
    "host_hash": host_hash,
    "events": [
        {
            "event_id": event_id,
            "task_id": "codex-install-smoke",
            "session_id": None,
            "tool": "codex",
            "event_type": "plugin_heartbeat",
            "occurred_at": occurred_at,
            "source_confidence": "direct",
            "username": username,
            "user_id": user_id,
            "user_email": email,
            "user_display_name": display_name,
            "machine_id": machine,
            "host_hash": host_hash,
            "payload": {
                "smoke_test": True,
                "install_smoke": True,
                "mcp": False,
                "source": "install-tinyai-observability",
                "env_file": sys.argv[1],
                "expected_runtime_plugin_version": plugin_version,
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
    --data-binary @/tmp/tinyai-codex-smoke.json \
    >/tmp/tinyai-codex-smoke-response.json
else
  curl -fsS -X POST "$BATCH_URL" \
    -H "Content-Type: application/json" \
    --data-binary @/tmp/tinyai-codex-smoke.json \
    >/tmp/tinyai-codex-smoke-response.json
fi

SMOKE_STATUS=$?
if [ "$SMOKE_STATUS" -ne 0 ]; then
  echo "TinyAI Codex smoke test failed: collector rejected heartbeat: $BATCH_URL" >&2
  cat /tmp/tinyai-codex-smoke-response.json 2>/dev/null || true
  exit "$SMOKE_STATUS"
fi

echo "TinyAI Codex collector smoke test passed: collector accepted install_smoke plugin_heartbeat."
echo "Restart Codex or open a new Codex session, then verify a real MCP heartbeat with payload.mcp=true and a codex turn_snapshot."
```

## Update

```bash
codex plugin marketplace upgrade tinyai
codex plugin add observability@tinyai
codex plugin list
```

## Verify

1. `codex plugin list` should show `observability@tinyai` enabled.
2. The env file should contain both `TINYAI_OBS_USER_NAME` and
   `TINYAI_OBS_CODEX_USER_NAME`.
3. The collector smoke test should pass and create a `tool=codex`
   `plugin_heartbeat` with `payload.install_smoke=true` and `payload.mcp=false`.
   This smoke heartbeat only proves collector reachability and should not be
   treated as real conversation telemetry.
4. Restart Codex or open a new Codex session.
5. Ask a simple question in Codex.
6. Check TinyAI for a real `tool=codex` heartbeat whose payload contains
   `mcp=true`. If only install-smoke heartbeats exist, Codex has not loaded the
   MCP server yet and no conversation data can be captured.
7. Check the TinyAI dashboard for a real `tool=codex` session under the
   confirmed user. The real MCP heartbeat and session data should use the
   installed plugin version, not `install-smoke`.

## Notes

- If the Git repository is private, the teammate must have GitHub HTTPS access.
- The plugin default collector is the LAN collector configured in the repo
  runtime defaults. A user-level env file can override it:
  `~/.tinyai-observability/tinyai-observability.env`.
- Installing this Codex plugin does not install the VS Code Copilot extension
  or the Claude Code plugin; those are separate surfaces.
