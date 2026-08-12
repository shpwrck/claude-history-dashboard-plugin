#!/usr/bin/env node
// Deterministic changed-release audit scope (#3602).
//
// The v0.6 audit was a one-time complete-tree baseline. Later release audits
// start from the immutable milestone diff and add only a bounded, reproducible
// blast radius: direct TS/JS static-relative importers and tracked text files
// containing an exact old/new path. Deleted paths remain evidenced tombstones;
// only paths present in the candidate head can be dispatched to reviewers.

import {
  mkdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, posix } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  RELEASE_AUDIT_SCOPE_POLICY_VERSION,
  resolveAuditUniverse,
} from './audit-scope.mjs';

export { RELEASE_AUDIT_SCOPE_POLICY_VERSION } from './audit-scope.mjs';

const SOURCE_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
];
const STATIC_RELATIVE_IMPORT_RE =
  /(?:^|[;\n])\s*(?:import|export)\s+(?:(?:type\s+)?[^'"`;]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/g;
const STATIC_RELATIVE_REQUIRE_RE =
  /\brequire\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;

function git(repoDir, args, options = {}) {
  return execFileSync('git', ['-C', repoDir, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

function resolveCommit(repoDir, ref) {
  if (typeof ref !== 'string' || !ref.trim()) {
    throw new Error('git ref must be a nonempty string');
  }
  return git(repoDir, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${ref}^{commit}`,
  ]).trim();
}

function readTreeEntries(repoDir, revision) {
  const records = git(repoDir, [
    'ls-tree',
    '-rlz',
    '--full-tree',
    revision,
  ])
    .split('\0')
    .filter(Boolean);
  return records.map((record) => {
    const separator = record.indexOf('\t');
    if (separator < 0) throw new Error('git ls-tree output is malformed');
    const [mode, type, oid, sizeText] = record
      .slice(0, separator)
      .trim()
      .split(/\s+/);
    const path = record.slice(separator + 1);
    const size = Number(sizeText);
    if (
      !path ||
      !/^[0-7]{6}$/.test(mode) ||
      type !== 'blob' ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid) ||
      !Number.isSafeInteger(size) ||
      size < 0
    ) {
      throw new Error(`git ls-tree returned an invalid blob entry for ${path}`);
    }
    return { path, mode, type, oid, size };
  });
}

function readBlobs(repoDir, entries) {
  if (!entries.length) return { get: () => undefined };
  const raw = execFileSync(
    'git',
    ['-C', repoDir, 'cat-file', '--batch'],
    {
      input: `${entries.map(({ oid }) => oid).join('\n')}\n`,
      maxBuffer: Math.max(
        1024 * 1024,
        entries.reduce((total, entry) => total + entry.size + 128, 0)
      ),
    }
  );
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  // perf-index-contract: release-scope-blob-index always-consumed: every nonempty blob batch is read once for every requested entry by its caller
  const blobs = new Map();
  let offset = 0;
  for (const entry of entries) {
    const newline = bytes.indexOf(0x0a, offset);
    if (newline < 0) throw new Error(`git cat-file truncated ${entry.path}`);
    const header = bytes.subarray(offset, newline).toString('utf8');
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) blob ([0-9]+)$/.exec(
      header
    );
    if (!match || match[1] !== entry.oid || Number(match[2]) !== entry.size) {
      throw new Error(`git cat-file identity drifted for ${entry.path}`);
    }
    const start = newline + 1;
    const end = start + entry.size;
    if (end >= bytes.length || bytes[end] !== 0x0a) {
      throw new Error(`git cat-file truncated ${entry.path}`);
    }
    blobs.set(entry.path, Buffer.from(bytes.subarray(start, end)));
    offset = end + 1;
  }
  if (offset !== bytes.length) {
    throw new Error('git cat-file returned unexpected trailing output');
  }
  return blobs;
}

function parseChanges(raw) {
  const fields = raw.split('\0');
  const changes = [];
  for (let index = 0; index < fields.length && fields[index]; ) {
    const status = fields[index++];
    if (/^[RC][0-9]+$/.test(status)) {
      const oldPath = fields[index++];
      const newPath = fields[index++];
      if (!oldPath || !newPath) throw new Error('git diff rename is malformed');
      changes.push({ status, oldPath, newPath });
      continue;
    }
    const path = fields[index++];
    if (!path || !/^[AMDTUXB]$/.test(status)) {
      throw new Error(`unsupported git diff status ${status || '<empty>'}`);
    }
    changes.push({
      status,
      oldPath: status === 'A' ? null : path,
      newPath: status === 'D' ? null : path,
    });
  }
  // perf-index-contract: release-scope-change-order always-consumed: the complete deterministic change order is sealed directly into every returned manifest
  return changes.sort((left, right) => {
    const leftPath = left.newPath ?? left.oldPath;
    const rightPath = right.newPath ?? right.oldPath;
    return leftPath.localeCompare(rightPath) || left.status.localeCompare(right.status);
  });
}

function changedPaths(changes) {
  // perf-index-contract: release-scope-changed-path-order always-consumed: the complete deduplicated path order drives both blast-radius passes and the manifest equation
  return [...new Set(
    changes.flatMap(({ oldPath, newPath }) =>
      [oldPath, newPath].filter(Boolean)
    )
  )].sort();
}

function sourceExtension(path) {
  return SOURCE_EXTENSIONS.find((extension) => path.endsWith(extension)) ?? null;
}

function importCandidates(importer, specifier) {
  const withoutSuffix = specifier.replace(/[?#].*$/, '');
  const base = posix.normalize(posix.join(posix.dirname(importer), withoutSuffix));
  if (base.startsWith('../') || base === '..' || base.startsWith('/')) return [];
  const extension = sourceExtension(base);
  const candidates = [base];
  if (!extension) {
    for (const candidateExtension of SOURCE_EXTENSIONS) {
      candidates.push(`${base}${candidateExtension}`);
      candidates.push(posix.join(base, `index${candidateExtension}`));
    }
  } else {
    const replacement = {
      '.js': ['.ts', '.tsx', '.mts', '.cts'],
      '.jsx': ['.tsx'],
      '.mjs': ['.mts'],
      '.cjs': ['.cts'],
    }[extension] ?? [];
    for (const candidateExtension of replacement) {
      candidates.push(`${base.slice(0, -extension.length)}${candidateExtension}`);
    }
  }
  // perf-index-contract: release-scope-import-candidates always-consumed: every resolved candidate list is immediately scanned against both tree and changed-path membership
  return [...new Set(candidates)];
}

function staticImportTargets(path, contents, treePaths, targetPaths) {
  // perf-index-contract: release-scope-static-targets always-consumed: every source scan returns and serializes the complete matched target membership
  const targets = new Set();
  for (const pattern of [
    STATIC_RELATIVE_IMPORT_RE,
    STATIC_RELATIVE_REQUIRE_RE,
  ]) {
    for (const match of contents.matchAll(pattern)) {
      for (const candidate of importCandidates(path, match[1])) {
        if (treePaths.has(candidate) && targetPaths.has(candidate)) {
          targets.add(candidate);
        }
      }
    }
  }
  // perf-index-contract: release-scope-static-target-order always-consumed: every source scan returns this complete deterministic target list to evidence collection
  return [...targets].sort();
}

function addEvidence(index, path, revision, targets) {
  if (!targets.length) return;
  // perf-index-contract: release-scope-evidence-membership always-consumed: every created evidence record immediately records its revision and targets and is later serialized
  const current = index.get(path) ?? {
    path,
    revisions: new Set(),
    targets: new Set(),
  };
  current.revisions.add(revision);
  for (const target of targets) current.targets.add(target);
  index.set(path, current);
}

function collectImporterEvidence({
  repoDir,
  baseSha,
  headSha,
  baseEntries,
  headEntries,
  changedPathSet,
}) {
  // perf-index-contract: release-scope-importer-evidence always-consumed: every importer pass serializes the complete evidence index into the returned manifest
  const evidence = new Map();
  for (const [revision, sha, entries] of [
    ['base', baseSha, baseEntries],
    ['head', headSha, headEntries],
  ]) {
    const sources = entries.filter(({ path }) => {
      const extension = sourceExtension(path);
      return extension && SOURCE_EXTENSIONS.includes(extension);
    });
    // perf-index-contract: release-scope-import-tree-index always-consumed: every source import candidate probes tree and changed-target membership during this revision pass
    const treePaths = new Set(entries.map(({ path }) => path));
    const targets = new Set(
      [...changedPathSet].filter((path) => treePaths.has(path))
    );
    const blobs = readBlobs(repoDir, sources);
    for (const source of sources) {
      const contents = blobs.get(source.path).toString('utf8');
      addEvidence(
        evidence,
        source.path,
        revision,
        staticImportTargets(source.path, contents, treePaths, targets)
      );
    }
  }
  return evidence;
}

function grepTextReferences(repoDir, revision, targets) {
  // perf-index-contract: release-scope-reference-matches always-consumed: every grep pass returns and enumerates the complete deduplicated match membership
  const matches = new Set();
  for (let start = 0; start < targets.length; start += 100) {
    const args = ['grep', '-I', '-l', '-z', '-F'];
    for (const target of targets.slice(start, start + 100)) {
      args.push('-e', target);
    }
    args.push(revision, '--');
    try {
      const output = git(repoDir, args);
      for (const record of output.split('\0').filter(Boolean)) {
        const prefix = `${revision}:`;
        matches.add(record.startsWith(prefix) ? record.slice(prefix.length) : record);
      }
    } catch (error) {
      if (error?.status !== 1) throw error;
    }
  }
  return matches;
}

function collectReferenceEvidence({
  repoDir,
  baseSha,
  headSha,
  baseEntries,
  headEntries,
  changedPathList,
}) {
  // perf-index-contract: release-scope-reference-evidence always-consumed: every reference pass serializes the complete evidence index into the returned manifest
  const evidence = new Map();
  for (const [revision, sha, entries] of [
    ['base', baseSha, baseEntries],
    ['head', headSha, headEntries],
  ]) {
    // perf-index-contract: release-scope-reference-path-index always-consumed: every grep match probes this auditable-tree index before blob selection and evidence extraction
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    // perf-index-contract: release-scope-reference-path-order always-consumed: every matched path in deterministic order is read and converted into evidence below
    const matchedPaths = [...grepTextReferences(repoDir, sha, changedPathList)]
      .filter((path) => byPath.has(path))
      .sort();
    const blobs = readBlobs(
      repoDir,
      matchedPaths.map((path) => byPath.get(path))
    );
    for (const path of matchedPaths) {
      const contents = blobs.get(path).toString('utf8');
      const targets = changedPathList.filter((target) => contents.includes(target));
      addEvidence(evidence, path, revision, targets);
    }
  }
  return evidence;
}

function serializeEvidence(index) {
  return [...index.values()]
    .map(({ path, revisions, targets }) => ({
      path,
      // perf-index-contract: release-scope-revision-order always-consumed: every evidence record seals its full deterministic revision list into the manifest
      revisions: [...revisions].sort((left, right) =>
        ['base', 'head'].indexOf(left) - ['base', 'head'].indexOf(right)
      ),
      // perf-index-contract: release-scope-evidence-target-order always-consumed: every evidence record seals its full deterministic target list into the manifest
      targets: [...targets].sort(),
    }))
    // perf-index-contract: release-scope-evidence-order always-consumed: the complete deterministic evidence list is sealed directly into every returned manifest
    .sort((left, right) => left.path.localeCompare(right.path));
}

function validateManualAdditions(additions, headAuditablePaths) {
  if (!additions?.length) return [];
  // perf-index-contract: release-scope-manual-membership always-consumed: every nonempty manual list probes this set once per addition before it can be accepted
  const seen = new Set();
  return additions
    .map((addition, index) => {
      const path = addition?.path;
      const reason = addition?.reason?.trim();
      if (
        typeof path !== 'string' ||
        !path ||
        path.includes('\0') ||
        path.startsWith('/') ||
        posix.normalize(path) !== path ||
        path.startsWith('../')
      ) {
        throw new Error(`manual addition ${index + 1} has an invalid repository path`);
      }
      if (!reason) {
        throw new Error(`manual addition ${path} requires a nonempty reason`);
      }
      if (!headAuditablePaths.has(path)) {
        throw new Error(`manual addition ${path} is absent from the head tree`);
      }
      if (seen.has(path)) {
        throw new Error(`manual addition ${path} is duplicated`);
      }
      seen.add(path);
      return { path, reason };
    })
    // perf-index-contract: release-scope-manual-order always-consumed: every accepted manual list is sealed in this complete deterministic order
    .sort((left, right) => left.path.localeCompare(right.path));
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function buildReleaseAuditManifest({
  repoDir,
  previousTag,
  head,
  fullAudit = false,
  manualAdditions = [],
}) {
  if (typeof repoDir !== 'string' || !repoDir) {
    throw new Error('repoDir is required');
  }
  if (typeof previousTag !== 'string' || !previousTag) {
    throw new Error('previousTag is required');
  }
  if (typeof head !== 'string' || !head) throw new Error('head is required');

  const baseSha = resolveCommit(repoDir, previousTag);
  const headSha = resolveCommit(repoDir, head);
  if (baseSha === headSha) {
    throw new Error('previousTag and head must resolve to different commits');
  }
  const baseTree = readTreeEntries(repoDir, baseSha);
  const headTree = readTreeEntries(repoDir, headSha);
  const baseUniverse = resolveAuditUniverse(baseTree);
  const headUniverse = resolveAuditUniverse(headTree);
  const baseEntries = baseUniverse.auditableEntries;
  const headEntries = headUniverse.auditableEntries;
  // perf-index-contract: release-scope-head-auditable-index always-consumed: every build uses this set for full selection, manual validation, or incremental exclusions
  const headAuditablePaths = new Set(headEntries.map(({ path }) => path));
  const changes = parseChanges(
    git(repoDir, [
      'diff',
      '--name-status',
      '-z',
      '--find-renames',
      `${baseSha}..${headSha}`,
    ])
  );
  const changedPathList = changedPaths(changes);
  // perf-index-contract: release-scope-empty-evidence-index always-consumed: full and incremental builds both serialize these evidence indexes into the manifest
  let importerEvidence = new Map();
  let referenceEvidence = new Map();
  if (!fullAudit) {
    // perf-index-contract: release-scope-changed-path-index always-consumed: every incremental build probes this set while deriving direct importer evidence
    const changedPathSet = new Set(changedPathList);
    importerEvidence = collectImporterEvidence({
      repoDir,
      baseSha,
      headSha,
      baseEntries,
      headEntries,
      changedPathSet,
    });
    referenceEvidence = collectReferenceEvidence({
      repoDir,
      baseSha,
      headSha,
      baseEntries,
      headEntries,
      changedPathList,
    });
  }
  const importers = serializeEvidence(importerEvidence);
  const references = serializeEvidence(referenceEvidence);
  const automaticPaths = fullAudit
    // perf-index-contract: release-scope-full-path-order always-consumed: full mode seals the entire deterministic auditable-head order as its automatic and final scope
    ? [...headAuditablePaths].sort()
    // perf-index-contract: release-scope-automatic-order always-consumed: incremental mode seals this complete deduplicated deterministic order into its equation and dispatch set
    : [...new Set([
        ...changedPathList,
        ...importers.map(({ path }) => path),
        ...references.map(({ path }) => path),
      ])].sort();
  const normalizedManual = validateManualAdditions(
    manualAdditions,
    headAuditablePaths
  );
  let redundantManual = null;
  if (normalizedManual.length) {
    // perf-index-contract: release-scope-automatic-membership always-consumed: a nonempty manual list immediately probes this set while rejecting redundant additions
    const automaticPathSet = new Set(automaticPaths);
    redundantManual = normalizedManual.find(({ path }) =>
      automaticPathSet.has(path)
    );
  }
  if (redundantManual) {
    throw new Error(
      `manual addition ${redundantManual.path} is already in automatic scope`
    );
  }
  // Automatic and manual paths are each unique, and redundant manual entries
  // fail above, so concatenation is already a disjoint union.
  // perf-index-contract: release-scope-candidate-order always-consumed: every candidate enters exclusion classification and the sealed scope equation in this order
  const candidatePaths = [
    ...automaticPaths,
    ...normalizedManual.map(({ path }) => path),
  ].sort();
  const exclusionPaths = fullAudit
    ? []
    : candidatePaths.filter((path) => !headAuditablePaths.has(path));
  let headTrackedPaths = null;
  if (exclusionPaths.length) {
    // perf-index-contract: release-scope-head-tracked-index always-consumed: every constructed index classifies at least one excluded candidate as evidence or a tombstone
    headTrackedPaths = new Set(headTree.map(({ path }) => path));
  }
  const exclusions = exclusionPaths.map((path) => ({
    path,
    reason: headTrackedPaths.has(path) ? 'sealed-evidence' : 'absent-at-head',
  }));
  const finalPaths = candidatePaths.filter((path) =>
    headAuditablePaths.has(path)
  );

  const manifest = {
    schemaVersion: 1,
    policyVersion: RELEASE_AUDIT_SCOPE_POLICY_VERSION,
    mode: fullAudit ? 'full' : 'incremental',
    fullAudit: Boolean(fullAudit),
    previousTag,
    baseSha,
    head,
    headSha,
    changes,
    evidence: {
      importers,
      references,
    },
    automaticPaths,
    manualAdditions: normalizedManual,
    exclusions,
    finalPaths,
    equation: {
      automatic: automaticPaths.length,
      manual: normalizedManual.length,
      exclusions: exclusions.length,
      final: finalPaths.length,
      statement: 'unique(automatic + manual) = final + exclusions',
    },
  };
  return { ...manifest, manifestSha256: sha256Json(manifest) };
}

export function parseReleaseScopeArgs(argv) {
  const options = {
    previousTag: null,
    head: null,
    repoDir: process.cwd(),
    output: null,
    fullAudit: false,
    manualAdditions: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--previous-tag') options.previousTag = argv[++index];
    else if (arg === '--head') options.head = argv[++index];
    else if (arg === '--repo-dir') options.repoDir = argv[++index];
    else if (arg === '--output') options.output = argv[++index];
    else if (arg === '--full-audit') options.fullAudit = true;
    else if (arg === '--add') {
      const path = argv[++index];
      if (argv[index + 1] !== '--reason') {
        throw new Error(`--add ${path ?? ''} requires an immediate --reason`);
      }
      index += 1;
      const reason = argv[++index];
      options.manualAdditions.push({ path, reason });
    } else {
      throw new Error(`unknown arg ${arg}`);
    }
  }
  if (!options.previousTag) throw new Error('--previous-tag is required');
  if (!options.head) throw new Error('--head is required');
  return options;
}

function main() {
  const options = parseReleaseScopeArgs(process.argv.slice(2));
  const manifest = buildReleaseAuditManifest(options);
  const output = `${JSON.stringify(manifest, null, 2)}\n`;
  if (options.output) {
    mkdirSync(dirname(options.output), { recursive: true });
    writeFileSync(options.output, output, 'utf8');
  } else {
    process.stdout.write(output);
  }
}

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) main();
