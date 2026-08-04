import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  lstat,
  link,
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
  ADOPTION_SPOOL_ROTATION_LOCK_RECLAIM_INFIX,
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

function isReclaimResidue(name: string): boolean {
  return (
    name.includes('.stale-') ||
    name.includes(ADOPTION_SPOOL_ROTATION_LOCK_RECLAIM_INFIX)
  );
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

const STALE_CONTENTION_ROUNDS = 12;
const STALE_CONTENTION_BATCHES = 4;

async function assertSingleStaleReclaimWinner(round: number): Promise<void> {
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
  await Promise.all(
    contenders.map((contender, index) =>
      waitFor(
        () => exists(join(dir, `${index === 0 ? 'a' : 'b'}-ready.marker`)),
        `round ${round} contender ${index === 0 ? 'a' : 'b'} ready (stderr: ${contender.stderr()})`
      )
    )
  );
  await writeFile(goMarker, '', 'utf8');
  expect(await Promise.all(contenders.map(({ exited }) => exited))).toEqual([
    0, 0,
  ]);

  const names = await readdir(dir);
  const wins = names.filter((name) => name.endsWith('-win.marker'));
  const losses = names.filter((name) => name.endsWith('-lose.marker'));
  expect(wins, `round ${round} winners`).toHaveLength(1);
  expect(losses, `round ${round} losers`).toHaveLength(1);
  // No quarantine/reclaim residue, and the surviving lock belongs to the
  // sole winner rather than a contender whose lock was renamed away.
  expect(names.filter(isReclaimResidue), `round ${round} reclaim residue`).toEqual(
    []
  );
  const winnerToken = await readFile(join(dir, wins[0]), 'utf8');
  const surviving = JSON.parse(await readFile(lockPath, 'utf8'));
  expect(surviving).toMatchObject({
    schemaVersion: '1',
    kind: ADOPTION_SPOOL_ROTATION_LOCK_KIND,
    role: 'drain',
    token: winnerToken,
  });
}

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
    expect((await readdir(dir)).filter(isReclaimResidue)).toEqual([]);

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
    expect((await readdir(dir)).filter(isReclaimResidue)).toEqual([]);
  });

  it('cleans its generation claim when release payload validation throws', async () => {
    const dir = await makeDir();
    const spool = join(dir, 'adoption-spool.jsonl');
    const lockPath = adoptionSpoolRotationLockPath(spool);

    const lock = await acquireAdoptionSpoolRotationLock(spool, { role: 'drain' });
    expect(lock).not.toBeNull();
    // Preserve the acquired inode but make the release predicate throw while
    // parsing. Release must fail closed and still clean the claim it owns.
    await writeFile(lockPath, 'not-json\n', 'utf8');

    await expect(lock!.release()).resolves.toBeUndefined();
    expect(await readFile(lockPath, 'utf8')).toBe('not-json\n');
    expect((await readdir(dir)).filter(isReclaimResidue)).toEqual([]);
  });

  it('reclaims a stale lock within bounds and leaves no reclaim residue', async () => {
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
    expect((await readdir(dir)).filter(isReclaimResidue)).toEqual([]);
    await lock!.release();
  });

  // #3625: a stale lock whose content read fails with a NON-ENOENT error
  // (EACCES on a foreign-owned mode-0600 stale lock, a transient EIO) must be
  // classified fail-closed — NEVER reclaimed — and acquisition must DEGRADE to
  // unavailable (back off within budget, return null) rather than letting the
  // read error propagate out of acquire and abort wholesale on the first read.
  it('fails closed without reclaiming when a stale lock content read fails with a non-ENOENT error', async () => {
    const dir = await makeDir();
    const spool = join(dir, 'adoption-spool.jsonl');
    const lockPath = adoptionSpoolRotationLockPath(spool);
    const stalePayload = `${JSON.stringify({
      schemaVersion: '1',
      kind: ADOPTION_SPOOL_ROTATION_LOCK_KIND,
      role: 'producer',
      pid: 1,
      token: randomUUID(),
      createdAt: '2026-07-31T00:00:00.000Z',
    })}\n`;
    await writeFile(lockPath, stalePayload, 'utf8');
    const past = new Date(Date.now() - 60_000);
    await utimes(lockPath, past, past);

    let lockReads = 0;
    vi.resetModules();
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      return {
        ...actual,
        // Only the lock's CONTENT read fails; everything else is real. This is
        // the EACCES-on-a-foreign-owned-stale-lock / transient-EIO case that the
        // content-binding (#3615) added to inspectLockHolder.
        readFile: (async (
          p: Parameters<typeof actual.readFile>[0],
          opts?: Parameters<typeof actual.readFile>[1]
        ) => {
          if (String(p) === lockPath) {
            lockReads++;
            const error = new Error(
              'EACCES: permission denied'
            ) as NodeJS.ErrnoException;
            error.code = 'EACCES';
            throw error;
          }
          return actual.readFile(p, opts as never);
        }) as typeof actual.readFile,
      };
    });

    try {
      const { acquireAdoptionSpoolRotationLock: acquireWithUnreadableLock } =
        await import('./adoption-spool-lock');
      const started = Date.now();
      const lock = await acquireWithUnreadableLock(spool, {
        role: 'drain',
        budgetMs: 90,
        retryDelayMs: 15,
      });
      const elapsedMs = Date.now() - started;

      // Fail closed: acquisition is unavailable, the unreadable stale lock is
      // left INTACT (never reclaimed), and no reclaim/quarantine residue exists.
      expect(lock).toBeNull();
      expect(await readFile(lockPath, 'utf8')).toBe(stalePayload);
      expect((await readdir(dir)).filter(isReclaimResidue)).toEqual([]);
      // The read error was classified, not propagated: acquire backed off across
      // MULTIPLE attempts within budget. Pre-#3625 the throw exited acquire on
      // the FIRST read (a single lockRead, in ~0 ms).
      expect(lockReads).toBeGreaterThanOrEqual(2);
      expect(elapsedMs).toBeGreaterThanOrEqual(75);
      expect(elapsedMs).toBeLessThan(1000);
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  // #3625 companion: an ENOENT content read (the lock vanished between our lstat
  // and read) must still fail OPEN — treated as 'missing' so the next attempt
  // recreates the lock — NOT as the fail-closed 'unreadable' state.
  it('treats an ENOENT content-read (lock vanished mid-inspect) as missing and acquires', async () => {
    const dir = await makeDir();
    const spool = join(dir, 'adoption-spool.jsonl');
    const lockPath = adoptionSpoolRotationLockPath(spool);
    const stalePayload = `${JSON.stringify({
      schemaVersion: '1',
      kind: ADOPTION_SPOOL_ROTATION_LOCK_KIND,
      role: 'producer',
      pid: 1,
      token: randomUUID(),
      createdAt: '2026-07-31T00:00:00.000Z',
    })}\n`;
    await writeFile(lockPath, stalePayload, 'utf8');
    const past = new Date(Date.now() - 60_000);
    await utimes(lockPath, past, past);

    let vanished = false;
    vi.resetModules();
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      return {
        ...actual,
        readFile: (async (
          p: Parameters<typeof actual.readFile>[0],
          opts?: Parameters<typeof actual.readFile>[1]
        ) => {
          if (!vanished && String(p) === lockPath) {
            vanished = true;
            // Simulate the holder removing the lock between our lstat and read.
            await actual.rm(lockPath, { force: true });
            const error = new Error(
              'ENOENT: no such file or directory'
            ) as NodeJS.ErrnoException;
            error.code = 'ENOENT';
            throw error;
          }
          return actual.readFile(p, opts as never);
        }) as typeof actual.readFile,
      };
    });

    try {
      const { acquireAdoptionSpoolRotationLock: acquireAfterVanish } =
        await import('./adoption-spool-lock');
      const lock = await acquireAfterVanish(spool, {
        role: 'drain',
        budgetMs: 500,
      });
      // Fail OPEN: the vanished lock is treated as missing, so acquisition
      // succeeds by recreating the lock rather than fail-closing to null.
      expect(lock).not.toBeNull();
      expect(await readFile(lockPath, 'utf8')).toContain(lock!.token);
      expect((await readdir(dir)).filter(isReclaimResidue)).toEqual([]);
      await lock!.release();
      expect(await exists(lockPath)).toBe(false);
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
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
    expect((await readdir(dir)).filter(isReclaimResidue)).toEqual([]);
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
  // within bounds and EXACTLY ONE contender wins. Run >=48 rounds at
  // concurrency 12 (the #3615 acceptance bar) in BATCHES — each batch is 12
  // rounds x 2 children = 24 concurrent processes, awaited before the next — so
  // CI runners are never hit with all 96 processes at once.
  //
  // NOTE: this only exercises the inode-reuse vulnerable path on an
  // inode-recycling filesystem. os.tmpdir() is tmpfs here, whose inode numbers
  // are monotonic (never recycled), so tmpfs MASKS the race and this stays a
  // smoke test. The deterministic "refuses to remove a recycled-inode fresh
  // generation" test below is the correctness proof for #3615.
  it(
    'lets exactly one of two concurrent child contenders reclaim a stale lock across repeated parallel rounds',
    async () => {
      for (let batch = 0; batch < STALE_CONTENTION_BATCHES; batch++) {
        await Promise.all(
          Array.from({ length: STALE_CONTENTION_ROUNDS }, (_, i) =>
            assertSingleStaleReclaimWinner(batch * STALE_CONTENTION_ROUNDS + i)
          )
        );
      }
    },
    60_000
  );

  it('does not remove a fresh generation after a stale observer is delayed', async () => {
    const dir = await makeDir();
    const spool = join(dir, 'adoption-spool.jsonl');
    const lockPath = adoptionSpoolRotationLockPath(spool);
    const parkedStaleLock = join(dir, 'parked-stale-lock');
    const stalePayload = `${JSON.stringify({
      schemaVersion: '1',
      kind: ADOPTION_SPOOL_ROTATION_LOCK_KIND,
      role: 'drain',
      pid: 1,
      token: randomUUID(),
      createdAt: '2026-07-31T00:00:00.000Z',
    })}\n`;
    await writeFile(lockPath, stalePayload, 'utf8');
    const past = new Date(Date.now() - 60_000);
    await utimes(lockPath, past, past);

    let reportRemovalStarted!: () => void;
    const removalStarted = new Promise<void>((resolve) => {
      reportRemovalStarted = resolve;
    });
    let permitRemoval!: () => void;
    const removalPermitted = new Promise<void>((resolve) => {
      permitRemoval = resolve;
    });
    let paused = false;
    const pauseFirstRemoval = async () => {
      if (paused) return;
      paused = true;
      reportRemovalStarted();
      await removalPermitted;
    };

    vi.resetModules();
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      return {
        ...actual,
        // Pause both the fixed claim operation and the legacy path-only
        // rename. The same schedule therefore passes only when removal is
        // bound to the generation observed before this pause.
        link: async (...args: Parameters<typeof actual.link>) => {
          await pauseFirstRemoval();
          return actual.link(...args);
        },
        rename: async (...args: Parameters<typeof actual.rename>) => {
          await pauseFirstRemoval();
          return actual.rename(...args);
        },
      };
    });

    try {
      const { acquireAdoptionSpoolRotationLock: acquireWithPausedRemoval } =
        await import('./adoption-spool-lock');
      const delayedObserver = acquireWithPausedRemoval(spool, {
        role: 'drain',
        budgetMs: 80,
      });
      await removalStarted;

      // Another contender wins while this one is paused after stale
      // inspection. Keep the stale inode alive so the replacement is
      // guaranteed to have a distinct generation even on eager inode reuse.
      await rename(lockPath, parkedStaleLock);
      const freshToken = randomUUID();
      const freshPayload = `${JSON.stringify({
        schemaVersion: '1',
        kind: ADOPTION_SPOOL_ROTATION_LOCK_KIND,
        role: 'producer',
        pid: 2,
        token: freshToken,
        createdAt: new Date().toISOString(),
      })}\n`;
      await writeFile(lockPath, freshPayload, 'utf8');
      expect((await lstat(lockPath)).ino).not.toBe(
        (await lstat(parkedStaleLock)).ino
      );

      permitRemoval();
      expect(await delayedObserver).toBeNull();
      expect(await readFile(lockPath, 'utf8')).toBe(freshPayload);
      expect((await readdir(dir)).filter(isReclaimResidue)).toEqual([]);
    } finally {
      permitRemoval();
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  // Deterministic proof of the #3615 fix, filesystem-independent. It reproduces
  // "same (dev,ino), different bytes" — the inode-RECYCLING case the natural
  // reclaim path leaves open — by pausing the observer's claim link after it has
  // inspected the stale lock (capturing its generation + content), replacing the
  // file with a FRESH lock (new token, recent mtime, distinct real inode), and
  // then spoofing that fresh inode's lstat to report the ORIGINAL stale
  // (dev,ino). Pre-fix (shouldRemove === () => true) trusts (dev,ino) identity
  // alone and removes the impostor -> the observer double-wins; the content +
  // still-stale re-check must refuse it, so the observer acquires nothing.
  it('refuses to remove a recycled-inode fresh generation during stale reclaim', async () => {
    const dir = await makeDir();
    const spool = join(dir, 'adoption-spool.jsonl');
    const lockPath = adoptionSpoolRotationLockPath(spool);
    const stalePayload = `${JSON.stringify({
      schemaVersion: '1',
      kind: ADOPTION_SPOOL_ROTATION_LOCK_KIND,
      role: 'drain',
      pid: 1,
      token: randomUUID(),
      createdAt: '2026-07-31T00:00:00.000Z',
    })}\n`;
    await writeFile(lockPath, stalePayload, 'utf8');
    const past = new Date(Date.now() - 60_000);
    await utimes(lockPath, past, past);
    // The (dev,ino) the delayed observer will capture as its stale generation.
    const staleStat = await lstat(lockPath, { bigint: true });
    const spoofGen = { dev: staleStat.dev, ino: staleStat.ino };

    let reportRemovalStarted!: () => void;
    const removalStarted = new Promise<void>((resolve) => {
      reportRemovalStarted = resolve;
    });
    let permitRemoval!: () => void;
    const removalPermitted = new Promise<void>((resolve) => {
      permitRemoval = resolve;
    });
    let paused = false;
    const pauseFirstRemoval = async () => {
      if (paused) return;
      paused = true;
      reportRemovalStarted();
      await removalPermitted;
    };

    // After the swap, make the fresh replacement's real inode report the
    // original stale (dev,ino) — emulating inode-number recycling on ANY FS,
    // including tmpfs whose real inode numbers are monotonic.
    let replaced = false;
    let recycledIno: bigint | null = null;
    vi.resetModules();
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      return {
        ...actual,
        link: async (...args: Parameters<typeof actual.link>) => {
          await pauseFirstRemoval();
          return actual.link(...args);
        },
        lstat: (async (
          p: Parameters<typeof actual.lstat>[0],
          opts?: Parameters<typeof actual.lstat>[1]
        ) => {
          const real = await actual.lstat(p, opts as never);
          const realIno = (real as { ino: bigint }).ino;
          if (replaced && recycledIno !== null && realIno === recycledIno) {
            return {
              dev: spoofGen.dev,
              ino: spoofGen.ino,
              mtimeMs: (real as { mtimeMs: bigint }).mtimeMs,
              isSymbolicLink: () => real.isSymbolicLink(),
              isFile: () => real.isFile(),
            } as unknown as typeof real;
          }
          return real;
        }) as typeof actual.lstat,
      };
    });

    try {
      const { acquireAdoptionSpoolRotationLock: acquireWithRecycledInode } =
        await import('./adoption-spool-lock');
      const delayedObserver = acquireWithRecycledInode(spool, {
        role: 'drain',
        budgetMs: 500,
      });
      await removalStarted;

      // Replace the stale lock with a fresh one (distinct real inode), then arm
      // the spoof so its lstat reports the recycled (original) generation.
      await rm(lockPath, { force: true });
      const freshToken = randomUUID();
      const freshPayload = `${JSON.stringify({
        schemaVersion: '1',
        kind: ADOPTION_SPOOL_ROTATION_LOCK_KIND,
        role: 'producer',
        pid: 2,
        token: freshToken,
        createdAt: new Date().toISOString(),
      })}\n`;
      await writeFile(lockPath, freshPayload, 'utf8');
      recycledIno = (await lstat(lockPath, { bigint: true })).ino;
      replaced = true;

      permitRemoval();
      // The observer must NOT acquire: the pinned file is a fresh replacement
      // (different token, recent mtime), so the content + still-stale re-check
      // rejects removal even though the (dev,ino) generation matches.
      expect(await delayedObserver).toBeNull();
      expect(await readFile(lockPath, 'utf8')).toBe(freshPayload);
      expect((await readdir(dir)).filter(isReclaimResidue)).toEqual([]);
    } finally {
      permitRemoval();
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });

  it('backs off instead of spinning when a stale generation claim already exists', async () => {
    const dir = await makeDir();
    const spool = join(dir, 'adoption-spool.jsonl');
    const lockPath = adoptionSpoolRotationLockPath(spool);
    await writeFile(lockPath, 'stale-lock\n', 'utf8');
    const past = new Date(Date.now() - 60_000);
    await utimes(lockPath, past, past);
    const generation = await lstat(lockPath, { bigint: true });
    const claimPath = `${lockPath}${ADOPTION_SPOOL_ROTATION_LOCK_RECLAIM_INFIX}${generation.dev}-${generation.ino}`;
    await link(lockPath, claimPath);

    let linkAttempts = 0;
    vi.resetModules();
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      return {
        ...actual,
        link: async (...args: Parameters<typeof actual.link>) => {
          linkAttempts++;
          return actual.link(...args);
        },
      };
    });

    try {
      const { acquireAdoptionSpoolRotationLock: acquireCountingClaims } =
        await import('./adoption-spool-lock');
      const started = Date.now();
      const lock = await acquireCountingClaims(spool, {
        role: 'drain',
        budgetMs: 90,
        retryDelayMs: 15,
      });
      const elapsedMs = Date.now() - started;

      expect(lock).toBeNull();
      expect(elapsedMs).toBeGreaterThanOrEqual(75);
      expect(elapsedMs).toBeLessThan(1000);
      expect(linkAttempts).toBeGreaterThanOrEqual(2);
      expect(linkAttempts).toBeLessThanOrEqual(8);
      expect(await readFile(lockPath, 'utf8')).toBe('stale-lock\n');
      expect(await exists(claimPath)).toBe(true);
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });
});
