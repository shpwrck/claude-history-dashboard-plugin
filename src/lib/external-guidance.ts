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
import type { RecCategory } from './detectors/types';

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
  snapshot: unknown
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
    fetchedAt: requiredString(raw.fetchedAt, 'fetchedAt'),
    contentHash: requiredString(raw.contentHash, 'contentHash'),
    suggestion: requiredString(raw.suggestion, 'suggestion'),
    target: parseTarget(raw.target),
    ...(title ? { title } : {}),
    ...(facts ? { facts } : {}),
    ...(pages ? { pages } : {}),
  };
}

export function externalGuidanceRef(
  guidance: ExternalGuidance
): ExternalGuidanceRef {
  const source = sourceForExternalGuidance(guidance.source);
  return {
    label: guidance.title ?? guidance.suggestion,
    url: guidance.url,
    source: source?.label ?? guidance.source,
    trustTier: guidance.trustTier,
  };
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
