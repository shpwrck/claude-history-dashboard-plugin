// Unit tests for the pure, network-free helpers in file-findings.mjs (the stage-2
// router of the v0.6.0 review-phase audit harness). The gh-touching path is run
// on demand against a real repo; these cover the idempotency key, validation,
// labelling, and body construction that make concurrent multi-harness filing safe.
//   node --test scripts/audits/file-findings.test.mjs
//
// See docs/audits/v060-review-phase-audit.md.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  lensConfig,
  epicLabel,
  slug,
  normalizePath,
  primaryFile,
  dedupKey,
  severityToPriority,
  cleanTitle,
  signature,
  validateFinding,
  labelsFor,
  buildBody,
  parseArgs,
  LENS,
} from './file-findings.mjs';
import { GATES, DEFAULT_GATES, resolveGates } from './gates.config.mjs';

const validFinding = {
  lens: 'security',
  severity: 'high',
  title: 'Egress scrub is an identity stub',
  files: ['src/lib/anthropic-egress.ts:220-253', 'scripts/server.mjs:7949'],
  where: '- `src/lib/anthropic-egress.ts:220-253` — identity pass-through',
  what: 'Raw transcript egresses unredacted.',
  fix: 'Implement a real redactor.',
  acceptance: 'egressScrub redacts a known secret in a unit test.',
  priority: 'High',
  verified: true,
  verifyNote: 'read anthropic-egress.ts at ff8d83b4',
};

test('lensConfig maps the three lenses to their gate epics', () => {
  assert.equal(lensConfig('security').epic, 1932);
  assert.equal(lensConfig('data-integrity').epic, 2133);
  assert.equal(lensConfig('performance').epic, 1930);
  assert.throws(() => lensConfig('nope'), /unknown lens/);
});

test('epicLabel derives the epic-NNN child label', () => {
  assert.equal(epicLabel('security'), 'epic-1932');
  assert.equal(epicLabel('data-integrity'), 'epic-2133');
  assert.equal(epicLabel('performance'), 'epic-1930');
});

test('slug is kebab, trimmed, bounded, and never empty', () => {
  assert.equal(slug('Egress scrub is an IDENTITY stub!'), 'egress-scrub-is-an-identity-stub');
  assert.equal(slug('***'), 'finding');
  assert.ok(slug('x'.repeat(200)).length <= 60);
});

test('normalizePath strips only a trailing :line, preserving colons in filenames', () => {
  assert.equal(normalizePath('src/a.ts:12-30'), 'src/a.ts');
  assert.equal(normalizePath('  src/b.ts:44  '), 'src/b.ts');
  assert.equal(normalizePath('src/c.ts'), 'src/c.ts');
  assert.equal(normalizePath('src/a:two.ts:10'), 'src/a:two.ts'); // git allows ':' in a name
  assert.equal(normalizePath('src/a:one.ts:10'), 'src/a:one.ts');
});

test('primaryFile is the lexicographically-smallest normalized path (order-independent)', () => {
  assert.equal(primaryFile(validFinding), 'scripts/server.mjs'); // < 'src/lib/anthropic-egress.ts'
  assert.equal(primaryFile({ ...validFinding, files: [...validFinding.files].reverse() }), 'scripts/server.mjs');
  assert.throws(() => primaryFile({ title: 't', files: [] }), /no files/);
});

test('dedupKey is stable across line numbers and body wording', () => {
  const a = dedupKey(validFinding);
  const b = dedupKey({ ...validFinding, files: ['src/lib/anthropic-egress.ts:999', 'scripts/server.mjs:1'], where: 'reworded', what: 'different' });
  assert.equal(a, b, 'same lens+files+title must collapse to one key');
  assert.match(a, /^[0-9a-f]{12}$/);
});

test('dedupKey is independent of files[] order', () => {
  const a = dedupKey(validFinding);
  const b = dedupKey({ ...validFinding, files: [...validFinding.files].reverse() });
  assert.equal(a, b);
});

test('dedupKey differs by lens, by file, and by title', () => {
  const base = dedupKey(validFinding);
  assert.notEqual(base, dedupKey({ ...validFinding, lens: 'performance' }));
  assert.notEqual(base, dedupKey({ ...validFinding, files: ['src/other.ts:1'] }));
  assert.notEqual(base, dedupKey({ ...validFinding, title: 'A different defect entirely' }));
});

test('dedupKey uses the FULL title, so titles sharing the first 60 chars do not collide', () => {
  const shared = 'x'.repeat(58);
  const a = dedupKey({ ...validFinding, title: `${shared} alpha` });
  const b = dedupKey({ ...validFinding, title: `${shared} beta` });
  assert.notEqual(a, b);
});

test('severityToPriority folds critical/high -> High', () => {
  assert.equal(severityToPriority('critical'), 'High');
  assert.equal(severityToPriority('high'), 'High');
  assert.equal(severityToPriority('medium'), 'Medium');
  assert.equal(severityToPriority('low'), 'Low');
  assert.equal(severityToPriority('weird'), 'Medium');
});

