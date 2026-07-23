#!/usr/bin/env node
// Usage-aware, harness-neutral orchestrator for the review-phase audit
// (corrections 2 & 3 of docs/audits/v060-review-phase-audit.md).
//
// It reads the ledger resume state + BOTH harnesses' live plan usage, picks the
// next unaudited (section, gates) batch, and DELEGATES it to whichever harness has
// confirmed budget — sizing the batch to the remaining window. A stale/unreadable
// usage source is treated as ZERO budget (never fresh), which is why a broken Codex
// reading can never cause over-spend (see dashboard #3024 / shpwrck/claude #194).
//
// It doesn't matter where a stage runs: the per-gate spec + findings-JSON contract +
// the FILE router are harness-agnostic; this orchestrator just routes each batch to
// Claude or Codex and runs the same router on the result.
//
// Modes:
//   --plan  (default) print the routing decision; NO execution, NO mutation.
//   --run   dispatch the batch to the chosen harness, then run the FILE router.
//
// Usage:
//   node scripts/audits/orchestrate.mjs --baseline <sha> [--gates a,b] [--plan|--run]
//     [--ledger <path>] [--floor 12] [--full-batch 40] [--repo-dir <dir>]
//     [--usage-cmd "<node check-usage.mjs>"] [--handoff]
//
// Pure helpers (decideBudget, parseLedger, pendingBatches, planNext,
// buildDispatchArgv) are unit-tested in orchestrate.test.mjs; the live dispatch is
// the seam validated on the first real --run.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

import { DEFAULT_GATES, resolveGates, GATES } from './gates.config.mjs';

export const DEFAULT_USAGE_CMD = process.env.CHD_USAGE_CMD || `node ${join(homedir(), '.agents/skills/session-usage/scripts/check-usage.mjs')}`;
export const DEFAULT_LEDGER = 'docs/audits/v060-review-phase-audit.md';
export const HARNESSES = ['claude', 'codex'];

// ---------------------------------------------------------------------------
// Pure helpers (network-free; unit-tested)
// ---------------------------------------------------------------------------

// Turn a check-usage `--json` headers object into a budget verdict. ANY missing /
// non-finite field, or a `rejected` status, yields ZERO budget — a lying or absent
// source must never read as fresh.
export function decideBudget(headers) {
  if (!headers || typeof headers !== 'object') return { ok: false, leftPct: 0, w5: 0, w7: 0, reason: 'no headers' };
  const u5 = Number(headers['5h-utilization']);
  const u7 = Number(headers['7d-utilization']);
  if (!Number.isFinite(u5) || !Number.isFinite(u7)) return { ok: false, leftPct: 0, w5: 0, w7: 0, reason: 'unparseable utilization' };
  // A utilization outside [0,1] means the source changed units or is corrupt; fail
  // closed (zero budget) rather than letting e.g. -0.5 inflate w5 to 150 and oversize a batch.
  if (u5 < 0 || u5 > 1 || u7 < 0 || u7 > 1) return { ok: false, leftPct: 0, w5: 0, w7: 0, reason: 'utilization out of [0,1]' };
  const rejected = headers['5h-status'] === 'rejected' || headers['7d-status'] === 'rejected';
  const stale = headers['5h-stale'] === true || headers['7d-stale'] === true || headers.stale === true;
  const w5 = Math.max(0, (1 - u5) * 100);
  const w7 = Math.max(0, (1 - u7) * 100);
  const leftPct = Math.min(w5, w7); // binding window % left
  return { ok: !rejected && !stale, leftPct, w5, w7, reason: rejected ? 'rejected' : stale ? 'stale' : 'ok' };
}

// Extract the ledger's section table -> [{ section, files, gates: {name: 'done'|'pending'} }].
// The header row names each gate column (e.g. "security → #1932"); we map a column to
// a gate by the first known GATES key appearing in its header.
export function parseLedger(md, knownGates = Object.keys(GATES)) {
  const lines = String(md).split('\n');
  const rows = lines.filter((l) => /^\s*\|/.test(l)).map((l) => l.trim());
  const headerIdx = rows.findIndex((r) => /\bSection\b/i.test(r) && /\bFiles\b/i.test(r));
  if (headerIdx < 0) return [];
  const cells = (r) => r.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
  const header = cells(rows[headerIdx]);
  // column index -> gate name (for columns after Section, Files)
  const gateCols = {};
  header.forEach((h, i) => {
    if (i < 2) return;
    const g = knownGates.find((name) => h.includes(name));
    if (g) gateCols[i] = g;
  });
  const out = [];
  for (const r of rows.slice(headerIdx + 1)) {
    const c = cells(r);
    if (c.length < 3 || /^-+$/.test(c[0]) || c[0] === '' || !/\d/.test(c[1] || '')) continue;
    const gates = {};
    for (const [i, name] of Object.entries(gateCols)) {
      const v = c[Number(i)] || '';
      gates[name] = /^DONE/i.test(v) ? 'done' : 'pending';
    }
    out.push({ section: c[0], files: Number((c[1] || '').replace(/[^\d]/g, '')) || 0, gates });
  }
  return out;
}

