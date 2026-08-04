import { link, lstat, open, readFile, unlink } from 'node:fs/promises';
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
/** Same-generation hard-link claim used to serialize removal of a lock. */
export const ADOPTION_SPOOL_ROTATION_LOCK_RECLAIM_INFIX = '.reclaim-';
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

interface LockGeneration {
  dev: bigint;
  ino: bigint;
}

type LockHolderInspection =
  | { state: 'missing' | 'hostile' }
  | { state: 'fresh'; generation: LockGeneration }
  | { state: 'stale'; generation: LockGeneration; content: string };

function sameLockGeneration(
  left: LockGeneration,
  right: LockGeneration
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function reclaimClaimPath(
  lockPath: string,
  generation: LockGeneration
): string {
  return `${lockPath}${ADOPTION_SPOOL_ROTATION_LOCK_RECLAIM_INFIX}${generation.dev}-${generation.ino}`;
}

async function inspectLockHolder(
  lockPath: string,
  staleMs: number
): Promise<LockHolderInspection> {
  let stats;
  try {
    stats = await lstat(lockPath, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: 'missing' };
    }
    throw error;
  }
  // A symlink (or anything that is not a regular file) at the lock path is
  // hostile squatting: never follow it, never unlink it, never wait it out.
  if (stats.isSymbolicLink() || !stats.isFile()) {
    return { state: 'hostile' };
  }
  const generation = { dev: stats.dev, ino: stats.ino };
  if (BigInt(Date.now()) - stats.mtimeMs <= BigInt(staleMs)) {
    return { state: 'fresh', generation };
  }
  // Stale: capture the observed bytes so the reclaim can bind removal to this
  // exact lock instance. On an inode-recycling filesystem a rival's fresh
  // replacement can reuse this generation's inode; the observed content plus a
  // staleness re-check at removal time reject that impostor even though the
  // (dev,ino) generation still matches (#3615).
  let content: string;
  try {
    content = await readFile(lockPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { state: 'missing' };
    }
    throw error;
  }
  return { state: 'stale', generation, content };
}

/**
 * Claim one observed lock generation with an O_EXCL hard link, revalidate that
 * both paths still name that exact inode, then remove only that generation.
 * Every protocol remover (stale reclaim and holder release) uses this seam, so
 * a delayed stale observer cannot remove a rival's fresh replacement (#3550).
 *
 * The claim is generation-keyed: once the old pathname is gone, a fresh lock
 * can be created safely while this function cleans the old hard link. A crash
 * can leave the claim behind; acquisition then fails closed rather than
 * guessing that it is safe to remove (tracked by #3557).
 */
async function removeClaimedLockGeneration(
  lockPath: string,
  generation: LockGeneration,
  shouldRemove: () => Promise<boolean>
): Promise<boolean> {
  const claimPath = reclaimClaimPath(lockPath, generation);
  let ownedClaimGeneration: LockGeneration | undefined;
  try {
    await link(lockPath, claimPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'ENOENT') return false;
    throw error;
  }

  try {
    const claimed = await lstat(claimPath, { bigint: true });
    if (claimed.isSymbolicLink() || !claimed.isFile()) return false;
    // The path may have changed between the stale observation and link().
    // Remember what this successful claim actually linked so finally cleans
    // that generation without touching an externally replaced claim path.
    ownedClaimGeneration = { dev: claimed.dev, ino: claimed.ino };
    const current = await lstat(lockPath, { bigint: true });
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      !sameLockGeneration(current, generation) ||
      !sameLockGeneration(claimed, generation) ||
      !(await shouldRemove())
    ) {
      return false;
    }

    // Revalidate after the async predicate. Protocol-abiding removers cannot
    // replace this generation while the hard-link claim exists.
    const confirmed = await lstat(lockPath, { bigint: true });
    if (
      confirmed.isSymbolicLink() ||
      !confirmed.isFile() ||
      !sameLockGeneration(confirmed, generation)
    ) {
      return false;
    }
    await unlink(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  } finally {
    try {
      const claimed = await lstat(claimPath, { bigint: true });
      if (
        ownedClaimGeneration !== undefined &&
        !claimed.isSymbolicLink() &&
        claimed.isFile() &&
        sameLockGeneration(claimed, ownedClaimGeneration)
      ) {
        await unlink(claimPath);
      }
    } catch {
      // Best-effort cleanup. A missing claim is already clean; an unreadable
      // or externally replaced claim fails closed on this generation.
    }
  }
}

async function reclaimStaleLock(
  lockPath: string,
  generation: LockGeneration,
  observedContent: string,
  staleMs: number
): Promise<boolean> {
  // Remove the stale lock ONLY if, after the hard-link claim has pinned the
  // inode, the pinned file is STILL the exact lock we observed: same generation,
  // same bytes, AND still stale. On an inode-recycling filesystem a rival's
  // fresh replacement can reuse this generation's inode (so the (dev,ino) check
  // in removeClaimedLockGeneration passes), but it carries a different token and
  // a recent mtime — either signal rejects it, closing the double-reclaim
  // window (#3615). The mtime re-check also covers the epsilon between inspect's
  // lstat and its readFile, where a recycled replacement could have been
  // captured as the "observed content".
  return removeClaimedLockGeneration(lockPath, generation, async () => {
    let stats;
    try {
      stats = await lstat(lockPath, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isFile()) return false;
    if (!sameLockGeneration({ dev: stats.dev, ino: stats.ino }, generation)) {
      return false;
    }
    if (BigInt(Date.now()) - stats.mtimeMs <= BigInt(staleMs)) return false;
    let current: string;
    try {
      current = await readFile(lockPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    return current === observedContent;
  });
}

async function releaseRotationLock(
  lockPath: string,
  token: string
): Promise<void> {
  try {
    const stats = await lstat(lockPath, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isFile()) return;
    const generation = { dev: stats.dev, ino: stats.ino };
    await removeClaimedLockGeneration(lockPath, generation, async () => {
      const parsed: unknown = JSON.parse(await readFile(lockPath, 'utf8'));
      if (typeof parsed !== 'object' || parsed === null) return false;
      // Remove ONLY our own lock: a stale reclaim may have replaced it with a
      // rival holder's file, and deleting that would unlock the rival's window.
      return (parsed as { token?: unknown }).token === token;
    });
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
      if (holder.state === 'hostile') return null;
      if (holder.state === 'stale') {
        const reclaimed = await reclaimStaleLock(
          lockPath,
          holder.generation,
          holder.content,
          staleMs
        );
        // Retry immediately only when this contender actually removed the old
        // generation. A contended/orphan claim must yield between attempts so
        // fail-closed acquisition cannot become a CPU spin (#3557).
        if (!reclaimed) await sleep(retryDelayMs);
        continue;
      }
      // 'missing' (holder released between our open and lstat) retries
      // immediately; 'fresh' backs off first.
      if (holder.state === 'fresh') await sleep(retryDelayMs);
    }
  } catch {
    return null;
  }
}
