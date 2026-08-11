# `/doctor` and `/recs`: two layers

> `/doctor` = a point-in-time Claude Code maintenance pass with confirmed
> edits; `/recs` = longitudinal, cross-harness coaching with auditable,
> recommend-only claims.

They answer different questions and work best together:

| Surface | Question | Evidence | Action posture |
| --- | --- | --- | --- |
| Claude Code `/doctor` | What should I fix in this Claude Code installation and its loaded configuration now? | Local settings, configuration, usage counters, loaded `CLAUDE.md` files, and a bounded cross-project transcript scan, plus selected live install/version checks | Proposes changes, asks for confirmation, and can apply them |
| Dashboard `/recs` | Which recurring patterns in retained work merit an auditable recommendation? | Longitudinal local `~/.claude` artifacts and opt-in `~/.codex` artifacts | Makes reproducible recommendations with evidence receipts; never applies them |

Run `/doctor` after an install or update, or when authentication, networking,
or editor integration is failing. Run `/recs` regularly to improve cost,
context use, workflow, reliability, and speed based on recorded work.

## Point-in-time comparison

An August 11, 2026 audit compared Claude Code `/doctor` v2.1.227 (which retains
the expanded surface introduced in v2.1.220) with the dashboard's catalog of 106
registered detectors. The comparison counted overlap only when the two surfaces
addressed substantially the same user concern or remediation; reading the same
artifact was not enough. On that basis, 11 detectors (about 10%) overlap:

- setup and updates: `reliability.settings-json-invalid` and
  `reliability.self-update-health`;
- unused or context-heavy extensions: `cost.idle-mcp-tools`,
  `context.mcp-schema-tax`, `safety.config-hygiene-rollup`,
  `workflow.unused-installed-skills`, and
  `workflow.unused-installed-plugins`;
- always-loaded guidance and hooks: `context.bloated-claude-md`,
  `context.over-scoped-config-section`, and `speed.hook-overhead`; and
- permission friction: `safety.prompt-friction`.

This is not a count of shared inputs. For example,
`context.reclaim-potential` analyzes repeated tool output and re-pasted context,
while `/doctor` restricts transcript use to specific counts and aggregates;
`reliability.config-drift` reconstructs configuration history from backups; and
`safety.allow-rule-overlaps-deny` diagnoses shadowed rules that `/doctor` merely
respects while proposing other changes. `maintenance.skill-hook-integrity`
finds missing file references, which is different from `/doctor`'s slow-hook
timing check. None addresses the same concern or remediation, so none is in the
overlap count.

These figures describe that dated snapshot, not an ongoing compatibility
promise. Re-run the comparison before quoting them as current.

## Ownership boundary

The recommendations engine must not reimplement `/doctor`'s live host probes or
self-fix surface. That surface includes:

- network and TLS reachability, proxy configuration, TLS interception, and
  `NODE_EXTRA_CA_CERTS`;
- keychain access and the primary Anthropic credential;
- multiple Claude Code installations, leftover global npm installations, and
  npm-prefix write permission; and
- search-backend availability, Remote Control entitlement, IDE integration,
  and run-method detection.

`/doctor` owns the live runtime authority and the path that changes the
installation. Artifact access alone no longer separates the products: current
`/doctor` scans roughly 50 recently modified transcript files across all Claude
Code projects, along with settings, extension usage counters, hook records, and
loaded `CLAUDE.md` files.

The durable boundary is what happens around that evidence:

- `/doctor` takes a bounded point-in-time snapshot, keeps no memory between
  runs, and can apply changes after confirmation. Its report does not provide
  durable per-finding receipts or decay old claims.
- `/recs` reasons across retained history, covers Claude and opt-in Codex data,
  and keeps every finding recommend-only. Detector claims must expose
  reproducible evidence and provenance, and stale signals must decay or be
  dated.
- `/doctor` estimates resident context size, but it does not analyze observed
  model selection, token usage, or dollar cost. `/recs` covers those measured
  usage and cost dimensions.

A proposed detector on the live-probe or self-fix surface is still presumed
redundant and needs an explicit product justification before implementation.

Any approved exception must be opt-in behind an explicit environment flag and
off by default. With the flag unset, the default deployment path must remain
byte-identical and make zero external calls, as required by the
[local-first rule](../AGENTS.md#local-first-by-default-non-local-data-is-opt-in).
The gate is necessary, not sufficient: it does not by itself justify duplicating
`/doctor`.

## Recommended-posture stance

`/doctor` v2.1.227 (with this behaviour already present in v2.1.220) actively
recommends permissive posture: check 8 writes `permissions.defaultMode: auto`
and check 9 mints transcript-mined `permissions.allow` rules. Per
[ADR 0021](./adr/0021-doctor-recommended-posture-safety-stance.md) (#3408),
the safety category **differentiates and reconciles** rather than conceding or
re-alarming: posture at or below that `/doctor` baseline is not alarm-grade on
posture alone — findings must cite observed behaviour (what ran unattended,
what each rule admitted; #3596) — and where a change is provably
`/doctor`-authored, the finding is framed as a follow-up on a known change,
not an alarm (#3597). Posture beyond the baseline (e.g. `bypassPermissions`,
write-capable allow rules) remains alarm-grade.

## Deliberate seam enhancements

The boundary still permits recommendations to make better use of already-local
artifacts without probing or repairing the host:

- [#2421](https://github.com/shpwrck/claude-history-dashboard/issues/2421)
  added per-finding manual suggestions for parsed `settings.json` health
  findings. It consumes already-observed settings health and neither launches
  a host probe nor applies a repair.
- [#2422](https://github.com/shpwrck/claude-history-dashboard/issues/2422)
  tracks work to accumulate timestamped local update-result snapshots so a
  recommendation can describe a real historical trend rather than imitate a
  live health check.

Both are recommendation-engine improvements at the shared artifact seam, not
new implementations of `/doctor`. Detector authors should also follow the
[recommendation auditability contract](./adding-a-recommendation.md#auditability-contract-required).
