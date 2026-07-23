#!/usr/bin/env node
// v0.6.0 review-phase audit — stage 2 (FILE): route verified findings JSON into
// specced sub-issues on the three gate epics, idempotently. Both Claude and Codex
// invoke this identically. See docs/audits/v060-review-phase-audit.md.
//
// Idempotency: each issue body carries `<!-- audit-finding: <key> -->`; the router
// searches open AND closed issues for that marker and refuses to double-file, so it
// is safe to re-run and to run concurrently across harnesses/windows. (Residual: a
// GitHub search-index latency window of a few minutes means two DIFFERENT runners
// filing the exact same key within that window could still race; batches are spaced
// by windows, and in-run dedup covers a single runner. This is documented, not hidden.)
//
// Usage:
//   node scripts/audits/file-findings.mjs --findings <path.json> \
//     [--handoff] [--dry-run] [--repo owner/name] \
//     [--vendor claude|codex] [--instance <id>] [--role coder|reviewer|main]
//
// Unit tests (pure helpers, network-free): scripts/audits/file-findings.test.mjs

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { GATES, DEFAULT_GATES, resolveGates } from './gates.config.mjs';

export const REPO = 'shpwrck/claude-history-dashboard';

// The gate registry (gates.config.mjs) is the single source of truth. LENS is a
// back-compat alias: gate key -> { epic, label, milestone, spec[, closed] }.
export const LENS = GATES;

// ---------------------------------------------------------------------------
// Pure helpers (network-free; unit-tested)
// ---------------------------------------------------------------------------

export function lensConfig(lens) {
  const c = LENS[lens];
  if (!c) throw new Error(`unknown lens ${JSON.stringify(lens)} (expected ${Object.keys(LENS).join(', ')})`);
  return c;
}

export function epicLabel(lens) {
  return `epic-${lensConfig(lens).epic}`;
}

// Display slug — bounded for readable labels. NOT used for the dedup key (its
// 60-char cap could collide distinct findings; see normalizeTitle/dedupKey).
export function slug(title) {
  return (
    String(title)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'finding'
  );
}

// Full, untruncated title normalization for the dedup key, so two findings whose
// titles share the same first 60 chars still get distinct keys.
export function normalizeTitle(title) {
  return String(title).toLowerCase().replace(/\s+/g, ' ').trim();
}

// Normalize a "path:line-range" evidence entry to just the path, for stable keying.
// Strip ONLY a trailing :line or :line-range — git allows ':' inside a filename, so
// removing from the first colon would collapse distinct files onto one key.
export function normalizePath(fileRef) {
  return String(fileRef).trim().replace(/:\d+(-\d+)?$/, '');
}

// The lexicographically-smallest normalized path — order-independent, so two harnesses
// citing the same evidence files in a different order produce the SAME dedup key.
export function primaryFile(finding) {
  const fs = (Array.isArray(finding.files) ? finding.files : []).filter(Boolean).map(normalizePath).sort();
  if (!fs.length) throw new Error(`finding "${finding.title}" has no files[]`);
  return fs[0];
}

// Stable dedup key: independent of line numbers and body wording, so re-audits of
// the same defect collapse to one issue.
export function dedupKey(finding) {
  const basis = `${finding.lens}\n${primaryFile(finding)}\n${normalizeTitle(finding.title)}`;
  return createHash('sha1').update(basis).digest('hex').slice(0, 12);
}

export function severityToPriority(sev) {
  switch (String(sev).toLowerCase()) {
    case 'critical':
    case 'high':
      return 'High';
    case 'medium':
      return 'Medium';
    case 'low':
      return 'Low';
    default:
      return 'Medium';
  }
}

export function cleanTitle(title) {
  return String(title).replace(/^\s*\[[^\]]+\]\s*/, '').trim();
}

export function signature({ vendor = 'claude', role = 'main', instance = 'unknown' } = {}) {
  const label = vendor.charAt(0).toUpperCase() + vendor.slice(1);
  const roleWord = role === 'main' ? '' : ` ${role}`;
  return (
    `<!-- agent-sig v1 vendor=${vendor} role=${role} instance=${instance} -->\n` +
    `Signed: ${label}${roleWord} (${instance})`
  );
}

