import type {
  AppliedMarkers,
  Detector,
  RecFix,
  RecObservation,
  Recommendation,
} from '../types';
import type { Session, SessionTokenData } from '../../../types';
import { isUnattendedEntrypoint } from '../../parse-sessions';
import { claudeMdMarksApplied, short } from '../shared';

/**
 * workflow.session-restart-retype (#2505, epic #2199).
 *
 * The coverage gap nothing else fills: when work is abandoned in one session and
 * picked up in a NEW session, the user re-types / re-explains the SAME task from
 * scratch — re-billing the setup and losing the prior context — where the fix is
 * simply `claude --resume` / `--continue`, or ending a session with a handoff
 * note. The siblings each own a different re-explanation surface:
 *  - `context.cross-session-reread` covers file **re-reads** across sessions;
 *  - `workflow.procedural-memory` (#2250) covers recurring **Bash procedures**;
 *  - `workflow.value-of-agent-handoff` (#2312) covers the agent's own dropped
 *    durable-state setup.
 * NONE cover prompt-level re-explanation across session boundaries — this does.
 *
 * MECHANISM. Compare session OPENERS (`tokenData[].opener`, the first user turn,
 * #743) pairwise within one project and a bounded window: two DISTINCT sessions
 * in the SAME project, within {@link WINDOW_DAYS} days, whose normalized openers
 * exceed a token-shingle similarity floor, are a "retype" pair; transitively
 * linked pairs form a cluster. The finding measures that recurrence.
 *
 * Auditable-claim contract (docs/adding-a-recommendation.md):
 *  - EVIDENCE / PROVENANCE: cites the similar session PAIRS (short ids + Jaccard
 *    similarity + days apart) and the full retype session id list as structured
 *    provenance, reading `tokenData[].opener` and each session's start time.
 *  - CLAIM CLASS: `'accounting'` / `proofTier:'accounting'`. It MEASURES that
 *    near-duplicate openers recurred across sessions; it does NOT assert the user
 *    forgot `--resume` (they may have deliberately restarted) nor a counterfactual
 *    saving — resuming is presented as an option, not a proven win.
 *  - GATES (precision over recall — a consumed rec must be honest):
 *      · MIN OPENER LENGTH ({@link MIN_OPENER_CHARS} chars, {@link MIN_OPENER_TOKENS}
 *        content tokens) so trivial openers ("hi", "continue") never pair.
 *      · SLASH-COMMAND EXCLUSION: an opener that IS a slash-command invocation
 *        (`/burn-epic …`) is a DELIBERATE reusable template, not a re-explained
 *        task — excluded so command reuse is never mis-flagged as a retype.
 *      · UNATTENDED EXCLUSION via {@link isUnattendedEntrypoint}: `sdk-*`
 *        automation legitimately reuses a fixed prompt — that reuse is #2250's
 *        territory, not a human retype.
 *      · SAME-PROJECT ONLY: openers are partitioned by project, so two similar
 *        prompts in different repos never pair. A session with no resolvable
 *        project is dropped (an unknowable project can't be asserted "same").
 *      · DISTINCT SESSIONS: records are keyed by `sessionId` (first wins), so the
 *        multiple history parts of ONE session (`history.d/<id>.jsonl`) collapse
 *        to a single record and can never pair with themselves.
 *      · BOUNDED WINDOW: a pair must sit within {@link WINDOW_DAYS} days — an
 *        opener echoed months later is not a live re-explanation.
 *  - STALE HANDLING: if the newest retype cluster is older than {@link STALE_MS}
 *    the wording is demoted to "as of <date>" and the provenance is flagged stale.
 *  - FIX: a non-`validated` (`'illustrative'`) CLAUDE.md prose note — the exact
 *    phrasing is the user's to adapt; anchored `appliedMarkers` self-suppress it.
 *
 * Reads only local artifacts (`tokenData`, `sessions`, `liveConfig`); zero
 * external calls. On the transcript-free/opener-less dataset it emits nothing.
 */

