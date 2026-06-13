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
  const isPullRequest = Boolean(baseRef || baseSha || headSha);

  const attempts = [];
  if (baseSha && headSha) {
    attempts.push({
      name: 'pull_request_base_head_sha',
      args: ['diff', '--name-only', baseSha, headSha],
    });
  }
  if (baseRef) {
    attempts.push({
      name: 'pull_request_origin_base_ref',
      args: ['diff', '--name-only', `origin/${baseRef}...HEAD`],
    });
  }
  if (!isPullRequest) {
    attempts.push({
      name: 'previous_commit',
      args: ['diff', '--name-only', 'HEAD^', 'HEAD'],
    });
  }

  const errors = [];
  for (const attempt of attempts) {
    try {
      return {
        strategy: attempt.name,
        files: git(attempt.args)
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean),
      };
    } catch (err) {
      errors.push(`${attempt.name}: ${err.message}`);
    }
  }
  const detail = errors.length > 0 ? ` Attempts: ${errors.join(' | ')}` : '';
  if (isPullRequest) {
    throw new Error(`could not determine pull request changed files.${detail}`);
  }
  throw new Error(`could not determine changed files.${detail}`);
}

function isDocsPath(file) {
  if (file.startsWith('docs/')) return true;
  if (file === 'deploy/README.md') return true;
  if (file === '.github/pull_request_template.md') return true;
  if (file.startsWith('.github/ISSUE_TEMPLATE/')) return true;
  return /^(AGENTS|CATALOG|CHANGELOG|CLAUDE|CODE_OF_CONDUCT|CONTRIBUTING|INDEX|LEARNING-ROADMAP|QUICK_REFERENCE|README|REFERENCES|SECURITY|STYLE_GUIDE)(\.[A-Za-z0-9_-]+)?$/.test(file)
    || /^(LICENSE|NOTICE)$/.test(file);
}

const { strategy, files } = changedFiles();
const docsOnly = files.length > 0 && files.every(isDocsPath);

console.log(`Diff strategy: ${strategy}`);
console.log('Changed files:');
for (const file of files) console.log(`- ${file}`);
console.log(`docs_only=${docsOnly}`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `docs_only=${docsOnly}\n`);
}
