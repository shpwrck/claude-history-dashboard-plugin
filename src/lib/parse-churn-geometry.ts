import { parseJsonl, parseMessage, type RawSessionEntry } from './parse-utils';

export interface StructuredPatchEdit {
  sessionId: string;
  timestamp: string;
  toolUseId: string;
  toolName: string;
  filePath: string;
  originalFile?: string;
  userModified: boolean;
  taskIndex: number;
  oldStart: number | null;
  oldLines: number;
  newStart: number | null;
  newLines: number;
  lines: number;
  grossLines: number;
  netLines: number;
  emptyPatch: boolean;
}

export interface ChurnGeometryFile {
  sessionId: string;
  filePath: string;
  tasks: number;
  edits: number;
  userModifiedEdits: number;
  emptyPatchWrites: number;
  grossLines: number;
  netLines: number;
  netAbsLines: number;
  reeditRanges: number;
  postStopReeditRanges: number;
  reworkDistance: number;
}

export interface ChurnGeometrySession {
  sessionId: string;
  edits: StructuredPatchEdit[];
  files: ChurnGeometryFile[];
}

interface RawChurnEntry extends RawSessionEntry {
  subtype?: string;
  toolUseResult?: unknown;
}

interface ToolUseMeta {
  toolName: string;
  filePath?: string;
}

type StructuredPatchInput = Record<string, unknown>;

const MUTATING_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit', 'Write']);
const MAX_EDIT_ROWS = 200;

function num(v: unknown): number | null {
  return typeof v === 'number' && isFinite(v) ? v : null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function parseTime(timestamp: string): number {
  const t = Date.parse(timestamp);
  return isFinite(t) ? t : 0;
}

function distillFilePath(v: unknown): string | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const r = v as Record<string, unknown>;
  return str(r.filePath) ?? str(r.file_path) ?? str(r.path);
}

function taskIndexFor(timestamp: string, stopTimes: number[]): number {
  const t = parseTime(timestamp);
  if (t === 0) return 0;
  let idx = 0;
  for (const stop of stopTimes) {
    if (stop <= t) idx += 1;
    else break;
  }
  return idx;
}

function patchItems(value: unknown): StructuredPatchInput[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is StructuredPatchInput => !!v && typeof v === 'object');
  }
  if (value && typeof value === 'object') return [value as StructuredPatchInput];
  return [];
}

function extractToolUseResults(entry: RawChurnEntry): unknown[] {
  const out: unknown[] = [];
  if (entry.toolUseResult) out.push(entry.toolUseResult);

  const msg = parseMessage(entry.message);
  if (!msg || !Array.isArray(msg.content)) return out;
  for (const block of msg.content) {
    if (!block || typeof block !== 'object') continue;
    const maybe = block as Record<string, unknown>;
    if (maybe.toolUseResult) out.push(maybe.toolUseResult);
    if (maybe.tool_use_result) out.push(maybe.tool_use_result);
  }
  return out;
}

function collectToolUses(text: string): Map<string, ToolUseMeta> {
  const byId = new Map<string, ToolUseMeta>();
  for (const entry of parseJsonl(text)) {
    if (entry.type !== 'assistant') continue;
    const msg = parseMessage(entry.message);
    if (!msg || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type !== 'tool_use' || !block.id) continue;
      byId.set(block.id, {
        toolName: block.name ?? 'unknown',
        filePath: distillFilePath(block.input),
      });
    }
  }
  return byId;
}

function collectStopTimes(text: string): number[] {
  return parseJsonl(text)
    .filter((e): e is RawChurnEntry => e.type === 'system')
    .filter((e) => e.subtype === 'stop_hook_summary')
    .map((e) => parseTime(e.timestamp ?? ''))
    .filter((t) => t > 0)
    .sort((a, b) => a - b);
}

