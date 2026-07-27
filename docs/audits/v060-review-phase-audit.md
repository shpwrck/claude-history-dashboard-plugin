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

**Baseline:** the completed sweep is pinned end-to-end to the full
`origin/master` SHA `c8b98a29508b5eb7725c75a7e2a41dfa94c1feba`. The
runner enumerates the exact NUL-delimited `git ls-tree` manifest, proves that its
13 sections form a lossless, non-overlapping partition, and gives workers a clean
detached worktree at that SHA. Every finding is re-read there before filing.

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

   Run it with a full 40-character SHA. `--plan` (default) prints the next
   routing decision without executing. `--run` dispatches one read-only worker,
   validates and seals its receipt, and previews the router; it does not mutate
   GitHub or advance state unless `--file --instance <unique-id>` is also present.
   `--run-all --file --instance <unique-id>` repeats until complete,
   budget-stopped, or `--max-batches` is hit; preview-only runs remain one batch.

3. **Take usage into account at all times.** Before every batch the orchestrator
   reads each harness's plan usage (`check-harness-usage.mjs --source <h> --json`),
   uses the smaller remaining percentage across the 5-hour and 7-day windows, and
   sizes the file count to at most half that binding budget. The default 96 KiB
   baseline-blob cap further bounds prompt content (one individually oversized file
   may run alone). It **stops** when no harness clears `--floor`. A stale,
   rejected, malformed, or unreadable usage source is ZERO budget, never fresh.

## Stage I/O contract (the portable seam)

Each batch produces three durable artifacts with the same stem:

- `.json`: a schema-validated receipt carrying the full baseline SHA, audit date,
  section, active gates, exact `auditedFiles`, one reasoned verdict for every
  file×gate pair, and zero or more verified findings;
- `.meta.json`: the producer harness plus SHA-256 seals for the receipt bytes and
  audited-file list, bound again to baseline/date/section/gates;
- `.router.json`: every validated finding accounted for as created or existing
  (a live run fails if anything is skipped).

The essential receipt shape is:

```jsonc
{
  "baseline": "c8b98a29508b5eb7725c75a7e2a41dfa94c1feba",
  "auditDate": "2026-07-26",
  "section": "root",
  "gates": ["security", "data-integrity", "performance"],
  "auditedFiles": ["AGENTS.md"],
  "verdicts": [{
    "file": "AGENTS.md",
    "gates": [
      { "gate": "security", "status": "clean|n/a|finding", "reason": "..." }
    ]
  }],
  "findings": [{
    "lens": "security|data-integrity|performance",
    "severity": "critical|high|medium|low",
    "title": "clean one-line title",
    "files": ["path/to/file.ts:120-133"],
    "where": "file:line evidence",
    "what": "impact",
    "fix": "concrete minimal fix",
    "acceptance": "verifiable check",
    "priority": "High|Medium|Low",
    "verified": true,
    "verifyNote": "how the immutable baseline was checked"
  }]
}
```

The durable run state is the authority for resume. It rejects baseline, gate, date,
manifest, batch, verdict, or issue-aggregation drift before any new dispatch, then
regenerates the Markdown ledger atomically after a successfully reconciled router.
The router embeds a stable `<!-- audit-finding: <key> -->` marker and searches open
and closed issues, so retries and overlapping harness windows do not double-file.

## How to run it (human kickoff)

Use an immutable full SHA and a clean worktree for the mutable runner checkout:

```sh
node scripts/audits/orchestrate.mjs \
  --baseline <40-character-sha> \
  --gates security,data-integrity,performance \
  --audit-date YYYY-MM-DD \
  --repo-dir <runner-worktree>
```

- Default/`--plan`: inspect usage and print the next bounded batch; no mutation.
- `--run`: dispatch and validate one receipt, then run only the router preview.
- Add `--file --instance <unique-id>` to a one-batch `--run` only when the
  preview is accepted and issue creation/linking plus durable state/ledger
  advancement are intended.
- `--run-all` requires that same explicit `--file --instance <unique-id>`
  authority and repeats until complete, budget-stopped, or batch-limited.
- Resume with the identical baseline, gates, and audit date; sealed receipts are
  reused, while an interrupted unsealed receipt is treated as retryable.

Workers receive an explicit file list and read-only tool surface. Receipt schema,
path:line evidence, active-lens membership, complete file×gate verdict coverage, and
immutable-baseline metadata are validated before routing. The live router sanitizes
issue text, preserves signed authorship, and creates native sub-issues. Because
GitHub caps a parent at 100 direct sub-issues, the router reserves direct slots at
90 and creates signed `audit-rollup` children; overflow findings remain native
descendants of the release gate.

## Gate-close criteria

