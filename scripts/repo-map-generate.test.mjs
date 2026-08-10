// Coverage for the repo-map producer's fail-closed env parsing (#3477, epic
// #1930).
//
// Run under register-ts (the producer imports the TS repo-map barrel):
//   node --import ./scripts/register-ts.mjs --test scripts/repo-map-generate.test.mjs
//
// The defect this pins — fourth instance of the fail-open-parse class #3076
// removed from the cold-ingest bench: the producer read every REPO_MAP_* size
// override as `Number(env) || DEFAULT`, so `Number('12g')` -> `NaN`, and
// `NaN || DEFAULT` -> `DEFAULT`. An operator setting `REPO_MAP_MAX_BYTES=12g`
// (or `0`, or a negative) got a silently default-sized 1 MiB artifact — their
// stated intent discarded with no warning — while the GATE parses the same
// override fail-closed (PR #3476), so gate and producer disagreed on invalid
// input. Every rejection asserted here exited 0 and shipped the default under
// the pre-#3477 implementation, so this suite fails against it by construction.
//
// The producer writes to `~/.claude/usage-data/repo-map/` via homedir(), which
// honors $HOME on Linux — each run gets a sandboxed HOME so nothing touches the
// real tree (same pattern as repo-map-refresh.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const GENERATOR = join(PROJECT_DIR, 'scripts', 'repo-map-generate.mjs');
const REGISTER_TS = join(PROJECT_DIR, 'scripts', 'register-ts.mjs');

/** A small parseable corpus with intra-repo imports (mirrors the gate suite). */
function makeFixture() {
  const base = mkdtempSync(join(tmpdir(), 'repo-map-generate-'));
  const home = join(base, 'home');
  const root = join(base, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  for (let i = 0; i < 12; i++) {
    const imports = i > 0 ? `import { helper${i - 1} } from './mod${i - 1}';\n` : '';
    const body = Array.from(
      { length: 6 },
      (_, k) =>
        `export function helper${i}_${k}(argumentNumber${k}: string, second${k}: number): string {\n` +
        `  return argumentNumber${k} + String(second${k});\n}`
    ).join('\n');
    writeFileSync(
      join(root, 'src', `mod${i}.ts`),
      `${imports}export function helper${i}(): number { return ${i}; }\n${body}\n`
    );
  }
  return { base, home, root };
}

function git(root, args) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

/** Run the producer with a sandboxed HOME. Strips any ambient REPO_MAP_* vars
 *  so only the overrides under test are set. */
function runProducer(fx, env = {}) {
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('REPO_MAP_'))
  );
  const r = spawnSync(process.execPath, ['--import', REGISTER_TS, GENERATOR, fx.root], {
    cwd: PROJECT_DIR,
    encoding: 'utf8',
    env: {
      ...cleanEnv,
      HOME: fx.home,
      REPO_MAP_FILE_CACHE_DIR: join(fx.base, 'parse-cache'),
      ...env,
    },
  });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

function artifacts(fx) {
  const dir = join(fx.home, '.claude', 'usage-data', 'repo-map');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(dir, f));
}

