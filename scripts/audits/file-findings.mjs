#!/usr/bin/env node
// Review-phase audit — stage 2 (FILE): route verified findings JSON into
// specced sub-issues on the configured gate epics, idempotently. Both Claude and Codex
// invoke this identically. See docs/audits/v060-review-phase-audit.md.
//
// Idempotency: each issue body carries `<!-- audit-finding: <key> -->`; the router
// searches open AND closed issue bodies/comments for that marker and refuses to double-file, so it
// is safe to re-run and to run concurrently across harnesses/windows. (Residual: a
// GitHub search-index latency window of a few minutes means two DIFFERENT runners
// filing the exact same key within that window could still race; batches are spaced
// by windows, and in-run dedup covers a single runner. This is documented, not hidden.)
//
// Usage:
//   node scripts/audits/file-findings.mjs --findings <path.json> \
//     [--result <path.json>] [--handoff] [--dry-run] [--repo owner/name] \
//     [--vendor claude|codex] [--instance <id>] [--role coder|reviewer|main]
//
// Unit tests (pure helpers, network-free): scripts/audits/file-findings.test.mjs

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { isAbsolute, relative } from 'node:path';

import { GATES, DEFAULT_GATES, resolveGates } from './gates.config.mjs';

export const REPO = 'shpwrck/claude-history-dashboard';
export const SUB_ISSUE_LIMIT = 100;
// Reserve ten direct gate slots for overflow rollups before GitHub's hard
// 100-sub-issue ceiling. Each rollup can hold another 100 individual findings.
export const DIRECT_GATE_FINDING_LIMIT = 90;
export const MAX_SUB_ISSUE_DEPTH = 8;

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
export function parseEvidenceRef(fileRef) {
  const raw = String(fileRef).trim();
  const match = raw.match(/^(.*):(\d+)(?:-(\d+))?$/);
  if (!match || !match[1]) return null;
  const start = Number(match[2]);
  const end = match[3] ? Number(match[3]) : start;
  if (!Number.isInteger(start) || start < 1 || !Number.isInteger(end) || end < start) {
    return null;
  }
  return { path: match[1], start, end };
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
export function sanitizeIssueText(value) {
  return String(value)
    .replace(/<!--/g, '&lt;!--')
    .replace(/-->/g, '--&gt;')
    .replace(/@(?=[A-Za-z0-9_])/g, '@\u200b');
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
  else {
    const invalidRefs = finding.files.filter((fileRef) => !parseEvidenceRef(fileRef));
    if (invalidRefs.length) {
      errs.push(`every files[] entry needs a trailing path:line reference: ${invalidRefs.join(', ')}`);
    }
  }
  if (!finding || !finding.fix || !String(finding.fix).trim()) errs.push('missing fix');
  if (!finding || !finding.acceptance || !String(finding.acceptance).trim()) errs.push('missing acceptance');
  if (!finding || !['critical', 'high', 'medium', 'low'].includes(String(finding.severity).toLowerCase()))
    errs.push('missing/invalid severity (critical|high|medium|low)');
  if (!finding || finding.verified !== true) errs.push('not verified (verified !== true)');
  const subtractionFields = ['cut', 'blastRadius', 'keepIf', 'reversibility'];
  if (finding && finding.lens === 'subtraction') {
    if (
      !Array.isArray(finding.cut)
      || finding.cut.length === 0
      || finding.cut.some((item) => typeof item !== 'string' || !item.trim())
      || finding.cut.some((item, index, items) => items.indexOf(item) !== index)
    ) {
      errs.push('subtraction cut must be a nonempty array of unique nonempty strings');
    }
    if (
      !Array.isArray(finding.blastRadius)
      || finding.blastRadius.some((item) => typeof item !== 'string' || !item.trim())
      || finding.blastRadius.some((item, index, items) => items.indexOf(item) !== index)
    ) {
      errs.push('subtraction blastRadius must be an array of unique nonempty strings (or [] for none)');
    }
    for (const field of ['keepIf', 'reversibility']) {
      if (typeof finding[field] !== 'string' || !finding[field].trim()) {
        errs.push(`subtraction ${field} must be a nonempty string`);
      }
    }
  } else if (finding) {
    for (const field of subtractionFields) {
      if (Object.hasOwn(finding, field)) {
        errs.push(`${field} is only valid for the subtraction lens`);
      }
    }
  }
  return errs;
}

export function labelsFor(finding, { handoff = false } = {}) {
  const base = [lensConfig(finding.lens).label, 'backlog', epicLabel(finding.lens)];
  return handoff ? [...base, 'groomed', 'for-agent'] : base;
}

function subtractionBodyLines(finding) {
  if (finding.lens !== 'subtraction') return [];
  return [
    '**Cut.**',
    ...finding.cut.map((item) => `- \`${sanitizeIssueText(String(item).trim())}\``),
    '',
    '**Blast radius.**',
    ...(finding.blastRadius.length
      ? finding.blastRadius.map((item) => `- ${sanitizeIssueText(String(item).trim())}`)
      : ['- None named.']),
    '',
    `**Keep if.** ${sanitizeIssueText(String(finding.keepIf).trim())}`,
    '',
    `**Reversibility.** ${sanitizeIssueText(String(finding.reversibility).trim())}`,
  ];
}

export function buildBody(finding, { baseline, auditDate, key, sig }) {
  const { epic, milestone } = lensConfig(finding.lens);
  const where = finding.files
    .map((fileRef) => `- \`${sanitizeIssueText(fileRef)}\``).join('\n');
  const priority = finding.priority || severityToPriority(finding.severity);
  const lines = [
    `Found by the ${milestone} review-phase audit (${finding.lens} lens) — origin/master \`${baseline}\`, ${auditDate}.`,
    '',
    '**Where.**',
    where,
    '',
  ];
  if (finding.what && String(finding.what).trim()) {
    lines.push(`**What.** ${sanitizeIssueText(String(finding.what).trim())}`, '');
  }
  const subtractionLines = subtractionBodyLines(finding);
  if (subtractionLines.length) {
    lines.push(...subtractionLines, '');
  }
  lines.push(
    `**Fix.** ${sanitizeIssueText(String(finding.fix).trim())}`,
    '',
    `**Acceptance.** ${sanitizeIssueText(String(finding.acceptance).trim())}`,
    '',
    `**Priority.** ${priority} (severity: ${String(finding.severity || 'n/a').toLowerCase()})`,
  );
  if (finding.verifyNote && String(finding.verifyNote).trim()) {
    lines.push('', `Verified vs \`${baseline}\`: ${sanitizeIssueText(String(finding.verifyNote).trim())}`);
  }
  lines.push('', `Part of the #${epic} review gate.`, '', `<!-- audit-finding: ${key} -->`, sig);
  return lines.join('\n');
}
export function buildRegressionComment(finding, { baseline, auditDate, sig }) {
  const { milestone } = lensConfig(finding.lens);
  const where = finding.files
    .map((fileRef) => `- \`${sanitizeIssueText(fileRef)}\``).join('\n');
  const lines = [
    `Reproduced by the ${milestone} review-phase audit at origin/master \`${baseline}\` on ${auditDate}.`,
    '',
    '**Where.**',
    where,
  ];
  if (finding.what && String(finding.what).trim()) {
    lines.push('', `**What.** ${sanitizeIssueText(String(finding.what).trim())}`);
  }
  const subtractionLines = subtractionBodyLines(finding);
  if (subtractionLines.length) {
    lines.push('', ...subtractionLines);
  }
  lines.push(
    '',
    `Verified vs \`${baseline}\`: ${sanitizeIssueText(String(finding.verifyNote).trim())}`,
    '',
    sig,
  );
  return lines.join('\n');
}


// Stable result shape consumed by the orchestrator. Every category carries the
// same four identity fields, including nulls for an invalid/unfiled finding.
export function auditRollupMarker(lens, baseline) {
  return `audit-rollup: ${lensConfig(lens).epic}:${baseline}`;
}

export function buildAuditRollupBody(lens, { baseline, auditDate, sig }) {
  const { epic, milestone } = lensConfig(lens);
  return [
    `Continuation container for verified ${milestone} ${lens} audit findings at origin/master \`${baseline}\` (${auditDate}).`,
    '',
    `GitHub permits at most ${SUB_ISSUE_LIMIT} direct sub-issues per parent. Individual findings nested here remain under the #${epic} release-gate hierarchy and keep the \`epic-${epic}\` label.`,
    '',
    '**Close when.** Every child finding is closed or explicitly moved to a later milestone.',
    '',
    `Part of the #${epic} review gate.`,
    '',
    `<!-- ${auditRollupMarker(lens, baseline)} -->`,
    sig,
  ].join('\n');
}

export function selectAuditParent({
  epic,
  directChildCount,
  rollups = [],
}) {
  if (!Number.isInteger(epic) || epic < 1) throw new Error('epic must be a positive integer');
  if (!Number.isInteger(directChildCount) || directChildCount < 0) {
    throw new Error('directChildCount must be a nonnegative integer');
  }
  if (directChildCount < DIRECT_GATE_FINDING_LIMIT) {
    return { parent: epic, createRollup: false };
  }
  for (const rollup of rollups) {
    if (
      rollup
      && Number.isInteger(rollup.number)
      && rollup.number > 0
      && String(rollup.state || 'OPEN').toUpperCase() === 'OPEN'
      && Number.isInteger(rollup.childCount)
      && rollup.childCount >= 0
      && rollup.childCount < SUB_ISSUE_LIMIT
    ) {
      return { parent: rollup.number, createRollup: false };
    }
  }
  if (directChildCount >= SUB_ISSUE_LIMIT) {
    throw new Error(
      `gate #${epic} has reached GitHub's ${SUB_ISSUE_LIMIT}-sub-issue limit without a usable audit rollup`,
    );
  }
  return { parent: null, createRollup: true };
}

export function resultEntry(finding, { key, number = null, reason } = {}) {
  const lens = finding && finding.lens != null ? finding.lens : null;
  const cleanedTitle =
    finding && finding.title != null && String(finding.title).trim()
      ? cleanTitle(finding.title) || null
      : null;
  let resolvedKey = key || null;
  if (
    !resolvedKey &&
    finding &&
    LENS[finding.lens] &&
    finding.title &&
    String(finding.title).trim() &&
    Array.isArray(finding.files) &&
    finding.files.filter(Boolean).length
  ) {
    resolvedKey = dedupKey(finding);
  }
  const resolvedNumber =
    number != null && Number.isInteger(Number(number)) && Number(number) > 0
      ? Number(number)
      : null;
  const entry = { lens, key: resolvedKey, title: cleanedTitle, number: resolvedNumber };
  if (reason) entry.reason = reason;
  return entry;
}

// ---------------------------------------------------------------------------
// gh integration (below the pure line)
// ---------------------------------------------------------------------------

export function gh(args, { repo = REPO, runner = execFileSync } = {}) {
  return runner('gh', args, {
    encoding: 'utf8',
    // Native sub-issue responses repeat the gate milestone and other issue
    // metadata for every child. A gate with ~65 children already exceeds
    // Node's 1 MiB execFileSync default, so leave enough room for GitHub's
    // 100-child hard limit without killing an otherwise successful request.
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, GH_REPO: repo },
  });
}