// Returns an array of error strings; empty means fileable.
export function validateFinding(finding) {
  const errs = [];
  if (!LENS[finding && finding.lens]) errs.push(`bad lens ${JSON.stringify(finding && finding.lens)}`);
  if (!finding || !finding.title || !String(finding.title).trim()) errs.push('missing title');
  if (!finding || !Array.isArray(finding.files) || !finding.files.filter(Boolean).length) errs.push('missing files[]');
  else if (!finding.files.some((f) => /:\d/.test(String(f)))) errs.push('files[] has no path:line reference (need at least one, e.g. src/x.ts:12)');
  if (!finding || !finding.fix || !String(finding.fix).trim()) errs.push('missing fix');
  if (!finding || !finding.acceptance || !String(finding.acceptance).trim()) errs.push('missing acceptance');
  if (!finding || !['critical', 'high', 'medium', 'low'].includes(String(finding.severity).toLowerCase()))
    errs.push('missing/invalid severity (critical|high|medium|low)');
  if (!finding || finding.verified !== true) errs.push('not verified (verified !== true)');
  return errs;
}

export function labelsFor(finding, { handoff = false } = {}) {
  const base = [lensConfig(finding.lens).label, 'backlog', epicLabel(finding.lens)];
  return handoff ? [...base, 'groomed', 'for-agent'] : base;
}

export function buildBody(finding, { baseline, auditDate, key, sig }) {
  const { epic } = lensConfig(finding.lens);
  const where =
    finding.where && String(finding.where).trim()
      ? String(finding.where).trim()
      : finding.files.map((f) => `- \`${f}\``).join('\n');
  const priority = finding.priority || severityToPriority(finding.severity);
  const lines = [
    `Found by the v0.6.0 review-phase audit (${finding.lens} lens) — origin/master \`${baseline}\`, ${auditDate}.`,
    '',
    '**Where.**',
    where,
    '',
  ];
  if (finding.what && String(finding.what).trim()) {
    lines.push(`**What.** ${String(finding.what).trim()}`, '');
  }
  lines.push(
    `**Fix.** ${String(finding.fix).trim()}`,
    '',
    `**Acceptance.** ${String(finding.acceptance).trim()}`,
    '',
    `**Priority.** ${priority} (severity: ${String(finding.severity || 'n/a').toLowerCase()})`,
  );
  if (finding.verifyNote && String(finding.verifyNote).trim()) {
    lines.push('', `Verified vs \`${baseline}\`: ${String(finding.verifyNote).trim()}`);
  }
  lines.push('', `Part of the #${epic} review gate.`, '', `<!-- audit-finding: ${key} -->`, sig);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// gh integration (below the pure line)
// ---------------------------------------------------------------------------

function gh(args, { repo = REPO } = {}) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    env: { ...process.env, GH_REPO: repo },
  });
}

export function findExisting(key, { repo = REPO, runner = gh } = {}) {
  const out = runner(
    ['issue', 'list', '--state', 'all', '--search', `"audit-finding: ${key}" in:body`, '--json', 'number', '--limit', '5'],
    { repo },
  );
  const arr = JSON.parse(out || '[]');
  return arr.length ? arr[0].number : null;
}

function labelExists(name, { repo = REPO } = {}) {
  const out = gh(['label', 'list', '--search', name, '--json', 'name', '--limit', '50'], { repo });
  return JSON.parse(out || '[]').some((l) => l.name === name);
}

function ensureEpicLabel(lens, { repo = REPO, dryRun = false } = {}) {
  const name = epicLabel(lens);
  if (labelExists(name, { repo })) return name;
  if (dryRun) {
    console.log(`  [dry-run] would create label ${name}`);
    return name;
  }
  try {
    gh(['label', 'create', name, '--description', `Sub-issue of epic #${lensConfig(lens).epic}`, '--color', 'ededed'], { repo });
  } catch (e) {
    // A concurrent router may have created it between labelExists() and here.
    // Treat an already-exists race as success so overlapping batches stay resumable.
    if (!labelExists(name, { repo })) throw e;
  }
  return name;
}

function createIssue({ title, body, labels, milestone, repo = REPO, dryRun = false }) {
  if (dryRun) {
    console.log(`  [dry-run] would CREATE "${title}"  labels=${labels.join(',')}  milestone=${milestone}`);
    return null;
  }
  const out = gh(
    ['issue', 'create', '--title', title, '--body', body, '--milestone', milestone, ...labels.flatMap((l) => ['--label', l])],
    { repo },
  );
  const m = out.match(/\/issues\/(\d+)/);
  return m ? Number(m[1]) : null;
}

function isLinkedSubIssue(parent, childNumber, { repo = REPO } = {}) {
  const out = gh(['api', `repos/${repo}/issues/${parent}/sub_issues`, '--jq', '[.[].number]'], { repo });
  return JSON.parse(out || '[]').includes(Number(childNumber));
}

