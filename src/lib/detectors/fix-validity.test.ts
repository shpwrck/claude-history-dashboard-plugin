/**
 * Fix-snippet validity gate tests (#1101, epic #866).
 *
 *  1. Unit: validateFixSnippet accepts a clean validated snippet, rejects a
 *     non-portable references, and lets illustrative/manual bypass;
 *     validateNpmRunScripts accepts a present script and rejects an absent one.
 *  2. Gate: a source scan over every detector — any file that embeds a
 *     non-portable reference (custom CLI, host path, slash command, or host tool)
 *     in a snippet
 *     MUST mark that fix `'manual'` or `'illustrative'`, never leave it the
 *     default `'validated'`. This is the deterministic CI guard against the
 *     audited copy-paste-unsafe snippets recurring.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  effectiveFixKind,
  validateFixSnippet,
  validateNpmRunScripts,
  npmRunScripts,
  NON_PORTABLE_SNIPPET_PATTERNS,
} from './fix-validity';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');

// ── Unit: validateFixSnippet ───────────────────────────────────────────────

describe('effectiveFixKind', () => {
  it('defaults an absent fixKind to validated', () => {
    expect(effectiveFixKind({})).toBe('validated');
    expect(effectiveFixKind({ fixKind: 'manual' })).toBe('manual');
  });
});

describe('validateFixSnippet', () => {
  it('passes a clean validated config snippet', () => {
    expect(validateFixSnippet({ snippet: '{ "permissions": { "allow": ["Bash(ls:*)"] } }' })).toEqual([]);
  });
  it('passes repo-relative paths and Claude settings DSL fragments', () => {
    expect(
      validateFixSnippet({
        snippet:
          'Add `.claude/rules/ui.md` with `paths: ["src/components/**"]` and allow `Bash(ls:*)`.',
      })
    ).toEqual([]);
  });
  it.each([
    ['custom cli', 'claude-team redispatch --team x --only-unread'],
    ['linux user path', 'Open /home/alice/project/CLAUDE.md and paste this block.'],
    ['macOS user path', 'Open /Users/alice/project/CLAUDE.md and paste this block.'],
    ['windows user path', 'Open C:\\Users\\alice\\project\\CLAUDE.md and paste this block.'],
    ['slash command', 'Run `/fewer-permission-prompts` and paste the generated allowlist.'],
    ['host tool reference', 'Use nodeRepl.cwd to locate the workspace before editing.'],
  ])('rejects a validated snippet containing a non-portable %s', (_name, snippet) => {
    expect(validateFixSnippet({ snippet }).length).toBeGreaterThan(0);
  });
  it('lets a manual or illustrative fix bypass the gate', () => {
    expect(validateFixSnippet({ fixKind: 'manual', snippet: 'claude-team redispatch' })).toEqual([]);
    expect(validateFixSnippet({ fixKind: 'illustrative', snippet: 'Run `/compact` at task boundaries.' })).toEqual([]);
  });
});

describe('validateNpmRunScripts (repo-local snippets)', () => {
  const scripts = new Set(['lint', 'build', 'test']);
  it('extracts npm run script names (with and without -s)', () => {
    expect(npmRunScripts('npm run -s lint && npm run build')).toEqual(['lint', 'build']);
  });
  it('passes when the referenced script exists', () => {
    expect(validateNpmRunScripts('npm run -s lint', scripts)).toEqual([]);
  });
  it('rejects a script absent from package.json (the audited typecheck case)', () => {
    expect(validateNpmRunScripts('npm run -s typecheck', scripts).length).toBeGreaterThan(0);
  });
});

// ── Gate: source scan over all detectors ───────────────────────────────────

// Top-level infra modules under src/lib/detectors/ that are NOT detector rule
// files — they define the non-portable patterns, so the gate
// must exclude them. Everything else (category-subdir files AND any future
// root-level detector) is scanned, so the "every detector" claim holds even if
// a rule is ever placed at the root.
const INFRA_FILES = new Set([
  'types.ts',
  'shared.ts',
  'index.ts',
  'provenance.ts',
  'fix-validity.ts',
  'suppression-transition.ts',
]);

function detectorSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, atRoot: boolean): void => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p, false);
      else if (
        ent.name.endsWith('.ts') &&
        !ent.name.endsWith('.test.ts') &&
        !(atRoot && INFRA_FILES.has(ent.name))
      ) {
        out.push(p);
      }
    }
  };
  walk(HERE, true);
  return out;
}

function sourceContainsNonPortableFixRegion(src: string): boolean {
  const starts = Array.from(src.matchAll(/\bfix\s*:/g), (m) => m.index ?? 0);
  for (let idx = 0; idx < starts.length; idx += 1) {
    const start = starts[idx];
    const next = starts[idx + 1];
    const segment = src.slice(start, next);
    if (NON_PORTABLE_SNIPPET_PATTERNS.some((p) => p.pattern.test(segment))) {
      return true;
    }
  }
  return false;
}

describe('detector fix-snippet portability gate (#1101)', () => {
  it('every detector embedding a non-portable reference marks its fix non-validated', () => {
    const offenders: string[] = [];
    for (const file of detectorSourceFiles()) {
      const src = readFileSync(file, 'utf8');
      const hasNonPortable = sourceContainsNonPortableFixRegion(src);
      if (!hasNonPortable) continue;
      // The file ships a non-portable reference - it must declare the fix as
      // manual/illustrative so the UI never presents it as copy-paste-safe.
      const declaresNonValidated = /fixKind:\s*'(manual|illustrative)'/.test(src);
      if (!declaresNonValidated) offenders.push(file.replace(REPO_ROOT + '/', ''));
    }
    expect(offenders, `validated fix snippets with non-portable references: ${offenders.join(', ')}`).toEqual([]);
  });
});