test('cleanTitle strips a leading [tag] prefix only', () => {
  assert.equal(cleanTitle('[epic] Do the thing'), 'Do the thing');
  assert.equal(cleanTitle('Do the thing'), 'Do the thing');
  assert.equal(cleanTitle('  spaced  '), 'spaced');
});

test('signature emits the agent-sig block; main role omits the role word', () => {
  const s = signature({ vendor: 'codex', role: 'coder', instance: 'coder-1' });
  assert.match(s, /<!-- agent-sig v1 vendor=codex role=coder instance=coder-1 -->/);
  assert.match(s, /Signed: Codex coder \(coder-1\)/);
  assert.match(signature({ vendor: 'claude', role: 'main', instance: 'x' }), /Signed: Claude \(x\)/);
});

test('validateFinding accepts a good finding and flags each missing piece', () => {
  assert.deepEqual(validateFinding(validFinding), []);
  assert.ok(validateFinding({ ...validFinding, verified: false }).some((e) => /not verified/.test(e)));
  assert.ok(validateFinding({ ...validFinding, lens: 'x' }).some((e) => /bad lens/.test(e)));
  assert.ok(validateFinding({ ...validFinding, files: [] }).some((e) => /files/.test(e)));
  assert.ok(validateFinding({ ...validFinding, fix: '' }).some((e) => /fix/.test(e)));
  assert.ok(validateFinding({ ...validFinding, acceptance: '  ' }).some((e) => /acceptance/.test(e)));
  assert.ok(validateFinding({ ...validFinding, files: ['src/x.ts'] }).some((e) => /path:line/.test(e)));
  assert.ok(validateFinding({ ...validFinding, severity: 'bogus' }).some((e) => /severity/.test(e)));
  assert.ok(validateFinding({ ...validFinding, severity: undefined }).some((e) => /severity/.test(e)));
});

test('labelsFor includes domain+backlog+epic, and for-agent/groomed only with handoff', () => {
  assert.deepEqual(labelsFor(validFinding), ['security', 'backlog', 'epic-1932']);
  const h = labelsFor(validFinding, { handoff: true });
  assert.ok(h.includes('for-agent') && h.includes('groomed'));
});

test('buildBody carries provenance, the four fields, the epic ref, marker, and sig', () => {
  const key = dedupKey(validFinding);
  const sig = signature({ vendor: 'claude', role: 'main', instance: 'z' });
  const body = buildBody(validFinding, { baseline: 'ff8d83b4', auditDate: '2026-07-23', key, sig });
  assert.match(body, /origin\/master `ff8d83b4`, 2026-07-23/);
  assert.match(body, /\*\*Where\.\*\*/);
  assert.match(body, /\*\*Fix\.\*\*/);
  assert.match(body, /\*\*Acceptance\.\*\*/);
  assert.match(body, /\*\*Priority\.\*\* High \(severity: high\)/);
  assert.match(body, /Part of the #1932 review gate\./);
  assert.match(body, new RegExp(`<!-- audit-finding: ${key} -->`));
  assert.match(body, /Signed: Claude \(z\)/);
});

test('buildBody falls back to files[] bullets when where is absent', () => {
  const body = buildBody(
    { ...validFinding, where: '' },
    { baseline: 'b', auditDate: 'd', key: 'k', sig: 's' },
  );
  assert.match(body, /- `src\/lib\/anthropic-egress\.ts:220-253`/);
});

test('parseArgs requires --findings and parses flags incl --gates', () => {
  const a = parseArgs(['--findings', 'f.json', '--handoff', '--vendor', 'codex', '--instance', 'coder-2', '--dry-run', '--gates', 'security,performance']);
  assert.equal(a.findings, 'f.json');
  assert.equal(a.handoff, true);
  assert.equal(a.dryRun, true);
  assert.equal(a.vendor, 'codex');
  assert.equal(a.instance, 'coder-2');
  assert.equal(a.gates, 'security,performance');
  assert.throws(() => parseArgs(['--handoff']), /--findings/);
  assert.throws(() => parseArgs(['--bogus']), /unknown arg/);
});

test('LENS is the shared gate registry (alias of GATES)', () => {
  assert.equal(LENS, GATES);
  assert.equal(LENS.security.epic, 1932);
});

test('DEFAULT_GATES is the v0.6.0 remaining three; GATES also carries architecture', () => {
  assert.deepEqual([...DEFAULT_GATES].sort(), ['data-integrity', 'performance', 'security']);
  assert.ok(GATES.architecture, 'architecture gate available for reuse');
  assert.equal(GATES.architecture.closed, true);
  assert.ok(GATES.security.milestone && GATES.security.epic === 1932);
});

test('resolveGates selects a subset, defaults to the three, and rejects unknowns', () => {
  assert.deepEqual(resolveGates().sort(), ['data-integrity', 'performance', 'security']);
  assert.deepEqual(resolveGates('security,performance'), ['security', 'performance']);
  assert.deepEqual(resolveGates(['performance']), ['performance']);
  assert.deepEqual(resolveGates('architecture'), ['architecture']);
  assert.deepEqual(resolveGates(' security , performance '), ['security', 'performance']);
  assert.throws(() => resolveGates('security,bogus'), /unknown gate/);
});
