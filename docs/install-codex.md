# Install TinyAI Observability For Codex

Use this document when the user asks to install the TinyAI observability Codex
plugin from:

```text
https://github.com/lyl170614239-dotcom/tinyai.git
```

The target branch is:

```text
codex/plugin-marketplace
```

Install only the Codex plugin. Do not install the Claude Code plugin or the VS
Code/Copilot extension unless the user explicitly asks for them too.

## Plugin Identity

- Marketplace name: `tinyai`
- Plugin name: `observability`
- Install name: `observability@tinyai`
- Current version: `0.1.9+codex.20260702115159`
- Plugin path in this branch: `plugins/codex/plugins/observability`
- Root marketplace manifest: `.agents/plugins/marketplace.json`

## Preferred Install Flow

Codex supports Git refs and sparse marketplace checkout. Use the marketplace
manifest and the Codex plugin path only:

```bash
codex plugin marketplace add https://github.com/lyl170614239-dotcom/tinyai.git \
  --ref codex/plugin-marketplace \
  --sparse .agents/plugins \
  --sparse plugins/codex/plugins/observability

codex plugin add observability@tinyai
codex plugin list
```

If the installed Codex CLI does not support `--sparse`, retry without sparse:

```bash
codex plugin marketplace add https://github.com/lyl170614239-dotcom/tinyai.git \
  --ref codex/plugin-marketplace

codex plugin add observability@tinyai
codex plugin list
```

## Identity Config

After installation, write the user's confirmed identity to:

```text
~/.tinyai-observability/tinyai-observability.env
```

Preserve unrelated values. Replace generic user keys and Codex-specific keys:

```env
TINYAI_OBS_USER_NAME=<name>
TINYAI_OBS_USER_DISPLAY_NAME=<name>
TINYAI_OBS_USERNAME=<name>
TINYAI_OBS_USER_ID=<name>
TINYAI_OBS_CODEX_USER_NAME=<name>
TINYAI_OBS_CODEX_USER_DISPLAY_NAME=<name>
TINYAI_OBS_CODEX_USERNAME=<name>
TINYAI_OBS_CODEX_USER_ID=<name>
```

Do not collect or write email fields. If old email keys already exist, remove
them while writing the new identity.

## Clean Legacy Local State

After installing or updating, remove stale Codex TinyAI config that can point to
old plugin cache paths. Keep local queue files; they may contain retryable data.

```bash
python3 - <<'PY'
from pathlib import Path
import json
import re
import shutil

home = Path.home()
env_path = home / ".tinyai-observability" / "tinyai-observability.env"
if env_path.exists():
    lines = [
        line for line in env_path.read_text(encoding="utf-8").splitlines()
        if not re.match(r"^(TINYAI_OBS_USER_EMAIL|TINYAI_OBS_CODEX_USER_EMAIL)=", line)
    ]
    env_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")

config = home / ".codex" / "config.toml"
plugin_root = home / ".codex" / "plugins" / "cache" / "tinyai" / "observability"
current_dir = None
if plugin_root.exists():
    manifests = sorted(plugin_root.glob("*/.codex-plugin/plugin.json"), key=lambda p: p.parent.stat().st_mtime)
    if manifests:
        current_dir = manifests[-1].parent
        for child in plugin_root.iterdir():
            if child.is_dir() and child != current_dir:
                shutil.rmtree(child, ignore_errors=True)

if config.exists() and current_dir:
    runtime = current_dir / "runtime" / "dist" / "mcp-server.js"
    if runtime.exists():
        version = current_dir.name
        try:
            version = json.loads((current_dir / ".codex-plugin" / "plugin.json").read_text(encoding="utf-8")).get("version") or version
        except Exception:
            pass
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
TINYAI_OBS_ENV_FILE = "{env_path}"
TINYAI_OBS_PLUGIN_VERSION = "{version}"
TINYAI_OBS_CAPTURE_CONVERSATION_TEXT = "true"
TINYAI_OBS_AUTO_CAPTURE_CONVERSATION = "true"
{end}'''
        pattern = re.compile(re.escape(begin) + r".*?" + re.escape(end), re.S)
        updated = pattern.sub(block, text) if pattern.search(text) else text.rstrip() + "\n\n" + block + "\n"
        config.write_text(updated, encoding="utf-8")
PY
```

## Verify

Before claiming success:

1. `codex plugin list` shows `observability@tinyai` installed and enabled.
2. The installed version is `0.1.9+codex.20260702115159`.
3. The TinyAI collector health endpoint is reachable.
4. A `plugin_heartbeat` smoke event with `tool=codex` is accepted.

The smoke event proves collector connectivity. Real Codex conversation capture
starts after a fresh Codex session loads the MCP server and uploads a heartbeat
whose payload contains `mcp=true`.

After verification, tell the user to restart Codex or open a new Codex session.

## Legacy MCP Repair

If `codex plugin list` says the plugin is enabled but no Codex data is uploaded,
check `~/.codex/config.toml` for an old hard-coded TinyAI MCP runtime path. It
must point to the latest installed cache under:

```text
~/.codex/plugins/cache/tinyai/observability/<version>/runtime/dist/mcp-server.js
```
