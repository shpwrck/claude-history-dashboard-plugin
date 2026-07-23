# Spike: can the dashboard trigger a fresh `/insights` run?

**Issue:** #265 · **Verdict: ✓ FEASIBLE** · Investigated 2026-05-31

> **Superseded (2026-07-22):** the product decision to *keep* an Insights view was
> reversed — [`insights-removal.md`](./insights-removal.md) (#1056) removed the
> Insights surface. This spike's "feasible to trigger `/insights`" finding remains
> technically accurate as a 2026-05-31 point-in-time record, but the dashboard no
> longer ships the view it was scoping. See `insights-removal.md` for the current
> stance.

## TL;DR

`claude -p "/insights"` (the headless/print CLI, avenue 1) **dispatches the
genuine `/insights` skill non-interactively and writes fresh
`~/.claude/usage-data/` artifacts**. This was not reasoned about — it was run,
and it produced a brand-new report. The success condition in the issue
("produce a working invocation that writes fresh `usage-data/` artifacts") is
met, so the heavier avenues (binary reverse-engineering) were not needed.

This flips the decision on #264: **keep the Insights view and make it
self-refreshing**; do not retire it.

## The working invocation (reproducible)

```sh
# Run from any cwd on the HOST (uses the logged-in Claude subscription auth).
claude -p "/insights" --output-format stream-json --verbose
```

Observed result event:

```
result/success  is_error=false
"Your shareable insights report is ready:
 file:///home/jskrzypek/.claude/usage-data/report-2026-05-31-091526.html"
```

### Evidence it wrote the real artifacts `parse-insights.ts` consumes

`src/lib/parse-insights.ts` reads three artifact kinds under
`~/.claude/usage-data/`: `report.html`, `session-meta/<id>.json`,
`facets/<id>.json`. All three were freshly written by the run:

| Artifact | Before | After |
| --- | --- | --- |
| `report.html` (md5) | `27556a71…` | `17a55263…` (regenerated) |
| dated report | — | `report-2026-05-31-091526.html` created |
| `facets/` count | 51 | 77 |
| `session-meta/` count | 118 | 207 |

It is the genuine skill (not a reimplementation/mimic — the CLAUDE.md
guardrail): the `init` event lists `"insights"` in both `slash_commands` and
`skills`, and the skill ran as its own async hook (`SessionStart` returned
`{"async": true, "asyncTimeout": 180000}`) doing per-session facet extraction.

## Avenue-by-avenue

| # | Avenue | Result |
| --- | --- | --- |
| 1 | **Headless CLI** (`claude -p "/insights"`) | ✓ **Works.** Dispatches the skill, writes fresh `usage-data/`. This is the answer. |
| 4 | **Direct skill trigger** | ✓ Confirmed via avenue 1: `/insights` is a registered slash command in `--print` mode (no separate `claude skill run` subcommand exists; `claude --help` shows no `skill` command). The `-p "/insights"` slash-command *is* the non-interactive trigger. |
| 2 | **Programmatic / SDK** | ✓ By extension. The Agent SDK (`~/.claude/security/agent-sdk-venv/.../claude_agent_sdk`) wraps the same bundled `claude` binary; sending `"/insights"` as the prompt drives the identical code path as avenue 1. Not separately needed once the CLI path works. |
| 3 | **Binary entry-point RE** | ✗ **Not pursued — unnecessary.** The mandate accepts "a working invocation" as a terminating success; avenue 1 produced one, so reverse-engineering the ~238 MB binary to *find* the dispatch path is moot. |
| 5 | **Auth + container reality** | Caveat: **Host-only as-is.** The run authenticated via the logged-in subscription (a `rate_limit_event` with a `five_hour` window fired; `apiKeySource: "none"`). The dashboard itself runs in a podman container (node/vite) that bind-mounts `~/.claude` but does **not** contain the `claude` CLI binary. So the trigger must run on the **host**, not inside the container. See "Follow-up design constraint" below. |
| 6 | **Cost & latency** | Measured on this ~207-session dataset: **`total_cost_usd` ≈ $1.69**, **wall-clock ≈ 64 s** (`duration_ms` 63 811), API time ≈ 342 s (parallel facet extraction). Acceptable for a button-triggered, run-locked refresh. |

## Follow-up design constraint (for the "Regenerate insights" feature)

The working invocation is **host-side** and needs the user's logged-in auth +
the `claude` binary — neither is present inside the dashboard's container. So an
in-app "Regenerate insights" button cannot simply shell out from the
containerized `scripts/server.mjs`. The follow-up feature must bridge
container → host, e.g. one of:

- a tiny host-side helper/watcher that runs `claude -p "/insights"` when the
  button drops a request (file/socket/named pipe on the bind-mounted volume);
- running `server.mjs` (or just the trigger endpoint) on the host rather than in
  the container;
- a host cron that the button schedules.

Whichever bridge is chosen, the feature should add **run-locking** (one run at a
time; `/insights` takes ~1 min and ~$1.69) and a **"last generated"** indicator
(the dated `report-YYYY-MM-DD-HHMMSS.html` filename already provides the
timestamp).

## Recommendations

1. **Close #264** (retire the Insights view) as **won't-do** — the data *can*
   be refreshed, so the view stays.
2. **Build the in-app "Regenerate insights" feature** — filed as a follow-up
   (see the issue linked from #265), incorporating the host-bridge + run-lock +
   last-generated notes above.

## Note on side effects

This spike triggered a **real** `/insights` run, which regenerated the user's
`report.html` (now dated 2026-05-31, newer than the prior 2026-05-29) and added
facets/session-meta. This is a genuine, newer report — an improvement, not
corruption. A pre-run backup was taken to `/tmp/usage-data-backup-*` in case
rollback was ever needed.
