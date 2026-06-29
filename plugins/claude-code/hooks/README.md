# Claude Code Hooks

These hooks are intentionally small. They forward lifecycle signals to the
shared runtime, queue offline uploads, and upload one Claude `turn_snapshot` at
task stop. When Claude used Bash/terminal commands to write files, the hook also
captures a scoped workspace diff for the paths mentioned by that turn.

Set these environment variables in the Claude Code environment:

```text
TINYAI_OBS_COLLECTOR_URL=http://10.161.248.133:18080
TINYAI_OBS_TOKEN=dev-token
TINYAI_OBS_WORKSPACE=/path/to/workspace
```

If `TINYAI_OBS_COLLECTOR_URL` is unset, the packaged hooks default to the shared
LAN collector `http://10.161.248.133:18080`. The dashboard is on port `18081`;
events must be sent to the collector on port `18080`.

Install or refresh this native Claude plugin from the repository root:

```bash
npm run build:plugins
npm run install:claude-plugin
```

The installer registers `observability@tinyai` in Claude's local plugin
registry and enables it in `~/.claude/settings.json` without printing the
settings contents. Restart Claude Code after installation.
