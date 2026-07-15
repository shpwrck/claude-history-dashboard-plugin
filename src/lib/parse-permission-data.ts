import { parseJsonl, type RawSessionEntry } from './parse-utils';

export interface PermissionChange {
  sessionId: string;
  timestamp: string;
  fromMode: string | null;
  toMode: string;
}

type PermissionSessionEntry = RawSessionEntry & {
  permissionMode?: unknown;
};

/** Browser-safe permission-mode pass used by the upload worker. */
export function parsePermissionData(
  text: string,
  fileName: string
): {
  perModeEntries: { mode: string; sessionId: string }[];
  changes: PermissionChange[];
} | null {
  const sessionId = fileName.replace(/\.jsonl$/, '');
  const perModeEntries: { mode: string; sessionId: string }[] = [];
  const changes: PermissionChange[] = [];
  let lastMode: string | null = null;

  for (const entry of parseJsonl(text) as PermissionSessionEntry[]) {
    const mode = entry.permissionMode;
    if (typeof mode !== 'string' || mode.length === 0) continue;
    perModeEntries.push({ mode, sessionId });
    if (mode !== lastMode) {
      changes.push({
        sessionId,
        timestamp: entry.timestamp ?? '',
        fromMode: lastMode,
        toMode: mode,
      });
      lastMode = mode;
    }
  }

  return perModeEntries.length > 0 ? { perModeEntries, changes } : null;
}