// Sections that still have >=1 ACTIVE gate not marked done, with the pending gate list.
export function pendingBatches(sections, activeGates) {
  const out = [];
  for (const s of sections) {
    const pend = activeGates.filter((g) => (s.gates[g] || 'pending') !== 'done');
    if (pend.length) out.push({ section: s.section, files: s.files, gates: pend });
  }
  return out;
}

// Size a batch to the remaining SESSION (5h) window: never more than half of it.
export function sizeBatch(w5Pct, fullBatchFiles) {
  return Math.max(1, Math.floor(fullBatchFiles * (Math.max(0, w5Pct) / 100) * 0.5));
}

// The heart of corrections 2 & 3: choose the next batch + harness, or stop.
export function planNext({ sections, activeGates, usage, floorPct = 12, fullBatchFiles = 40 }) {
  const pend = pendingBatches(sections, activeGates);
  if (!pend.length) return { stop: true, reason: 'all sections audited for the active gates' };
  const candidates = HARNESSES.map((h) => ({ harness: h, u: usage[h] || { ok: false, leftPct: 0, w5: 0 } }))
    .filter((c) => c.u.ok && c.u.leftPct >= floorPct)
    .sort((a, b) => b.u.leftPct - a.u.leftPct);
  if (!candidates.length) {
    return { stop: true, reason: `no harness has budget >= floor ${floorPct}% (usage-aware halt)` };
  }
  const chosen = candidates[0];
  const batch = pend[0];
  return {
    stop: false,
    harness: chosen.harness,
    section: batch.section,
    gates: batch.gates,
    maxFiles: sizeBatch(chosen.u.w5, fullBatchFiles),
    remaining: pend.length,
    usage: chosen.u,
  };
}

// Ledger section label -> { include: git ls-tree pathspecs, exclude: path prefixes }.
// The orchestrator enumerates with ls-tree over `include` then JS-filters `exclude` —
// NOT git `:(exclude)` pathspec magic, which `git ls-tree` does not support. Sections
// with no form ("root" = top-level files only, and the mixed data/tools/bin bucket)
// are absent and require an explicit --files list. resolveSectionSpec returns null then.
export const SECTION_SPECS = {
  'scripts/': { include: ['scripts/'] },
  'src/lib/detectors': { include: ['src/lib/detectors/'] },
  'src/components': { include: ['src/components/'] },
  'docs/': { include: ['docs/'] },
  'fixtures/': { include: ['fixtures/'] },
  'e2e/': { include: ['e2e/'] },
  '.github/': { include: ['.github/'] },
  'probaitio-operator/': { include: ['probaitio-operator/'] },
  'deploy/': { include: ['deploy/'] },
  'src/lib (non-detectors)': { include: ['src/lib/'], exclude: ['src/lib/detectors/'] },
  'src (rest)': { include: ['src/'], exclude: ['src/lib/', 'src/components/'] },
};

export function resolveSectionSpec(section) {
  return SECTION_SPECS[section] || null;
}

// Drop files under any excluded prefix (JS-side, since ls-tree can't exclude).
export function filterFiles(files, exclude = []) {
  return files.filter((f) => !exclude.some((p) => String(f).startsWith(p)));
}

// POSIX single-quote escape (wrap in '...'; embedded ' -> '\'') so a filename or path
// with shell metacharacters cannot break out of an interpolated command argument.
export const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

