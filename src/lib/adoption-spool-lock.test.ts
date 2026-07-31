import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  lstat,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ADOPTION_SPOOL_ROTATION_LOCK_KIND,
  ADOPTION_SPOOL_ROTATION_LOCK_SUFFIX,
  acquireAdoptionSpoolRotationLock,
  adoptionSpoolRotationLockPath,
} from './adoption-spool-lock';
import { drainAdoptionSpool } from './adoption-spool';
import { readAdoptionReceipts } from './adoption-receipts';

// Protocol v1 (#3402) requires DESCRIPTOR/PROCESS-level proof, not an
// in-process mutex timing test: contenders here are real child processes that
// import the lock helper themselves and coordinate with the test only through
// marker files on disk.

const WORKTREE = fileURLToPath(new URL('../..', import.meta.url));
const REGISTER_TS = join(WORKTREE, 'scripts', 'register-ts.mjs');
const LOCK_MODULE_URL = pathToFileURL(
  join(WORKTREE, 'src', 'lib', 'adoption-spool-lock.ts')
).href;

const tmpDirs: string[] = [];
const children: ChildProcess[] = [];
const now = () => new Date('2026-07-31T12:00:00.000Z');

async function makeDir() {
  const dir = await mkdtemp(join(tmpdir(), 'adoption-spool-lock-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (children.length > 0) {
    const child = children.pop()!;
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function surfacedLine(sessionHash: string, findingIds: string[]) {
  return (
    JSON.stringify({
      kind: 'SURFACED',
      ts: now().toISOString(),
      sessionHash,
      findingIds,
    }) + '\n'
  );
}

interface LockChild {
  child: ChildProcess;
  exited: Promise<number | null>;
  stderr: () => string;
}

/**
 * Spawn a real child Node process that runs `code` as an ES module with the
 * repo's TS resolver registered, so the child can `import()` the lock helper
 * straight from its .ts source. Parameters travel via environment variables to
 * avoid embedding paths in the code string.
 */
function spawnLockChild(code: string, env: Record<string, string>): LockChild {
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    ...env,
    CHD_LOCK_MODULE_URL: LOCK_MODULE_URL,
  };
  delete childEnv.NODE_OPTIONS;
  const child = spawn(
    process.execPath,
    ['--import', REGISTER_TS, '--input-type=module', '-e', code],
    { env: childEnv, stdio: ['ignore', 'ignore', 'pipe'] }
  );
  children.push(child);
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += String(chunk);
  });
  const exited = new Promise<number | null>((resolve) => {
    child.on('exit', (exitCode) => resolve(exitCode));
  });
  return { child, exited, stderr: () => stderr };
}

async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  predicate: () => Promise<boolean>,
  what: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Child that acquires the lock, then holds it until a release marker appears. */
const HOLDER_CHILD = `
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
const { acquireAdoptionSpoolRotationLock } = await import(process.env.CHD_LOCK_MODULE_URL);
const lock = await acquireAdoptionSpoolRotationLock(process.env.CHD_SPOOL, {
  role: 'producer',
  budgetMs: 8000,
});
if (!lock) {
  await writeFile(process.env.CHD_FAILED_MARKER, 'acquire-failed');
  process.exit(1);
}
await writeFile(process.env.CHD_LOCKED_MARKER, String(process.pid));
const deadline = Date.now() + 15000;
while (!existsSync(process.env.CHD_RELEASE_MARKER) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
await lock.release();
process.exit(existsSync(process.env.CHD_RELEASE_MARKER) ? 0 : 2);
`;

/** Protocol-abiding producer child: lock → append → release → done marker. */
const PRODUCER_CHILD = `
import { appendFile, writeFile } from 'node:fs/promises';
const { acquireAdoptionSpoolRotationLock } = await import(process.env.CHD_LOCK_MODULE_URL);
await writeFile(process.env.CHD_ATTEMPT_MARKER, String(process.pid));
const lock = await acquireAdoptionSpoolRotationLock(process.env.CHD_SPOOL, {
  role: 'producer',
  budgetMs: 10000,
});
if (!lock) {
  await writeFile(process.env.CHD_FAILED_MARKER, 'acquire-failed');
  process.exit(1);
}
try {
  await appendFile(process.env.CHD_SPOOL, process.env.CHD_LINE, 'utf8');
} finally {
  await lock.release();
}
await writeFile(process.env.CHD_DONE_MARKER, '');
process.exit(0);
`;

/**
 * Stale-reclaim contender: waits for a shared GO marker, then races for the
 * lock. A winner records its token and exits WITHOUT releasing, so the rival
 * cannot subsequently acquire — the test can then count winners exactly.
 */
