import { readFileSync } from 'node:fs';

import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';

import {
  decodeDefinitionV1,
  decodeRunV1,
  decodeVerdictV1,
} from './codec';
import {
  withBehaviorFingerprintDigest,
  withDocumentDigest,
} from './canonical';
import {
  EXPERIMENT_CONTRACT_SCHEMAS_V1,
  validateContractSchema,
  validateRegistrySchema,
} from './schema';
import type {
  ContractRegistryV1,
  DefinitionDecodeContextV1,
  RunDecodeContextV1,
  SelectionReceiptBindingV1,
  TriggerReceiptBindingV1,
  ValidatedExperimentRunV1,
  VerdictDecodeContextV1,
} from './codec';
import type {
  ExperimentDefinition,
  ExperimentDocument,
  ExperimentRun,
  ExperimentVerdict,
  JsonValue,
} from './types';

interface FixtureManifest {
  schemaVersion: 1;
  valid: Array<{
    flow: string;
    harness: string;
    path: string;
    runCount: number;
    verdictCount: number;
  }>;
  invalid: Array<{ name: string; expectedCode: string }>;
  corrections: { path: string; validCount: number; invalidCount: number };
}

interface FixtureBundle {
  flow: string;
  harness: string;
  registry: ContractRegistryV1;
  definition: ExperimentDefinition;
  selectionReceipts: SelectionReceiptBindingV1[];
  triggerReceipts: TriggerReceiptBindingV1[];
  operatorSafeguardAuthorizations: [];
  runs: ExperimentRun[];
  verdict: ExperimentVerdict;
}

interface Mutation {
  op: 'add' | 'remove' | 'replace' | 'copy-run-ref';
  path: string;
  from?: string;
  value?: JsonValue | { $special: 'negative-zero' };
}

interface InvalidCase {
  name: string;
  contract: 'definition' | 'run' | 'verdict';
  base: string;
  target: string;
  recompute: 'none' | 'document';
  expectedCode: string;
  mutations: Mutation[];
}

interface VerdictCorrectionFixture {
  base: string;
  valid: ExperimentVerdict;
  invalid: Array<{
    name: string;
    expectedCode: string;
    verdict: ExperimentVerdict;
  }>;
}

const FIXTURE_ROOT = new URL(
  '../../../../../fixtures/experiment-runtime/v1/',
  import.meta.url
);

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(new URL(path, FIXTURE_ROOT), 'utf8')) as T;
}

