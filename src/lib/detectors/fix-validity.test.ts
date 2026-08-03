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
  isBlanketModelPinSnippet,
  NON_PORTABLE_SNIPPET_PATTERNS,
} from './fix-validity';
import { detector as blockedTaskPileupDetector } from './workflow/blocked-task-pileup';
import type { RecommendationInput, RecFix } from './types';
import type { TaskRecord } from '../parse-tasks';

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

function emittedBlockedTaskFix(rootSubject: string): RecFix {
  const task = (
    id: string,
    subject: string,
    blockedBy: string[] = []
  ): TaskRecord => ({
    id,
    sessionId: 'runtime-fixture',
    status: 'pending',
    subject,
    description: '',
    activeForm: '',
    owner: '',
    blocks: [],
    blockedBy,
    mtimeMs: 0,
  });
  const tasks = [
    task('root', rootSubject),
    task('child-1', 'First child', ['root']),
    task('child-2', 'Second child', ['root']),
  ];
  const input = {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    tasks,
  } as unknown as RecommendationInput;
  return blockedTaskPileupDetector.rule(input, 0)!.fix!;
}

describe('emitted runtime fix portability (#3381)', () => {
  it('demotes an actual emitted fix when interpolated artifact text trips the portability rules', () => {
    const fix = emittedBlockedTaskFix('Run /deploy before continuing');

    // Negative control: the detector's real emitted bytes violate the validated
    // contract when the runtime classification is forced to validated.
    expect(validateFixSnippet({ ...fix, fixKind: 'validated' }).length).toBeGreaterThan(0);
    expect(effectiveFixKind(fix)).toBe('manual');
    expect(validateFixSnippet(fix)).toEqual([]);
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

describe('isBlanketModelPinSnippet (#2548)', () => {
  it('flags a top-level global model pin', () => {
    expect(isBlanketModelPinSnippet('{\n  "model": "claude-haiku-4-5"\n}')).toBe(true);
  });
  it('ignores a settings object with no top-level model key', () => {
    expect(isBlanketModelPinSnippet('{ "permissions": { "allow": ["Bash(ls:*)"] } }')).toBe(false);
  });
  it('ignores prose / non-JSON snippets', () => {
    expect(isBlanketModelPinSnippet('Set the model in the settings.json your sdk-* runs use.')).toBe(false);
  });
  it('ignores a non-string model value', () => {
    expect(isBlanketModelPinSnippet('{ "model": { "id": "x" } }')).toBe(false);
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

/** The `fix:`-delimited regions of a detector source, in order. */
function fixRegions(src: string): string[] {
  const starts = Array.from(src.matchAll(/\bfix\s*:/g), (m) => m.index ?? 0);
  return starts.map((start, idx) => src.slice(start, starts[idx + 1]));
}

/**
 * True when at least one fix region embeds a non-portable reference WITHOUT
 * declaring `fixKind: 'manual' | 'illustrative'` in that SAME region (#3202).
 *
 * The exemption must be region-scoped: the old gate searched the whole file
 * for a non-validated fixKind, so a source shipping one correctly-marked
 * manual fix silently exempted a DIFFERENT default-validated fix carrying a
 * host path / custom CLI / slash command — exactly the copy-paste-unsafe
 * publication the gate exists to prevent.
 */
function hasUndeclaredNonPortableFixRegion(src: string): boolean {
  return fixRegions(src).some(
    (region) =>
      NON_PORTABLE_SNIPPET_PATTERNS.some((p) => p.pattern.test(region)) &&
      !/fixKind:\s*'(manual|illustrative)'/.test(region)
  );
}

describe('per-fix-region exemption scoping (#3202)', () => {
  // Negative control: TWO fixes in one source — a correctly-marked manual fix
  // followed by a default-validated fix whose snippet embeds `claude-team`.
  const manualFix = [
    "fix: {",
    "  target: 'CLAUDE.md',",
    "  label: 'Apply by hand',",
    "  fixKind: 'manual',",
    "  snippet: 'claude-team redispatch --team x',",
    "},",
  ].join('\n');
  const validatedUnsafeFix = [
    "fix: {",
    "  target: 'CLAUDE.md',",
    "  label: 'Paste this',",
    "  snippet: 'claude-team redispatch --only-unread',",
    "},",
  ].join('\n');

  it('reports a default-validated non-portable fix even when another fix in the file is marked manual', () => {
    // The whole-file regex would find the first fix's `fixKind: 'manual'` and
    // wave the second, unsafe fix through.
    expect(hasUndeclaredNonPortableFixRegion(`${manualFix}\n${validatedUnsafeFix}`)).toBe(true);
  });

  it('passes once that second fix is also marked manual', () => {
    const flipped = validatedUnsafeFix.replace(
      "  label: 'Paste this',",
      "  label: 'Paste this',\n  fixKind: 'manual',"
    );
    expect(hasUndeclaredNonPortableFixRegion(`${manualFix}\n${flipped}`)).toBe(false);
  });

  it('passes a clean validated fix alongside a manual one', () => {
    const cleanValidated = "fix: {\n  snippet: '{ \"permissions\": { \"allow\": [] } }',\n},";
    expect(hasUndeclaredNonPortableFixRegion(`${manualFix}\n${cleanValidated}`)).toBe(false);
  });

  it('still reports a lone default-validated non-portable fix', () => {
    expect(hasUndeclaredNonPortableFixRegion(validatedUnsafeFix)).toBe(true);
  });
});

describe('detector fix-snippet portability gate (#1101)', () => {
  it('every detector embedding a non-portable reference marks that fix non-validated in the same region (#3202)', () => {
    const offenders: string[] = [];
    for (const file of detectorSourceFiles()) {
      const src = readFileSync(file, 'utf8');
      // Each fix region shipping a non-portable reference must itself declare
      // manual/illustrative so the UI never presents it as copy-paste-safe —
      // a declaration on a DIFFERENT fix in the same file does not count.
      if (hasUndeclaredNonPortableFixRegion(src)) {
        offenders.push(file.replace(REPO_ROOT + '/', ''));
      }
    }
    expect(offenders, `validated fix snippets with non-portable references: ${offenders.join(', ')}`).toEqual([]);
  });
});
