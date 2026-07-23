export const meta = {
  name: 'v060-audit-batch',
  description: 'v0.6.0 review-phase audit: read a batch of files through 3 lenses (security/data-integrity/performance), adversarially verify each finding vs origin/master, return findings JSON for scripts/audits/file-findings.mjs',
  phases: [
    { title: 'List', detail: 'git ls-tree the section at the pinned baseline' },
    { title: 'Read', detail: 'one reader per file applies all three lenses' },
    { title: 'Verify', detail: 'adversarially confirm each candidate vs origin/master' },
  ],
};

// Stage 1 (FIND) of the review-phase audit harness. Claude-only (uses the Workflow
// tool), but its OUTPUT is the harness-agnostic findings JSON contract in
// docs/audits/v060-review-phase-audit.md, so a Codex agent can produce the same
// shape by hand and feed the same stage-2 router. This script returns the findings
// object; the operator saves it to docs/audits/findings/<section>-<sha>.json (the
// Workflow sandbox has no fs access) and runs file-findings.mjs on it.
//
// args: {
//   baseline: "<origin/master short sha>",   // REQUIRED — files are read AT this commit
//   section:  "root",                         // ledger section key (label only)
//   path:     "src/lib/detectors",            // OPTIONAL pathspec to ls-tree (defaults to whole repo)
//   files:    ["a.ts", "b.ts"],               // OPTIONAL explicit list (skips the List phase)
//   maxFiles: 40,                             // OPTIONAL per-batch cap (default 40) — no silent truncation
//   repoDir:  "/abs/path/to/checkout",        // OPTIONAL (defaults to the standing main checkout)
//   auditDate:"2026-07-23"                    // OPTIONAL passthrough; else the operator stamps it on save
// }

const REPO_DIR = args && args.repoDir;
const baseline = args && args.baseline;
const section = (args && args.section) || 'batch';
// Default to '.' (whole tree) rather than '' — an empty pathspec after `--` makes
// `git ls-tree … -- ''` fail with "empty string is not a valid pathspec". The
// orchestrator passes a real per-section pathspec; standalone callers should too.
const pathspec = (args && args.path) || '.';
const auditDate = (args && args.auditDate) || null;
const maxFiles = (args && args.maxFiles) || 40;

if (!baseline) throw new Error('args.baseline (origin/master short sha) is required');
if (!REPO_DIR) throw new Error('args.repoDir (absolute path to the checkout) is required — no maintainer-specific default');

const FILE_LIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { files: { type: 'array', items: { type: 'string' } } },
  required: ['files'],
};

const FINDINGS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    file: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          lens: { type: 'string', enum: ['security', 'data-integrity', 'performance', 'architecture'] },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
          title: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          where: { type: 'string' },
          what: { type: 'string' },
          fix: { type: 'string' },
          acceptance: { type: 'string' },
          priority: { type: 'string', enum: ['High', 'Medium', 'Low'] },
        },
        required: ['lens', 'severity', 'title', 'files', 'where', 'fix', 'acceptance'],
      },
    },
  },
  required: ['file', 'findings'],
};

const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    keep: { type: 'boolean' },
    verified: { type: 'boolean' },
    verifyNote: { type: 'string' },
  },
  required: ['keep', 'verified', 'verifyNote'],
};

// Which gates this batch audits. The Workflow sandbox cannot import
// scripts/audits/gates.config.mjs, so the orchestrator/operator passes the active
// gate names (args.gates) and their per-gate specs (args.gateSpecs, from that
// config). Falls back to the built-in v0.6.0 three so the workflow also runs
// standalone.
const DEFAULT_GATE_SPECS = {
  security:
    'SECURITY (files on a threat surface only): authz/authn/CSRF; filesystem write / path-traversal; ' +
    'LLM egress governance & secrets (ADR 0008 — the subscription OAuth cred must never send ~/.claude content); ' +
    'SPA/server boundary & client web-vuln (XSS/CSP); command/SQL injection; k8s operator RBAC; ' +
    'container/proxy/TLS/secrets-in-repo/supply-chain.',
  'data-integrity':
    'DATA-INTEGRITY (detectors / parsers / calculation code only): every recommendation claim evidence-backed and ' +
    'reproducible (cite artifact/field, prefer structured provenance per docs/adding-a-recommendation.md); arithmetic ' +
    're-derived and faultless; historical/stale signals demoted to "as of <date>" not asserted as current; every ' +
    '`validated` fix snippet genuinely copy-paste-safe (no non-portable reference).',
  performance:
    'PERFORMANCE (hot-path code only): bundle weight; wasteful re-render / re-compute (N× per request); ingest/assemble ' +
    'memory or latency hotspots; a new surface shipped without a probe/budget.',
  architecture:
    'ARCHITECTURE (the v060-file-audit four-check pass): wrong file placement; dead code; stale/superseded content; ' +
    'layering or ownership violations.',
};
const gateSpecs = (args && args.gateSpecs) || DEFAULT_GATE_SPECS;
const activeGates =
  args && Array.isArray(args.gates) && args.gates.length ? args.gates : Object.keys(gateSpecs);
