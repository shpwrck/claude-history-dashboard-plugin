import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  adoptionWritesDisabled,
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

export interface AdoptionSpoolDrainResult {
  drained: number;
  skipped: number;
  disabled?: true;
}

const SPOOL_DRAIN_BATCH_BYTES = 65_536;

// Read every JSONL line from the spool, append each line that sanitizes to a
// valid receipt into the canonical receipts log, then clear the spool. The
// drain is best-effort and never throws: a SessionStart hook write that can't be
// drained must never crash the server boot.
//
// Killswitch: when shadow-calls is OFF the drain writes NOTHING and leaves the
// spool untouched (the hook honours the same switch, so a disabled run simply
// defers — the spool drains on a later boot once shadows are re-enabled).
export async function drainAdoptionSpool(
  spoolFile: string,
  receiptsFile: string,
  opts: AdoptionReceiptOptions = {}
): Promise<AdoptionSpoolDrainResult> {
  if (adoptionWritesDisabled(opts)) {
    return { drained: 0, skipped: 0, disabled: true };
  }
  if (!existsSync(spoolFile)) {
    return { drained: 0, skipped: 0 };
  }

  const receiptsDir = dirname(receiptsFile);
  const tempFile = join(
    receiptsDir,
    `.${basename(receiptsFile)}.${Date.now().toString(36)}.${Math.random()
      .toString(36)
      .slice(2)}.tmp`
  );
  let tempCreated = false;
  let tempBody = '';
  let skipped = 0;

  const flushTempBody = async () => {
    if (!tempBody) return;
    await appendFile(tempFile, tempBody, 'utf8');
    tempBody = '';
  };

  try {
    // Reuse the canonical streaming parse->sanitize loop so a large spool does
    // not have to become one large records array before it can drain.
    const result = await streamAdoptionReceipts(
      spoolFile,
      opts.now ?? (() => new Date()),
      async (record) => {
        if (!tempCreated) {
          await mkdir(receiptsDir, { recursive: true });
          tempCreated = true;
        }
        tempBody += `${JSON.stringify(record)}\n`;
        if (Buffer.byteLength(tempBody, 'utf8') >= SPOOL_DRAIN_BATCH_BYTES) {
          await flushTempBody();
        }
      }
    );
    if (!result.read) {
      return { drained: 0, skipped: 0 };
    }
    skipped = result.skipped;
    await flushTempBody();
    if (tempCreated) {
      await pipeline(
        createReadStream(tempFile),
        createWriteStream(receiptsFile, { flags: 'a' })
      );
    }
    // Clear the spool only after a successful append so a failed write doesn't
    // lose the queued receipts. Truncate rather than unlink so the hook's
    // append target keeps existing.
    await writeFile(spoolFile, '', 'utf8');
    return { drained: result.records, skipped: result.skipped };
  } catch {
    // Append or truncate failed — leave the spool intact for the next boot.
    return { drained: 0, skipped };
  } finally {
    if (tempCreated) {
      try {
        await rm(tempFile, { force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}

// Convenience used by the live server on boot: drain, swallowing any error and
// removing an emptied spool file is intentionally NOT done (truncate keeps the
// inode), returning a quiet summary for an optional log line.
export async function drainAdoptionSpoolQuiet(
  spoolFile: string,
  receiptsFile: string,
  opts: AdoptionReceiptOptions = {}
): Promise<AdoptionSpoolDrainResult> {
  try {
    return await drainAdoptionSpool(spoolFile, receiptsFile, opts);
  } catch {
    return { drained: 0, skipped: 0 };
  }
}

// Exported only so a test can clean up its temp spool; not used in the boot path.
export async function removeSpool(spoolFile: string): Promise<void> {
  try {
    await rm(spoolFile, { force: true });
  } catch {
    /* best-effort */
  }
}
