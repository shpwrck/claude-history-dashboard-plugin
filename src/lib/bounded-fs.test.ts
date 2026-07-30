/**
 * Tests for the shared bounded, symlink-refusing artifact read path (#3378).
 *
 * `bounded-fs.ts` had no test file of its own while it was three small helpers.
 * It is now the single hardened read path for every `~/.claude` artifact parser
 * — the place the #3151 symlink boundary and the #3152 byte budget actually
 * live — so it carries the behavioural suite for both, and the parsers that call
 * it test that they call it, not that the guarantees hold.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  symlinkSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_ARTIFACT_MAX_ENTRIES,
  DEFAULT_ARTIFACT_MAX_FILE_BYTES,
  normalizeMaxEntries,
  resolveCap,
  readDirentsBoundedSync,
  readDirentsBoundedDetailedSync,
  readFileInDirBoundedSync,
  readSubdirectoryNamesBoundedSync,
  remainingEntryCapacity,
} from './bounded-fs';

/** A controllable concurrent writer, used to open the stat-then-read race. */
const raceWriter = vi.hoisted(() => ({ path: '', append: '' }));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const realFstat = actual.fstatSync as unknown as (...args: unknown[]) => unknown;
  // Fires once, after the size has been observed but before any bytes are read
  // — precisely what a live (or hostile) writer does.
  const fstatSync = (...args: unknown[]) => {
    const stat = realFstat(...args);
    if (raceWriter.path) {
      const target = raceWriter.path;
      raceWriter.path = '';
      actual.appendFileSync(target, raceWriter.append);
    }
    return stat;
  };
  return { ...actual, default: { ...actual, fstatSync }, fstatSync };
});

const freshDir = (label: string) => mkdtempSync(join(tmpdir(), `bounded-fs-${label}-`));

