import { opendirSync, type Dirent } from 'node:fs';

export function normalizeMaxEntries(maxEntries?: number): number {
  if (
    typeof maxEntries !== 'number' ||
    !Number.isFinite(maxEntries) ||
    maxEntries < 0
  ) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.floor(maxEntries);
}

export function remainingEntryCapacity(maxEntries: number, used: number): number {
  return Math.max(0, maxEntries - used);
}

export function readDirentsBoundedSync(
  dirPath: string,
  maxEntries?: number
): Dirent[] {
  const limit = normalizeMaxEntries(maxEntries);
  const entries: Dirent[] = [];
  let dir;
  try {
    dir = opendirSync(dirPath);
  } catch {
    return entries;
  }
  try {
    while (entries.length < limit) {
      const ent = dir.readSync();
      if (!ent) break;
      entries.push(ent);
    }
  } finally {
    try {
      dir.closeSync();
    } catch {
      /* ignore close failures */
    }
  }
  return entries;
}
