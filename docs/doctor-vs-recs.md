# `/doctor` and `/recs`: two layers

> `/doctor` = install health with fixes; `/recs` = behavioural coaching with
> auditable, recommend-only claims.

They answer different questions and work best together:

| Surface | Question | Evidence | Action posture |
| --- | --- | --- | --- |
| Claude Code `/doctor` | Is this installation healthy right now? | Live host and runtime checks | Diagnoses installation problems and can apply fixes |
| Dashboard `/recs` | How could this work improve? | Local `~/.claude` artifacts and opt-in `~/.codex` artifacts | Makes reproducible recommendations; never applies them |

Run `/doctor` after an install or update, or when authentication, networking,
or editor integration is failing. Run `/recs` regularly to improve cost,
context use, workflow, reliability, and speed based on recorded work.

## Point-in-time comparison

A [July 9, 2026 audit](https://github.com/shpwrck/claude-history-dashboard/issues/2423)
compared Claude Code `/doctor` v2.1.205 with the dashboard's then-current catalog
of 91 registered detectors. About 10 detectors (roughly 11%) touched the same
settings, configuration, MCP, or update-health band. The audit also counted 61
cost, context, workflow, and speed detectors with no `/doctor` counterpart.

Those figures describe that dated snapshot, not the current inventory or an
ongoing compatibility promise. Re-run the comparison before quoting them as
current.

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
installation. `/recs` owns artifact-backed claims that remain auditable and
recommend-only. A proposed detector on the live-probe surface is presumed
redundant and needs an explicit product justification before implementation.

Any approved exception must be opt-in behind an explicit environment flag and
off by default. With the flag unset, the default deployment path must remain
byte-identical and make zero external calls, as required by the
[local-first rule](../AGENTS.md#local-first-by-default-non-local-data-is-opt-in).
The gate is necessary, not sufficient: it does not by itself justify duplicating
`/doctor`.

## Recommended-posture stance

`/doctor` (v2.1.220) actively recommends permissive posture: check 8 writes
`permissions.defaultMode: auto` and check 9 mints transcript-mined
`permissions.allow` rules. Per
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
