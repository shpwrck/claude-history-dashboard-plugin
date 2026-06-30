import { readFile } from 'node:fs/promises';
import {
  STEER_EVENTS,
  MISFIRE_TAGS,
  type SteerEvent,
  type MisfireTag,
  type SteerRecord,
  type SteerRuleTelemetry,
} from './steer-telemetry-types';

/**
 * Reader + aggregator for the PreToolUse-steer delivery/outcome log
 * (`~/.claude/skills/recs/.pretooluse-steer.jsonl`) — #2203, epic #1868.
 *
 * The steer hook already logs every `delivered` / `accepted` / `declined` event
 * keyed by `ruleId`; this consumes that EXISTING channel (no second capture) and
 * rolls it up per rule into fire-count + followed/ignored + any misfire tags. The
 * parse/aggregate halves are pure (testable without node); only `readSteerTelemetry`
 * touches the filesystem, and a missing/empty/unreadable log is an empty result —
 * the dashboard renders a "no data" state rather than crashing.
 */

const MAX_ID_LEN = 200;
const MAX_LINE_BYTES = 8_192;

function asString(value: unknown, maxLen: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLen) return null;
  return trimmed;
}

function asEvent(value: unknown): SteerEvent | null {
  return typeof value === 'string' && (STEER_EVENTS as readonly string[]).includes(value)
    ? (value as SteerEvent)
    : null;
}

function asMisfireTag(value: unknown): MisfireTag | undefined {
  return typeof value === 'string' && (MISFIRE_TAGS as readonly string[]).includes(value)
    ? (value as MisfireTag)
    : undefined;
}

function asTimestamp(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** Sanitize one raw log object into a `SteerRecord`, or `null` if it is not a
 *  well-formed delivery/outcome line (fail-closed — unknown events are dropped). */
export function sanitizeSteerRecord(input: unknown): SteerRecord | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = input as Record<string, unknown>;
  const event = asEvent(raw.event);
  const ruleId = asString(raw.ruleId, MAX_ID_LEN);
  const ts = asTimestamp(raw.ts);
  if (!event || !ruleId || !ts) return null;
  const kind = asString(raw.kind, MAX_ID_LEN) ?? 'steer';
  const misfireTag = asMisfireTag(raw.misfireTag);
  return { ts, event, ruleId, kind, ...(misfireTag ? { misfireTag } : {}) };
}

/** Parse raw JSONL text into sanitized records, dropping blank/oversized/
 *  unparseable/non-conforming lines. Pure. */
export function parseSteerTelemetryLines(raw: string): SteerRecord[] {
  const records: SteerRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // TextEncoder (not Buffer) so the parse/aggregate halves stay genuinely pure
    // — no Node global — and could be reused client-side if ever needed.
    if (new TextEncoder().encode(trimmed).byteLength > MAX_LINE_BYTES) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = sanitizeSteerRecord(parsed);
    if (record) records.push(record);
  }
  return records;
}

/**
 * Roll sanitized records up per `ruleId`: fire-count (delivered), accepted/declined
 * outcome counts, the distinct misfire tags, and the latest timestamp. Pure.
 * Returned rules are sorted by fire-count desc, then ruleId asc, so the busiest
 * steer leads and ties are stable.
 */
export function aggregateSteerTelemetry(records: SteerRecord[]): SteerRuleTelemetry[] {
  const byRule = new Map<
    string,
    {
      kinds: Set<string>;
      fireCount: number;
      acceptedCount: number;
      declinedCount: number;
      misfireTags: Set<MisfireTag>;
      lastTs: string;
    }
  >();
  for (const r of records) {
    let agg = byRule.get(r.ruleId);
    if (!agg) {
      agg = {
        kinds: new Set(),
        fireCount: 0,
        acceptedCount: 0,
        declinedCount: 0,
        misfireTags: new Set(),
        lastTs: '',
      };
      byRule.set(r.ruleId, agg);
    }
    agg.kinds.add(r.kind);
    if (r.event === 'delivered') agg.fireCount += 1;
    else if (r.event === 'accepted') agg.acceptedCount += 1;
    else if (r.event === 'declined') agg.declinedCount += 1;
    if (r.misfireTag) agg.misfireTags.add(r.misfireTag);
    if (r.ts > agg.lastTs) agg.lastTs = r.ts;
  }

  return [...byRule.entries()]
    .map(([ruleId, a]) => ({
      ruleId,
      kinds: [...a.kinds].sort(),
      fireCount: a.fireCount,
      acceptedCount: a.acceptedCount,
      declinedCount: a.declinedCount,
      misfireTags: [...a.misfireTags].sort(),
      lastTs: a.lastTs,
    }))
    .sort((x, y) => y.fireCount - x.fireCount || x.ruleId.localeCompare(y.ruleId));
}

/** Read + aggregate the steer log. Missing/unreadable file ⇒ `[]` (no throw). */
export async function readSteerTelemetry(file: string): Promise<SteerRuleTelemetry[]> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  return aggregateSteerTelemetry(parseSteerTelemetryLines(raw));
}
