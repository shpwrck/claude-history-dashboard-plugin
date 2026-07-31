# 0020 — The persisted repo-map is a head-of-ranking index, not a whole-repo map

- **Status:** Accepted (2026-07-31)
- **Date:** 2026-07-31
- **Deciders:** r13 Perf audit stream (epic #1930), recorded for maintainer veto before merge
- **Related:** [#3475](https://github.com/shpwrck/claude-history-dashboard/issues/3475)
  (the product decision this records), #3452 (the gate repair that made the
  shedding visible), #3471/#3510 (the localization probe rebuild + relaxation
  control that gate the same artifact), ADR
  [0007](./0007-repo-map-host-producer-wasm.md) (host producer). Measurement
  basis: [`docs/perf-sprint/repo-map.md`](../perf-sprint/repo-map.md);
  budget: `repo-map-budget.json`.

## Context

The repo-map producer clamps the persisted artifact to
`DEFAULT_MAX_PERSISTED_BYTES` (1 MiB per ingested root,
`src/lib/repo-map/cache.ts`): `enforceSizeLimit` binary-searches the largest
prefix of the **ranked** file list that fits and drops the tail. Until #3452
that shedding was structurally unobservable — the payload gate compared the
clamped size against an equal budget, a tautology — and the repair surfaced the
real numbers (measured at `2793e89d`):

| | bytes | files |
|---|---:|---:|
| natural (unbounded) serialization | 1,758,457 B | 1,191 |
| persisted artifact (what ships) | 1,047,468 B | 527 |

The artifact wants to be ~168 % of its ceiling, so **55.8 % of ranked files are
absent from the shipped map**. #3475 asked for a decision among three options:
raise the ceiling, densify the map, or accept and document.

## Decision

**Accept and document.** The persisted repo-map artifact is *deliberately* a
**head-of-ranking structural index** — the most-referenced ~500+ files of the
repo, by import in-degree — not a whole-repo map. Concretely:

1. **The 1 MiB per-root ceiling stays.** The artifact ships inside the dataset
   payload once per ingested root; the ceiling exists so one pathological
   monorepo cannot dominate the payload, and raising it to ~1.8 MiB for this
   repo would be a per-root cost multiplied across every root. A ceiling raise
   is rejected as the default response to growth.
2. **What is shed is the least-referenced tail**, which is the intended
   ordering: `enforceSizeLimit` keeps a prefix of the in-degree ranking, so
   every retained file outranks every dropped one. The map's job — point an
   agent at the load-bearing files — concentrates in exactly the head it keeps.
3. **`retainedFilesMin` (absolute count, currently 500) guards collapse**, not
   coverage: it trips when average entry size grows ~5 %, i.e. when the head
   itself gets thinner, which is a real regression signal. Retained *share*
   falling as the tree grows is the accepted, by-construction consequence of a
   fixed ceiling and is not a defect.
4. **The escalation path is densification, not a bigger ceiling.** If the
   retained-count floor trips, or a localization regression is ever traced to
   shedding, the remedy to design is fewer bytes per retained entry (shorter
   signatures, trimmed import lists) so more files fit under the same ceiling.
   That changes what the map can answer and therefore deserves its own issue
   and measurement when it happens.
5. **Value metrics stay measured on the unbounded map, and that is
   conservative.** The persisted artifact is a prefix of the ranking, so the
   top-K head the localization probe scores against is byte-identical in the
   persisted and unbounded maps; unbounded seeding additionally scores edges
   out of the shed tail, which the shipped artifact never claims to answer.
   (The probe's semantics are #3471's; its relaxation control is #3510's.)
   The byte-identical claim rests on the invariant `retainedFilesMin > K`:
   the retained-count floor (500) must exceed the probe slice
   (`localizationTopKPct`, 7% of ranked files), which holds until the tree
   approaches ~7,100 ranked files. If that ratio ever inverts, the probe must
   move to the persisted artifact.

## Consequences

- Consumers (the #889/#891 joins, prompt renderers) may rely on the artifact
  containing the ranked head and must not assume whole-repo coverage; absence
  of a file from the map is **not** evidence the file does not exist.
- `repo-map-budget.json`'s `unboundedPayloadMaxBytes` remains a growth alarm
  for the *natural* size (raise it deliberately, with a note, when the repo
  legitimately grows); it is not part of this decision's shipped-size posture.
- The docs and gate output stop describing the shedding as a known-bad state;
  `docs/perf-sprint/repo-map.md` and the budget `_comment` cite this ADR.
- Reversal criteria are named in (4): a tripped retained floor or a
  shedding-attributed localization regression reopens the question as a
  densification design, superseding this ADR.
