#!/usr/bin/env node
/**
 * Doc-neighborhood agent-inject producer (#2322 / ADR 0007 host-side artifact).
 *
 * Given a TASK ANCHOR (a changed file path, a GitHub issue number, or a doc
 * slug), walk a repo's own Markdown with `buildDocGraph` (#2257) and emit the
 * relevant doc NEIGHBORHOOD (#2263) as an agent-inject payload — the ranked doc
 * cluster the agent can self-serve plus the #1934 ambiguity-trigger signal for
 * #2202. It prints the injection JSON to stdout.
 *
 * This runs HOST-SIDE (where the repo + node_modules + the register-ts loader
 * exist), exactly like `repo-map-generate.mjs` — the runtime container never
 * walks source (ADR 0007). It is the ADR-0007 producer half of the same pattern
 * repo-map uses; there is no new server route.
 *
 * GATING (inject nothing, log nothing): when the graph is empty / the anchor
 * resolves to no seed / the cluster is empty, it prints NOTHING and exits 0, so
 * a caller (e.g. the `doc_neighborhood` MCP tool) stays silent.
 *
 * Usage (one anchor required):
 *   node --import ./scripts/register-ts.mjs scripts/doc-neighborhood-inject.mjs \
 *     (--file <path> | --issue <n> | --doc <slug>) [--root <dir>] \
 *     [--max-distance <n>] [--max-nodes <n>] [--now <iso>] [--status-key <k>]
 * `--root` defaults to the current working directory (the repo the agent is in).
 *
 * The `.ts` modules are dynamic-imported so they resolve under the register-ts
 * loader, exactly like ingest.mjs loads the `parse-*.ts` modules.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => argv[++i];
    switch (a) {
      case '--file': opts.file = take(); break;
      case '--issue': opts.issue = take(); break;
      case '--doc': opts.doc = take(); break;
      case '--root': opts.root = take(); break;
      case '--max-distance': opts.maxDistance = Number(take()); break;
      case '--max-nodes': opts.maxNodes = Number(take()); break;
      case '--now': opts.now = take(); break;
      case '--status-key': opts.statusKey = take(); break;
      case '-h':
      case '--help': opts.help = true; break;
      default:
        // Unknown flag — surface it rather than silently ignoring.
        throw new Error(`unknown argument: ${a}`);
    }
  }
  return opts;
}

/** Build a #2263 NeighborhoodAnchor from the parsed args (exactly one anchor). */
function anchorFrom(opts) {
  const kinds = [];
  if (opts.file != null) kinds.push({ kind: 'file', path: String(opts.file) });
  if (opts.issue != null) kinds.push({ kind: 'issue', issue: Number(opts.issue) });
  if (opts.doc != null) kinds.push({ kind: 'doc', slug: String(opts.doc) });
  if (kinds.length !== 1) {
    throw new Error('exactly one of --file / --issue / --doc is required');
  }
  const anchor = kinds[0];
  if (anchor.kind === 'issue' && !Number.isFinite(anchor.issue)) {
    throw new Error('--issue must be a number');
  }
  return anchor;
}

const USAGE =
  'Usage: node --import ./scripts/register-ts.mjs scripts/doc-neighborhood-inject.mjs ' +
  '(--file <path> | --issue <n> | --doc <slug>) [--root <dir>] ' +
  '[--max-distance <n>] [--max-nodes <n>] [--now <iso>] [--status-key <k>]';

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n${USAGE}\n`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  let anchor;
  try {
    anchor = anchorFrom(opts);
  } catch (err) {
    process.stderr.write(`${err.message}\n${USAGE}\n`);
    process.exit(2);
  }

  const root = resolve(opts.root ?? process.cwd());

  // Dynamic-import the .ts modules under the register-ts loader (like ingest.mjs).
  const { buildDocGraph } = await import(
    join(PROJECT_DIR, 'src', 'lib', 'parse-docs.ts')
  );
  const { buildDocNeighborhoodInjection } = await import(
    join(PROJECT_DIR, 'src', 'lib', 'doc-neighborhood-inject.ts')
  );

  const graph = buildDocGraph(root);

  const injectOptions = {};
  if (Number.isFinite(opts.maxDistance)) injectOptions.maxDistance = opts.maxDistance;
  if (Number.isFinite(opts.maxNodes)) injectOptions.maxNodes = opts.maxNodes;
  if (opts.now != null) injectOptions.now = opts.now;
  if (opts.statusKey != null) injectOptions.statusKey = opts.statusKey;

  const injection = buildDocNeighborhoodInjection(graph, anchor, injectOptions);

  // GATE: empty / no-graph / unresolved / empty-cluster -> inject nothing, log
  // nothing. A caller reads empty stdout as "no neighborhood".
  if (injection === null) return;

  process.stdout.write(JSON.stringify(injection));
}

main().catch((err) => {
  process.stderr.write(`doc-neighborhood-inject failed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