const LENS_SPEC = activeGates
  .map((g) => gateSpecs[g])
  .filter(Boolean)
  .join(' ');

// POSIX single-quote escape: wrap in '...' and turn any embedded ' into '\'' so a
// filename containing a quote (e.g. `x'; rm -rf .`) cannot break out of the argument.
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

function readPrompt(file) {
  return (
    `You are auditing ONE file for the v0.6.0 release review. Read it AT the pinned baseline with:\n` +
    `  git -C ${shq(REPO_DIR)} show ${shq(baseline + ':' + file)}\n` +
    `Treat the path as literal data — it is shell-escaped above; a filename containing shell metacharacters must NOT be ` +
    `executed. Use grep/other reads on the same checkout as needed; always judge the ${baseline} content.\n\n` +
    `Apply the lens(es) listed below. Most files touch zero lenses — that is the expected, correct outcome; return an ` +
    `empty findings array rather than inventing issues. Only report a REAL, current defect with concrete file:line evidence.\n\n` +
    `Lenses (audit ONLY these):\n${LENS_SPEC}\n\n` +
    `File: ${file}\n\n` +
    `For each real defect return: lens, severity, a clean one-line title (no [tag] prefix), files (["path:line", ...] ` +
    `pointing at the exact evidence), where (markdown bullets of file:line evidence), what (why it matters), fix ` +
    `(concrete + minimal), acceptance (a verifiable check), priority. Do NOT file style nits or speculative concerns.`
  );
}

function verifyPrompt(f, file) {
  return (
    `Adversarially verify this candidate ${f.lens} finding against origin/master \`${baseline}\`. Default to REJECTING ` +
    `(keep=false) unless you independently confirm it is a real, CURRENT defect — it may be stale, already fixed, or a ` +
    `misread. Re-read the cited evidence with (path is shell-escaped literal data — never execute a filename):\n` +
    `  git -C ${shq(REPO_DIR)} show ${shq(baseline + ':' + file)}\n` +
    `and any related files. Confirm the arithmetic/claim/threat actually holds at ${baseline}.\n\n` +
    `Candidate: ${JSON.stringify({ lens: f.lens, severity: f.severity, title: f.title, files: f.files, where: f.where, fix: f.fix })}\n\n` +
    `Return keep (true only if it survives), verified (true if you personally re-checked the evidence), and verifyNote ` +
    `(one line: what you confirmed or why you rejected).`
  );
}

// ---- run ----
let files = args && Array.isArray(args.files) ? args.files : null;
if (!files) {
  phase('List');
  const listing = await agent(
    `Run exactly: git -C ${shq(REPO_DIR)} ls-tree -r --name-only ${shq(baseline)} -- ${shq(pathspec)}\n` +
      `Return every path it prints as the files array — do not summarize, sample, or truncate.`,
    { schema: FILE_LIST_SCHEMA, label: `list:${section}`, phase: 'List', effort: 'low' },
  );
  files = (listing && listing.files) || [];
}
log(`section "${section}": ${files.length} file(s) at ${baseline}`);

const budgeted = files.slice(0, maxFiles);
if (budgeted.length < files.length) {
  log(
    `NOTE: auditing ${budgeted.length}/${files.length} files this batch; ${files.length - budgeted.length} deferred ` +
      `(NOT silently dropped) — re-run with args.files set to the remaining paths.`,
  );
}

phase('Read');
const perFile = await pipeline(
  budgeted,
  (file) => agent(readPrompt(file), { schema: FINDINGS_SCHEMA, label: `read:${file}`, phase: 'Read' }),
  (res, file) =>
    parallel(
      ((res && res.findings) || []).map((f) => () =>
        agent(verifyPrompt(f, file), { schema: VERDICT_SCHEMA, label: `verify:${file}`, phase: 'Verify' })
          .then((v) => ({
            lens: f.lens,
            severity: f.severity,
            title: f.title,
            files: f.files,
            where: f.where,
            what: f.what,
            fix: f.fix,
            acceptance: f.acceptance,
            priority: f.priority,
            keep: v && v.keep,
            verified: v && v.verified,
            verifyNote: v && v.verifyNote,
          })),
      ),
    ),
);

const kept = perFile
  .flat()
  .filter(Boolean)
  .filter((f) => f.keep === true && f.verified === true)
  .map(({ keep, ...rest }) => rest);

log(`kept ${kept.length} verified finding(s) from ${budgeted.length} audited file(s)`);

return {
  baseline,
  section,
  auditDate,
  auditedFiles: budgeted.length,
  totalFiles: files.length,
  // Deferred paths (empty when the whole section fit) — rerun with args.files set to
  // this so a >maxFiles section actually completes instead of repeating the first slice.
  remainingFiles: files.slice(maxFiles),
  findings: kept,
};