describe('normalizeMaxEntries', () => {
  it('falls back to the caller-supplied finite default', () => {
    expect(normalizeMaxEntries(undefined, 500)).toBe(500);
    expect(normalizeMaxEntries(Number.NaN, 500)).toBe(500);
    expect(normalizeMaxEntries(Number.POSITIVE_INFINITY, 500)).toBe(500);
    expect(normalizeMaxEntries(-1, 500)).toBe(500);
  });

  it('honours a valid explicit cap, in either direction', () => {
    expect(normalizeMaxEntries(3, 500)).toBe(3);
    expect(normalizeMaxEntries(9_000, 500)).toBe(9_000);
    expect(normalizeMaxEntries(2.9, 500)).toBe(2);
    expect(normalizeMaxEntries(0, 500)).toBe(0);
  });

  it('never yields an unbounded scan, which is the whole point of #3378', () => {
    // Before this change the omitted case returned Number.MAX_SAFE_INTEGER, so
    // "no cap" was what a caller got by forgetting rather than by asking.
    for (const bad of [undefined, Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      const resolved = normalizeMaxEntries(bad, DEFAULT_ARTIFACT_MAX_ENTRIES);
      expect(Number.isFinite(resolved)).toBe(true);
      expect(resolved).toBeLessThan(Number.MAX_SAFE_INTEGER);
      expect(resolved).toBe(DEFAULT_ARTIFACT_MAX_ENTRIES);
    }
  });
});

describe('resolveCap / remainingEntryCapacity', () => {
  it('resolveCap floors valid input and falls back otherwise', () => {
    expect(resolveCap(7.9, 10)).toBe(7);
    expect(resolveCap(undefined, 10)).toBe(10);
    expect(resolveCap(-3, 10)).toBe(10);
  });

  it('remainingEntryCapacity never goes negative', () => {
    expect(remainingEntryCapacity(10, 3)).toBe(7);
    expect(remainingEntryCapacity(10, 25)).toBe(0);
  });
});

describe('readDirentsBoundedDetailedSync (#3140)', () => {
  it('reports truncation when the cap cuts the scan short', () => {
    const dir = freshDir('trunc');
    for (let i = 0; i < 10; i += 1) writeFileSync(join(dir, `f${i}.json`), '{}');
    const scan = readDirentsBoundedDetailedSync(dir, 4);
    expect(scan.entries).toHaveLength(4);
    expect(scan.truncated).toBe(true);
  });

  it('does NOT report truncation when the directory ends exactly at the cap', () => {
    // The boundary a naive `entries.length === cap` check gets wrong: a
    // directory that simply ends at the cap was not truncated. Probing one
    // entry past the cap is what makes truncation a fact instead of a guess.
    const dir = freshDir('exact');
    for (let i = 0; i < 4; i += 1) writeFileSync(join(dir, `f${i}.json`), '{}');
    const scan = readDirentsBoundedDetailedSync(dir, 4);
    expect(scan.entries).toHaveLength(4);
    expect(scan.truncated).toBe(false);
  });

  it('does not report truncation for an under-cap or missing directory', () => {
    const dir = freshDir('under');
    for (let i = 0; i < 2; i += 1) writeFileSync(join(dir, `f${i}.json`), '{}');
    expect(readDirentsBoundedDetailedSync(dir, 50).truncated).toBe(false);
    const missing = readDirentsBoundedDetailedSync(join(dir, 'nope'), 50);
    expect(missing.entries).toHaveLength(0);
    expect(missing.truncated).toBe(false);
  });

  it('agrees with readDirentsBoundedSync on the entries it returns', () => {
    // The delegation contract: the bare helper must keep returning exactly what
    // it returned before, since 11 production modules depend on it.
    const dir = freshDir('delegate');
    for (let i = 0; i < 10; i += 1) writeFileSync(join(dir, `f${i}.json`), '{}');
    for (const cap of [0, 1, 4, 10, 100]) {
      expect(readDirentsBoundedSync(dir, cap).map((e) => e.name)).toEqual(
        readDirentsBoundedDetailedSync(dir, cap).entries.map((e) => e.name)
      );
    }
  });
});

describe('readDirentsBoundedSync', () => {
  it('stops at the cap', () => {
    const dir = freshDir('dirents');
    for (let i = 0; i < 10; i += 1) writeFileSync(join(dir, `f${i}.json`), '{}');
    expect(readDirentsBoundedSync(dir, 4)).toHaveLength(4);
    expect(readDirentsBoundedSync(dir, 100)).toHaveLength(10);
    expect(readDirentsBoundedSync(dir, 0)).toHaveLength(0);
  });

  it('falls back to the default cap on a non-finite one, never to empty', () => {
    const dir = freshDir('nan-cap');
    for (let i = 0; i < 5; i += 1) writeFileSync(join(dir, `f${i}.json`), '{}');
    // Math.max(0, Math.floor(NaN)) is NaN and `length < NaN` is false, so a bad
    // cap would report the directory as EMPTY — a missing result that reads as
    // a fact about the world rather than about the argument.
    expect(readDirentsBoundedSync(dir, Number.NaN)).toHaveLength(5);
    expect(readDirentsBoundedSync(dir, Number.POSITIVE_INFINITY)).toHaveLength(5);
    expect(readDirentsBoundedSync(dir, -1)).toHaveLength(5);
  });

  it('returns empty for a missing directory rather than throwing', () => {
    expect(readDirentsBoundedSync(join(freshDir('missing'), 'nope'), 10)).toEqual([]);
  });
});

describe('readFileInDirBoundedSync — the directory is the boundary (#3151)', () => {
  it('reads an ordinary file and reports the stat of the descriptor it read', () => {
    const dir = freshDir('read');
    writeFileSync(join(dir, 'a.json'), '{"ok":true}');
    const read = readFileInDirBoundedSync(dir, 'a.json');
    expect(read?.text).toBe('{"ok":true}');
    expect(read?.stat.isFile()).toBe(true);
    expect(typeof read?.stat.mtimeMs).toBe('number');
  });

  it('refuses a symlink to a valid file OUTSIDE the directory', () => {
    const outside = freshDir('outside');
    const dir = freshDir('link-out');
    const target = join(outside, 'elsewhere.json');
    writeFileSync(target, '{"stolen":true}');
    symlinkSync(target, join(dir, 'a.json'));
    expect(readFileInDirBoundedSync(dir, 'a.json')).toBeNull();
    // The refusal is about the link, not about the target being unreadable.
    expect(realpathSync(join(dir, 'a.json'))).toBe(realpathSync(target));
  });

  it('refuses a symlink even when its target sits inside the same directory', () => {
    const dir = freshDir('link-in');
    writeFileSync(join(dir, 'real.json'), '{"ok":true}');
    symlinkSync(join(dir, 'real.json'), join(dir, 'alias.json'));
    expect(readFileInDirBoundedSync(dir, 'alias.json')).toBeNull();
    expect(readFileInDirBoundedSync(dir, 'real.json')?.text).toBe('{"ok":true}');
  });

  it('refuses a dangling symlink without throwing', () => {
    const dir = freshDir('dangling');
    symlinkSync(join(dir, 'gone.json'), join(dir, 'a.json'));
    expect(readFileInDirBoundedSync(dir, 'a.json')).toBeNull();
  });

  it('refuses a directory and a missing entry', () => {
    const dir = freshDir('notfile');
    mkdirSync(join(dir, 'sub'));
    expect(readFileInDirBoundedSync(dir, 'sub')).toBeNull();
    expect(readFileInDirBoundedSync(dir, 'absent.json')).toBeNull();
  });

  it('refuses an entry name that would escape the directory', () => {
    const outside = freshDir('escape-target');
    const dir = freshDir('escape');
    writeFileSync(join(outside, 'x.json'), '{"stolen":true}');
    expect(readFileInDirBoundedSync(dir, join('..', 'nope', 'x.json'))).toBeNull();
  });
});

describe('readFileInDirBoundedSync — the byte budget bounds the READ (#3152)', () => {
  afterEach(() => {
    raceWriter.path = '';
    raceWriter.append = '';
  });

  it('skips a file already over budget at stat time', () => {
    const dir = freshDir('big');
    writeFileSync(join(dir, 'a.json'), 'x'.repeat(200));
    expect(readFileInDirBoundedSync(dir, 'a.json', 100)).toBeNull();
    expect(readFileInDirBoundedSync(dir, 'a.json', 1000)?.text).toHaveLength(200);
  });

  it('reads a file exactly at the budget', () => {
    const dir = freshDir('exact');
    writeFileSync(join(dir, 'a.json'), 'x'.repeat(100));
    expect(readFileInDirBoundedSync(dir, 'a.json', 100)?.text).toHaveLength(100);
  });

  it('refuses a file that grows past the budget AFTER it is stat-checked', () => {
    const dir = freshDir('grow');
    const path = join(dir, 'a.json');
    writeFileSync(path, 'x'.repeat(50));
    // The writer fires between the fstat and the first read.
    raceWriter.path = path;
    raceWriter.append = 'y'.repeat(500);
    expect(readFileInDirBoundedSync(dir, 'a.json', 100)).toBeNull();
  });

  it('still reads post-stat growth that stays within budget', () => {
    const dir = freshDir('grow-ok');
    const path = join(dir, 'a.json');
    writeFileSync(path, 'x'.repeat(50));
    raceWriter.path = path;
    raceWriter.append = 'y'.repeat(20);
    const read = readFileInDirBoundedSync(dir, 'a.json', 1000);
    expect(read?.text).toBe('x'.repeat(50) + 'y'.repeat(20));
  });

  it('decodes multi-byte text that spans the growth boundary', () => {
    const dir = freshDir('utf8');
    const path = join(dir, 'a.json');
    writeFileSync(path, 'héllo');
    raceWriter.path = path;
    raceWriter.append = ' wörld ünïcødé';
    expect(readFileInDirBoundedSync(dir, 'a.json', 1000)?.text).toBe('héllo wörld ünïcødé');
  });

  it('defaults to a finite budget when none is supplied', () => {
    const dir = freshDir('default-budget');
    writeFileSync(join(dir, 'a.json'), 'x'.repeat(10));
    expect(readFileInDirBoundedSync(dir, 'a.json')?.text).toHaveLength(10);
    expect(Number.isFinite(DEFAULT_ARTIFACT_MAX_FILE_BYTES)).toBe(true);
    expect(DEFAULT_ARTIFACT_MAX_FILE_BYTES).toBeLessThan(Number.MAX_SAFE_INTEGER);
  });

  it('reads an empty file as an empty string, not a refusal', () => {
    const dir = freshDir('empty');
    writeFileSync(join(dir, 'a.json'), '');
    expect(readFileInDirBoundedSync(dir, 'a.json')?.text).toBe('');
  });
});

describe('readSubdirectoryNamesBoundedSync — the directory half of the boundary', () => {
  it('returns real subdirectories and ignores files', () => {
    const dir = freshDir('subdirs');
    mkdirSync(join(dir, 'one'));
    mkdirSync(join(dir, 'two'));
    writeFileSync(join(dir, 'a.json'), '{}');
    expect(readSubdirectoryNamesBoundedSync(dir, 100).sort()).toEqual(['one', 'two']);
  });

  it('refuses a symlinked directory pointing outside the tree', () => {
    const outside = freshDir('subdir-outside');
    mkdirSync(join(outside, 'foreign'));
    const dir = freshDir('subdir-link');
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(outside, 'foreign'), join(dir, 'linked'));
    expect(readSubdirectoryNamesBoundedSync(dir, 100)).toEqual(['real']);
  });

  it('refuses a symlinked directory even when it points inside the tree', () => {
    const dir = freshDir('subdir-link-in');
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'alias'));
    expect(readSubdirectoryNamesBoundedSync(dir, 100)).toEqual(['real']);
  });

  it('honours the entry cap', () => {
    const dir = freshDir('subdir-cap');
    for (let i = 0; i < 8; i += 1) mkdirSync(join(dir, `d${i}`));
    expect(readSubdirectoryNamesBoundedSync(dir, 3)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// The portable half of the guarantee: platforms without O_NOFOLLOW.
//
// Moved here from parse-session-registry.test.ts in #3378. The behaviour under
// test is now this module's, and that file cannot host it: it carries a hoisted
// `vi.mock('./bounded-fs')` spy whose `importOriginal()` pins an instance of
// this module evaluated OUTSIDE the `doMock('node:fs')` window, so the
// Windows-shaped constants never reach the code under test and the check
// silently reads the real `O_NOFOLLOW` instead.
// ---------------------------------------------------------------------------

describe('readFileInDirBoundedSync — boundary without O_NOFOLLOW (#3151)', () => {
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
  });

  it('refuses an entry swapped for a symlink between the lstat and the open', async () => {
    const outsideDir = freshDir('swap-outside');
    const dir = freshDir('swap');

    // A valid file outside the boundary — what an attacker wants read.
    const outsideTarget = join(outsideDir, 'elsewhere.json');
    writeFileSync(outsideTarget, '{"swapped":true}');

    // Inside the boundary: an ordinary regular file at readdir and lstat time.
    const entryPath = join(dir, 'a.json');
    writeFileSync(entryPath, '{"honest":true}');

    vi.resetModules();
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>();
      const realLstat = actual.lstatSync as unknown as (...args: unknown[]) => unknown;
      let armed = true;
      // The hostile writer: replaces the just-approved regular file with a
      // symlink out of the directory, in the window before the open.
      const lstatSync = (...args: unknown[]) => {
        const stat = realLstat(...args);
        if (armed) {
          armed = false;
          actual.unlinkSync(entryPath);
          actual.symlinkSync(outsideTarget, entryPath);
        }
        return stat;
      };
      // A Windows-shaped fs: O_NOFOLLOW is simply not defined there, so the
      // open flags collapse to a following O_RDONLY and only the dev/ino
      // identity check stands between us and the foreign file.
      const constants = { ...actual.constants } as Record<string, number>;
      delete constants.O_NOFOLLOW;
      return {
        ...actual,
        default: { ...actual, constants, lstatSync },
        constants,
        lstatSync,
      };
    });

    const { readFileInDirBoundedSync: readWithoutNofollow } = await import('./bounded-fs');

    // Nothing is read: the honest file is gone, and the symlink that replaced
    // it must not be followed out of the directory.
    expect(readWithoutNofollow(dir, 'a.json')).toBeNull();

    // The swap really did fire, and it really does resolve outside the
    // boundary — so the null is the identity check, not a no-op.
    expect(lstatSync(entryPath).isSymbolicLink()).toBe(true);
    expect(realpathSync(entryPath)).toBe(realpathSync(outsideTarget));
  });
});
