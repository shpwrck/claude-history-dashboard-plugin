import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  CanonicalizationError,
  canonicalDocumentJson,
  canonicalJson,
  computeBehaviorFingerprintDigest,
  computeDocumentDigest,
} from './canonical';
import type {
  ExperimentDefinition,
  ExperimentRun,
  ExperimentVerdict,
} from './types';

interface FixtureBundle {
  definition: ExperimentDefinition;
  runs: ExperimentRun[];
  verdict: ExperimentVerdict;
}

const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../../../../../fixtures/experiment-runtime/v1/valid/enrollment.claude-code.json',
      import.meta.url
    ),
    'utf8'
  )
) as FixtureBundle;

function expectCanonicalFailure(value: unknown, code: string): void {
  try {
    canonicalJson(value);
    throw new Error('expected canonicalization to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(CanonicalizationError);
    expect(error).toMatchObject({ code });
  }
}

describe('RFC 8785 canonical JSON boundary', () => {
  it('pins ECMAScript number rendering and object-key order', () => {
    expect(
      canonicalJson({
        string: '€$\u000f\nA\'B"\\"/',
        numbers: [333333333.3333333, 4.5, 0.002, 1e-27],
      })
    ).toBe(
      '{"numbers":[333333333.3333333,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\"/"}'
    );
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('preserves an own __proto__ key without a digest collision', () => {
    expect(canonicalJson(JSON.parse('{"__proto__":"a"}'))).toBe(
      '{"__proto__":"a"}'
    );
    expect(canonicalJson(JSON.parse('{"__proto__":"b"}'))).not.toBe(
      canonicalJson(JSON.parse('{"__proto__":"a"}'))
    );
  });

  it('fails closed outside the strict JSON number and value domain', () => {
    expectCanonicalFailure(-0, 'json.negative-zero');
    expectCanonicalFailure(Number.NaN, 'json.non-finite-number');
    expectCanonicalFailure(Number.POSITIVE_INFINITY, 'json.non-finite-number');
    expectCanonicalFailure(Number.MAX_SAFE_INTEGER + 1, 'json.unsafe-integer');
    expectCanonicalFailure('\ud800', 'json.lone-surrogate');
    expectCanonicalFailure(new Date(0), 'json.non-plain-object');

    const sparse: unknown[] = [];
    sparse[1] = true;
    expectCanonicalFailure(sparse, 'json.sparse-array');

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expectCanonicalFailure(cyclic, 'json.cycle');

    const namedArray = [] as unknown[] & { extra?: boolean };
    namedArray.extra = true;
    expectCanonicalFailure(namedArray, 'json.array-property');

    const symbolKeyed = { [Symbol('hidden')]: true };
    expectCanonicalFailure(symbolKeyed, 'json.symbol-key');
  });
});

describe('experiment document digest normalization', () => {
  it('pins reproducible fixture digests', () => {
    expect(fixture.definition.contentDigest).toBe(
      'sha256:e45dafb1c1ba5b172eaf1d928225f9f3de88fe1758743556de3c1ecccc0b6368'
    );
    expect(fixture.runs[0].behaviorFingerprint.digest).toBe(
      'sha256:93a01988f415b3e8eb2a669b7d518937390e85bc3cdd6b4253f19b9527181381'
    );
    expect(fixture.runs[0].contentDigest).toBe(
      'sha256:0cb843eb59fa6888fdb9c6645267aff61327113d4d59d83792d5b547e171068e'
    );
    expect(fixture.verdict.contentDigest).toBe(
      'sha256:be58da98d7f173c45df4975906a4cea776c53817d24402f6cca2f9eed19b504a'
    );
    expect(computeDocumentDigest(fixture.definition)).toBe(
      fixture.definition.contentDigest
    );
    expect(computeDocumentDigest(fixture.runs[0])).toBe(
      fixture.runs[0].contentDigest
    );
    expect(computeDocumentDigest(fixture.verdict)).toBe(
      fixture.verdict.contentDigest
    );
  });

  it('is permutation-invariant only for contract-declared set arrays', () => {
    const definition = structuredClone(fixture.definition);
    definition.requiredCapabilities.reverse();
    definition.treatments.reverse();
    definition.metrics.reverse();
    definition.checks.reverse();
    expect(computeDocumentDigest(definition)).toBe(
      fixture.definition.contentDigest
    );

    const run = structuredClone(fixture.runs[0]);
    run.behaviorFingerprint.factors.reverse();
    run.capabilitySnapshot.reverse();
    run.observations.reverse();
    run.observations[0].evidenceRefs.reverse();
    run.checkResults.reverse();
    expect(computeDocumentDigest(run)).toBe(fixture.runs[0].contentDigest);

    const verdict = structuredClone(fixture.verdict);
    verdict.evidence.includedRuns.reverse();
    verdict.evidenceBasis.satisfiedCapabilitySemantics.reverse();
    verdict.primaryEffect?.sampleCounts.reverse();
    expect(computeDocumentDigest(verdict)).toBe(fixture.verdict.contentDigest);

    const ordered = structuredClone(fixture.definition);
    ordered.extensions['fixtures/ordered-values'] = [1, 2];
    const reversed = structuredClone(ordered);
    reversed.extensions['fixtures/ordered-values'] = [2, 1];
    expect(computeDocumentDigest(ordered)).not.toBe(
      computeDocumentDigest(reversed)
    );
  });

  it('hashes the complete fingerprint except its own digest', () => {
    const fingerprint = fixture.runs[0].behaviorFingerprint;
    const reordered = structuredClone(fingerprint);
    reordered.factors.reverse();
    expect(computeBehaviorFingerprintDigest(reordered)).toBe(
      fingerprint.digest
    );

    const reobserved = structuredClone(fingerprint);
    reobserved.observedAt = '2026-07-01T12:00:00.001Z';
    expect(computeBehaviorFingerprintDigest(reobserved)).not.toBe(
      fingerprint.digest
    );

    const relabelled = structuredClone(fingerprint);
    relabelled.factors[0].displayValue = 'changed audit aid';
    expect(computeBehaviorFingerprintDigest(relabelled)).not.toBe(
      fingerprint.digest
    );
  });

  it('emits identical canonical bytes after declared permutations', () => {
    const verdict = structuredClone(fixture.verdict);
    verdict.evidence.includedRuns.reverse();
    expect(canonicalDocumentJson(verdict)).toBe(
      canonicalDocumentJson(fixture.verdict)
    );
  });
});
