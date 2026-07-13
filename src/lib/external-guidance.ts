/**
 * External guidance core (#1300, epic #656) — the browser-safe half of the
 * external-guidance artifact: types, the trust-tiered source registry, the
 * snapshot parser/validator, and the reference projection.
 *
 * This module is PURE (no node:fs / node:path) so the recommendation engine —
 * which is bundled into the SPA — can import the attach-time helpers at
 * runtime. The on-disk snapshot reader lives in `parse-external-guidance.ts`,
 * which re-exports everything here for back-compat.
 */
import type { RecCategory } from './detectors/rec-enums';

type JsonObject = Record<string, unknown>;

export type ExternalGuidanceTrustTier =
  | 'first-party'
  | 'vendor'
  | 'community';

export interface ExternalGuidanceSource {
  id: string;
  label: string;
  trustTier: ExternalGuidanceTrustTier;
  allowedUrlPrefixes: string[];
}

export const SOURCE_REGISTRY: readonly ExternalGuidanceSource[] = [
  {
    id: 'anthropic-support',
    label: 'Anthropic Support',
    trustTier: 'first-party',
    allowedUrlPrefixes: ['https://support.claude.com/en/articles/'],
  },
  {
    id: 'anthropic-claude-code-docs',
    label: 'Anthropic Claude Code Docs',
    trustTier: 'first-party',
    allowedUrlPrefixes: ['https://code.claude.com/docs/en/'],
  },
  {
    // A personal technical blog (#1589) — useful prompt-brevity craft, but not
    // a vendor or first-party source, so it carries the lower-trust `community`
    // tier. Downstream rendering marks community guidance distinctly from
    // first-party (RecommendationCard) so a reader can weigh it accordingly.
    id: 'prahlad-yeri-guides',
    label: 'Prahlad Yeri (guides)',
    trustTier: 'community',
    allowedUrlPrefixes: ['https://prahladyeri.github.io/guides/'],
  },
];

export interface ExternalGuidanceTarget {
  detectorId?: string;
  category?: RecCategory;
}

export type ExternalGuidanceFactValue = string | number | boolean;
export type ExternalGuidanceFacts = Record<string, ExternalGuidanceFactValue>;

/**
 * Per-page provenance inside a snapshot (#1407). A multi-page snapshot (a
 * primary article plus fact-bearing supporting pages) records one entry per
 * fetched page so drift localizes to the page that changed and a citation can
 * point at the page that actually contains the asserted facts.
 */
export interface ExternalGuidancePage {
  url: string;
  /** sha256 over this page's extracted text content. */
  contentHash: string;
  title?: string;
}

export interface ExternalGuidance {
  id: string;
  source: string;
  trustTier: ExternalGuidanceTrustTier;
  url: string;
  fetchedAt: string;
  contentHash: string;
  suggestion: string;
  target: ExternalGuidanceTarget;
  title?: string;
  facts?: ExternalGuidanceFacts;
  /** Per-page provenance (#1407); absent on legacy single-hash snapshots. */
  pages?: ExternalGuidancePage[];
}

export interface ExternalGuidanceRef {
  label: string;
  url: string;
  source: string;
  trustTier: ExternalGuidanceTrustTier;
}

export const EXTERNAL_GUIDANCE_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Snapshot clocks may be slightly ahead of the dashboard host, but more than
 * 24 hours indicates a bad capture clock or hand-authored provenance. Rejecting
 * that case prevents a future timestamp from suppressing stale labeling for an
 * unbounded period while tolerating ordinary timezone/clock skew.
 */
export const EXTERNAL_GUIDANCE_MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;

export interface ExternalGuidanceClockTransition {
  guidanceId: string;
  target: ExternalGuidanceTarget;
  url: string;
  currentLabel: string;
  staleLabel: string;
  staleAfter: number;
}

/**
 * Interval in which cached guidance labels remain correct. `after` is an
 * exclusive lower bound contributed by labels already rendered stale;
 * `through` is an inclusive upper bound contributed by labels still current.
 * Either side is `null` when unbounded.
 */
export interface ExternalGuidanceCacheValidity {
  after: number | null;
  through: number | null;
}

export class ExternalGuidanceParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExternalGuidanceParseError';
  }
}

const SOURCE_BY_ID = new Map(
  SOURCE_REGISTRY.map((source) => [source.id, source])
);

const REC_CATEGORIES: readonly RecCategory[] = [
  'cost',
  'context',
  'workflow',
  'safety',
  'security',
  'reliability',
  'speed',
  'activity',
  'maintenance',
];

function asObject(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExternalGuidanceParseError(`${field} must be an object`);
  }
  return value as JsonObject;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ExternalGuidanceParseError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value == null) return undefined;
  return requiredString(value, field);
}

const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

