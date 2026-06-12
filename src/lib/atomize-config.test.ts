// Tests for the atomizer codemod (#1268, epic #1264).
//
// scripts/atomize-config.mjs splits a monolithic CLAUDE.md/AGENTS.md into
// path-scoped .claude/rules/<topic>.md files, driven by the over-scoped
// detector's section->subtree mapping (#1267) or by CLI-side inference.
// Pinned here, per the issue's acceptance criteria:
//   - dry-run prints planned rule files + trimmed monolith and writes NOTHING;
//   - apply-then-revert round-trips to the byte-identical original;
//   - generated rule files carry valid `paths:` frontmatter scoped to the
//     section's subtree;
// plus the load-bearing internals: fence-aware section boundaries that stay in
// parity with parse-config-sections.ts (the codemod mirrors, not imports, that
// parser - it is privacy-scoped to never return bodies), invertible @import
// rewriting, idempotent re-apply, and detector-shaped mapping keys.

import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfigSections } from './parse-config-sections';
import {
  atomizeFile,
  buildPlan,
  componentSubtree,
  inferMapping,
  listSections,
  revertFile,
  rewriteImports,
  splitSections,
  unrewriteImports,
  // @ts-expect-error - plain .mjs script, no type declarations.
} from '../../scripts/atomize-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', '..', 'scripts', 'atomize-config.mjs');

const MONOLITH = `# Project conventions

Intro prose with no path refs.

## Build & deploy

Use \`npx vite build\`; entry points are src/lib/foo.ts and src/lib/bar.ts.
Shared rules: @AGENTS.md

\`\`\`bash
# example comment, not a heading
cat @AGENTS.md
\`\`\`

## Workflows

Edit .github/workflows/ci.yml and .github/workflows/publish.yml when gates change.

## Misc

No file references here.
`;

const tempDirs: string[] = [];

function makeTempMonolith(content: string = MONOLITH): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), 'atomize-config-test-'));
  tempDirs.push(dir);
  const file = join(dir, 'CLAUDE.md');
  writeFileSync(file, content);
  return { dir, file };
}

const quiet = { log: () => {}, warn: () => {} };

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('dry-run (acceptance: node scripts/atomize-config.mjs --dry-run <file>)', () => {
  it('prints planned rule files + trimmed monolith and writes nothing', () => {
    const { dir, file } = makeTempMonolith();
    const stdout = execFileSync('node', [SCRIPT, '--dry-run', file], {
      encoding: 'utf8',
    });

    // Planned rule files with their paths: frontmatter are printed.
    expect(stdout).toContain('would write .claude/rules/build-deploy.md');
    expect(stdout).toContain('paths: ["src/lib/**"]');
    expect(stdout).toContain('would write .claude/rules/workflows.md');
    expect(stdout).toContain('paths: [".github/workflows/**"]');
    // The trimmed monolith preview shows the markers replacing the sections.
    expect(stdout).toContain('-- trimmed CLAUDE.md --');
    expect(stdout).toContain('<!-- atomized: .claude/rules/build-deploy.md -->');
    expect(stdout).toContain('(dry-run: nothing written)');

    // Nothing was written: monolith byte-identical, no .claude dir appeared.
    expect(readFileSync(file, 'utf8')).toBe(MONOLITH);
    expect(existsSync(join(dir, '.claude'))).toBe(false);
    expect(readdirSync(dir)).toEqual(['CLAUDE.md']);
  });
});

