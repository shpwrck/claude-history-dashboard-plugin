// Unit tests for the pure, network-free helpers in file-findings.mjs (the stage-2
// router of the v0.6.0 review-phase audit harness). The gh-touching path is run
// on demand against a real repo; these cover the idempotency key, validation,
// labelling, and body construction that make concurrent multi-harness filing safe.
//   node --test scripts/audits/file-findings.test.mjs
//
// See docs/audits/v060-review-phase-audit.md.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import Ajv from 'ajv';

import {
  lensConfig,
  epicLabel,
  slug,
  normalizePath,
  parseEvidenceRef,
  primaryFile,
  dedupKey,
  severityToPriority,
  cleanTitle,
  signature,
  sanitizeIssueText,
  validateEvidenceAtBaseline,
  validateFinding,
  labelsFor,
  buildBody,
  buildRegressionComment,
  parseArgs,
  resultEntry,
  auditRollupMarker,
  buildAuditRollupBody,
  selectAuditParent,
  parseSubIssuePages,
  listSubIssueNumbers,
  findExisting,
  isLinkedSubIssue,
  parentIssueNumber,
  isDescendantOf,
  resolveFindingParent,
  portableArtifactPath,
  gh,
  runFileFindings,
  SUB_ISSUE_LIMIT,
  DIRECT_GATE_FINDING_LIMIT,
  LENS,
} from './file-findings.mjs';
import { GATES, DEFAULT_GATES, resolveGates } from './gates.config.mjs';
const BASELINE = 'a'.repeat(40);

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

const validSubtractionFinding = {
  lens: 'subtraction',
  severity: 'low',
  title: 'Retire the dormant TLS deployment flavor unless the hosted tier ships',
  files: ['Caddyfile:1', 'docker-compose.tls.yml:1'],
  where: 'The root deployment configuration.',
  what: 'The TLS flavor is wired but has never been exercised on the known operator host or in CI.',
  cut: ['Caddyfile', 'docker-compose.tls.yml'],
  blastRadius: [
    'README.md TLS setup instructions',
    'compose users that explicitly select docker-compose.tls.yml',
  ],
  keepIf: 'Keep only if the hosted/self-hoster tier is committed for this release.',
  reversibility: 'Both files and their setup history remain recoverable from git history.',
  fix: 'Delete the dormant flavor or demote it to a non-shipped documentation recipe.',
  acceptance: 'The selected disposition is reflected in deployment files and documentation.',
  priority: 'Low',
  verified: true,
  verifyNote: 'The v0.6 file audit records zero known Caddy container runs and no CI exercise.',
};

