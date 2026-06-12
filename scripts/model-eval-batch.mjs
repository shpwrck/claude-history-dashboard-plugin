import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import {
  buildModelEvalBatchSpec,
  buildFixtureBackedBatchSpec,
  generateEvalBatchesFromClusters,
  validateModelEvalBatchSpec,
} from '../src/lib/model-eval-batch.ts';
import { CURATED_CORPUS } from '../src/lib/model-eval-corpus.ts';
import { parseTaskShapeClusters } from '../src/lib/model-gap-clustering.ts';
import { CURRENT_MODEL_IDS } from '../src/lib/model-registry.ts';

function usage() {
  return [
    'Usage: node --import ./scripts/register-ts.mjs scripts/model-eval-batch.mjs --candidate=<model> [options]',
    '       node --import ./scripts/register-ts.mjs scripts/model-eval-batch.mjs --clusters=<file> [options]',
    '',
    'Options:',
    '  --candidate=<id>    Candidate model to compare. Repeatable or comma-separated.',
    '  --baseline=<id>     Baseline model. Repeatable or comma-separated. Defaults to current Opus/Sonnet/Haiku.',
    '  --corpus=<source>   shadow-calls | replay-history | curated-fixtures. Default: shadow-calls.',
    '  --clusters=<file>   Generate cluster-driven batch specs (#1084) from a task-shape',
    '                      clusters JSON file: an array of clusters, or an object',
    '                      { clusters, replayRunIds, shadowRunIds }. Fixtures come from the',
    '                      in-repo curated corpus; replay/shadow material is the intersection',
    '                      of each cluster with the provided run ids. One spec per',
    '                      cluster x corpus with matching material. Models derive from each',
    '                      cluster gap direction; not combinable with --candidate/--baseline/--corpus.',
    '  --limit=<n>         Max tasks to include. Default: 20.',
    '  --out=<dir>         Output directory. Default: .claude/model-evals.',
    '  --print            Print JSON to stdout instead of writing the artifact.',
  ].join('\n');
}

function valuesFor(args, name) {
  const prefix = `--${name}=`;
  return args
    .filter((arg) => arg.startsWith(prefix))
    .flatMap((arg) => arg.slice(prefix.length).split(','))
    .map((value) => value.trim())
    .filter(Boolean);
}

function valueFor(args, name) {
  const found = valuesFor(args, name);
  return found.length > 0 ? found[found.length - 1] : undefined;
}

function cleanRunIds(raw) {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((id) => typeof id === 'string').map((id) => id.trim()).filter(Boolean))];
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(usage());
  process.exit(0);
}

const candidates = valuesFor(args, 'candidate');
const baselines = valuesFor(args, 'baseline');
const corpus = valueFor(args, 'corpus');
const clustersPath = args
  .filter((arg) => arg.startsWith('--clusters='))
  .map((arg) => arg.slice('--clusters='.length).trim())
  .filter(Boolean)
  .pop();
const limitRaw = valueFor(args, 'limit');
const outDir = valueFor(args, 'out') ?? '.claude/model-evals';
const printOnly = args.includes('--print');
const limit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;

if (limitRaw && (!Number.isFinite(limit) || (limit ?? 0) <= 0)) {
  console.error('--limit must be a positive integer.');
  process.exit(1);
}

async function writeSpec(spec) {
  const outputPath = resolve(spec.output.path);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${outputPath}`);
}

try {
  if (clustersPath) {
    if (candidates.length > 0 || baselines.length > 0 || corpus) {
      throw new Error('--clusters cannot be combined with --candidate/--baseline/--corpus.');
    }
    let raw;
    try {
      raw = JSON.parse(await readFile(resolve(clustersPath), 'utf8'));
    } catch (cause) {
      throw new Error(
        `Could not read clusters file ${clustersPath}: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
    const isWrapped = raw && typeof raw === 'object' && !Array.isArray(raw);
    const clusters = parseTaskShapeClusters(isWrapped ? raw.clusters : raw);
    if (clusters.length === 0) {
      throw new Error(`No valid task-shape clusters in ${clustersPath}.`);
    }
    const corpora = {
      fixtures: CURATED_CORPUS,
      replayRunIds: cleanRunIds(isWrapped ? raw.replayRunIds : undefined),
      shadowRunIds: cleanRunIds(isWrapped ? raw.shadowRunIds : undefined),
    };
    const specs = generateEvalBatchesFromClusters(clusters, corpora, { limit, outDir });
    if (specs.length === 0) {
      throw new Error('No batch specs generated: no cluster had matching corpus material.');
    }
    for (const spec of specs) {
      const validation = validateModelEvalBatchSpec(spec);
      if (!validation.ok) {
        throw new Error(
          `Generated spec for ${spec.cluster?.clusterId ?? '?'} (${spec.corpus.source}) failed validation: ${validation.errors.join('; ')}`
        );
      }
    }
    if (printOnly) {
      process.stdout.write(`${JSON.stringify(specs, null, 2)}\n`);
    } else {
      for (const spec of specs) await writeSpec(spec);
    }
  } else {
    const batchInput = {
      candidates,
      baselines: baselines.length > 0
        ? baselines
        : [CURRENT_MODEL_IDS.opus, CURRENT_MODEL_IDS.sonnet, CURRENT_MODEL_IDS.haiku],
      corpus,
      limit,
      outDir,
    };
    const spec = corpus === 'curated-fixtures'
      ? buildFixtureBackedBatchSpec(batchInput, CURATED_CORPUS)
      : buildModelEvalBatchSpec(batchInput);
    const validation = validateModelEvalBatchSpec(spec);
    if (!validation.ok) {
      throw new Error(`Generated spec failed validation: ${validation.errors.join('; ')}`);
    }

    if (printOnly) {
      process.stdout.write(`${JSON.stringify(spec, null, 2)}\n`);
    } else {
      await writeSpec(spec);
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error('');
  console.error(usage());
  process.exit(1);
}
