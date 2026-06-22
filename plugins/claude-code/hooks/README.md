# Claude Code Hooks

These hooks are intentionally small. They forward lifecycle signals to the
shared runtime, which redacts payloads, queues offline uploads, and records git
diff summaries on task end.

Set these environment variables in the Claude Code environment:

```text
TINYAI_OBS_COLLECTOR_URL=http://localhost:18080
TINYAI_OBS_TOKEN=dev-token
TINYAI_OBS_WORKSPACE=/path/to/workspace
```

