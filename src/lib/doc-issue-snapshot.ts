/**
 * doc-issue-snapshot.ts — BROWSER-SAFE schema, validation, state normalization,
 * and freshness helpers for the OPT-IN GitHub issue-state snapshot (#2710, epic
 * #2256).
 *
 * The doc graph records exact `issue:<n>` edges, but the recommendation engine
 * has no trustworthy issue-state oracle: a detector cannot prove a documentation
 * reference is nonexistent, or that an explicitly owned draft is closed, without
 * a non-local, freshness-bounded carrier. This module is the SCHEMA half of that
 * carrier — the pure types, strict validation, GitHub-state normalization, and
 * freshness predicates that BOTH the server producer and the (absence-tolerant)
 * consumer share.
 *
 * The NODE half — the GraphQL `fetch`, credential read, SSRF guards, byte/record
 * caps, atomic cache, and single-flight refresh — lives in the server-only
 * `doc-issue-fetch.ts`. Keeping this file free of any `node:*` import lets the
 * detector types and the SPA `api-client` reference the snapshot type without
 * dragging Node code (or a credential path) into the browser bundle.
 *
 * FAIL-CLOSED is the whole contract: only a COMPLETE snapshot is ever persisted
 * or trusted, a snapshot is bound to the EXACT ref set it resolved (any ref
 * added or removed invalidates it), and absence (`not-found`) is only ever an
 * explicit resolution, never the mere lack of a record.
 *
 * BROWSER-SAFE: never add a `node:*` (or other non-portable) import here.
 *
 * Issues: #2710 (epic #2256 — doc artifact hygiene)
 */

/**
 * Normalized lifecycle state of a referenced issue/PR, or a PROVEN absence.
 * `not-found` is emitted only for an explicit null GraphQL alias on an otherwise
 * complete, error-free response — never inferred from a missing record.
 */
export type DocIssueState = 'open' | 'closed' | 'not-found';

/** One resolved reference: the issue/PR number and its normalized state. */
export interface DocIssueRecord {
  /** The referenced GitHub issue/PR number (a positive integer). */
  number: number;
  /** Normalized state; `not-found` means the number resolved to a null node. */
  state: DocIssueState;
}

/**
 * A COMPLETE, freshness-bounded snapshot of issue state for a FIXED ref set.
 * Never carries the credential. Only complete snapshots are ever serialized, so
 * `complete` is always `true` on the wire — an incomplete refresh is dropped in
 * the fetcher and never reaches this shape.
 */
export interface DocIssueSnapshot {
  /** `owner/repo` the refs were resolved against (lowercased, validated slug). */
  repo: string;
  /** The EXACT sorted, unique issue numbers this snapshot resolved. */
  refs: number[];
  /** Per-number normalized state; exactly one record per `refs` entry. */
  records: DocIssueRecord[];
  /** ISO 8601 instant the complete snapshot was produced (its "as of" clock). */
  asOf: string;
  /** Always `true`: only complete snapshots are persisted or carried. */
  complete: true;
  /** `sha256(repo + sorted ref set)` — binds the snapshot to its exact refs. */
  fingerprint: string;
}

// ── Freshness windows (FIXED; #2710) ────────────────────────────────────────
//
// Two tiers, deliberately small and deterministic:
//  - REUSE: a complete snapshot younger than 15 minutes is reused as-is; at or
//    past 15 minutes the server may make ONE single-flight refresh attempt.
//  - MAX-USABLE: after a FAILED refresh the last complete snapshot stays usable
//    through 24 hours; past 24 hours it is null and no surface may retain it.

/** A complete snapshot younger than this is reused without a refresh. */
export const DOC_ISSUE_REUSE_MS = 15 * 60 * 1000;
/** The oldest a complete snapshot may be and still be usable at all. */
export const DOC_ISSUE_MAX_USABLE_MS = 24 * 60 * 60 * 1000;
/** Hard schema cap: snapshots above this size are never trusted or persisted. */
export const DOC_ISSUE_MAX_REFS = 1000;

/**
 * Age of a snapshot at `nowMs`, or `null` when `asOf` is unparseable OR lies in
 * the future (clock skew) — either makes the snapshot untrustworthy, so callers
 * treat a `null` age as "not reusable, not usable, refresh-eligible".
 */
export function docIssueSnapshotAgeMs(
  snapshot: Pick<DocIssueSnapshot, 'asOf'>,
  nowMs: number
): number | null {
  const asOfMs = Date.parse(snapshot.asOf);
  if (!Number.isFinite(asOfMs)) return null;
  const age = nowMs - asOfMs;
  return age >= 0 ? age : null;
}