const DETECTOR_ID = 'workflow.session-restart-retype';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Window within which two near-duplicate openers count as one live retype. */
const WINDOW_DAYS = 7;
const WINDOW_MS = WINDOW_DAYS * DAY_MS;

/** Trimmed opener shorter than this is too thin to be a re-explained task. */
const MIN_OPENER_CHARS = 40;
/** Fewer content tokens than this can't form a meaningful shingle comparison. */
const MIN_OPENER_TOKENS = 6;
/** Word-shingle width for the similarity comparison (consecutive-token n-grams). */
const SHINGLE_SIZE = 2;
/** Jaccard floor at/above which two openers count as near-duplicate. */
const SIMILARITY_FLOOR = 0.5;
/** A retype cluster needs at least this many DISTINCT sessions. */
const MIN_CLUSTER_SESSIONS = 2;
/** Newest cluster older than this ⇒ demote to "as of <date>". 30 days. */
const STALE_MS = 30 * DAY_MS;
/** How many evidence rows / cited pairs to surface. */
const MAX_EVIDENCE = 5;

/**
 * Common English filler dropped before shingling so two openers that overlap
 * ONLY on structural words ("the", "and", "please", "to") never clear the floor.
 * Small and deliberately generic — it improves precision of the similarity floor
 * without encoding any task vocabulary.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'please', 'can', 'this', 'that', 'with',
  'from', 'into', 'are', 'was', 'were', 'have', 'has', 'had', 'but', 'not',
  'all', 'any', 'our', 'out', 'get', 'now', 'then', 'them', 'they', 'its',
  'let', 'add', 'use', 'need', 'want', 'also', 'still', 'just', 'some', 'more',
]);

const MARKERS: AppliedMarkers = {
  headings: [/^##\s+Resume prior sessions instead of re-?typing\b/i],
  bodyPhrases: ['resume the prior session instead of re-explaining the task'],
};

export interface OpenerRecord {
  sessionId: string;
  project: string;
  projectShort: string;
  tsMs: number;
  /** Original opener (truncated by the parser to ~200 chars) for display only. */
  opener: string;
  /** Normalized token-shingle set — the similarity identity. */
  shingles: Set<string>;
}

interface RetypePair {
  a: OpenerRecord;
  b: OpenerRecord;
  similarity: number;
  daysApart: number;
}

interface Cluster {
  project: string;
  projectShort: string;
  members: OpenerRecord[];
  pairs: RetypePair[];
  latestTs: number;
}

/** A slash-command opener (`/burn-epic …`) — a deliberate template, not a retype. */
function isSlashCommandOpener(opener: string): boolean {
  return /^\s*\//.test(opener);
}

/**
 * Normalize an opener into content tokens: lowercase, drop path-like tokens and
 * URLs (they carry no re-explanation signal and inflate overlap), strip numbers
 * (issue/line/version noise), split on non-letters, and drop 1-char tokens and
 * {@link STOPWORDS}. "Strip paths/numbers" per the spec so `src/lib/foo.ts:42`
 * and `#2505` never anchor a false match.
 */