function isIsoCalendarRoundTrip(timestamp: string): boolean {
  const match = ISO_TIMESTAMP.exec(timestamp);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  if (
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
    return false;
  }

  // Date.parse normalizes impossible dates on some runtimes (Feb 30 -> Mar 2).
  // Round-trip the calendar fields independently of the timestamp's offset so
  // only a real date survives. setUTCFullYear handles years 0000-0099 without
  // Date.UTC's legacy 1900 offset.
  const calendar = new Date(0);
  calendar.setUTCHours(0, 0, 0, 0);
  calendar.setUTCFullYear(year, month - 1, day);
  return (
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() === month - 1 &&
    calendar.getUTCDate() === day
  );
}

function requiredIsoTimestamp(
  value: unknown,
  field: string,
  now: number
): string {
  const timestamp = requiredString(value, field);
  const parsed = Date.parse(timestamp);
  if (!isIsoCalendarRoundTrip(timestamp) || !Number.isFinite(parsed)) {
    throw new ExternalGuidanceParseError(
      `${field} must be a valid ISO timestamp`
    );
  }
  if (
    Number.isFinite(now) &&
    parsed > now + EXTERNAL_GUIDANCE_MAX_FUTURE_SKEW_MS
  ) {
    throw new ExternalGuidanceParseError(
      `${field} is more than 24 hours in the future`
    );
  }
  return timestamp;
}

function parseTarget(value: unknown): ExternalGuidanceTarget {
  const raw = asObject(value, 'target');
  const detectorId = optionalString(raw.detectorId, 'target.detectorId');
  const category = optionalString(raw.category, 'target.category');
  if ((detectorId ? 1 : 0) + (category ? 1 : 0) !== 1) {
    throw new ExternalGuidanceParseError(
      'target must set exactly one of detectorId or category'
    );
  }
  if (category && !REC_CATEGORIES.includes(category as RecCategory)) {
    throw new ExternalGuidanceParseError(
      `target.category is not a known recommendation category: ${category}`
    );
  }
  return detectorId
    ? { detectorId }
    : { category: category as RecCategory };
}

function parseFacts(value: unknown): ExternalGuidanceFacts | undefined {
  if (value == null) return undefined;
  const raw = asObject(value, 'facts');
  const facts: ExternalGuidanceFacts = {};
  for (const [key, fact] of Object.entries(raw)) {
    if (
      typeof fact !== 'string' &&
      typeof fact !== 'number' &&
      typeof fact !== 'boolean'
    ) {
      throw new ExternalGuidanceParseError(
        `facts.${key} must be a string, number, or boolean`
      );
    }
    facts[key] = fact;
  }
  return facts;
}

/**
 * Whether `url` falls inside `source`'s allowlist: same protocol, hostname,
 * and port as an allowed prefix, with the prefix's pathname as a path prefix.
 * Exported (#1407) so the ingest script gates its writes with THIS predicate
 * instead of a drifting copy — a lib-side tightening reaches the write path.
 */
export function isAllowedUrl(
  url: string,
  source: ExternalGuidanceSource
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  return source.allowedUrlPrefixes.some((prefix) => {
    let allowed: URL;
    try {
      allowed = new URL(prefix);
    } catch {
      return false;
    }
    if (
      parsed.protocol !== allowed.protocol ||
      parsed.hostname !== allowed.hostname ||
      parsed.port !== allowed.port
    ) {
      return false;
    }
    return parsed.pathname.startsWith(allowed.pathname);
  });
}

export function sourceForExternalGuidance(
  sourceId: string
): ExternalGuidanceSource | undefined {
  return SOURCE_BY_ID.get(sourceId);
}

function parsePages(
  value: unknown,
  source: ExternalGuidanceSource
): ExternalGuidancePage[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new ExternalGuidanceParseError('pages must be a non-empty array');
  }
  return value.map((entry, i) => {
    const raw = asObject(entry, `pages[${i}]`);
    const url = requiredString(raw.url, `pages[${i}].url`);
    if (!isAllowedUrl(url, source)) {
      throw new ExternalGuidanceParseError(
        `pages[${i}].url is outside the ${source.id} allowlist: ${url}`
      );
    }
    const title = optionalString(raw.title, `pages[${i}].title`);
    return {
      url,
      contentHash: requiredString(raw.contentHash, `pages[${i}].contentHash`),
      ...(title ? { title } : {}),
    };
  });
}