test('an unusable REPO_MAP_MAX_BYTES exits non-zero and ships NO artifact', () => {
  const fx = makeFixture();
  try {
    const r = runProducer(fx, { REPO_MAP_MAX_BYTES: '12g' });
    assert.equal(r.code, 2, `expected a hard error, got exit ${r.code}:\n${r.out}`);
    assert.match(r.out, /REPO_MAP_MAX_BYTES.*not a finite number/);
    // The old implementation shipped a default-sized artifact here.
    assert.equal(artifacts(fx).length, 0, 'no artifact may be written on a rejected override');
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test('zero and negative REPO_MAP_MAX_BYTES are rejected, not swallowed into the default', () => {
  const fx = makeFixture();
  try {
    for (const bad of ['0', '-5']) {
      const r = runProducer(fx, { REPO_MAP_MAX_BYTES: bad });
      assert.equal(r.code, 2, `expected a hard error for ${bad}, got exit ${r.code}:\n${r.out}`);
      assert.match(r.out, /REPO_MAP_MAX_BYTES.*out of range/);
    }
    assert.equal(artifacts(fx).length, 0);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test('the neighbouring discovery/budget overrides are parsed just as strictly', () => {
  const fx = makeFixture();
  try {
    const cases = [
      ['REPO_MAP_MAX_FILES', '12g', /REPO_MAP_MAX_FILES.*not a finite number/],
      ['REPO_MAP_MAX_DIR_ENTRIES', '0', /REPO_MAP_MAX_DIR_ENTRIES.*out of range/],
      ['REPO_MAP_TOKEN_BUDGET', '1.5', /REPO_MAP_TOKEN_BUDGET.*not an integer/],
      ['REPO_MAP_FILE_CACHE_MAX_BYTES', '-1', /REPO_MAP_FILE_CACHE_MAX_BYTES.*out of range/],
    ];
    for (const [name, value, pattern] of cases) {
      const r = runProducer(fx, { [name]: value });
      assert.equal(r.code, 2, `expected a hard error for ${name}=${value}, got exit ${r.code}:\n${r.out}`);
      assert.match(r.out, pattern);
    }
    assert.equal(artifacts(fx).length, 0);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test('a VALID REPO_MAP_MAX_BYTES is still honored: the artifact fits the requested ceiling', () => {
  const fx = makeFixture();
  try {
    const ceiling = 3000;
    const r = runProducer(fx, { REPO_MAP_MAX_BYTES: String(ceiling) });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /size-bounded \(dropped [1-9]\d* low-rank files to fit 3000 B\)/);

    const files = artifacts(fx);
    assert.equal(files.length, 1, `expected exactly one artifact, got ${files.length}`);
    const raw = readFileSync(files[0], 'utf8');
    assert.ok(
      Buffer.byteLength(raw, 'utf8') <= ceiling,
      `persisted artifact ${Buffer.byteLength(raw, 'utf8')} B exceeds the requested ${ceiling} B`
    );
    // And it is still a consumable envelope, not a truncated write.
    const parsed = JSON.parse(raw);
    assert.equal(parsed.sizeBounded, true);
    assert.ok(parsed.map.files.length > 0);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test('unset overrides still mean the documented defaults (fallback path intact)', () => {
  const fx = makeFixture();
  try {
    const r = runProducer(fx);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /12 files indexed/);
    assert.equal(artifacts(fx).length, 1);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test('clean repos stamp canonical HEAD while dirty repos retain the mtime fallback', () => {
  const fx = makeFixture();
  try {
    git(fx.root, ['init', '--quiet']);
    git(fx.root, ['add', '.']);
    git(fx.root, [
      '-c',
      'user.name=Repo Map Test',
      '-c',
      'user.email=repo-map@example.invalid',
      'commit',
      '--quiet',
      '-m',
      'fixture',
    ]);
    const expectedHead = git(fx.root, ['rev-parse', 'HEAD']);

    const clean = runProducer(fx);
    assert.equal(clean.code, 0, clean.out);
    let persisted = JSON.parse(readFileSync(artifacts(fx)[0], 'utf8'));
    assert.equal(persisted.map.generatedAtGitSha, expectedHead);
    assert.equal(persisted.cacheKey.gitSha, expectedHead);

    const artifact = artifacts(fx)[0];
    chmodSync(artifact, 0o600);
    writeFileSync(join(fx.root, 'src', 'mod0.ts'), '// dirty\n');
    const dirty = runProducer(fx);
    assert.equal(dirty.code, 0, dirty.out);
    persisted = JSON.parse(readFileSync(artifact, 'utf8'));
    assert.equal(persisted.map.generatedAtGitSha, null);
    assert.equal(persisted.cacheKey.gitSha, null);
    assert.equal(
      statSync(artifact).mode & 0o777,
      0o600,
      'atomic refresh must not widen an existing private artifact mode'
    );
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});
