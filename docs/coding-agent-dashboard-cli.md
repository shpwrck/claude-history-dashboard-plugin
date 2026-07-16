# Coding Agent Dashboard CLI

`coding-agent-dashboard` is a thin Node launcher for the published server image:

```bash
npx coding-agent-dashboard serve
npx coding-agent-dashboard recs
npx coding-agent-dashboard stop
```

It uses only Node built-ins. The CLI detects a healthy Podman runtime first,
then Docker, and shells out to that runtime rather than reimplementing
container orchestration.

## Commands

```bash
coding-agent-dashboard --help
coding-agent-dashboard --version
coding-agent-dashboard serve [--host 127.0.0.1] [--port 5173] [--image ghcr.io/shpwrck/claude-history-dashboard:latest]
coding-agent-dashboard recs [--url http://127.0.0.1:5173] [--json] [--max-chars 220] [--timeout-ms 15000]
coding-agent-dashboard stop
```

`serve` reconciles one managed container:

- container name: `coding-agent-dashboard`
- image: `ghcr.io/shpwrck/claude-history-dashboard:latest` by default
- host binding: `127.0.0.1:<port>:5173` by default
- data mount: host `~/.claude` to `/home/node/.claude:ro`
- config mount: host `~/.claude.json` to `/home/node/.claude.json:ro` when the file exists
- cache volume: `coding-agent-dashboard-cache` to `/app/.cache`
- env pass-through: `CODING_AGENT_SOURCES` when it is set

For Podman, the launcher also adds `--userns=keep-id` so the read-only
`~/.claude` bind mount remains readable in rootless setups.

`recs` reads the same local `/api/recommendations.json` engine output as the
dashboard Recommendations view and prints the top ranked finding as a compact
terminal/statusline string:

```bash
coding-agent-dashboard recs
# recs critical safety: High-impact actions need review (permissions) -> Review the cited tool calls...
```

The command is local-only: `--url` must point at `localhost`, `127.0.0.1`, or
`::1`, and it never calls `api.anthropic.com`. Use `--json` for shell/statusline
integrations that want structured fields, and `--max-chars` to keep the rendered
line within a fixed prompt width. The default 15s HTTP timeout tolerates cold
local recommendation builds after a dashboard restart; use `--timeout-ms` to set
a bounded 1s-60s timeout for stricter prompt integrations. Source checkouts can
call the same formatter directly:

```bash
npm run recs:statusline
```

`stop` removes only the managed `coding-agent-dashboard` container. It does not
remove the cache volume.

## Scope

The CLI does not migrate or manage legacy `claude-history-dashboard` containers,
volumes, images, compose projects, or plugin-launched instances. It only
reconciles the new `coding-agent-dashboard` container name.

For local source builds, TLS, SPA hosting, or enterprise compose overrides, keep
using the compose files documented in the README.
