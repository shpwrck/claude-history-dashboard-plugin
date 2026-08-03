// Reproducibility guard for the v0.4 proof fixture bundle (#1076, epic #995).
// The pre-registration (docs/v0.4-proof-preregistration.md) freezes the fixture
// set before any batch run; this suite is the in-repo guard that the committed
// bundle actually satisfies what was pre-registered: >= 12 matched pairs, both
// arms derivable per pair, deterministic objective gates wired to files that
// exist, #890-marker-conformant injected recommendations, and a fully
// deterministic load.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRE_REGISTERED_MIN_PAIRS,
  PROOF_PAIR_ARMS,
  RECOMMENDATION_BODY_PHRASE,
  RECOMMENDATION_HEADING,
  WASTE_REASONS,
  armTaskId,
  bundleToCorpusTasks,
  pairToCorpusTasks,
  parseArmTaskId,
  parseProofPair,
  parseProofPairBundle,
  validateProofPairBundle,
  type ProofPairBundle,
} from './proof-fixture-pairs';
import {
  OBJECTIVE_GATE_KINDS,
  corpusTaskRef,
  parseCorpusTask,
  validateCorpus,
} from './model-eval-corpus';

const bundleRoot = fileURLToPath(
  new URL('../../fixtures/proof/repo-map-context-waste/', import.meta.url)
);
const manifestPath = join(bundleRoot, 'manifest.json');
const readmePath = join(bundleRoot, 'README.md');

function loadBundle(): ProofPairBundle {
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bundle = parseProofPairBundle(raw);
  if (!bundle) throw new Error('manifest.json failed to parse as a proof-pair bundle');
  return bundle;
}