function addSubIssue(parent, childNumber, { repo = REPO, dryRun = false } = {}) {
  if (dryRun) {
    console.log(`  [dry-run] would link #${childNumber} as native sub-issue of #${parent}`);
    return;
  }
  const dbid = gh(['api', `repos/${repo}/issues/${childNumber}`, '--jq', '.id'], { repo }).trim();
  try {
    gh(['api', `repos/${repo}/issues/${parent}/sub_issues`, '-X', 'POST', '-F', `sub_issue_id=${dbid}`], { repo });
  } catch (e) {
    // Idempotent, but do NOT swallow real failures (the error message contains the
    // command, so a substring match on "sub_issue" would hide permission/outage/bad-id
    // errors). Tolerate ONLY when the link actually exists now; rethrow otherwise.
    if (!isLinkedSubIssue(parent, childNumber, { repo })) throw e;
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const a = { dryRun: false, handoff: false, repo: REPO, vendor: 'claude', role: 'main', instance: 'unknown' };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--dry-run') a.dryRun = true;
    else if (v === '--handoff') a.handoff = true;
    else if (v === '--findings') a.findings = argv[++i];
    else if (v === '--repo') a.repo = argv[++i];
    else if (v === '--vendor') a.vendor = argv[++i];
    else if (v === '--role') a.role = argv[++i];
    else if (v === '--instance') a.instance = argv[++i];
    else if (v === '--gates') a.gates = argv[++i];
    else throw new Error(`unknown arg ${v}`);
  }
  if (!a.findings) throw new Error('--findings <path.json> is required');
  return a;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.dryRun && (!opts.instance || opts.instance === 'unknown')) {
    throw new Error('--instance <id> is required for a non-dry run so every filed issue is attributable (agent-sig)');
  }
  const activeGates = resolveGates(opts.gates); // throws on an unknown gate name
  const doc = JSON.parse(readFileSync(opts.findings, 'utf8'));
  const baseline = doc.baseline;
  const auditDate = doc.auditDate;
  if (!baseline || !auditDate) throw new Error('findings JSON needs baseline and auditDate');
  const sig = signature({ vendor: opts.vendor, role: opts.role, instance: opts.instance });

  const findings = Array.isArray(doc.findings) ? doc.findings : [];
  console.log(
    `${opts.dryRun ? '[DRY-RUN] ' : ''}filing ${findings.length} finding(s) from ${opts.findings} ` +
      `(section=${doc.section}, baseline=${baseline}, handoff=${opts.handoff}, gates=${activeGates.join('+')})`,
  );

  const seenThisRun = new Set();
  const counts = { created: 0, skippedDup: 0, skippedInvalid: 0, skippedInRun: 0, skippedGate: 0 };

  for (const finding of findings) {
    const errs = validateFinding(finding);
    if (errs.length) {
      console.log(`  SKIP invalid "${finding && finding.title}": ${errs.join('; ')}`);
      counts.skippedInvalid++;
      continue;
    }
    if (!activeGates.includes(finding.lens)) {
      console.log(`  skip (gate "${finding.lens}" not in active set) "${finding.title}"`);
      counts.skippedGate++;
      continue;
    }
    const key = dedupKey(finding);
    if (seenThisRun.has(key)) {
      console.log(`  skip (dup in this batch) ${key} "${finding.title}"`);
      counts.skippedInRun++;
      continue;
    }
    seenThisRun.add(key);

    const existing = findExisting(key, { repo: opts.repo });
    if (existing) {
      // Repair a parent link a prior partial run may have left unset (idempotent),
      // so the epic's native rollup and gate-close checks stay complete.
      addSubIssue(lensConfig(finding.lens).epic, existing, { repo: opts.repo, dryRun: opts.dryRun });
      console.log(`  skip (already filed #${existing}; ensured epic link) ${key} "${finding.title}"`);
      counts.skippedDup++;
      continue;
    }

    const gate = lensConfig(finding.lens);
    if (gate.closed) {
      console.log(`  NOTE: gate "${finding.lens}" epic #${gate.epic} is marked closed — filing anyway (explicitly selected)`);
    }
    const title = cleanTitle(finding.title);
    const labels = labelsFor(finding, { handoff: opts.handoff });
    const body = buildBody(finding, { baseline, auditDate, key, sig });
    ensureEpicLabel(finding.lens, { repo: opts.repo, dryRun: opts.dryRun });
    const num = createIssue({ title, body, labels, milestone: gate.milestone, repo: opts.repo, dryRun: opts.dryRun });
    if (num) {
      addSubIssue(gate.epic, num, { repo: opts.repo, dryRun: opts.dryRun });
      console.log(`  created #${num} [${finding.lens}] ${title}`);
    }
    counts.created++;
  }

  console.log(
    `done: ${counts.created} created, ${counts.skippedDup} already-filed, ` +
      `${counts.skippedInRun} in-batch dups, ${counts.skippedGate} gate-inactive, ${counts.skippedInvalid} invalid`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
