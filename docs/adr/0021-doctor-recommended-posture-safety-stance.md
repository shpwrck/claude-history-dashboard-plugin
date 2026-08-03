# ADR 0021: Safety stance toward /doctor-recommended permission postures — differentiate on behavior, reconcile on provenance

- Status: Accepted
- Date: 2026-08-03
- Decision drivers: #3408 (needs-human decision, maintainer decided 2026-08-03)
- Follow-ups: #3596 (differentiate), #3597 (reconcile)

## Context

Claude Code `/doctor` (v2.1.220) actively recommends permissive posture as its
first, "(recommended)" option: check 8 writes
`{"permissions": {"defaultMode": "auto"}}` to `~/.claude/settings.json`, and
check 9 mints standing `permissions.allow` rules in
`.claude/settings.local.json` from transcript-mined denial counts.

The dashboard's safety category partly exists to flag permissive posture. As
`/doctor` adoption grows, a growing share of the configurations our safety
detectors fire on will have been created by the first-party tool, on the first
party's explicit recommendation. "Your permission posture is risky" is a much
weaker claim when Anthropic just told the user to do it — the finding reads as
noise, and noise is the fastest way to erode trust in the engine
(recommendations are auditable claims; see `adding-a-recommendation.md`).

`/doctor`'s own reasoning for check 9 is unusually careful: it refuses
wildcards on git subcommands, refuses `gh api` rules entirely, refuses anything
with an option-embedded execution vector, and writes local scope only, because
transcript-derived command strings are model-authored and prompt-injectable.
Any position we take has to engage with that reasoning rather than assume the
first-party recommendation is careless.

The forks considered (#3408): **concede** (treat the `/doctor`-recommended
posture as baseline and stop flagging it), **differentiate** (re-ground the
claim in observed behaviour), **reconcile** (detect `/doctor` provenance and
reframe), or combinations.

## Decision

Adopt **differentiate + reconcile**:

1. **Differentiate — posture alone is no longer alarm-grade at or below the
   `/doctor` baseline.** Safety findings about auto default mode or standing
   allow rules must be re-grounded in observed behaviour — the receipts
   `/doctor` cannot take, because it runs live checks and takes no history:
   what actually ran unattended under auto mode, which allow rules admitted
   which invocations, what the permission classifier let through. Posture that
   goes **beyond** the `/doctor`-recommendable baseline (`bypassPermissions`,
   allow rules covering write-capable invocations, wildcarded git subcommands
   or `gh api` rules that check 9 itself refuses to mint) remains alarm-grade
   on posture alone. Detector work: #3596.

2. **Reconcile — known first-party changes are follow-ups, not alarms.** Where
   `/doctor` provenance is determinable from local artifacts (a retained
   `/doctor` session applying the change, or drift timing correlating with a
   `/doctor` run), the finding is framed as a follow-up on a known,
   first-party-recommended change — "here is what that posture has admitted
   since" — with the provenance cited. Where provenance is not determinable,
   framing is unchanged; authorship is never guessed. Detector work: #3597,
   complementing #3409 (config-drift recognition of `/doctor`-applied
   changes).

**Concede is rejected** as a standalone posture: it would vacate the safety
category exactly where the engine has a defensible edge. Behavioural receipts
are the axis `/doctor` structurally cannot reach, and the local artifact tree
is precisely the evidence base this product owns. Conceding baseline posture
*findings* is subsumed by (1): the baseline stops producing alarm-grade
posture-only findings, but the category keeps watching what the posture does.

## Consequences

- The five posture-adjacent safety detectors
  (`src/lib/detectors/safety/dangerous-bypass.ts`,
  `allow-rule-overlaps-deny.ts`, `deny-rule-never-triggered.ts`,
  `prompt-friction.ts`, `config-hygiene-rollup.ts`) are re-scoped under #3596:
  each finding either cites behavioural evidence or is explicitly scoped to
  beyond-baseline posture.
- Provenance extraction and follow-up framing land under #3597.
- The `/doctor` boundary doc (`docs/doctor-vs-recs.md`) gains a
  recommended-posture note pointing here; the ownership boundary in that doc
  (live probes and self-fixes are `/doctor`'s; artifact-backed recommend-only
  claims are ours) is unchanged by this ADR.
- Our allow-rule analysis must meet or exceed check 9's own bar: a safety
  finding that recommends *tightening* a rule `/doctor` refused to mint in the
  first place is redundant; the value is in what the minted rules were
  actually used for.
