#!/usr/bin/env node
// Detect whether a pull request changes only documentation paths.
//
// Workflows use this instead of pull_request.paths-ignore so required check
// names do not disappear or sit pending on docs-only PRs. PR workflows get the
// same answer from the merge-SHA resolver (#3740); this script stays for local
// and non-PR use.

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { isDocsOnlyChange } from './ci-docs-paths.mjs';

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
      args: ['diff', '--name-only', '--no-renames', baseSha, headSha],
    });
  }
  if (baseRef) {
    attempts.push({
      name: 'pull_request_origin_base_ref',
      args: ['diff', '--name-only', '--no-renames', `origin/${baseRef}...HEAD`],
    });
  }
  if (!isPullRequest) {
    attempts.push({
      name: 'previous_commit',
      args: ['diff', '--name-only', '--no-renames', 'HEAD^', 'HEAD'],
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

const { strategy, files } = changedFiles();
const docsOnly = isDocsOnlyChange(files);

console.log(`Diff strategy: ${strategy}`);
console.log('Changed files:');
for (const file of files) console.log(`- ${file}`);
console.log(`docs_only=${docsOnly}`);

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `docs_only=${docsOnly}\n`);
}