export function validateEvidenceAtBaseline(
  finding,
  { baseline, repoDir = process.cwd(), runner = execFileSync } = {},
) {
  if (!/^[0-9a-f]{40}$/.test(baseline || '')) {
    return ['baseline must be a full 40-character commit SHA'];
  }
  const errors = [];
  for (const fileRef of finding.files || []) {
    const ref = parseEvidenceRef(fileRef);
    if (!ref) continue;
    let content;
    try {
      content = runner(
        'git',
        ['-C', repoDir, 'show', `${baseline}:${ref.path}`],
        { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
      );
    } catch (error) {
      errors.push(`${fileRef} is not readable at ${baseline}: ${error.message}`);
      continue;
    }
    if (content.includes('\0')) {
      errors.push(`${fileRef} points into a binary file`);
      continue;
    }
    const lines = content.split(/\r?\n/);
    if (lines.at(-1) === '') lines.pop();
    if (ref.end > lines.length) {
      errors.push(`${fileRef} exceeds the baseline file's ${lines.length} lines`);
    }
  }

  return errors;
}

export function findExisting(key, { repo = REPO, runner = gh } = {}) {
  const out = runner(
    ['issue', 'list', '--state', 'all', '--search', `"audit-finding: ${key}" in:body,comments`, '--json', 'number,state', '--limit', '5'],
    { repo },
  );
  const arr = JSON.parse(out || '[]');
  const preferred = arr.find((issue) => String(issue.state).toUpperCase() === 'OPEN') || arr[0];
  return preferred
    ? { number: Number(preferred.number), state: String(preferred.state || 'OPEN').toUpperCase() }
    : null;
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
function restoreClosedIssue({ number, comment, labels, milestone, repo = REPO }) {
  gh(['issue', 'reopen', String(number)], { repo });
  gh(['issue', 'edit', String(number), '--milestone', milestone, ...labels.flatMap((label) => ['--add-label', label])], { repo });
  gh(['issue', 'comment', String(number), '--body', comment], { repo });
}

function reconcileOpenIssue({ number, labels, milestone, repo = REPO }) {
  gh(['issue', 'edit', String(number), '--milestone', milestone, ...labels.flatMap((label) => ['--add-label', label])], { repo });
}


export function parseSubIssueItems(out) {
  if (!out || !String(out).trim()) return [];
  const parsed = JSON.parse(out);
  const pages = Array.isArray(parsed) && parsed.every(Array.isArray) ? parsed : [parsed];
  return pages.flatMap((page) => (Array.isArray(page) ? page : []));
}

export function parseSubIssuePages(out) {
  return parseSubIssueItems(out)
    .map((item) => Number(item && typeof item === 'object' ? item.number : item))
    .filter((number) => Number.isInteger(number) && number > 0);
}

export function listSubIssues(parent, { repo = REPO, runner = gh } = {}) {
  // Native sub-issues are paginated (30 by default). Slurp wraps all response
  // pages in one JSON array so a link beyond the first page is still detected.
  const out = runner(
    ['api', `repos/${repo}/issues/${parent}/sub_issues?per_page=100`, '--paginate', '--slurp'],
    { repo },
  );
  return parseSubIssueItems(out);
}

export function listSubIssueNumbers(parent, options = {}) {
  return listSubIssues(parent, options)
    .map((item) => Number(item && typeof item === 'object' ? item.number : item))
    .filter((number) => Number.isInteger(number) && number > 0);
}

export function isLinkedSubIssue(parent, childNumber, options = {}) {
  return listSubIssueNumbers(parent, options).includes(Number(childNumber));
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

export function parentIssueNumber(issueNumber, { repo = REPO, runner = gh } = {}) {
  try {
    const out = runner(
      ['api', `repos/${repo}/issues/${issueNumber}/parent`, '--jq', '.number'],
      { repo },
    ).trim();
    const number = Number(out);
    return Number.isInteger(number) && number > 0 ? number : null;
  } catch (error) {
    const detail = [error && error.message, error && error.stderr]
      .filter(Boolean)
      .join(' ');
    if (/404|not found|does not have a parent/i.test(detail)) return null;
    throw error;
  }
}

export function isDescendantOf(ancestor, childNumber, options = {}) {
  const seen = new Set([Number(childNumber)]);
  let current = Number(childNumber);
  for (let depth = 0; depth < MAX_SUB_ISSUE_DEPTH; depth += 1) {
    const parent = parentIssueNumber(current, options);
    if (parent == null) return false;
    if (parent === Number(ancestor)) return true;
    if (seen.has(parent)) throw new Error(`cycle in issue parent hierarchy at #${parent}`);
    seen.add(parent);
    current = parent;
  }
  throw new Error(`issue #${childNumber} exceeds GitHub's ${MAX_SUB_ISSUE_DEPTH}-level hierarchy`);
}

export function resolveFindingParent({
  lens,
  baseline,
  auditDate,
  sig,
  repo = REPO,
  runner = gh,
  createIssueFn = createIssue,
  linkSubIssueFn = addSubIssue,
} = {}) {
  const gate = lensConfig(lens);
  const directChildren = listSubIssues(gate.epic, { repo, runner });
  if (directChildren.length < DIRECT_GATE_FINDING_LIMIT) return gate.epic;

  // Inspect the direct-child bodies returned by the native API instead of relying
  // on GitHub's eventually-consistent search index. A rollup created by the prior
  // finding is therefore reusable immediately within the same router batch.
  const marker = auditRollupMarker(lens, baseline);
  const rollups = directChildren
    .filter((issue) => issue && typeof issue === 'object' && String(issue.body || '').includes(marker))
    .map((issue) => ({
      number: Number(issue.number),
      state: String(issue.state || 'OPEN').toUpperCase(),
      childCount: listSubIssueNumbers(Number(issue.number), { repo, runner }).length,
    }))
    .filter((issue) => Number.isInteger(issue.number) && issue.number > 0);
  const selected = selectAuditParent({
    epic: gate.epic,
    directChildCount: directChildren.length,
    rollups,
  });
  if (!selected.createRollup) return selected.parent;

  const part = rollups.length + 1;
  const number = createIssueFn({
    title: `${lens} audit findings continuation ${part} for ${gate.milestone}`,
    body: buildAuditRollupBody(lens, { baseline, auditDate, sig }),
    labels: [gate.label, 'backlog', epicLabel(lens), 'meta'],
    milestone: gate.milestone,
    repo,
    dryRun: false,
  });
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`failed to create overflow rollup for ${lens} gate #${gate.epic}`);
  }
  linkSubIssueFn(gate.epic, number, { repo, dryRun: false });
  return number;
}

export function linkFindingUnderGate({
  lens,
  childNumber,
  baseline,
  auditDate,
  sig,
  repo = REPO,
  assumeUnlinked = false,
} = {}) {
  const epic = lensConfig(lens).epic;
  // A freshly-created issue cannot already have a parent. Skipping the parent
  // lookup avoids a guaranteed 404 and leaves ancestry repair enabled for replays.
  if (!assumeUnlinked && isDescendantOf(epic, childNumber, { repo })) return epic;
  const parent = resolveFindingParent({
    lens,
    baseline,
    auditDate,
    sig,
    repo,
  });
  addSubIssue(parent, childNumber, { repo, dryRun: false });
  return parent;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const a = { dryRun: false, handoff: false, repo: REPO, repoDir: process.cwd(), vendor: 'claude', role: 'main', instance: 'unknown' };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--dry-run') a.dryRun = true;
    else if (v === '--handoff') a.handoff = true;
    else if (v === '--findings') a.findings = argv[++i];
    else if (v === '--result') {
      a.result = argv[++i];
      if (!a.result) throw new Error('--result <path.json> needs a path');
    }
    else if (v === '--repo') a.repo = argv[++i];
    else if (v === '--repo-dir') a.repoDir = argv[++i];
    else if (v === '--vendor') a.vendor = argv[++i];
    else if (v === '--role') a.role = argv[++i];
    else if (v === '--instance') a.instance = argv[++i];
    else if (v === '--gates') a.gates = argv[++i];
    else throw new Error(`unknown arg ${v}`);
  }
  if (!a.findings) throw new Error('--findings <path.json> is required');
  return a;
}

