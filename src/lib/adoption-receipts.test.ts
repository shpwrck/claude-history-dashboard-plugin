import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ADOPTION_RECEIPT_LINE_MAX_BYTES,
  appendAdoptionReceipt,
  adoptionWritesDisabled,
  parseAdoptionReceiptLines,
  readAdoptionReceipts,
  readAdoptionReceiptIndex,
  readRejectedFindingIds,
  sanitizeAdoptionReceipt,
} from './adoption-receipts';

const tmpDirs: string[] = [];
const now = () => new Date('2026-06-09T12:00:00.000Z');

async function makeDir() {
  const dir = await mkdtemp(join(tmpdir(), 'adoption-receipts-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('sanitizeAdoptionReceipt', () => {
  it('allowlist-drops sensitive fields from SURFACED records', () => {
    const record = sanitizeAdoptionReceipt(
      {
        kind: 'SURFACED',
        schemaVersion: '999',
        ts: '2026-06-09T11:00:00.000Z',
        sessionHash: 'sesshash',
        findingIds: ['cost.cache', 'context.reread'],
        cwd: '/secret/repo',
        promptText: 'do not persist',
        diffHunk: '@@ secret',
      },
      now
    );
    expect(record).toEqual({
      schemaVersion: '1',
      kind: 'SURFACED',
      ts: '2026-06-09T11:00:00.000Z',
      sessionHash: 'sesshash',
      findingIds: ['cost.cache', 'context.reread'],
    });
    expect(JSON.stringify(record)).not.toContain('/secret/repo');
    expect(JSON.stringify(record)).not.toContain('do not persist');
  });

  it('allowlist-drops raw config body fields from SUPPRESSED records', () => {
    const record = sanitizeAdoptionReceipt(
      {
        kind: 'SUPPRESSED',
        findingId: 'reliability.rate-limits',
        markerHeading: 'Rate-limit hygiene',
        contentFingerprint: 'sha256:abc123',
        claudeMdBody: 'raw body must never persist',
        repoPath: '/secret/repo/CLAUDE.md',
      },
      now
    );
    expect(record).toEqual({
      schemaVersion: '1',
      kind: 'SUPPRESSED',
      ts: '2026-06-09T12:00:00.000Z',
      findingId: 'reliability.rate-limits',
      markerHeading: 'Rate-limit hygiene',
      contentFingerprint: 'sha256:abc123',
    });
    expect(JSON.stringify(record)).not.toContain('raw body');
    expect(JSON.stringify(record)).not.toContain('/secret/repo');
  });

  it('fails closed for unknown kinds or missing required fields', () => {
    expect(sanitizeAdoptionReceipt({ kind: 'ADOPTED' }, now)).toBeNull();
    expect(
      sanitizeAdoptionReceipt({ kind: 'SURFACED', sessionHash: 's' }, now)
    ).toBeNull();
    expect(
      sanitizeAdoptionReceipt({ kind: 'SUPPRESSED', findingId: 'f' }, now)
    ).toBeNull();
  });
});

// The efficacy half (#1074) ADR 0005 deferred: a completed matched-pair
// experiment serialized as a PROOF receipt beside the SURFACED/SUPPRESSED
// adoption receipts (see docs/v0.4-proof-engine.md, "The proof receipt").
describe('sanitizeAdoptionReceipt PROOF (#1074)', () => {
  function proofInput(
    overrides: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      kind: 'PROOF',
      ts: '2026-06-09T11:00:00.000Z',
      experimentRef: 'exp-890-repo-map',
      preRegistrationRef: 'sha:prereg0',
      observed: {
        wastePattern: 'repo-map re-walk on every session',
        detectorRef: 'cost.repo-map',
        observedUsdPerMo: 412.5,
      },
      experiment: {
        fixtureSetRef: 'fixtures:v1',
        design: 'matched-pairs',
        arm: 'injected',
        n: 6,
        objectiveGates: ['tokens-to-green', 'quality-holds'],
      },
      result: {
        effectSize: -0.31,
        uncertainty: 'bootstrap CI [-0.45, -0.18], Wilcoxon p=0.01',
        perDimensionDeltas: { cost: -0.31, latency: -0.08 },
        statistics: {
          nDecided: 12,
          controlSuccessRate: 1,
          injectedSuccessRate: 1,
          qualityHoldPass: true,
          bootstrap: {
            lo: -0.45,
            hi: -0.18,
            iters: 10_000,
            alpha: 0.05,
            seed: 1,
          },
          wilcoxon: { statistic: 78, pOneSided: 0.01, n: 12 },
        },
        verdict: 'proven',
      },
      projection: {
        reclaimUsdPerMo: 380,
        assumptions: 'fixtures->history bridge is an extrapolation',
      },
      rollout: 'Inject the repo-map recommendation at session start.',
      externalReviewRef: 'review:1078-pending',
      modelVersion: 'claude-opus-4-8',
      revalidationStatus: 'current',
      evidenceRef: 'data/proof-evidence/sha256-abc.json',
      evidenceDigest:
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      ...overrides,
    };
  }

  it('round-trips a PROOF receipt with all fields preserved and stamps schemaVersion', () => {
    const record = sanitizeAdoptionReceipt(proofInput(), now);
    expect(record).toEqual({
      schemaVersion: '1',
      kind: 'PROOF',
      ts: '2026-06-09T11:00:00.000Z',
      experimentRef: 'exp-890-repo-map',
      preRegistrationRef: 'sha:prereg0',
      observed: {
        wastePattern: 'repo-map re-walk on every session',
        detectorRef: 'cost.repo-map',
        observedUsdPerMo: 412.5,
      },
      experiment: {
        fixtureSetRef: 'fixtures:v1',
        design: 'matched-pairs',
        arm: 'injected',
        n: 6,
        objectiveGates: ['tokens-to-green', 'quality-holds'],
      },
      result: {
        effectSize: -0.31,
        uncertainty: 'bootstrap CI [-0.45, -0.18], Wilcoxon p=0.01',
        perDimensionDeltas: { cost: -0.31, latency: -0.08 },
        statistics: {
          nDecided: 12,
          controlSuccessRate: 1,
          injectedSuccessRate: 1,
          qualityHoldPass: true,
          bootstrap: {
            lo: -0.45,
            hi: -0.18,
            iters: 10_000,
            alpha: 0.05,
            seed: 1,
          },
          wilcoxon: { statistic: 78, pOneSided: 0.01, n: 12 },
        },
        verdict: 'proven',
      },
      projection: {
        reclaimUsdPerMo: 380,
        assumptions: 'fixtures->history bridge is an extrapolation',
      },
      rollout: 'Inject the repo-map recommendation at session start.',
      externalReviewRef: 'review:1078-pending',
      modelVersion: 'claude-opus-4-8',
      revalidationStatus: 'current',
      evidenceRef: 'data/proof-evidence/sha256-abc.json',
      evidenceDigest:
        'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
  });

  it('fails closed when only one evidence binding field is present or the digest is malformed', () => {
    expect(
      sanitizeAdoptionReceipt(
        proofInput({ evidenceDigest: undefined }),
        now
      )
    ).toBeNull();
    expect(
      sanitizeAdoptionReceipt(
        proofInput({ evidenceRef: undefined }),
        now
      )
    ).toBeNull();
    expect(
      sanitizeAdoptionReceipt(
        proofInput({ evidenceDigest: 'sha256:not-a-digest' }),
        now
      )
    ).toBeNull();
  });

  it('continues to read historical PROOF receipts created before evidence bindings', () => {
    const legacy = proofInput();
    delete legacy.evidenceRef;
    delete legacy.evidenceDigest;
    const record = sanitizeAdoptionReceipt(legacy, now);
    expect(record?.kind).toBe('PROOF');
    expect(record).not.toHaveProperty('evidenceRef');
    expect(record).not.toHaveProperty('evidenceDigest');
  });

  it('refuses to append a new PROOF claim without its evidence binding', async () => {
    const legacy = proofInput();
    delete legacy.evidenceRef;
    delete legacy.evidenceDigest;
    const dir = await makeDir();
    const result = await appendAdoptionReceipt(
      join(dir, 'proof.jsonl'),
      legacy,
      { env: {}, shadowCallsDir: join(dir, 'shadow-calls') }
    );
    expect(result).toEqual({
      ok: false,
      status: 400,
      error:
        'New PROOF receipts require evidenceRef, evidenceDigest, and structured statistics',
    });
  });

  it('allowlist-drops fields not on the PROOF schema', () => {
    const record = sanitizeAdoptionReceipt(
      proofInput({ cwd: '/secret/repo', promptText: 'do not persist' }),
      now
    );
    expect(JSON.stringify(record)).not.toContain('/secret/repo');
    expect(JSON.stringify(record)).not.toContain('do not persist');
  });

  it('represents a null-verdict (scientific null) receipt', () => {
    const record = sanitizeAdoptionReceipt(
      proofInput({
        result: {
          effectSize: 0.01,
          uncertainty: 'CI spans zero; below MDE',
          perDimensionDeltas: {},
          verdict: 'null',
        },
      }),
      now
    );
    expect(record).not.toBeNull();
    expect((record as { kind: string }).kind).toBe('PROOF');
    expect(
      (record as { result: { verdict: string } }).result.verdict
    ).toBe('null');
  });

  it('accepts each allowed verdict and rejects an invalid one', () => {
    for (const verdict of ['proven', 'null', 'refuted']) {
      const record = sanitizeAdoptionReceipt(
        proofInput({
          result: {
            effectSize: 0,
            uncertainty: 'u',
            perDimensionDeltas: {},
            verdict,
          },
        }),
        now
      );
      expect(record).not.toBeNull();
    }
    expect(
      sanitizeAdoptionReceipt(
        proofInput({
          result: {
            effectSize: 0,
            uncertainty: 'u',
            perDimensionDeltas: {},
            verdict: 'inconclusive',
          },
        }),
        now
      )
    ).toBeNull();
  });

  it('rejects an invalid arm, design, or revalidation status', () => {
    expect(
      sanitizeAdoptionReceipt(
        proofInput({
          experiment: {
            fixtureSetRef: 'fixtures:v1',
            design: 'matched-pairs',
            arm: 'control',
            n: 6,
            objectiveGates: [],
          },
        }),
        now
      )
    ).toBeNull();
    expect(
      sanitizeAdoptionReceipt(
        proofInput({
          experiment: {
            fixtureSetRef: 'fixtures:v1',
            design: 'between-subjects',
            arm: 'injected',
            n: 6,
            objectiveGates: [],
          },
        }),
        now
      )
    ).toBeNull();
    expect(
      sanitizeAdoptionReceipt(proofInput({ revalidationStatus: 'fresh' }), now)
    ).toBeNull();
  });

  it('fails closed when a required nested field is missing or non-finite', () => {
    expect(
      sanitizeAdoptionReceipt(proofInput({ experimentRef: '' }), now)
    ).toBeNull();
    expect(
      sanitizeAdoptionReceipt(proofInput({ observed: {} }), now)
    ).toBeNull();
    expect(
      sanitizeAdoptionReceipt(
        proofInput({
          observed: {
            wastePattern: 'p',
            detectorRef: 'd',
            observedUsdPerMo: Infinity,
          },
        }),
        now
      )
    ).toBeNull();
  });

  it('drops a PROOF receipt whose bounded text field is oversized', () => {
    expect(
      sanitizeAdoptionReceipt(
        proofInput({ rollout: 'x'.repeat(2001) }),
        now
      )
    ).toBeNull();
  });

  it('round-trips a PROOF receipt through the shared parse primitive', () => {
    const raw = JSON.stringify(proofInput());
    const { receipts, skipped } = parseAdoptionReceiptLines(raw, now);
    expect(skipped).toBe(0);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].kind).toBe('PROOF');
  });
});

