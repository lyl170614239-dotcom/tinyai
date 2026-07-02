# Install TinyAI Observability For Claude Code

Use this document when the user asks to install the TinyAI observability Claude
Code plugin from:

```text
https://github.com/lyl170614239-dotcom/tinyai.git
```

The target branch is:

```text
codex/plugin-marketplace
```

Install only the Claude Code plugin. Do not install the Codex plugin or the VS
Code/Copilot extension unless the user explicitly asks for them too.

## Plugin Identity

- Marketplace name: `tinyai`
- Plugin name: `observability`
- Install name: `observability@tinyai`
- Current version: `0.1.16`
- Plugin path in this branch: `plugins/claude-code`
- Root marketplace manifest: `.claude-plugin/marketplace.json`

## Preferred Install Flow

Claude Code marketplace Git support may not expose a branch option in all
versions. If the user asks for this branch, use a temporary shallow clone of the
branch, then add that local checkout as the marketplace.

```bash
rm -rf /tmp/tinyai-observability-plugins
git clone --depth 1 --branch codex/plugin-marketplace \
  https://github.com/lyl170614239-dotcom/tinyai.git \
  /tmp/tinyai-observability-plugins

claude plugin validate /tmp/tinyai-observability-plugins/.claude-plugin/marketplace.json
claude plugin validate /tmp/tinyai-observability-plugins/plugins/claude-code/.claude-plugin/plugin.json
claude plugin marketplace add /tmp/tinyai-observability-plugins
claude plugin marketplace update tinyai
claude plugin install observability@tinyai
claude plugin list
```

If `tinyai` already exists and points to an old source, refresh it:

```bash
claude plugin marketplace remove tinyai
claude plugin marketplace add /tmp/tinyai-observability-plugins
claude plugin marketplace update tinyai
claude plugin install observability@tinyai
claude plugin list
```

## Identity Config

After installation, write the user's confirmed identity to:

```text
~/.tinyai-observability/tinyai-observability.env
```

Preserve unrelated values. Replace generic user keys and Claude-specific keys:

```env
TINYAI_OBS_USER_NAME=<name>
TINYAI_OBS_USER_DISPLAY_NAME=<name>
TINYAI_OBS_USERNAME=<name>
TINYAI_OBS_USER_ID=<name>
TINYAI_OBS_CLAUDE_USER_NAME=<name>
TINYAI_OBS_CLAUDE_USER_DISPLAY_NAME=<name>
TINYAI_OBS_CLAUDE_USERNAME=<name>
TINYAI_OBS_CLAUDE_USER_ID=<name>
```

Do not collect or write email fields. If old email keys already exist, remove
them while writing the new identity.

## Clean Legacy Local State

After installing or updating, remove stale Claude TinyAI marketplace/cache state
that can keep an old runtime active. Keep local queue files; they may contain
retryable data.

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
        if not re.match(r"^(TINYAI_OBS_USER_EMAIL|TINYAI_OBS_CLAUDE_USER_EMAIL)=", line)
    ]
    env_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")

plugin_root = home / ".claude" / "plugins" / "cache" / "tinyai" / "observability"
current_dir = None
if plugin_root.exists():
    manifests = sorted(plugin_root.glob("*/.claude-plugin/plugin.json"), key=lambda p: p.parent.stat().st_mtime)
    if manifests:
        current_dir = manifests[-1].parent
        for child in plugin_root.iterdir():
            if child.is_dir() and child != current_dir:
                shutil.rmtree(child, ignore_errors=True)

installed = home / ".claude" / "plugins" / "installed_plugins.json"
if installed.exists() and current_dir:
    try:
        data = json.loads(installed.read_text(encoding="utf-8"))
    except Exception:
        data = None
    if isinstance(data, list):
        for item in data:
            if isinstance(item, dict) and item.get("name") == "observability" and item.get("marketplace") == "tinyai":
                item["path"] = str(current_dir)
                item["version"] = current_dir.name
        installed.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
PY
```

## Verify

Before claiming success:

1. `claude plugin validate` passes for the marketplace and plugin manifest.
2. `claude plugin list` shows `observability@tinyai` installed and enabled.
3. The installed version is `0.1.16`.
4. The TinyAI collector health endpoint is reachable.
5. A `plugin_heartbeat` smoke event with `tool=claude` is accepted.

After verification, tell the user to restart Claude Code or reload the VS Code
Claude Code window.

## Installed Cache Path

After install, Claude Code should run the plugin from a cache path like:

```text
~/.claude/plugins/cache/tinyai/observability/0.1.16/runtime/dist/mcp-server.js
```

If old development processes are running from a repository path such as
`plugins/claude-code/runtime/dist/mcp-server.js`, ask the user to restart Claude
Code so only the installed plugin cache is used.
