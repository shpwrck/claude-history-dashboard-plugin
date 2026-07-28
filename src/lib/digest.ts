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
// Source these types from their leaf modules, not from the cyclic `./recommendations`
// / `./coverage` barrels (#1582): `digest.ts` imports VALUES from `domain-registry`
// (which `recommendations` reaches) and is reached BY `coverage`, so importing the
// types from those modules closed a (type-only, runtime-erased) madge cycle.
// `Recommendation` is defined in `./detectors/types`; `RecCategory` in the
// `./detectors/rec-enums` leaf; the coverage types in the `./coverage-types` leaf.
// All three are re-exported by the original barrels, so this is a pure path swap.
import type { Recommendation } from './detectors/types';
import type { RecCategory } from './detectors/rec-enums';
import type { DomainCoverage, DomainCoverageStatus } from './coverage-types';
import type { ActionDomain, View } from '../types';
import {
  ACTION_DOMAIN_NAMES,
  CATEGORY_TO_DOMAIN,
  DOMAIN_LANDING_VIEW,
} from './domain-registry';

/**
 * Map a rec engine `category` onto the action-domain taxonomy (#490). Derived
 * from the single source of truth in {@link domain-registry.ts} (#2079) — edit
 * the category→domain mapping there, not here.
 */
export const DOMAIN_FOR_CATEGORY: Record<RecCategory, ActionDomain> =
  CATEGORY_TO_DOMAIN;

/**
 * The six action-domains in digest order — safety first. The `speed` slot stays
 * empty until a clock-lever detector fires (ADR 0006 — honestly sparse at
 * launch). Derived from the domain registry (#2079).
 */
export const ACTION_DOMAINS: readonly ActionDomain[] = ACTION_DOMAIN_NAMES;

/**
 * The default raw view to deep-link to for a domain's "open full view" link.
 * Derived from the domain registry (#2079).
 */
export const DOMAIN_LANDING: Record<ActionDomain, View> = DOMAIN_LANDING_VIEW;

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
 * Each finding carries the matching `coverage` level so the empty cards can
 * distinguish a true blind-spot ("no data to judge this") from a domain that
 * genuinely looks healthy.
 *
 * A domain with NO coverage entry is a blind spot, not a healthy one (#3123).
 * It previously defaulted to `healthy`, which meant an uninstrumented domain —
 * and, when the coverage array was empty, EVERY domain — rendered as a clean
 * card. Absence of a coverage signal is a fact about our instrumentation, not
 * about the user's setup.
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
    coverage: levelByDomain.get(domain) ?? 'blind-spot',
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

/**
 * `unknown` is not a severity — it is the absence of a basis for any severity
 * (#3123). Without it, "no findings" and "nothing was analysed" collapse into
 * the same reassuring sentence.
 */
export type VerdictTone = 'ok' | 'attention' | 'critical' | 'unknown';

export interface DigestVerdict {
  tone: VerdictTone;
  text: string;
}

/**
 * The one-sentence "am I okay" verdict. Critical when any safety finding is
 * critical; attention when there are findings; ok when there are none AND we
 * actually looked.
 *
 * `coverage` is REQUIRED (#3123). It used to be absent entirely, so an empty
 * `recs` array produced "your recent agent activity looks healthy" whether the
 * engine had examined everything and found nothing, or had examined nothing at
 * all. Those are opposite states and the reassuring one was the default — on a
 * fresh or partially-ingested install, the moment a user has least basis for
 * confidence is exactly when they were told everything looked fine.
 *
 * Making it a required parameter rather than an optional one is deliberate: a
 * caller cannot now produce a verdict without stating what was observed.
 */
export function digestVerdict(
  recs: Recommendation[],
  coverage: readonly DomainCoverage[]
): DigestVerdict {
  // Nothing observable in any domain — we have no basis for a verdict, clean or
  // otherwise. This is distinct from "we looked everywhere and it was quiet".
  const observed = coverage.filter(
    (c) => coverageLevelForStatus(c.status) !== 'blind-spot'
  );
  if (observed.length === 0) {
    return {
      tone: 'unknown',
      text:
        recs.length === 0
          ? 'No agent activity has been analysed yet — this is not a clean bill of health.'
          : 'Findings are shown below, but no domain reported observable coverage — treat them as provisional.',
    };
  }
  if (recs.length === 0) {
    const blind = coverage.length - observed.length;
    return {
      tone: 'ok',
      text:
        blind > 0
          ? `No findings across the ${observed.length} domain(s) with data — ${blind} domain(s) had none to judge.`
          : 'No findings — your recent agent activity looks healthy.',
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
