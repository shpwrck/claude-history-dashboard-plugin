#!/usr/bin/env node
// Zero-dependency bundle-composition report (epic #1852, issue #1860).
//
// Attributes BUILT bytes to source modules by decoding each emitted chunk's
// sourcemap (`dist/assets/*.js` + sibling `.js.map`). No new dependency, no
// bundler plugin — it post-processes a sourcemap build. Run:
//
//   npx vite build --mode spa --sourcemap   # (or --mode production for server)
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

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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

function attributeChunk(jsPath, mapPath) {
  const code = readFileSync(jsPath, 'utf8');
  const lineLens = code.split('\n').map((l) => l.length + 1);
  const map = JSON.parse(readFileSync(mapPath, 'utf8'));
  const sources = map.sources || [];
  const bySource = new Map();
  let srcIdx = 0;
  const lines = (map.mappings || '').split(';');
  for (let L = 0; L < lines.length; L++) {
    const lineLen = lineLens[L] || 0;
    const segs = lines[L].split(',').filter(Boolean).map(decodeVLQ);
    let genCol = 0;
    let prevGenCol = 0;
    let prevSrc = null;
    for (let i = 0; i < segs.length; i++) {
      const d = segs[i];
      genCol += d[0];
      // charge the span of the PREVIOUS segment up to this segment's column
      if (prevSrc !== null) {
        const span = Math.max(0, genCol - prevGenCol);
        bySource.set(prevSrc, (bySource.get(prevSrc) || 0) + span);
      }
      if (d.length >= 2) srcIdx += d[1];
      prevSrc = d.length >= 2 ? sources[srcIdx] : '(unmapped)';
      prevGenCol = genCol;
    }
    if (prevSrc !== null) {
      const span = Math.max(0, lineLen - prevGenCol);
      bySource.set(prevSrc, (bySource.get(prevSrc) || 0) + span);
    }
  }
  return bySource;
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

main();
