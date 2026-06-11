#!/usr/bin/env node
// Detect whether a pull request changes only documentation paths.
//
// Workflows use this instead of pull_request.paths-ignore so required check
// names do not disappear or sit pending on docs-only PRs. A docs-only PR still
// gets a tiny classifier job; expensive jobs can then skip at the job level.

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function changedFiles() {
  const baseRef = process.env.GITHUB_BASE_REF;
  const baseSha = process.env.GITHUB_EVENT_PULL_REQUEST_BASE_SHA;
  const headSha = process.env.GITHUB_EVENT_PULL_REQUEST_HEAD_SHA;

  const attempts = [];
  if (baseRef) attempts.push(['diff', '--name-only', `origin/${baseRef}...HEAD`]);
  if (baseSha && headSha) attempts.push(['diff', '--name-only', baseSha, headSha]);
  attempts.push(['diff', '--name-only', 'HEAD^', 'HEAD']);

  let lastErr = null;
  for (const args of attempts) {
    try {
      return git(args)
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr ?? new Error('could not determine changed files');
}

function isDocsPath(file) {
  if (file.startsWith('docs/')) return true;
  if (file === 'deploy/README.md') return true;
  if (file === '.github/pull_request_template.md') return true;
  if (file.startsWith('.github/ISSUE_TEMPLATE/')) return true;
  return /^(AGENTS|CATALOG|CHANGELOG|CLAUDE|CODE_OF_CONDUCT|CONTRIBUTING|INDEX|LEARNING-ROADMAP|QUICK_REFERENCE|README|REFERENCES|SECURITY|STYLE_GUIDE)(\.[A-Za-z0-9_-]+)?$/.test(file)
    || /^(LICENSE|NOTICE)$/.test(file);
}

const files = changedFiles();
const docsOnly = files.length > 0 && files.every(isDocsPath);

console.log('Changed files:');
for (const file of files) console.log(`- ${file}`);
console.log(`docs_only=${docsOnly}`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `docs_only=${docsOnly}\n`);
}