// Build the per-batch instruction the chosen harness executes (harness-neutral text).
// The orchestrator has already enumerated and sliced the section, so it passes the
// EXPLICIT file list — the worker never runs ls-tree, which removes pathspec/exclude/
// quoting hazards from the prompt entirely.
export function buildPrompt({ section, gates, baseline, repoDir, findingsPath, auditDate, files }) {
  const specs = gates.map((g) => `- ${g}: ${GATES[g] ? GATES[g].spec : g}`).join('\n');
  const fileList = (files || []).map((f) => `  ${f}`).join('\n');
  return [
    `Audit these ${(files || []).length} file(s) in the "${section}" section at origin/master ${baseline}, for these gates ONLY:`,
    specs,
    ``,
    `Files (audit EXACTLY these — do not list, add, or substitute others):`,
    fileList,
    ``,
    `Read each AT the baseline with: git -C ${shq(repoDir)} show <ARG>, where <ARG> is ${baseline}:<file> passed as ONE POSIX-shell-escaped argument (single-quote the whole thing; turn any embedded ' into '\\''). A filename with metacharacters must NEVER execute. Most files have zero findings — that is correct.`,
    `Only report REAL, current defects with concrete file:line evidence, verified against ${baseline}.`,
    ``,
    `Write a findings JSON to ${findingsPath} matching docs/audits/v060-review-phase-audit.md's contract`,
    `(baseline="${baseline}", auditDate="${auditDate}", section="${section}", each finding { lens (one of the gates above),`,
    `severity, title, files[], where, what, fix, acceptance, priority, verified:true, verifyNote }). Do NOT file anything;`,
    `the orchestrator runs the router.`,
  ].join('\n');
}

// Pure command construction for dispatch (unit-tested); the spawn happens in run().
export function buildDispatchArgv({ harness, promptPath }) {
  if (harness === 'claude') return { file: 'claude', args: ['-p', `@${promptPath}`] };
  if (harness === 'codex') return { file: 'codex', args: ['exec', `@${promptPath}`] };
  throw new Error(`unknown harness ${harness}`);
}

// ---------------------------------------------------------------------------
// I/O (below the pure line)
// ---------------------------------------------------------------------------

function readUsage(source, { cmd = DEFAULT_USAGE_CMD, runner } = {}) {
  try {
    const run = runner || (() => {
      const parts = cmd.split(/\s+/);
      return execFileSync(parts[0], [...parts.slice(1), '--source', source, '--json'], { encoding: 'utf8' });
    });
    return decideBudget(JSON.parse(run(source)));
  } catch (e) {
    return { ok: false, leftPct: 0, w5: 0, w7: 0, reason: `usage read failed: ${e && e.message ? e.message : e}` };
  }
}