/** True when the snapshot is young enough to reuse without a refresh (< 15m). */
export function isDocIssueSnapshotReusable(
  snapshot: Pick<DocIssueSnapshot, 'asOf'>,
  nowMs: number
): boolean {
  const age = docIssueSnapshotAgeMs(snapshot, nowMs);
  return age !== null && age < DOC_ISSUE_REUSE_MS;
}

/** True when a refresh attempt is allowed (age >= 15m, or an untrustworthy age). */
export function isDocIssueSnapshotRefreshEligible(
  snapshot: Pick<DocIssueSnapshot, 'asOf'>,
  nowMs: number
): boolean {
  const age = docIssueSnapshotAgeMs(snapshot, nowMs);
  return age === null || age >= DOC_ISSUE_REUSE_MS;
}

/** True when a complete snapshot may still be USED at all (age <= 24h). */
export function isDocIssueSnapshotUsable(
  snapshot: Pick<DocIssueSnapshot, 'asOf'>,
  nowMs = Date.now()
): boolean {
  const age = docIssueSnapshotAgeMs(snapshot, nowMs);
  return age !== null && age <= DOC_ISSUE_MAX_USABLE_MS;
}

/**
 * The next freshness boundary (epoch ms) a consumer's cache key must not outlive
 * — the instant the snapshot becomes refresh-eligible (`asOf + 15m`). Included
 * in `sourceSignature`/`contentHash` so a served response re-validates the moment
 * the snapshot is eligible to change. `null` when `asOf` is unparseable.
 */
export function docIssueSnapshotFreshnessBoundaryMs(
  snapshot: Pick<DocIssueSnapshot, 'asOf'>
): number | null {
  const asOfMs = Date.parse(snapshot.asOf);
  if (!Number.isFinite(asOfMs)) return null;
  return asOfMs + DOC_ISSUE_REUSE_MS;
}

/**
 * Last epoch millisecond at which a snapshot is usable. The boundary is
 * inclusive: callers must suppress it only when `nowMs > usableThrough`.
 */
export function docIssueSnapshotUsableThroughMs(
  snapshot: Pick<DocIssueSnapshot, 'asOf'>
): number | null {
  const asOfMs = Date.parse(snapshot.asOf);
  if (!Number.isFinite(asOfMs)) return null;
  const usableThrough = asOfMs + DOC_ISSUE_MAX_USABLE_MS;
  return Number.isFinite(usableThrough) ? usableThrough : null;
}

/**
 * Canonical browser-safe identity for detector-visible snapshot state. This is
 * deliberately a deterministic string rather than a digest: the browser-safe
 * schema module must not import Node crypto, while cache gates still need every
 * claim-bearing field (including record order/state and freshness) represented.
 */
export function docIssueSnapshotIdentity(snapshot: DocIssueSnapshot): string {
  return JSON.stringify({
    repo: snapshot.repo,
    refs: snapshot.refs,
    records: snapshot.records.map(({ number, state }) => [number, state]),
    asOf: snapshot.asOf,
    fingerprint: snapshot.fingerprint,
  });
}

// ── State normalization ─────────────────────────────────────────────────────

/** GitHub `IssueState` (OPEN | CLOSED) → `open`/`closed`, or `null` if unknown. */
export function normalizeIssueState(raw: unknown): 'open' | 'closed' | null {
  if (typeof raw !== 'string') return null;
  switch (raw.toUpperCase()) {
    case 'OPEN':
      return 'open';
    case 'CLOSED':
      return 'closed';
    default:
      return null;
  }
}

/**
 * GitHub `PullRequestState` (OPEN | CLOSED | MERGED) → `open`/`closed`, or `null`
 * if unknown. A MERGED PR normalizes to `closed` (a merged reference is not open).
 */
export function normalizePullRequestState(raw: unknown): 'open' | 'closed' | null {
  if (typeof raw !== 'string') return null;
  switch (raw.toUpperCase()) {
    case 'OPEN':
      return 'open';
    case 'CLOSED':
    case 'MERGED':
      return 'closed';
    default:
      return null;
  }
}

/**
 * Normalize a resolved GraphQL node's `__typename` + `state` to `open`/`closed`,
 * or `null` when the typename/state is unrecognized (a malformed node the
 * fetcher must treat as incomplete, never as `not-found`).
 */
export function normalizeIssueOrPrState(
  typename: unknown,
  state: unknown
): 'open' | 'closed' | null {
  if (typename === 'Issue') return normalizeIssueState(state);
  if (typename === 'PullRequest') return normalizePullRequestState(state);
  return null;
}

// ── Ref-set canonicalization + validation ───────────────────────────────────

