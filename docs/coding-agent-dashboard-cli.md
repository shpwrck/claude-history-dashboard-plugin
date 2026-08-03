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
- image: `ghcr.io/shpwrck/claude-history-dashboard:latest@sha256:...` by
  default — the readable tag is kept but pinned to an **immutable digest** so a
  mutable `latest` tag cannot be swapped for a malicious image. Override with
  `--image` / `CODING_AGENT_DASHBOARD_IMAGE`.
- host binding: `127.0.0.1:<port>:5173` by default
- data mounts: an **allowlisted, credential-free projection** of `~/.claude` —
  each history/config subpath the dashboard reads (`projects/`, `history.jsonl`,
  `history.d/`, `usage-data/`, `settings.json`, `CLAUDE.md`, `skills/`,
  `agents/`, `commands/`, `plugins/`, and the server-only artifact dirs) is
  bind-mounted individually to `/home/node/.claude/<name>:ro` when it exists.
  The whole `~/.claude` directory is **never** mounted.
- credentials: `~/.claude/.credentials.json` (the OAuth subscription token) is
  never mounted, and is additionally hard-masked with an empty `/dev/null`
  source as defense in depth. `~/.claude.json` is **not** mounted at all.
- cache volume: `coding-agent-dashboard-cache` to `/app/.cache`
- egress: the container runs on a dedicated **internal (no-egress) network**
  (`coding-agent-dashboard-noegress`, created on first `serve`), so a compromised
  image cannot exfiltrate anything it reads; the published inbound port still
  works. Image pulls happen host-side and are unaffected. `stop` tears the
  network down.
- env pass-through: `CODING_AGENT_SOURCES` when it is set

For Podman, the launcher also adds `--userns=keep-id` so the read-only
allowlisted bind mounts remain readable in rootless setups.

### Security posture and intentional degradations (issue #3344, ADR 0008)

Because the launcher runs the *published* image against your live local state,
it treats that image as untrusted: digest-pinned, credential-free, and
egress-denied. The trade-off is that a few features which needed either a secret
or `~/.claude.json` degrade gracefully instead of exposing data:

- The `/api/usage` plan-limit gauge shows "log in to Claude Code" (it needs
  `~/.claude/.credentials.json`, which is intentionally withheld).
- MCP-server attribution and config-drift (`~/.claude.json` and its `backups/`
  snapshots, which can carry MCP secrets) are omitted.

Everything on the local free path — history/session/token/cost/tool analysis,
recommendations, config hygiene — reads only the allowlisted projection and is
unaffected. Because the local path makes zero external calls, the no-egress
network causes no functional loss.

To grant a withheld capability, mount the specific subpath yourself with a
source-built compose file (see the README); the launcher's default stays locked
down.

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