const CONTENDER_CHILD = `
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
const { acquireAdoptionSpoolRotationLock } = await import(process.env.CHD_LOCK_MODULE_URL);
await writeFile(process.env.CHD_READY_MARKER, '');
const goDeadline = Date.now() + 15000;
while (!existsSync(process.env.CHD_GO_MARKER) && Date.now() < goDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}
const lock = await acquireAdoptionSpoolRotationLock(process.env.CHD_SPOOL, {
  role: 'drain',
  budgetMs: 700,
});
if (lock) {
  await writeFile(process.env.CHD_WIN_MARKER, lock.token);
} else {
  await writeFile(process.env.CHD_LOSE_MARKER, '');
}
process.exit(0);
`;

describe('adoption-spool rotation lock (protocol v1)', () => {
  it('acquires, writes the contract payload, excludes a second acquirer, and releases', async () => {
    const dir = await makeDir();
    const spool = join(dir, 'adoption-spool.jsonl');
    const lockPath = adoptionSpoolRotationLockPath(spool);
    expect(lockPath).toBe(`${spool}${ADOPTION_SPOOL_ROTATION_LOCK_SUFFIX}`);

    const lock = await acquireAdoptionSpoolRotationLock(spool, { role: 'drain' });
    expect(lock).not.toBeNull();
    const payload = JSON.parse(await readFile(lockPath, 'utf8'));
    expect(payload).toEqual({
      schemaVersion: '1',
      kind: ADOPTION_SPOOL_ROTATION_LOCK_KIND,
      role: 'drain',
      pid: process.pid,
      token: lock!.token,
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });

    // A fresh lock excludes a second acquirer for its whole (short) budget.
    expect(
      await acquireAdoptionSpoolRotationLock(spool, {
        role: 'producer',
        budgetMs: 60,
      })
    ).toBeNull();

    await lock!.release();
    expect(await exists(lockPath)).toBe(false);

    // Released means re-acquirable; release is idempotent.
    const again = await acquireAdoptionSpoolRotationLock(spool, {
      role: 'producer',
      budgetMs: 100,
    });
    expect(again).not.toBeNull();
    await again!.release();
    await again!.release();
    expect(await exists(lockPath)).toBe(false);
  });

  it('release leaves a lock alone when a stale reclaim replaced it (token mismatch)', async () => {
    const dir = await makeDir();
    const spool = join(dir, 'adoption-spool.jsonl');
    const lockPath = adoptionSpoolRotationLockPath(spool);

    const lock = await acquireAdoptionSpoolRotationLock(spool, { role: 'drain' });
    expect(lock).not.toBeNull();
    // Simulate a rival that reclaimed our (stale-looking) lock and now holds
    // its own: same path, different token.
    const rival = `${JSON.stringify({
      schemaVersion: '1',
      kind: ADOPTION_SPOOL_ROTATION_LOCK_KIND,
      role: 'producer',
      pid: 99999,
      token: randomUUID(),
      createdAt: now().toISOString(),
    })}\n`;
    await writeFile(lockPath, rival, 'utf8');

    await lock!.release();
    // The rival's lock survives our release.
    expect(await readFile(lockPath, 'utf8')).toBe(rival);
  });

  it('reclaims a stale lock within bounds and leaves no .stale residue', async () => {
    const dir = await makeDir();
    const spool = join(dir, 'adoption-spool.jsonl');
    const lockPath = adoptionSpoolRotationLockPath(spool);
    await writeFile(
      lockPath,
      `${JSON.stringify({
        schemaVersion: '1',
        kind: ADOPTION_SPOOL_ROTATION_LOCK_KIND,
        role: 'producer',
        pid: 1,
        token: randomUUID(),
        createdAt: '2026-07-31T00:00:00.000Z',
      })}\n`,
      'utf8'
    );
    const past = new Date(Date.now() - 60_000);
    await utimes(lockPath, past, past);

    const started = Date.now();
    const lock = await acquireAdoptionSpoolRotationLock(spool, {
      role: 'drain',
      budgetMs: 2000,
    });
    expect(lock).not.toBeNull();
    // Reclaim + reacquire is immediate, not a budget-length stall.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(
      (await readdir(dir)).filter((name) => name.includes('.stale-'))
    ).toEqual([]);
    await lock!.release();
  });

  // (d) A symlink planted at the lock path: acquisition refuses permanently —
  // nothing is followed, nothing is unlinked, and the budget is not waited out.
  it('refuses a symlink planted at the lock path without following or unlinking it', async () => {
    const dir = await makeDir();
    const spool = join(dir, 'adoption-spool.jsonl');
    const lockPath = adoptionSpoolRotationLockPath(spool);
    const victim = join(dir, 'victim');
    const victimBody = 'victim-bytes-must-survive\n';
    await writeFile(victim, victimBody, 'utf8');
    await symlink(victim, lockPath);
    // Make the symlink look stale so a follower would try to reclaim it.
    const past = new Date(Date.now() - 60_000);
    await utimes(victim, past, past);

    const started = Date.now();
    const lock = await acquireAdoptionSpoolRotationLock(spool, {
      role: 'drain',
      budgetMs: 5000,
    });
    expect(lock).toBeNull();
    // Permanent failure returns immediately instead of burning the budget.
    expect(Date.now() - started).toBeLessThan(2500);

    expect((await lstat(lockPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(lockPath)).toBe(victim);
    expect(await readFile(victim, 'utf8')).toBe(victimBody);
    expect(
      (await readdir(dir)).filter((name) => name.includes('.stale-'))
    ).toEqual([]);
  });

  // (a) A child PROCESS holds the lock: the real drain must not rotate the live
  // spool (same inode, no snapshot) until the child releases; then it proceeds.
  it(
    'defers drain rotation while a producer child process holds the lock',
    async () => {
      const dir = await makeDir();
      const spool = join(dir, 'adoption-spool.jsonl');
      const receipts = join(dir, 'adoption-receipts.jsonl');
      await writeFile(spool, surfacedLine('queued', ['cost.cache']), 'utf8');
      const liveInode = (await stat(spool)).ino;

      const lockedMarker = join(dir, 'locked.marker');
      const releaseMarker = join(dir, 'release.marker');
      const failedMarker = join(dir, 'failed.marker');
      const holder = spawnLockChild(HOLDER_CHILD, {
        CHD_SPOOL: spool,
        CHD_LOCKED_MARKER: lockedMarker,
        CHD_RELEASE_MARKER: releaseMarker,
        CHD_FAILED_MARKER: failedMarker,
      });
      await waitFor(
        () => exists(lockedMarker),
        `holder child to acquire the lock (stderr: ${holder.stderr()})`
      );

      let settled = false;
      const drain = drainAdoptionSpool(spool, receipts, {
        now,
        env: {},
        shadowCallsDir: join(dir, 'sc'),
        rotationLockBudgetMs: 8000,
      }).finally(() => {
        settled = true;
      });

      // While the child holds the lock the drain must not have rotated: same
      // live inode, unchanged content, no snapshot, drain still pending.
      await sleep(300);
      expect(settled).toBe(false);
      expect((await stat(spool)).ino).toBe(liveInode);
      expect(await readFile(spool, 'utf8')).toBe(
        surfacedLine('queued', ['cost.cache'])
      );
      expect(
        (await readdir(dir)).filter((name) => name.endsWith('.snapshot'))
      ).toEqual([]);

      await writeFile(releaseMarker, '', 'utf8');
      const result = await drain;
      expect(result).toEqual({ drained: 1, skipped: 0 });
      expect(await holder.exited).toBe(0);

      // Rotation went through after release: recreated (new inode, empty) live
      // spool, retired snapshot, receipt in the canonical log.
      expect((await stat(spool)).ino).not.toBe(liveInode);
      expect(await readFile(spool, 'utf8')).toBe('');
      expect(
        (await readdir(dir)).filter((name) => name.endsWith('.snapshot'))
      ).toEqual([]);
      const replay = await readAdoptionReceipts(receipts, now);
      expect(replay.receipts).toHaveLength(1);
      expect(replay.receipts[0]).toMatchObject({ sessionHash: 'queued' });
    },
    20_000
  );

  // (b) A producer child arriving while the (simulated) drain holds the lock
  // across rotation must block, and after release its append must land in the
  // RECREATED live spool — never in the retired snapshot.
  it(
    'blocks a producer child during rotation so its append lands in the recreated live spool',
    async () => {
      const dir = await makeDir();
      const spool = join(dir, 'adoption-spool.jsonl');
      await writeFile(spool, surfacedLine('queued', ['cost.cache']), 'utf8');
      const originalInode = (await stat(spool)).ino;

      // The test plays the drain: hold the rotation lock, as the drain does
      // across rotateLiveSpool.
      const drainLock = await acquireAdoptionSpoolRotationLock(spool, {
        role: 'drain',
      });
      expect(drainLock).not.toBeNull();

      const attemptMarker = join(dir, 'attempt.marker');
      const doneMarker = join(dir, 'done.marker');
      const failedMarker = join(dir, 'failed.marker');
      const producerLine = surfacedLine('post-rotation-producer', [
        'workflow.native-bypass',
      ]);
      const producer = spawnLockChild(PRODUCER_CHILD, {
        CHD_SPOOL: spool,
        CHD_LINE: producerLine,
        CHD_ATTEMPT_MARKER: attemptMarker,
        CHD_DONE_MARKER: doneMarker,
        CHD_FAILED_MARKER: failedMarker,
      });
      await waitFor(
        () => exists(attemptMarker),
        `producer child to start acquiring (stderr: ${producer.stderr()})`
      );

      // The producer is attempting but the lock is held: no append can land.
      await sleep(200);
      expect(await exists(doneMarker)).toBe(false);
      expect(await readFile(spool, 'utf8')).toBe(
        surfacedLine('queued', ['cost.cache'])
      );

      // Rotate exactly as rotateLiveSpool does, while still holding the lock.
      const snapshot = join(
        dir,
        `.adoption-spool.jsonl.drain-${randomUUID()}.snapshot`
      );
      await rename(spool, snapshot);
      const recreated = await open(spool, 'a', 0o600);
      await recreated.close();
      const recreatedInode = (await stat(spool)).ino;
      expect(recreatedInode).not.toBe(originalInode);
      // Still holding: the producer must still be blocked after rotation.
      await sleep(100);
      expect(await exists(doneMarker)).toBe(false);
      expect(await readFile(spool, 'utf8')).toBe('');

      await drainLock!.release();
      await waitFor(
        () => exists(doneMarker),
        `producer child append after release (stderr: ${producer.stderr()})`
      );
      expect(await producer.exited).toBe(0);
      expect(await exists(failedMarker)).toBe(false);

      // The append reached the RECREATED live file (same identity as the
      // post-rotation inode), and the retired snapshot never saw it.
      expect((await stat(spool)).ino).toBe(recreatedInode);
      expect(await readFile(spool, 'utf8')).toBe(producerLine);
      expect((await stat(snapshot)).ino).toBe(originalInode);
      expect(await readFile(snapshot, 'utf8')).toBe(
        surfacedLine('queued', ['cost.cache'])
      );
    },
    20_000
  );

  // (c) Two contender child processes racing a stale lock: it is reclaimed
  // within bounds and EXACTLY ONE contender wins.
  it(
    'lets exactly one of two concurrent child contenders reclaim a stale lock',
    async () => {
      const dir = await makeDir();
      const spool = join(dir, 'adoption-spool.jsonl');
      const lockPath = adoptionSpoolRotationLockPath(spool);
      await writeFile(spool, '', 'utf8');
      await writeFile(
        lockPath,
        `${JSON.stringify({
          schemaVersion: '1',
          kind: ADOPTION_SPOOL_ROTATION_LOCK_KIND,
          role: 'drain',
          pid: 1,
          token: randomUUID(),
          createdAt: '2026-07-31T00:00:00.000Z',
        })}\n`,
        'utf8'
      );
      const past = new Date(Date.now() - 60_000);
      await utimes(lockPath, past, past);

      const goMarker = join(dir, 'go.marker');
      const contenders = (['a', 'b'] as const).map((name) =>
        spawnLockChild(CONTENDER_CHILD, {
          CHD_SPOOL: spool,
          CHD_READY_MARKER: join(dir, `${name}-ready.marker`),
          CHD_GO_MARKER: goMarker,
          CHD_WIN_MARKER: join(dir, `${name}-win.marker`),
          CHD_LOSE_MARKER: join(dir, `${name}-lose.marker`),
        })
      );
      await waitFor(
        () => exists(join(dir, 'a-ready.marker')),
        `contender a ready (stderr: ${contenders[0].stderr()})`
      );
      await waitFor(
        () => exists(join(dir, 'b-ready.marker')),
        `contender b ready (stderr: ${contenders[1].stderr()})`
      );
      await writeFile(goMarker, '', 'utf8');
      expect(await contenders[0].exited).toBe(0);
      expect(await contenders[1].exited).toBe(0);

      const names = await readdir(dir);
      const wins = names.filter((name) => name.endsWith('-win.marker'));
      const losses = names.filter((name) => name.endsWith('-lose.marker'));
      expect(wins).toHaveLength(1);
      expect(losses).toHaveLength(1);
      // No reclaim residue, and the surviving lock belongs to the winner.
      expect(names.filter((name) => name.includes('.stale-'))).toEqual([]);
      const winnerToken = await readFile(join(dir, wins[0]), 'utf8');
      const surviving = JSON.parse(await readFile(lockPath, 'utf8'));
      expect(surviving).toMatchObject({
        schemaVersion: '1',
        kind: ADOPTION_SPOOL_ROTATION_LOCK_KIND,
        role: 'drain',
        token: winnerToken,
      });
    },
    20_000
  );
});
