/**
 * Digest spine logic (epic #490, #491) — the pure ranking behind the home
 * landing. Kept separate from `DigestSpine.tsx` so the safety-first ordering and
 * verdict are unit-testable without rendering PatternFly.
 *
 * The home page is a single ranked answer-sequence — *verdict → where did it go
 * → what to fix* — that ranks findings **across all six action-domains at once**,
 * with **safety leading**. Leading with safety (rather than the engine's raw
 * severity sort) is deliberate: it stops a critical safety finding from hiding
 * behind a more-legible cost finding the user would otherwise read first
 * (S1-Priya's siloing failure-mode; see `docs/reviews/nav-redesign-funnel.md`).
 */
import type { Recommendation, RecCategory } from './recommendations';
import type { DomainCoverage, DomainCoverageStatus } from './coverage';
import type { ActionDomain, View } from '../types';

/** Map a rec engine `category` onto the action-domain taxonomy (#490). */
export const DOMAIN_FOR_CATEGORY: Record<RecCategory, ActionDomain> = {
  cost: 'cost',
  reliability: 'success-rate',
  safety: 'safety',
  // Agent-trustworthiness findings (model-deceit, #686) ride the safety-first
  // lane: an unverified completion claim is a safety concern, not config hygiene.
  security: 'safety',
  context: 'context-health',
  workflow: 'workflow-hygiene',
  // Speed findings (the clock — wall-clock/latency levers, e.g. slow stop-hooks)
  // own their own action-domain; see ADR 0006.
  speed: 'speed',
  activity: 'workflow-hygiene',
  // Memory-store / config upkeep (#1965) is workflow hygiene: keeping the
  // agent's own durable state clean is part of keeping the workflow honest.
  maintenance: 'workflow-hygiene',
};

/**
 * The six action-domains in digest order — safety first. The `speed` slot stays
 * empty until a clock-lever detector fires (ADR 0006 — honestly sparse at launch).
 */
export const ACTION_DOMAINS: readonly ActionDomain[] = [
  'safety',
  'cost',
  'success-rate',
  'speed',
  'context-health',
  'workflow-hygiene',
];

/** The default raw view to deep-link to for a domain's "open full view" link. */
export const DOMAIN_LANDING: Record<ActionDomain, View> = {
  home: 'home',
  safety: 'permissions',
  cost: 'cost',
  'success-rate': 'errors',
  speed: 'evaluator',
  'context-health': 'context',
  'workflow-hygiene': 'tools',
  discovery: 'search',
  raw: 'stats',
};

/** The action-domain a recommendation belongs to. */
export function domainForRec(rec: Recommendation): ActionDomain {
  return DOMAIN_FOR_CATEGORY[rec.category];
}

/**
 * Re-rank the engine's already-sorted recommendations for the digest: all
 * safety-domain findings first (regardless of severity), then everything else
 * in the engine's existing severity → savings → affected order. Stable —
 * relative order within each partition is preserved.
 */
export function rankForDigest(recs: Recommendation[]): Recommendation[] {
  const safety = recs.filter((r) => domainForRec(r) === 'safety');
  const rest = recs.filter((r) => domainForRec(r) !== 'safety');
  return [...safety, ...rest];
}

/** Top warning/critical safety-domain finding for the dedicated digest lead. */
export function safetyLeadForDigest(recs: Recommendation[]): Recommendation | null {
  return (
    rankForDigest(recs).find(
      (r) => domainForRec(r) === 'safety' && r.severity !== 'info'
    ) ?? null
  );
}

/**
 * How much the dashboard can actually *see* in a domain, in the digest's
 * vocabulary (#1610). Derived from #1480's per-domain coverage signal
 * (`computeDomainCoverage` → `PROVE | INFER | CANNOT_SEE`):
 *
 *  - `healthy`    (`PROVE`)      — all core inputs present; a quiet domain here
 *    truly looks healthy.
 *  - `sparse`     (`INFER`)      — some inputs missing, so a verdict is
 *    low-confidence; we can infer but not prove.
 *  - `blind-spot` (`CANNOT_SEE`) — no core inputs at all; a blank card is the
 *    *absence of data*, not evidence of health.
 *
 * Defaults to `healthy` when no coverage signal is threaded in (keeps Slice A's
 * rendering unchanged for callers that don't yet supply coverage).
 */
export type DomainCoverageLevel = 'healthy' | 'sparse' | 'blind-spot';
export type DomainEmptyStateKind = 'clean' | 'uninstrumented' | 'stale';

export interface DomainEmptyState {
  kind: DomainEmptyStateKind;
  title: string;
  detail: string;
}

const COVERAGE_LEVEL_FOR_STATUS: Record<
  DomainCoverageStatus,
  DomainCoverageLevel
> = {
  PROVE: 'healthy',
  INFER: 'sparse',
  CANNOT_SEE: 'blind-spot',
};

/** Map #1480's coverage status onto the digest's coverage vocabulary. */
export function coverageLevelForStatus(
  status: DomainCoverageStatus
): DomainCoverageLevel {
  return COVERAGE_LEVEL_FOR_STATUS[status];
}

export interface DomainFinding {
  domain: ActionDomain;
  /** The top finding for the domain, or null when the domain is quiet. */
  rec: Recommendation | null;
  /**
   * How much the dashboard can see in this domain (#1610). A `blind-spot` empty
   * card means "no data to judge this"; `sparse` carries a low-confidence
   * caveat; `healthy` is the Slice A rendering. Defaults to `healthy` when no
   * coverage signal is supplied.
   */
  coverage: DomainCoverageLevel;
  /** Why an otherwise-quiet domain is low-confidence or stale, when known. */
  staleNote?: string;
}

