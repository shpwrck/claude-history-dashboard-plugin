import { join } from 'node:path';
import { normalizeMaxEntries, readDirentsBoundedSync } from './bounded-fs';
import { CONFIG_FILE_MAX_BYTES, readTextFileCappedSync } from './config-loader';
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
}

export interface ExternalGuidanceRef {
  label: string;
  url: string;
  source: string;
  trustTier: ExternalGuidanceTrustTier;
}

export interface ParseExternalGuidanceOptions {
  maxFileBytes?: number;
  maxEntries?: number;
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

function isAllowedUrl(url: string, source: ExternalGuidanceSource): boolean {
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

  return {
    id: requiredString(raw.id, 'id'),
    source: source.id,
    trustTier: source.trustTier,
    url,
    fetchedAt: requiredString(raw.fetchedAt, 'fetchedAt'),
    contentHash: requiredString(raw.contentHash, 'contentHash'),
    suggestion: requiredString(raw.suggestion, 'suggestion'),
    target: parseTarget(raw.target),
    ...(optionalString(raw.title, 'title')
      ? { title: optionalString(raw.title, 'title') }
      : {}),
    ...(parseFacts(raw.facts) ? { facts: parseFacts(raw.facts) } : {}),
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

export function readExternalGuidanceSnapshots(
  dir: string,
  opts: ParseExternalGuidanceOptions = {}
): ExternalGuidance[] {
  const maxEntries = normalizeMaxEntries(opts.maxEntries);
  const maxFileBytes = opts.maxFileBytes ?? CONFIG_FILE_MAX_BYTES;
  return readDirentsBoundedSync(dir, maxEntries)
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => join(dir, entry.name))
    .sort()
    .map((path) =>
      parseExternalGuidanceSnapshot(
        JSON.parse(readTextFileCappedSync(path, maxFileBytes))
      )
    );
}