function editsFromResult(params: {
  sessionId: string;
  timestamp: string;
  taskIndex: number;
  rawResult: unknown;
  toolUseById: Map<string, ToolUseMeta>;
}): StructuredPatchEdit[] {
  const { sessionId, timestamp, taskIndex, rawResult, toolUseById } = params;
  if (!rawResult || typeof rawResult !== 'object') return [];
  const result = rawResult as Record<string, unknown>;

  const toolUseId =
    str(result.toolUseId) ??
    str(result.tool_use_id) ??
    str(result.toolUseID) ??
    '';
  const meta = toolUseById.get(toolUseId);
  const toolName = str(result.toolName) ?? meta?.toolName ?? 'unknown';
  if (!MUTATING_TOOLS.has(toolName)) return [];

  const filePath =
    str(result.filePath) ??
    str(result.file_path) ??
    str(result.path) ??
    meta?.filePath;
  if (!filePath) return [];

  const originalFile = str(result.originalFile);
  const userModified = result.userModified === true;
  const patches = patchItems(result.structuredPatch);

  if (patches.length === 0) {
    return [
      {
        sessionId,
        timestamp,
        toolUseId,
        toolName,
        filePath,
        originalFile,
        userModified,
        taskIndex,
        oldStart: null,
        oldLines: 0,
        newStart: null,
        newLines: 0,
        lines: 0,
        grossLines: 0,
        netLines: 0,
        emptyPatch: true,
      },
    ];
  }

  return patches.map((patch) => {
    const oldStart = num(patch.oldStart);
    const oldLines = num(patch.oldLines) ?? 0;
    const newStart = num(patch.newStart);
    const newLines = num(patch.newLines) ?? 0;
    const lines = num(patch.lines) ?? 0;
    const grossLines = Math.max(oldLines, newLines, lines, 0);
    return {
      sessionId,
      timestamp,
      toolUseId,
      toolName,
      filePath: str(patch.filePath) ?? filePath,
      originalFile,
      userModified,
      taskIndex,
      oldStart,
      oldLines,
      newStart,
      newLines,
      lines,
      grossLines,
      netLines: newLines - oldLines,
      emptyPatch: false,
    };
  });
}

function rangeKey(edit: StructuredPatchEdit): string | null {
  if (edit.oldStart === null) return null;
  const span = Math.max(edit.oldLines, edit.lines, 1);
  return `${edit.oldStart}-${edit.oldStart + span - 1}`;
}

export function summarizeChurnGeometry(
  edits: StructuredPatchEdit[]
): ChurnGeometryFile[] {
  const byFile = new Map<string, StructuredPatchEdit[]>();
  for (const edit of edits) {
    const bucket = byFile.get(edit.filePath) ?? [];
    bucket.push(edit);
    byFile.set(edit.filePath, bucket);
  }

  return [...byFile.entries()]
    .map(([filePath, fileEdits]) => {
      const taskIndexes = new Set(fileEdits.map((e) => e.taskIndex));
      const byRange = new Map<string, StructuredPatchEdit[]>();
      for (const edit of fileEdits) {
        const key = rangeKey(edit);
        if (!key) continue;
        const bucket = byRange.get(key) ?? [];
        bucket.push(edit);
        byRange.set(key, bucket);
      }

      let reeditRanges = 0;
      let postStopReeditRanges = 0;
      for (const rangeEdits of byRange.values()) {
        if (rangeEdits.length < 2) continue;
        reeditRanges += 1;
        if (new Set(rangeEdits.map((e) => e.taskIndex)).size > 1) {
          postStopReeditRanges += 1;
        }
      }

      const grossLines = fileEdits.reduce((sum, e) => sum + e.grossLines, 0);
      const netLines = fileEdits.reduce((sum, e) => sum + e.netLines, 0);
      const netAbsLines = Math.abs(netLines);
      const reworkDistance = grossLines / Math.max(1, netAbsLines);

      return {
        sessionId: fileEdits[0]?.sessionId ?? '',
        filePath,
        tasks: taskIndexes.size,
        edits: fileEdits.length,
        userModifiedEdits: fileEdits.filter((e) => e.userModified).length,
        emptyPatchWrites: fileEdits.filter((e) => e.emptyPatch).length,
        grossLines,
        netLines,
        netAbsLines,
        reeditRanges,
        postStopReeditRanges,
        reworkDistance: +reworkDistance.toFixed(1),
      };
    })
    .sort(
      (a, b) =>
        b.postStopReeditRanges - a.postStopReeditRanges ||
        b.reworkDistance - a.reworkDistance ||
        b.grossLines - a.grossLines
    );
}

export function parseChurnGeometry(
  text: string,
  fileName: string
): ChurnGeometrySession | null {
  const sessionId = fileName.replace(/\.jsonl$/, '');
  const toolUseById = collectToolUses(text);
  const stopTimes = collectStopTimes(text);
  const edits: StructuredPatchEdit[] = [];

  for (const entry of parseJsonl(text) as RawChurnEntry[]) {
    const timestamp = entry.timestamp ?? '';
    if (!timestamp) continue;
    for (const rawResult of extractToolUseResults(entry)) {
      edits.push(
        ...editsFromResult({
          sessionId,
          timestamp,
          taskIndex: taskIndexFor(timestamp, stopTimes),
          rawResult,
          toolUseById,
        })
      );
    }
  }

  if (edits.length === 0) return null;
  const files = summarizeChurnGeometry(edits);
  return {
    sessionId,
    edits: edits.slice(0, MAX_EDIT_ROWS),
    files,
  };
}
