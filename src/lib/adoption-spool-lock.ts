import {
  link,
  lstat,
  open,
  readFile,
  readdir,
  readlink,
  rename,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
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
// Dependency-free on purpose (node:fs / node:path / node:crypto only) so the
// module is importable by tests spawned as bare child processes and portable to
// the producer side.
//
// ---------------------------------------------------------------------------
// PROTOCOL v2 — the crash-recoverable generation-claim LEASE (#3557)
// ---------------------------------------------------------------------------
// v1 serialized every remover of a lock generation behind ONE O_EXCL hard link,
// the "generation claim" (`<lock>.reclaim-<dev>-<ino>`). That is sound while the
// claimant lives, but a claimant killed before its `finally` leaves the claim on
// disk forever: no later remover can ever take that claim again, so the stale
// lock can never be reclaimed and rotation stays unavailable until a human
// deletes the file.
//
// The round-24 analysis on #3557 proved no FORMAT-PRESERVING recovery is safe:
//
//   (r24-a) The orphan claim is a hard link to the stale lock's inode. A
//           recoverer's own `link(lockPath, claimPath)` would produce ANOTHER
//           link to the SAME inode carrying the SAME mtime, so neither inode
//           identity nor mtime can tell an orphan from a live claim — only
//           ctime differs, and ctime is not a liveness signal.
//   (r24-b) There is no atomic "unlink-if-ctime-old" primitive, so any
//           ctime-based recovery degrades to check-then-unlink. A recoverer
//           preempted between the two syscalls can delete a LIVE claim, which
//           reopens exactly the confirmed-lstat -> unlink gap #3550 closed and
//           permits DUAL OWNERSHIP.
//   (r24-c) The provably single-winner alternative (steal by rename) needs a
//           new on-disk artifact, which v1's contract forbade.
//
// v2 is (r24-c) with the maintainer's explicit approval to change the on-disk
// format, and it answers (r24-a) and (r24-b) head-on:
//
//   * ANSWER TO (r24-a) — stop inferring liveness from the claim's metadata.
//     A claimant that has TAKEN the claim records a LEASE, `<claim>.lease-
//     <ownerId>`, whose NAME carries the owner's identity: pid, pid NAMESPACE
//     id, kernel boot id, the process start token (`/proc/<pid>/stat` field 22),
//     and a per-attempt nonce. Liveness is then PROVEN, not guessed: in this pid
//     namespace, a lease from an earlier boot is definitively dead, and a pid
//     that is ESRCH — or alive under a DIFFERENT start token, i.e. recycled — is
//     definitively dead. Identity lives in the NAME, not the body, because a
//     name is created atomically while a body write is not, so a crash can never
//     produce a lease we cannot classify.
//
//   * ANSWER TO (r24-b) — never unlink on a check-then-act. A recoverer takes
//     the right to remove the orphan by RENAMING the dead owner's lease to a
//     private name, `<lease>.stolen-<recovererId>`. Both names are unique per
//     attempt (nonce), so the rename can neither collide with, nor be raced by,
//     a fresh claimant: a fresh claimant always creates a NEW unique lease name
//     and never touches this one. Concurrent recoverers therefore contend on a
//     single rename of a single source path, which the kernel resolves with
//     exactly one winner; every loser sees ENOENT and stands down.
//
// THE FIVE INVARIANTS (each is load-bearing; a test pins each one):
//
//   L1  CLAIM BEFORE LEASE, LEASE BEFORE CLAIM. A lease is created ONLY after
//       this process's claim `link` has succeeded, and is removed BEFORE the
//       claim is released. Hence a lease is never created by a process that
//       does not hold the claim, and a lease never OUTLIVES its claim.
//   L2  A LEASE IS POSITIVE PROOF OF WHO OWNS THE CLAIM. By L1, a lease on disk
//       means its owner held the claim when it wrote it and has not released the
//       claim since (release removes the lease first). So "this lease's owner is
//       provably dead" is exactly "this claim is orphaned" — recovery no longer
//       infers orphanhood from the mere ABSENCE of a live lease, which was the
//       #3651 hole: a live LEASE-LESS claim (a v1 peer's) standing beside any
//       stranded dead lease read as orphaned, and a live claim was removed.
//       L1 is what makes a stranded lease impossible: a contender that loses the
//       `link` race never creates one, and a released claim never leaves one.
//   L3  ONLY A LEASE BOUND TO THIS CLAIM COUNTS, AND ONLY IF IT IS THE ONLY ONE.
//       The lease is a hard link to the CLAIM, so a candidate whose (dev,ino) is
//       not this generation is ignored, and exactly one lease may exist (one
//       holder at a time, and by L1 none can be left behind), so a count other
//       than one is an anomaly and stands down. This also disposes of readdir
//       atomicity: a torn scan can only UNDER-report, which fails closed, never
//       over-attribute.
//       BE CLEAR ABOUT WHAT THIS DOES NOT DO. The bind check excludes only
//       NON-links — a hard link to this generation planted by hand passes it,
//       because r24-a is exactly the statement that no on-disk check can tell
//       two links to one inode apart. L3 is defence in depth against a stray
//       regular file; the guarantee that a stranded lease never EXISTS is L1's
//       ordering alone. Do not relax L1 on the belief that L3 covers it.
//   L4  A CLAIM IS REMOVED ONLY BY ITS OWNER OR BY THE UNIQUE LEASE-STEALER.
//       The owner removes it after its lease; a recoverer removes it only after
//       winning the single rename of that one lease. Two recoverers therefore
//       contend on one source path and the kernel picks one; the loser sees
//       ENOENT and stands down. No live claim is ever removed.
//   L5  A STEAL RECORD IS NOT OWNERSHIP EVIDENCE. It is a renamed lease that may
//       outlive its claim (its recoverer can die between removing the claim and
//       dropping the record), so treating it as a lease would reopen the #3651
//       hole. While its recoverer may still act, others stand down; once that
//       recoverer is provably dead the record is garbage-collected. Recovery
//       NEVER touches the lock — the caller re-contends through the ordinary v1
//       path, whose content-bound still-stale predicate (#3615) is unchanged.
//
// WHAT v2 DOES NOT CHANGE — and why an un-upgraded peer stays safe. The lock
// file's bytes and the generation-claim NAME are byte-identical to v1, so a v1
// peer still mutually excludes correctly against a v2 peer on the same O_EXCL
// claim name. The lease is purely ADDITIVE, and by L2 a v1 peer's lease-less
// claim can never be attributed to a dead owner, so it is never recovered —
// exactly today's fail-closed behavior, no regression.
//
// WHAT IS DELIBERATELY NOT RECOVERED (fail-closed, and why that is the right
// trade). A claim is recoverable only while its lease is on disk, so two
// single-syscall windows stay unrecoverable: a kill between `link`ing the claim
// and creating the lease, and one between removing the lease and removing the
// claim. Both leave a lease-less claim — indistinguishable from a v1 peer's, so
// never guessed at. That is strictly better than v1 (where the ENTIRE hold was
// unrecoverable) and it is the price of L2: attributing an owner we cannot see
// is what removed live claims.
//
// A THIRD, WIDER WINDOW WEDGES ITS GENERATION (tracked by #3659). A recoverer
// killed after winning the steal rename but before unlinking the claim leaves
// the claim, no lease (it was renamed away), and a steal record naming a dead
// recoverer. The next pass garbage-collects that record — it must, or L5 and
// with it finding 1 reopen — and every later pass then sees a lease-less claim
// and stands down PERMANENTLY. This is the original #3557 symptom in a much
// narrower window: a kill inside a recovery, which is itself the rare path.
// Completing the dead recoverer's job instead of collecting is NOT a safe
// substitute, because a steal record can equally outlive a claim its recoverer
// already removed, and the two cases are indistinguishable from the record; see
// #3659.
//
// Every one of these degrades AVAILABILITY only; none can produce dual
// ownership. Note the benign case that is NOT on this list: a recoverer killed
// AFTER unlinking the claim leaves only a stale steal record. A fresh claimant
// takes the free claim path normally, and the record is collected by the first
// later pass that contends, costing one wasted recovery attempt.
//
// KNOWN LIMIT (deliberate, fail-closed). Liveness is provable only within one
// pid namespace AND one kernel boot: pids are not comparable across namespaces,
// so a containerized drain cannot classify a host-side producer's lease, and it
// stands down (`unknown`) rather than guess. That applies to STEAL RECORDS too,
// and there it is stickier: an unclassifiable record blocks all recovery of its
// generation until a process in the RECOVERER's own namespace runs and collects
// it. In the container-drain / host-producer topology that can leave the drain
// blocked until the next host-side SessionStart. The namespace check runs FIRST,
// because a runtime that virtualizes boot_id per container (lxcfs, nspawn) would
// otherwise turn "different boot id" into a false proof of death (#3651). Such a
// claim is recovered by the next process in the OWNER's own namespace, or after
// the next reboot. Recovery also assumes the spool directory lives on ONE
// machine's local POSIX filesystem — the same assumption v1's hard-link O_EXCL
// and (dev,ino) generation identity already require.

/** The lock is a SIBLING file: `<resolved spool path> + suffix`. */
export const ADOPTION_SPOOL_ROTATION_LOCK_SUFFIX = '.rotation-lock';
/** Same-generation hard-link claim used to serialize removal of a lock. */
export const ADOPTION_SPOOL_ROTATION_LOCK_RECLAIM_INFIX = '.reclaim-';
/**
 * Per-owner claim lease (protocol v2, #3557): `<claim path> + infix + ownerId`.
 * A hard link to the claim, created only AFTER that claim link succeeds and
 * removed BEFORE the claim is released (L1) — which is what makes a lease proof
 * of who holds the claim rather than merely a hint that someone did.
 */
export const ADOPTION_SPOOL_ROTATION_LOCK_LEASE_INFIX = '.lease-';
/**
 * Private steal target a recoverer renames an orphaned lease to (protocol v2):
 * `<lease path> + infix + recovererId`. Unique per (victim, recoverer).
 */
export const ADOPTION_SPOOL_ROTATION_LOCK_STEAL_INFIX = '.stolen-';
export const ADOPTION_SPOOL_ROTATION_LOCK_KIND = 'ChdAdoptionSpoolRotationLock';
/** Tag written when a component of the owner identity cannot be established. */
export const ADOPTION_SPOOL_ROTATION_LOCK_OWNER_UNKNOWN_TAG = 'x';
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
  | { state: 'stale'; generation: LockGeneration; content: string }
  // A stale lock whose bytes could NOT be read for a reason other than ENOENT
  // (EACCES on a foreign-owned mode-0600 lock, a transient EIO, ...). Reclaim is
  // content-bound (#3615), so a lock we cannot read cannot be reclaimed: this is
  // an intended fail-closed state the acquirer treats as NON-reclaimable (#3625).
  | { state: 'unreadable'; generation: LockGeneration };

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

// --- Claim-owner identity and liveness (protocol v2, #3557) -----------------
//
// An owner id is `<pid>_<bootTag>_<nsTag>_<startTag>_<nonce>`. Every component
// is digits, lowercase hex, or the unknown tag, so an id never contains `_`'s
// separator ambiguity nor the `.` that delimits the lease and steal infixes —
// the artifact names stay parseable by splitting on those infixes alone.

const UNKNOWN_TAG = ADOPTION_SPOOL_ROTATION_LOCK_OWNER_UNKNOWN_TAG;

interface ClaimOwnerIdentity {
  pid: number;
  /** Kernel boot id: shared by every process of one boot, containers included. */
  bootTag: string;
  /** `/proc/self/ns/pid` inode — the scope in which a pid is comparable. */
  nsTag: string;
  /** `/proc/<pid>/stat` field 22 (starttime): distinguishes a recycled pid. */
  startTag: string;
}

type ClaimOwnerLiveness = 'alive' | 'dead' | 'unknown';

function boundedTag(raw: string, pattern: RegExp, maxLength: number): string {
  const cleaned = raw.replace(pattern, '').toLowerCase().slice(0, maxLength);
  return cleaned.length > 0 ? cleaned : UNKNOWN_TAG;
}

/**
 * `/proc/<pid>/stat` field 22. Fields 1-2 (pid and the parenthesized comm,
 * which may itself contain spaces and parens) are dropped by slicing past the
 * LAST `)` — every later field is numeric, so that paren is the comm's closer.
 * Field 3 is then index 0, putting starttime at index 19.
 */
function parseProcessStartTag(stat: string): string {
  const fields = stat
    .slice(stat.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/);
  return boundedTag(fields[19] ?? '', /[^0-9]/g, 20);
}

/**
 * The start token of a running pid. `'gone'` when `/proc/<pid>/stat` is ENOENT,
 * `undefined` on any other read failure. ENOENT means "gone" ONLY for a pid we
 * have not already proven to exist: a hardened `/proc` (`hidepid=2`,
 * `ProtectProc=invisible`) hides another user's LIVE process behind the very
 * same ENOENT, so the caller must weigh this against `process.kill(pid, 0)`
 * rather than read it as proof of death (#3651).
 */
async function readProcessStartTag(
  pid: number | 'self'
): Promise<string | 'gone' | undefined> {
  try {
    return parseProcessStartTag(await readFile(`/proc/${pid}/stat`, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone';
    return undefined;
  }
}

let selfIdentityPromise: Promise<ClaimOwnerIdentity> | undefined;

/** Memoized: every component is fixed for the life of the process. */
function selfClaimOwnerIdentity(): Promise<ClaimOwnerIdentity> {
  selfIdentityPromise ??= (async () => {
    const [bootTag, nsTag, startTag] = await Promise.all([
      readFile('/proc/sys/kernel/random/boot_id', 'utf8')
        .then((raw) => boundedTag(raw, /[^0-9a-fA-F]/g, 16))
        .catch(() => UNKNOWN_TAG),
      readlink('/proc/self/ns/pid')
        .then((target) => boundedTag(target, /[^0-9]/g, 12))
        .catch(() => UNKNOWN_TAG),
      readProcessStartTag('self').then((tag) =>
        tag === undefined || tag === 'gone' ? UNKNOWN_TAG : tag
      ),
    ]);
    return { pid: process.pid, bootTag, nsTag, startTag };
  })();
  return selfIdentityPromise;
}

function parseClaimOwnerId(ownerId: string): ClaimOwnerIdentity | null {
  const parts = ownerId.split('_');
  if (parts.length !== 5) return null;
  const [rawPid, bootTag, nsTag, startTag, nonce] = parts;
  if (!/^[0-9]{1,12}$/.test(rawPid) || nonce.length === 0) return null;
  const pid = Number(rawPid);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return { pid, bootTag, nsTag, startTag };
}

/**
 * The owner id this process writes into a claim lease. Exported because the id
 * format is part of the cross-repo on-disk contract (the producer mirrors it)
 * and because tests synthesize dead-owner leases from it; production callers do
 * not need it. `pid` may be overridden to describe a DIFFERENT process.
 */
export async function adoptionSpoolRotationLockOwnerId(
  pid?: number
): Promise<string> {
  const self = await selfClaimOwnerIdentity();
  const nonce = randomUUID().replace(/-/g, '').slice(0, 12);
  return `${pid ?? self.pid}_${self.bootTag}_${self.nsTag}_${self.startTag}_${nonce}`;
}

/**
 * PROVE — never guess — whether a lease's owner can still act. Every uncertain
 * path returns `'unknown'`, which the recoverer treats exactly like `'alive'`,
 * so an unprovable owner keeps its claim (fail-closed, answering r24-a).
 */
async function classifyClaimOwner(ownerId: string): Promise<ClaimOwnerLiveness> {
  const owner = parseClaimOwnerId(ownerId);
  if (owner === null) return 'unknown';
  const self = await selfClaimOwnerIdentity();
  // NAMESPACE FIRST (#3651). A pid means nothing outside its own pid namespace,
  // and neither does a boot id: a runtime that virtualizes `boot_id` per
  // container (lxcfs, nspawn) while sharing this spool directory would make a
  // LIVE peer's lease look like an earlier boot's. Establishing that we share a
  // pid namespace is what makes every later comparison meaningful.
  if (owner.nsTag === UNKNOWN_TAG || self.nsTag === UNKNOWN_TAG) return 'unknown';
  if (owner.nsTag !== self.nsTag) return 'unknown';
  if (owner.bootTag === UNKNOWN_TAG || self.bootTag === UNKNOWN_TAG) {
    return 'unknown';
  }
  // Same pid namespace, different boot: every process of that boot is gone.
  // (Cross-MACHINE reuse of one spool directory is already outside the
  // protocol: v1's hard-link O_EXCL and (dev,ino) generation identity are not
  // dependable across hosts.)
  if (owner.bootTag !== self.bootTag) return 'dead';
  if (owner.pid === self.pid) {
    // Our own pid, possibly recycled from an earlier process of this boot.
    if (self.startTag === UNKNOWN_TAG) return 'unknown';
    return owner.startTag === self.startTag ? 'alive' : 'dead';
  }
  // `exists` records what the signal probe PROVED. Without it, a hardened
  // /proc's ENOENT would be read as death for a pid we just proved alive.
  let exists = true;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ESRCH is definitive: no process holds that pid.
    if (code === 'ESRCH') return 'dead';
    // EPERM proves the pid EXISTS (it is another user's). Anything else tells
    // us nothing either way.
    if (code !== 'EPERM') exists = false;
  }
  const observed = await readProcessStartTag(owner.pid);
  // ENOENT is proof of death only when the probe above did not already prove
  // the opposite; under `hidepid=2` a live foreign process reads exactly so.
  if (observed === 'gone') return exists ? 'unknown' : 'dead';
  if (observed === undefined || observed === UNKNOWN_TAG) return 'unknown';
  if (owner.startTag === UNKNOWN_TAG) return 'unknown';
  // The pid exists but under a different start token: it was recycled, and the
  // lease's owner is gone.
  return observed === owner.startTag ? 'alive' : 'dead';
}

function claimLeasePath(claimPath: string, ownerId: string): string {
  return `${claimPath}${ADOPTION_SPOOL_ROTATION_LOCK_LEASE_INFIX}${ownerId}`;
}

function claimStealPath(leasePath: string, recovererId: string): string {
  return `${leasePath}${ADOPTION_SPOOL_ROTATION_LOCK_STEAL_INFIX}${recovererId}`;
}

async function bestEffortUnlink(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // Missing or unremovable: nothing further this attempt can do.
  }
}

/**
 * Record this process's ownership of a claim it ALREADY holds (L1). The lease
 * is a hard link to the claim, so it carries that generation's (dev,ino) and a
 * recoverer can verify it is bound to this exact claim rather than trusting a
 * name (L3) — a planted regular file cannot impersonate one.
 *
 * Returns whether the lease exists. `false` is safe, not fatal: the claim is
 * then merely unrecoverable if this process dies holding it, exactly like a v1
 * peer's claim, and by L2 nothing will ever attribute it to someone else.
 */
async function createClaimLease(
  claimPath: string,
  leasePath: string
): Promise<boolean> {
  try {
    await link(claimPath, leasePath);
    return true;
  } catch {
    return false;
  }
}

/** `true` when this candidate is a hard link to the claimed generation (L3). */
async function leaseBindsToGeneration(
  leasePath: string,
  generation: LockGeneration
): Promise<boolean> {
  try {
    const stats = await lstat(leasePath, { bigint: true });
    return (
      !stats.isSymbolicLink() &&
      stats.isFile() &&
      sameLockGeneration({ dev: stats.dev, ino: stats.ino }, generation)
    );
  } catch {
    return false;
  }
}

/**
 * Recover a generation claim whose owner is provably dead, and return whether
 * this call removed it. Runs when our own claim `link` hit EEXIST, so the claim
 * existed at that instant; if its holder had got as far as recording a lease,
 * that lease is on disk now and stays there until the holder releases the claim
 * (L1), which is what lets the single candidate below IDENTIFY the owner rather
 * than merely suggest that someone once held it (L2). A claim with no lease is
 * one we cannot attribute, so it is left alone.
 *
 * NEVER touches the lock itself (L5): the caller re-contends normally
 * afterwards, through the unchanged content-bound stale-reclaim predicate.
 */
async function recoverOrphanedGenerationClaim(
  claimPath: string,
  generation: LockGeneration,
  selfOwnerId: string
): Promise<boolean> {
  const dir = dirname(claimPath);
  const leasePrefix = `${basename(claimPath)}${ADOPTION_SPOOL_ROTATION_LOCK_LEASE_INFIX}`;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return false;
  }

  const leases: string[] = [];
  const steals: { name: string; victimId: string; recovererId: string }[] = [];
  for (const entry of entries) {
    if (!entry.startsWith(leasePrefix)) continue;
    const ownerPart = entry.slice(leasePrefix.length);
    const cut = ownerPart.indexOf(ADOPTION_SPOOL_ROTATION_LOCK_STEAL_INFIX);
    if (cut === -1) {
      leases.push(entry);
      continue;
    }
    steals.push({
      name: entry,
      victimId: ownerPart.slice(0, cut),
      recovererId: ownerPart.slice(
        cut + ADOPTION_SPOOL_ROTATION_LOCK_STEAL_INFIX.length
      ),
    });
  }

  // A steal record is NOT ownership evidence (L5): it can outlive its claim, so
  // reading one as a lease is exactly how a live claim gets attributed to a dead
  // owner. While its recoverer may still act we stand down; once that recoverer
  // is provably dead the record is only garbage, and collecting it keeps a stale
  // one from masking later recoveries of this generation.
  if (steals.length > 0) {
    for (const steal of steals) {
      if ((await classifyClaimOwner(steal.recovererId)) !== 'dead') continue;
      await bestEffortUnlink(join(dir, steal.name));
    }
    return false;
  }

  // Exactly one lease, bound to this claim, or there is nothing we may act on
  // (L3). Zero means a v1 peer's claim or a kill in one of the two
  // single-syscall windows — no evidence, never guessed at. More than one means
  // two owners appear to hold one claim, which the protocol cannot produce.
  if (leases.length !== 1) return false;
  const ownerId = leases[0].slice(leasePrefix.length);
  if (ownerId === selfOwnerId) return false;
  const leasePath = join(dir, leases[0]);
  if (!(await leaseBindsToGeneration(leasePath, generation))) return false;
  // L2: this lease PROVES the claim is that owner's, so proving the owner dead
  // proves the claim orphaned — rather than inferring orphanhood from the
  // absence of a live lease, which cannot distinguish a lease-less live claim.
  if ((await classifyClaimOwner(ownerId)) !== 'dead') return false;

  // One rename of one uniquely named path: the kernel elects a single winner
  // and every loser sees ENOENT (L4). This is what makes the following unlink
  // safe where r24-b's ctime check-then-unlink was not.
  const stealPath = claimStealPath(leasePath, selfOwnerId);
  try {
    await rename(leasePath, stealPath);
  } catch {
    return false;
  }

  let removed = false;
  try {
    const claimed = await lstat(claimPath, { bigint: true });
    if (
      !claimed.isSymbolicLink() &&
      claimed.isFile() &&
      sameLockGeneration({ dev: claimed.dev, ino: claimed.ino }, generation)
    ) {
      await unlink(claimPath);
      removed = true;
    }
  } catch {
    // Already gone, or unreadable: the steal record is dropped either way.
  }
  await bestEffortUnlink(stealPath);
  return removed;
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
      // The lock vanished between our lstat and this read: fail OPEN — treat it
      // as missing so the next attempt can recreate it. Nothing to reclaim.
      return { state: 'missing' };
    }
    // Any OTHER read error (EACCES on a foreign-owned mode-0600 stale lock, a
    // transient EIO, ...) means we cannot bind a reclaim to the lock's observed
    // bytes (#3615). This is INTENDED fail-closed (#3625): classify it
    // EXPLICITLY as `unreadable` — a non-reclaimable state — instead of letting
    // the exception propagate out of acquire (which would abort acquisition
    // wholesale on the first attempt) or guessing it is safe to remove a lock we
    // cannot even read (#3557's "never guess it is safe to remove"). A
    // foreign-owned/unreadable stale lock is NEVER reclaimed; rotation is simply
    // unavailable this cycle and a later acquire retries once it is readable or
    // gone.
    return { state: 'unreadable', generation };
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
 * can be created safely while this function cleans the old hard link.
 *
 * Protocol v2 (#3557): the claim is wrapped in a per-owner LEASE, created
 * before the link and dropped only once the claim is provably gone (L1), so a
 * claimant killed anywhere in this function leaves an orphan that a later
 * process can PROVE dead and recover. See the invariants in the module header.
 */
async function removeClaimedLockGeneration(
  lockPath: string,
  generation: LockGeneration,
  shouldRemove: () => Promise<boolean>
): Promise<boolean> {
  const claimPath = reclaimClaimPath(lockPath, generation);
  const ownerId = await adoptionSpoolRotationLockOwnerId();
  const leasePath = claimLeasePath(claimPath, ownerId);

  let ownedClaimGeneration: LockGeneration | undefined;
  let linked = false;
  let leaseHeld = false;
  try {
    try {
      await link(lockPath, claimPath);
      linked = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        // Someone else holds this generation's claim. We created NOTHING (L1:
        // a contender that loses the race never leaves a lease behind, which is
        // what keeps a stranded lease from ever being mistaken for a live
        // claim's owner). Try to prove the holder dead and recover the claim —
        // never the lock (L5).
        await recoverOrphanedGenerationClaim(claimPath, generation, ownerId);
        return false;
      }
      if (code === 'ENOENT') return false;
      throw error;
    }

    // L1: the claim is ours, so NOW record who owns it. Failing to record is
    // safe — the claim is simply unrecoverable if this process dies holding it,
    // exactly like a v1 peer's, and by L2 no one will attribute it to another
    // owner.
    leaseHeld = await createClaimLease(claimPath, leasePath);

    const claimed = await lstat(claimPath, { bigint: true });
    if (claimed.isSymbolicLink() || !claimed.isFile()) return false;
    // The path may have changed between the stale observation and link().
    // Remember what this successful claim actually linked so cleanup drops
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
    // L1's second half: the lease goes FIRST, so a lease can never outlive the
    // claim it attributes. If it cannot be removed, leave the claim in place
    // too — the pair then reads as a recoverable orphan once this process
    // exits, which is strictly better than stranding a lease beside a claim
    // some later owner would be blamed for.
    const leaseCleared = leaseHeld ? await clearOwnedLease(leasePath) : true;
    if (linked && leaseCleared) {
      await releaseOwnedClaim(claimPath, ownedClaimGeneration);
    }
  }
}

