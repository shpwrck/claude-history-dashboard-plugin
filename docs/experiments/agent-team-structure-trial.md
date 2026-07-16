# Agent-team structure trial — run protocol & corpus

Epic: [#2094](https://github.com/shpwrck/claude-history-dashboard/issues/2094) ·
Milestone: v0.6.0 · This doc closes
[#2097](https://github.com/shpwrck/claude-history-dashboard/issues/2097).

A controlled efficacy trial (ADR-0005 sense) of **how we organize agents on this
repo**: does a component-owner team plus a specialist review swarm beat
pure-specialist and solo-control on real v0.6 work, without quality loss? This
document is the run protocol and the size-matched task corpus. The rig
(#2095/#2096), the execution (#2098), and the verdict (#2099) are separate
sub-issues.

## Hypothesis

Component owners for divergence (scoped construction) + specialists for
convergence (diff critique), with the top session owning the shared spine
(`types.ts`, the `SESSION_BLOB_PARSER_VERSION` / `PARSER_SIG_VERSION` knobs,
cross-stage contracts), **lowers context-token waste and rework vs solo and vs
pure-specialist — without quality loss**.

## Arms

Four arms, matched tasks, randomized order, frozen model + effort across arms.

| Arm | Structure |
|---|---|
| **C0** control | solo top session, monolithic AGENTS.md, ad-hoc fan-out |
| **S** specialists | solo implement + lens review swarm (#1930–32 / compound-engineering reviewers) |
| **O** owners | scoped component teammates + router owns the spine |
| **O+S** combo | owners implement, specialists review the diff |

## Run protocol

1. **Matched-set assignment.** Tasks are grouped into **size-matched blocks**
   (one task per arm per block, all four the same burn-epic T-shirt size). An arm
   is compared to the others only within a block, so a hard task never lands on
   one arm and an easy one on another. Each arm's total workload is the same size
   profile (see [Corpus](#corpus)).
2. **Randomized order.** Within each block, the task→arm mapping is drawn at
   random (not by author preference), and the order in which an arm works its
   three tasks is shuffled, so learning/ordering effects don't track an arm.
   Record the seed used so the assignment is reproducible.
3. **Frozen model + effort.** The same model id and the same reasoning effort are
   pinned for every arm and every task. The independent variable is *team
   structure only* — not model tier, not effort. Any model/effort change voids the
   block.
4. **Arms run in separate 5h windows.** Agent teams are token-intensive and the
   5h window has redlined before (#321). Each arm runs in its own fresh window;
   never two arms in one window. The combo arm (**O+S**) is the most expensive and
   runs **last**.
5. **Worktree isolation per owner; spine edits stay with the router.** Depth-1 is
   enforced — flat teammates, no nesting (changelog:2503 patched nested teammates
   out). Each owner works an isolated worktree; edits to the shared spine
   (`types.ts`, the parser-version knobs, cross-stage contracts) are made only by
   the top/router session.
6. **Never run over the live release.** The trial runs against v0.6.0 *development*
   sub-issues, never against the live v0.5.0 release branch.
7. **Small-n honesty.** This is n≈3 per arm. Treat **only effects ≳ 2×** as
   signal; report everything else as directional-at-best and do not encode a
   winner off a <2× gap. Per-metric medians, not means (one runaway task should
   not decide an arm). State n on every comparison.

## Metrics

Read from the dashboard's own ingestion of the arm-tagged sessions (#2096 wires
the per-arm labeling + segment view):

- **context tokens loaded / task** (primary — the hypothesis is about context waste)
- **rework / correction rate** (the #1266 over-steer / correction classifier)
- **$ cost / task**
- **iterations-to-CI-green**
- **wall-clock to merge**
- **specialist findings caught** (count of real issues the lens swarm surfaced)
- **operability** — one-line free-text note per arm (what was annoying to run)

## Corpus

### Selection method

Candidates are open, **groomed, eligible** (not `blocked` / `for-agent` /
`in-progress`, no open PR) v0.6.0 **dashboard-repo** sub-issues. Pure-`meta`
tasks (those editing `~/.claude/skills/...`, e.g. the epic-867 steer-delivery
sub-issues) are **excluded** — they don't go through the worktree → lint → build
→ PR contract the metrics (iterations-to-CI-green, wall-clock-to-merge) depend
on. Each task's size is the **burn-epic scorer's T-shirt estimate**
(`pick.mjs --epic <N> --dry-run`), using the repo's observed calibration:
**XS ≈ 2%**, **S ≈ 5%**, **M ≈ 7%** of a 5h window.

The trial's own rig/execution sub-issues (#2095, #2096, #2098, #2099) are **not**
corpus tasks — an arm never measures the machinery measuring it.

### Design

Target: each arm works a matched **{M, S, XS}** triple (≈ 14% / window), one task
drawn from each size stratum, so the four arms carry an identical size profile.

The currently-eligible clean pool is **3 M / 5 S / 3 XS = 11 tasks** — exactly
three clean {M, S, XS} triples plus two spare S. So arms **C0 / S / O** are
assigned now from the clean pool; the combo arm **O+S** runs last (per the epic
build order) and draws its matched triple from the epic-2138 down-model siblings
that **unblock as this corpus lands** (their keystone is in the corpus). Those two
slots are marked *provisional* and are re-verified at execution time (#2098).

### Assignments

> **Illustrative pre-seed mapping — NOT the frozen assignment.** The table below
> is *a* valid size-matched layout, shown to prove the pool composes into clean
> {M, S, XS} triples. It is not the mapping that runs. At execution (#2098) the
> task→arm assignment *within each size block* is **drawn at random under the
> recorded seed** (see the checklist), so there is reproducible evidence the
> mapping was randomized rather than author-chosen. Read each row as the
> candidate pool for that block, to be permuted by the seed.

| Block | Size (est) | C0 | S | O | O+S |
|---|---|---|---|---|---|
| Block-M | M (7%) | #2139 | #1350 | #2058 | #2142 *(prov.)* |
| Block-S | S (5%) | #2170 | #2183 | #2185 | #1349 |
| Block-XS | XS (2%) | #2182 | #1353 | #1354 | #2144 *(prov.)* |

Per-arm total ≈ 14% of a 5h window (C0/S/O identical; O+S matched once its
provisional slots resolve).

Task titles (for the run sheet):

- **M (7%)** — #2139 task-class segmentation of automation spend · #1350 single
  shared `chd-cache-dir` module · #2058 MCP server UX + deployment-surface review
  · #2142 *(prov., epic-2138)* decay/demote stale down-model proofs
- **S (5%)** — #2170 `/api/recommendations.json` response-cache never hits · #2183
  eliminate the double detector pass · #2185 optimize the hottest detectors ·
  #1349 harden MCP-SDK isolation guard
- **XS (2%)** — #2182 assemble only the recommendation-input fields · #1353
  migrate enterprise scoped-ingest DBs · #1354 plugin-ctl lifecycle hardening ·
  #2144 *(prov., epic-2138)* cheap-worker + verifier composite measurement

**Spare / replacement pool** — a replacement MUST match the **size** of the slot
it fills, or the arm's {M, S, XS} profile breaks and the within-block comparison
is invalidated. #1351 (plugin-ctl/mcp-shim tests) is a clean **S**, so it can only
replace a **Block-S** slot; an **M** or **XS** slot must instead be filled by the
next eligible **same-size** sub-issue from `pick.mjs` at run time. Record every
substitution and its size.

### Provisional-slot rule

`#2142` and `#2144` (epic-2138) are `blocked` today on their epic's keystone.
Because **O+S runs last** and the corpus's own M/S tasks (which the keystone
depends on) land first, they are expected eligible by then. At execution (#2098),
re-run `pick.mjs --epic 2138 --dry-run`; if either is still blocked, replace it
with the next eligible same-size epic-2138 sub-issue (or a spare), keeping the
{M, S, XS} profile intact, and record the substitution.

**Confound — do not let an earlier arm gate O+S.** These provisional slots depend
on a keystone that is itself in the measured corpus, so O+S eligibility is
determined by whether an *earlier arm* lands its prerequisite. If that prerequisite
slips or changes scope, O+S either waits or substitutes tasks, folding another
arm's delivery result into the O+S measurement. Preferred order of resolution:
(1) pick O+S tasks that are eligible **before any arm starts**; failing that,
(2) land the shared keystone **outside** the measured corpus (unmeasured, ahead of
the run) so no measured arm gates O+S. If neither holds at execution, treat the
O+S arm as **cross-arm-dependent** and say so in the #2099 verdict — its result may
reflect an earlier arm's delivery, not the O+S structure.

## Confounds & mitigations

| Confound | Risk | Mitigation |
|---|---|---|
| **Task difficulty varies** | An arm looks good because it drew easy tasks | Size-matched blocks (one same-size task per arm); compare only within a block |
| **Model / effort drift** | A faster model flatters an arm | Frozen model id + reasoning effort across all arms/tasks; any change voids the block |
| **Order / learning effects (task-level)** | Later tasks are easier (context built up) | Randomize task→arm mapping and per-arm task order under a recorded seed |
| **Arm-order confound (arm-level)** | With one operator and a fixed arm sequence, operator-learning and release-state drift track the arm itself — C0 always first, O+S always last | Arm *sequence* is NOT counterbalanced: the 5h-redline mitigation pins the priciest arm (O+S) last, which conflicts with counterbalancing. Per-arm task shuffles do not remove this. So #2099 must treat O+S as **order-biased** (its result may reflect being last, not its structure), and read a marginal O+S gap as inconclusive rather than a clean structure win |
| **5h-window token redline (#321)** | A window caps out mid-arm and skews tokens/cost | One arm per fresh window; O+S (priciest) last; abort+rerun a capped window rather than report a truncated arm |
| **Same author across arms** | Operator skill, not structure, drives results | Same operator runs every arm with the documented structure; the per-arm difference is the *structure*, held everything-else-equal; note residual operator-learning as un-eliminated |
| **Subsystem clustering** | An arm's three tasks all touch one module | Triples mix epics (perf #2181, down-model #2138, MCP #1333) where the pool allows; note any residual clustering |
| **Provisional O+S tasks differ** | O+S's matched slots resolve to different tasks | Re-verify eligibility at execution; substitute same-size only; record substitutions |
| **Small n (≈3/arm)** | Noise reads as a winner | Trust only ≳2× effects; medians not means; state n; #2099 encodes a winner only on a robust gap, else "no clear winner" |
| **Quality not measured by speed** | A fast arm that ships worse code looks best | Quality gates are independent: CI-green is a *gate* not a metric; specialist findings + post-merge correction rate guard against speed-at-quality's-expense |

## Execution checklist (owned by #2098)

- [ ] Pin model id + reasoning effort; record both here.
- [ ] Draw and record the randomization seed; freeze the task→arm map + per-arm order.
- [ ] Re-verify every assigned task is still eligible; resolve the two provisional O+S slots (or substitute same-size); record substitutions.
- [ ] Run **C0**, **S**, **O** each in its own fresh 5h window (#2095 owner agent defs ready before **O**).
- [ ] Run **O+S** last in its own window.
- [ ] Confirm each session is arm-tagged so #2096's segment view ingests it.
- [ ] Hand the per-arm metric table to #2099 for analysis + winner encoding.