function openerTokens(opener: string): string[] {
  return opener
    .toLowerCase()
    .replace(/`+/g, ' ') // code fences / inline code ticks
    .replace(/\S*\/\S*/g, ' ') // any token containing a slash (paths, urls)
    .replace(/\d+/g, ' ') // numbers (issue/line/version noise)
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t));
}

/** Consecutive-token shingles (width {@link SHINGLE_SIZE}); unigrams when short. */
function toShingles(tokens: string[]): Set<string> {
  if (tokens.length < SHINGLE_SIZE) return new Set(tokens);
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE_SIZE <= tokens.length; i += 1) {
    out.add(tokens.slice(i, i + SHINGLE_SIZE).join(' '));
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function shortenProject(project: string): string {
  const parts = project.split('/').filter(Boolean);
  return parts[parts.length - 1] || project;
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Build one de-duplicated {@link OpenerRecord} per qualifying session. Openers
 * come from `tokenData`; a session's project + start time are resolved from its
 * history `Session` row first (authoritative start time), then from the token
 * record's own `project` / earliest entry timestamp. Records are keyed by
 * `sessionId` so multiple history parts of one session collapse to one.
 */
function buildRecords(
  tokenData: SessionTokenData[],
  sessions: Session[]
): OpenerRecord[] {
  const projectBySession = new Map<string, string>();
  const startBySession = new Map<string, number>();
  for (const s of sessions) {
    if (s.project) projectBySession.set(s.sessionId, s.project);
    if (Number.isFinite(s.startTime)) startBySession.set(s.sessionId, s.startTime);
  }

  const byId = new Map<string, OpenerRecord>();
  for (const t of tokenData) {
    if (byId.has(t.sessionId)) continue; // distinct sessions only (history parts collapse)
    const opener = t.opener;
    if (typeof opener !== 'string' || opener.trim().length < MIN_OPENER_CHARS) continue;
    if (isSlashCommandOpener(opener)) continue; // deliberate template, not a retype
    if (isUnattendedEntrypoint(t.entrypoint)) continue; // sdk-* prompt reuse ≠ human retype

    const project = t.project ?? projectBySession.get(t.sessionId);
    if (!project) continue; // unknowable project can't be asserted "same project"

    let tsMs = startBySession.get(t.sessionId);
    if (tsMs === undefined) {
      const first = t.entries?.[0]?.timestamp;
      const parsed = first ? Date.parse(first) : NaN;
      if (!Number.isFinite(parsed)) continue; // no timestamp ⇒ can't apply the window
      tsMs = parsed;
    }

    const tokens = openerTokens(opener);
    if (tokens.length < MIN_OPENER_TOKENS) continue;
    const shingles = toShingles(tokens);
    if (shingles.size === 0) continue;

    byId.set(t.sessionId, {
      sessionId: t.sessionId,
      project,
      projectShort: t.projectShort ?? shortenProject(project),
      tsMs,
      opener: opener.trim(),
      shingles,
    });
  }
  return [...byId.values()];
}

/** Union-find over one project's records; edges are within-window near-duplicates. */
export function clusterProject(records: OpenerRecord[]): Cluster[] {
  const parent = records.map((_, i) => i);
  const find = (i: number): number => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    while (parent[i] !== r) {
      const next = parent[i];
      parent[i] = r;
      i = next;
    }
    return r;
  };
  const union = (i: number, j: number): void => {
    parent[find(i)] = find(j);
  };

  // #3245: the old loop enumerated all n(n−1)/2 pairs and only SKIPPED the
  // Jaccard for out-of-window pairs — the enumeration itself stayed quadratic.
  // Sort record indices by timestamp and sweep a forward 7-day window per
  // anchor, so pairs beyond the window are never enumerated at all (`break`,
  // not `continue`). On sparse real histories that is near-linear; a dense
  // burst inside one window is inherently O(pairs-in-window) for any algorithm.
  // Qualifying edges are then replayed in the original (min-index, max-index)
  // order, so the union sequence, component roots, per-anchor pair lists, and
  // evidence ordering are byte-identical to the all-pairs loop.
  const order = records
    .map((_, i) => i)
    .sort((a, b) => records[a].tsMs - records[b].tsMs);
  const edges: Array<{
    lo: number;
    hi: number;
    similarity: number;
    daysApart: number;
  }> = [];
  for (let p = 0; p < order.length; p += 1) {
    const i = order[p];
    for (let q = p + 1; q < order.length; q += 1) {
      const j = order[q];
      // order is tsMs-ascending, so once the gap exceeds the window every later
      // record is further still — stop scanning this anchor.
      if (records[j].tsMs - records[i].tsMs > WINDOW_MS) break;
      const similarity = jaccard(records[i].shingles, records[j].shingles);
      if (similarity < SIMILARITY_FLOOR) continue;
      const lo = Math.min(i, j);
      const hi = Math.max(i, j);
      const daysApart = Math.round(
        Math.abs(records[i].tsMs - records[j].tsMs) / DAY_MS
      );
      edges.push({ lo, hi, similarity, daysApart });
    }
  }
  // Original nested loop visited qualifying pairs in (i asc, j asc) = (lo asc,
  // hi asc) order; replay in that exact order so pairsByRoot keys, per-anchor
  // pair lists, and Map insertion order are identical.
  edges.sort((x, y) => x.lo - y.lo || x.hi - y.hi);

  const pairsByRoot = new Map<number, RetypePair[]>();
  for (const edge of edges) {
    union(edge.lo, edge.hi);
    // Stash the pair under its first endpoint index; the loop below re-keys it
    // to the final component root once all unions have settled.
    const pair: RetypePair = {
      a: records[edge.lo],
      b: records[edge.hi],
      similarity: edge.similarity,
      daysApart: edge.daysApart,
    };
    const list = pairsByRoot.get(edge.lo) ?? [];
    list.push(pair);
    pairsByRoot.set(edge.lo, list);
  }

  const byRoot = new Map<number, Cluster>();
  const rootOf = (i: number): number => find(i);
  for (const [anchor, pairs] of pairsByRoot) {
    const root = rootOf(anchor);
    const cluster = byRoot.get(root) ?? {
      project: records[root].project,
      projectShort: records[root].projectShort,
      members: [],
      pairs: [],
      latestTs: 0,
    };
    cluster.pairs.push(...pairs);
    byRoot.set(root, cluster);
  }
  // Assign members by component root, then keep components with >= 2 sessions.
  for (let i = 0; i < records.length; i += 1) {
    const root = rootOf(i);
    const cluster = byRoot.get(root);
    if (!cluster) continue; // singleton with no edge
    cluster.members.push(records[i]);
    cluster.latestTs = Math.max(cluster.latestTs, records[i].tsMs);
  }
  return [...byRoot.values()].filter((c) => c.members.length >= MIN_CLUSTER_SESSIONS);
}

function strongestPair(cluster: Cluster): RetypePair {
  return cluster.pairs.reduce((best, p) => (p.similarity > best.similarity ? p : best));
}

function buildFix(): RecFix {
  return {
    target: 'CLAUDE.md',
    label: 'Add a resume-instead-of-retype rule',
    note: 'Append to your project or global CLAUDE.md and adapt the wording — this is an example to adapt, not copy-paste config.',
    fixKind: 'illustrative',
    appliedMarkers: MARKERS,
    snippet:
      '## Resume prior sessions instead of re-typing\n\n' +
      'When you pick up work you already started in an earlier session, resume the ' +
      'prior session instead of re-explaining the task from scratch:\n' +
      '- run `claude --resume` (or `claude --continue`) to reload the earlier context; and\n' +
      '- when you must stop mid-task, leave a short handoff note so the next session ' +
      'continues from it instead of re-deriving the setup.',
  };
}

function toRecommendation(clusters: Cluster[], now: number): Recommendation {
  // Deterministic lead: largest cluster, then most recent, then lowest id.
  const sorted = [...clusters].sort(
    (a, b) =>
      b.members.length - a.members.length ||
      b.latestTs - a.latestTs ||
      a.members[0].sessionId.localeCompare(b.members[0].sessionId)
  );
  const lead = sorted[0];

  const retypeSessionIds = new Set<string>();
  for (const c of clusters) for (const m of c.members) retypeSessionIds.add(m.sessionId);
  const totalSessions = retypeSessionIds.size;
  const projectsAffected = new Set(clusters.map((c) => c.project)).size;
  const latestAcross = Math.max(...clusters.map((c) => c.latestTs));
  const asOf = isoDate(latestAcross);
  const stale = now - latestAcross > STALE_MS;
  const asOfPrefix = stale ? `As of ${asOf}, ` : '';

  const top = strongestPair(lead);
  const leadIds = lead.members.map((m) => m.sessionId);

  // Evidence: the strongest pair leads (a session id first, so per-project rec
  // filtering can attribute this finding), then further cited pairs.
  const allPairs = clusters
    .flatMap((c) => c.pairs.map((p) => ({ p, projectShort: c.projectShort })))
    .sort((x, y) => y.p.similarity - x.p.similarity)
    .slice(0, MAX_EVIDENCE);
  const evidence = allPairs.map(
    ({ p, projectShort }) =>
      `${short(p.a.sessionId)} & ${short(p.b.sessionId)} in ${projectShort}: openers ~${Math.round(
        p.similarity * 100
      )}% similar, ${p.daysApart} day(s) apart`
  );

  const observations: RecObservation[] = [
    {
      claim: `${totalSessions} distinct session(s) across ${projectsAffected} project(s) re-opened with a near-duplicate prompt within ${WINDOW_DAYS} days of an earlier same-project session`,
      source: 'parse-sessions',
      field: 'tokenData[].opener',
      value: totalSessions,
    },
    {
      claim: `strongest retype pair: sessions ${top.a.sessionId} and ${top.b.sessionId} in ${lead.projectShort}, opener token-shingle Jaccard ~${top.similarity.toFixed(
        2
      )}, ${top.daysApart} day(s) apart`,
      source: 'parse-sessions',
      field: 'tokenData[].opener + sessions[].startTime',
      value: Number(top.similarity.toFixed(2)),
    },
    {
      claim: `the ${leadIds.length} distinct sessions in the lead retype cluster`,
      source: 'parse-sessions',
      field: 'tokenData[].sessionId',
      value: leadIds.join(', '),
    },
  ];

  const detail =
    `${asOfPrefix}${totalSessions} session(s) in ${projectsAffected} project(s) re-opened with a ` +
    `near-duplicate prompt within ${WINDOW_DAYS} days of an earlier same-project session ` +
    `(strongest pair ~${Math.round(top.similarity * 100)}% similar, ${top.daysApart} day(s) apart) — ` +
    `re-explaining the task instead of resuming the prior session.`;

  return {
    id: DETECTOR_ID,
    category: 'workflow',
    severity: 'info',
    title: 'Resume prior sessions instead of re-typing the task',
    // ADR 0017: MEASURES that near-duplicate openers recurred (arithmetic on the
    // cited openers) — an accounting claim, not a proven causal saving.
    claimClass: 'accounting',
    proofTier: 'accounting',
    detail,
    action:
      'Resume the earlier session with `claude --resume` / `--continue` to reload its context, or end a session mid-task with a short handoff note, instead of re-explaining the same task in a fresh session.',
    affected: totalSessions,
    view: 'sessions',
    evidence,
    provenance: {
      observations,
      inference:
        'Near-duplicate openers in the same project within a short window are a measured recurrence of re-explaining the same task across session boundaries; resuming the prior session (or leaving a handoff note) would avoid re-typing it. This is not an assertion that the user forgot `--resume` — some restarts are deliberate — only that the pattern recurred.',
      asOf,
      ...(stale ? { stale: true } : {}),
    },
    fix: buildFix(),
  };
}

export const detector: Detector = {
  id: DETECTOR_ID,
  category: 'workflow',
  dataDeps: ['tokenData', 'sessions', 'liveConfig'],
  appliedMarkers: MARKERS,
  rule(input, now): Recommendation | null {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS)) return null;
    const records = buildRecords(input.tokenData ?? [], input.sessions ?? []);
    if (records.length < MIN_CLUSTER_SESSIONS) return null;

    const byProject = new Map<string, OpenerRecord[]>();
    for (const r of records) {
      const list = byProject.get(r.project) ?? [];
      list.push(r);
      byProject.set(r.project, list);
    }

    const clusters: Cluster[] = [];
    for (const group of byProject.values()) {
      if (group.length < MIN_CLUSTER_SESSIONS) continue;
      clusters.push(...clusterProject(group));
    }
    if (clusters.length === 0) return null;

    return toRecommendation(clusters, now);
  },
};