export function parseExternalGuidanceSnapshot(
  snapshot: unknown,
  now = Date.now()
): ExternalGuidance {
  const raw = asObject(snapshot, 'snapshot');
  const sourceId = requiredString(raw.source, 'source');
  const source = sourceForExternalGuidance(sourceId);
  if (!source) {
    throw new ExternalGuidanceParseError(`unknown guidance source: ${sourceId}`);
  }

  const url = requiredString(raw.url, 'url');
  if (!isAllowedUrl(url, source)) {
    throw new ExternalGuidanceParseError(
      `url is outside the ${source.id} allowlist: ${url}`
    );
  }

  const title = optionalString(raw.title, 'title');
  const facts = parseFacts(raw.facts);
  const pages = parsePages(raw.pages, source);
  return {
    id: requiredString(raw.id, 'id'),
    source: source.id,
    trustTier: source.trustTier,
    url,
    fetchedAt: requiredIsoTimestamp(raw.fetchedAt, 'fetchedAt', now),
    contentHash: requiredString(raw.contentHash, 'contentHash'),
    suggestion: requiredString(raw.suggestion, 'suggestion'),
    target: parseTarget(raw.target),
    ...(title ? { title } : {}),
    ...(facts ? { facts } : {}),
    ...(pages ? { pages } : {}),
  };
}

/**
 * Short, human-readable label for a trust tier, used where guidance is cited so
 * a reader can weigh a `community` (personal blog) source differently from a
 * `first-party` (vendor) one (#1589). First-party carries no marker — it is the
 * baseline; lower-trust tiers are called out explicitly.
 */
export function trustTierLabel(
  tier: ExternalGuidanceTrustTier
): string | undefined {
  switch (tier) {
    case 'first-party':
      return undefined;
    case 'vendor':
      return 'vendor';
    case 'community':
      return 'community-sourced';
    default:
      return undefined;
  }
}

export function externalGuidanceRef(
  guidance: ExternalGuidance,
  now?: number
): ExternalGuidanceRef {
  const source = sourceForExternalGuidance(guidance.source);
  const baseLabel = guidance.title ?? guidance.suggestion;
  const transition = externalGuidanceClockTransition(guidance);
  const stale =
    transition !== undefined &&
    typeof now === 'number' &&
    Number.isFinite(now) &&
    now > transition.staleAfter;
  return {
    label: stale ? transition.staleLabel : baseLabel,
    url: guidance.url,
    source: source?.label ?? guidance.source,
    trustTier: guidance.trustTier,
  };
}

function externalGuidanceClockTransition(
  guidance: ExternalGuidance
): ExternalGuidanceClockTransition | undefined {
  const fetchedMs = Date.parse(guidance.fetchedAt);
  const staleAfter = fetchedMs + EXTERNAL_GUIDANCE_STALE_AFTER_MS;
  if (!Number.isFinite(fetchedMs) || !Number.isFinite(staleAfter)) {
    return undefined;
  }
  const currentLabel = guidance.title ?? guidance.suggestion;
  const asOf = new Date(fetchedMs).toISOString().slice(0, 10);
  return {
    guidanceId: guidance.id,
    target: guidance.target.detectorId
      ? { detectorId: guidance.target.detectorId }
      : { category: guidance.target.category },
    url: guidance.url,
    currentLabel,
    staleLabel: `${currentLabel} (as of ${asOf})`,
    staleAfter,
  };
}

export function externalGuidanceClockTransitions(
  guidance: readonly ExternalGuidance[] | null | undefined
): ExternalGuidanceClockTransition[] {
  if (!guidance) return [];
  return guidance.flatMap((item) => {
    const transition = externalGuidanceClockTransition(item);
    return transition ? [transition] : [];
  });
}

/** Build the two-sided validity interval for labels rendered at `now`. */
export function externalGuidanceCacheValidity(
  transitions: readonly ExternalGuidanceClockTransition[],
  now: number
): ExternalGuidanceCacheValidity {
  let after = Number.NEGATIVE_INFINITY;
  let through = Number.POSITIVE_INFINITY;
  for (const transition of transitions) {
    if (now > transition.staleAfter) {
      after = Math.max(after, transition.staleAfter);
    } else {
      through = Math.min(through, transition.staleAfter);
    }
  }
  return {
    after: Number.isFinite(after) ? after : null,
    through: Number.isFinite(through) ? through : null,
  };
}

export function externalGuidanceCacheValidityContains(
  validity: ExternalGuidanceCacheValidity,
  now: number
): boolean {
  if (!Number.isFinite(now)) return false;
  return (
    (validity.after === null || now > validity.after) &&
    (validity.through === null || now <= validity.through)
  );
}

/**
 * Render the combined snapshot content from its per-page parts. The ingest
 * script hashes this rendering into the snapshot's top-level `contentHash`,
 * and the drift-guard test recomputes it from the committed pages — so the
 * format is load-bearing: changing it flags every snapshot as drifted.
 */
export function renderExternalGuidanceContent(
  pages: readonly { url: string; title?: string; content: string }[]
): string {
  return `${pages
    .map(
      (page) =>
        `# Source: ${page.url}\n\nTitle: ${page.title ?? page.url}\n\n${page.content.trim()}`
    )
    .join('\n\n---\n\n')}\n`;
}
