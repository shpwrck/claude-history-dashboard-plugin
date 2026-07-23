# v0.6.0 review-phase audit — 3-lens file-by-file sweep

Bulletproof, resumable, multi-harness execution harness for the three remaining
v0.6.0 release-gate reviews. It applies the **same per-finding rigor** as the
architecture sweep (`v060-file-audit.md`) but audits **every tracked file through
three lenses at once**, routing findings to the three gate epics:

| Lens | Gate epic | Domain label | What it checks per file |
|---|---|---|---|
| **security** | #1932 | `security` | authz/authn/CSRF, FS write / path-traversal, LLM egress & secrets (ADR 0008), SPA/server boundary & client web-vuln, injection, k8s operator, container/proxy/TLS/supply-chain |
| **data-integrity** | #2133 | `data-integrity` | for detectors/parsers/calc: evidence-backed + reproducible provenance, **arithmetic re-derived and faultless**, stale signals demoted to "as of \<date\>", every `validated` fix snippet copy-paste-safe (`docs/adding-a-recommendation.md`) |
| **performance** | #1930 | `performance` | bundle weight, render churn, N× recompute, ingest/assemble hotspots, unbudgeted new surface (probes in `scripts/{cold-load-measure,measure-render-churn,measure-isolated-views,perf-probe,server-scale-budget}.mjs`) |

A file that a lens doesn't touch gets a fast **`N/A (reason)`** verdict for that
lens — file-by-file coverage without deep analysis where it can't apply.

**Baseline:** pin at each batch's run commit (record it per row). Every finding
is **verified against `origin/master` at that commit** before filing — the local
tree may be stale, so a fixed-on-master issue is never reported as a gap.

## Design corrections (v2) — the three invariants

