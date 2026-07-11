#!/usr/bin/env node
// End-to-end test for the host-side doc-neighborhood inject producer (#2322):
// scripts/doc-neighborhood-inject.mjs. Proves the ADR-0007 producer path over a
// REAL on-disk doc tree (buildDocGraph -> buildDocNeighborhoodInjection -> JSON)
// and the suppression contract (empty stdout when the anchor resolves to
// nothing). Inline tmp fixtures only — nothing couples CI to committed docs.
//
// Run: node --test scripts/doc-neighborhood-inject.test.mjs
//   (the producer spawns its own child under the register-ts loader; this parent
//    test needs no loader.)

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const SCRIPTS_DIR = dirname(fileURLToPath(import.meta.url));
const LOADER = join(SCRIPTS_DIR, 'register-ts.mjs');
const PRODUCER = join(SCRIPTS_DIR, 'doc-neighborhood-inject.mjs');

/** Spawn the producer with the given args; return { stdout, stderr, code }. */
async function runProducer(args, cwd) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--import', LOADER, PRODUCER, ...args],
      { cwd, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }
    );
    return { stdout, stderr, code: 0 };
  } catch (err) {
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code ?? 1 };
  }
}

/** A tmp doc tree: live `a` links INTO superseded `b` (a live->retired conflict). */
async function makeDocTree() {
  const dir = await mkdtemp(join(tmpdir(), 'doc-neighborhood-inject-'));
  await writeFile(
    join(dir, 'a.md'),
    '---\nstatus: accepted\n---\n\n# A\n\nSee [b](b.md) for details.\n'
  );
  await writeFile(
    join(dir, 'b.md'),
    '---\nstatus: superseded\n---\n\n# B\n\nOld content.\n'
  );
  return dir;
}

test('emits the ranked injection JSON for a resolving anchor', async () => {
  const dir = await makeDocTree();
  try {
    const { stdout, code } = await runProducer(['--doc', 'a', '--root', dir]);
    assert.equal(code, 0);
    const inj = JSON.parse(stdout);

    assert.deepEqual(inj.anchor, { kind: 'doc', slug: 'a' });
    assert.deepEqual(inj.seeds, ['a']);
    const slugs = inj.nodes.map((n) => n.slug).sort();
    assert.deepEqual(slugs, ['a', 'b']);

    // b is a live->retired conflict: contradictory + stale, and DEMOTED.
    const b = inj.nodes.find((n) => n.slug === 'b');
    assert.equal(b.status, 'demoted');
    assert.match(b.asOf, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(b.hygiene.stale, true);
    assert.equal(b.hygiene.contradictory, true);

    // The ambiguity-trigger signal fires with auditable provenance.
    assert.equal(inj.ambiguityTrigger, true);
    assert.deepEqual(inj.ambiguitySources, ['b']);
    assert.equal(inj.trigger.kind, 'doc-ambiguity');
    assert.equal(inj.trigger.authorityConflict, true);
    const src = inj.trigger.sources.find((s) => s.slug === 'b');
    assert.deepEqual(src.flags, ['contradictory', 'stale']);
    assert.equal(src.declaredStatus, 'superseded');
    const obs = inj.trigger.provenance.observations.find((o) =>
      o.field.includes('slug=b')
    );
    assert.equal(obs.source, 'doc-neighborhood (#2263)');
    assert.match(obs.value, /contradictory\+stale|stale\+contradictory/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolves a --file anchor to the doc node', async () => {
  const dir = await makeDocTree();
  try {
    const { stdout, code } = await runProducer(['--file', 'a.md', '--root', dir]);
    assert.equal(code, 0);
    const inj = JSON.parse(stdout);
    assert.deepEqual(inj.anchor, { kind: 'file', path: 'a.md' });
    assert.deepEqual(inj.seeds, ['a']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('suppresses (empty stdout) when the anchor resolves to nothing', async () => {
  const dir = await makeDocTree();
  try {
    const { stdout, code } = await runProducer(['--doc', 'nonexistent', '--root', dir]);
    assert.equal(code, 0);
    assert.equal(stdout.trim(), ''); // inject nothing, log nothing
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('errors (exit 2) when no anchor is given', async () => {
  const { code, stderr } = await runProducer([], SCRIPTS_DIR);
  assert.equal(code, 2);
  assert.match(stderr, /exactly one of --file/);
});