function pointerSegments(path: string): string[] {
  if (!path.startsWith('/')) throw new Error(`invalid fixture pointer ${path}`);
  return path
    .slice(1)
    .split('/')
    .map((value) => value.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function atPointer(root: unknown, path: string): unknown {
  let current = root;
  for (const segment of pointerSegments(path)) {
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function materializeInvalid(
  fixture: InvalidCase
): { bundle: FixtureBundle; document: unknown } {
  const bundle = readJson<FixtureBundle>(fixture.base);
  let document = structuredClone(atPointer(bundle, fixture.target));
  for (const mutation of fixture.mutations) {
    const segments = pointerSegments(mutation.path);
    const key = segments.pop();
    if (key === undefined) throw new Error('fixture mutation targets root');
    let parent = document as Record<string, unknown>;
    for (const segment of segments) {
      parent = parent[segment] as Record<string, unknown>;
    }
    if (mutation.op === 'remove') {
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
      continue;
    }
    let value: unknown = mutation.value;
    if (
      value !== null &&
      typeof value === 'object' &&
      '$special' in value &&
      value.$special === 'negative-zero'
    ) {
      value = -0;
    }
    if (mutation.op === 'copy-run-ref') {
      const source = atPointer(bundle, mutation.from ?? '');
      const run = source as ExperimentRun;
      value = { runId: run.runId, contentDigest: run.contentDigest };
    }
    parent[key] = value;
  }
  if (fixture.recompute === 'document') {
    document = withDocumentDigest(document as ExperimentDocument);
  }
  return { bundle, document };
}

function issueCodes(result: { ok: boolean; issues?: readonly { code: string }[] }) {
  return result.ok ? [] : (result.issues ?? []).map((issue) => issue.code);
}

function decodeBundleRuns(
  bundle: FixtureBundle,
  count = bundle.runs.length
): ValidatedExperimentRunV1[] {
  const runs: ValidatedExperimentRunV1[] = [];
  for (const input of bundle.runs.slice(0, count)) {
    const result = decodeRunV1(input, {
      definition: bundle.definition,
      registry: bundle.registry,
      selectionReceipts: bundle.selectionReceipts,
      triggerReceipts: bundle.triggerReceipts,
      operatorSafeguardAuthorizations:
        bundle.operatorSafeguardAuthorizations,
      priorRuns: runs,
    });
    if (!result.ok) {
      throw new Error(`fixture Run failed decoding: ${JSON.stringify(result.issues)}`);
    }
    runs.push(result.value);
  }
  return runs;
}

function documentKind(contract: InvalidCase['contract']) {
  if (contract === 'definition') return 'ExperimentDefinition' as const;
  if (contract === 'run') return 'ExperimentRun' as const;
  return 'ExperimentVerdict' as const;
}

const manifest = readJson<FixtureManifest>('manifest.json');
const validBundles = manifest.valid.map((entry) =>
  readJson<FixtureBundle>(entry.path)
);
const invalidCases = readJson<InvalidCase[]>('invalid-cases.json');
const verdictCorrections = readJson<VerdictCorrectionFixture>(
  manifest.corrections.path
);

describe('experiment contract v1 fixture corpus', () => {
  it('covers all five flows under both harness identities', () => {
    const expectedFlows = [
      'enrollment',
      'proof-model-evaluation',
      'race',
      'replay',
      'speed-background-first',
    ];
    expect([...new Set(validBundles.map((value) => value.flow))].sort()).toEqual(
      expectedFlows
    );
    expect([...new Set(validBundles.map((value) => value.harness))].sort()).toEqual(
      ['claude-code', 'codex']
    );
    expect(validBundles).toHaveLength(10);
    expect(validBundles.reduce((sum, value) => sum + value.runs.length, 0)).toBeGreaterThanOrEqual(
      20
    );
    expect(validBundles.map((value) => value.verdict)).toHaveLength(10);
  });

  it.each(validBundles.map((bundle) => [bundle.flow, bundle.harness, bundle] as const))(
    'decodes %s under %s without external state',
    (_flow, _harness, bundle) => {
      const definition = decodeDefinitionV1(bundle.definition, {
        registry: bundle.registry,
      });
      expect(definition).toMatchObject({ ok: true });
      if (!definition.ok) return;

      const decodedRuns: ValidatedExperimentRunV1[] = [];
      for (const input of bundle.runs) {
        const run = decodeRunV1(input, {
          definition: definition.value,
          registry: bundle.registry,
          selectionReceipts: bundle.selectionReceipts,
          triggerReceipts: bundle.triggerReceipts,
          operatorSafeguardAuthorizations:
            bundle.operatorSafeguardAuthorizations,
          priorRuns: decodedRuns,
        });
        expect(run).toMatchObject({ ok: true });
        if (run.ok) decodedRuns.push(run.value);
      }

      const verdict = decodeVerdictV1(bundle.verdict, {
        definition: definition.value,
        registry: bundle.registry,
        trialRuns: decodedRuns,
        previousVerdict: null,
      });
      expect(verdict).toMatchObject({ ok: true });
    }
  );

  it('keeps equal local artifact and session IDs distinct by harness namespace', () => {
    const claude = validBundles.find(
      (value) => value.flow === 'enrollment' && value.harness === 'claude-code'
    );
    const codex = validBundles.find(
      (value) => value.flow === 'enrollment' && value.harness === 'codex'
    );
    expect(claude).toBeDefined();
    expect(codex).toBeDefined();
    expect(claude?.runs[0].subjectRef.artifactId).toBe(
      codex?.runs[0].subjectRef.artifactId
    );
    expect(claude?.runs[0].sessionRef.sessionId).toBe(
      codex?.runs[0].sessionRef.sessionId
    );
    expect(claude?.runs[0].subjectRef.harness).not.toBe(
      codex?.runs[0].subjectRef.harness
    );
    expect(claude?.runs[0].sessionRef.harness).not.toBe(
      codex?.runs[0].sessionRef.harness
    );
  });

  it('fails closed when JavaScript callers omit required Run context arrays', () => {
    const bundle = validBundles.find(
      (value) => value.flow === 'enrollment' && value.harness === 'claude-code'
    );
    expect(bundle).toBeDefined();
    if (!bundle) return;

    const context: RunDecodeContextV1 = {
      definition: bundle.definition,
      registry: bundle.registry,
      selectionReceipts: bundle.selectionReceipts,
      triggerReceipts: bundle.triggerReceipts,
      operatorSafeguardAuthorizations:
        bundle.operatorSafeguardAuthorizations,
      priorRuns: [],
    };
    const required = [
      ['selectionReceipts', 'context.selection-receipts-required'],
      ['triggerReceipts', 'context.trigger-receipts-required'],
      [
        'operatorSafeguardAuthorizations',
        'context.operator-authorizations-required',
      ],
      ['priorRuns', 'context.prior-runs-required'],
    ] as const;

    for (const [field, expectedCode] of required) {
      const incomplete = { ...context } as Record<string, unknown>;
      delete incomplete[field];
      const result = decodeRunV1(
        bundle.runs[0],
        incomplete as unknown as RunDecodeContextV1
      );
      expect(issueCodes(result), field).toContain(expectedCode);
    }
  });

  it('fails closed when JavaScript callers omit the contract registry', () => {
    const bundle = validBundles.find(
      (value) => value.flow === 'enrollment' && value.harness === 'claude-code'
    );
    expect(bundle).toBeDefined();
    if (!bundle) return;

    const definitionResult = decodeDefinitionV1(
      bundle.definition,
      {} as DefinitionDecodeContextV1
    );
    expect(issueCodes(definitionResult)).toContain('context.registry-required');

    const runContext = {
      definition: bundle.definition,
      selectionReceipts: bundle.selectionReceipts,
      triggerReceipts: bundle.triggerReceipts,
      operatorSafeguardAuthorizations:
        bundle.operatorSafeguardAuthorizations,
      priorRuns: [],
    } as unknown as RunDecodeContextV1;
    expect(issueCodes(decodeRunV1(bundle.runs[0], runContext))).toContain(
      'context.registry-required'
    );

    const verdictContext = {
      definition: bundle.definition,
      trialRuns: decodeBundleRuns(bundle),
      previousVerdict: null,
    } as unknown as VerdictDecodeContextV1;
    expect(issueCodes(decodeVerdictV1(bundle.verdict, verdictContext))).toContain(
      'context.registry-required'
    );
  });

  it('fails closed on malformed nested registry bindings', () => {
    const source = validBundles.find(
      (value) => value.flow === 'enrollment' && value.harness === 'claude-code'
    );
    expect(source).toBeDefined();
    if (!source) return;

    const malformedUsage = structuredClone(source.registry);
    const usageSemantics = malformedUsage.semantics.find(
      (entry) => entry.usage !== undefined
    );
    expect(usageSemantics?.usage).toBeDefined();
    if (!usageSemantics?.usage) return;
    usageSemantics.usage.measures =
      null as unknown as typeof usageSemantics.usage.measures;
    expect(
      issueCodes(
        decodeDefinitionV1(source.definition, { registry: malformedUsage })
      )
    ).toContain('context.registry-invalid');

    const malformedFingerprintPolicy = structuredClone(source.registry);
    const fingerprintPolicy = malformedFingerprintPolicy.fingerprintPolicies[0];
    expect(fingerprintPolicy).toBeDefined();
    if (!fingerprintPolicy) return;
    fingerprintPolicy.harnessByAdapter =
      null as unknown as typeof fingerprintPolicy.harnessByAdapter;
    const runResult = decodeRunV1(source.runs[0], {
      definition: source.definition,
      registry: malformedFingerprintPolicy,
      selectionReceipts: source.selectionReceipts,
      triggerReceipts: source.triggerReceipts,
      operatorSafeguardAuthorizations:
        source.operatorSafeguardAuthorizations,
      priorRuns: [],
    });
    expect(issueCodes(runResult)).toContain('context.registry-invalid');
  });

  it('fails closed before reading unstable or cyclic registry context', () => {
    const source = validBundles[0];
    const throwingRegistry = structuredClone(source.registry);
    const usageSemantics = throwingRegistry.semantics.find(
      (entry) => entry.usage !== undefined
    );
    expect(usageSemantics?.usage).toBeDefined();
    if (!usageSemantics?.usage) return;
    Object.defineProperty(usageSemantics.usage, 'measures', {
      enumerable: true,
      get() {
        throw new Error('unstable registry getter');
      },
    });
    expect(
      issueCodes(
        decodeDefinitionV1(source.definition, { registry: throwingRegistry })
      )
    ).toContain('context.registry-invalid');

    const cyclicRegistry = structuredClone(source.registry) as ContractRegistryV1 & {
      cycle?: unknown;
    };
    cyclicRegistry.cycle = cyclicRegistry;
    expect(
      issueCodes(
        decodeDefinitionV1(source.definition, { registry: cyclicRegistry })
      )
    ).toContain('context.registry-invalid');
  });

  it('fails closed on malformed operational bindings from JavaScript callers', () => {
    const bundle = validBundles.find(
      (value) =>
        value.flow === 'speed-background-first' &&
        value.harness === 'claude-code'
    );
    expect(bundle).toBeDefined();
    if (!bundle) return;

    const context: RunDecodeContextV1 = {
      definition: bundle.definition,
      registry: bundle.registry,
      selectionReceipts: bundle.selectionReceipts,
      triggerReceipts: bundle.triggerReceipts,
      operatorSafeguardAuthorizations:
        bundle.operatorSafeguardAuthorizations,
      priorRuns: [],
    };
    const malformed = [
      {
        field: 'selectionReceipts',
        value: [{ receiptId: bundle.runs[0].selectionRef.receiptId }],
        expectedCode: 'context.selection-receipt-invalid',
      },
      {
        field: 'triggerReceipts',
        value: [{ receiptId: bundle.runs[0].triggerRef?.receiptId }],
        expectedCode: 'context.trigger-receipt-invalid',
      },
      {
        field: 'operatorSafeguardAuthorizations',
        value: [{}],
        expectedCode: 'context.operator-authorization-invalid',
      },
    ] as const;

    for (const { field, value, expectedCode } of malformed) {
      const invalidContext = {
        ...context,
        [field]: value,
      } as unknown as RunDecodeContextV1;
      const result = decodeRunV1(bundle.runs[0], invalidContext);
      expect(issueCodes(result), field).toContain(expectedCode);
    }
  });

  it('requires fully decoded immutable context documents downstream', () => {
    const bundle = validBundles.find(
      (value) => value.flow === 'enrollment' && value.harness === 'claude-code'
    );
    expect(bundle).toBeDefined();
    if (!bundle) return;

    const tamperedDefinition = structuredClone(bundle.definition);
    tamperedDefinition.title = `${tamperedDefinition.title} (tampered)`;
    const runResult = decodeRunV1(bundle.runs[0], {
      definition: tamperedDefinition,
      registry: bundle.registry,
      selectionReceipts: bundle.selectionReceipts,
      triggerReceipts: bundle.triggerReceipts,
      operatorSafeguardAuthorizations:
        bundle.operatorSafeguardAuthorizations,
      priorRuns: [],
    });
    expect(issueCodes(runResult)).toContain('document.digest-mismatch');

    const decodedRuns = decodeBundleRuns(bundle);
    const tamperedRun = structuredClone(bundle.runs[0]);
    tamperedRun.observations[0].value += 1;
    const verdictResult = decodeVerdictV1(bundle.verdict, {
      definition: bundle.definition,
      registry: bundle.registry,
      trialRuns: [
        tamperedRun as ValidatedExperimentRunV1,
        ...decodedRuns.slice(1),
      ],
      previousVerdict: null,
    });
    expect(issueCodes(verdictResult)).toContain('context.run-not-decoded');

    const duplicateResult = decodeVerdictV1(bundle.verdict, {
      definition: bundle.definition,
      registry: bundle.registry,
      trialRuns: [decodedRuns[0], ...decodedRuns],
      previousVerdict: null,
    });
    expect(issueCodes(duplicateResult)).toContain('context.duplicate-run-id');

    const invalidProvenance = structuredClone(bundle.runs[0]);
    invalidProvenance.harnessProvenance.driver = 'codex';
    const redigestedInvalid = withDocumentDigest(invalidProvenance);
    expect(
      issueCodes(
        decodeRunV1(redigestedInvalid, {
          definition: bundle.definition,
          registry: bundle.registry,
          selectionReceipts: bundle.selectionReceipts,
          triggerReceipts: bundle.triggerReceipts,
          operatorSafeguardAuthorizations:
            bundle.operatorSafeguardAuthorizations,
          priorRuns: [],
        })
      )
    ).toContain('run.provenance-mismatch');
    const alteredVerdict = structuredClone(bundle.verdict);
    alteredVerdict.evidence.includedRuns[0].contentDigest =
      redigestedInvalid.contentDigest;
    const invalidEvidenceResult = decodeVerdictV1(
      withDocumentDigest(alteredVerdict),
      {
        definition: bundle.definition,
        registry: bundle.registry,
        trialRuns: [
          redigestedInvalid as ValidatedExperimentRunV1,
          ...decodedRuns.slice(1),
        ],
        previousVerdict: null,
      }
    );
    expect(issueCodes(invalidEvidenceResult)).toContain(
      'context.run-not-decoded'
    );

    const replay = validBundles.find(
      (value) => value.flow === 'replay' && value.harness === 'claude-code'
    );
    expect(replay).toBeDefined();
    if (!replay) return;
    const tamperedParent = structuredClone(replay.runs[1]);
    if (!tamperedParent.error) throw new Error('fixture retry parent must fail');
    tamperedParent.error.message = `${tamperedParent.error.message} tampered`;
    const retryResult = decodeRunV1(replay.runs[2], {
      definition: replay.definition,
      registry: replay.registry,
      selectionReceipts: replay.selectionReceipts,
      triggerReceipts: replay.triggerReceipts,
      operatorSafeguardAuthorizations:
        replay.operatorSafeguardAuthorizations,
      priorRuns: [
        decodeBundleRuns(replay, 1)[0],
        tamperedParent as ValidatedExperimentRunV1,
      ],
    });
    expect(issueCodes(retryResult)).toContain('context.run-not-decoded');
  });

  it('keeps paired trial Runs bound to one immutable Selection Receipt', () => {
    const bundle = validBundles.find(
      (value) => value.flow === 'enrollment' && value.harness === 'claude-code'
    );
    expect(bundle).toBeDefined();
    if (!bundle) return;

    const alternateReceipt = structuredClone(bundle.selectionReceipts[0]);
    alternateReceipt.receiptId = '00000000-0000-4000-8000-000000099999';
    alternateReceipt.receiptDigest = bundle.definition.contentDigest;
    const secondRun = structuredClone(bundle.runs[1]);
    secondRun.selectionRef = {
      ...secondRun.selectionRef,
      receiptId: alternateReceipt.receiptId,
      receiptDigest: alternateReceipt.receiptDigest,
    };
    const firstRun = decodeBundleRuns(bundle, 1)[0];
    const result = decodeRunV1(withDocumentDigest(secondRun), {
      definition: bundle.definition,
      registry: bundle.registry,
      selectionReceipts: [...bundle.selectionReceipts, alternateReceipt],
      triggerReceipts: bundle.triggerReceipts,
      operatorSafeguardAuthorizations:
        bundle.operatorSafeguardAuthorizations,
      priorRuns: [firstRun],
    });
    expect(issueCodes(result)).toContain(
      'selection.paired-trial-receipt-mismatch'
    );

    const independentlyDecoded = decodeRunV1(withDocumentDigest(secondRun), {
      definition: bundle.definition,
      registry: bundle.registry,
      selectionReceipts: [...bundle.selectionReceipts, alternateReceipt],
      triggerReceipts: bundle.triggerReceipts,
      operatorSafeguardAuthorizations:
        bundle.operatorSafeguardAuthorizations,
      priorRuns: [],
    });
    expect(independentlyDecoded).toMatchObject({ ok: true });
    if (!independentlyDecoded.ok) return;
    const alteredVerdict = structuredClone(bundle.verdict);
    alteredVerdict.evidence.includedRuns[1].contentDigest =
      independentlyDecoded.value.contentDigest;
    const aggregateResult = decodeVerdictV1(
      withDocumentDigest(alteredVerdict),
      {
        definition: bundle.definition,
        registry: bundle.registry,
        trialRuns: [firstRun, independentlyDecoded.value],
        previousVerdict: null,
      }
    );
    expect(issueCodes(aggregateResult)).toContain(
      'selection.paired-trial-receipt-mismatch'
    );

    const collidingReceipt = structuredClone(bundle.selectionReceipts[0]);
    collidingReceipt.receiptDigest = bundle.definition.contentDigest;
    const collidingSecond = structuredClone(bundle.runs[1]);
    collidingSecond.selectionRef.receiptDigest =
      collidingReceipt.receiptDigest;
    const independentlyDecodedCollision = decodeRunV1(
      withDocumentDigest(collidingSecond),
      {
        definition: bundle.definition,
        registry: bundle.registry,
        selectionReceipts: [collidingReceipt],
        triggerReceipts: bundle.triggerReceipts,
        operatorSafeguardAuthorizations:
          bundle.operatorSafeguardAuthorizations,
        priorRuns: [],
      }
    );
    expect(independentlyDecodedCollision).toMatchObject({ ok: true });
    if (!independentlyDecodedCollision.ok) return;
    const collisionVerdict = structuredClone(bundle.verdict);
    collisionVerdict.evidence.includedRuns[1].contentDigest =
      independentlyDecodedCollision.value.contentDigest;
    const receiptCollisionResult = decodeVerdictV1(
      withDocumentDigest(collisionVerdict),
      {
        definition: bundle.definition,
        registry: bundle.registry,
        trialRuns: [firstRun, independentlyDecodedCollision.value],
        previousVerdict: null,
      }
    );
    expect(issueCodes(receiptCollisionResult)).toContain(
      'selection.receipt-identity-collision'
    );
  });

  it('permits separate receipts for registered harness-as-treatment trials', () => {
    const bundle = structuredClone(
      validBundles.find(
        (value) => value.flow === 'race' && value.harness === 'claude-code'
      )
    );
    expect(bundle).toBeDefined();
    if (!bundle) return;

    const verdictPolicy = bundle.registry.semantics.find(
      (entry) => entry.id === bundle.definition.verdictPolicy.id
    );
    if (!verdictPolicy) throw new Error('fixture Verdict Policy missing');
    verdictPolicy.allowsHarnessComparison = true;
    const intervention = bundle.definition.treatments
      .flatMap((treatment) => treatment.interventions)
      .at(0);
    if (!intervention) throw new Error('fixture intervention missing');
    const interventionSemantics = bundle.registry.semantics.find(
      (entry) => entry.id === intervention.capability.semanticsRef.id
    );
    if (!interventionSemantics) {
      throw new Error('fixture intervention semantics missing');
    }
    interventionSemantics.selectedHarnessOperations = [intervention.operation];

    const first = decodeRunV1(bundle.runs[0], {
      definition: bundle.definition,
      registry: bundle.registry,
      selectionReceipts: bundle.selectionReceipts,
      triggerReceipts: bundle.triggerReceipts,
      operatorSafeguardAuthorizations:
        bundle.operatorSafeguardAuthorizations,
      priorRuns: [],
    });
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) return;

    const second = structuredClone(bundle.runs[1]);
    second.selectedHarness = 'codex';
    second.harnessProvenance.driver = 'codex';
    second.harnessProvenance.worker = 'codex';
    second.harnessProvenance.judge = 'codex';
    second.sessionRef.harness = 'codex';
    for (const evidence of [
      ...second.observations.flatMap((observation) => observation.evidenceRefs),
      ...second.checkResults.flatMap((check) => check.evidenceRefs),
    ]) {
      if (evidence.kind === 'session') evidence.sessionRef.harness = 'codex';
    }
    second.behaviorFingerprint.adapter.id = 'codex-adapter';
    second.behaviorFingerprint.model.qualifiedId = 'openai/gpt-5-codex';
    second.behaviorFingerprint = withBehaviorFingerprintDigest(
      second.behaviorFingerprint
    );
    const receipt = structuredClone(bundle.selectionReceipts[0]);
    receipt.receiptId = '00000000-0000-4000-8000-000000099997';
    receipt.receiptDigest = bundle.definition.contentDigest;
    receipt.selectedHarness = 'codex';
    receipt.adapterBinding = {
      adapterId: 'codex-adapter',
      behaviorFingerprintDigest: second.behaviorFingerprint.digest,
    };
    second.selectionRef.receiptId = receipt.receiptId;
    second.selectionRef.receiptDigest = receipt.receiptDigest;

    const result = decodeRunV1(withDocumentDigest(second), {
      definition: bundle.definition,
      registry: bundle.registry,
      selectionReceipts: [...bundle.selectionReceipts, receipt],
      triggerReceipts: bundle.triggerReceipts,
      operatorSafeguardAuthorizations:
        bundle.operatorSafeguardAuthorizations,
      priorRuns: [first.value],
    });
    expect(result).toMatchObject({ ok: true });
  });

  it('enforces stable identity and digest invalidation for Verdict corrections', () => {
    const bundle = readJson<FixtureBundle>(verdictCorrections.base);

    const trialRuns = decodeBundleRuns(bundle);
    const initial = decodeVerdictV1(bundle.verdict, {
      definition: bundle.definition,
      registry: bundle.registry,
      trialRuns,
      previousVerdict: null,
    });
    expect(initial).toMatchObject({ ok: true });
    if (!initial.ok) return;

    const validCorrection = verdictCorrections.valid;
    expect(
      decodeVerdictV1(validCorrection, {
        definition: bundle.definition,
        registry: bundle.registry,
        trialRuns,
        previousVerdict: initial.value,
      })
    ).toMatchObject({ ok: true });
    expect(validCorrection.contentDigest).not.toBe(bundle.verdict.contentDigest);

    expect(verdictCorrections.invalid).toHaveLength(
      manifest.corrections.invalidCount
    );
    for (const invalid of verdictCorrections.invalid) {
      expect(
        issueCodes(
          decodeVerdictV1(invalid.verdict, {
            definition: bundle.definition,
            registry: bundle.registry,
            trialRuns,
            previousVerdict: initial.value,
          })
        ),
        invalid.name
      ).toContain(invalid.expectedCode);
    }
  });

  it('uses representative lifecycle shapes instead of relabelled clones', () => {
    const replay = validBundles.find(
      (value) => value.flow === 'replay' && value.harness === 'claude-code'
    );
    expect(replay?.runs).toHaveLength(3);
    expect(replay?.runs[1]).toMatchObject({ status: 'failed' });
    expect(replay?.runs[2].retryOf).toEqual({
      runId: replay?.runs[1].runId,
      contentDigest: replay?.runs[1].contentDigest,
    });
    expect(replay?.verdict.evidence.excludedRuns[0].run.runId).toBe(
      replay?.runs[1].runId
    );

    const proof = validBundles.find(
      (value) =>
        value.flow === 'proof-model-evaluation' &&
        value.harness === 'claude-code'
    );
    expect(proof?.definition.studyDesign).toMatchObject({
      kind: 'cohort',
      assignment: { kind: 'explicit' },
    });
    expect(proof?.runs.every((run) => run.assignment.kind === 'explicit')).toBe(
      true
    );

    const race = validBundles.find(
      (value) => value.flow === 'race' && value.harness === 'claude-code'
    );
    expect(race?.runs[0].harnessProvenance.origin).not.toBe(
      race?.runs[0].selectedHarness
    );
    expect(
      validBundles
        .filter((value) =>
          ['enrollment', 'speed-background-first'].includes(value.flow)
        )
        .every((value) => value.runs.every((run) => run.triggerRef !== null))
    ).toBe(true);
  });

  it('accepts an all-excluded invalid Verdict but not a nonexistent trial', () => {
    const bundle = structuredClone(validBundles[0]);
    const verdict = structuredClone(bundle.verdict);
    verdict.evidence = {
      includedRuns: [],
      excludedRuns: bundle.runs.map((run) => ({
        run: { runId: run.runId, contentDigest: run.contentDigest },
        reason: 'quality/evidence-unusable',
      })),
    };
    verdict.outcome = { kind: 'invalid', reason: 'quality/evidence-unusable' };
    verdict.primaryEffect = null;
    verdict.evidenceBasis.satisfiedCapabilitySemantics = [];
    const digested = withDocumentDigest(verdict);
    const accepted = decodeVerdictV1(digested, {
      definition: bundle.definition,
      registry: bundle.registry,
      trialRuns: decodeBundleRuns(bundle),
      previousVerdict: null,
    });
    expect(accepted).toMatchObject({ ok: true });

    const missing = decodeVerdictV1(digested, {
      definition: bundle.definition,
      registry: bundle.registry,
      trialRuns: [],
      previousVerdict: null,
    });
    expect(issueCodes(missing)).toContain('verdict.trial-empty');
  });

  it('does not count failed, metric-free Runs toward a conclusive cohort effect', () => {
    const source = validBundles.find(
      (value) =>
        value.flow === 'proof-model-evaluation' &&
        value.harness === 'claude-code'
    );
    expect(source).toBeDefined();
    if (!source) return;
    const bundle = structuredClone(source);
    bundle.runs = bundle.runs.map((input) => {
      const run = structuredClone(input);
      const evidenceRefs = run.observations[0].evidenceRefs;
      run.status = 'failed';
      run.observations = [];
      run.checkResults = [];
      run.error = {
        code: 'runtime/worker-failed',
        message: 'Synthetic cohort failure.',
        evidenceRefs,
      };
      return withDocumentDigest(run);
    });
    const verdict = structuredClone(bundle.verdict);
    verdict.evidence.includedRuns = bundle.runs.map((run) => ({
      runId: run.runId,
      contentDigest: run.contentDigest,
    }));
    const result = decodeVerdictV1(withDocumentDigest(verdict), {
      definition: bundle.definition,
      registry: bundle.registry,
      trialRuns: decodeBundleRuns(bundle),
      previousVerdict: null,
    });
    expect(issueCodes(result)).toContain('verdict.cohort-minimum-not-met');
    expect(issueCodes(result)).toContain('effect.sample-count-mismatch');
  });

  it('rejects a failed Run included alongside conclusive succeeded evidence', () => {
    const source = validBundles.find(
      (value) => value.flow === 'replay' && value.harness === 'claude-code'
    );
    expect(source).toBeDefined();
    if (!source) return;
    const bundle = structuredClone(source);
    const failed = bundle.runs.find((run) => run.status === 'failed');
    expect(failed).toBeDefined();
    if (!failed) return;

    const verdict = structuredClone(bundle.verdict);
    verdict.evidence.includedRuns.push({
      runId: failed.runId,
      contentDigest: failed.contentDigest,
    });
    verdict.evidence.excludedRuns = verdict.evidence.excludedRuns.filter(
      (entry) => entry.run.runId !== failed.runId
    );
    const result = decodeVerdictV1(withDocumentDigest(verdict), {
      definition: bundle.definition,
      registry: bundle.registry,
      trialRuns: decodeBundleRuns(bundle),
      previousVerdict: null,
    });
    expect(issueCodes(result)).toContain('verdict.included-run-not-succeeded');
  });

  it('validates a stable JSON clone rather than rereading input accessors', () => {
    const bundle = validBundles[0];
    const input = structuredClone(bundle.definition) as ExperimentDefinition;
    let reads = 0;
    Object.defineProperty(input, 'kind', {
      enumerable: true,
      get() {
        reads++;
        if (reads > 1) throw new Error('kind was reread');
        return 'ExperimentDefinition';
      },
    });
    expect(decodeDefinitionV1(input, { registry: bundle.registry })).toMatchObject({
      ok: true,
    });
    expect(reads).toBe(1);
  });

  it('accepts arbitrary RFC3339 fractions and orders beyond milliseconds', () => {
    const bundle = validBundles.find(
      (value) => value.flow === 'enrollment' && value.harness === 'claude-code'
    );
    expect(bundle).toBeDefined();
    if (!bundle) return;
    const withFraction = (value: string, fraction: string) =>
      value.replace(/(?:\.[0-9]+)?Z$/, `.${fraction}Z`);

    const definition = structuredClone(bundle.definition);
    definition.createdAt = withFraction(definition.createdAt, '123456');
    expect(
      decodeDefinitionV1(withDocumentDigest(definition), {
        registry: bundle.registry,
      })
    ).toMatchObject({ ok: true });

    const run = structuredClone(bundle.runs[0]);
    run.createdAt = withFraction(run.createdAt, '123456789');
    const runResult = decodeRunV1(withDocumentDigest(run), {
      definition: bundle.definition,
      registry: bundle.registry,
      selectionReceipts: bundle.selectionReceipts,
      triggerReceipts: bundle.triggerReceipts,
      operatorSafeguardAuthorizations:
        bundle.operatorSafeguardAuthorizations,
      priorRuns: [],
    });
    expect(runResult).toMatchObject({ ok: true });

    const verdict = structuredClone(bundle.verdict);
    verdict.createdAt = withFraction(verdict.createdAt, '123456789');
    verdict.updatedAt = verdict.createdAt;
    expect(
      decodeVerdictV1(withDocumentDigest(verdict), {
        definition: bundle.definition,
        registry: bundle.registry,
        trialRuns: decodeBundleRuns(bundle),
        previousVerdict: null,
      })
    ).toMatchObject({ ok: true });

    const reversed = structuredClone(bundle.runs[0]);
    reversed.createdAt = '2026-07-01T12:00:10.123456789Z';
    reversed.startedAt = '2026-07-01T12:00:10.123456788Z';
    const reversedResult = decodeRunV1(withDocumentDigest(reversed), {
      definition: bundle.definition,
      registry: bundle.registry,
      selectionReceipts: bundle.selectionReceipts,
      triggerReceipts: bundle.triggerReceipts,
      operatorSafeguardAuthorizations:
        bundle.operatorSafeguardAuthorizations,
      priorRuns: [],
    });
    expect(issueCodes(reversedResult)).toContain('timestamp.out-of-order');
  });

  it('uses full fractional precision for retry and Verdict replacement order', () => {
    const replay = validBundles.find(
      (value) => value.flow === 'replay' && value.harness === 'claude-code'
    );
    expect(replay).toBeDefined();
    if (!replay) return;

    const firstRun = decodeBundleRuns(replay, 1)[0];
    const parent = structuredClone(replay.runs[1]);
    parent.finishedAt = '2026-07-01T12:42:40.123456788Z';
    const parentResult = decodeRunV1(withDocumentDigest(parent), {
      definition: replay.definition,
      registry: replay.registry,
      selectionReceipts: replay.selectionReceipts,
      triggerReceipts: replay.triggerReceipts,
      operatorSafeguardAuthorizations:
        replay.operatorSafeguardAuthorizations,
      priorRuns: [firstRun],
    });
    expect(parentResult).toMatchObject({ ok: true });
    if (!parentResult.ok) return;

    const child = structuredClone(replay.runs[2]);
    child.createdAt = '2026-07-01T12:42:40.123456789Z';
    if (!child.retryOf) throw new Error('fixture retry child must name its parent');
    child.retryOf.contentDigest = parentResult.value.contentDigest;
    const retryContext: RunDecodeContextV1 = {
      definition: replay.definition,
      registry: replay.registry,
      selectionReceipts: replay.selectionReceipts,
      triggerReceipts: replay.triggerReceipts,
      operatorSafeguardAuthorizations:
        replay.operatorSafeguardAuthorizations,
      priorRuns: [firstRun, parentResult.value],
    };
    expect(decodeRunV1(withDocumentDigest(child), retryContext)).toMatchObject({
      ok: true,
    });

    child.createdAt = '2026-07-01T12:42:40.123456787Z';
    expect(issueCodes(decodeRunV1(withDocumentDigest(child), retryContext))).toContain(
      'retry.precedes-parent'
    );

    const correctionBundle = readJson<FixtureBundle>(verdictCorrections.base);
    const trialRuns = decodeBundleRuns(correctionBundle);
    const initial = structuredClone(correctionBundle.verdict);
    initial.updatedAt = '2026-07-01T12:05:00.123456788Z';
    const initialResult = decodeVerdictV1(withDocumentDigest(initial), {
      definition: correctionBundle.definition,
      registry: correctionBundle.registry,
      trialRuns,
      previousVerdict: null,
    });
    expect(initialResult).toMatchObject({ ok: true });
    if (!initialResult.ok) return;

    const replacement = structuredClone(verdictCorrections.valid);
    replacement.updatedAt = '2026-07-01T12:05:00.123456789Z';
    expect(
      decodeVerdictV1(withDocumentDigest(replacement), {
        definition: correctionBundle.definition,
        registry: correctionBundle.registry,
        trialRuns,
        previousVerdict: initialResult.value,
      })
    ).toMatchObject({ ok: true });

    replacement.updatedAt = '2026-07-01T12:05:00.123456787Z';
    expect(
      issueCodes(
        decodeVerdictV1(withDocumentDigest(replacement), {
          definition: correctionBundle.definition,
          registry: correctionBundle.registry,
          trialRuns,
          previousVerdict: initialResult.value,
        })
      )
    ).toContain('verdict.replacement-not-newer');
  });

  it('fails closed when operational receipt bindings are unresolved', () => {
    const bundle = validBundles.find(
      (value) =>
        value.flow === 'speed-background-first' &&
        value.harness === 'claude-code'
    );
    expect(bundle).toBeDefined();
    if (!bundle) return;
    const withoutSelection = decodeRunV1(bundle.runs[0], {
      definition: bundle.definition,
      registry: bundle.registry,
      selectionReceipts: [],
      triggerReceipts: bundle.triggerReceipts,
      operatorSafeguardAuthorizations: [],
      priorRuns: [],
    });
    expect(issueCodes(withoutSelection)).toContain('selection.receipt-missing');

    const withoutTrigger = decodeRunV1(bundle.runs[0], {
      definition: bundle.definition,
      registry: bundle.registry,
      selectionReceipts: bundle.selectionReceipts,
      triggerReceipts: [],
      operatorSafeguardAuthorizations: [],
      priorRuns: [],
    });
    expect(issueCodes(withoutTrigger)).toContain('trigger.receipt-missing');
  });

  it.each(invalidCases.map((fixture) => [fixture.name, fixture] as const))(
    'rejects focused invalid fixture %s',
    (_name, fixture) => {
      const { bundle, document } = materializeInvalid(fixture);
      const definition = decodeDefinitionV1(bundle.definition, {
        registry: bundle.registry,
      });
      expect(definition).toMatchObject({ ok: true });
      if (!definition.ok) return;

      let result;
      if (fixture.contract === 'definition') {
        result = decodeDefinitionV1(document, { registry: bundle.registry });
      } else if (fixture.contract === 'run') {
        const targetIndex = Number(/\/runs\/(\d+)$/.exec(fixture.target)?.[1] ?? 0);
        result = decodeRunV1(document, {
          definition: definition.value,
          registry: bundle.registry,
          selectionReceipts: bundle.selectionReceipts,
          triggerReceipts: bundle.triggerReceipts,
          operatorSafeguardAuthorizations:
            bundle.operatorSafeguardAuthorizations,
          priorRuns: decodeBundleRuns(bundle, targetIndex),
        });
      } else {
        result = decodeVerdictV1(document, {
          definition: definition.value,
          registry: bundle.registry,
          trialRuns: decodeBundleRuns(bundle),
          previousVerdict: null,
        });
      }
      expect(result.ok).toBe(false);
      expect(issueCodes(result)).toContain(fixture.expectedCode);
    }
  );
});

describe('published schema parity', () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validators = {
    definition: ajv.compile(EXPERIMENT_CONTRACT_SCHEMAS_V1.ExperimentDefinition),
    run: ajv.compile(EXPERIMENT_CONTRACT_SCHEMAS_V1.ExperimentRun),
    verdict: ajv.compile(EXPERIMENT_CONTRACT_SCHEMAS_V1.ExperimentVerdict),
  };

  it.each(validBundles.map((bundle) => [bundle.flow, bundle.harness, bundle] as const))(
    'Ajv and the internal evaluator accept %s under %s',
    (_flow, _harness, bundle) => {
      const documents = [
        ['definition', bundle.definition],
        ...bundle.runs.map((run) => ['run', run]),
        ['verdict', bundle.verdict],
      ] as const;
      for (const [kind, document] of documents) {
        expect(validators[kind](document), JSON.stringify(validators[kind].errors)).toBe(
          true
        );
        expect(validateContractSchema(document, documentKind(kind))).toEqual([]);
      }
    }
  );

  it('accepts RFC3339 microsecond and nanosecond schema values', () => {
    const bundle = validBundles[0];
    const definition = structuredClone(bundle.definition);
    const run = structuredClone(bundle.runs[0]);
    const verdict = structuredClone(bundle.verdict);
    definition.createdAt = '2026-07-14T12:00:00.123456Z';
    run.createdAt = '2026-07-14T12:00:00.123456789Z';
    verdict.updatedAt = '2026-07-14T12:00:00.123456789Z';

    for (const [kind, document] of [
      ['definition', definition],
      ['run', run],
      ['verdict', verdict],
    ] as const) {
      expect(validators[kind](document), JSON.stringify(validators[kind].errors)).toBe(
        true
      );
      expect(validateContractSchema(document, documentKind(kind))).toEqual([]);
    }
  });

  it.each(invalidCases.map((fixture) => [fixture.name, fixture] as const))(
    'Ajv and the internal evaluator agree on structural case %s',
    (_name, fixture) => {
      const { document } = materializeInvalid(fixture);
      const ajvValid = validators[fixture.contract](document);
      const internalValid =
        validateContractSchema(document, documentKind(fixture.contract)).length === 0;
      expect(internalValid).toBe(ajvValid);
      if (fixture.expectedCode.startsWith('schema.')) expect(ajvValid).toBe(false);
      else expect(ajvValid).toBe(true);
    }
  );

  it('exports the exact checked-in schema assets', () => {
    // The explicit URL reads below avoid testing an import against itself.
    const definition = JSON.parse(
      readFileSync(
        new URL(
          '../../schemas/v1/experiment-definition.schema.json',
          import.meta.url
        ),
        'utf8'
      )
    );
    const run = JSON.parse(
      readFileSync(
        new URL('../../schemas/v1/experiment-run.schema.json', import.meta.url),
        'utf8'
      )
    );
    const verdict = JSON.parse(
      readFileSync(
        new URL('../../schemas/v1/experiment-verdict.schema.json', import.meta.url),
        'utf8'
      )
    );
    expect(EXPERIMENT_CONTRACT_SCHEMAS_V1).toEqual({
      ExperimentDefinition: definition,
      ExperimentRun: run,
      ExperimentVerdict: verdict,
    });
    expect(Object.isFrozen(EXPERIMENT_CONTRACT_SCHEMAS_V1.ExperimentRun)).toBe(
      true
    );
    expect(
      Object.isFrozen(
        EXPERIMENT_CONTRACT_SCHEMAS_V1.ExperimentRun.properties as object
      )
    ).toBe(true);
  });

  it('validates cloned registry schemas independently and supports booleans', () => {
    const first = {
      $id: 'https://fixtures.invalid/shared-schema',
      type: 'string',
    };
    const second = structuredClone(first);
    expect(validateRegistrySchema('ok', first)).toEqual({ issues: [] });
    expect(validateRegistrySchema('ok', second)).toEqual({ issues: [] });
    expect(validateRegistrySchema('anything', true)).toEqual({ issues: [] });
    expect(validateRegistrySchema('anything', false).issues).not.toHaveLength(0);
  });

  it('rejects async registry schemas without invoking their validator', () => {
    expect(
      validateRegistrySchema(123, { $async: true, type: 'string' })
    ).toEqual({
      issues: [],
      schemaError: 'async registry schemas are not supported',
    });
  });

  it('treats a registered false operation schema as rejecting every value', () => {
    const bundle = structuredClone(validBundles[0]);
    const intervention = bundle.definition.treatments
      .flatMap((treatment) => treatment.interventions)
      .at(0);
    if (!intervention) throw new Error('fixture intervention missing');
    const semantics = bundle.registry.semantics.find(
      (entry) => entry.id === intervention.capability.semanticsRef.id
    );
    if (!semantics?.interventionOperations) {
      throw new Error('fixture intervention registry missing');
    }
    semantics.interventionOperations[intervention.operation] = false;
    const result = decodeDefinitionV1(bundle.definition, {
      registry: bundle.registry,
    });
    expect(issueCodes(result)).toContain('intervention.value-invalid');
    expect(issueCodes(result)).not.toContain(
      'intervention.operation-unregistered'
    );
  });
});
