import { afterEach, describe, expect, it } from 'vitest';
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drainAdoptionSpool, drainAdoptionSpoolQuiet } from './adoption-spool';
import {
  ADOPTION_RECEIPT_LINE_MAX_BYTES,
  readAdoptionReceipts,
} from './adoption-receipts';

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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * A spool big enough to need several destination appends: the drain caps one
 * append at 64 KiB, so anything above that exercises the multi-batch commit
 * protocol rather than the trivial single-write path.
 */
function multiBatchSpoolBody(count: number): string {
  let body = '';
  for (let i = 0; i < count; i += 1) {
    body += surfacedLine(`s${String(i).padStart(5, '0')}`, [
      'cost.cache',
      'workflow.native-bypass',
      'reliability.rate-limits',
    ]);
  }
  return body;
}

function surfacedHashes(receipts: { kind: string }[]): string[] {
  return receipts
    .filter((receipt) => receipt.kind === 'SURFACED')
    .map((receipt) => (receipt as { sessionHash: string }).sessionHash);
}

describe('drainAdoptionSpool', () => {
  // #3106 (a): a batch that only PARTIALLY reached the destination must be
  // resumed, never replayed. The drain commits each 64 KiB batch with the
  // snapshot offset it covers, so an interruption between batches leaves the
  // already-appended prefix committed and the retry starts after it.
  it('resumes a partially committed multi-batch drain instead of replaying it', async () => {
    const dir = await makeDir();
    const spool = join(dir, 'adoption-spool.jsonl');
    const receipts = join(dir, 'adoption-receipts.jsonl');
    const total = 1200;
    await writeFile(spool, multiBatchSpoolBody(total), 'utf8');

    let batches = 0;
    const interrupted = await drainAdoptionSpool(spool, receipts, {
      now,
      env: {},
      shadowCallsDir: join(dir, 'sc'),
      onPhase: (phase) => {
        if (phase !== 'batch-committed') return;
        batches += 1;
        // Interrupt immediately after the first batch reached the destination:
        // the reviewer's "process exits / disk fills / stream errors mid-batch".
        if (batches === 1) throw new Error('injected mid-batch failure');
      },
    });

    const partial = await readAdoptionReceipts(receipts, now);
    // A prefix landed, the rest did not, and no line is corrupt.
    expect(partial.skipped).toBe(0);
    expect(partial.receipts.length).toBeGreaterThan(0);
    expect(partial.receipts.length).toBeLessThan(total);
    expect(interrupted.drained).toBeGreaterThan(0);
    expect(
      (await readdir(dir)).filter((name) => name.endsWith('.snapshot'))
    ).toHaveLength(1);

    const resumed = await drainAdoptionSpool(spool, receipts, {
      now,
      env: {},
      shadowCallsDir: join(dir, 'sc'),
    });
    // The retry appends only what was still missing.
    expect(resumed.drained).toBe(total - partial.receipts.length);

    const replay = await readAdoptionReceipts(receipts, now);
    expect(replay.skipped).toBe(0);
    const hashes = surfacedHashes(replay.receipts);
    // Exactly once, in the original spool order: no duplicate, no gap.
    expect(hashes).toHaveLength(total);
    expect(new Set(hashes).size).toBe(total);
    expect(hashes[0]).toBe('s00000');
    expect(hashes[total - 1]).toBe(`s${String(total - 1).padStart(5, '0')}`);
    expect(
      (await readdir(dir)).filter((name) => name.endsWith('.snapshot'))
    ).toEqual([]);
  });

  // #3106 (c): the canonical receipts log has several independent appenders.
  // Every destination write is one whole-line `appendFile`, so a receipt POSTed
  // exactly at a batch boundary can never be merged into a split record.
  it('never splits a record when another writer appends at a batch boundary', async () => {
    const dir = await makeDir();
    const spool = join(dir, 'adoption-spool.jsonl');
    const receipts = join(dir, 'adoption-receipts.jsonl');
    const total = 1200;
    await writeFile(spool, multiBatchSpoolBody(total), 'utf8');

    let interlopers = 0;
    const result = await drainAdoptionSpool(spool, receipts, {
      now,
      env: {},
      shadowCallsDir: join(dir, 'sc'),
      onPhase: async (phase) => {
        if (phase !== 'batch-committed') return;
        await appendFile(
          receipts,
          surfacedLine(`post-${interlopers}`, ['posted']),
          'utf8'
        );
        interlopers += 1;
      },
    });

    expect(result).toEqual({ drained: total, skipped: 0 });
    // More than one batch, so at least one interloper landed BETWEEN two
    // destination appends — the exact interleaving that corrupted lines before.
    expect(interlopers).toBeGreaterThan(1);
    const replay = await readAdoptionReceipts(receipts, now);
    expect(replay.skipped).toBe(0);
    expect(replay.receipts).toHaveLength(total + interlopers);
    expect(surfacedHashes(replay.receipts)).toContain('post-0');
  });

  // Same property under a real, untimed race rather than a barrier: an appender
  // hammering the log for the whole drain must never corrupt or lose a line.
  it('tolerates an unsynchronized concurrent appender for a whole drain', async () => {
    const dir = await makeDir();
    const spool = join(dir, 'adoption-spool.jsonl');
    const receipts = join(dir, 'adoption-receipts.jsonl');
    const total = 1500;
    await writeFile(spool, multiBatchSpoolBody(total), 'utf8');

    let racing = true;
    let posted = 0;
    const appender = (async () => {
      while (racing) {
        await appendFile(receipts, surfacedLine(`post-${posted}`, ['posted']), 'utf8');
        posted += 1;
      }
    })();
    const result = await drainAdoptionSpool(spool, receipts, {
      now,
      env: {},
      shadowCallsDir: join(dir, 'sc'),
    });
    racing = false;
    await appender;

    expect(result).toEqual({ drained: total, skipped: 0 });
    const replay = await readAdoptionReceipts(receipts, now);
    expect(replay.skipped).toBe(0);
    expect(replay.receipts).toHaveLength(total + posted);
  });

  // #3106 (b), narrowed: rotation cannot quiesce a producer that already holds
  // a descriptor on the live spool — its bytes land in the ROTATED snapshot,
  // behind the read cursor. The drain must chase that tail and must not unlink
  // a snapshot whose bytes it has not all consumed.
  it('drains a tail written through a descriptor opened before rotation', async () => {
    const dir = await makeDir();
    const spool = join(dir, 'adoption-spool.jsonl');
    const receipts = join(dir, 'adoption-receipts.jsonl');
    await writeFile(spool, surfacedLine('queued', ['cost.cache']), 'utf8');

    // The hook opens the live spool for append, then is descheduled.
    const hookFd = await open(spool, 'a');
    let wrote = false;
    const result = await drainAdoptionSpool(spool, receipts, {
      now,
      env: {},
      shadowCallsDir: join(dir, 'sc'),
      onPhase: async (phase) => {
        if (phase !== 'snapshot-read' || wrote) return;
        wrote = true;
        // It finally writes — through the pre-rotation descriptor, so the bytes
        // go to the snapshot the drain has already read to EOF.
        await hookFd.write(surfacedLine('pre-rotation-fd', ['workflow.native']));
      },
    });
    await hookFd.close();

    expect(result).toEqual({ drained: 2, skipped: 0 });
    const replay = await readAdoptionReceipts(receipts, now);
    expect(replay.skipped).toBe(0);
    expect(surfacedHashes(replay.receipts)).toEqual(['queued', 'pre-rotation-fd']);
    expect(
      (await readdir(dir)).filter((name) => name.endsWith('.snapshot'))
    ).toEqual([]);
  });

  it('retains, rather than unlinks, a snapshot that grew past what it consumed', async () => {
    const dir = await makeDir();
    const spool = join(dir, 'adoption-spool.jsonl');
    const receipts = join(dir, 'adoption-receipts.jsonl');
    await writeFile(spool, surfacedLine('queued', ['cost.cache']), 'utf8');

    const hookFd = await open(spool, 'a');
    // Write on the LAST tail pass so the drain runs out of passes with unread
    // bytes still in the snapshot. It must leave the snapshot in place.
    let reads = 0;
    await drainAdoptionSpool(spool, receipts, {
      now,
      env: {},
      shadowCallsDir: join(dir, 'sc'),
      onPhase: async (phase) => {
        if (phase !== 'snapshot-read') return;
        reads += 1;
        await hookFd.write(surfacedLine(`late-${reads}`, ['workflow.native']));
      },
    });
    expect(reads).toBeGreaterThan(1);
    expect(
      (await readdir(dir)).filter((name) => name.endsWith('.snapshot'))
    ).toHaveLength(1);
    await hookFd.close();

    // The retained snapshot resumes from its committed offset on the next pass.
    await drainAdoptionSpool(spool, receipts, {
      now,
      env: {},
      shadowCallsDir: join(dir, 'sc'),
    });
    const replay = await readAdoptionReceipts(receipts, now);
    expect(replay.skipped).toBe(0);
    const hashes = surfacedHashes(replay.receipts);
    expect(new Set(hashes).size).toBe(hashes.length);
    expect(hashes[0]).toBe('queued');
    expect(hashes).toContain(`late-${reads}`);
  });

  it('keeps a receipt appended after snapshot EOF queued for the next drain', async () => {
    const dir = await makeDir();
    const spool = join(dir, 'adoption-spool.jsonl');
    const receipts = join(dir, 'adoption-receipts.jsonl');
    await writeFile(
      spool,
      surfacedLine('before-rotation', ['cost.cache']),
      'utf8'
    );

    const snapshotRead = deferred();
    const continueDrain = deferred();
    const firstDrain = drainAdoptionSpool(spool, receipts, {
      now,
      env: {},
      shadowCallsDir: join(dir, 'sc'),
      onPhase: async (phase) => {
        if (phase !== 'snapshot-read') return;
        snapshotRead.resolve();
        await continueDrain.promise;
      },
    });

    await Promise.race([
      snapshotRead.promise,
      new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error('snapshot EOF barrier was not reached')),
          500
        );
      }),
    ]);
    await appendFile(
      spool,
      surfacedLine('during-drain', ['workflow.native-bypass']),
      'utf8'
    );
    continueDrain.resolve();

    expect(await firstDrain).toEqual({ drained: 1, skipped: 0 });
    expect(await readFile(spool, 'utf8')).toContain(
      '"sessionHash":"during-drain"'
    );

    expect(
      await drainAdoptionSpool(spool, receipts, {
        now,
        env: {},
        shadowCallsDir: join(dir, 'sc'),
      })
    ).toEqual({ drained: 1, skipped: 0 });

    const replay = await readAdoptionReceipts(receipts, now);
    expect(
      replay.receipts.map(
        (receipt) => receipt.kind === 'SURFACED' && receipt.sessionHash
      )
    ).toEqual(['before-rotation', 'during-drain']);
  });

  it('does not replay a snapshot whose destination append committed before retirement failed', async () => {
    const dir = await makeDir();
    const spool = join(dir, 'adoption-spool.jsonl');
    const receipts = join(dir, 'adoption-receipts.jsonl');
    await writeFile(
      spool,
      surfacedLine('append-committed', ['cost.cache']),
      'utf8'
    );

    let destinationAppended = false;
    const interrupted = await drainAdoptionSpool(spool, receipts, {
      now,
      env: {},
      shadowCallsDir: join(dir, 'sc'),
      onPhase: (phase) => {
        if (phase === 'destination-appended') destinationAppended = true;
        if (phase === 'before-snapshot-retire') {
          expect(destinationAppended).toBe(true);
          throw new Error('injected snapshot retirement failure');
        }
      },
    });
    // Reports what actually committed: the batch DID reach the destination, only
    // retirement failed. (Before #3106's commit protocol this reported 0 while a
    // receipt had in fact landed.)
    expect(interrupted).toEqual({ drained: 1, skipped: 0 });
    expect(destinationAppended).toBe(true);

    await drainAdoptionSpool(spool, receipts, {
      now,
      env: {},
      shadowCallsDir: join(dir, 'sc'),
    });

    const replay = await readAdoptionReceipts(receipts, now);
    expect(replay.skipped).toBe(0);
    expect(
      replay.receipts.map(
        (receipt) => receipt.kind === 'SURFACED' && receipt.sessionHash
      )
    ).toEqual(['append-committed']);
    expect(
      (await readdir(dir)).filter((name) => name.endsWith('.snapshot'))
    ).toEqual([]);
  });

  it('serializes concurrent drainers before either can rotate the recreated live target', async () => {
    const dir = await makeDir();
    const spool = join(dir, 'adoption-spool.jsonl');
    const receipts = join(dir, 'adoption-receipts.jsonl');
    await writeFile(spool, surfacedLine('serialized', ['cost.cache']), 'utf8');

    const firstSnapshotRead = deferred();
    const continueFirst = deferred();
    const firstDrain = drainAdoptionSpool(spool, receipts, {
      now,
      env: {},
      shadowCallsDir: join(dir, 'sc'),
      onPhase: async (phase) => {
        if (phase !== 'snapshot-read') return;
        firstSnapshotRead.resolve();
        await continueFirst.promise;
      },
    });
    await firstSnapshotRead.promise;

    const secondSnapshotRead = deferred();
    const secondDrain = drainAdoptionSpool(spool, receipts, {
      now,
      env: {},
      shadowCallsDir: join(dir, 'sc'),
      onPhase: (phase) => {
        if (phase === 'snapshot-read') secondSnapshotRead.resolve();
      },
    });
    const secondEnteredWhileFirstHeld = await Promise.race([
      secondSnapshotRead.promise.then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), 100);
      }),
    ]);
    expect(secondEnteredWhileFirstHeld).toBe(false);

    continueFirst.resolve();
    await Promise.all([firstDrain, secondDrain]);
    const replay = await readAdoptionReceipts(receipts, now);
    expect(
      replay.receipts.map(
        (receipt) => receipt.kind === 'SURFACED' && receipt.sessionHash
      )
    ).toEqual(['serialized']);
  });

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
    const replay = await readAdoptionReceipts(receipts, now);
    expect(replay.skipped).toBe(0);
    expect(replay.receipts).toHaveLength(2);
    expect(replay.receipts[0]).toMatchObject({
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
    const replay = await readAdoptionReceipts(receipts, now);
    expect(replay.skipped).toBe(0);
    expect(replay.receipts).toHaveLength(2);
    expect(
      replay.receipts[0].kind === 'SURFACED' && replay.receipts[0].sessionHash
    ).toBe('prior');
    expect(
      replay.receipts[1].kind === 'SURFACED' && replay.receipts[1].sessionHash
    ).toBe('s1');
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
    const replay = await readAdoptionReceipts(receipts, now);
    expect(replay.skipped).toBe(0);
    expect(replay.receipts).toHaveLength(1);
    expect(replay.receipts[0]).toEqual({
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
    const replay = await readAdoptionReceipts(receipts, now);
    expect(replay.skipped).toBe(0);
    expect(replay.receipts).toHaveLength(1);
    expect(replay.receipts[0]).toMatchObject({ sessionHash: 's1' });
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

  it('does not rotate or scan an empty live spool', async () => {
    const dir = await makeDir();
    const spool = join(dir, 'adoption-spool.jsonl');
    const receipts = join(dir, 'adoption-receipts.jsonl');
    await writeFile(spool, '', 'utf8');
    const phases: string[] = [];

    const result = await drainAdoptionSpool(spool, receipts, {
      now,
      env: {},
      shadowCallsDir: join(dir, 'sc'),
      onPhase: (phase) => {
        phases.push(phase);
      },
    });

    expect(result).toEqual({ drained: 0, skipped: 0 });
    expect(phases).toEqual([]);
    expect(await readFile(spool, 'utf8')).toBe('');
  });
});
