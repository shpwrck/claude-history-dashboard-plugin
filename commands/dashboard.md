---
allowed-tools: Bash(node $CLAUDE_PLUGIN_ROOT/scripts/plugin-ctl.mjs start:*), Bash(node $CLAUDE_PLUGIN_ROOT/scripts/plugin-ctl.mjs stop:*), Bash(node $CLAUDE_PLUGIN_ROOT/scripts/plugin-ctl.mjs status:*)
description: Start, stop, or check the Claude History Dashboard server
---

## Your task

Start the Claude History Dashboard server (if it is not already running) and tell
the user where to open it.

The dashboard reads live from `~/.claude` on every request; no rebuild is needed
for new sessions to appear after the server is running.

### Start (or confirm already running)

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/plugin-ctl.mjs" start
```

The supervisor is idempotent: if the server is already running it prints the
existing URL and exits cleanly. If it was not running it boots a detached server
process that outlives this shell, writes the PID and port to
`~/.claude/.cache/chd/` (or `$CHD_CACHE_DIR` if set), and prints the URL.

Optional env vars forwarded to the server:
- `HOST` (default `127.0.0.1`) -- bind address
- `PORT` (default `5173`, auto-incremented if taken)
- `CHD_CACHE_DIR` (default `~/.claude/.cache/chd/`) -- where state files + logs land

### Check status

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/plugin-ctl.mjs" status
```

### Stop

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/plugin-ctl.mjs" stop
```

### Then

Tell the user the URL printed by `start` (e.g. `http://127.0.0.1:5173`) and ask
them to open it in their browser. Mention the in-app "Reload from disk" button to
pick up new sessions without restarting.
