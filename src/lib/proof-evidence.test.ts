import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createProofEvidenceArtifact,
  persistProofEvidenceArtifact,
  rederiveProofAnalysis,
  verifyProofEvidenceArtifact,
  verifyProofReceiptAgainstEvidence,
  type ProofEvidenceContent,
} from './proof-evidence';

function evidenceContent(): ProofEvidenceContent {
  const pairOrder = Array.from({ length: 12 }, (_, index) => `pair-${index + 1}`);
  const runs = pairOrder.flatMap((pairId) =>
    (['control', 'injected'] as const).map((arm) => {
      const costUsd = arm === 'control' ? 10 : 8;
      return {
        runId: `${pairId}/${arm}/1`,
        pairId,
        arm,
        runIndex: 1,
        modelVersion: 'claude-test',
        startedAt: '2026-07-27T00:00:00.000Z',
        finishedAt: '2026-07-27T00:00:01.000Z',
        unresolved: false,
        unresolvedReason: null,
        decidedSuccess: true,
        gate: {
          kind: 'node-test',
          command: 'node --test',
          expectMatch: null,
          pass: true,
          exitCode: 0,
          expectedExitCode: 0,
        },
        costUsd,
        costSources: ['total_cost_usd'],
        tokenCounts: { total: costUsd * 100, perStep: [costUsd * 100] },
        wallMs: costUsd * 10,
        sessions: 1,
        stableReads: arm === 'control' ? 2 : 1,
        perStepCostUsd: [costUsd],
        workerResults: [
          {
            session: 1,
            startedAt: '2026-07-27T00:00:00.000Z',
            finishedAt: '2026-07-27T00:00:01.000Z',
            exitCode: 0,
            resultDigest: `sha256:${arm === 'control' ? 'a' : 'b'}${'0'.repeat(63)}`,
            resultType: 'result',
          },
        ],
      };
    })
  );

  return {
    schemaVersion: '1',
    experimentRef: 'proof-batch/repo-map-context-waste',
    preRegistrationRef: 'docs/v0.4-proof-preregistration.md',
    fixtureSetRef: 'repo-map-context-waste/v1',
    modelVersion: 'claude-test',
    createdAt: '2026-07-27T01:00:00.000Z',
    pairOrder,
    analysisPlan: {
      bootstrapIters: 10_000,
      bootstrapAlpha: 0.05,
      bootstrapSeed: 1,
      qualityTolerance: 0.05,
      minDecidedPairs: 12,
      minimumDetectableEffectPct: 15,
      significanceAlpha: 0.05,
      sessionsPerChain: 1,
      observedUsdPerMo: 100,
    },
    runs,
  };
}

function receiptFor(
  evidenceRef: string,
  evidenceDigest: string
): Record<string, unknown> {
  return {
    schemaVersion: '1',
    kind: 'PROOF',
    experimentRef: 'proof-batch/repo-map-context-waste',
    preRegistrationRef: 'docs/v0.4-proof-preregistration.md',
    observed: { observedUsdPerMo: 100 },
    experiment: { n: 12 },
    result: {
      effectSize: -2,
      perDimensionDeltas: { costUsd: -2, costPct: -20, latencyMs: -20 },
      statistics: {
        nDecided: 12,
        controlSuccessRate: 1,
        injectedSuccessRate: 1,
        qualityHoldPass: true,
        bootstrap: { lo: -2, hi: -2, iters: 10_000, alpha: 0.05, seed: 1 },
        wilcoxon: {
          statistic: 78,
          pOneSided: rederiveProofAnalysis(evidenceContent()).wilcoxon.pOneSided,
          n: 12,
        },
      },
      verdict: 'proven',
    },
    projection: { reclaimUsdPerMo: 20 },
    modelVersion: 'claude-test',
    evidenceRef,
    evidenceDigest,
  };
}

describe('proof evidence artifacts', () => {
  it('rederives every receipt claim from run-level evidence and verifies its digest', () => {
    const artifact = createProofEvidenceArtifact(evidenceContent());
    const analysis = rederiveProofAnalysis(artifact.content);

    expect(analysis).toMatchObject({
      nDecided: 12,
      controlSuccessRate: 1,
      injectedSuccessRate: 1,
      qualityHoldPass: true,
      medianCostDeltaUsd: -2,
      medianCostDeltaPct: -20,
      medianLatencyDeltaMs: -20,
      bootstrap: { lo: -2, hi: -2, iters: 10_000 },
      wilcoxon: { statistic: 78, n: 12 },
      verdict: 'proven',
      reclaimUsdPerMo: 20,
    });
    expect(analysis.pairs[0]).toMatchObject({
      pairId: 'pair-1',
      pairDecided: true,
      control: { nDecided: 1, nSuccess: 1, medianCostUsd: 10 },
      injected: { nDecided: 1, nSuccess: 1, medianCostUsd: 8 },
    });
    expect(verifyProofEvidenceArtifact(artifact)).toEqual({ ok: true });

    const dir = mkdtempSync(join(tmpdir(), 'proof-evidence-test-'));
    const written = persistProofEvidenceArtifact(artifact, dir);
    expect(JSON.parse(readFileSync(written.path, 'utf8'))).toEqual(artifact);

    const receipt = receiptFor(written.path, artifact.artifactDigest);
    expect(verifyProofReceiptAgainstEvidence(receipt, artifact)).toEqual({
      ok: true,
      analysis,
    });

    const receiptPath = join(dir, 'receipt.json');
    writeFileSync(receiptPath, JSON.stringify(receipt), 'utf8');
    const cli = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--import',
          './scripts/register-ts.mjs',
          'scripts/verify-proof-evidence.mjs',
          receiptPath,
        ],
        { cwd: process.cwd(), encoding: 'utf8' }
      )
    );
    expect(cli).toMatchObject({
      ok: true,
      evidenceDigest: artifact.artifactDigest,
      analysis: { nDecided: 12, verdict: 'proven' },
    });
  });

  it('fails closed when either the immutable evidence or a receipt claim is tampered', () => {
    const artifact = createProofEvidenceArtifact(evidenceContent());
    const tampered = structuredClone(artifact);
    tampered.content.runs[0].costUsd = 999;
    expect(verifyProofEvidenceArtifact(tampered)).toMatchObject({ ok: false });

    const receipt = receiptFor('evidence.json', artifact.artifactDigest);
    (receipt.experiment as { n: number }).n = 11;
    expect(verifyProofReceiptAgainstEvidence(receipt, artifact)).toMatchObject({
      ok: false,
    });
  });
});
