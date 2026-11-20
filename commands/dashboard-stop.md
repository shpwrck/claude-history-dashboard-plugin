---
allowed-tools: Bash(node $CLAUDE_PLUGIN_ROOT/scripts/plugin-ctl.mjs stop:*)
description: Stop the Claude History Dashboard server started by /dashboard
---

## Your task

Stop the dashboard server that `/dashboard` started, then tell the user the
result in one line.

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/plugin-ctl.mjs" stop
```

The supervisor is idempotent and cross-platform. It signals only the process
recorded in its own state file under `~/.claude/.cache/chd/` (or
`$CHD_CACHE_DIR`), after checking that process still matches the server it
started. If nothing is running it prints `stopped (no pid file)` and exits
cleanly. Relay the printed line to the user; run `/dashboard` to start it again.
