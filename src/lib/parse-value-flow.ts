import type { SessionDimensions } from '../types';
import { evidenceRefForEntry, type EvidenceRef } from './evidence';
import { parseSessionTimeline } from './parse-timeline';
import { parseJsonl, parseMessage } from './parse-utils';
import { scrubSecrets } from './transcript-hygiene';

export interface ValueFlowEdge {
  sessionId: string;
  value: string;
  source: EvidenceRef;
  target: EvidenceRef;
  sourceToolUseId: string;
  targetToolUseId: string;
  confidence: 'high';
  reason: 'distinctive-value-reuse';
}

export interface ValueFlowHypothesis {
  sessionId: string;
  source: EvidenceRef;
  target: EvidenceRef;
  reason: 'temporal-sequence';
}

export interface ValueFlowSession extends SessionDimensions {
  sessionId: string;
  edges: ValueFlowEdge[];
  hypotheses: ValueFlowHypothesis[];
}

export interface ParseValueFlowOptions {
  includeHypotheses?: boolean;
}

interface ToolEvent {
  kind: 'tool_use' | 'tool_result';
  timestamp: string;
  toolUseId: string;
  text: string;
  ref: EvidenceRef;
}

interface PriorValue {
  key: string;
  value: string;
  source: EvidenceRef;
  sourceToolUseId: string;
}

const DISTINCTIVE_TOKEN = /[A-Za-z0-9][A-Za-z0-9._:/@-]{8,}[A-Za-z0-9]/g;
const MAX_EDGES = 200;
const MAX_HYPOTHESES = 200;
// Work bounds: transcripts can carry megabyte tool results (build logs, file
// dumps), so every per-event scan is truncated and every accumulator capped.
// Proven edges require an *exact* distinctive-token match (tokenized on both
// sides), so matching is a Map lookup per input token rather than a substring
// scan of every prior value over the full input.
const MAX_SCAN_CHARS = 16_384;
const MAX_TOKENS_PER_EVENT = 64;
const MAX_PRIOR_VALUES = 1_000;
const MAX_EDGES_PER_PAIR = 3;
const MAX_VALUE_CHARS = 64;

function stringifyContent(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map(stringifyContent).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    const maybe = value as { text?: unknown; content?: unknown };
    if (typeof maybe.text === 'string') return maybe.text;
    if (maybe.content != null) return stringifyContent(maybe.content);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function cleanCandidate(value: string): string {
  return value.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
}

function isDistinctive(value: string): boolean {
  if (value.length < 10 || value.length > 160) return false;
  if (/^[0-9._:/@-]+$/.test(value)) return false;

  const hasLetter = /[A-Za-z]/.test(value);
  const hasDigit = /\d/.test(value);
  const hasSeparator = /[._:/@-]/.test(value);
  const looksHex = /^[a-f0-9]{12,}$/i.test(value) && hasDigit && /[a-f]/i.test(value);
  const looksPath = value.includes('/') && hasLetter;
  const mixedCase = /[a-z]/.test(value) && /[A-Z]/.test(value);

  return (
    looksPath ||
    looksHex ||
    (hasDigit && (hasSeparator || value.length >= 16)) ||
    (hasSeparator && mixedCase)
  );
}

function candidateValues(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const match of text.matchAll(DISTINCTIVE_TOKEN)) {
    const value = cleanCandidate(match[0]);
    if (!isDistinctive(value)) continue;
    const key = value.toLowerCase();
    if (!values.has(key)) {
      values.set(key, value);
      if (values.size >= MAX_TOKENS_PER_EVENT) break;
    }
  }
  return values;
}

function makeRefResolver(timeline: NonNullable<ReturnType<typeof parseSessionTimeline>>) {
  const indexesByKey = new Map<string, number[]>();
  timeline.entries.forEach((entry, index) => {
    if (entry.kind !== 'tool_use' && entry.kind !== 'tool_result') return;
    const key = `${entry.kind}|${entry.timestamp}|${entry.toolUseId ?? ''}`;
    const indexes = indexesByKey.get(key);
    if (indexes) indexes.push(index);
    else indexesByKey.set(key, [index]);
  });
  return (event: {
    kind: 'tool_use' | 'tool_result';
    timestamp: string;
    toolUseId: string;
  }): EvidenceRef | null => {
    const indexes = indexesByKey.get(
      `${event.kind}|${event.timestamp}|${event.toolUseId}`
    );
    const index = indexes?.shift();
    if (index == null) return null;
    return evidenceRefForEntry(timeline, index);
  };
}