export function portableArtifactPath(path, repoDir) {
  const value = String(path);
  if (!isAbsolute(value)) return value;
  const rel = relative(repoDir || process.cwd(), value);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : value;
}

export function writeResultFile(path, result) {
  writeFileSync(path, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
}

export function runFileFindings(opts, dependencies = {}) {
  const {
    readFindings = (path) => JSON.parse(readFileSync(path, 'utf8')),
    findExistingIssue = findExisting,
    verifyFindingAtBaseline = validateEvidenceAtBaseline,
    restoreClosedFinding = restoreClosedIssue,
    reconcileOpenFinding = reconcileOpenIssue,
    ensureEpicLabelForFinding = ensureEpicLabel,
    createFindingIssue = createIssue,
    linkFindingIssue = linkFindingUnderGate,
    writeResult = writeResultFile,
    log = console.log,
  } = dependencies;

  if (!opts.dryRun && (!opts.instance || opts.instance === 'unknown')) {
    throw new Error('--instance <id> is required for a non-dry run so every filed issue is attributable (agent-sig)');
  }
  const activeGates = resolveGates(opts.gates); // throws on an unknown gate name
  const doc = readFindings(opts.findings);
  const baseline = doc.baseline;
  const auditDate = doc.auditDate;
  if (!/^[0-9a-f]{40}$/.test(baseline || '')) {
    throw new Error('findings JSON needs a full 40-character baseline SHA');
  }
  if (!auditDate) throw new Error('findings JSON needs auditDate');
  const sig = signature({ vendor: opts.vendor, role: opts.role, instance: opts.instance });

  const findings = Array.isArray(doc.findings) ? doc.findings : [];
  log(
    `${opts.dryRun ? '[DRY-RUN] ' : ''}filing ${findings.length} finding(s) from ${opts.findings} ` +
      `(section=${doc.section}, baseline=${baseline}, handoff=${opts.handoff}, gates=${activeGates.join('+')})`,
  );

  const summary = {
    schemaVersion: 1,
    findings: portableArtifactPath(opts.findings, opts.repoDir),
    section: doc.section ?? null,
    baseline,
    auditDate,
    dryRun: Boolean(opts.dryRun),
    gates: activeGates,
    created: [],
    existing: [],
    skipped: [],
  };
  const seenThisRun = new Map();
  const counts = {
    created: 0,
    wouldCreate: 0,
    skippedDup: 0,
    skippedInvalid: 0,
    skippedInRun: 0,
    skippedGate: 0,
  };

  for (const finding of findings) {
    const errs = validateFinding(finding);
    if (errs.length) {
      log(`  SKIP invalid "${finding && finding.title}": ${errs.join('; ')}`);
      summary.skipped.push(resultEntry(finding, { reason: 'invalid' }));
      counts.skippedInvalid++;
      continue;
    }
    if (!activeGates.includes(finding.lens)) {
      log(`  skip (gate "${finding.lens}" not in active set) "${finding.title}"`);
      summary.skipped.push(resultEntry(finding, { reason: 'gate-inactive' }));
      counts.skippedGate++;
      continue;
    }
    const evidenceErrors = verifyFindingAtBaseline(finding, {
      baseline,
      repoDir: opts.repoDir,
    });
    if (evidenceErrors.length) {
      log(`  SKIP invalid evidence "${finding.title}": ${evidenceErrors.join('; ')}`);
      summary.skipped.push(resultEntry(finding, { reason: 'invalid-evidence' }));
      counts.skippedInvalid++;
      continue;
    }
    const key = dedupKey(finding);
    if (seenThisRun.has(key)) {
      log(`  skip (dup in this batch) ${key} "${finding.title}"`);
      summary.skipped.push(
        resultEntry(finding, {
          key,
          number: seenThisRun.get(key),
          reason: 'in-batch-duplicate',
        }),
      );
      counts.skippedInRun++;
      continue;
    }

    const gate = lensConfig(finding.lens);
    const labels = labelsFor(finding, { handoff: opts.handoff });
    const existingMatch = findExistingIssue(key, { repo: opts.repo });
    const existing = Number.isInteger(existingMatch) ? { number: existingMatch, state: 'OPEN' } : existingMatch;
    if (existing) {
      const existingNumber = Number(existing.number);
      const existingState = String(existing.state || 'OPEN').toUpperCase();
      if (!Number.isInteger(existingNumber) || existingNumber < 1) throw new Error('existing issue match has no valid number');
      ensureEpicLabelForFinding(finding.lens, { repo: opts.repo, dryRun: opts.dryRun });
      if (!opts.dryRun) {
        if (existingState === 'CLOSED') {
          restoreClosedFinding({
            number: existingNumber,
            comment: buildRegressionComment(finding, { baseline, auditDate, sig }),
            labels,
            milestone: gate.milestone,
            repo: opts.repo,
          });
        } else {
          reconcileOpenFinding({
            number: existingNumber,
            labels,
            milestone: gate.milestone,
            repo: opts.repo,
          });
        }
        linkFindingIssue({
          lens: finding.lens,
          childNumber: existingNumber,
          baseline,
          auditDate,
          sig,
          repo: opts.repo,
        });
      }
      const action = existingState === 'CLOSED'
        ? (opts.dryRun ? 'would reopen closed regression' : 'reopened closed regression')
        : (opts.dryRun ? 'dry-run did not repair issue metadata or epic link' : 'reconciled issue metadata and epic link');
      log(`  skip (already filed #${existingNumber}; ${action}) ${key} "${finding.title}"`);
      summary.existing.push(resultEntry(finding, { key, number: existingNumber }));
      seenThisRun.set(key, existingNumber);
      counts.skippedDup++;
      continue;
    }

    if (gate.closed) {
      log(`  NOTE: gate "${finding.lens}" epic #${gate.epic} is marked closed — filing anyway (explicitly selected)`);
    }
    const title = sanitizeIssueText(cleanTitle(finding.title));
    const body = buildBody(finding, { baseline, auditDate, key, sig });
    ensureEpicLabelForFinding(finding.lens, { repo: opts.repo, dryRun: opts.dryRun });
    if (opts.dryRun) {
      log(`  [dry-run] would CREATE "${title}"  labels=${labels.join(',')}  milestone=${gate.milestone}`);
      summary.skipped.push(resultEntry(finding, { key, reason: 'dry-run' }));
      seenThisRun.set(key, null);
      counts.wouldCreate++;
      continue;
    }

    const num = createFindingIssue({
      title,
      body,
      labels,
      milestone: gate.milestone,
      repo: opts.repo,
      dryRun: false,
    });
    if (!num) throw new Error(`created issue "${title}" but gh did not return its issue number`);
    const parent = linkFindingIssue({
      lens: finding.lens,
      childNumber: num,
      baseline,
      auditDate,
      sig,
      repo: opts.repo,
      assumeUnlinked: true,
    });
    log(`  created #${num} [${finding.lens}] ${title} (parent #${parent})`);
    summary.created.push(resultEntry(finding, { key, number: num }));
    seenThisRun.set(key, Number(num));
    counts.created++;
  }

  summary.counts = {
    created: summary.created.length,
    existing: summary.existing.length,
    skipped: summary.skipped.length,
  };
  if (opts.result) writeResult(opts.result, summary);

  log(
    `done: ${opts.dryRun ? `${counts.wouldCreate} would-create` : `${counts.created} created`}, ` +
      `${counts.skippedDup} already-filed, ` +
      `${counts.skippedInRun} in-batch dups, ${counts.skippedGate} gate-inactive, ${counts.skippedInvalid} invalid`,
  );
  return summary;
}

export function main(argv = process.argv.slice(2), dependencies = {}) {
  return runFileFindings(parseArgs(argv), dependencies);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
