/**
 * Tests for the shared byte-capped read (#3419).
 *
 * The three copies this replaces had no direct test of the bound between them;
 * each was exercised only through its caller. The cap is the security-relevant
 * property, so it gets tested here directly.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTextFileCappedSync } from './capped-read';

const dir = () => mkdtempSync(join(tmpdir(), 'capped-read-'));

describe('readTextFileCappedSync', () => {
  it('reads a file inside the budget', () => {
    const d = dir();
    writeFileSync(join(d, 'a.txt'), 'hello');
    expect(readTextFileCappedSync(join(d, 'a.txt'), 100)).toBe('hello');
  });

  it('reads a file exactly at the budget', () => {
    const d = dir();
    writeFileSync(join(d, 'a.txt'), 'x'.repeat(100));
    expect(readTextFileCappedSync(join(d, 'a.txt'), 100)).toHaveLength(100);
  });

  it('throws once the budget is passed', () => {
    const d = dir();
    writeFileSync(join(d, 'a.txt'), 'x'.repeat(101));
    expect(() => readTextFileCappedSync(join(d, 'a.txt'), 100)).toThrow(
      /exceeds the 100 byte read limit/
    );
  });

  it('lets the caller supply its own overflow error', () => {
    const d = dir();
    writeFileSync(join(d, 'a.txt'), 'x'.repeat(200));
    expect(() =>
      readTextFileCappedSync(join(d, 'a.txt'), 10, (limit) =>
        new Error(`Review events cache exceeds ${limit} byte limit`)
      )
    ).toThrow(/Review events cache exceeds 10 byte limit/);
  });

  it('decodes multi-byte text across chunk boundaries', () => {
    const d = dir();
    const text = 'héllo wörld ünïcødé '.repeat(50);
    writeFileSync(join(d, 'a.txt'), text);
    expect(readTextFileCappedSync(join(d, 'a.txt'), 1_000_000)).toBe(text);
  });

  it('reads an empty file as an empty string', () => {
    const d = dir();
    writeFileSync(join(d, 'a.txt'), '');
    expect(readTextFileCappedSync(join(d, 'a.txt'), 100)).toBe('');
  });

  it('FOLLOWS a symlink — these are caller-supplied paths, not directory entries', () => {
    // Deliberate, and the reason #3419 was filed separately from #3378: a user
    // symlinking their own config or token file is normal, and refusing it
    // would break a working setup to close a hole that is not open.
    const target = dir();
    const d = dir();
    writeFileSync(join(target, 'real.json'), '{"ok":true}');
    symlinkSync(join(target, 'real.json'), join(d, 'link.json'));
    expect(readTextFileCappedSync(join(d, 'link.json'), 100)).toBe('{"ok":true}');
  });

  it('bounds the READ, so a file growing mid-read cannot exceed the budget', () => {
    const d = dir();
    const path = join(d, 'a.txt');
    // Larger than one 64 KiB chunk so the loop iterates and the running total
    // trips the cap rather than a prior stat deciding it was small enough.
    writeFileSync(path, 'x'.repeat(200_000));
    appendFileSync(path, 'y'.repeat(200_000));
    expect(() => readTextFileCappedSync(path, 150_000)).toThrow(/read limit/);
  });
});