const CLEAN_DOMAIN_DETAIL: Record<ActionDomain, string> = {
  home: 'No home-level findings in the loaded evidence.',
  safety:
    'No bypass, unattended-session, dangerous-command, or policy findings in the loaded evidence.',
  cost: 'No cost findings in the loaded token evidence.',
  'success-rate': 'No tool-error or retry findings in the loaded evidence.',
  speed: 'No speed findings in the loaded timing evidence.',
  'context-health': 'No context-health findings in the loaded token and timeline evidence.',
  'workflow-hygiene': 'No workflow-hygiene findings in the loaded tool/task evidence.',
  discovery: 'No discovery findings in the loaded evidence.',
  raw: 'No raw-data findings in the loaded evidence.',
};

const MISSING_DOMAIN_DETAIL: Record<ActionDomain, string> = {
  home: 'No home signals were loaded yet.',
  safety:
    'No safety data yet — load tool calls, permission rows, or deceit signals.',
  cost: 'No cost data yet — load token-usage records.',
  'success-rate':
    'No success-rate data yet — load tool calls, API errors, or runtime events.',
  speed:
    'No speed data yet — wire runtime events or model-latency samples.',
  'context-health':
    'No context-health data yet — load token, timeline, or repo-map evidence.',
  'workflow-hygiene':
    'No workflow-hygiene data yet — load tool calls, tasks, or workflow runs.',
  discovery: 'No discovery signals were loaded yet.',
  raw: 'No raw signals were loaded yet.',
};

/**
 * The "where did it go" beat: the single top finding per action-domain, in
 * digest order (safety first). Domains with no finding are still listed (with
 * `rec: null`) so the spine shows the full action surface, including the
 * intentionally-sparse `speed` slot.
 *
 * When #1480's per-domain `coverage` signal is threaded in, each finding carries
 * the matching `coverage` level so the empty cards can distinguish a true
 * blind-spot ("no data to judge this") from a domain that genuinely looks
 * healthy. Absent that signal, every domain defaults to `healthy` — preserving
 * Slice A's rendering.
 */
export function topPerDomain(
  recs: Recommendation[],
  coverage?: readonly DomainCoverage[]
): DomainFinding[] {
  const ranked = rankForDigest(recs);
  const coverageByDomain = new Map<ActionDomain, DomainCoverage>(
    (coverage ?? []).map((c) => [c.domain, c])
  );
  const levelByDomain = new Map<ActionDomain, DomainCoverageLevel>(
    (coverage ?? []).map((c) => [c.domain, coverageLevelForStatus(c.status)])
  );
  return ACTION_DOMAINS.map((domain) => ({
    domain,
    rec: ranked.find((r) => domainForRec(r) === domain) ?? null,
    coverage: levelByDomain.get(domain) ?? 'healthy',
    staleNote: coverageByDomain.get(domain)?.staleNote,
  }));
}

export function emptyStateForDomainFinding(
  finding: DomainFinding
): DomainEmptyState | null {
  if (finding.rec) return null;
  if (finding.coverage === 'blind-spot') {
    return {
      kind: 'uninstrumented',
      title: 'Needs data',
      detail: MISSING_DOMAIN_DETAIL[finding.domain],
    };
  }
  if (finding.staleNote) {
    return {
      kind: 'stale',
      title: 'Stale evidence',
      detail: finding.staleNote,
    };
  }
  if (finding.coverage === 'sparse') {
    return {
      kind: 'uninstrumented',
      title: 'Partial data',
      detail: `${MISSING_DOMAIN_DETAIL[finding.domain]} Some inputs are present, so this read is low-confidence.`,
    };
  }
  return {
    kind: 'clean',
    title: 'Clean',
    detail: CLEAN_DOMAIN_DETAIL[finding.domain],
  };
}

export type VerdictTone = 'ok' | 'attention' | 'critical';

export interface DigestVerdict {
  tone: VerdictTone;
  text: string;
}

/**
 * The one-sentence "am I okay" verdict. Critical when any safety finding is
 * critical; attention when there are findings; ok when there are none.
 */
export function digestVerdict(recs: Recommendation[]): DigestVerdict {
  if (recs.length === 0) {
    return {
      tone: 'ok',
      text: 'No findings — your recent agent activity looks healthy.',
    };
  }
  const criticalSafety = recs.find(
    (r) => r.category === 'safety' && r.severity === 'critical'
  );
  if (criticalSafety) {
    return {
      tone: 'critical',
      text: `Safety needs attention first: ${criticalSafety.title}`,
    };
  }
  const critical = recs.filter((r) => r.severity === 'critical').length;
  const total = recs.length;
  // Name the top-ranked non-safety finding that set the verdict, mirroring how
  // the `critical` branch embeds `criticalSafety.title` (#1609). The title is
  // already present in the ranked `recs[]` the function receives.
  const topFinding =
    rankForDigest(recs).find((r) => domainForRec(r) !== 'safety') ?? recs[0];
  if (critical > 0) {
    return {
      tone: 'attention',
      text: `${critical} critical ${
        critical === 1 ? 'finding' : 'findings'
      } across ${total} total — start at the top: ${topFinding.title}`,
    };
  }
  return {
    tone: 'attention',
    text: `${total} ${
      total === 1 ? 'finding' : 'findings'
    } worth a look — start with ${topFinding.title}.`,
  };
}
