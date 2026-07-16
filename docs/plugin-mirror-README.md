# Claude History Dashboard — plugin bundle

This repository is the **published, installable bundle** of the Claude History
Dashboard Claude Code plugin: a local, browsable view of your `~/.claude` session
history — sessions, costs, tool usage, and recommendations — served on a local
loopback URL (`http://127.0.0.1:5173` by default).

> **Auto-generated — do not edit here.** The `gh-pages` branch is overwritten on
> every push to the source project's `master`. This bundle is built and published
> by CI.

## Install (Claude Code)

```
/plugin marketplace add shpwrck/claude-history-dashboard-plugin
/plugin install claude-history-dashboard@claude-history-dashboard
```

## Run

In any Claude Code session:

```
/dashboard
```

It boots a local server and prints the exact URL to open. Port 5173 is preferred;
if it is occupied, the supervisor selects a free port and the MCP tools follow
the running instance. To stop it today, run
`node <plugin-dir>/scripts/plugin-ctl.mjs stop`; a dedicated `/dashboard-stop`
command is tracked in [source issue #2563](https://github.com/shpwrck/claude-history-dashboard/issues/2563).

## Requirements

- **Claude Code**
- **Node.js >= 24** — the server runs TypeScript via native type-stripping and
  uses `node:sqlite`. The launcher checks this and errors clearly on older Node.

No Docker, no clone, no systemd. Works on Windows, macOS, and Linux.

## Local-only — your data stays yours

The dashboard reads **your own** `~/.claude` history on the machine where you run
it, and binds to `127.0.0.1` only. Installing this plugin shares the *tool*, not
anyone's session data.

## Run without Claude Code

```
git clone -b gh-pages https://github.com/shpwrck/claude-history-dashboard-plugin
cd claude-history-dashboard-plugin
node scripts/plugin-ctl.mjs start   # prints the URL; stop with the same script: ... stop
```

## Agent tools (MCP)

The plugin manifest declares a self-contained MCP server exposing
`dashboard_status`, `get_recommendations`, `top_frictions`, and
`doc_neighborhood`. No separate `npm install` is needed. The first three tools
query the running dashboard; `doc_neighborhood` computes locally from the target
repository and does not require the dashboard server.
