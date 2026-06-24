// Policy write-back core for the Policy Builder route (#199), extracted from
// scripts/server.mjs (#625, epic #622). The validate -> read -> backup ->
// merge/dedupe -> write pipeline used to live inside the HTTP handler and was
// reachable only over HTTP, so the integration test scripts/policy-write.test.mjs
// was its only test surface. Lifting the pure-where-possible steps here makes
// them unit-testable without booting a server, on the one path that mutates the
// user's global ~/.claude/settings.json.
//
// Behaviour matches the prior inline implementation — same validation messages,
// same corrupt-file refusals, same timestamped backup BEFORE any write, same
// append+dedupe (idempotent, never drops existing rules), same pretty-print +
// trailing newline, same success payload — hardened for integrity under #2062:
//   - writes are ATOMIC (temp file + rename) so a crash can't truncate settings;
//   - writes are SERIALISED per file so concurrent requests can't clobber each
//     other's merged rules;
//   - backups are pruned to the newest MAX_POLICY_BACKUPS so a write loop can't
//     fill the user's home;
//   - rules are GRAMMAR-validated (ToolName / ToolName(specifier)) so malformed
//     junk can't land in the global permission buckets.
// The HTTP route in server.mjs now only frames these results into responses.

import { readFile, writeFile, copyFile, rename, unlink, readdir, stat } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';

export const POLICY_BUCKETS = ['allow', 'deny', 'ask'] as const;
export type PolicyBucket = (typeof POLICY_BUCKETS)[number];

export type PermissionsInput = Partial<Record<PolicyBucket, string[]>>;

// A Claude permission rule is `ToolName` or `ToolName(specifier)`. The tool name
// starts with a letter and is word-characters only (covers Bash, Read, WebFetch,
// WebSearch, and mcp__server__tool); the optional parenthesised specifier may be
// any text. We validate GRAMMAR (parseable), not breadth — a legitimately broad
// rule like `Bash(*)` is well-formed and accepted; junk like `; rm -rf` or
// `not a rule` is rejected before it lands in the user's global settings (#2062).
const PERMISSION_RULE_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(\(.*\))?$/;

// Keep at most this many timestamped settings.json.backup-* files; older ones
// are pruned after each successful write so a write loop cannot fill the user's
// home directory (#2062).
const MAX_POLICY_BACKUPS = 10;

export type ValidateResult =
  | { ok: true; perms: PermissionsInput }
  | { ok: false; error: string };

// Validate that a parsed body is a well-formed permissions block:
//   { permissions: { allow?: string[], deny?: string[], ask?: string[] } }
// Returns { ok: true, perms } or { ok: false, error }.
export function validatePolicyInput(parsed: unknown): ValidateResult {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Body must be a JSON object' };
  }
  const perms = (parsed as Record<string, unknown>).permissions;
  if (!perms || typeof perms !== 'object' || Array.isArray(perms)) {
    return { ok: false, error: 'Body must contain a "permissions" object' };
  }
  let hasAny = false;
  for (const bucket of POLICY_BUCKETS) {
    const val = (perms as Record<string, unknown>)[bucket];
    if (val === undefined) continue;
    if (!Array.isArray(val)) {
      return { ok: false, error: `permissions.${bucket} must be an array of strings` };
    }
    for (const rule of val) {
      if (typeof rule !== 'string' || rule.trim() === '') {
        return { ok: false, error: `permissions.${bucket} contains a non-string or empty rule` };
      }
      if (!PERMISSION_RULE_PATTERN.test(rule)) {
        return {
          ok: false,
          error: `permissions.${bucket} contains a malformed rule "${rule}" (expected ToolName or ToolName(specifier))`,
        };
      }
    }
    if (val.length > 0) hasAny = true;
  }
  if (!hasAny) {
    return { ok: false, error: 'No rules to write (allow/deny/ask are all empty)' };
  }
  return { ok: true, perms: perms as PermissionsInput };
}

export type AddedRules = Record<PolicyBucket, string[]>;

// Append + dedupe incoming rules into a copy of `current`'s permissions buckets.
// Existing rules and unrelated top-level keys are preserved; duplicates are not
// re-added. Pure: does not mutate `current`. Returns the merged object plus the
// rules actually added per bucket.
export function mergeAndDedupe(
  current: Record<string, unknown>,
  perms: PermissionsInput,
): { merged: Record<string, unknown>; added: AddedRules } {
  const existingPerms =
    current.permissions && typeof current.permissions === 'object' && !Array.isArray(current.permissions)
      ? (current.permissions as Record<string, unknown>)
      : {};
  const merged: Record<string, unknown> = { ...current, permissions: { ...existingPerms } };
  const mergedPerms = merged.permissions as Record<string, string[]>;
  const added: AddedRules = { allow: [], deny: [], ask: [] };
  for (const bucket of POLICY_BUCKETS) {
    const incoming = perms[bucket];
    if (!Array.isArray(incoming) || incoming.length === 0) continue;
    const base = Array.isArray(mergedPerms[bucket]) ? mergedPerms[bucket].slice() : [];
    const seen = new Set(base);
    for (const rule of incoming) {
      if (!seen.has(rule)) {
        base.push(rule);
        seen.add(rule);
        added[bucket].push(rule);
      }
    }
    mergedPerms[bucket] = base;
  }
  return { merged, added };
}

export type ApplyResult =
  | { ok: true; file: string; backup: string | null; added: AddedRules; addedCount: number }
  | { ok: false; status: number; error: string };

