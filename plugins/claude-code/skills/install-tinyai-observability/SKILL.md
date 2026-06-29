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
claude plugin marketplace add https://github.com/lyl170614239-dotcom/tinyai.git --scope user --sparse .claude-plugin plugins/claude-code
claude plugin install observability@tinyai --scope user
claude plugin list
```

If this Claude Code version does not support `--sparse`, retry the marketplace
add without it:

```bash
claude plugin marketplace add https://github.com/lyl170614239-dotcom/tinyai.git --scope user
claude plugin install observability@tinyai --scope user
claude plugin list
```

## Identity setup after install

After `claude plugin list` confirms `observability@tinyai` is enabled, configure
the Claude identity before telling the user installation is complete. Claude and
Codex are separate plugins; use `TINYAI_OBS_CLAUDE_*` keys here, not
`TINYAI_OBS_CODEX_*`.

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
env | grep '^TINYAI_OBS_CLAUDE_USER_' || true
git config --global user.name || true
git config --global user.email || true
```

2. Only ask the user when the request did not provide a clear identity, or when
the detected identity looks unreliable. The prompt should be short:

```text
TinyAI 需要你的姓名用于监控台按人聚合。我检测到：姓名=<git user.name>，邮箱=<git user.email>。是否使用？如果不对，请告诉我正确姓名/邮箱。
```

3. Write the confirmed Claude identity to the TinyAI env file:

```bash
mkdir -p "$HOME/.tinyai-observability"
touch "$HOME/.tinyai-observability/tinyai-observability.env"
grep -v '^TINYAI_OBS_CLAUDE_USER_' "$HOME/.tinyai-observability/tinyai-observability.env" > "$HOME/.tinyai-observability/tinyai-observability.env.tmp" || true
cat >> "$HOME/.tinyai-observability/tinyai-observability.env.tmp" <<'EOF'
TINYAI_OBS_CLAUDE_USER_NAME=<confirmed-name>
TINYAI_OBS_CLAUDE_USER_DISPLAY_NAME=<confirmed-name>
TINYAI_OBS_CLAUDE_USERNAME=<confirmed-name>
TINYAI_OBS_CLAUDE_USER_EMAIL=<confirmed-email>
TINYAI_OBS_CLAUDE_USER_ID=<confirmed-email-or-name>
EOF
mv "$HOME/.tinyai-observability/tinyai-observability.env.tmp" "$HOME/.tinyai-observability/tinyai-observability.env"
```

If the email is unknown, omit `TINYAI_OBS_CLAUDE_USER_EMAIL` and set
`TINYAI_OBS_CLAUDE_USER_ID` to the confirmed name. Do not leave the user as
`user` or `unknown` unless the user explicitly refuses to provide a name.

4. Ask the user to restart Claude Code or reload the VS Code Claude Code panel
so the plugin process reloads the env file.

## Update

```bash
claude plugin marketplace update tinyai
claude plugin update observability@tinyai
claude plugin list
```

## Verify

1. `claude plugin list` should show `observability@tinyai` enabled.
2. The env file should contain `TINYAI_OBS_CLAUDE_USER_NAME`.
3. Restart Claude Code or reload the VS Code Claude Code panel.
4. Ask a simple question in Claude Code.
5. Check the TinyAI dashboard for a `tool=claude` session under the confirmed user.

## Notes

- If the Git repository is private, the teammate must have GitHub HTTPS access.
- The plugin default collector is the LAN collector configured in the repo
  runtime defaults. A user-level env file can override it:
  `~/.tinyai-observability/tinyai-observability.env`.
- Installing this Claude plugin does not install the VS Code Copilot extension
  or the Codex plugin; those are separate surfaces.
