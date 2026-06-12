// Forensic-graph model (#1307, epic #807): folds a session timeline into
// turn -> tool-call structure and re-anchors proven value-flow edges (#1306)
// on their tool_use nodes. Pure data shaping for SessionForensicGraph.tsx,
// kept out of the component file so react-refresh sees components only.
import type { SessionTokenData } from '../types';
import type { SessionTimeline } from './parse-timeline';
import type { ValueFlowSession } from './parse-value-flow';

export interface ToolNode {
  entryIndex: number;
  toolUseId?: string;
  toolName?: string;
  isError?: boolean;
}

export interface TurnNode {
  turnIndex: number;
  /** Entry index of the user entry that opened the turn (null for a leading assistant run). */
  userEntryIndex: number | null;
  /** ISO timestamp the turn starts at (for token attribution). */
  startTime: string;
  label: string;
  toolCalls: ToolNode[];
  outputTokens: number;
}

export interface FlowEdgeModel {
  sourceEntryIndex: number;
  targetEntryIndex: number;
  value: string;
}

export interface ForensicModel {
  turns: TurnNode[];
  edges: FlowEdgeModel[];
  /** tool_use entryIndex for every entry (tool_use or its tool_result) keyed by entryIndex. */
  toolUseIndexByEntry: Map<number, number>;
}

/**
 * Fold a timeline into turns: a new turn opens at each `user` entry (skipping
 * tool_result carriers, which parse as `tool_result`, not `user`). Tool calls
 * attach to the turn they occur in; output tokens are attributed to a turn by
 * timestamp window [turn start, next turn start).
 */
export function buildForensicModel(
  timeline: SessionTimeline,
  tokens: SessionTokenData | undefined,
  flow: ValueFlowSession | undefined
): ForensicModel {
  const turns: TurnNode[] = [];
  const toolUseIndexByEntry = new Map<number, number>();
  // toolUseId -> tool_use entryIndex, so value-flow sources (tool_result refs)
  // can be re-anchored on the tool node they belong to.
  const toolUseIndexById = new Map<string, number>();

  let current: TurnNode | null = null;
  timeline.entries.forEach((entry, entryIndex) => {
    if (entry.kind === 'user' || current === null) {
      const isUser = entry.kind === 'user';
      current = {
        turnIndex: turns.length,
        userEntryIndex: isUser ? entryIndex : null,
        startTime: entry.timestamp,
        label:
          (isUser ? entry.summary : undefined) ?? `Turn ${turns.length + 1}`,
        toolCalls: [],
        outputTokens: 0,
      };
      turns.push(current);
      if (isUser) return;
    }
    if (entry.kind === 'tool_use') {
      current.toolCalls.push({
        entryIndex,
        toolUseId: entry.toolUseId,
        toolName: entry.toolName,
      });
      toolUseIndexByEntry.set(entryIndex, entryIndex);
      if (entry.toolUseId) toolUseIndexById.set(entry.toolUseId, entryIndex);
    } else if (entry.kind === 'tool_result') {
      const useIndex = entry.toolUseId
        ? toolUseIndexById.get(entry.toolUseId)
        : undefined;
      if (useIndex != null) {
        toolUseIndexByEntry.set(entryIndex, useIndex);
        const owner = turns.find((t) =>
          t.toolCalls.some((c) => c.entryIndex === useIndex)
        );
        const call = owner?.toolCalls.find((c) => c.entryIndex === useIndex);
        if (call && entry.isError) call.isError = true;
      }
    }
  });

  // Token impact per turn: each TokenEntry lands in the latest turn whose
  // start precedes it. Turn starts are chronological, so a reverse scan finds
  // the owner in O(turns) worst case (token entries are few per session).
  if (tokens) {
    const startMs = turns.map((t) => Date.parse(t.startTime));
    for (const tokenEntry of tokens.entries) {
      const ts = Date.parse(tokenEntry.timestamp);
      if (Number.isNaN(ts)) continue;
      for (let i = turns.length - 1; i >= 0; i--) {
        if (!Number.isNaN(startMs[i]) && startMs[i] <= ts) {
          turns[i].outputTokens += tokenEntry.outputTokens;
          break;
        }
      }
    }
  }

  // Anchor edges by stable toolUseId, never by the edge's entryIndex: the
  // refs were computed against the full timeline at parse time, but a
  // time-filtered ViewData drops entries and shifts indexes (valueFlow rows
  // pass through index-unchanged). An id miss drops the edge rather than risk
  // drawing a "proven" arc between unrelated tool calls.
  const edges: FlowEdgeModel[] = [];
  for (const edge of flow?.edges ?? []) {
    const source = toolUseIndexById.get(edge.sourceToolUseId);
    const target = toolUseIndexById.get(edge.targetToolUseId);
    if (source == null || target == null || source === target) continue;
    edges.push({
      sourceEntryIndex: source,
      targetEntryIndex: target,
      value: edge.value,
    });
  }

  return { turns, edges, toolUseIndexByEntry };
}

