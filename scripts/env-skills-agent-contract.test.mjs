// env-skills agent scope contract (#3343).
//
// The env-skills project agent is a model-backed component owner whose Read
// results become subscription-OAuth model context. Its definition once granted
// blanket `~/.claude/**` read authority, which permitted session history,
// credentials, and keys to flow into model calls — gitignore only prevents
// commits, not LLM egress (ADR 0008). This suite pins the fix on two layers:
//
// 1. STATIC REVIEW of `.claude/agents/env-skills.md`: no blanket tree grant;
//    the excluded classes (.credentials.json, keys, *.jsonl, history/,
//    projects/, runtime data) are named; the subscription-OAuth invariant is
//    stated.
// 2. PERMISSION LAYER in `.claude/settings.json`: project-scope Read deny
//    rules cover representative secret paths while leaving the documented
//    configuration allowlist readable.
//
// Deliberately NOT settings-level: `*.jsonl`, `history/`, `projects/` denies.
// Those stay definition-level instructions because a project-wide Read deny
// would break legitimate dashboard work — workflow journals live under
// `~/.claude/projects/**`, shadow-calls ledgers are `.jsonl`, and auto-memory
// recall reads memory files from `~/.claude/projects/**`. Credentials and key
// material have no legitimate read path in ANY session here, so only those are
// enforced repo-wide.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const agentDef = readFileSync(
  join(repoRoot, '.claude', 'agents', 'env-skills.md'),
  'utf8'
);
const settings = JSON.parse(
  readFileSync(join(repoRoot, '.claude', 'settings.json'), 'utf8')
);

/** Convert one permission-rule glob (supports `**` and `*`) to an anchored RegExp. */
export function globToRegExp(glob) {
  let out = '^';
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 3;
      continue;
    }
    if (glob.startsWith('**', i)) {
      out += '.*';
      i += 2;
      continue;
    }
    const c = glob[i];
    if (c === '*') out += '[^/]*';
    else if ('\\^$.|?+()[]{}'.includes(c)) out += '\\' + c;
    else out += c;
    i++;
  }
  return new RegExp(out + '$');
}

const denyRules = settings.permissions?.deny ?? [];
const readDenyGlobs = denyRules
  .map((rule) => /^Read\((.+)\)$/.exec(rule)?.[1])
  .filter(Boolean);
const deniedByRead = (path) =>
  readDenyGlobs.some((glob) => globToRegExp(glob).test(path));

test('agent definition carries no blanket ~/.claude tree grant', () => {
  assert.ok(
    !agentDef.includes('~/.claude/**'),
    'env-skills.md must not grant (or even mention) the blanket ~/.claude/** scope'
  );
  assert.match(
    agentDef,
    /explicit ALLOWLIST/,
    'scope section must present itself as an explicit allowlist'
  );
});

test('agent definition names every excluded data class', () => {
  for (const marker of [
    '.credentials.json',
    '*.jsonl',
    '~/.claude/history/',
    '~/.claude/projects/',
    '~/.claude/usage-data/',
    'runtime data',
    'key / token / secret',
  ]) {
    assert.ok(
      agentDef.includes(marker),
      `env-skills.md must explicitly exclude: ${marker}`
    );
  }
});

test('agent definition states the subscription-OAuth invariant', () => {
  assert.match(
    agentDef.replace(/\s+/g, ' '),
    /Subscription-OAuth model context must never contain `~\/\.claude`-derived secrets or session content/
  );
});

test('settings deny rules block representative secret reads', () => {
  for (const path of [
    '~/.claude/.credentials.json',
    '~/.claude/keys/gh-deploy.pem',
    '~/.claude/certs/host.key',
    '~/.claude/id.key',
  ]) {
    assert.ok(deniedByRead(path), `expected a Read deny rule to match ${path}`);
  }
});

test('settings deny rules leave the configuration allowlist readable', () => {
  for (const path of [
    '~/.claude/settings.json',
    '~/.claude/AGENTS.md',
    '~/.claude/CLAUDE.md',
    '~/.claude/skills/recs/SKILL.md',
    '~/.claude/hooks/stop-dispatch.mjs',
    '~/.claude/agents/env-skills.md',
    '~/.claude/shadow-calls/lib/judge.mjs',
  ]) {
    assert.ok(!deniedByRead(path), `allowlisted path must not be denied: ${path}`);
  }
});