describe('appendAdoptionReceipt', () => {
  it('appends JSONL records without rewriting prior entries', async () => {
    const dir = await makeDir();
    const file = join(dir, 'adoption-receipts.jsonl');
    const env = { SHADOW_CALLS_OFF: undefined };
    const shadowCallsDir = join(dir, 'shadow-calls');

    const first = await appendAdoptionReceipt(
      file,
      { kind: 'SURFACED', sessionHash: 's1', findingIds: ['f1'] },
      { now, env, shadowCallsDir }
    );
    const second = await appendAdoptionReceipt(
      file,
      {
        kind: 'SUPPRESSED',
        findingId: 'f1',
        markerHeading: 'Heading',
        contentFingerprint: 'hash',
      },
      { now, env, shadowCallsDir }
    );

    expect(first.ok && first.written).toBe(true);
    expect(second.ok && second.written).toBe(true);
    const lines = (await readFile(file, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toMatchObject({ kind: 'SURFACED' });
    expect(JSON.parse(lines[1])).toMatchObject({ kind: 'SUPPRESSED' });
  });

  it('writes nothing when the shared shadow-calls killswitch is disabled', async () => {
    const dir = await makeDir();
    const file = join(dir, 'adoption-receipts.jsonl');

    const viaEnv = await appendAdoptionReceipt(
      file,
      { kind: 'SURFACED', sessionHash: 's1', findingIds: ['f1'] },
      { now, env: { SHADOW_CALLS_OFF: '1' }, shadowCallsDir: join(dir, 'sc') }
    );
    expect(viaEnv).toEqual({ ok: true, written: false, disabled: true });

    const shadowCallsDir = join(dir, 'shadow-calls');
    await mkdir(shadowCallsDir, { recursive: true });
    await writeFile(join(shadowCallsDir, 'OFF'), '');
    expect(adoptionWritesDisabled({ env: {}, shadowCallsDir })).toBe(true);
    const viaSentinel = await appendAdoptionReceipt(
      file,
      { kind: 'SURFACED', sessionHash: 's1', findingIds: ['f1'] },
      { now, env: {}, shadowCallsDir }
    );
    expect(viaSentinel).toEqual({ ok: true, written: false, disabled: true });
  });
});

describe('readAdoptionReceiptIndex (#576)', () => {
  it('returns an empty index when the file is missing', async () => {
    const dir = await makeDir();
    const index = await readAdoptionReceiptIndex(
      join(dir, 'does-not-exist.jsonl')
    );
    expect(index.surfacedFindingIds.size).toBe(0);
    expect(index.suppressedFindingIds.size).toBe(0);
  });

  it('indexes surfaced + suppressed finding ids and skips malformed lines', async () => {
    const dir = await makeDir();
    const file = join(dir, 'adoption-receipts.jsonl');
    const lines = [
      JSON.stringify({
        kind: 'SURFACED',
        ts: '2026-06-09T11:00:00.000Z',
        sessionHash: 's1',
        findingIds: ['cost.a', 'reliability.b'],
      }),
      '', // blank line, skipped
      'not json at all', // malformed, skipped
      JSON.stringify({ kind: 'SURFACED' }), // invalid (no sessionHash), dropped
      JSON.stringify({
        kind: 'SUPPRESSED',
        ts: '2026-06-09T12:00:00.000Z',
        findingId: 'cost.a',
        markerHeading: 'Cache policy',
        contentFingerprint: 'sha256:deadbeef',
      }),
    ].join('\n');
    await writeFile(file, `${lines}\n`);

    const index = await readAdoptionReceiptIndex(file);
    expect([...index.surfacedFindingIds].sort()).toEqual([
      'cost.a',
      'reliability.b',
    ]);
    expect([...index.suppressedFindingIds]).toEqual(['cost.a']);
  });

  it('indexes later receipts after skipping an over-limit JSONL line', async () => {
    const dir = await makeDir();
    const file = join(dir, 'adoption-receipts.jsonl');
    await writeFile(
      file,
      [
        JSON.stringify({
          kind: 'SURFACED',
          ts: '2026-06-09T11:00:00.000Z',
          sessionHash: 's1',
          findingIds: ['cost.a'],
        }),
        JSON.stringify({
          kind: 'SURFACED',
          sessionHash: 'too-large',
          findingIds: ['x'.repeat(ADOPTION_RECEIPT_LINE_MAX_BYTES)],
        }),
        JSON.stringify({
          kind: 'SUPPRESSED',
          ts: '2026-06-09T12:00:00.000Z',
          findingId: 'cost.a',
          markerHeading: 'Cache policy',
          contentFingerprint: 'sha256:deadbeef',
        }),
      ].join('\n') + '\n'
    );

    const index = await readAdoptionReceiptIndex(file);
    expect([...index.surfacedFindingIds]).toEqual(['cost.a']);
    expect([...index.suppressedFindingIds]).toEqual(['cost.a']);
  });

  it('reopens a suppressed finding after a newer surface and re-closes it on the next suppression', async () => {
    const dir = await makeDir();
    const file = join(dir, 'adoption-receipts.jsonl');
    const surface = (ts: string, sessionHash: string) => ({
      kind: 'SURFACED',
      ts,
      sessionHash,
      findingIds: ['workflow.shadow-prompt'],
    });
    const suppression = (ts: string) => ({
      kind: 'SUPPRESSED',
      ts,
      findingId: 'workflow.shadow-prompt',
      markerHeading: 'Winning prompt framing',
      contentFingerprint: `sha256:${ts}`,
    });
    const reopened = [
      surface('2026-07-01T00:00:00.000Z', 's1'),
      suppression('2026-07-02T00:00:00.000Z'),
      surface('2026-07-03T00:00:00.000Z', 's3'),
    ];
    await writeFile(file, `${reopened.map((record) => JSON.stringify(record)).join('\n')}\n`);

    let index = await readAdoptionReceiptIndex(file);
    expect(index.surfacedFindingIds.has('workflow.shadow-prompt')).toBe(true);
    expect(index.suppressedFindingIds.has('workflow.shadow-prompt')).toBe(false);

    await writeFile(
      file,
      `${[...reopened, suppression('2026-07-04T00:00:00.000Z')]
        .map((record) => JSON.stringify(record))
        .join('\n')}\n`
    );
    index = await readAdoptionReceiptIndex(file);
    expect(index.suppressedFindingIds.has('workflow.shadow-prompt')).toBe(true);
  });

  it('uses append order only to break equal receipt timestamps', async () => {
    const dir = await makeDir();
    const file = join(dir, 'adoption-receipts.jsonl');
    const surface = {
      kind: 'SURFACED',
      ts: '2026-07-01T00:00:00.000Z',
      sessionHash: 'same-ts',
      findingIds: ['ordinary.finding'],
    };
    const suppression = {
      kind: 'SUPPRESSED',
      ts: '2026-07-01T00:00:00.000Z',
      findingId: 'ordinary.finding',
      markerHeading: 'Ordinary',
      contentFingerprint: 'sha256:same-ts',
    };

    await writeFile(file, `${JSON.stringify(surface)}\n${JSON.stringify(suppression)}\n`);
    expect(
      (await readAdoptionReceiptIndex(file)).suppressedFindingIds.has('ordinary.finding')
    ).toBe(true);

    await writeFile(file, `${JSON.stringify(suppression)}\n${JSON.stringify(surface)}\n`);
    expect(
      (await readAdoptionReceiptIndex(file)).suppressedFindingIds.has('ordinary.finding')
    ).toBe(false);
  });

  it('does not let a delayed older surface reopen a newer suppression', async () => {
    const dir = await makeDir();
    const file = join(dir, 'adoption-receipts.jsonl');
    await writeFile(
      file,
      [
        {
          kind: 'SURFACED',
          ts: '2026-07-01T00:00:00.000Z',
          sessionHash: 's1',
          findingIds: ['ordinary.finding'],
        },
        {
          kind: 'SUPPRESSED',
          ts: '2026-07-03T00:00:00.000Z',
          findingId: 'ordinary.finding',
          markerHeading: 'Ordinary',
          contentFingerprint: 'sha256:newer',
        },
        {
          kind: 'SURFACED',
          ts: '2026-07-02T00:00:00.000Z',
          sessionHash: 'delayed',
          findingIds: ['ordinary.finding'],
        },
      ].map((record) => JSON.stringify(record)).join('\n') + '\n'
    );

    const index = await readAdoptionReceiptIndex(file);
    expect(index.suppressedFindingIds.has('ordinary.finding')).toBe(true);
  });

  it('does not let an invalid or far-future surface reopen a valid suppression', async () => {
    const dir = await makeDir();
    const file = join(dir, 'adoption-receipts.jsonl');
    await writeFile(
      file,
      [
        {
          kind: 'SURFACED',
          ts: '2026-07-01T00:00:00.000Z',
          sessionHash: 'valid-surface',
          findingIds: ['ordinary.finding'],
        },
        {
          kind: 'SUPPRESSED',
          ts: '2026-07-03T00:00:00.000Z',
          findingId: 'ordinary.finding',
          markerHeading: 'Ordinary',
          contentFingerprint: 'sha256:valid-suppression',
        },
        {
          kind: 'SURFACED',
          ts: 'not-a-timestamp',
          sessionHash: 'invalid-time',
          findingIds: ['ordinary.finding'],
        },
        {
          kind: 'SURFACED',
          ts: '9999-01-01T00:00:00.000Z',
          sessionHash: 'future-time',
          findingIds: ['ordinary.finding'],
        },
      ].map((record) => JSON.stringify(record)).join('\n') + '\n'
    );

    const index = await readAdoptionReceiptIndex(file);
    expect(index.surfacedFindingIds.has('ordinary.finding')).toBe(true);
    expect(index.suppressedFindingIds.has('ordinary.finding')).toBe(true);
  });

  it('ignores REJECTED receipts — the suppression-transition index is untouched (#2206)', async () => {
    const dir = await makeDir();
    const file = join(dir, 'adoption-receipts.jsonl');
    await writeFile(
      file,
      JSON.stringify({
        kind: 'REJECTED',
        ts: '2026-06-09T12:00:00.000Z',
        findingId: 'cost.a',
        reason: 'wrong',
      }) + '\n'
    );
    const index = await readAdoptionReceiptIndex(file);
    expect(index.surfacedFindingIds.size).toBe(0);
    expect(index.suppressedFindingIds.size).toBe(0);
  });
});

describe('sanitizeAdoptionReceipt REJECTED (#2206)', () => {
  it('normalizes a valid reject and defaults active to true', () => {
    expect(
      sanitizeAdoptionReceipt(
        { kind: 'REJECTED', findingId: 'cost.a', reason: 'wrong' },
        now
      )
    ).toEqual({
      schemaVersion: '1',
      kind: 'REJECTED',
      ts: '2026-06-09T12:00:00.000Z',
      findingId: 'cost.a',
      reason: 'wrong',
      active: true,
    });
  });

  it('records an un-reject when active is explicitly false', () => {
    const rec = sanitizeAdoptionReceipt(
      { kind: 'REJECTED', findingId: 'cost.a', reason: 'dismiss', active: false },
      now
    );
    expect(rec).toMatchObject({ kind: 'REJECTED', findingId: 'cost.a', active: false });
  });

  it('rejects an unknown reason or a missing findingId', () => {
    expect(
      sanitizeAdoptionReceipt({ kind: 'REJECTED', findingId: 'x', reason: 'nope' }, now)
    ).toBeNull();
    expect(
      sanitizeAdoptionReceipt({ kind: 'REJECTED', reason: 'wrong' }, now)
    ).toBeNull();
  });
});

describe('readRejectedFindingIds (#2206)', () => {
  it('returns an empty set when the file is missing', async () => {
    const dir = await makeDir();
    const rejected = await readRejectedFindingIds(join(dir, 'nope.jsonl'));
    expect(rejected.size).toBe(0);
  });

  it('includes actively-rejected findings and skips malformed lines', async () => {
    const dir = await makeDir();
    const file = join(dir, 'adoption-receipts.jsonl');
    await writeFile(
      file,
      [
        JSON.stringify({ kind: 'REJECTED', ts: '2026-06-09T11:00:00.000Z', findingId: 'cost.a', reason: 'wrong' }),
        'not json', // skipped
        JSON.stringify({ kind: 'REJECTED', ts: '2026-06-09T11:00:00.000Z', findingId: 'reliability.b', reason: 'not-relevant' }),
        // a SURFACED receipt is not a reject → ignored
        JSON.stringify({ kind: 'SURFACED', ts: '2026-06-09T11:00:00.000Z', sessionHash: 's', findingIds: ['x'] }),
      ].join('\n') + '\n'
    );
    expect([...(await readRejectedFindingIds(file))].sort()).toEqual(['cost.a', 'reliability.b']);
  });

  it('un-rejecting restores a finding — the latest receipt per finding wins', async () => {
    const dir = await makeDir();
    const file = join(dir, 'adoption-receipts.jsonl');
    await writeFile(
      file,
      [
        JSON.stringify({ kind: 'REJECTED', ts: '2026-06-09T11:00:00.000Z', findingId: 'cost.a', reason: 'wrong' }),
        // later un-reject → cost.a restored (dropped from the set)
        JSON.stringify({ kind: 'REJECTED', ts: '2026-06-09T12:00:00.000Z', findingId: 'cost.a', reason: 'wrong', active: false }),
        JSON.stringify({ kind: 'REJECTED', ts: '2026-06-09T11:30:00.000Z', findingId: 'reliability.b', reason: 'dismiss' }),
      ].join('\n') + '\n'
    );
    expect([...(await readRejectedFindingIds(file))]).toEqual(['reliability.b']);
  });

  it('a later re-reject after an un-reject suppresses again', async () => {
    const dir = await makeDir();
    const file = join(dir, 'adoption-receipts.jsonl');
    await writeFile(
      file,
      [
        JSON.stringify({ kind: 'REJECTED', ts: '2026-06-09T11:00:00.000Z', findingId: 'cost.a', reason: 'wrong', active: false }),
        JSON.stringify({ kind: 'REJECTED', ts: '2026-06-09T12:00:00.000Z', findingId: 'cost.a', reason: 'wrong', active: true }),
      ].join('\n') + '\n'
    );
    expect([...(await readRejectedFindingIds(file))]).toEqual(['cost.a']);
  });
});

// The single canonical read-side parse->sanitize loop (#1003). Every consumer
// (index reader, spool drain, server read route) delegates to it, so the
// fail-closed allowlist drop has exactly one source of truth.
describe('parseAdoptionReceiptLines (#1003)', () => {
  const oversized = 'x'.repeat(200); // exceeds MAX_ID_LEN (160)

  it('skips a malformed line, ignores blank lines, and keeps valid receipts', () => {
    const raw = [
      '', // blank, ignored (not counted as skipped)
      '   ', // whitespace-only, ignored
      '{not valid json', // malformed, skipped
      JSON.stringify({
        kind: 'SURFACED',
        ts: '2026-06-09T11:00:00.000Z',
        sessionHash: 's1',
        findingIds: ['cost.a'],
      }),
      JSON.stringify({
        kind: 'SUPPRESSED',
        ts: '2026-06-09T12:00:00.000Z',
        findingId: 'cost.a',
        markerHeading: 'Cache policy',
        contentFingerprint: 'sha256:deadbeef',
      }),
    ].join('\n');

    const { receipts, skipped } = parseAdoptionReceiptLines(raw, now);
    expect(receipts).toHaveLength(2);
    expect(receipts[0].kind).toBe('SURFACED');
    expect(receipts[1].kind).toBe('SUPPRESSED');
    // Only the malformed JSON line counts as skipped; blank lines are ignored.
    expect(skipped).toBe(1);
  });

  it('rejects missing and invalid persisted timestamps instead of restamping them', () => {
    const raw = [
      JSON.stringify({
        kind: 'SURFACED',
        sessionHash: 'missing-time',
        findingIds: ['cost.a'],
      }),
      JSON.stringify({
        kind: 'SURFACED',
        ts: 'not-a-timestamp',
        sessionHash: 'invalid-time',
        findingIds: ['cost.b'],
      }),
    ].join('\n');

    const firstRead = parseAdoptionReceiptLines(raw, now);
    const laterRead = parseAdoptionReceiptLines(
      raw,
      () => new Date('2026-06-10T12:00:00.000Z')
    );
    expect(firstRead).toEqual({ receipts: [], skipped: 2 });
    expect(laterRead).toEqual(firstRead);
  });

  it('accepts bounded clock skew but rejects timestamps beyond it', () => {
    const record = (ts: string) =>
      JSON.stringify({
        kind: 'SURFACED',
        ts,
        sessionHash: ts,
        findingIds: ['cost.a'],
      });
    const raw = [
      record('2026-06-09T12:05:00.000Z'),
      record('2026-06-09T12:05:00.001Z'),
    ].join('\n');

    const { receipts, skipped } = parseAdoptionReceiptLines(raw, now);
    expect(receipts.map((receipt) => receipt.ts)).toEqual([
      '2026-06-09T12:05:00.000Z',
    ]);
    expect(skipped).toBe(1);
  });

  it('uses one timestamp boundary for the whole in-memory replay', () => {
    const raw = [
      JSON.stringify({
        kind: 'SURFACED',
        ts: '2026-06-09T12:00:00.000Z',
        sessionHash: 'one',
        findingIds: ['cost.a'],
      }),
      JSON.stringify({
        kind: 'SURFACED',
        ts: '2026-06-09T12:00:01.000Z',
        sessionHash: 'two',
        findingIds: ['cost.b'],
      }),
    ].join('\n');
    let clockReads = 0;

    const result = parseAdoptionReceiptLines(raw, () => {
      clockReads += 1;
      return new Date('2026-06-09T12:00:00.000Z');
    });

    expect(result.receipts).toHaveLength(2);
    expect(clockReads).toBe(1);
  });

  it('drops a receipt whose field is oversized (fail-closed allowlist)', () => {
    const raw = [
      JSON.stringify({
        kind: 'SURFACED',
        ts: '2026-06-09T11:00:00.000Z',
        sessionHash: oversized, // over MAX_ID_LEN -> sanitizes to null
        findingIds: ['cost.a'],
      }),
      JSON.stringify({
        kind: 'SURFACED',
        ts: '2026-06-09T11:00:00.000Z',
        sessionHash: 's-ok',
        findingIds: ['cost.b'],
      }),
    ].join('\n');

    const { receipts, skipped } = parseAdoptionReceiptLines(raw, now);
    expect(receipts).toHaveLength(1);
    expect((receipts[0] as { sessionHash: string }).sessionHash).toBe('s-ok');
    expect(skipped).toBe(1);
  });

  it('skips over-limit lines before JSON parsing and keeps later receipts', () => {
    const raw = [
      JSON.stringify({
        kind: 'SURFACED',
        sessionHash: 'too-large',
        findingIds: ['x'.repeat(ADOPTION_RECEIPT_LINE_MAX_BYTES)],
      }),
      JSON.stringify({
        kind: 'SURFACED',
        ts: '2026-06-09T11:00:00.000Z',
        sessionHash: 's-ok',
        findingIds: ['cost.b'],
      }),
    ].join('\n');

    const { receipts, skipped } = parseAdoptionReceiptLines(raw, now);
    expect(receipts).toHaveLength(1);
    expect((receipts[0] as { sessionHash: string }).sessionHash).toBe('s-ok');
    expect(skipped).toBe(1);
  });

  it('returns an empty result for empty input', () => {
    expect(parseAdoptionReceiptLines('', now)).toEqual({
      receipts: [],
      skipped: 0,
    });
  });
});

describe('readAdoptionReceipts (#1003)', () => {
  it('returns an empty result when the file is missing', async () => {
    const dir = await makeDir();
    const result = await readAdoptionReceipts(
      join(dir, 'does-not-exist.jsonl')
    );
    expect(result).toEqual({ receipts: [], skipped: 0 });
  });

  it('uses one timestamp boundary for the whole streamed replay', async () => {
    const dir = await makeDir();
    const file = join(dir, 'adoption-receipts.jsonl');
    await writeFile(
      file,
      [
        JSON.stringify({
          kind: 'SURFACED',
          ts: '2026-06-09T12:00:00.000Z',
          sessionHash: 'one',
          findingIds: ['cost.a'],
        }),
        JSON.stringify({
          kind: 'SURFACED',
          ts: '2026-06-09T12:00:01.000Z',
          sessionHash: 'two',
          findingIds: ['cost.b'],
        }),
      ].join('\n') + '\n'
    );
    let clockReads = 0;

    const result = await readAdoptionReceipts(file, () => {
      clockReads += 1;
      return new Date('2026-06-09T12:00:00.000Z');
    });

    expect(result.receipts).toHaveLength(2);
    expect(clockReads).toBe(1);
  });

  it('reads + sanitizes the log through the shared primitive', async () => {
    const dir = await makeDir();
    const file = join(dir, 'adoption-receipts.jsonl');
    const lines = [
      'not json', // malformed, skipped
      JSON.stringify({
        kind: 'SURFACED',
        ts: '2026-06-09T11:00:00.000Z',
        sessionHash: 's1',
        findingIds: ['cost.a'],
      }),
    ].join('\n');
    await writeFile(file, `${lines}\n`);

    const { receipts, skipped } = await readAdoptionReceipts(file, now);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].kind).toBe('SURFACED');
    expect(skipped).toBe(1);
  });

  it('streams past a multi-chunk over-limit line without parsing it', async () => {
    const dir = await makeDir();
    const file = join(dir, 'adoption-receipts.jsonl');
    const valid = JSON.stringify({
      kind: 'SURFACED',
      ts: '2026-06-09T11:00:00.000Z',
      sessionHash: 's-ok',
      findingIds: ['cost.b'],
    });
    await writeFile(
      file,
      `${'x'.repeat(ADOPTION_RECEIPT_LINE_MAX_BYTES * 3)}\n${valid}\n`
    );

    const { receipts, skipped } = await readAdoptionReceipts(file, now);
    expect(receipts).toHaveLength(1);
    expect((receipts[0] as { sessionHash: string }).sessionHash).toBe('s-ok');
    expect(skipped).toBe(1);
  });

  it('tail-bounds reads without parsing a partial leading line', async () => {
    const dir = await makeDir();
    const file = join(dir, 'adoption-receipts.jsonl');
    const older = JSON.stringify({
      kind: 'SURFACED',
      ts: '2026-06-09T10:00:00.000Z',
      sessionHash: 'older-session-hash',
      findingIds: ['older.finding'],
    });
    const latest = JSON.stringify({
      kind: 'SUPPRESSED',
      ts: '2026-06-09T12:00:00.000Z',
      findingId: 'latest.finding',
      markerHeading: 'Latest heading',
      contentFingerprint: 'sha256:latest',
      rawSecret: 'must still be allowlist-dropped',
    });
    await writeFile(file, `${older}\n${latest}\n`);

    const { receipts, skipped } = await readAdoptionReceipts(file, {
      now,
      maxBytes: Buffer.byteLength(latest, 'utf8') + 8,
    });
    expect(receipts).toEqual([
      {
        schemaVersion: '1',
        kind: 'SUPPRESSED',
        ts: '2026-06-09T12:00:00.000Z',
        findingId: 'latest.finding',
        markerHeading: 'Latest heading',
        contentFingerprint: 'sha256:latest',
      },
    ]);
    expect(JSON.stringify(receipts)).not.toContain('rawSecret');
    expect(skipped).toBe(0);
  });
});
