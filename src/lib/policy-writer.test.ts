import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validatePolicyInput,
  mergeAndDedupe,
  applyPolicyWrite,
} from './policy-writer';

const tmpDirs: string[] = [];
async function makeDir() {
  const d = await mkdtemp(join(tmpdir(), 'policy-writer-test-'));
  tmpDirs.push(d);
  return d;
}
afterEach(async () => {
  while (tmpDirs.length) await rm(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('validatePolicyInput', () => {
  it('rejects a non-object body', () => {
    expect(validatePolicyInput(null)).toEqual({ ok: false, error: 'Body must be a JSON object' });
    expect(validatePolicyInput([])).toEqual({ ok: false, error: 'Body must be a JSON object' });
    expect(validatePolicyInput('x')).toEqual({ ok: false, error: 'Body must be a JSON object' });
  });

  it('requires a permissions object', () => {
    expect(validatePolicyInput({})).toEqual({
      ok: false,
      error: 'Body must contain a "permissions" object',
    });
    expect(validatePolicyInput({ permissions: [] })).toEqual({
      ok: false,
      error: 'Body must contain a "permissions" object',
    });
  });

  it('rejects a non-array bucket', () => {
    expect(validatePolicyInput({ permissions: { allow: 'Bash(ls:*)' } })).toEqual({
      ok: false,
      error: 'permissions.allow must be an array of strings',
    });
  });

  it('rejects a non-string or empty rule', () => {
    expect(validatePolicyInput({ permissions: { deny: ['ok', ''] } })).toEqual({
      ok: false,
      error: 'permissions.deny contains a non-string or empty rule',
    });
    expect(validatePolicyInput({ permissions: { ask: [42] } })).toEqual({
      ok: false,
      error: 'permissions.ask contains a non-string or empty rule',
    });
  });

  it('rejects an all-empty payload', () => {
    expect(validatePolicyInput({ permissions: { allow: [], deny: [], ask: [] } })).toEqual({
      ok: false,
      error: 'No rules to write (allow/deny/ask are all empty)',
    });
  });

  it('accepts a well-formed body', () => {
    const r = validatePolicyInput({ permissions: { allow: ['Bash(ls:*)'] } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.perms.allow).toEqual(['Bash(ls:*)']);
  });
});

describe('mergeAndDedupe', () => {
  it('appends new rules and reports them, preserving unrelated keys', () => {
    const current = { model: 'claude-opus-4-8', permissions: { allow: ['Bash(ls:*)'] } };
    const { merged, added } = mergeAndDedupe(current, { allow: ['Bash(cat:*)'], deny: ['Bash(rm:*)'] });
    expect((merged as { model: string }).model).toBe('claude-opus-4-8');
    expect((merged.permissions as Record<string, string[]>).allow).toEqual(['Bash(ls:*)', 'Bash(cat:*)']);
    expect((merged.permissions as Record<string, string[]>).deny).toEqual(['Bash(rm:*)']);
    expect(added).toEqual({ allow: ['Bash(cat:*)'], deny: ['Bash(rm:*)'], ask: [] });
  });

  it('is idempotent — a duplicate rule is not re-added', () => {
    const current = { permissions: { allow: ['Bash(ls:*)'] } };
    const { merged, added } = mergeAndDedupe(current, { allow: ['Bash(ls:*)'] });
    expect((merged.permissions as Record<string, string[]>).allow).toEqual(['Bash(ls:*)']);
    expect(added.allow).toEqual([]);
  });

  it('does not mutate the input', () => {
    const current = { permissions: { allow: ['Bash(ls:*)'] } };
    mergeAndDedupe(current, { allow: ['Bash(cat:*)'] });
    expect(current.permissions.allow).toEqual(['Bash(ls:*)']);
  });
});

describe('applyPolicyWrite', () => {
  it('creates a missing file with no backup, pretty-printed + trailing newline', async () => {
    const dir = await makeDir();
    const file = join(dir, 'settings.json');
    const r = await applyPolicyWrite(file, { allow: ['Bash(ls:*)'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.backup).toBeNull();
    expect(r.addedCount).toBe(1);
    const written = await readFile(file, 'utf8');
    expect(written).toBe(`${JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }, null, 2)}\n`);
    expect(written.endsWith('\n')).toBe(true);
  });

  it('backs up the existing file BEFORE writing, and merges + dedupes', async () => {
    const dir = await makeDir();
    const file = join(dir, 'settings.json');
    await writeFile(
      file,
      `${JSON.stringify({ model: 'm', permissions: { allow: ['Bash(ls:*)'], deny: ['Bash(rm:*)'] } }, null, 2)}\n`,
      'utf8',
    );
    const r = await applyPolicyWrite(file, { allow: ['Bash(ls:*)', 'Bash(cat:*)'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Only the genuinely new rule is added.
    expect(r.added.allow).toEqual(['Bash(cat:*)']);
    expect(r.addedCount).toBe(1);
    // A timestamped backup exists alongside the file.
    const entries = await readdir(dir);
    const backups = entries.filter((f) => f.startsWith('settings.json.backup-'));
    expect(backups.length).toBe(1);
    expect(r.backup).toBe(join(dir, backups[0]));
    // Backup holds the ORIGINAL content; the live file holds the merge.
    const backupContent = JSON.parse(await readFile(join(dir, backups[0]), 'utf8'));
    expect(backupContent.permissions.allow).toEqual(['Bash(ls:*)']);
    const merged = JSON.parse(await readFile(file, 'utf8'));
    expect(merged.model).toBe('m');
    expect(merged.permissions.allow).toEqual(['Bash(ls:*)', 'Bash(cat:*)']);
    expect(merged.permissions.deny).toEqual(['Bash(rm:*)']);
  });

  it('is idempotent — re-applying the same rules changes nothing in the file', async () => {
    const dir = await makeDir();
    const file = join(dir, 'settings.json');
    await applyPolicyWrite(file, { allow: ['Bash(ls:*)'] });
    const afterFirst = await readFile(file, 'utf8');
    const r = await applyPolicyWrite(file, { allow: ['Bash(ls:*)'] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.addedCount).toBe(0);
    expect(await readFile(file, 'utf8')).toBe(afterFirst);
  });

  it('refuses to overwrite a corrupt (non-JSON) settings.json', async () => {
    const dir = await makeDir();
    const file = join(dir, 'settings.json');
    await writeFile(file, '{ not json', 'utf8');
    const r = await applyPolicyWrite(file, { allow: ['Bash(ls:*)'] });
    expect(r).toEqual({
      ok: false,
      status: 409,
      error: 'Existing settings.json is not valid JSON; refusing to overwrite. Fix it manually first.',
    });
    // Original left untouched.
    expect(await readFile(file, 'utf8')).toBe('{ not json');
  });

  it('refuses to read or back up an oversized existing settings.json', async () => {
    const dir = await makeDir();
    const file = join(dir, 'settings.json');
    const original = `${JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } })}\n`;
    await writeFile(file, original, 'utf8');

    const r = await applyPolicyWrite(
      file,
      { allow: ['Bash(cat:*)'] },
      { maxExistingBytes: 16 },
    );

    expect(r).toEqual({
      ok: false,
      status: 413,
      error: 'Existing settings.json exceeds 16 byte limit; refusing to read or overwrite.',
    });
    expect(await readFile(file, 'utf8')).toBe(original);
    const backups = (await readdir(dir)).filter((f) =>
      f.startsWith('settings.json.backup-')
    );
    expect(backups).toEqual([]);
  });

  it('refuses a present-but-non-object settings.json', async () => {
    const dir = await makeDir();
    const file = join(dir, 'settings.json');
    await writeFile(file, '[]', 'utf8');
    const r = await applyPolicyWrite(file, { allow: ['Bash(ls:*)'] });
    expect(r).toEqual({
      ok: false,
      status: 409,
      error: 'Existing settings.json is not a JSON object; refusing to overwrite.',
    });
  });
});