/** `true` once the lease is provably gone (removed here, or already absent). */
async function clearOwnedLease(leasePath: string): Promise<boolean> {
  try {
    await unlink(leasePath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/**
 * Drop a claim this call created, and report whether the claim path is now
 * clear. Best-effort by design: a missing claim is already clean, while an
 * unreadable or externally replaced one is left alone and reported as NOT
 * cleared so its lease outlives it.
 */
async function releaseOwnedClaim(
  claimPath: string,
  ownedClaimGeneration: LockGeneration | undefined
): Promise<boolean> {
  try {
    const claimed = await lstat(claimPath, { bigint: true });
    if (
      ownedClaimGeneration !== undefined &&
      !claimed.isSymbolicLink() &&
      claimed.isFile() &&
      sameLockGeneration(claimed, ownedClaimGeneration)
    ) {
      await unlink(claimPath);
      return true;
    }
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
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
      if (holder.state === 'unreadable') {
        // Fail-closed (#3625): a stale lock whose bytes we cannot read cannot be
        // bound to a content-verified reclaim (#3615), so we NEVER reclaim it.
        // Back off and retry within budget rather than reclaiming or aborting;
        // rotation is unavailable this cycle and a later acquire retries once the
        // lock becomes readable or is removed.
        await sleep(retryDelayMs);
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
