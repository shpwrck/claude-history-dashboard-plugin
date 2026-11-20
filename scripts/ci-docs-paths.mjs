// Which repository paths count as documentation for the docs-only CI skip.
// Shared by scripts/ci-docs-only.mjs (git diff) and the PR merge-SHA
// resolver (GitHub compare API), so both classify a change set the same way.

export function isDocsPath(file) {
  if (file.startsWith('docs/')) return true;
  if (file === 'deploy/README.md') return true;
  if (file === '.github/pull_request_template.md') return true;
  if (file.startsWith('.github/ISSUE_TEMPLATE/')) return true;
  return /^(AGENTS|CATALOG|CHANGELOG|CLAUDE|CODE_OF_CONDUCT|CONTRIBUTING|INDEX|LEARNING-ROADMAP|QUICK_REFERENCE|README|REFERENCES|SECURITY|STYLE_GUIDE)(\.[A-Za-z0-9_-]+)?$/.test(file)
    || /^(LICENSE|NOTICE)$/.test(file);
}

/** True only for a non-empty change set made entirely of docs paths. */
export function isDocsOnlyChange(files) {
  return files.length > 0 && files.every(isDocsPath);
}