export function parseArgs(argv) {
  const a = { mode: 'plan', ledger: DEFAULT_LEDGER, floor: 12, fullBatch: 40, repoDir: process.cwd(), handoff: false, instance: 'orchestrator' };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--plan') a.mode = 'plan';
    else if (v === '--run') a.mode = 'run';
    else if (v === '--baseline') a.baseline = argv[++i];
    else if (v === '--gates') a.gates = argv[++i];
    else if (v === '--ledger') a.ledger = argv[++i];
    else if (v === '--floor') a.floor = Number(argv[++i]);
    else if (v === '--full-batch') a.fullBatch = Number(argv[++i]);
    else if (v === '--repo-dir') a.repoDir = argv[++i];
    else if (v === '--usage-cmd') a.usageCmd = argv[++i];
    else if (v === '--audit-date') a.auditDate = argv[++i];
    else if (v === '--files') a.files = argv[++i];
    else if (v === '--instance') a.instance = argv[++i];
    else if (v === '--handoff') a.handoff = true;
    else throw new Error(`unknown arg ${v}`);
  }
  if (!a.baseline) throw new Error('--baseline <origin/master sha> is required');
  return a;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const activeGates = resolveGates(opts.gates);
  const sections = parseLedger(readFileSync(opts.ledger, 'utf8'));
  const usage = {};
  for (const h of HARNESSES) usage[h] = readUsage(h, { cmd: opts.usageCmd || DEFAULT_USAGE_CMD });

  console.log(`orchestrate [${opts.mode}] gates=${activeGates.join('+')} baseline=${opts.baseline}`);
  for (const h of HARNESSES) {
    const u = usage[h];
    console.log(`  usage ${h}: ${u.ok ? `${u.leftPct.toFixed(0)}% left (5h ${u.w5.toFixed(0)}%)` : `UNUSABLE -> 0% (${u.reason})`}`);
  }

  const plan = planNext({ sections, activeGates, usage, floorPct: opts.floor, fullBatchFiles: opts.fullBatch });
  if (plan.stop) {
    console.log(`STOP: ${plan.reason}`);
    return;
  }
  console.log(
    `NEXT: audit "${plan.section}" for [${plan.gates.join(', ')}] on ${plan.harness} ` +
      `(maxFiles=${plan.maxFiles}; ${plan.remaining} section(s) pending)`,
  );

  if (opts.mode !== 'run') {
    console.log('(--plan: no execution. Re-run with --run to dispatch.)');
    return;
  }

  // --run: dispatch to the chosen harness, then file via the router.
  if (!opts.instance || opts.instance === 'orchestrator') {
    throw new Error('--instance <unique id> is required for --run so every filed batch is attributable (the default is not unique)');
  }

  // Enumerate the section's files OURSELVES (ls-tree over include-paths, JS-filter the
  // exclude-prefixes — git ls-tree has no :(exclude) magic) so completeness is
  // authoritative and never depends on a worker voluntarily returning remainingFiles.
  // --files overrides the section mapping (and covers unmapped sections like "root").
  let allFiles;
  if (opts.files) {
    allFiles = opts.files.split(',').map((s) => s.trim()).filter(Boolean);
  } else {
    const spec = resolveSectionSpec(plan.section);
    if (!spec) {
      throw new Error(`section "${plan.section}" has no path mapping (e.g. "root" = top-level files only). Pass --files <comma,list>.`);
    }
    const listed = execFileSync('git', ['-C', opts.repoDir, 'ls-tree', '-r', '--name-only', opts.baseline, '--', ...spec.include], { encoding: 'utf8' })
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    allFiles = filterFiles(listed, spec.exclude || []);
  }
  if (!allFiles.length) {
    console.log(`STOP: "${plan.section}" has no files to audit at ${opts.baseline}.`);
    return;
  }
  const batch = allFiles.slice(0, plan.maxFiles);
  const remainder = allFiles.slice(plan.maxFiles);

  // The router rejects an empty auditDate; default to today (plain Node, Date is fine here).
  const auditDate = opts.auditDate || new Date().toISOString().slice(0, 10);
  const safe = plan.section.replace(/[^a-z0-9]+/gi, '-');
  const findingsPath = `docs/audits/findings/${safe}-${opts.baseline}.json`;
  const promptPath = `/tmp/audit-${safe}-${opts.baseline}.txt`;
  mkdirSync(dirname(findingsPath), { recursive: true }); // the worker writes here; create it first
  rmSync(findingsPath, { force: true }); // clear any stale artifact from a prior partial run so we only file THIS batch
  writeFileSync(
    promptPath,
    buildPrompt({ section: plan.section, gates: plan.gates, baseline: opts.baseline, repoDir: opts.repoDir, findingsPath, auditDate, files: batch }),
  );
  const { file, args } = buildDispatchArgv({ harness: plan.harness, promptPath });
  console.log(`dispatching ${batch.length} of ${allFiles.length} file(s) in "${plan.section}" to ${file}`);
  execFileSync(file, args, { stdio: 'inherit' });
  if (!existsSync(findingsPath)) {
    throw new Error(`worker did not produce ${findingsPath} — aborting before filing (nothing to file; the stale artifact was cleared).`);
  }
  const routerArgs = ['scripts/audits/file-findings.mjs', '--findings', findingsPath, '--gates', plan.gates.join(','), '--vendor', plan.harness, '--instance', opts.instance];
  if (opts.handoff) routerArgs.push('--handoff');
  console.log(`filing: node ${routerArgs.join(' ')}`);
  execFileSync('node', routerArgs, { stdio: 'inherit' });

  // Completeness is computed HERE (we enumerated), not inferred from the worker.
  if (remainder.length) {
    const cont =
      `node scripts/audits/orchestrate.mjs --baseline ${opts.baseline} --run --gates ${plan.gates.join(',')} ` +
      `--instance ${opts.instance}${opts.handoff ? ' --handoff' : ''} --files ${remainder.join(',')}`;
    console.log(`PARTIAL: ${batch.length}/${allFiles.length} file(s) audited in "${plan.section}". Do NOT mark the ledger row done. Continue with:\n  ${cont}`);
  } else {
    console.log(`batch complete (${batch.length} file(s)) — mark "${plan.section}" [${plan.gates.join(',')}] done in the ledger, then re-run for the next batch.`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