1. **Any combination of gates.** The harness runs any SUBSET of the review gates,
   not a fixed three. The gate registry is `scripts/audits/gates.config.mjs`
   (`GATES` = security→#1932, data-integrity→#2133, performance→#1930,
   architecture→#1931; each with epic + label + milestone + per-file `spec`).
   `DEFAULT_GATES` is the v0.6.0 remaining three; select any subset with `--gates
   a,b` (router) / `args.gates` (FIND). Reuse for another release = edit this file
   only. Both the FILE router (`--gates`) and the FIND workflow (`args.gates` +
   `args.gateSpecs`) read the registry and only file/audit the active subset;
   findings for an inactive gate are skipped, and each issue's milestone comes from
   its gate's config entry.

2. **It must not matter where a stage runs (Claude or Codex).** The neutral seam is
   the per-gate `spec` + the findings-JSON contract + the idempotent router — all
   harness-agnostic. The **usage-aware orchestrator** `scripts/audits/orchestrate.mjs`
   owns the loop: it reads the ledger resume state + both harnesses' usage, picks
   the next unaudited (section, gates) batch, and **delegates it to whichever harness
   has confirmed budget**, both executing the identical per-batch spec and feeding
   the same router. The Claude `Workflow` engine
   (`scripts/audits/v060-audit-batch.workflow.mjs`) is just ONE optional Claude
   accelerator, never the required path. **FILE** (`file-findings.mjs`) is already
   fully neutral and idempotent (the `<!-- audit-finding: <key> -->` marker means
   overlapping Claude/Codex runs across windows never double-file). **BURN** reuses
   the existing vendor-neutral `for-agent` queue + `coder`/`reviewer` skills
   (`--handoff` stamps `for-agent`+`groomed`).

   Run it: `node scripts/audits/orchestrate.mjs --baseline <sha> [--gates a,b]
   [--floor 12]` — `--plan` (default) prints the routing decision without executing;
   `--run` dispatches the batch then files via the router. The live dispatch (nested
   `claude -p` / `codex exec`) is the seam validated on the first real `--run`.

3. **Take usage into account at all times.** Before every batch the orchestrator
   reads each harness's plan usage (`check-usage.mjs --source <h> --json`) and routes
   to the one with budget, sizing the batch to ≤ half its 5h window; it **stops**
   when no harness clears the `--floor`. **A stale, rejected, or unreadable usage
   source is treated as ZERO budget, never as fresh** — verified: with the local
   Codex source reporting its snapshot stale (the fix from dashboard #3024 /
   shpwrck/claude #194), the orchestrator marks Codex `UNUSABLE -> 0%` and routes to
   Claude instead of over-spending on a phantom budget.

## Stage I/O contract (the portable seam)

Stage 1 emits, and stage 2 consumes, one JSON file per batch:

```jsonc
{
  "baseline": "ff8d83b4",            // origin/master short sha the audit ran against
  "auditDate": "2026-07-23",         // ISO date (stamped by the human/runner, not the workflow)
  "section": "root",                 // ledger section key
  "auditor": { "vendor": "claude", "instance": "00a0f586", "role": "main" },
  "findings": [
    {
      "lens": "security|data-integrity|performance",
      "severity": "critical|high|medium|low",
      "title": "clean one-line title, no [tag] prefix",
      "files": ["path/to/file.ts:120-133", "other.ts:44"],  // >=1 file:line
      "where": "markdown bullets of file:line evidence",
      "what": "what breaks / why it matters (optional)",
      "fix": "concrete, minimal fix",
      "acceptance": "a verifiable acceptance check",
      "priority": "High|Medium|Low",   // optional; derived from severity if absent
      "verified": true,                // MUST be true to file; verifier confirmed vs origin/master
      "verifyNote": "how it was confirmed against origin/master"
    }
  ]
}
```

Only `verified: true` findings are filed. The router derives a **stable dedup
key** `sha1(lens \n normalizedPrimaryFilePath \n slug(title))[:12]` and embeds
`<!-- audit-finding: <key> -->` in the issue body; it refuses to create a second
issue for the same key (searching open **and** closed issues), which is what
makes concurrent multi-harness / multi-window auditing safe.

## How to run it (human kickoff)

Weekly budget is the ceiling; each batch is sized to **≤ half the live 5h window**
(the `workflow-window-guard` governs Claude launches). One section per batch is a
safe default; large sections (`src/lib` 455, `src/lib/detectors` 212) split further.

   **Prefer the orchestrator** (`orchestrate.mjs`, above) — it resolves the section to a
   pathspec, sizes the batch to real usage, dispatches, and files in one step.

1. **FIND** — the Workflow does NOT write to disk (its sandbox has no filesystem
   access): it **returns** the findings object, so save that returned value to
   `docs/audits/findings/<section>-<sha>.json` yourself. It requires `args.repoDir`
   (absolute checkout path) and a real `args.path` **or** `args.files` — `section` is
   only a label, so a bare `{ section, baseline }` would list the whole tree and audit
   its first 40 files. Codex (or Claude, by hand) can instead audit the section per the
   lens spec and write the same JSON shape directly.
2. **FILE** — `node scripts/audits/file-findings.mjs --findings
   docs/audits/findings/<section>-<sha>.json [--gates a,b] [--handoff] [--dry-run]
   --vendor <v> --instance <id>`. `--gates` restricts filing to a subset (default
   = the three remaining); `--instance` is required for a real (non-dry) run so
   filed issues are attributable. Dry-run first to preview; it prints skip/create
   per finding and never mutates under `--dry-run`.
3. **Record** — mark the section's three lens cells in the ledger below (`DONE`,
   with the finding issue numbers), commit the ledger, move to the next section.
4. **BURN** — the `coder`/`reviewer` skills drain the `for-agent` findings across
   both harnesses; gates close by hand (below) when their lens is fully swept and
   their sub-issues are all closed.

**Kill switch / safety:** stage 2 is the only mutating step; run it `--dry-run`
whenever unsure. Stage 1 is read-only. Re-running any section is safe (idempotent
filing). No batch silently truncates — the workflow logs every file it skips.

## Gate-close criteria

Close a gate epic (as done for #1931) when **both**: (a) its lens column is `DONE`
for every section row below, and (b) every sub-issue it owns is closed **or**
explicitly moved to a later milestone. When all three of #1930/#1932/#2133 are
closed (architecture #1931 already is), `scripts/check-release-gate.mjs` opens the
v0.6.0 cut.

## Ledger (resume state — update after each batch, then commit)

File counts are from architecture baseline `bd45f1c5`; the workflow regenerates
the actual file list per section from the run baseline via `git ls-tree`, so drift
is handled — the counts below are only a size guide. Lens cells: `—` = not
started, `WIP`, `DONE (#nnnn, #nnnn)` with filed issues, or `DONE (clean)`.

| Section | Files | security → #1932 | data-integrity → #2133 | performance → #1930 |
|---|---|---|---|---|
| root | 33 | — | — | — |
| scripts/ | 158 | — | — | — |
| src/lib (non-detectors) | 455 | — | — | — |
| src/lib/detectors | 212 | — | — | — |
| src/components | 161 | — | — | — |
| src (rest) | 13 | — | — | — |
| docs/ | 140 | — | — | — |
| fixtures/ | 172 | — | — | — |
| e2e/ | 13 | — | — | — |
| .github/ | 21 | — | — | — |
| probaitio-operator/ | 81 | — | — | — |
| deploy/ | 8 | — | — | — |
| data/, tools/, bin/, commands/, .claude* | 27 | — | — | — |

## Seeded concerns (bank before the sweep)

Known findings surfaced during the release, to confirm/file in the relevant lens:

- **performance** — `assembleDataset` builds a ~132 MB in-memory dataset and
  detectors run twice per request; recs warm at 4.7–11.7 s (memory:
  api-latency-profile-2026-06, instant-load-rearchitecture-proto). Confirm vs
  current `origin/master` and file under #1930 if still live.
- **security** — re-verify the ADR 0008 egress path (the v0.5.0 CRITICAL F1 was
  an `egressScrub` identity stub); confirm the scrub is real on current master.
- **data-integrity** — spot the detectors touched this cycle (adoption-loop,
  rate-limits, down-modelling confidence) for present-tense staleness and
  arithmetic.