/** Sorted, de-duplicated positive integers — the canonical ref-set form. */
export function canonicalRefSet(refs: Iterable<number>): number[] {
  const set = new Set<number>();
  for (const n of refs) {
    if (Number.isInteger(n) && n > 0) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

/** A `owner/repo` slug of the exact shape GitHub accepts (segments 1–100 chars). */
const REPO_SLUG_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

/** True when `value` is a syntactically valid, lowercased `owner/repo` slug. */
export function isValidRepoSlug(value: unknown): value is string {
  return typeof value === 'string' && REPO_SLUG_RE.test(value) && value === value.toLowerCase();
}

function isDocIssueState(value: unknown): value is DocIssueState {
  return value === 'open' || value === 'closed' || value === 'not-found';
}

const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

/** Optional caller-bound identity checks layered onto structural validation. */
export interface DocIssueSnapshotExpectation {
  repo?: string;
  refs?: readonly number[];
  /** A caller-recomputed SHA-256 for `repo + "\\n" + refs.join(",")`. */
  fingerprint?: string;
}

function sameRefs(left: readonly number[], right: readonly number[]): boolean {
  return left.length === right.length && left.every((number, index) => number === right[index]);
}

/**
 * Strictly validate a raw value as a COMPLETE {@link DocIssueSnapshot}, or
 * return `null`. Enforces every fail-closed invariant so a malformed or tampered
 * cache can never masquerade as a complete snapshot: a valid lowercased slug, a
 * sorted-unique positive-integer ref set, EXACTLY one recognized-state record
 * per ref (record numbers === refs, no extras, no gaps), an ISO-8601 `asOf`,
 * `complete === true`, and a lowercase 64-hex fingerprint. Optional expectations
 * bind the parsed snapshot to a caller's exact canonical repo/ref identity and
 * caller-recomputed fingerprint. Pure and total.
 */
export function validateDocIssueSnapshot(
  raw: unknown,
  expected: DocIssueSnapshotExpectation = {}
): DocIssueSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.complete !== true) return null;
  if (!isValidRepoSlug(obj.repo)) return null;
  if (typeof obj.fingerprint !== 'string' || !FINGERPRINT_RE.test(obj.fingerprint)) return null;
  if (typeof obj.asOf !== 'string' || !ISO_INSTANT_RE.test(obj.asOf)) return null;
  const asOfMs = Date.parse(obj.asOf);
  if (!Number.isFinite(asOfMs)) return null;
  try {
    // Date.parse normalizes some impossible calendar/clock values instead of
    // rejecting them (for example, February 31 or a 24:00 rollover). The
    // producer always emits canonical toISOString() output, so require an exact
    // round trip before this timestamp may control a trust/freshness window.
    if (new Date(asOfMs).toISOString() !== obj.asOf) return null;
  } catch {
    return null;
  }

  if (!Array.isArray(obj.refs)) return null;
  const refs = obj.refs;
  if (refs.length > DOC_ISSUE_MAX_REFS) return null;
  for (let i = 0; i < refs.length; i += 1) {
    const n = refs[i];
    if (!Number.isInteger(n) || (n as number) <= 0) return null;
    if (i > 0 && (n as number) <= (refs[i - 1] as number)) return null; // sorted + unique
  }

  if (!Array.isArray(obj.records)) return null;
  if (obj.records.length !== refs.length) return null;
  const refSet = new Set(refs as number[]);
  const seen = new Set<number>();
  const records: DocIssueRecord[] = [];
  for (let index = 0; index < obj.records.length; index += 1) {
    const rawRecord = obj.records[index];
    if (!rawRecord || typeof rawRecord !== 'object' || Array.isArray(rawRecord)) return null;
    const record = rawRecord as Record<string, unknown>;
    const number = record.number;
    if (!Number.isInteger(number) || (number as number) <= 0) return null;
    if (!refSet.has(number as number) || seen.has(number as number)) return null;
    if (number !== refs[index]) return null; // record order is canonical ref order
    if (!isDocIssueState(record.state)) return null;
    seen.add(number as number);
    records.push({ number: number as number, state: record.state });
  }

  const snapshot: DocIssueSnapshot = {
    repo: obj.repo,
    refs: [...(refs as number[])],
    records,
    asOf: obj.asOf,
    complete: true,
    fingerprint: obj.fingerprint,
  };
  if (expected.repo !== undefined && snapshot.repo !== expected.repo) return null;
  if (expected.refs !== undefined && !sameRefs(snapshot.refs, expected.refs)) return null;
  if (expected.fingerprint !== undefined && snapshot.fingerprint !== expected.fingerprint) return null;
  return snapshot;
}

/** O(1) state lookup by number for the #2711 consumer detector. */
export function docIssueStateByNumber(
  snapshot: Pick<DocIssueSnapshot, 'records'>
): Map<number, DocIssueState> {
  const map = new Map<number, DocIssueState>();
  for (const record of snapshot.records) map.set(record.number, record.state);
  return map;
}
