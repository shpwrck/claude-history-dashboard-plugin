# Memory lifecycle schema

Status: authoritative machine-readable contract for the memory-lifecycle
detectors (epic #2233; this document is issue #2234, work ticket
shpwrck/claude#127). The writer-facing twin is the **"Memory lifecycle"**
section of the global `CLAUDE.md` in `shpwrck/claude` (the versioned
`~/.claude`), which requires exactly one lifecycle clause on every new memory
and every existing memory when it is touched.
The two documents are intended to fix the same field names, value grammars,
and semantics. They are in parity as of the companion correction in
[shpwrck/claude#160](https://github.com/shpwrck/claude/pull/160), merged as
`d5c7ac299668d165f94d4bd04abae2ffcb405623`. See *Writer-twin parity record*
for the verified shared scope.

## Scope

This schema applies only to root memory **fact files** — every
`~/.claude/projects/<slug>/memory/*.md` file except `MEMORY.md`. The broader
fixed-depth reader also parses direct `memory/archive/*.md` facts for memory
hygiene, but those archive facts are deliberately outside this lifecycle
contract: their `AgentMemory.file` is a root-relative path such as
`archive/old.md`, while the version-1 lifecycle memory id below admits one
slash only, between the project slug and a root fact filename. Extending
lifecycle enforcement to archive facts requires one coordinated, versioned
change to that id grammar and to the writer-facing twin; this PR does neither.

`readMemories` includes `MEMORY.md`, direct archive facts, and
`archive/ARCHIVE.md`; `parseMemories` excludes both index files from memory
cards and `buildMemoryStores` separates both indexes from fact files. That
broader hygiene read surface does not broaden lifecycle scope. The stale
`REFERENCES.md` mapping is tracked separately in #2549/#2700; this contract
does not repair that mapping inline.

## Placement and parsing

Lifecycle keys are **top-level frontmatter keys**, siblings of `name:` and
`description:` — **never** nested under `metadata:`. Two reasons, both grounded
in the existing parser:

1. `parseMemoryFile` (in `parse-memories.ts`) reads frontmatter line-by-line
   with anchored key regexes — `^name:` and `^description:` are matched at
   column 0. Top-level lifecycle keys get the same exact `^<key>:` anchoring;
   a `metadata:`-nested key would need the loose `^\s*<key>:` compromise the
   legacy `type:` field uses, which can false-match a same-named key in any
   other nested block.
2. The `metadata:` block carries harness-managed provenance (`node_type`,
   `originSessionId`, `type`) that the memory tooling writes; author-declared
   lifecycle contracts stay out of it so a harness rewrite of that block can
   never clobber them.

Parser requirements:

- Match each lifecycle key with a line-anchored regex at column 0 —
  `/^expiresWhen:\s*(.*)$/` etc. — inside the same `FRONTMATTER_RE` block
  `parseMemoryFile` already isolates. Capture `(.*)`, **not** `(.+)`: key
  presence is decided by the line match alone, and value validity is checked
  afterwards, so a key line with an empty value still counts as that key's
  first occurrence. (With `(.+)`, a bare `reviewBy:` line would not match and
  a later duplicate would silently become the governing value — contradicting
  first-occurrence-wins; see *Malformed clauses and duplicate keys*.)
- Apply the same `stripQuotes` tolerance as the existing fields (see
  *Accepted syntax vs canonical writer style* below), except that
  `lifecycleWhy` uses the stricter one-line scalar grammar defined in its own
  section.
- Key names are exact and case-sensitive (camelCase, matching
  `originSessionId`/`lastModifiedMs` conventions). No aliases.
- The schema is **additive**: `parseMemoryFile` today ignores unknown
  frontmatter lines, so files carrying these keys parse identically until a
  detector opts in. Likewise, a detector must ignore unknown keys — future
  additions to this schema must not break older parsers.

**Accepted syntax vs canonical writer style.** Two distinct layers; do not
conflate them:

- *Accepted syntax* — what a classifier recognizes: the value of any
  lifecycle key after `stripQuotes`, whether written bare, `'single'`- or
  `"double"`-quoted; all three are equally recognized for every field except
  `lifecycleWhy`. A value that is empty or whitespace-only after
  `stripQuotes` is a **malformed fragment** (see *Malformed clauses and
  duplicate keys*). `lifecycleWhy` additionally rejects block markers,
  trailing comments, unmatched quotes, and placeholders.
- *Canonical writer style* — what the writing convention tells authors:
  always double-quote `expiresWhen` and `lifecycleWhy`; write dates,
  intervals, and `lifecycle: evergreen` as plain scalars. A style deviation
  is not a violation so long as the value parses. The quoting rule exists
  because a consumer reading the frontmatter as *real YAML* (this contract's
  parser is line-regex, but other tools may not be) treats a bare leading `#`
  as a comment delimiter and sees an empty value.

## Required parser and detector projection

The #2235 implementation must extend `parse-memories.ts` with these exact
public shapes. Names in this block are contract, not examples:

```ts
export type MemoryLifecycleKey =
  | 'expiresWhen'
  | 'reviewBy'
  | 'validatedAt'
  | 'revalidateEvery'
  | 'lifecycle'
  | 'lifecycleWhy';

export type MemoryLifecycleClauseKind =
  | 'condition-expiry'
  | 'time-decay'
  | 'heartbeat'
  | 'evergreen';

export type MemoryLifecycleDiagnosticCode =
  | 'duplicate-key'
  | 'empty-value'
  | 'invalid-date'
  | 'invalid-interval'
  | 'invalid-lifecycle-value'
  | 'invalid-lifecycle-why'
  | 'incomplete-heartbeat'
  | 'incomplete-evergreen'
  | 'multiple-valid-clauses';

export interface MemoryLifecycleField {
  /** Exact `(.*)` capture from the first key occurrence. */
  raw: string;
  /** Normalized field value, or null when its scalar/field grammar fails. */
  value: string | null;
  /** One-based line number inside the isolated frontmatter block. */
  line: number;
}

export interface MemoryLifecycleDiagnostic {
  code: MemoryLifecycleDiagnosticCode;
  keys: MemoryLifecycleKey[];
  /** Every implicated one-based frontmatter line, in source order. */
  lines: number[];
}

export interface MemoryLifecycleProjection {
  /** First occurrence only; absent and present-but-empty stay distinguishable. */
  fields: Partial<Record<MemoryLifecycleKey, MemoryLifecycleField>>;
  /** Valid clause kinds in the precedence order defined below. */
  validClauses: MemoryLifecycleClauseKind[];
  diagnostics: MemoryLifecycleDiagnostic[];
}

export interface AgentMemory {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
  file: string;
  lastModifiedMs?: number;
  lifecycle: MemoryLifecycleProjection;
}
```

`parseMemoryFile` must always return `lifecycle`; a file with no frontmatter or
no lifecycle keys returns `{ fields: {}, validClauses: [], diagnostics: [] }`.
`fields` contains only the first occurrence of each key. A duplicate produces a
`duplicate-key` diagnostic pointing at the first and duplicate lines but never
replaces the first field. `value` is `null` when the first occurrence fails its
field grammar; pair and multi-clause diagnostics are added after all six first
occurrences are collected. An unrecognized but non-empty free-text
`expiresWhen` remains a valid condition-expiry value and is handled manually,
so it is not a parse diagnostic.

Diagnostic construction is deterministic:

1. Emit `duplicate-key` once per duplicated occurrence, with the first and
   that duplicate's lines.
2. Validate first occurrences in source order. Empty raw captures — and values
   that decode to empty — emit `empty-value`. Otherwise dates, intervals,
   `lifecycle`, and `lifecycleWhy` use their corresponding `invalid-*` code.
3. Emit `incomplete-heartbeat` when exactly one heartbeat key is present, and
   `incomplete-evergreen` when exactly one evergreen key is present. Presence,
   not value validity, decides whether a pair is incomplete; a present but
   invalid partner already has its field diagnostic.
4. Build `validClauses` from first-occurrence fields that form complete, valid
   clauses, in precedence order. When it contains more than one kind, emit one
   `multiple-valid-clauses` diagnostic whose keys and lines cover every valid
   clause in that same order.

Within each phase diagnostics follow source-line order, and the four phases
above are the final array order. A diagnostic's `keys` and `lines` arrays are
parallel and contain no unrelated fields. This order and the first-occurrence
projection are what parser tests must assert.

The recommendation input must add these exact fields and types:

```ts
export interface LifecycleIssueStateSnapshot {
  version: 1;
  enabled: boolean;
  entries: Record<string, LifecycleIssueStateEntry>;
}
export type LifecycleIssueStateEntry =
  | { state: 'open' | 'closed'; checkedAt: string }
  | { state: 'error'; checkedAt: string; errorCode: string };

export interface LifecycleFileStateSnapshot {
  version: 1;
  entries: Record<string, LifecycleFileStateEntry>;
}
export type LifecycleFileStateEntry =
  | { state: 'present' | 'absent'; checkedAt: string }
  | { state: 'root-unavailable'; checkedAt: string }
  | { state: 'error'; checkedAt: string; errorCode: string };

export interface LifecycleGraduationEvidence {
  source: string;
  field: 'memory-source-marker' | 'normalized-description' | 'hook-referenced-path';
  value: string;
}
export type LifecycleGraduationStateEntry =
  | {
      kind: 'rule' | 'hook';
      state: 'verified' | 'candidate' | 'not-found' | 'ambiguous';
      checkedAt: string;
      evidence: LifecycleGraduationEvidence[];
    }
  | {
      kind: 'rule' | 'hook';
      state: 'error';
      checkedAt: string;
      evidence: LifecycleGraduationEvidence[];
      errorCode: string;
    };
export interface LifecycleGraduationStateSnapshot {
  version: 1;
  entries: Record<string, LifecycleGraduationStateEntry>;
}

export interface RecommendationInput {
  memoryStores?: ProjectMemoryStore[] | null;
  issueStateSnapshot?: LifecycleIssueStateSnapshot | null;
  fileStateSnapshot?: LifecycleFileStateSnapshot | null;
  graduationStateSnapshot?: LifecycleGraduationStateSnapshot | null;
}

// Additive field required on both global and project-scoped settings.
export interface LiveSettings {
  disableAllHooks?: boolean;
}
```

Issue entries are keyed by the canonical condition reference
`<owner>/<repo>#<n>`. File entries are keyed by the exact recognized
`~/.claude/...` condition path. Graduation entries are keyed by the version-1
stable memory id `<ProjectMemoryStore.project>/<AgentMemory.file>` for
lifecycle-bearing root facts; neither component contains `/`, so the id
contains exactly one slash. An archive fact whose `AgentMemory.file` is
`archive/<file>.md` is outside this contract and MUST NOT receive a version-1
graduation entry. These three fields must be declared in the detector's
`dataDeps`, supplied by both recommendation assembly surfaces when available,
and normalized to `null` when their producer did not run. The SPA/upload path
supplies `null` snapshots and performs no I/O.

`disableAllHooks` must survive the same global/local and project/local settings
merge that produces `liveConfig.settings` and `liveConfig.projectSettings`.
It is detector input, not a new Claude Code setting: `config-hygiene.ts`
already recognizes the real setting, while the lifecycle implementation makes
the effective boolean visible so a configured-but-disabled hook can never be
claimed as enforcement.

The field names above replace the earlier non-binding “recommended field”
language. A detector must not cast an ad hoc extension onto
`RecommendationInput`, recover raw frontmatter from `body`, or perform its own
filesystem/network lookup.

## The four clauses

| Clause | Field(s) | Value grammar |
| --- | --- | --- |
| Condition-expiry | `expiresWhen` | non-empty condition string (below; canonical style double-quotes it) |
| Time-decay | `reviewBy` | calendar date (Date validity, below) |
| Heartbeat | `validatedAt` + `revalidateEvery` | calendar date + interval `/^[1-9][0-9]*[dwm]$/` |
| Evergreen | `lifecycle` + `lifecycleWhy` | literal `evergreen` + valid one-line reason scalar (canonical style double-quotes it) |

**Date validity** (applies to `reviewBy` and `validatedAt`): a value is a
valid date only if it (a) matches the lexical form `/^\d{4}-\d{2}-\d{2}$/`,
(b) is a real Gregorian calendar date (`2026-02-29` is invalid — 2026 is not a
leap year), and (c) has a year in `2000`–`2100` inclusive. A value failing any
of these is a **malformed fragment** (see *Malformed clauses and duplicate
keys* below), not a clause.

**Interval validity** (`revalidateEvery`): `/^[1-9][0-9]*[dwm]$/` — a positive
integer with **no leading zeros** plus a unit, so `0d` and `01m` are visibly
malformed.

### `expiresWhen` — condition-expiry

A single deterministically checkable condition; the memory is void the moment
it holds. Canonical writer style **double-quotes** the value (see *Accepted
syntax vs canonical writer style*): this contract's line-regex parser captures
an unquoted `expiresWhen: #2138 closes` literally — the `#` is NOT a comment
to it — but a real YAML parser would treat that `#` as a comment delimiter and
read an empty value, so quoting keeps the file correct under both readers.
After `stripQuotes`, bare and quoted values are recognized identically; an
empty or whitespace-only value is a malformed fragment.

Exactly **four** machine-recognized shapes are recognized — no more, no fewer —
so every conforming classifier recognizes an identical set. All four are matched
against the post-`stripQuotes` value, **case-sensitively**, with single ASCII
spaces (U+0020) as the only separators and no leading or trailing whitespace:

- **Issue-close** —
  `/^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)#([1-9][0-9]*) closes$/`
  True when that GitHub issue/PR is closed. `<owner>` is `[A-Za-z0-9-]+`,
  `<repo>` is `[A-Za-z0-9._-]+`, and `<n>` is a positive integer with no
  leading zeros. The trailing keyword is the literal lowercase ` closes`.
  The repository MUST be fully qualified: a bare `"#<n> closes"` is NOT
  recognized and falls through to free-text (→ `active`), because the memory
  store offers no deterministic issue-number → repository resolver — the
  `~/.claude/projects/<slug>` directory name is a one-way, **lossy** slug of
  the project cwd (`projectPathToSlug` in
  [`src/lib/project-slug.ts`](../src/lib/project-slug.ts): `/home/dev/acme-web`
  and `/home/dev/acme/web` slug identically, and a slug cannot be reversed to
  a path, let alone to a GitHub repo).
- **File-removed** — `/^file (~\/\.claude\/\S+) removed$/`, AND the captured
  path MUST NOT contain a `..` segment. Both checks are shape recognition, so
  `"file ~/.claude/../outside removed"` is NOT recognized and falls through
  to free-text (→ `active`) — the traversal escape is closed at the grammar
  level, before any filesystem contact. True when the path no longer exists
  under the memory store's `.claude` tree. The path MUST start with
  `~/.claude/` and MUST contain no whitespace; there is NO escaping
  mechanism — a path containing spaces does not match this shape and falls
  through to free-text. Any other path — absolute (`/...`), other `~/`
  paths, repo-relative — is NOT recognized and falls through to free-text
  (→ `active`). Why so narrow: `~/.claude` is the only host tree the
  canonical container deployment can see (`docker-compose.yml` mounts
  `${CLAUDE_DIR:-${HOME}/.claude}` at `/home/node/.claude`, read-only, and
  nothing else), so a broader path grammar would make existing host paths
  outside the mount *appear* removed — a false `expired`.
- **Rule graduation** —
  `/^promoted to CLAUDE\.md\/AGENTS\.md rule$/`.
  This is the agreed “lesson moved into standing instructions” condition. It
  names the destination class, not a network resource; verification is a local
  config-document scan described under *Graduation-state snapshot*.
- **Hook graduation** —
  `/^enforced by hook ([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/`.
  The capture is the exact hook script basename, including its extension when
  present (for example `cwd-anchor-guard.mjs`). Whitespace, paths, shell syntax,
  and aliases are not accepted as hook ids. Verification is a local settings
  and referenced-path scan described below.

All four shapes are evaluated through ingest-produced snapshots, never by the
detector itself: detector rules are synchronous and pure —
`rule: (input, now) => Recommendation | null` in
[`src/lib/detectors/types.ts`](../src/lib/detectors/types.ts), and the
engine's design notes pin "Pure: `buildRecommendations` depends only on its
argument. No I/O"
([`src/lib/recommendations.ts`](../src/lib/recommendations.ts)) — filesystem
stats are I/O just as much as GitHub lookups. The three snapshots live under
**`CHD_CACHE_DIR`** — the ingest cache-dir contract in
[`scripts/ingest.mjs`](../scripts/ingest.mjs)
(`process.env.CHD_CACHE_DIR || <claude-dir>/.cache/chd`, default
`~/.claude/.cache/chd/`), NOT a repo-relative `.cache/` path — so runtime
state survives plugin reinstalls and honors the operator's override.

**Shared snapshot freshness rule.** `LIFECYCLE_SNAPSHOT_TTL_MS` is exactly
`7 * 24 * 60 * 60 * 1000`. An entry is fresh only when `checkedAt` matches
`/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/`, denotes a real finite
UTC instant, and `0 <= now - checkedAt <= TTL`. A missing, invalid, or future
`checkedAt` is invalid, not fresh. No state — including terminal-
looking `closed`, `absent`, or graduation `verified` — may expire a memory
outside that window. Stale/invalid terminal-looking evidence yields `active`
plus a dated `unverifiable-stale`/`snapshot-invalid` diagnostic; it is never
silently reused. A finding cites the entry's `checkedAt` when present; malformed
or absent evidence explicitly records that the timestamp or entry was missing.

**Current authorization and cache coherence.** Snapshot freshness is necessary
but not sufficient: the recommendation input and every cache in front of it
must also describe the current process configuration, the lifecycle-bearing
memory bytes, the inputs from which the three snapshots are produced, and the
clock interval for which a classified recommendation remains true.

- `CHD_LIFECYCLE_GITHUB` is evaluated at **recommendation assembly time**,
  before a persisted issue snapshot or cached dataset can reach the detector.
  When its current value is not exactly `1`, assembly supplies `null` or a new
  in-memory `{ version: 1, enabled: false, entries: {} }`, performs no GitHub
  fetch, and does not read or trust `${CHD_CACHE_DIR}/lifecycle-github.json`.
  A persisted `enabled: true` is historical producer metadata, never current
  authorization. This flag-off override is unconditional, including when the
  cached entry is fresh.
- The normalized current flag value is part of the ingest/dataset and
  recommendation source signatures. Turning the flag off therefore invalidates
  any cached enabled input before classification; turning it on forces the
  gated producer path instead of reusing a disabled result.
- Each lifecycle snapshot that actually feeds the detector participates in
  both cache layers. The cheap `sourceSignature()` folds file existence plus
  stable identity/stat metadata (`ino`, `size`, `mtimeMs`, `ctimeMs`); the full
  content hash folds the same bytes the parser consumes, bounded by
  `ARTIFACT_CACHE_JSON_MAX_BYTES`. This applies to `lifecycle-files.json` and
  `lifecycle-graduation.json` always, and to `lifecycle-github.json` only while
  the current flag is enabled. Add, remove, atomic replace, or content change
  must invalidate `/api/recommendations.json` even when no memory or config
  file changed. When an ingest run itself refreshes a snapshot, it finalizes
  the cache key from the post-rename version and assembles recommendations from
  those same bytes; its own write must not guarantee a spurious miss on the
  next request.
- Snapshot writes use a temp file plus atomic rename. A failed/capped/malformed
  read becomes unavailable/error input and can never reuse an earlier
  terminal-looking row. The signature and parser must observe one file version;
  if a replacement races the read, retry or fail closed to unavailable rather
  than caching bytes under a different signature.

**Lifecycle-bearing memory inventory is one bounded captured input.** The
current `readMemoryStores()` implementation is **not** bounded for this
purpose: it materializes and sorts the whole `PROJECTS` directory and each
selected `memory/` directory, and `ARTIFACT_FILE_MAX_BYTES` limits one body but
not the number of names or aggregate bytes. #2235 MUST replace those
independent recommendation-path walks with one
`captureLifecycleMemoryInventory()` primitive. These production limits are
fixed contract values (tests may dependency-inject smaller values, but must
also assert the production values):

| Limit | Exact value |
| --- | ---: |
| Raw entries admitted from `PROJECTS` | 50,000 |
| Raw entries admitted from any one `memory/` directory | 50,000 |
| Raw directory entries admitted across the complete capture | 250,000 |
| Root `.md` candidates selected across all projects, including `MEMORY.md` | 50,000 |
| Bytes accepted from one selected file | 262,144 (256 KiB) |
| Bytes accepted across all selected file bodies | 4,194,304 (4 MiB) |

Enumeration uses `opendirSync()`/`Dir.readSync()` (or an equivalent streaming
directory API), closes the stream as soon as a limit is known to be crossed,
and never calls `readdirSync()` or otherwise materializes an unbounded listing.
It may read exactly one additional raw entry as a truncation probe: therefore
the absolute inspection ceilings are 50,001 for `PROJECTS`, 50,001 for one
`memory/` directory, and 250,001 across the capture. Probe entries are never
accepted. The global ceiling includes project-root entries, memory-directory
entries, and probes; when it is exhausted, no later directory is opened.

Within each captured window, eligible names are sorted by unsigned UTF-8 byte
order (`Buffer.compare`), never locale order. Projects are ordered by slug and
files by the `(slug, relative filename)` tuple. The first 50,000 `.md`
candidates in that order are the selected file set. Body reads then follow
that exact order. An oversized/unreadable/raced candidate contributes a stable
typed token and no bytes; when the next readable body would cross 4 MiB, it and
the remaining candidates contribute one aggregate-cap truncation token and no
later body is read. Thus a fixed captured directory window has one stable,
deterministic accepted subset and prefix, rather than four consumers applying
their own cutoffs.

The capture returns the selected identities plus an explicit internal
`LifecycleMemoryInventoryState`: `complete`, `truncated`, or `error`; exact
limits and observed/selected/file/byte counts; an ordered reason set
(`project-entry-cap`, `memory-entry-cap`, `total-entry-cap`, `file-count-cap`,
`file-byte-cap`, `aggregate-byte-cap`, `unreadable`, or `raced`); and a digest
of the ordered selected ids and typed tokens. Directory identity/stat metadata
and the presence of every truncation probe participate in that state. A cap,
permission failure, vanished entry, containment failure, or read race is never
reported as a complete inventory.

`readMemoryStores(capture)`, the memory portion of `sourceSignature()`,
`ingest().contentHash`, and `lifecycleProducerPreflight()` MUST consume that
same immutable capture object. They may not enumerate again or select a
different prefix. A cheap-hit attempt captures names and replacement-safe
stats only; if a rebuild is required, the full-read phase hydrates those same
selected identities and supplies the resulting bytes both to the hash and to
`parseMemoryFile`. A transition into or between truncation/error states moves
the cheap signature and full hash. While state is not `complete`, lifecycle
classification is fail-closed: no prior or newly carried-forward `expired`
row may be returned; affected memories are `active`/`unverifiable` with
`memory-inventory-truncated` provenance. `hit`, `hit-content`, persisted, and
stale-while-revalidate paths therefore cannot preserve terminal-looking rows
from an older complete or differently truncated subset.

**Lifecycle-bearing memory files are full content-hash inputs.** The ordinary
memory stat gate is not enough. `ingest().contentHash` MUST include the exact
ordered lifecycle inventory captured above, including `MEMORY.md` and every
selected root fact file. The broader memory-hygiene cache may additionally
hash the archive tier, but those files are not lifecycle-bearing inputs. For
every selected lifecycle file it hashes a domain-separated tuple of project
slug, relative filename, the exact finite `mtimeMs` projected to
`RawMemoryFile`/`AgentMemory.lastModifiedMs`, and the exact bytes passed to
`parseMemoryFile`. Typed unavailable/truncation tokens and the complete
inventory state are hashed too. The tuple encoding is length-delimited or
otherwise unambiguous.

The cheap signature covers the identical selected membership, inventory
state, and replacement-safe directory/file identity and stat fields
(`dev`/`ino`, `size`, exact `mtimeMs`, `ctimeMs`; no floored-mtime-only
shortcut). The full read opens/stats/reads/stats one file version; a changed
identity/size/time during that sequence is retried once or represented as
unavailable, never hashed under an unrelated stat. Consequently all of these
invalidate before a content-hash restamp:

- a same-size clause edit even if the writer restores the old mtime (bytes
  move the full hash and `ctimeMs`/identity moves the cheap gate);
- an mtime-only change (the cutover/touched classification consumes mtime);
- add/remove/rename or atomic replacement of a memory file.

It is forbidden for `sourceSignature()` to move on a memory edit while
`ingest().contentHash` omits those memory bytes and then restamps the old
recommendation entry as `hit-content`. The bytes used for the hash and the
bytes used to assemble `memoryStores` are one captured version, not two
independent reads that may race.

**Clock validity of recommendation results.** Lifecycle classifications are
time-dependent even when every source byte is unchanged. Every cache object
that can return, restamp, persist, or transfer a recommendation result MUST
carry this internal (not API-serialized) metadata:

```ts
interface LifecycleCacheValidity {
  /** Inclusive lower bound; must be finite. */
  builtAtMs: number;
  /** Exclusive upper bound; must be finite and greater than builtAtMs. */
  validBeforeMs: number;
}
```

For a build pinned to one finite `builtAtMs`, compute `validBeforeMs` as the
earliest of:

1. the next UTC midnight after `builtAtMs` (the earliest possible
   `reviewBy`/heartbeat state transition); and
2. `checkedAtMs + LIFECYCLE_SNAPSHOT_TTL_MS` for every valid issue, file, or
   graduation entry that is fresh at `builtAtMs` and participated in
   classification.

The second boundary is deliberately conservative by at most one millisecond:
the detector's freshness predicate remains inclusive (`now - checkedAt <=
TTL`), while cache reuse and producer refresh stop when `now >= checkedAt +
TTL`. This leaves no interval in which a terminal-looking cached result can be
served after its evidence should be rechecked. An invalid/future timestamp or
missing required entry makes the current build fail closed as already defined;
it does not contribute an infinite horizon.

The in-process response cache, the content-hash restamp path, the assembled
recommendation-dataset memo, the worker request/result protocol, and any
persisted dataset/recommendation row all apply the same two-sided predicate
before reuse:

```ts
Number.isFinite(now) &&
  Number.isFinite(validity.builtAtMs) &&
  Number.isFinite(validity.validBeforeMs) &&
  validity.builtAtMs <= now &&
  now < validity.validBeforeMs
```

The producer MUST also construct only intervals with `builtAtMs <
validBeforeMs`; malformed or empty intervals are non-reusable. A worker returns
the validity calculated from the exact snapshots it classified; the receiving
process applies the predicate at receipt, so a horizon crossed during the
build is rejected. `now < builtAtMs` is a clock rollback/future-built cache,
not a hit: it runs producer preflight and rebuilds with a newly pinned finite
`now`. It never returns the future-built body, including from a persisted row
restored on a host with an earlier clock or from stale-while-revalidate. At or
beyond the upper boundary the same rebuild rule applies. Time-insensitive
parsed inputs may be reused after preflight, but `hit`, `hit-content`, memo,
worker, persisted, or stale-while-revalidate paths may not bypass either side
of the interval. This rule applies even if the external-guidance cache clock
remains valid.

**Producer inputs and pre-cache-hit refresh.** Hashing
`lifecycle-files.json`, `lifecycle-graduation.json`, and
`lifecycle-github.json` only detects a producer that already ran; those output
hashes MUST NOT be used to decide whether their own producer needs to run.
Before any server, worker, or dataset recommendation cache can return a body,
a bounded `lifecycleProducerPreflight(now)` compares signatures derived from
the producer inputs below with the signatures from the last successful
attempt. The signatures may be stored in an atomic, versioned sidecar such as
`${CHD_CACHE_DIR}/lifecycle-producer-state.json`, but that sidecar and the
three lifecycle snapshot outputs are never inputs to these signatures.
Missing/malformed producer state forces the applicable producer; it never
authorizes reuse.

The preflight first uses the exact current
`captureLifecycleMemoryInventory()` object described above to derive the
sorted stable memory ids and recognized file, issue, rule, and hook references.
If the memory signature moved, it hydrates and reparses that capture's selected
identities before deriving dependencies; it does not enumerate a second time.
If it did not move, the prior bounded reference inventory may be reused only
when its inventory-state digest and exact limit values also match. A truncated
or errored capture applies the fail-closed rule above. It then covers these
exact input sets:

- **File-state producer:** the resolved `.claude` root identity and, for each
  recognized file target, every lexical path component from that root through
  the target. Record each existing component's `lstat` identity/stat, symlink
  text and contained realpath result; at the first missing component, record
  the missing suffix plus the nearest existing parent's identity, `mtimeMs`,
  and `ctimeMs`. Recreating a target or an intermediate directory therefore
  moves the signature through the parent's directory metadata. Escape, loop,
  permission, cap, and stat errors are explicit signature states and force an
  `error` row, never reuse of an old `absent` row.
- **Graduation producer, rules:** the deterministic candidate project-root
  set and each root's forward `projectPathToSlug` result; readable global
  `CLAUDE.md`/`AGENTS.md`; the uniquely matched project's root `CLAUDE.md`;
  and the complete bounded, realpath-contained directory inventory used to
  discover nested `AGENTS.md`, plus replacement-safe stats for and bounded
  bytes of each applicable document. Directory membership participates before
  the `CONFIG_RESOURCE_MAX_ENTRIES` cutoff, so adding/removing a nested marker
  file moves the signature; truncation itself is an explicit ambiguous input.
- **Graduation producer, hooks:** the global and uniquely matched project
  settings inputs that build both `liveConfig.settings` and
  `liveConfig.projectSettings`: replacement-safe stats and bounded bytes for
  `~/.claude/settings.json`, `~/.claude/settings.local.json`, and the uniquely
  matched root's `.claude/settings.json`/`.claude/settings.local.json`. This
  includes `disableAllHooks`, hook groups, and `referencedPaths`, plus every
  applicable referenced hook token's deterministic resolved path,
  ancestor/identity signature, and bounded body bytes. Resolution uses the
  same conservative `~`/`$HOME`/`$CLAUDE_PROJECT_DIR`/absolute-path rules that
  produced `referencedPaths`; an opaque or newly unresolvable token is an
  ambiguous input, not a preserved match. A settings edit, enable/disable
  change, referenced-path change, hook replacement, or marker-body edit
  therefore forces a new graduation row. Inputs from unrelated or slug-
  colliding project roots remain excluded exactly as classification requires.
- **Issue-state producer:** the normalized current
  `CHD_LIFECYCLE_GITHUB` value and sorted canonical issue references. While it
  is exactly `1`, each missing entry is due immediately and every existing
  `open`, `closed`, or `error` entry is due no later than
  `checkedAtMs + LIFECYCLE_SNAPSHOT_TTL_MS`; `now >=` the earliest due instant
  forces a fetch for every due reference before cache reuse. This scheduled
  fetch is the non-circular wake-up that can observe a reopened issue/PR when
  no local byte changed. A failed fetch overwrites that reference with a new
  `error` entry and cannot preserve its prior terminal-looking state.

A changed local dependency signature runs the corresponding local producer
synchronously before cache lookup. Local file/graduation entries also become
due at `checkedAtMs + LIFECYCLE_SNAPSHOT_TTL_MS`; the preflight rechecks those
references at the boundary even when their dependency signatures are
unchanged. A due enabled GitHub reference is fetched before cache lookup. The
producer atomically replaces its snapshot, then the ordinary snapshot
source/content hashes are finalized from that post-rename version and
recommendation assembly consumes those same bytes. If the preflight, refresh,
or post-write consistency check fails, the affected snapshot is
unavailable/error and the request rebuilds fail-closed classification; it MUST
NOT serve the previous `expired` body through the stale-while-revalidate path.
Recreated file targets become `present`, removed rule/hook markers become
`candidate`/`not-found`, disabled or unreadable hooks become ambiguous/error,
and reopened remote items become `open`, all without waiting for an unrelated
transcript or dataset mutation.

When `CHD_LIFECYCLE_GITHUB` is not exactly `1`, the issue-state branch of this
preflight performs zero fetches, does not read
`${CHD_CACHE_DIR}/lifecycle-github.json`, ignores any persisted issue producer
deadline/signature, and supplies the disabled/null input described above.
Local file and graduation preflight remain available because they use only
the already-mounted local tree. Thus the producer contract preserves the
flag-off byte path and the product's zero-external-call default.

The #2235 cache/producer tests are load-bearing acceptance criteria, not
optional performance tests. With every unrelated source held byte-identical,
they MUST prove:

1. a cached `active` `reviewBy`/heartbeat result rebuilds after UTC midnight;
2. a cached terminal-looking snapshot result cannot cross its TTL boundary:
   a successful due refresh supplies a new `checkedAt`, while an unavailable
   or failed refresh rebuilds to `active` with stale/error provenance;
3. a same-size lifecycle-clause edit with restored mtime, and a separate
   mtime-only cutover change, both move `contentHash` and classification;
4. recreating a referenced absent file, removing a rule marker, changing or
   disabling a referenced hook, and reopening an opted-in remote issue at its
   refresh deadline each fail closed before any old body is returned; and
5. the same GitHub cases with the flag off perform zero network calls and do
   not read or trust the persisted issue snapshot;
6. clock rollback rejects a future-built body in a four-case matrix: both an
   in-process entry and a serialized/persisted entry, each for (a) a result
   built after a UTC date transition and read after rollback to the prior date,
   and (b) an `expired` result built from terminal-looking snapshot evidence
   whose `checkedAt` becomes future-dated after rollback. Every case runs
   preflight and rebuilds at the rolled-back `now`; the latter becomes
   `active` with invalid/future-snapshot provenance; and
7. injected small-limit tests cover exactly-at-cap and cap-plus-one project,
   per-memory-directory, total-entry, file-count, per-file-byte, and aggregate-
   byte cases. The live reader, cheap signature, full hash, and producer
   preflight must report byte-for-byte identical ordered ids, state digest,
   counts, and truncation reasons from one capture. Transitioning from a
   complete capture to any truncation, and between two truncated accepted
   subsets, must discard a previously cached terminal-looking row before a
   body is returned. A separate assertion pins every production limit to the
   exact value in the table above.

Exercise both the in-process and worker-backed recommendation paths, including
the source-signature fast hit, content-hash restamp, assembled memo, and stale-
while-revalidate branches. A test that calls only the pure detector does not
cover this cache contract.

**File-state snapshot — no detector I/O (file-removed).**

- **Check (ingest-side, always on).** The ingest walk — local filesystem
  reading it already performs; no flag gates this — records state for every
  path referenced by a recognized file-removed condition. It resolves the
  `~/.claude/` prefix against the `.claude` tree it is actually reading
  (host `$HOME/.claude`; canonical container `/home/node/.claude`), never
  against a literal `$HOME` alone, then enforces **normalized containment**.
  Resolve the real root, reject lexical escapes, and walk the target from that
  root. Every existing ancestor (including any symlink) must resolve inside the
  real root. Only ENOENT reached after those ancestor checks records `absent`;
  an escape, loop, permission failure, or unverifiable ancestor records
  `error`. This prevents a missing target below an outward-pointing symlink
  from looking safely absent.
- **Snapshot.** `${CHD_CACHE_DIR}/lifecycle-files.json`, one entry per
  referenced path:
  the versioned `LifecycleFileStateSnapshot` shape above.
  Root missing or unreadable → `root-unavailable` for every path. Clean
  ENOENT on the target with the root verified → `absent`; target exists →
  `present`; any other failure (permissions, I/O, containment escape) →
  `error`. A failed current check overwrites any previous `absent` row with
  `error`; producers must not preserve a formerly terminal-looking value after
  a newer failed attempt.
- **Classify (detector-side, snapshot only).** The detector reads only
  `fileStateSnapshot`. A **fresh** `absent` entry is the ONLY file path to
  `expired`; fresh `present` is `active`. Fresh `root-unavailable`/`error`, a
  missing snapshot/entry, an invalid timestamp, or ANY stale state is
  unverifiable → `active`, never `expired`. Missing/error/invalid/stale states
  are flagged with their exact `checkedAt` when one exists. A stale `present`
  remains non-expiring but is still stale evidence; all states follow the same
  freshness rule so future consumers cannot accidentally privilege one branch.

**Issue-state snapshot — no detector I/O (issue-close).**

- **Fetch (ingest-side, gated).** An ingest/refresh step — not the detector —
  fetches issue state, and ONLY when the operator has opted in with
  `CHD_LIFECYCLE_GITHUB=1` (the repo's local-first rule, `AGENTS.md`
  *Local-first by default*). With the flag unset or set to any other value,
  NO network request of any kind is made — a hard guarantee, not
  best-effort. It fetches only the fully-qualified `owner/repo#n` references
  present in parsed `expiresWhen` conditions.
- **Snapshot.** `${CHD_CACHE_DIR}/lifecycle-github.json`:
  the versioned `LifecycleIssueStateSnapshot` shape above.
  `enabled` records the producer state as of that ingest run, which lets an
  enabled assembly distinguish never-fetched from a per-reference failure; it
  does **not** authorize reuse when the current flag is off. The assembly-time
  override and cache-key rule above always win. A fetch failure leaves the
  ingest run healthy but writes an `error` entry for that reference; it must
  not leave a prior `closed` value looking current. The snapshot is supplied
  through `issueStateSnapshot`; the detector reads only that current-authorized
  view.
- **Classify (detector-side, snapshot only).** Apply the shared 7-day TTL to
  **every** entry state:
  - `enabled: false`, or no snapshot at all → EVERY issue-close condition is
    unverifiable → `active`, **regardless of any cached entries** — opting
    out revokes stale trust: a cached `closed` is NOT honored while the flag
    is off, because the operator has withdrawn the verification channel and
    nothing may keep expiring on old data. Silent, not flagged.
  - `enabled: true` + fresh entry `closed` → the condition holds → `expired`.
  - `enabled: true` + fresh entry `open` → `active`.
  - `enabled: true` + fresh entry `error` → *unverifiable-error* → `active` +
    flagged with `errorCode` and `checkedAt`.
  - `enabled: true` + stale `open`, `closed`, or `error` →
    *unverifiable-stale* → `active` + flagged. A reopened issue or closed-
    unmerged PR therefore cannot remain expired from an arbitrarily old row.
  - `enabled: true` + invalid/missing/future `checkedAt` →
    *snapshot-invalid* → `active` + flagged.
  - `enabled: true` + NO entry for the reference → *never-fetched* →
    `active` + flagged (distinguishable from opt-out precisely because
    `enabled` travels in the snapshot).

  `checkedAt` supplies the finding's as-of provenance.

**Graduation-state snapshot — local inference, never detector I/O.**

Graduation has intentionally different proof semantics from issue/file state:
a phrase or hook-name match can suggest redundancy but does not prove that the
standing rule or hook fully subsumes the memory. An ingest-side local scanner
therefore writes `${CHD_CACHE_DIR}/lifecycle-graduation.json` using the exact
`LifecycleGraduationStateSnapshot` type above. It makes zero network calls.

- **Resolve project scope first.** For a lifecycle-bearing root fact, the entry
  key is `<project>/<file>` and contains exactly one slash; call that complete
  string the version-1 stable memory id. Archive facts are not admitted to this
  snapshot. Start with the same deterministic,
  readable project-root set used to assemble `liveConfig`. Forward-map every
  root with `projectPathToSlug(root)` and retain roots equal to
  `ProjectMemoryStore.project`; never reverse the lossy slug. Exactly one match
  establishes the applicable project root. Zero matches or more than one match
  makes all project-scoped evidence `ambiguous` and unable to verify expiry.
  Global sources remain global; a document, setting, or hook from an unrelated
  project root is ignored, even when it contains the memory marker.
- **Rule graduation.** Applicable global sources are the readable global
  `CLAUDE.md` and `AGENTS.md`. With exactly one matched project root, applicable
  project sources are its root `CLAUDE.md` plus every root-contained file named
  `AGENTS.md`, including nested directory-scoped files. The nested walk is
  lexicographically deterministic, bounded by `CONFIG_RESOURCE_MAX_ENTRIES`,
  reads each candidate through `CONFIG_FILE_MAX_BYTES`, and enforces realpath
  containment; it never follows an outward directory/file symlink. A truncated,
  escaped, or unreadable walk cannot produce a negative proof and records
  `ambiguous`/`error`. A safe applicable destination containing the exact
  Markdown marker `<!-- memory-source: <memory-id> -->` is `verified`; the same
  marker in an unrelated or slug-colliding project is never evidence.
  Without that marker, normalize both document and memory `description` with
  JavaScript `normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ')`.
  An exact occurrence of a normalized description at least 24 Unicode code
  points long is only `candidate`; a shorter/empty description is `ambiguous`,
  never a match. Evidence stores `sha256:<lowercase hex>` of the normalized
  UTF-8 description, not the description itself. Candidate matching uses only
  those same applicable sources.
- **Hook graduation.** A hook can verify only after project scope resolves to
  exactly one root and hooks are effectively enabled. The implementation
  preserves `LiveSettings.disableAllHooks` in both settings surfaces. If
  `liveConfig.settings.disableAllHooks === true` **or**
  `liveConfig.projectSettings[matchedRoot]?.disableAllHooks === true`, neither
  a global nor project hook is enforcement for that memory: any name/marker
  match stays `candidate`/`ambiguous`, never `verified`. An applicable settings
  file that exists but is unreadable/malformed, or an unresolved/colliding
  project scope, likewise fails closed; an absent project settings file simply
  contributes no project hooks and no project-local disable override.

  Search the effective global groups at
  `liveConfig.settings.hooks[event][group].hooks[hook]` and the matched project
  groups at
  `liveConfig.projectSettings[matchedRoot].hooks[event][group].hooks[hook]`.
  `<hook-id>` must equal the basename of exactly one applicable
  `referencedPaths[].path` across both surfaces. Paths from unrelated projects
  do not participate; multiple applicable matches are ambiguous. If that one
  referenced hook file also contains a full line matching
  `/^\s*(?:#|\/\/)\s*memory-source: <memory-id>\s*$/m`, state is `verified`;
  this uses a language-valid `#` or `//` line comment instead of putting an
  invalid HTML comment into executable code. An exact unique basename match
  without that marker is only `candidate`.
  Zero applicable matches → `not-found`; disabled hooks, several matches, an
  unreadable referenced file, incomplete config traversal, or an
  identity that cannot be derived without interpreting shell syntax →
  `ambiguous`/`error`, never verified.
- Evidence rows record the config path/field and the matched marker,
  normalized-description hash, or hook referenced path. Do not persist config
  or memory bodies in the snapshot.
- Fresh `verified` means the condition holds and may classify `expired`.
  Fresh `candidate` leaves lifecycle state `active` and emits a separate,
  recommend-only `graduation-candidate` diagnostic with explicitly inferential
  wording. This is a detector-side recommendation signal, not a
  `MemoryLifecycleDiagnosticCode` parser value. `not-found`, `ambiguous`,
  `error`, missing entries, invalid times,
  and stale entries all remain `active`; error/ambiguous/invalid/stale states
  are flagged, and no prior `verified` row is reused after a failed scan.

This preserves the grooming decision's lower-confidence phrase-match path
without turning a fuzzy match into destructive expiry. The marker supplies a
deterministic graduation path for future promotions.

Any other value is a free-text condition: it must still name ONE observable
condition a human or agent can check in a single step. Classifiers treat an
unrecognized condition as *not verifiable* — the memory stays `active` (never
auto-`expired`) and may be surfaced for manual checking.

### `reviewBy` — time-decay

A calendar date per Date validity above, written as a plain (unquoted) scalar.
The memory is trustworthy through that date and `due-for-review` after it.

### `validatedAt` + `revalidateEvery` — heartbeat

Both fields are required together; one without the other is a **malformed
fragment** — skipped and flagged per *Malformed clauses and duplicate keys*
below, so it never counts as a clause and never blocks another valid clause
from governing.

- `validatedAt`: a calendar date per Date validity above — the last day the
  fact was actually re-verified. Re-validating a memory means setting this to
  today.
- `revalidateEvery`: `/^[1-9][0-9]*[dwm]$/` per Interval validity above — a
  positive integer (no leading zeros) plus a unit. Units use **fixed
  conversions** so classification is deterministic with no calendar
  arithmetic: `d` = 1 day, `w` = 7 days, `m` = 30 days. Examples: `30d`, `6w`,
  `3m`.

The memory is `heartbeat-stale` when today > `validatedAt` + interval.

### `lifecycle: evergreen` + `lifecycleWhy` — explicit escape hatch

`lifecycle` has exactly one valid value, the literal `evergreen`; every other
value is reserved and invalid. It requires a valid `lifecycleWhy` one-line
scalar. Canonical writer style double-quotes it; accepted syntax may be bare,
single-quoted, or double-quoted only when this algorithm succeeds:

1. Let `t = raw.trim()`. Reject empty `t` or any CR/LF.
2. If `t` starts with `'` or `"`, require the same quote as its FINAL
   character. Nothing — including an inline comment — may follow that closing
   quote. Remove exactly those two outer quotes. A starting quote without that
   exact final mate is invalid.
3. For a bare scalar, reject a leading `|` or `>` (including YAML block-marker
   variants) and reject `#` at the start or preceded by whitespace; quoted
   scalars may contain `#` inside their closing quote.
4. Trim the decoded value and require at least one non-whitespace character.
5. Case-insensitively reject these placeholder values:
   `todo`, `tbd`, `fixme`, `placeholder`, `unknown`, `none`, `null`, `n/a`,
   `na`, `-`, `?`, `...`, and any value consisting only of one angle-bracketed
   placeholder such as `<why>`.

Consequently `lifecycleWhy: |`, `lifecycleWhy: >-`, `lifecycleWhy: ""`,
`lifecycleWhy: "" # TODO`, `lifecycleWhy: # TODO`, and
`lifecycleWhy: "TBD"` are all malformed. A real explanation such as
`lifecycleWhy: "user-set security policy; only the user retires it"` is valid.
`lifecycle: evergreen` without `lifecycleWhy`
(or `lifecycleWhy` alone, or a non-`evergreen` `lifecycle` value) is a
**malformed fragment** — skipped and flagged per the rule below; it is not a
clause.

## Malformed clauses and duplicate keys

A **malformed fragment** is any lifecycle key (or key pair) that fails its
grammar: half a heartbeat pair, `lifecycle: evergreen` without `lifecycleWhy`
(or `lifecycleWhy` alone), a `lifecycle` value other than `evergreen`, an
empty or whitespace-only value (after `stripQuotes`) for any lifecycle key, a
`lifecycleWhy` rejected by the strict scalar algorithm, a date failing Date
validity, or an interval failing Interval validity. ONE rule governs
everywhere:

- A malformed fragment **poisons nothing**: the classifier skips it and flags
  it, and classification proceeds over the remaining VALID clauses by
  precedence.
- A file whose only lifecycle keys are malformed fragments has no valid
  clause: it classifies `unclassified-legacy`, with the fragments flagged
  (unlike a pre-convention file, which is silent — see Classification).

**Duplicate keys:** if the same lifecycle key appears more than once in the
frontmatter, the **first occurrence wins** and the duplicates are flagged.
This adopts the parser's documented duplicate-safe precedent: `parseMemoryFile`
in `parse-memories.ts` guards `type:` so its first occurrence wins ("Take the
first occurrence") — note its unguarded legacy fields (`name:`,
`description:`) overwrite on re-match instead, which is exactly why this
contract pins first-wins explicitly for lifecycle keys. **Key presence — not
value validity — decides the winner** (this is why the matcher captures
`(.*)`): the winning occurrence is validated afterwards and may itself be a
malformed fragment. Worked case: a bare `reviewBy:` line (empty value)
followed by `reviewBy: 2026-10-01` — the empty FIRST occurrence wins the key
and is a malformed fragment (skipped + flagged), and the valid-looking second
line is a flagged duplicate, never the governing value; the file has no valid
time-decay clause.

## Precedence

The convention is **exactly one clause per file**. When several appear, a
classifier resolves by the first **valid** clause present in this order
(malformed fragments are skipped per the rule above):

1. `expiresWhen`
2. `reviewBy`
3. `validatedAt` + `revalidateEvery`
4. `lifecycle: evergreen`

The governing clause drives classification; a multi-clause file is still
classified (never rejected) but SHOULD be flagged as a convention violation.

## Classification

The state enum a detector emits, evaluated against "today" as a UTC calendar
date. Date comparisons are strict (`>`): the named day itself is still
in-date.

| State | Condition |
| --- | --- |
| `expired` | governing `expiresWhen` condition verified true from a fresh snapshot |
| `due-for-review` | governing `reviewBy` and today > `reviewBy` |
| `heartbeat-stale` | governing valid pair and today > `validatedAt` + interval |
| `evergreen` | governing `lifecycle: evergreen` with `lifecycleWhy` |
| `active` | a valid clause governs and is not triggered (includes unverifiable/stale/error conditions and graduation candidates) |
| `unclassified-legacy` | no valid clause: a pre-convention file (no lifecycle keys at all), or every lifecycle key present is a malformed fragment |

### Grandfathering and `missing-lifecycle-clause`

The enforcement cutover is the merge instant of the writer-facing convention,
shpwrck/claude PR #156:

```ts
export const MEMORY_LIFECYCLE_CUTOVER_MS =
  Date.parse('2026-07-13T03:15:39.000Z');
```

This is deliberately a fixed contract constant, not “the first detector run”
or a deployment-local time. `AgentMemory.lastModifiedMs` is the touched signal:

- No lifecycle keys and a finite `lastModifiedMs >= CUTOVER` → state remains
  `unclassified-legacy`, but #2235 MUST emit `missing-lifecycle-clause` with
  provenance citing `file`, `lastModifiedMs`, the fixed cutover, and
  `lifecycle.fields` being empty.
- No lifecycle keys and finite `lastModifiedMs < CUTOVER` → grandfathered
  `unclassified-legacy`, silent.
- Missing/non-finite `lastModifiedMs` → age unknown; conservatively
  grandfathered and silent. The detector must not guess that an SPA upload or
  old cached payload is new.
- Any lifecycle key present but no valid clause → emit the specific malformed
  diagnostics instead of an additional missing-clause finding, regardless of
  mtime. This prevents two findings for one attempted but invalid contract.

The live recommendation producer `readMemoryStores()` in `scripts/ingest.mjs`
must stat each fact file and pass `mtimeMs` into `RawMemoryFile`, just as the
live `readMemories()` route already does; `parseMemoryFile` continues projecting
that exact value to `lastModifiedMs`. Do not substitute `ctime`, directory mtime,
ingest time, or Git time. A restored/copied file whose preserved mtime predates
the cutover stays conservatively grandfathered; this signal favors avoiding
false accusations over perfect recall.

Thus `unclassified-legacy` is not itself an error. It is silent for provably
old or age-unknown files, paired with `missing-lifecycle-clause` for a
post-cutover clause-less file, or paired with precise parse diagnostics for a
file that attempted only malformed fragments.

## Worked examples

All four evaluated with today = `2026-07-13`.

### 1. Condition-expiry, condition now true → `expired`

```yaml
---
name: quadlet-autostart-missing
description: "Dashboard container does not survive reboot — no Quadlet unit yet"
expiresWhen: "shpwrck/claude-history-dashboard#1234 closes"
metadata:
  node_type: memory
  type: project
---
```

`expiresWhen` governs (highest precedence, only clause). The condition matches
the recognized issue-close shape (fully qualified — a bare `"#1234 closes"`
would be free-text). The snapshot at `${CHD_CACHE_DIR}/lifecycle-github.json`
carries `enabled: true` and `{ state: "closed", checkedAt:
"2026-07-10T12:00:00Z" }`, so the detector — reading only
`issueStateSnapshot` — classifies `expired`. A `closed` row checked on
`2026-07-01` is stale and therefore `active` + flagged, not expired. Fresh
`open`: `active`; stale `open`: `active` + flagged unverifiable-stale. A fresh
`error` row is `active` + flagged unverifiable-error. `enabled: true` with no
entry is `active` + flagged never-fetched. `enabled: false` (the default — flag
off, no fetch, no network call) is `active`, regardless of any cached entry.
If the condition were free-text: `active`, surfaced for manual review.

### 2. Heartbeat, overdue → `heartbeat-stale`

```yaml
---
name: truenas-access-path
description: "Reach NAS 192.168.17.1 by jumping through the UDM (root@192.168.1.1)"
validatedAt: 2026-03-01
revalidateEvery: 90d
metadata:
  node_type: memory
  type: project
---
```

Valid pair; deadline = `2026-03-01` + 90 days = `2026-05-30`. Today
(`2026-07-13`) > `2026-05-30`, so `heartbeat-stale`: the fact needs
re-verification, after which the writer bumps `validatedAt` to today. Had
`revalidateEvery: 90d` appeared without `validatedAt`, that fragment would be
skipped and flagged; with no other valid clause in the file, it would classify
`unclassified-legacy`. Had the file ALSO carried a valid `reviewBy`, the
fragment would still be flagged but `reviewBy` would govern.

### 3. Pre-convention file → `unclassified-legacy`

```yaml
---
name: feedback-subagent-fan-out
description: "Fan out subagents from the top-level session; never nest"
metadata:
  node_type: memory
  type: feedback
---
```

No lifecycle key at all — a grandfathered legacy memory. Classified
`unclassified-legacy` without a finding only when its `lastModifiedMs` is before
`2026-07-13T03:15:39.000Z` or unavailable. If its mtime is at/after the
cutover, the same content emits `missing-lifecycle-clause`. The writer
convention requires adding a clause the next time this file is edited for any
reason.

### 4. Hook graduation, inferential match → `active` + candidate

```yaml
---
name: cwd-anchor-bash-discipline
description: "Anchor every git and gh command to the intended repository"
expiresWhen: "enforced by hook cwd-anchor-guard.mjs"
metadata:
  node_type: memory
  type: feedback
---
```

If a fresh graduation snapshot resolves one applicable project, finds no
applicable `disableAllHooks: true`, and finds exactly one applicable
referenced path whose basename is `cwd-anchor-guard.mjs` but no memory-source
marker in that hook file, the memory stays `active` and emits only the demoted,
recommend-only `graduation-candidate` diagnostic. If the hook file also
contains `// memory-source: <project>/cwd-anchor-bash-discipline.md` as its own
line, a fresh `verified` row makes the condition true and the memory `expired`.
A stale `verified` row, disabled/unreadable hook, unresolved/colliding project,
or multiple applicable basename matches is never expiry. Rule graduation uses
the same marker/candidate distinction over global instructions and the uniquely
matched root `CLAUDE.md` plus root-contained nested `AGENTS.md`; unrelated
project documents never count.

## Rollout and grandfathering

- **New/touched memories**: the writer convention (the `shpwrck/claude`
  `CLAUDE.md` section) requires exactly one clause. The detector enforces this
  only when the file's `lastModifiedMs` is at/after the fixed cutover.
- **Existing memories**: no mass rewrite. A provably pre-cutover or age-unknown
  clause-less file stays silent `unclassified-legacy`; editing it advances
  mtime, so omitting the required clause becomes detectable.
- **Detectors**: the #2233 children code against this document. Field names,
  grammars, precedence, and the state enum above are fixed; extending the
  schema (new clause forms, new recognized `expiresWhen` shapes) is additive
  and must keep older parsers safe.

## Writer-twin parity record

The original writer twin at `shpwrck/claude` merge
`a608b1893b7c9b3618f1a2b9cabc4ca3a163278b` predates the review corrections in
this revision. Companion [PR #160](https://github.com/shpwrck/claude/pull/160),
merged as `d5c7ac299668d165f94d4bd04abae2ffcb405623`, brought its **Memory
lifecycle** section into parity. The verified shared scope is:

1. The writer now defines the four recognized `expiresWhen` shapes with the
   exact grammars in this document, including both graduation forms and the exact
   hook-id restrictions.
2. The writer now defines `lifecycleWhy` with the strict scalar
   algorithm and rejected block/comment/placeholder examples above.
3. Rule graduation now requires the exact Markdown marker
   `<!-- memory-source: <project>/<file> -->`; hook graduation requires a
   language-valid full-line `# memory-source: <project>/<file>` or
   `// memory-source: <project>/<file>` marker. The writer states that a
   phrase/hook-name match without the appropriate marker is only a
   recommendation candidate, not verified expiry.
4. The writer retains the “new memories and touched existing memories require
   one clause” rule and identifies the dashboard's fixed enforcement cutover as
   `2026-07-13T03:15:39.000Z` so writer and detector use the same boundary.
5. The shared version-1 scope is root fact filenames only. Neither document
   treats `archive/<file>.md` as a lifecycle memory id; adding archive lifecycle
   support requires a coordinated writer-twin and stable-id contract revision.

Snapshot type names, TTL/error behavior, and `RecommendationInput` wiring are
dashboard-only detector seams and do not belong in the writer-facing twin.
With the five shared bullets landed in both repositories, this document remains
authoritative for #2235's detector-only seams and the writer/parser contracts
are in parity.