describe('apply -> revert round trip', () => {
  it('restores the byte-identical original (including @import rewrites)', () => {
    const { dir, file } = makeTempMonolith();

    const applied = atomizeFile(file, quiet);
    expect(applied.written).toBe(true);
    expect(applied.plan.moves.map((m: { slug: string }) => m.slug)).toEqual([
      'build-deploy',
      'workflows',
    ]);

    // The split actually happened: sections moved, markers left behind.
    const trimmed = readFileSync(file, 'utf8');
    expect(trimmed).not.toContain('## Build & deploy');
    expect(trimmed).toContain('<!-- atomized: .claude/rules/build-deploy.md -->');

    const reverted = revertFile(file, quiet);
    expect(reverted.written).toBe(true);
    expect(reverted.reverted).toBe(2);
    expect(readFileSync(file, 'utf8')).toBe(MONOLITH);
    // Consumed rule files are deleted and the empty rules dir pruned.
    expect(existsSync(join(dir, '.claude'))).toBe(false);
  });

  it('rewrites relative @imports for rule-file depth and inverts them on revert', () => {
    const { dir, file } = makeTempMonolith();
    atomizeFile(file, quiet);

    const rule = readFileSync(join(dir, '.claude', 'rules', 'build-deploy.md'), 'utf8');
    // Unfenced import is re-anchored two levels up; the fenced example is not.
    expect(rule).toContain('Shared rules: @../../AGENTS.md');
    expect(rule).toContain('cat @AGENTS.md');

    revertFile(file, quiet);
    expect(readFileSync(file, 'utf8')).toBe(MONOLITH);
  });

  it('is idempotent: re-apply is a no-op and a mapped re-run warn-skips', () => {
    const { file } = makeTempMonolith();
    atomizeFile(file, quiet);
    const afterFirst = readFileSync(file, 'utf8');

    // Inferred re-apply finds nothing (markers are not path references).
    const second = atomizeFile(file, quiet);
    expect(second.written).toBe(false);
    expect(second.plan.moves).toEqual([]);
    expect(readFileSync(file, 'utf8')).toBe(afterFirst);

    // The detector mapping re-run resolves nothing (section already moved).
    const warnings: string[] = [];
    const third = atomizeFile(file, {
      mapping: new Map([['Build & deploy', 'src/lib']]),
      log: () => {},
      warn: (msg: string) => warnings.push(msg),
    });
    expect(third.written).toBe(false);
    expect(third.unresolved).toEqual(['Build & deploy']);
    expect(warnings.some((w) => w.includes('matched no section'))).toBe(true);

    // And the round trip still holds after all of that.
    revertFile(file, quiet);
    expect(readFileSync(file, 'utf8')).toBe(MONOLITH);
  });

  it('never moves a section that contains an atomized marker (revert anchor)', () => {
    const { file } = makeTempMonolith();
    atomizeFile(file, quiet);

    // "Project conventions" now holds the two markers in its body; an explicit
    // mapping for it must be refused or --revert could never find the markers.
    const result = atomizeFile(file, {
      mapping: new Map([['Project conventions', 'src/lib']]),
      ...quiet,
    });
    expect(result.written).toBe(false);
    expect(result.plan.skipped).toEqual([
      {
        slug: 'project-conventions',
        heading: 'Project conventions',
        reason: 'contains-atomized-marker',
      },
    ]);

    revertFile(file, quiet);
    expect(readFileSync(file, 'utf8')).toBe(MONOLITH);
  });
});

