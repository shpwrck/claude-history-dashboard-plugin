import { lstat, open, readFile, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

// Cross-process rotation lock for the recs adoption-receipt spool — PROTOCOL v1
// (#3402 drain half; #3369 / shpwrck/agent-skills#22 producer half).
//
// The producer (the recs SessionStart hook, a separate process in the
// shpwrck/agent-skills repo) and the drain (`src/lib/adoption-spool.ts`) share
// one live spool file. Rotation renames that file out from under any producer
// that has opened it but not yet written, so the producer's append can land in a
// retired snapshot after its EOF scan and be deleted. This module is the shared
// mutual-exclusion primitive that closes that window for protocol-abiding
// processes: the drain holds the lock across rotation (rename + recreate ONLY),
// a producer holds it across its open+append, so an append can only ever reach
// the CURRENT live spool.
//
// The constants and byte-level behavior below are a CROSS-REPO CONTRACT — the
// producer implementation copies them exactly. The prose form of the contract
// lives in docs/recs-adoption-receipts.md; change neither in isolation.
//
// Dependency-free on purpose (node:fs / node:crypto only) so the module is
// importable by tests spawned as bare child processes and portable to the
// producer side.

/** The lock is a SIBLING file: `<resolved spool path> + suffix`. */
export const ADOPTION_SPOOL_ROTATION_LOCK_SUFFIX = '.rotation-lock';
export const ADOPTION_SPOOL_ROTATION_LOCK_KIND = 'ChdAdoptionSpoolRotationLock';
/** A lock whose mtime is older than this is presumed abandoned and reclaimed. */
export const ADOPTION_SPOOL_ROTATION_LOCK_STALE_MS = 10_000;
/** Backoff between acquisition attempts while another process holds the lock. */
export const ADOPTION_SPOOL_ROTATION_LOCK_RETRY_DELAY_MS = 5;
/** Drain-side total acquisition budget; on expiry the drain SKIPS rotation. */
export const ADOPTION_SPOOL_ROTATION_LOCK_DRAIN_BUDGET_MS = 2_000;
/**
 * Producer-side total acquisition budget; on expiry the producer MAY fall back
 * to a bare append (degraded mode — same exposure as a pre-protocol producer).
 */
export const ADOPTION_SPOOL_ROTATION_LOCK_PRODUCER_BUDGET_MS = 250;

export type AdoptionSpoolRotationLockRole = 'drain' | 'producer';

/** The single-line JSON body written into the lock file. */
export interface AdoptionSpoolRotationLockPayload {
  schemaVersion: '1';
  kind: typeof ADOPTION_SPOOL_ROTATION_LOCK_KIND;
  role: AdoptionSpoolRotationLockRole;
  pid: number;
  token: string;
  createdAt: string;
}

export interface AdoptionSpoolRotationLock {
  lockPath: string;
  /** The `randomUUID` this holder wrote; release unlinks only on a match. */
  token: string;
  /** Idempotent; tolerates the lock already being gone. Never throws. */
  release: () => Promise<void>;
}

export interface AcquireAdoptionSpoolRotationLockOptions {
  role: AdoptionSpoolRotationLockRole;
  /** Total acquisition budget; defaults to the role's contract budget. */
  budgetMs?: number;
  staleMs?: number;
  retryDelayMs?: number;
}

export function adoptionSpoolRotationLockPath(spoolFile: string): string {
  return `${spoolFile}${ADOPTION_SPOOL_ROTATION_LOCK_SUFFIX}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * `true` when this attempt created the lock, `false` on EEXIST (someone else
 * holds it — or something else squats on the path; the caller inspects which).
 * Any other failure propagates; a lock file this attempt created but could not
 * fill with its payload is best-effort removed so it cannot squat as a 10 s
 * stale blocker.
 */
async function tryCreateLock(lockPath: string, line: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    await handle.writeFile(line, 'utf8');
    return true;
  } catch (error) {
    try {
      await unlink(lockPath);
    } catch {
      // Best-effort only; the stale reclaim is the backstop.
    }
    throw error;
  } finally {
    await handle.close();
  }
}

type LockHolderState = 'missing' | 'hostile' | 'fresh' | 'stale';

async function inspectLockHolder(
  lockPath: string,
  staleMs: number
): Promise<LockHolderState> {
  let stats;
  try {
    stats = await lstat(lockPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
  // A symlink (or anything that is not a regular file) at the lock path is
  // hostile squatting: never follow it, never unlink it, never wait it out.
  if (stats.isSymbolicLink() || !stats.isFile()) return 'hostile';
  return Date.now() - stats.mtimeMs > staleMs ? 'stale' : 'fresh';
}

/**
 * Rename-FIRST reclaim: exactly one of two concurrent reclaimers wins the
 * atomic rename of a given stale lock, so its holder identity cannot be
 * unlinked twice and a reclaimer can never delete a lock a rival reclaimer
 * already replaced. ENOENT at either step just means the rival won that step.
 */
async function reclaimStaleLock(lockPath: string): Promise<void> {
  const retired = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(lockPath, retired);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  try {
    await unlink(retired);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function releaseRotationLock(
  lockPath: string,
  token: string
): Promise<void> {
  try {
    const stats = await lstat(lockPath);
    if (stats.isSymbolicLink() || !stats.isFile()) return;
    const parsed: unknown = JSON.parse(await readFile(lockPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return;
    // Unlink ONLY our own lock: a stale reclaim may have replaced it with a
    // rival holder's file, and deleting that would unlock the rival's window.
    if ((parsed as { token?: unknown }).token !== token) return;
    await unlink(lockPath);
  } catch {
    // ENOENT, unreadable, or unparsable: the lock is gone or is not provably
    // ours — either way there is nothing safe to remove. Never throw.
  }
}

/**
 * Acquire the spool rotation lock, or `null` when it cannot be had: budget
 * exhausted, hostile squatter at the lock path (permanent failure — returns
 * immediately), or any filesystem error. Never throws: for the drain a missed
 * lock means "skip rotation this cycle", never a failed drain.
 */
export async function acquireAdoptionSpoolRotationLock(
  spoolFile: string,
  opts: AcquireAdoptionSpoolRotationLockOptions
): Promise<AdoptionSpoolRotationLock | null> {
  const lockPath = adoptionSpoolRotationLockPath(spoolFile);
  const staleMs = opts.staleMs ?? ADOPTION_SPOOL_ROTATION_LOCK_STALE_MS;
  const retryDelayMs =
    opts.retryDelayMs ?? ADOPTION_SPOOL_ROTATION_LOCK_RETRY_DELAY_MS;
  const budgetMs =
    opts.budgetMs ??
    (opts.role === 'producer'
      ? ADOPTION_SPOOL_ROTATION_LOCK_PRODUCER_BUDGET_MS
      : ADOPTION_SPOOL_ROTATION_LOCK_DRAIN_BUDGET_MS);

  const token = randomUUID();
  const payload: AdoptionSpoolRotationLockPayload = {
    schemaVersion: '1',
    kind: ADOPTION_SPOOL_ROTATION_LOCK_KIND,
    role: opts.role,
    pid: process.pid,
    token,
    createdAt: new Date().toISOString(),
  };
  const line = `${JSON.stringify(payload)}\n`;
  const deadline = Date.now() + budgetMs;
  let firstAttempt = true;

  try {
    for (;;) {
      if (!firstAttempt && Date.now() > deadline) return null;
      firstAttempt = false;

      if (await tryCreateLock(lockPath, line)) {
        let released = false;
        return {
          lockPath,
          token,
          release: async () => {
            if (released) return;
            released = true;
            await releaseRotationLock(lockPath, token);
          },
        };
      }

      const holder = await inspectLockHolder(lockPath, staleMs);
      if (holder === 'hostile') return null;
      if (holder === 'stale') {
        await reclaimStaleLock(lockPath);
        continue; // Retry the create immediately; the path should now be free.
      }
      // 'missing' (holder released between our open and lstat) retries
      // immediately; 'fresh' backs off first.
      if (holder === 'fresh') await sleep(retryDelayMs);
    }
  } catch {
    return null;
  }
}
