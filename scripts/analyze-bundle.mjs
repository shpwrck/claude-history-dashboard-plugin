#!/usr/bin/env node
// Zero-dependency bundle-composition report (epic #1852, issue #1860).
//
// Attributes BUILT bytes to source modules by decoding each emitted chunk's
// sourcemap (`dist/assets/*.js` + sibling `.js.map`). No new dependency, no
// bundler plugin — it post-processes a sourcemap build. Run:
//
//   npx vite build --mode sample --sourcemap   # (or production for server)
//   node scripts/analyze-bundle.mjs --dist dist
//
// Flags:
//   --dist <dir>     dist root (default: dist)
//   --top  <n>       how many source groups to list (default: 25)
//   --chunk <name>   also print the per-source breakdown of one chunk (e.g. index)
//
// Attribution method mirrors source-map-explorer: for each generated line, the
// byte span between consecutive mapping segments is charged to that segment's
// source. It is an approximation (unmapped gaps are charged to "(unmapped)"),
// but more than accurate enough to find what dominates a chunk.

import { readdirSync, readFileSync, statSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const C2I = {};
for (let i = 0; i < B64.length; i++) C2I[B64[i]] = i;

function decodeVLQ(str) {
  const out = [];
  let shift = 0, value = 0;
  for (const c of str) {
    let int = C2I[c];
    if (int === undefined) continue;
    const cont = int & 32;
    int &= 31;
    value += int << shift;
    if (cont) {
      shift += 5;
    } else {
      const neg = value & 1;
      value >>= 1;
      out.push(neg ? -value : value);
      value = 0;
      shift = 0;
    }
  }
  return out;
}

function parseArgs(argv) {
  const out = { dist: 'dist', top: 25, chunk: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dist') out.dist = argv[++i];
    else if (argv[i] === '--top') out.top = Number(argv[++i]);
    else if (argv[i] === '--chunk') out.chunk = argv[++i];
  }
  return out;
}

function groupOf(source) {
  const s = source.replace(/^.*?\/node_modules\//, 'node_modules/');
  const nm = s.match(/node_modules\/((@[^/]+\/[^/]+)|([^/]+))/);
  if (nm) return nm[1];
  const src = s.match(/(?:^|\/)(src\/[^/]+\/[^/]+|src\/[^/]+)/);
  if (src) return src[1].endsWith('.ts') || src[1].endsWith('.tsx') ? src[1] : src[1];
  return s.replace(/^\.\.\//, '');
}

// Attribute a chunk's BYTES to its sources.
//
// Sourcemap columns are UTF-16 code-unit offsets, NOT byte offsets. Subtracting
// two columns therefore yields a character count, and any non-ASCII character in
// the emitted chunk made the per-group totals disagree with the on-disk UTF-8
// size this report compares them against (#3068). Each span is measured with
// Buffer.byteLength over the actual slice instead, the real newline byte is
// charged only where a newline exists, and the region before the first mapping
// on a line (plus any generated line the map does not cover) is charged to
// "(unmapped)" — so the attributed totals sum EXACTLY to the chunk byte length.
export function attributeChunkSource(code, map) {
  const codeLines = code.split('\n');
  const sources = map.sources || [];
  const bySource = new Map();
  const charge = (src, bytes) => {
    if (bytes <= 0) return;
    bySource.set(src, (bySource.get(src) || 0) + bytes);
  };
  let srcIdx = 0;
  const mappingLines = (map.mappings || '').split(';');
  for (let L = 0; L < codeLines.length; L++) {
    const line = codeLines[L];
    // split('\n') yields one more element than there are newlines: only the
    // elements before the last are actually followed by a newline byte.
    const newlineBytes = L < codeLines.length - 1 ? 1 : 0;
    const segs = (mappingLines[L] ?? '')
      .split(',')
      .filter(Boolean)
      .map(decodeVLQ);
    let genCol = 0;
    let prevGenCol = 0;
    let prevSrc = null;
    for (let i = 0; i < segs.length; i++) {
      const d = segs[i];
      genCol += d[0];
      // Charge the span of the PREVIOUS segment up to this segment's column.
      // Before the first segment there is no mapping — that leading run is
      // generated output no source claims.
      charge(
        prevSrc === null ? '(unmapped)' : prevSrc,
        Buffer.byteLength(line.slice(prevGenCol, genCol), 'utf8')
      );
      if (d.length >= 2) srcIdx += d[1];
      prevSrc = d.length >= 2 ? sources[srcIdx] : '(unmapped)';
      prevGenCol = genCol;
    }
    // Tail of the line (plus its newline) goes to the last segment's source, or
    // to "(unmapped)" when the line carries no mapping at all.
    charge(
      prevSrc === null ? '(unmapped)' : prevSrc,
      Buffer.byteLength(line.slice(prevGenCol), 'utf8') + newlineBytes
    );
  }
  return bySource;
}

export function attributeChunk(jsPath, mapPath) {
  return attributeChunkSource(
    readFileSync(jsPath, 'utf8'),
    JSON.parse(readFileSync(mapPath, 'utf8'))
  );
}

function fmt(n) {
  return `${(n / 1024).toFixed(1)} kB`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const assets = join(args.dist, 'assets');
  const jsFiles = readdirSync(assets).filter((f) => f.endsWith('.js'));
  const overall = new Map();
  const perChunk = [];
  let mapped = 0, total = 0;
  for (const f of jsFiles) {
    const jsPath = join(assets, f);
    const mapPath = jsPath + '.map';
    const size = statSync(jsPath).size;
    total += size;
    const base = f.replace(/-[A-Za-z0-9_-]{8}\.js$/, '');
    if (!existsSync(mapPath)) {
      perChunk.push({ name: base, file: f, size, groups: null });
      continue;
    }
    mapped += size;
    const bySource = attributeChunk(jsPath, mapPath);
    const groups = new Map();
    for (const [src, bytes] of bySource) {
      const g = groupOf(src);
      groups.set(g, (groups.get(g) || 0) + bytes);
      overall.set(g, (overall.get(g) || 0) + bytes);
    }
    perChunk.push({ name: base, file: f, size, groups });
  }

  console.log(`\n=== Bundle composition (${args.dist}) ===`);
  console.log(`total JS: ${fmt(total)} across ${jsFiles.length} chunks (sourcemapped: ${fmt(mapped)})\n`);

  console.log(`Top ${args.top} source groups by attributed built bytes (all chunks):`);
  const top = [...overall.entries()].sort((a, b) => b[1] - a[1]).slice(0, args.top);
  for (const [g, b] of top) console.log(`  ${fmt(b).padStart(10)}  ${g}`);

  console.log(`\nLargest chunks:`);
  for (const c of perChunk.sort((a, b) => b.size - a.size).slice(0, 12)) {
    console.log(`  ${fmt(c.size).padStart(10)}  ${c.name}`);
  }

  const target = args.chunk
    ? perChunk.find((c) => c.name === args.chunk)
    : perChunk.find((c) => c.name === 'index');
  if (target && target.groups) {
    console.log(`\nComposition of "${target.name}" chunk (${fmt(target.size)}):`);
    const g = [...target.groups.entries()].sort((a, b) => b[1] - a[1]).slice(0, args.top);
    for (const [name, b] of g) console.log(`  ${fmt(b).padStart(10)}  ${name}`);
  }
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (invokedDirectly) main();