describe('revert marker containment', () => {
  it('never follows a marker outside the config directory', () => {
    // A hostile monolith whose marker points above its own directory: the
    // victim file (which legitimately carries an atomized-from header for the
    // same scope name) must be neither spliced in nor deleted.
    const outer = mkdtempSync(join(tmpdir(), 'atomize-config-escape-'));
    tempDirs.push(outer);
    const inner = join(outer, 'project');
    mkdirSync(inner);
    const victim = join(outer, 'victim.md');
    writeFileSync(
      victim,
      '---\npaths: ["src/**"]\natomized-from: CLAUDE.md\n---\nsecret rule body\n'
    );
    const file = join(inner, 'CLAUDE.md');
    const hostile = '# Doc\n\n<!-- atomized: ../victim.md -->\n';
    writeFileSync(file, hostile);

    const warnings: string[] = [];
    const result = revertFile(file, {
      log: () => {},
      warn: (msg: string) => warnings.push(msg),
    });

    expect(result.written).toBe(false);
    expect(result.reverted).toBe(0);
    expect(existsSync(victim)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(hostile);
    expect(result.restored).not.toContain('secret rule body');
    expect(warnings.some((w) => w.includes('escapes'))).toBe(true);
  });

  it('rejects absolute marker paths', () => {
    const { dir, file } = makeTempMonolith(
      '# Doc\n\n<!-- atomized: /etc/hostname -->\n'
    );
    const warnings: string[] = [];
    const result = revertFile(file, {
      log: () => {},
      warn: (msg: string) => warnings.push(msg),
    });
    expect(result.written).toBe(false);
    expect(result.reverted).toBe(0);
    expect(warnings.some((w) => w.includes('escapes'))).toBe(true);
    expect(readdirSync(dir)).toEqual(['CLAUDE.md']);
  });
});

describe('paths: frontmatter', () => {
  it('scopes each generated rule file to its section subtree', () => {
    const { dir, file } = makeTempMonolith();
    atomizeFile(file, quiet);

    const buildRule = readFileSync(join(dir, '.claude', 'rules', 'build-deploy.md'), 'utf8');
    const wfRule = readFileSync(join(dir, '.claude', 'rules', 'workflows.md'), 'utf8');

    // Valid frontmatter block: opening/closing --- with the paths glob, the
    // exact shape the detector's fix snippet prescribes (#1267).
    expect(buildRule.startsWith('---\npaths: ["src/lib/**"]\n')).toBe(true);
    expect(buildRule).toMatch(/^---\n[\s\S]*?\n---\n## Build & deploy\n/);
    expect(buildRule).toContain('atomized-from: CLAUDE.md');
    expect(wfRule.startsWith('---\npaths: [".github/workflows/**"]\n')).toBe(true);
    expect(wfRule).toMatch(/^---\n[\s\S]*?\n---\n## Workflows\n/);
  });

  it('accepts detector-shaped mapping keys: full section id, slug, heading', () => {
    for (const key of ['CLAUDE.md#build-deploy', 'build-deploy', 'Build & deploy']) {
      const { dir, file } = makeTempMonolith();
      atomizeFile(file, { mapping: new Map([[key, 'src/lib']]), ...quiet });
      const rule = readFileSync(join(dir, '.claude', 'rules', 'build-deploy.md'), 'utf8');
      expect(rule).toContain('paths: ["src/lib/**"]');
      // Explicit mapping moves only the mapped section.
      expect(readFileSync(file, 'utf8')).toContain('## Workflows');
    }
  });
});

describe('section model parity with parse-config-sections', () => {
  it('produces the same section ids/headings/levels as the TS parser', () => {
    const doc = [
      '---',
      'frontmatter: ignored',
      '---',
      'Preamble prose.',
      '',
      '# Top',
      '',
      '## Hooks!',
      'a',
      '## Hooks?',
      'b',
      '## Same',
      'x',
      '## Same',
      'y',
      '```',
      '# fenced, not a heading',
      '```',
      '',
    ].join('\n');

    const parsed = parseConfigSections({ scope: 'CLAUDE.md', content: doc });
    const mirrored = listSections(doc, 'CLAUDE.md');
    expect(mirrored.map((s: { id: string }) => s.id)).toEqual(parsed.map((s) => s.id));
    expect(mirrored.map((s: { heading: string }) => s.heading)).toEqual(
      parsed.map((s) => s.heading)
    );
    expect(mirrored.map((s: { level: number }) => s.level)).toEqual(
      parsed.map((s) => s.level)
    );
  });

  it('splits losslessly: sections partition the document bytes exactly', () => {
    for (const doc of [MONOLITH, '', 'no headings at all', '# h\nbody', 'tail\n']) {
      const sections = splitSections(doc) as Array<{ lines: string[] }>;
      expect(sections.flatMap((s) => s.lines).join('\n')).toBe(doc);
    }
  });
});

describe('subtree inference (detector mirror)', () => {
  it('mirrors the detector componentSubtree rule', () => {
    expect(componentSubtree('src/lib/foo.ts')).toBe('src/lib');
    expect(componentSubtree('src/foo.ts')).toBe('src');
    expect(componentSubtree('tools/x/y.mjs')).toBe('tools/x');
    expect(componentSubtree('.github/workflows/ci.yml')).toBe('.github/workflows');
    expect(componentSubtree('scripts/atomize-config.mjs')).toBe('scripts');
    expect(componentSubtree('README.md')).toBe(null);
  });

  it('infers only sections whose references share one subtree', () => {
    const mapping = inferMapping(splitSections(MONOLITH)) as Map<string, string>;
    expect([...mapping.entries()]).toEqual([
      ['build-deploy', 'src/lib'],
      ['workflows', '.github/workflows'],
    ]);
    // "Misc" (no refs) and the mixed/preamble sections are never proposed.
    expect(mapping.has('misc')).toBe(false);
    expect(mapping.has('project-conventions')).toBe(false);
  });
});

describe('import rewriting is exactly invertible', () => {
  it('round-trips bodies through rewrite/unrewrite, fence-aware', () => {
    const body = [
      'See @AGENTS.md and @docs/RELEASING.md.',
      'Already-relative: @../../up.md and absolute @/etc/conf.md stay sane.',
      '```',
      '@AGENTS.md inside a fence is untouched',
      '```',
    ].join('\n');
    const rewritten = rewriteImports(body, '../../');
    expect(rewritten).toContain('@../../AGENTS.md');
    expect(rewritten).toContain('@../../docs/RELEASING.md');
    expect(rewritten).toContain('@../../../../up.md');
    expect(rewritten).toContain('@/etc/conf.md');
    expect(rewritten).toContain('@AGENTS.md inside a fence is untouched');
    expect(unrewriteImports(rewritten, '../../')).toBe(body);
  });
});

describe('plan shape', () => {
  it('exposes detector-aligned move records', () => {
    const plan = buildPlan({
      content: MONOLITH,
      scope: 'AGENTS.md',
      mapping: new Map([['build-deploy', 'src/lib']]),
    });
    expect(plan.moves).toHaveLength(1);
    expect(plan.moves[0]).toMatchObject({
      id: 'AGENTS.md#build-deploy',
      slug: 'build-deploy',
      heading: 'Build & deploy',
      subtree: 'src/lib',
      pathsGlob: 'src/lib/**',
      rulePathRel: '.claude/rules/build-deploy.md',
    });
    expect(plan.trimmedContent).toContain('<!-- atomized: .claude/rules/build-deploy.md -->');
    expect(plan.trimmedContent).toContain('## Workflows');
  });
});