export interface PolicyWriteOptions {
  maxExistingBytes?: number;
}

// The full safety pipeline for one validated write: read the current settings
// (refuse to clobber a corrupt / non-object file), back up the existing file
// with a timestamped copy BEFORE writing, append+dedupe, then write
// pretty-printed with a trailing newline. Returns a discriminated result so the
// HTTP route maps {ok:false,status} to a response without knowing the file
// mechanics. On any failure the original file is left untouched (the only write
// is the final settings write, which is the last step).
// Serialise writes per file so concurrent requests cannot interleave their
// read -> merge -> write and clobber each other's added rules (#2062).
const policyWriteTails = new Map<string, Promise<unknown>>();
let policyWriteCounter = 0;

export function applyPolicyWrite(
  file: string,
  perms: PermissionsInput,
  opts: PolicyWriteOptions = {},
): Promise<ApplyResult> {
  const prior = policyWriteTails.get(file) ?? Promise.resolve();
  const run = prior.then(
    () => applyPolicyWriteInner(file, perms, opts),
    () => applyPolicyWriteInner(file, perms, opts),
  );
  // The stored tail swallows result and error so the next writer always
  // proceeds; drop the entry once this is the last write in flight.
  const tail = run.then(
    () => {},
    () => {},
  );
  policyWriteTails.set(file, tail);
  void tail.then(() => {
    if (policyWriteTails.get(file) === tail) policyWriteTails.delete(file);
  });
  return run;
}

async function applyPolicyWriteInner(
  file: string,
  perms: PermissionsInput,
  opts: PolicyWriteOptions = {},
): Promise<ApplyResult> {
  // Read the current settings. A missing file is fine (we create it); a
  // present-but-corrupt file is NOT — refuse rather than clobber it.
  let current: Record<string, unknown> = {};
  let fileExisted = false;
  const maxExistingBytes = normalizePositiveByteCap(opts.maxExistingBytes);
  try {
    if (maxExistingBytes > 0) {
      const info = await stat(file);
      if (info.isFile() && info.size > maxExistingBytes) {
        return {
          ok: false,
          status: 413,
          error: `Existing settings.json exceeds ${maxExistingBytes} byte limit; refusing to read or overwrite.`,
        };
      }
    }
    const existing = await readFile(file, 'utf8');
    fileExisted = true;
    if (existing.trim() !== '') {
      let parsedCurrent: unknown;
      try {
        parsedCurrent = JSON.parse(existing);
      } catch {
        return {
          ok: false,
          status: 409,
          error: 'Existing settings.json is not valid JSON; refusing to overwrite. Fix it manually first.',
        };
      }
      if (!parsedCurrent || typeof parsedCurrent !== 'object' || Array.isArray(parsedCurrent)) {
        return {
          ok: false,
          status: 409,
          error: 'Existing settings.json is not a JSON object; refusing to overwrite.',
        };
      }
      current = parsedCurrent as Record<string, unknown>;
    }
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.code !== 'ENOENT') {
      return { ok: false, status: 500, error: `Failed to read settings.json: ${e.message}` };
    }
  }

  // Back up the existing file BEFORE any write (timestamped copy).
  let backupPath: string | null = null;
  if (fileExisted) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = `${file}.backup-${ts}`;
    try {
      await copyFile(file, backupPath);
    } catch (err) {
      const e = err as { message?: string };
      return { ok: false, status: 500, error: `Failed to write backup; aborting: ${e.message}` };
    }
  }

  // Append + dedupe into permissions.allow/deny/ask.
  const { merged, added } = mergeAndDedupe(current, perms);

  // Write the merged result (pretty-printed, trailing newline) ATOMICALLY:
  // write a sibling temp file, then rename it over the target. rename(2) is
  // atomic on the same filesystem, so a crash/ENOSPC mid-write can never leave
  // a half-written or truncated settings.json — the old file stays intact until
  // the complete new one replaces it in one step (#2062).
  const tmpFile = `${file}.tmp-${process.pid}-${policyWriteCounter++}`;
  try {
    await writeFile(tmpFile, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
    await rename(tmpFile, file);
  } catch (err) {
    await unlink(tmpFile).catch(() => {});
    const e = err as { message?: string };
    return {
      ok: false,
      status: 500,
      error: `Failed to write settings.json: ${e.message}${backupPath ? ` (backup preserved at ${backupPath})` : ''}`,
    };
  }

  // Prune old timestamped backups so a write loop cannot fill the user's home.
  if (fileExisted) await pruneOldBackups(file, MAX_POLICY_BACKUPS);

  return {
    ok: true,
    file,
    backup: backupPath,
    added,
    addedCount: added.allow.length + added.deny.length + added.ask.length,
  };
}

// Keep only the newest `keep` settings.json.backup-* files. Timestamps are
// ISO-8601, which sorts chronologically as plain strings. Best-effort: pruning
// must never fail the write it follows.
async function pruneOldBackups(file: string, keep: number): Promise<void> {
  try {
    const dir = dirname(file);
    const prefix = `${basename(file)}.backup-`;
    const backups = (await readdir(dir)).filter((f) => f.startsWith(prefix));
    if (backups.length <= keep) return;
    backups.sort();
    await Promise.all(
      backups
        .slice(0, backups.length - keep)
        .map((f) => unlink(join(dir, f)).catch(() => {})),
    );
  } catch {
    // ignore — pruning is non-critical
  }
}

function normalizePositiveByteCap(value?: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}