describe('proof fixture bundle (manifest.json)', () => {
  const bundle = loadBundle();

  it('parses cleanly with no pair dropped by the sanitizer', () => {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(bundle.pairs.length).toBe(raw.pairs.length);
  });

  it('satisfies the pre-registered minimum matched-pair N (>= 12)', () => {
    expect(bundle.minDecidedPairs).toBeGreaterThanOrEqual(PRE_REGISTERED_MIN_PAIRS);
    expect(bundle.pairs.length).toBeGreaterThanOrEqual(PRE_REGISTERED_MIN_PAIRS);
  });

  it('cites the pre-registration and the #890 detector, and both files exist', () => {
    expect(bundle.preRegistrationRef).toBe('docs/v0.4-proof-preregistration.md');
    expect(bundle.detectorRef).toBe('src/lib/detectors/context/repo-map-context-waste.ts');
    const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
    expect(existsSync(join(repoRoot, bundle.preRegistrationRef))).toBe(true);
    expect(existsSync(join(repoRoot, bundle.detectorRef))).toBe(true);
  });

  it('validates as a bundle (round-trip, unique ids, all waste reasons covered)', () => {
    const result = validateProofPairBundle(bundle);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('pair ids are unique and stable kebab-case without the arm separator', () => {
    const ids = new Set<string>();
    for (const pair of bundle.pairs) {
      expect(ids.has(pair.pairId)).toBe(false);
      ids.add(pair.pairId);
      expect(pair.pairId).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(pair.pairId).not.toContain('--');
    }
  });

  it('pairs vary meaningfully: all 3 waste reasons, >= 2 gate kinds, >= 6 task shapes', () => {
    expect(new Set(bundle.pairs.map((p) => p.wasteReason)).size).toBe(WASTE_REASONS.length);
    // Gate-kind diversity guards against a single-gate artifact. The
    // multi-session bundle (#2082) drops the `diff` kind: a diff gate ships an
    // `expected/` answer key, which would let an agent solve the task by reading
    // the answer instead of re-reading the stable file — defeating the
    // cross-session re-read premise. So we require >= 2 kinds, all valid.
    const gateKinds = new Set(bundle.pairs.map((p) => p.gate.kind));
    expect(gateKinds.size).toBeGreaterThanOrEqual(2);
    for (const k of gateKinds) expect(OBJECTIVE_GATE_KINDS).toContain(k);
    expect(new Set(bundle.pairs.map((p) => p.taskShape)).size).toBeGreaterThanOrEqual(6);
  });

  it('is a multi-session bundle: every pair carries an 8-session chain (#2082)', () => {
    expect(bundle.sessionsPerChain).toBe(8);
    for (const pair of bundle.pairs) {
      expect(pair.chain, pair.pairId).toBeDefined();
      expect(pair.chain!.length, pair.pairId).toBe(8);
      for (const step of pair.chain!) {
        expect(typeof step.instruction).toBe('string');
        expect(step.instruction.length).toBeGreaterThan(0);
      }
    }
    expect(validateProofPairBundle(bundle).errors).toEqual([]);
  });

  it('loads deterministically (two independent loads are deeply equal)', () => {
    const again = loadBundle();
    expect(again).toEqual(bundle);
    expect(JSON.stringify(again)).toBe(JSON.stringify(bundle));
  });
});

describe('per-pair substrate and gates', () => {
  const bundle = loadBundle();

  it('every pair has a committed substrate tree', () => {
    for (const pair of bundle.pairs) {
      expect(existsSync(join(bundleRoot, pair.tree)), pair.pairId).toBe(true);
    }
  });

  it('every gate references only files that exist in the pair tree', () => {
    for (const pair of bundle.pairs) {
      const treeDir = join(bundleRoot, pair.tree);
      // Tokens starting with '-' are flags (e.g. a future `--reporter=dot.tap`),
      // not file paths — exclude them so they can't false-positive.
      const fileTokens = (pair.gate.command.match(/[\w./-]+\.[a-z]+/g) ?? []).filter(
        (t) => !t.startsWith('-')
      );
      expect(fileTokens.length, `${pair.pairId}: gate names no files`).toBeGreaterThan(0);
      for (const token of fileTokens) {
        expect(existsSync(join(treeDir, token)), `${pair.pairId}: ${token}`).toBe(true);
      }
    }
  });

  it('names exactly the manifest gate command in every pair instruction', () => {
    for (const pair of bundle.pairs) {
      const namedGateCommands = [...pair.instruction.matchAll(/`(node [^`]+\.mjs)`/g)].map(
        (match) => match[1]
      );
      expect(namedGateCommands, pair.pairId).toEqual([pair.gate.command]);
    }
  });

  it('reports every manifest gate kind truthfully in the README inventory', () => {
    const readmeLines = readFileSync(readmePath, 'utf8').split('\n');
    for (const pair of bundle.pairs) {
      const row = readmeLines.find((line) => line.startsWith(`| ${pair.pairId} |`));
      expect(row, `${pair.pairId}: missing README inventory row`).toBeDefined();
      const cells = row!.split('|').slice(1, -1).map((cell) => cell.trim());
      expect(cells[3], pair.pairId).toBe(pair.gate.kind);
    }
  });

  it('every stable file the recommendation names exists and exports the cited symbols', () => {
    for (const pair of bundle.pairs) {
      expect(pair.stableFiles.length).toBeGreaterThan(0);
      for (const ref of pair.stableFiles) {
        const filePath = join(bundleRoot, pair.tree, ref.path);
        expect(existsSync(filePath), `${pair.pairId}: ${ref.path}`).toBe(true);
        const source = readFileSync(filePath, 'utf8');
        expect(ref.symbols.length).toBeGreaterThan(0);
        for (const symbol of ref.symbols) {
          expect(source, `${pair.pairId}: ${ref.path} should export ${symbol}`).toContain(
            symbol
          );
        }
      }
    }
  });

  it('the injected recommendation carries the #890 applied-markers and cites each stable file', () => {
    for (const pair of bundle.pairs) {
      expect(pair.injectedRecommendation.startsWith(RECOMMENDATION_HEADING)).toBe(true);
      expect(pair.injectedRecommendation).toContain(RECOMMENDATION_BODY_PHRASE);
      for (const ref of pair.stableFiles) {
        expect(pair.injectedRecommendation).toContain(`@${ref.path}`);
      }
    }
  });

  it('every objective gate FAILS on the pristine tree (Gate 0 is meaningful, not vacuous)', () => {
    // A gate that already passes before the task is attempted could never
    // distinguish success from failure; DECIDED semantics require the pristine
    // state to fail. (The matching pass-with-solution check ran at authoring
    // time; solutions are deliberately not committed.)
    for (const pair of bundle.pairs) {
      const cwd = join(bundleRoot, pair.tree);
      const result = spawnSync(pair.gate.command, { shell: true, cwd, encoding: 'utf8' });
      expect(
        result.status,
        `${pair.pairId}: gate should fail pristine but exited ${result.status}`
      ).not.toBe(pair.gate.expectExitCode);
    }
  }, 60_000);
});

describe('corpus-schema bridge (#1080 addressability)', () => {
  const bundle = loadBundle();

  it('each pair derives exactly one control and one injected corpus task', () => {
    for (const pair of bundle.pairs) {
      const tasks = pairToCorpusTasks(pair);
      expect(tasks).toHaveLength(PROOF_PAIR_ARMS.length);
      expect(tasks.map((t) => t.id)).toEqual([
        armTaskId(pair.pairId, 'control'),
        armTaskId(pair.pairId, 'injected'),
      ]);
      // Both arms are the SAME task: identical instruction and gate.
      expect(tasks[0].instruction).toBe(tasks[1].instruction);
      expect(tasks[0].gate).toEqual(tasks[1].gate);
      expect(tasks[0].tags).toContain('arm:control');
      expect(tasks[1].tags).toContain('arm:injected');
    }
  });

  it('every derived task parses against the #1080 corpus schema unchanged', () => {
    for (const task of bundleToCorpusTasks(bundle)) {
      expect(parseCorpusTask(task)).toEqual(task);
    }
  });

  it('the flattened corpus view validates and is referenceable (taskId + gateKind)', () => {
    const tasks = bundleToCorpusTasks(bundle);
    expect(tasks).toHaveLength(bundle.pairs.length * 2);
    const result = validateCorpus(tasks);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    for (const task of tasks) {
      const ref = corpusTaskRef(task);
      expect(OBJECTIVE_GATE_KINDS).toContain(ref.gateKind);
      const parsed = parseArmTaskId(ref.taskId);
      expect(parsed).not.toBeNull();
      expect(bundle.pairs.some((p) => p.pairId === parsed?.pairId)).toBe(true);
    }
  });
});

describe('parser robustness (pure, total, deterministic)', () => {
  const valid = {
    pairId: 'sample-pair',
    title: 'A sample pair',
    taskShape: 'bugfix',
    wasteReason: 'stable-api',
    instruction: 'Fix the thing.',
    tree: 'pairs/sample-pair/tree',
    stableFiles: [{ path: 'src/core.mjs', symbols: ['core'] }],
    injectedRecommendation:
      '## Stable reference files\n\nReference these stable files instead of re-reading them each session:\n- @src/core.mjs — core',
    gate: { kind: 'test', command: 'node --test test.mjs', expectExitCode: 0 },
    tags: ['bugfix'],
  };

  it('accepts a valid pair and normalizes the gate default', () => {
    const pair = parseProofPair({ ...valid, gate: { kind: 'test', command: 'x' } });
    expect(pair).not.toBeNull();
    expect(pair?.gate.expectExitCode).toBe(0);
  });

  it('rejects malformed pairs (bad ids, missing markers, bad reasons, path escapes)', () => {
    expect(parseProofPair(null)).toBeNull();
    expect(parseProofPair({ ...valid, pairId: 'has--separator' })).toBeNull();
    expect(parseProofPair({ ...valid, pairId: 'Bad_Case' })).toBeNull();
    expect(parseProofPair({ ...valid, wasteReason: 'vibes' })).toBeNull();
    expect(parseProofPair({ ...valid, injectedRecommendation: 'pin some files' })).toBeNull();
    expect(parseProofPair({ ...valid, stableFiles: [] })).toBeNull();
    expect(
      parseProofPair({ ...valid, stableFiles: [{ path: '../escape.mjs', symbols: ['x'] }] })
    ).toBeNull();
    expect(parseProofPair({ ...valid, tree: '../outside' })).toBeNull();
    expect(parseProofPair({ ...valid, gate: { kind: 'vibes', command: 'x' } })).toBeNull();
    // Recommendation must cite every claimed stable file.
    expect(
      parseProofPair({ ...valid, stableFiles: [{ path: 'src/other.mjs', symbols: ['x'] }] })
    ).toBeNull();
  });

  it('bundle parser drops malformed pairs and de-duplicates by pairId (first wins)', () => {
    const bundle = parseProofPairBundle({
      bundle: 'b',
      preRegistrationRef: 'docs/x.md',
      detectorRef: 'src/y.ts',
      minDecidedPairs: 12,
      pairs: [valid, { ...valid, title: 'dup' }, { bad: true }],
    });
    expect(bundle).not.toBeNull();
    expect(bundle?.pairs.map((p) => p.title)).toEqual(['A sample pair']);
  });

  it('bundle parser rejects a malformed envelope', () => {
    expect(parseProofPairBundle(null)).toBeNull();
    expect(parseProofPairBundle({ bundle: 'b' })).toBeNull();
  });

  it('an undersized bundle fails validation against the pre-registered N', () => {
    const bundle = parseProofPairBundle({
      bundle: 'b',
      preRegistrationRef: 'docs/x.md',
      detectorRef: 'src/y.ts',
      minDecidedPairs: 12,
      pairs: [valid],
    });
    const result = validateProofPairBundle(bundle!);
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/requires >= 12/);
  });

  it('armTaskId and parseArmTaskId are inverses', () => {
    for (const arm of PROOF_PAIR_ARMS) {
      expect(parseArmTaskId(armTaskId('sample-pair', arm))).toEqual({
        pairId: 'sample-pair',
        arm,
      });
    }
    expect(parseArmTaskId('no-arm-suffix')).toBeNull();
    expect(parseArmTaskId('--control')).toBeNull();
  });
});
