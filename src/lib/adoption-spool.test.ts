import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainAdoptionSpool, drainAdoptionSpoolQuiet } from './adoption-spool';
import { ADOPTION_RECEIPT_LINE_MAX_BYTES } from './adoption-receipts';

const tmpDirs: string[] = [];
const now = () => new Date('2026-06-09T12:00:00.000Z');

async function makeDir() {
  const dir = await mkdtemp(join(tmpdir(), 'adoption-spool-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function surfacedLine(sessionHash: string, findingIds: string[]) {
  return (
    JSON.stringify({ kind: 'SURFACED', ts: now().toISOString(), sessionHash, findingIds }) +
    '\n'
  );
}

describe('drainAdoptionSpool', () => {
  it('drains spooled SURFACED receipts into the receipts log and clears the spool', async () => {
    const dir = await makeDir();
    const spool = join(dir, 'adoption-spool.jsonl');
    const receipts = join(dir, 'adoption-receipts.jsonl');
    await writeFile(
      spool,
      surfacedLine('s1', ['cost.cache']) + surfacedLine('s2', ['context.reread']),
      'utf8'
    );

    const result = await drainAdoptionSpool(spool, receipts, {
      now,
      env: {},
      shadowCallsDir: join(dir, 'sc'),
    });

    expect(result).toEqual({ drained: 2, skipped: 0 });
    const lines = (await readFile(receipts, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({
      schemaVersion: '1',
      kind: 'SURFACED',
      sessionHash: 's1',
      findingIds: ['cost.cache'],
    });
    // Spool is emptied (truncated, not removed).
    expect((await readFile(spool, 'utf8')).trim()).toBe('');
  });

  it('appends to an existing receipts log without rewriting prior entries', async () => {
    const dir = await makeDir();
    const spool = join(dir, 'adoption-spool.jsonl');
    const receipts = join(dir, 'adoption-receipts.jsonl');
    await writeFile(
      receipts,
      JSON.stringify({ schemaVersion: '1', kind: 'SURFACED', ts: now().toISOString(), sessionHash: 'prior', findingIds: ['x'] }) + '\n',
      'utf8'
    );
    await writeFile(spool, surfacedLine('s1', ['cost.cache']), 'utf8');

    const result = await drainAdoptionSpool(spool, receipts, {
      now,
      env: {},
      shadowCallsDir: join(dir, 'sc'),
    });

    expect(result.drained).toBe(1);
    const lines = (await readFile(receipts, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).sessionHash).toBe('prior');
    expect(JSON.parse(lines[1]).sessionHash).toBe('s1');
  });

  it('fail-closed drops corrupt lines and non-allowlisted fields', async () => {
    const dir = await makeDir();
    const spool = join(dir, 'adoption-spool.jsonl');
    const receipts = join(dir, 'adoption-receipts.jsonl');
    await writeFile(
      spool,
      [
        'not json at all',
        JSON.stringify({ kind: 'ADOPTED', sessionHash: 's' }), // unknown kind
        JSON.stringify({ kind: 'SURFACED', sessionHash: 's0' }), // missing findingIds
        JSON.stringify({
          kind: 'SURFACED',
          ts: now().toISOString(),
          sessionHash: 's1',
          findingIds: ['cost.cache'],
          cwd: '/secret/repo',
          promptText: 'do not persist',
        }),
        '',
      ].join('\n'),
      'utf8'
    );

    const result = await drainAdoptionSpool(spool, receipts, {
      now,
      env: {},
      shadowCallsDir: join(dir, 'sc'),
    });

    expect(result.drained).toBe(1);
    expect(result.skipped).toBe(3);
    const body = await readFile(receipts, 'utf8');
    const lines = body.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({
      schemaVersion: '1',
      kind: 'SURFACED',
      ts: now().toISOString(),
      sessionHash: 's1',
      findingIds: ['cost.cache'],
    });
    expect(body).not.toContain('/secret/repo');
    expect(body).not.toContain('do not persist');
  });

  it('skips over-limit spooled lines and removes drain temp files', async () => {
    const dir = await makeDir();
    const spool = join(dir, 'adoption-spool.jsonl');
    const receipts = join(dir, 'adoption-receipts.jsonl');
    await writeFile(
      spool,
      [
        JSON.stringify({
          kind: 'SURFACED',
          sessionHash: 'too-large',
          findingIds: ['x'.repeat(ADOPTION_RECEIPT_LINE_MAX_BYTES)],
        }),
        JSON.stringify({
          kind: 'SURFACED',
          ts: now().toISOString(),
          sessionHash: 's1',
          findingIds: ['cost.cache'],
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    const result = await drainAdoptionSpool(spool, receipts, {
      now,
      env: {},
      shadowCallsDir: join(dir, 'sc'),
    });

    expect(result).toEqual({ drained: 1, skipped: 1 });
    const lines = (await readFile(receipts, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ sessionHash: 's1' });
    expect((await readFile(spool, 'utf8')).trim()).toBe('');
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual(
      []
    );
  });

  it('writes nothing and leaves the spool intact when the killswitch is engaged', async () => {
    const dir = await makeDir();
    const spool = join(dir, 'adoption-spool.jsonl');
    const receipts = join(dir, 'adoption-receipts.jsonl');
    const spoolBody = surfacedLine('s1', ['cost.cache']);
    await writeFile(spool, spoolBody, 'utf8');

    // via env
    const viaEnv = await drainAdoptionSpool(spool, receipts, {
      now,
      env: { SHADOW_CALLS_OFF: '1' },
      shadowCallsDir: join(dir, 'sc'),
    });
    expect(viaEnv).toEqual({ drained: 0, skipped: 0, disabled: true });

    // via OFF sentinel file
    const shadowCallsDir = join(dir, 'shadow-calls');
    await mkdir(shadowCallsDir, { recursive: true });
    await writeFile(join(shadowCallsDir, 'OFF'), '');
    const viaSentinel = await drainAdoptionSpool(spool, receipts, {
      now,
      env: {},
      shadowCallsDir,
    });
    expect(viaSentinel).toEqual({ drained: 0, skipped: 0, disabled: true });

    // Receipts never written; spool preserved for a later (enabled) boot.
    let receiptsExists = true;
    try {
      await stat(receipts);
    } catch {
      receiptsExists = false;
    }
    expect(receiptsExists).toBe(false);
    expect(await readFile(spool, 'utf8')).toBe(spoolBody);
  });

  it('is a no-op when the spool does not exist', async () => {
    const dir = await makeDir();
    const spool = join(dir, 'missing-spool.jsonl');
    const receipts = join(dir, 'adoption-receipts.jsonl');
    const result = await drainAdoptionSpoolQuiet(spool, receipts, {
      now,
      env: {},
      shadowCallsDir: join(dir, 'sc'),
    });
    expect(result).toEqual({ drained: 0, skipped: 0 });
  });
});
