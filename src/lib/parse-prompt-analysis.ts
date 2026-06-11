import type { HistoryEntry, PromptAnalysis } from '../types';

const SENTENCE_RE = /[^.!?\n]+[.!?]+|[^.!?\n]+$/g;
const FILE_PATH_RE =
  /(?:^|[\s(["'])((?:\.{1,2}\/|\/)?(?:[A-Za-z0-9_.@-]+\/)+[A-Za-z0-9_.@-]+|[A-Za-z0-9_.@-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|scss|html|yml|yaml|sh|sql|py|go|rs|java|kt|rb|php|toml|lock))(?:$|[\s)"',.:;])/g;
const BACKTICK_RE = /`([^`]+)`/g;
const HEDGING_RE =
  /\b(?:maybe|perhaps|probably|possibly|might|could|not\s+sure|unsure|i\s+think|i\s+guess|kind\s+of|sort\s+of|somehow)\b/i;
const CONSTRAINT_RE =
  /\b(?:acceptance|criteria|must|should|need(?:s|ed)?\s+to|do\s+not|don't|never|only|exactly|without|avoid|keep|ensure|required?|constraint|guardrail)\b/i;
const QUESTION_RE = /\?|^\s*(?:what|why|how|when|where|who|which|can|could|should|would|is|are|do|does|did)\b/i;
const IMPERATIVE_RE =
  /^\s*(?:please\s+)?(?:add|apply|build|change|check|create|delete|document|ensure|expose|fix|implement|keep|make|move|remove|replace|rerun|run|set|show|switch|test|update|use|wire|write)\b/i;
const LOW_SPECIFICITY_MAX_CHARS = 120;

type MutablePromptAnalysis = PromptAnalysis;

function countMatches(text: string, pattern: RegExp): number {
  let count = 0;
  pattern.lastIndex = 0;
  while (pattern.exec(text)) count += 1;
  return count;
}

function countSentences(text: string): number {
  const matches = text.match(SENTENCE_RE);
  return matches ? matches.filter((part) => part.trim().length > 0).length : 0;
}

function pastedContentCount(entry: HistoryEntry): number {
  return Object.keys(entry.pastedContents ?? {}).length;
}

function createRecord(entry: HistoryEntry): MutablePromptAnalysis {
  return {
    sessionId: entry.sessionId,
    project: entry.project,
    promptTurnCount: 0,
    totalPromptChars: 0,
    avgPromptChars: 0,
    sentenceCount: 0,
    questionTurnCount: 0,
    imperativeTurnCount: 0,
    filePathMentionCount: 0,
    backtickIdentifierCount: 0,
    specificityMarkerCount: 0,
    lowSpecificityTurnCount: 0,
    hedgingTurnCount: 0,
    constraintTurnCount: 0,
    pastedContentTurnCount: 0,
    pastedContentCount: 0,
  };
}

function finalize(record: MutablePromptAnalysis): PromptAnalysis {
  return {
    ...record,
    avgPromptChars:
      record.promptTurnCount > 0
        ? record.totalPromptChars / record.promptTurnCount
        : 0,
  };
}

/**
 * Reduce user prompts to per-session numeric traits. No prompt prose is
 * retained in the returned records.
 */
export function parsePromptAnalysis(
  entries: readonly HistoryEntry[]
): PromptAnalysis[] {
  const bySession = new Map<string, MutablePromptAnalysis>();

  for (const entry of entries) {
    const text = entry.display.trim();
    if (!text) continue;

    let record = bySession.get(entry.sessionId);
    if (!record) {
      record = createRecord(entry);
      bySession.set(entry.sessionId, record);
    }

    const filePathMentions = countMatches(text, FILE_PATH_RE);
    const backtickIdentifiers = countMatches(text, BACKTICK_RE);
    const specificityMarkers = filePathMentions + backtickIdentifiers;
    const pastedCount = pastedContentCount(entry);

    record.promptTurnCount += 1;
    record.totalPromptChars += text.length;
    record.sentenceCount += countSentences(text);
    if (QUESTION_RE.test(text)) record.questionTurnCount += 1;
    if (IMPERATIVE_RE.test(text)) record.imperativeTurnCount += 1;
    record.filePathMentionCount += filePathMentions;
    record.backtickIdentifierCount += backtickIdentifiers;
    record.specificityMarkerCount += specificityMarkers;
    if (HEDGING_RE.test(text)) record.hedgingTurnCount += 1;
    if (CONSTRAINT_RE.test(text)) record.constraintTurnCount += 1;
    if (pastedCount > 0) record.pastedContentTurnCount += 1;
    record.pastedContentCount += pastedCount;

    if (text.length <= LOW_SPECIFICITY_MAX_CHARS && specificityMarkers === 0) {
      record.lowSpecificityTurnCount += 1;
    }
  }

  return [...bySession.values()]
    .map(finalize)
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}
