import {
  appendFile,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import {
  ADOPTION_RECEIPT_LINE_MAX_BYTES,
  ADOPTION_SPOOL_COMMIT_KIND,
  adoptionSpoolCommitMarker,
  adoptionWritesDisabled,
  isAdoptionSpoolCommitMarker,
  streamAdoptionReceipts,
  type AdoptionReceiptOptions,
} from './adoption-receipts';

// Server-side drain for the recs adoption-receipt SPOOL (#581).
//
// The SessionStart recs hook (a separate process under ~/.claude) emits one
// SURFACED receipt per session. Its primary path POSTs to the live dashboard
// route (#575). When the dashboard is DOWN, the hook can't POST, so it appends
// the line to a dashboard-OWNED spool instead — never into ~/.claude, which is
// transcript/corpus territory. This module drains that spool into the canonical
// adoption-receipts log the next time the server boots.
//
// The spool carries the exact same JSONL record shape the route accepts, so the
// drain reuses sanitizeAdoptionReceipt for the same fail-closed allowlist drop:
// any line that is not a valid SURFACED/SUPPRESSED receipt with only the
// allowlisted fields is discarded, so a corrupt or oversized spool can never
// leak a repo path, prompt body, or raw config into the receipts log.
//
// COMMIT PROTOCOL (#3106). The canonical receipts log is a shared append-only
// file with several independent writers (this drain, the POST route, the reject
// mirror, `ingest.mjs`, `proof-batch.mjs`). The drain therefore writes it the
// same way every other writer does — one `appendFile` call per unit — and never
// as a byte-chunked stream copy, because a stream copy splits records at
// arbitrary byte offsets and lets a concurrent appender land INSIDE a record.
//
// Each unit is a "batch": some whole receipt lines plus a trailing
// `_CHD_SPOOL_DRAIN_COMMIT` frame, emitted in ONE `appendFile` call, so the
// frame cannot be separated from the records it commits. The frame carries the
// snapshot byte OFFSET the batch covers, which makes recovery resumable rather
// than all-or-nothing: a retry reads the highest committed offset for the
// transaction out of the receipts log and restarts the snapshot there. A drain
// interrupted after N of M batches therefore appends only batches N+1..M on the
// next pass — no replay of what already landed, no loss of what did not.

export interface AdoptionSpoolDrainResult {
  drained: number;
  skipped: number;
  disabled?: true;
}

export type AdoptionSpoolDrainPhase =
  | 'snapshot-read'
  | 'batch-committed'
  | 'destination-appended'
  | 'before-snapshot-retire';

export interface AdoptionSpoolDrainOptions extends AdoptionReceiptOptions {
  /**
   * An observation seam for deterministic filesystem-barrier tests. Production
   * callers omit it; throwing leaves the private snapshot available to retry.
   */
  onPhase?: (phase: AdoptionSpoolDrainPhase) => void | Promise<void>;
}

/**
 * Soft cap on one destination append. Kept well under the size at which a
 * regular-file `write(2)` would be split, so each batch is a single atomic
 * O_APPEND write against every other writer of the log.
 */
const SPOOL_DRAIN_BATCH_BYTES = 65_536;
const SPOOL_SNAPSHOT_SUFFIX = '.snapshot';
/**
 * How many times one drain pass will chase a snapshot that grew underneath it
 * (a producer writing through a descriptor it opened before rotation). Bounded
 * so a hot producer cannot pin the drain; whatever is still unread is left in
 * the snapshot for the next drain, never deleted.
 */
const SPOOL_SNAPSHOT_TAIL_PASSES = 8;
const drainTails = new Map<string, Promise<void>>();

interface AdoptionSpoolSnapshot {
  file: string;
  transactionId: string;
}

interface AdoptionSpoolDrainOutcome {
  result: AdoptionSpoolDrainResult;
  retired: boolean;
}

function snapshotPrefix(spoolFile: string): string {
  return `.${basename(spoolFile)}.drain-`;
}

function snapshotPath(spoolFile: string, transactionId: string): string {
  return join(
    dirname(spoolFile),
    `${snapshotPrefix(spoolFile)}${transactionId}${SPOOL_SNAPSHOT_SUFFIX}`
  );
}

function snapshotFromName(
  spoolFile: string,
  name: string
): AdoptionSpoolSnapshot | null {
  const prefix = snapshotPrefix(spoolFile);
  if (!name.startsWith(prefix) || !name.endsWith(SPOOL_SNAPSHOT_SUFFIX)) {
    return null;
  }
  const transactionId = name.slice(
    prefix.length,
    -SPOOL_SNAPSHOT_SUFFIX.length
  );
  try {
    adoptionSpoolCommitMarker(transactionId, 0);
  } catch {
    return null;
  }
  return { file: join(dirname(spoolFile), name), transactionId };
}

async function listSnapshots(
  spoolFile: string
): Promise<AdoptionSpoolSnapshot[]> {
  const directory = dirname(spoolFile);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  return names
    .sort()
    .map((name) => snapshotFromName(spoolFile, name))
    .filter((snapshot): snapshot is AdoptionSpoolSnapshot => snapshot !== null);
}

async function rotateLiveSpool(
  spoolFile: string
): Promise<AdoptionSpoolSnapshot | null> {
  try {
    // If the live target is empty, leave it in place. A hook append that races
    // after this check stays queued at the live path for the next drain.
    if ((await stat(spoolFile)).size === 0) return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  const transactionId = randomUUID();
  const snapshot = snapshotPath(spoolFile, transactionId);
  try {
    await rename(spoolFile, snapshot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }

  // `a` creates the hook's live append target without truncating it if the
  // hook won the create race immediately after the atomic rename.
  const live = await open(spoolFile, 'a', 0o600);
  await live.close();
  return { file: snapshot, transactionId };
}

/**
 * The highest snapshot offset the receipts log already carries a commit frame
 * for, or `null` when this transaction has never committed anything. That
 * offset is the resume point: everything before it is durably in the
 * destination, everything after it still has to be appended.
 */
async function committedSnapshotOffset(
  receiptsFile: string,
  transactionId: string
): Promise<number | null> {
  let highest: number | null = null;
  const consider = (line: string): void => {
    // Cheap pre-filter: a commit frame always contains the literal kind, so the
    // scan only pays for JSON.parse on candidate lines, not on every receipt.
    if (!line.includes(ADOPTION_SPOOL_COMMIT_KIND)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isAdoptionSpoolCommitMarker(parsed)) return;
    if (parsed.transactionId !== transactionId) return;
    if (highest === null || parsed.offset > highest) highest = parsed.offset;
  };

  const input = createReadStream(receiptsFile, {
    encoding: 'utf8',
    highWaterMark: ADOPTION_RECEIPT_LINE_MAX_BYTES,
  });
  let pending = '';
  let droppingLongLine = false;
  try {
    for await (const chunk of input) {
      let text = String(chunk);
      while (text.length > 0) {
        const newlineIndex = text.indexOf('\n');
        const lineEnded = newlineIndex !== -1;
        const segment = lineEnded ? text.slice(0, newlineIndex) : text;
        text = lineEnded ? text.slice(newlineIndex + 1) : '';

        if (droppingLongLine) {
          if (lineEnded) droppingLongLine = false;
          continue;
        }

        pending += segment;
        if (
          Buffer.byteLength(pending, 'utf8') > ADOPTION_RECEIPT_LINE_MAX_BYTES
        ) {
          pending = '';
          droppingLongLine = !lineEnded;
          continue;
        }
        if (lineEnded) {
          consider(pending);
          pending = '';
        }
      }
    }
    if (!droppingLongLine && pending) consider(pending);
    return highest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally {
    input.destroy();
  }
}

async function snapshotSize(file: string): Promise<number | null> {
  try {
    return (await stat(file)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function drainSnapshot(
  snapshot: AdoptionSpoolSnapshot,
  receiptsFile: string,
  opts: AdoptionSpoolDrainOptions,
  recoverCommitted = true
): Promise<AdoptionSpoolDrainOutcome> {
  const receiptsDir = dirname(receiptsFile);
  let drained = 0;
  let skipped = 0;

  try {
    // A newly rotated transaction cannot already be committed, so the normal
    // path skips this O(history) scan of the canonical receipt log entirely.
    let consumed = recoverCommitted
      ? (await committedSnapshotOffset(receiptsFile, snapshot.transactionId)) ??
        0
      : 0;

    for (let pass = 0; pass < SPOOL_SNAPSHOT_TAIL_PASSES; pass += 1) {
      const size = await snapshotSize(snapshot.file);
      // Already gone (a concurrent retire, or never created) — nothing to do.
      if (size === null) return { result: { drained, skipped }, retired: true };
      if (consumed >= size) break;

      let batch = '';
      let batchBytes = 0;
      let batchRecords = 0;
      let batchOffset = consumed;
      let appended = false;
      let directoryReady = false;

      // One destination append: the batch's receipt lines AND the commit frame
      // that names the snapshot offset they cover, in a single `appendFile`
      // call. Nothing else can be interleaved into it, and no failure can land
      // the records without the frame.
      const commitBatch = async (offset: number): Promise<void> => {
        if (!batch) return;
        if (!directoryReady) {
          await mkdir(receiptsDir, { recursive: true });
          directoryReady = true;
        }
        const frame = `${JSON.stringify(
          adoptionSpoolCommitMarker(snapshot.transactionId, offset)
        )}\n`;
        await appendFile(receiptsFile, `${batch}${frame}`, 'utf8');
        batch = '';
        batchBytes = 0;
        // Counted only once the batch is durably committed, so the reported
        // total can never claim more receipts than the destination holds.
        drained += batchRecords;
        batchRecords = 0;
        consumed = offset;
        appended = true;
        await opts.onPhase?.('batch-committed');
      };

      // Reuse the canonical streaming parse->sanitize loop so a large spool does
      // not have to become one large records array before it can drain.
      const result = await streamAdoptionReceipts(
        snapshot.file,
        opts.now ?? (() => new Date()),
        async (record, endOffset) => {
          const encoded = `${JSON.stringify(record)}\n`;
          const encodedBytes = Buffer.byteLength(encoded, 'utf8');
          if (
            batchBytes > 0 &&
            batchBytes + encodedBytes > SPOOL_DRAIN_BATCH_BYTES
          ) {
            await commitBatch(batchOffset);
          }
          batch += encoded;
          batchBytes += encodedBytes;
          batchRecords += 1;
          batchOffset = endOffset;
        },
        { start: consumed }
      );
      if (!result.read) return { result: { drained, skipped }, retired: false };
      skipped += result.skipped;
      await opts.onPhase?.('snapshot-read');
      // The tail batch covers everything up to the byte the scan stopped at, so
      // a resume after a complete pass starts at EOF and replays nothing.
      await commitBatch(result.endOffset);
      consumed = Math.max(consumed, result.endOffset);
      if (appended) await opts.onPhase?.('destination-appended');
    }

    // Retire ONLY a snapshot whose every byte is committed. If a producer that
    // opened the live spool before rotation appended through that descriptor,
    // the snapshot is longer than what we consumed — keep it so the next drain
    // resumes at `consumed` and picks the tail up, instead of unlinking unread
    // receipts. (The producer can still write after this check; see the
    // "residual" note on drainAdoptionSpool.)
    const finalSize = await snapshotSize(snapshot.file);
    if (finalSize === null) return { result: { drained, skipped }, retired: true };
    if (finalSize > consumed) {
      return { result: { drained, skipped }, retired: false };
    }
    await opts.onPhase?.('before-snapshot-retire');
    await rm(snapshot.file);
    return { result: { drained, skipped }, retired: true };
  } catch {
    // Parse, append, or retirement failed — leave the private snapshot intact.
    // Whatever already committed carries its offset frame, so the next drain
    // resumes instead of replaying.
    return { result: { drained, skipped }, retired: false };
  }
}

async function serializeDrain<T>(
  spoolFile: string,
  task: () => Promise<T>
): Promise<T> {
  const previous = drainTails.get(spoolFile) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => turn);
  drainTails.set(spoolFile, tail);

  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (drainTails.get(spoolFile) === tail) {
      drainTails.delete(spoolFile);
    }
  }
}

// Atomically rotate the live JSONL append target to a private snapshot, recreate
// the live target immediately, and drain only snapshots. A hook append after
// rotation therefore stays queued for the next pass rather than being erased at
// the end of this one. The drain is best-effort and never throws: a
// SessionStart hook write that cannot be drained must never crash server boot.
//
// Killswitch: when shadow-calls is OFF the drain writes NOTHING and leaves both
// the live spool and any recovery snapshots untouched.
//
// RESIDUAL (documented, not fixed here — #3106 follow-up). Rotation is a
// consumer-side move, so it cannot quiesce the producer: a hook that opened the
// live spool for append BEFORE the rename holds a descriptor on the rotated
// inode and may write to it at any later time. This drain chases such a tail
// (it re-reads a snapshot that grew and refuses to unlink one whose bytes it
// has not all consumed), which narrows the loss window to a write landing
// between the final size check and the unlink — but it cannot close it.
// Closing it requires the PRODUCER to cooperate (a lock the drain honours, or a
// spool DIRECTORY where each receipt is renamed in atomically), and the
// producer lives in `~/.claude`, outside this repo.
//
// Cross-process drains are likewise NOT serialized: `serializeDrain` is an
// in-process mutex. Two server processes sharing one cache dir can rotate and
// drain concurrently.
export async function drainAdoptionSpool(
  spoolFile: string,
  receiptsFile: string,
  opts: AdoptionSpoolDrainOptions = {}
): Promise<AdoptionSpoolDrainResult> {
  if (adoptionWritesDisabled(opts)) {
    return { drained: 0, skipped: 0, disabled: true };
  }

  return serializeDrain(spoolFile, async () => {
    try {
      const snapshots = await listSnapshots(spoolFile);
      let drained = 0;
      let skipped = 0;
      for (const snapshot of snapshots) {
        const outcome = await drainSnapshot(snapshot, receiptsFile, opts);
        drained += outcome.result.drained;
        skipped += outcome.result.skipped;
        if (!outcome.retired) return { drained, skipped };
      }

      // Recover older private snapshots before rotating the current live file.
      // A repeatedly failing recovery therefore cannot accumulate or reorder
      // progressively newer snapshots.
      const rotated = await rotateLiveSpool(spoolFile);
      if (rotated) {
        const outcome = await drainSnapshot(rotated, receiptsFile, opts, false);
        drained += outcome.result.drained;
        skipped += outcome.result.skipped;
      }
      return { drained, skipped };
    } catch {
      return { drained: 0, skipped: 0 };
    }
  });
}

// Convenience used by the live server on boot: drain, swallowing any error and
// keeping the recreated live append target, returning a quiet summary for an
// optional log line.
export async function drainAdoptionSpoolQuiet(
  spoolFile: string,
  receiptsFile: string,
  opts: AdoptionSpoolDrainOptions = {}
): Promise<AdoptionSpoolDrainResult> {
  try {
    return await drainAdoptionSpool(spoolFile, receiptsFile, opts);
  } catch {
    return { drained: 0, skipped: 0 };
  }
}
