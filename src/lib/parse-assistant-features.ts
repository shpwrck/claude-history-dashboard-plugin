import { parseJsonl, parseMessage, type ContentBlock } from './parse-utils';
import type { AssistantFeatures } from '../types';

/**
 * Per-turn assistant-behaviour features, aggregated per session (#206 — slice 3
 * of the transcript-ingest work, #181).
 *
 * The recommendations engine can't reason about *how* the assistant behaves —
 * how often it refuses or hedges, how code-dense its replies are, whether it
 * ends turns asking a question — because none of that is in the main dataset.
 * This parser derives a handful of cheap, NUMERIC features so the engine can
 * use them without ever fetching a transcript BLOB. Everything here is a count
 * or a byte size: the per-session record stays a few small integers, so the
 * dataset payload barely grows and the dashboard hot path is untouched.
 *
 * One assistant transcript line = one "turn". Markers are matched once per turn
 * (a turn either contains a refusal or it doesn't), so the counts are turn
 * counts, not phrase counts — `refusalCount / assistantTurnCount` is a rate.
 *
 * Pure and browser-safe: no Node built-ins (byte sizes via `TextEncoder`), so
 * it tree-shakes cleanly out of the client bundle while remaining importable by
 * `scripts/ingest.mjs` at ingest time, exactly like the other `parse-*` modules.
 */

// Refusal / course-correction markers. "you're right" is deliberately included:
// a high rate of the assistant conceding ("you're right", "I apologize") is a
// friction signal — the user is frequently correcting it.
const REFUSAL_RE =
  /\b(?:I\s+(?:cannot|can(?:'|’)?t|won(?:'|’)?t|am\s+unable\s+to|am\s+not\s+able\s+to)|I\s+apologize|I\s+apologise|you(?:'|’)?re\s+right|you\s+are\s+right|my\s+apologies)\b/i;

// Hedging / low-confidence markers.
const HEDGING_RE =
  /\b(?:I\s+think|I\s+believe|I\s+suspect|probably|perhaps|might\s+be|may\s+be|it\s+seems|it\s+appears|not\s+(?:entirely\s+)?sure|I(?:'|’)?m\s+not\s+sure)\b/i;

const CODE_FENCE_RE = /```/g;

const ENCODER = new TextEncoder();
const byteLen = (s: string): number => ENCODER.encode(s).length;

/**
 * Walk a session transcript and aggregate per-turn assistant features.
 * Returns `null` when the session has no assistant turns at all.
 */
export function parseAssistantFeatures(
  text: string,
  fileName: string
): AssistantFeatures | null {
  const sessionId = fileName.replace(/\.jsonl$/, '');

  let assistantTurnCount = 0;
  let textLength = 0;
  let codeBlockCount = 0;
  let toolCallCount = 0;
  let refusalCount = 0;
  let hedgingCount = 0;
  let endsWithQuestionCount = 0;
  let thinkingByteLen = 0;
  let sawAssistant = false;

  for (const entry of parseJsonl(text)) {
    if (entry.type !== 'assistant') continue;
    const msg = parseMessage(entry.message);
    if (!msg || !Array.isArray(msg.content)) continue;

    sawAssistant = true;
    assistantTurnCount += 1;

    // Concatenate this turn's text blocks so markers and the ends-with-question
    // flag are evaluated over the whole turn, not per block.
    let turnText = '';
    for (const block of msg.content as ContentBlock[]) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'text' && typeof block.text === 'string') {
        turnText += (turnText ? '\n' : '') + block.text;
      } else if (block.type === 'tool_use') {
        toolCallCount += 1;
      } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
        thinkingByteLen += byteLen(block.thinking);
      }
    }

    if (turnText.length > 0) {
      textLength += turnText.length;
      const fences = turnText.match(CODE_FENCE_RE);
      if (fences) codeBlockCount += Math.floor(fences.length / 2);
      if (REFUSAL_RE.test(turnText)) refusalCount += 1;
      if (HEDGING_RE.test(turnText)) hedgingCount += 1;
      if (/\?$/.test(turnText.trimEnd())) endsWithQuestionCount += 1;
    }
  }

  if (!sawAssistant) return null;

  return {
    sessionId,
    assistantTurnCount,
    textLength,
    codeBlockCount,
    toolCallCount,
    refusalCount,
    hedgingCount,
    endsWithQuestionCount,
    thinkingByteLen,
  };
}
