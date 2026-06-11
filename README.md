# Claude History Dashboard — plugin bundle

This repository is the **published, installable bundle** of the Claude History
Dashboard Claude Code plugin: a local, browsable view of your `~/.claude` session
history — sessions, costs, tool usage, and recommendations — served at
`http://localhost:5173`.

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

It boots a local server on **http://localhost:5173** and prints the URL — open it
in your browser. To stop it: `node <plugin-dir>/scripts/plugin-ctl.mjs stop`.

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

The bundle declares an MCP server (`.mcp.json`) exposing `dashboard_status`,
`get_recommendations`, and `top_frictions`, so a Claude Code agent can query the
running dashboard. Start the dashboard first.