test('lensConfig maps the standing lenses to their gate epics', () => {
  assert.equal(lensConfig('security').epic, 1932);
  assert.equal(lensConfig('data-integrity').epic, 2133);
  assert.equal(lensConfig('performance').epic, 1930);
  assert.equal(lensConfig('subtraction').epic, 2994);
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

test('validateFinding requires the complete subtraction decision shape', () => {
  assert.deepEqual(validateFinding(validSubtractionFinding), []);
  for (const field of ['cut', 'blastRadius', 'keepIf', 'reversibility']) {
    const candidate = { ...validSubtractionFinding };
    delete candidate[field];
    assert.ok(
      validateFinding(candidate).some((error) => error.includes(field)),
      `missing ${field} must fail closed`,
    );
  }
  assert.ok(
    validateFinding({ ...validSubtractionFinding, cut: [] }).some((error) => /cut/.test(error)),
  );
  assert.ok(
    validateFinding({ ...validSubtractionFinding, blastRadius: [''] })
      .some((error) => /blastRadius/.test(error)),
  );
  assert.ok(
    validateFinding({ ...validSubtractionFinding, cut: ['Caddyfile', 'Caddyfile'] })
      .some((error) => /cut/.test(error)),
  );
  assert.ok(
    validateFinding({ ...validSubtractionFinding, blastRadius: [{}] })
      .some((error) => /blastRadius/.test(error)),
  );
  assert.ok(
    validateFinding({ ...validSubtractionFinding, keepIf: {} })
      .some((error) => /keepIf/.test(error)),
  );
});

test('the receipt schema accepts only the gate-appropriate finding shape', () => {
  const schema = JSON.parse(
    readFileSync(new URL('./audit-receipt.schema.json', import.meta.url), 'utf8'),
  );
  const validate = new Ajv().compile(schema);
  const receiptFor = (finding) => ({
    baseline: BASELINE,
    auditDate: '2026-08-11',
    section: 'root',
    gates: [finding.lens],
    auditedFiles: finding.files.map(normalizePath),
    verdicts: finding.files.map((fileRef) => ({
      file: normalizePath(fileRef),
      gates: [{ gate: finding.lens, status: 'finding', reason: 'Verified candidate.' }],
    })),
    findings: [finding],
  });

  assert.equal(validate(receiptFor(validFinding)), true, JSON.stringify(validate.errors));
  assert.equal(validate(receiptFor(validSubtractionFinding)), true, JSON.stringify(validate.errors));

  const incomplete = { ...validSubtractionFinding };
  delete incomplete.keepIf;
  assert.equal(validate(receiptFor(incomplete)), false);
  assert.match(JSON.stringify(validate.errors), /keepIf/);

  assert.equal(validate(receiptFor({ ...validFinding, cut: ['src/lib/anthropic-egress.ts'] })), false);
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

test('buildBody renders a standalone subtraction proposal', () => {
  const key = dedupKey(validSubtractionFinding);
  const body = buildBody(validSubtractionFinding, {
    baseline: BASELINE,
    auditDate: '2026-08-11',
    key,
    sig: signature({ vendor: 'codex', role: 'coder', instance: 'audit-1' }),
  });
  assert.match(body, /v0\.7\.0 review-phase audit \(subtraction lens\)/);
  assert.match(body, /\*\*Cut\.\*\*[\s\S]*- `Caddyfile`[\s\S]*- `docker-compose\.tls\.yml`/);
  assert.match(body, /\*\*Blast radius\.\*\*/);
  assert.match(body, /README\.md TLS setup instructions/);
  assert.match(body, /\*\*Keep if\.\*\* Keep only if the hosted\/self-hoster tier/);
  assert.match(body, /\*\*Reversibility\.\*\* Both files and their setup history remain recoverable from git history/);
  assert.match(body, /Part of the #2994 review gate\./);
});

test('buildRegressionComment keeps the subtraction release and decision shape', () => {
  const comment = buildRegressionComment(validSubtractionFinding, {
    baseline: BASELINE,
    auditDate: '2026-08-11',
    sig: signature({ vendor: 'codex', role: 'coder', instance: 'audit-1' }),
  });
  assert.match(comment, /Reproduced by the v0\.7\.0 review-phase audit/);
  assert.match(comment, /\*\*Cut\.\*\*/);
  assert.match(comment, /\*\*Blast radius\.\*\*/);
  assert.match(comment, /\*\*Keep if\.\*\*/);
  assert.match(comment, /\*\*Reversibility\.\*\*/);
});

test('parseArgs requires --findings and parses flags incl --gates and --result', () => {
  const a = parseArgs([
    '--findings',
    'f.json',
    '--result',
    'result.json',
    '--handoff',
    '--vendor',
    'codex',
    '--instance',
    'coder-2',
    '--dry-run',
    '--gates',
    'security,performance',
  ]);
  assert.equal(a.findings, 'f.json');
  assert.equal(a.result, 'result.json');
  assert.equal(a.handoff, true);
  assert.equal(a.dryRun, true);
  assert.equal(a.vendor, 'codex');
  assert.equal(a.instance, 'coder-2');
  assert.equal(a.gates, 'security,performance');
  assert.throws(() => parseArgs(['--handoff']), /--findings/);
  assert.throws(() => parseArgs(['--findings', 'f.json', '--result']), /needs a path/);
  assert.throws(() => parseArgs(['--bogus']), /unknown arg/);
});

test("gh wrapper raises the child-process buffer above GitHub's 100-sub-issue response size", () => {
  let invocation;
  const output = gh(['api', 'endpoint'], {
    repo: 'owner/repo',
    runner: (file, args, options) => {
      invocation = { file, args, options };
      return '[]';
    },
  });
  assert.equal(output, '[]');
  assert.equal(invocation.file, 'gh');
  assert.ok(invocation.options.maxBuffer >= 128 * 1024 * 1024);
  assert.equal(invocation.options.env.GH_REPO, 'owner/repo');
});

test('LENS is the shared gate registry (alias of GATES)', () => {
  assert.equal(LENS, GATES);
  assert.equal(LENS.security.epic, 1932);
  assert.equal(LENS.subtraction.epic, 2994);
});

test('DEFAULT_GATES includes the standing subtraction lens; architecture remains opt-in', () => {
  assert.deepEqual([...DEFAULT_GATES].sort(), ['data-integrity', 'performance', 'security', 'subtraction']);
  assert.ok(GATES.architecture, 'architecture gate available for reuse');
  assert.equal(GATES.architecture.closed, true);
  assert.ok(GATES.security.milestone && GATES.security.epic === 1932);
  assert.equal(GATES.subtraction.closed, undefined);
  assert.equal(GATES.subtraction.milestone, 'v0.7.0');
});

test('resolveGates selects a subset, defaults to the standing four, and rejects unknowns', () => {
  assert.deepEqual(resolveGates().sort(), ['data-integrity', 'performance', 'security', 'subtraction']);
  assert.deepEqual(resolveGates('security,performance'), ['security', 'performance']);
  assert.deepEqual(resolveGates(['performance']), ['performance']);
  assert.deepEqual(resolveGates('architecture'), ['architecture']);
  assert.deepEqual(resolveGates(' security , performance '), ['security', 'performance']);
  assert.throws(() => resolveGates('security,bogus'), /unknown gate/);
});

test('resultEntry always exposes lens, key, title, and number; invalid findings use nulls', () => {
  const key = dedupKey(validFinding);
  assert.deepEqual(resultEntry(validFinding, { key, number: 42 }), {
    lens: 'security',
    key,
    title: 'Egress scrub is an identity stub',
    number: 42,
  });
  assert.deepEqual(resultEntry({ verified: false }, { reason: 'invalid' }), {
    lens: null,
    key: null,
    title: null,
    number: null,
    reason: 'invalid',
  });
});

test('parseSubIssuePages flattens every paginated gh api page', () => {
  const firstPage = Array.from({ length: 30 }, (_, i) => ({ number: i + 1 }));
  const payload = JSON.stringify([firstPage, [{ number: 31 }, { number: 77 }]]);
  assert.deepEqual(parseSubIssuePages(payload), [...Array.from({ length: 31 }, (_, i) => i + 1), 77]);
  assert.deepEqual(parseSubIssuePages(''), []);
});

test('isLinkedSubIssue requests and searches every native sub-issue page', () => {
  let calledArgs;
  const firstPage = Array.from({ length: 30 }, (_, i) => ({ number: i + 1 }));
  const runner = (args) => {
    calledArgs = args;
    return JSON.stringify([firstPage, [{ number: 88 }]]);
  };

  assert.equal(isLinkedSubIssue(1932, 88, { repo: 'o/r', runner }), true);
  assert.deepEqual(listSubIssueNumbers(1932, { repo: 'o/r', runner }), [
    ...Array.from({ length: 30 }, (_, i) => i + 1),
    88,
  ]);
  assert.ok(calledArgs.includes('--paginate'));
  assert.ok(calledArgs.includes('--slurp'));
  assert.match(calledArgs[1], /repos\/o\/r\/issues\/1932\/sub_issues/);
});

test('selectAuditParent reserves direct gate capacity and reuses an open rollup', () => {
  assert.equal(SUB_ISSUE_LIMIT, 100);
  assert.equal(DIRECT_GATE_FINDING_LIMIT, 90);
  assert.deepEqual(
    selectAuditParent({ epic: 2133, directChildCount: 89 }),
    { parent: 2133, createRollup: false },
  );
  assert.deepEqual(
    selectAuditParent({
      epic: 2133,
      directChildCount: 90,
      rollups: [
        { number: 400, state: 'CLOSED', childCount: 2 },
        { number: 401, state: 'OPEN', childCount: 99 },
      ],
    }),
    { parent: 401, createRollup: false },
  );
  assert.deepEqual(
    selectAuditParent({ epic: 2133, directChildCount: 90, rollups: [] }),
    { parent: null, createRollup: true },
  );
  assert.throws(
    () => selectAuditParent({ epic: 2133, directChildCount: 100, rollups: [] }),
    /100-sub-issue limit/,
  );
});

test('audit rollup body pins the baseline, gate, marker, close rule, and signature', () => {
  const sig = signature({ vendor: 'codex', role: 'main', instance: 'audit-1' });
  const body = buildAuditRollupBody('data-integrity', {
    baseline: BASELINE,
    auditDate: '2026-07-26',
    sig,
  });
  assert.match(body, new RegExp(auditRollupMarker('data-integrity', BASELINE)));
  assert.match(body, /#2133 release-gate hierarchy/);
  assert.match(body, /Close when/);
  assert.match(body, /Signed: Codex/);
});

test('parent traversal recognizes nested gate descendants and no-parent issues', () => {
  const parents = new Map([[700, 600], [600, 2133]]);
  const runner = (args) => {
    const issue = Number(args[1].match(/issues\/(\d+)\/parent/)[1]);
    if (!parents.has(issue)) {
      const error = new Error('HTTP 404: Issue does not have a parent');
      error.stderr = '404 Not Found';
      throw error;
    }
    return String(parents.get(issue));
  };
  assert.equal(parentIssueNumber(700, { repo: 'o/r', runner }), 600);
  assert.equal(parentIssueNumber(2133, { repo: 'o/r', runner }), null);
  assert.equal(isDescendantOf(2133, 700, { repo: 'o/r', runner }), true);
  assert.equal(isDescendantOf(1932, 700, { repo: 'o/r', runner }), false);
});

test('resolveFindingParent reuses capacity or creates and links a deterministic rollup', () => {
  const direct = Array.from({ length: 90 }, (_, index) => ({ number: index + 1 }));
  const directWithRollup = direct.map((issue, index) =>
    index === direct.length - 1
      ? {
          number: 500,
          state: 'OPEN',
          body: `<!-- ${auditRollupMarker('data-integrity', BASELINE)} -->`,
        }
      : issue,
  );
  const runnerWithRollup = (args) => {
    const joined = args.join(' ');
    if (joined.includes('/issues/2133/sub_issues')) return JSON.stringify([directWithRollup]);
    if (joined.includes('/issues/500/sub_issues')) {
      return JSON.stringify([[{ number: 800 }, { number: 801 }]]);
    }
    throw new Error('unexpected args: ' + joined);
  };
  assert.equal(
    resolveFindingParent({
      lens: 'data-integrity',
      baseline: BASELINE,
      auditDate: '2026-07-26',
      sig: 'sig',
      repo: 'o/r',
      runner: runnerWithRollup,
    }),
    500,
  );

  const linked = [];
  const runnerWithoutRollup = (args) => {
    const joined = args.join(' ');
    if (joined.includes('/issues/2133/sub_issues')) return JSON.stringify([direct]);
    throw new Error('unexpected args: ' + joined);
  };
  assert.equal(
    resolveFindingParent({
      lens: 'data-integrity',
      baseline: BASELINE,
      auditDate: '2026-07-26',
      sig: 'sig',
      repo: 'o/r',
      runner: runnerWithoutRollup,
      createIssueFn: ({ title, labels }) => {
        assert.match(title, /continuation 1/);
        assert.ok(labels.includes('meta'));
        return 501;
      },
      linkSubIssueFn: (parent, child) => linked.push([parent, child]),
    }),
    501,
  );
  assert.deepEqual(linked, [[2133, 501]]);
});

test('portableArtifactPath removes checkout-specific prefixes only for in-repo artifacts', () => {
  assert.equal(
    portableArtifactPath('/repo/docs/audits/findings/a.json', '/repo'),
    'docs/audits/findings/a.json',
  );
  assert.equal(portableArtifactPath('docs/a.json', '/repo'), 'docs/a.json');
  assert.equal(portableArtifactPath('/outside/a.json', '/repo'), '/outside/a.json');
});

test('runFileFindings returns and writes created/existing/skipped issue identities without live GitHub', () => {
  const existing = { ...validFinding, title: '[security] Existing finding' };
  const created = { ...validFinding, title: '[security] New finding', files: ['src/new.ts:4'] };
  const invalid = { ...validFinding, title: 'Unverified finding', verified: false };
  const inactive = {
    ...validFinding,
    lens: 'performance',
    title: 'Inactive gate finding',
    files: ['src/slow.ts:9'],
  };
  const doc = {
    baseline: BASELINE,
    auditDate: '2026-07-26',
    section: 'src/lib',
    findings: [existing, created, invalid, inactive, { ...existing }],
  };
  const existingKey = dedupKey(existing);
  const createdKey = dedupKey(created);
  const linked = [];
  const reconciled = [];
  let written;

  const summary = runFileFindings(
    {
      findings: 'findings.json',
      result: 'result.json',
      dryRun: false,
      handoff: false,
      repo: 'o/r',
      vendor: 'codex',
      role: 'main',
      instance: 'audit-1',
      gates: 'security',
    },
    {
      readFindings: () => doc,
      verifyFindingAtBaseline: () => [],
      findExistingIssue: (key) => (key === existingKey ? 41 : null),
      ensureEpicLabelForFinding: () => {},
      reconcileOpenFinding: (value) => reconciled.push(value),
      createFindingIssue: ({ title }) => {
        assert.equal(title, 'New finding');
        return 52;
      },
      linkFindingIssue: ({ lens, childNumber, baseline }) => {
        linked.push([lensConfig(lens).epic, childNumber, baseline]);
        return lensConfig(lens).epic;
      },
      writeResult: (path, value) => {
        written = { path, value };
      },
      log: () => {},
    },
  );

  assert.deepEqual(summary.created, [
    { lens: 'security', key: createdKey, title: 'New finding', number: 52 },
  ]);
  assert.deepEqual(summary.existing, [
    { lens: 'security', key: existingKey, title: 'Existing finding', number: 41 },
  ]);
  assert.deepEqual(
    summary.skipped.map(({ reason, number }) => [reason, number]),
    [
      ['invalid', null],
      ['gate-inactive', null],
      ['in-batch-duplicate', 41],
    ],
  );
  assert.deepEqual(linked, [
    [1932, 41, BASELINE],
    [1932, 52, BASELINE],
  ]);
  assert.equal(reconciled[0].number, 41);
  assert.equal(reconciled[0].milestone, 'v0.6.0');
  assert.ok(reconciled[0].labels.includes('epic-1932'));
  assert.equal(written.path, 'result.json');
  assert.deepEqual(written.value, summary);
});

test('subtraction routing files the dormant TLS fixture and leaves a load-bearing batch empty', () => {
  const created = [];
  const dependencies = {
    readFindings: () => ({
      baseline: BASELINE,
      auditDate: '2026-08-11',
      section: 'root',
      auditedFiles: ['Caddyfile', 'docker-compose.tls.yml'],
      findings: [validSubtractionFinding],
    }),
    verifyFindingAtBaseline: () => [],
    findExistingIssue: () => null,
    ensureEpicLabelForFinding: () => {},
    createFindingIssue: (issue) => {
      created.push(issue);
      return 4001;
    },
    linkFindingIssue: ({ lens }) => lensConfig(lens).epic,
    log: () => {},
  };
  const options = {
    findings: 'tls-receipt.json',
    dryRun: false,
    handoff: false,
    repo: 'o/r',
    vendor: 'codex',
    role: 'main',
    instance: 'audit-1',
    gates: 'subtraction',
  };

  const dormant = runFileFindings(options, dependencies);
  assert.deepEqual(dormant.created.map(({ number }) => number), [4001]);
  assert.equal(created[0].milestone, 'v0.7.0');
  assert.ok(created[0].labels.includes('epic-2994'));
  assert.match(created[0].body, /\*\*Cut\.\*\*/);
  assert.match(created[0].body, /\*\*Blast radius\.\*\*/);
  assert.match(created[0].body, /\*\*Keep if\.\*\*/);

  const live = runFileFindings(options, {
    ...dependencies,
    readFindings: () => ({
      baseline: BASELINE,
      auditDate: '2026-08-11',
      section: 'root',
      auditedFiles: ['Dockerfile'],
      findings: [],
    }),
  });
  assert.deepEqual(live.created, []);
  assert.equal(created.length, 1);
});

test('runFileFindings dry-run reports would-be issues as skipped and never as created', () => {
  let createCalls = 0;
  let linkCalls = 0;
  let written;
  const summary = runFileFindings(
    {
      findings: 'findings.json',
      result: 'result.json',
      dryRun: true,
      handoff: false,
      repo: 'o/r',
      vendor: 'codex',
      role: 'main',
      instance: 'unknown',
      gates: 'security',
    },
    {
      readFindings: () => ({
        baseline: BASELINE,
        auditDate: '2026-07-26',
        section: 'src/lib',
        findings: [validFinding],
      }),
      findExistingIssue: () => null,
      verifyFindingAtBaseline: () => [],
      ensureEpicLabelForFinding: () => {},
      createFindingIssue: () => {
        createCalls++;
        return 999;
      },
      linkFindingIssue: () => {
        linkCalls++;
        return 1932;
      },
      writeResult: (_path, value) => {
        written = value;
      },
      log: () => {},
    },
  );

  assert.deepEqual(summary.created, []);
  assert.equal(summary.existing.length, 0);
  assert.deepEqual(summary.skipped, [
    {
      lens: 'security',
      key: dedupKey(validFinding),
      title: 'Egress scrub is an identity stub',
      number: null,
      reason: 'dry-run',
    },
  ]);
  assert.equal(createCalls, 0);
  assert.equal(linkCalls, 0);
  assert.deepEqual(written, summary);
});

test('runFileFindings dry-run reports an existing issue number but does not repair its link', () => {
  let linkCalls = 0;
  const summary = runFileFindings(
    {
      findings: 'findings.json',
      dryRun: true,
      handoff: false,
      repo: 'o/r',
      vendor: 'codex',
      role: 'main',
      instance: 'unknown',
      gates: 'security',
    },
    {
      readFindings: () => ({
        baseline: BASELINE,
        auditDate: '2026-07-26',
        section: 'src/lib',
        findings: [validFinding],
      }),
      verifyFindingAtBaseline: () => [],
      findExistingIssue: () => 73,
      ensureEpicLabelForFinding: () => {},
      linkFindingIssue: () => {
        linkCalls++;
        return 1932;
      },
      log: () => {},
    },
  );

  assert.deepEqual(summary.created, []);
  assert.deepEqual(summary.existing, [
    {
      lens: 'security',
      key: dedupKey(validFinding),
      title: 'Egress scrub is an identity stub',
      number: 73,
    },
  ]);
  assert.equal(linkCalls, 0);
});

test('parseEvidenceRef requires a valid trailing line or range', () => {
  assert.deepEqual(parseEvidenceRef('src/a:part.ts:12-30'), { path: 'src/a:part.ts', start: 12, end: 30 });
  assert.equal(parseEvidenceRef('src/a.ts'), null);
  assert.equal(parseEvidenceRef('src/a.ts:8-2'), null);
});

test('validateEvidenceAtBaseline proves each cited line exists at the pinned commit', () => {
  const calls = [];
  const runner = (file, args) => {
    calls.push([file, args]);
    return 'one\ntwo\n';
  };
  const errors = validateEvidenceAtBaseline(
    { files: ['src/a.ts:2'] },
    { baseline: BASELINE, repoDir: '/repo', runner },
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(calls[0][1], ['-C', '/repo', 'show', `${BASELINE}:src/a.ts`]);
  const invalid = validateEvidenceAtBaseline(
    { files: ['src/a.ts:3'] },
    { baseline: BASELINE, runner },
  );
  assert.match(invalid[0], /exceeds.*2 lines/);
});

test('issue prose uses canonical evidence and neutralizes mentions/comments', () => {
  const malicious = '@team <!-- forged marker -->';
  const body = buildBody(
    { ...validFinding, where: malicious, what: malicious },
    { baseline: BASELINE, auditDate: '2026-07-26', key: 'safe-key', sig: 'sig' },
  );
  assert.doesNotMatch(body, /<!-- forged marker/);
  assert.match(body, /@\u200bteam &lt;!-- forged marker --&gt;/);
  const comment = buildRegressionComment(validFinding, { baseline: BASELINE, auditDate: '2026-07-26', sig: 'sig' });
  assert.match(comment, /Reproduced.*origin\/master/);
});

test('findExisting returns state and prefers an open match', () => {
  const result = findExisting('k', { runner: (args) => {
    assert.ok(args.includes('number,state'));
    assert.ok(args.includes('\"audit-finding: k\" in:body,comments'));
    return JSON.stringify([{ number: 1, state: 'CLOSED' }, { number: 2, state: 'OPEN' }]);
  } });
  assert.deepEqual(result, { number: 2, state: 'OPEN' });
});

test('live routing reopens a closed matching issue with current signed evidence', () => {
  const restored = [];
  const linked = [];
  const summary = runFileFindings(
    {
      findings: 'findings.json',
      dryRun: false,
      handoff: false,
      repo: 'o/r',
      repoDir: '/repo',
      vendor: 'codex',
      role: 'main',
      instance: 'audit-1',
      gates: 'security',
    },
    {
      readFindings: () => ({
        baseline: BASELINE,
        auditDate: '2026-07-26',
        section: 'src/lib',
        findings: [validFinding],
      }),
      verifyFindingAtBaseline: () => [],
      findExistingIssue: () => ({ number: 73, state: 'CLOSED' }),
      ensureEpicLabelForFinding: () => {},
      restoreClosedFinding: (value) => restored.push(value),
      linkFindingIssue: ({ lens, childNumber, baseline }) => {
        linked.push([lensConfig(lens).epic, childNumber, baseline]);
        return lensConfig(lens).epic;
      },
      log: () => {},
    },
  );
  assert.deepEqual(summary.existing.map(({ number }) => number), [73]);
  assert.equal(restored[0].milestone, 'v0.6.0');
  assert.match(restored[0].comment, /Signed: Codex/);
  assert.deepEqual(linked, [[1932, 73, BASELINE]]);
});