function collectToolEvents(
  text: string,
  resolveRef: ReturnType<typeof makeRefResolver>
): ToolEvent[] {
  const events: ToolEvent[] = [];
  for (const raw of parseJsonl(text)) {
    const timestamp = raw.timestamp ?? '';
    if (!timestamp) continue;
    const msg = parseMessage(raw.message);
    if (!msg || !Array.isArray(msg.content)) continue;

    if (raw.type === 'assistant') {
      for (const block of msg.content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type !== 'tool_use' || typeof block.id !== 'string') continue;
        const ref = resolveRef({
          kind: 'tool_use',
          timestamp,
          toolUseId: block.id,
        });
        if (!ref) continue;
        events.push({
          kind: 'tool_use',
          timestamp,
          toolUseId: block.id,
          text: stringifyContent(block.input).slice(0, MAX_SCAN_CHARS),
          ref,
        });
      }
    } else if (raw.type === 'user') {
      for (const block of msg.content) {
        if (!block || typeof block !== 'object') continue;
        if (
          block.type !== 'tool_result' ||
          typeof block.tool_use_id !== 'string'
        ) {
          continue;
        }
        const ref = resolveRef({
          kind: 'tool_result',
          timestamp,
          toolUseId: block.tool_use_id,
        });
        if (!ref) continue;
        events.push({
          kind: 'tool_result',
          timestamp,
          toolUseId: block.tool_use_id,
          text: stringifyContent(block.content).slice(0, MAX_SCAN_CHARS),
          ref,
        });
      }
    }
  }
  return events.sort((a, b) => a.ref.entryIndex - b.ref.entryIndex);
}

export function parseValueFlow(
  text: string,
  fileName: string,
  options: ParseValueFlowOptions = {}
): ValueFlowSession | null {
  const timeline = parseSessionTimeline(text, fileName);
  if (!timeline) return null;
  const includeHypotheses = options.includeHypotheses ?? true;

  const events = collectToolEvents(text, makeRefResolver(timeline));
  // Keyed by lowercased token; first occurrence wins so an edge always points
  // at the earliest provenance of a value.
  const priorValues = new Map<string, PriorValue>();
  const edges: ValueFlowEdge[] = [];
  const hypotheses: ValueFlowHypothesis[] = [];
  const edgesPerPair = new Map<string, number>();
  const seenHypotheses = new Set<string>();
  let lastResult: ToolEvent | null = null;

  for (const event of events) {
    if (event.kind === 'tool_result') {
      for (const [key, value] of candidateValues(event.text)) {
        if (priorValues.size >= MAX_PRIOR_VALUES) break;
        if (!priorValues.has(key)) {
          priorValues.set(key, {
            key,
            value,
            source: event.ref,
            sourceToolUseId: event.toolUseId,
          });
        }
      }
      lastResult = event;
      continue;
    }

    if (!event.text) continue;
    let matchedLastResult = false;

    for (const key of candidateValues(event.text).keys()) {
      const prior = priorValues.get(key);
      if (!prior) continue;
      if (prior.sourceToolUseId === event.toolUseId) continue;
      if (prior.source.entryIndex === lastResult?.ref.entryIndex) {
        matchedLastResult = true;
      }
      const pairKey = `${prior.source.entryIndex}:${event.ref.entryIndex}`;
      const pairCount = edgesPerPair.get(pairKey) ?? 0;
      if (pairCount >= MAX_EDGES_PER_PAIR) continue;
      edgesPerPair.set(pairKey, pairCount + 1);
      edges.push({
        sessionId: timeline.sessionId,
        value: scrubSecrets(prior.value).slice(0, MAX_VALUE_CHARS),
        source: prior.source,
        target: event.ref,
        sourceToolUseId: prior.sourceToolUseId,
        targetToolUseId: event.toolUseId,
        confidence: 'high',
        reason: 'distinctive-value-reuse',
      });
      if (edges.length >= MAX_EDGES) break;
    }
    if (
      includeHypotheses &&
      lastResult &&
      lastResult.toolUseId !== event.toolUseId &&
      !matchedLastResult &&
      hypotheses.length < MAX_HYPOTHESES
    ) {
      const hypothesisKey = [
        lastResult.ref.entryIndex,
        event.ref.entryIndex,
      ].join(':');
      if (!seenHypotheses.has(hypothesisKey)) {
        seenHypotheses.add(hypothesisKey);
        hypotheses.push({
          sessionId: timeline.sessionId,
          source: lastResult.ref,
          target: event.ref,
          reason: 'temporal-sequence',
        });
      }
    }
    if (edges.length >= MAX_EDGES) break;
  }

  if (edges.length === 0 && hypotheses.length === 0) return null;
  return {
    sessionId: timeline.sessionId,
    edges,
    hypotheses,
    version: timeline.version,
    gitBranch: timeline.gitBranch,
    entrypoint: timeline.entrypoint,
    serviceTier: timeline.serviceTier,
  };
}