Close a gate epic (as done for #1931) when **both**: (a) its lens column is `DONE`
for every section row below, and (b) every sub-issue it owns is closed **or**
explicitly moved to a later milestone. When all three of #1930/#1932/#2133 are
closed (architecture #1931 already is), `scripts/check-release-gate.mjs` opens the
v0.6.0 cut.

## Ledger (durable completed state)

File counts and cells below are generated from
`docs/audits/runs/v060-c8b98a29508b.json`, whose manifest is the exact 1,487-file
tracked tree at the pinned baseline. `DONE (#...)` lists the unique issues to
which that section's accepted findings route; `DONE (clean)` means no issue for
that lens in the section.

| Section | Files | security → #1932 | data-integrity → #2133 | performance → #1930 |
|---|---|---|---|---|
| root | 33 | DONE (#2865, #3062, #3063, #3064, #3066, #3067) | DONE (clean) | DONE (#3065) |
| scripts/ | 166 | DONE (#3069, #3070, #3071, #3072, #3074, #3077, #3079, #3080, #3085, #3086, #3089, #3090, #3095, #3096, #3102) | DONE (#3068, #3073, #3075, #3078, #3081, #3082, #3083, #3084, #3091, #3092, #3093, #3097, #3099, #3101, #3104) | DONE (#3076, #3087, #3088, #3094, #3098, #3100, #3103) |
| src/lib (non-detectors) | 452 | DONE (#3107, #3108, #3111, #3117, #3132, #3151, #3157, #3168, #3178) | DONE (#3105, #3106, #3109, #3110, #3112, #3113, #3115, #3116, #3118, #3119, #3120, #3121, #3123, #3124, #3125, #3126, #3128, #3131, #3133, #3134, #3135, #3136, #3138, #3139, #3141, #3142, #3143, #3144, #3145, #3146, #3149, #3153, #3154, #3155, #3158, #3159, #3160, #3162, #3163, #3165, #3166, #3170, #3171, #3173, #3175, #3179) | DONE (#3114, #3122, #3127, #3129, #3130, #3137, #3140, #3147, #3148, #3150, #3152, #3156, #3161, #3164, #3167, #3169, #3172, #3174, #3176, #3177) |
| src/lib/detectors | 214 | DONE (#3212, #3220, #3223, #3230, #3231) | DONE (#3180, #3181, #3182, #3183, #3184, #3185, #3186, #3188, #3189, #3190, #3191, #3192, #3193, #3194, #3195, #3196, #3197, #3199, #3200, #3201, #3202, #3204, #3205, #3206, #3207, #3208, #3210, #3211, #3213, #3214, #3216, #3217, #3218, #3219, #3221, #3222, #3224, #3225, #3226, #3227, #3228, #3229, #3232, #3234, #3236, #3237, #3239, #3241, #3242, #3243, #3244, #3246, #3247, #3248, #3249, #3250) | DONE (#3187, #3198, #3203, #3209, #3233, #3235, #3238, #3240, #3245, #3251) |
| src/components | 160 | DONE (#3254) | DONE (#3252, #3255, #3256, #3258, #3260, #3262, #3264, #3265, #3269, #3271, #3274, #3275, #3276, #3279) | DONE (#3253, #3257, #3259, #3261, #3263, #3266, #3267, #3268, #3270, #3272, #3273, #3277, #3278) |
| src (rest) | 11 | DONE (clean) | DONE (clean) | DONE (clean) |
| docs/ | 142 | DONE (#3281, #3284, #3289, #3291, #3292, #3295, #3296) | DONE (#3280, #3282, #3283, #3285, #3286, #3293, #3294, #3297) | DONE (#3287, #3288, #3290) |
| fixtures/ | 172 | DONE (clean) | DONE (#3298, #3301, #3302) | DONE (clean) |
| e2e/ | 13 | DONE (clean) | DONE (#3305) | DONE (clean) |
| .github/ | 21 | DONE (#3306, #3307, #3313) | DONE (#3309) | DONE (clean) |
| probaitio-operator/ | 77 | DONE (#3314, #3315, #3316, #3317, #3318, #3320, #3321, #3322, #3323, #3325, #3326, #3327, #3328, #3329, #3330, #3336) | DONE (#3333, #3335) | DONE (#3331) |
| deploy/ | 8 | DONE (#3340, #3341) | DONE (clean) | DONE (clean) |
| data/, tools/, bin/, commands/, .claude* | 18 | DONE (#3343, #3344, #3345, #3346) | DONE (clean) | DONE (clean) |

## Completed sweep

The 2026-07-26 run completed all 13 sections in 260 sealed batches: **1,487 files**,
**4,461 file×gate verdicts**, and **280 accepted finding records** routed to **269
unique open issues** — 68 security, 146 data-integrity, and 55 performance. Data
integrity exceeded GitHub's direct-child ceiling, so #3215 is the signed overflow
rollup under #2133; every accepted issue remains reachable as a native descendant
of its gate.

The run recovered cleanly from an interrupted component receipt and a timed-out
14-file fixture batch by retrying only unsealed work in smaller batches. Four
model-evaluation fixture candidates (#3299, #3300, #3303, #3304) and one redundant
caller consequence (#3308) were rejected and removed from receipts/state. Eleven
real but non-independent findings were consolidated into their surviving issues:
#3310, #3311, #3312, #3319, #3324, #3332, #3334, #3337, #3338, #3339, and #3342.
Those rejected issue shells are closed as not planned, unlabelled, unmilestoned,
and absent from the gate hierarchy; their surviving issues carry the extra audit
markers.

All three lens columns are complete, but #1930, #1932, and #2133 intentionally
remain open until their accepted descendants are closed or explicitly moved under
the gate-close criteria above.

## Seeded concerns (checked by the completed sweep)

These pre-run concerns were included explicitly in the completed lens review:

- **performance** — the `assembleDataset` memory profile, repeated detector
  execution, and warm recommendation latency were included in the hot-path lens.
- **security** — the ADR 0008 egress path and the former identity-stub failure
  mode were re-read at the immutable baseline.
- **data-integrity** — adoption-loop, rate-limit, and down-modelling detectors
  were included in the stale-claim and arithmetic review.
