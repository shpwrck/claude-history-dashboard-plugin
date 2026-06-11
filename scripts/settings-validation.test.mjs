// Regression test for settings.json validation (#167).
//
// This repo has no formal test runner, so this is a standalone runnable check:
//   node --import ./scripts/register-ts.mjs scripts/settings-validation.test.mjs
// (also wired as `npm run test:settings`). Exits non-zero on the first failure.

import { validateSettingsJson } from '../src/lib/config-hygiene.ts';

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${name}`);
  }
}

const P = '~/.claude/settings.json';

// 1) The motivating case: the permissions/defaultMode block wrapped in an
//    unnamed inner object — invalid JSON that silently produced no rules.
const orphanBrace = `{
  {
    "permissions": { "deny": ["Bash(rm -rf:*)"] },
    "defaultMode": "acceptEdits"
  }
}`;
const r1 = validateSettingsJson(P, orphanBrace);
check('orphan brace → not ok', r1.ok === false);
check('orphan brace → present', r1.present === true);
const syntax = r1.findings.find((f) => f.kind === 'syntax');
check('orphan brace → syntax finding', !!syntax);
check('orphan brace → has a line number', typeof syntax?.line === 'number' && syntax.line >= 1);
check('orphan brace → error severity', syntax?.severity === 'error');

// 2) Valid settings → ok, no findings.
const valid = JSON.stringify({
  model: 'claude-opus-4-8',
  permissions: { deny: ['Bash(rm -rf:*)'], allow: ['Bash(ls:*)', 'WebFetch'] },
  cleanupPeriodDays: 30,
  env: { FOO: 'bar' },
});
const r2 = validateSettingsJson(P, valid);
check('valid → ok', r2.ok === true);
check('valid → no findings', r2.findings.length === 0);

// 3) Misspelled top-level key (near a known key) → warning, still ok.
const r3 = validateSettingsJson(P, JSON.stringify({ permisions: {} }));
check('typo key → ok (warning only)', r3.ok === true);
check('typo key → unknown-key warning', r3.findings.some((f) => f.kind === 'unknown-key' && f.path === 'permisions'));

// 3b) Genuinely-novel key (far from any known key) → NOT flagged, so the
//     dashboard doesn't cry "typo" at real settings it just doesn't track yet.
const r3b = validateSettingsJson(P, JSON.stringify({ inputNeededNotifEnabled: true, someFutureKey9000: 1 }));
check('novel keys → ok', r3b.ok === true);
check('known notif flag → no warning', !r3b.findings.some((f) => f.path === 'inputNeededNotifEnabled'));
check('far novel key → no warning', !r3b.findings.some((f) => f.path === 'someFutureKey9000'));

// 4) Wrong type for permissions → error with path.
const r4 = validateSettingsJson(P, JSON.stringify({ permissions: ['Bash(ls:*)'] }));
check('permissions array → error', r4.ok === false);
check('permissions array → path "permissions"', r4.findings.some((f) => f.path === 'permissions' && f.severity === 'error'));

// 5) Non-string rule inside deny → error with indexed path.
const r5 = validateSettingsJson(P, JSON.stringify({ permissions: { deny: ['Bash(ls:*)', 123] } }));
check('deny[1] number → error', r5.findings.some((f) => f.path === 'permissions.deny[1]' && f.severity === 'error'));

// 6) Malformed rule string → rule-format warning (not error).
const r6 = validateSettingsJson(P, JSON.stringify({ permissions: { allow: ['not a rule!'] } }));
check('bad rule string → ok (warning only)', r6.ok === true);
check('bad rule string → rule-format warning', r6.findings.some((f) => f.kind === 'rule-format' && f.path === 'permissions.allow[0]'));

// 7) Top level not an object → error.
const r7 = validateSettingsJson(P, JSON.stringify(['nope']));
check('array top level → error', r7.ok === false && r7.findings.some((f) => f.kind === 'type' && f.path === ''));

// 8) Absent file → present:false, ok:true.
const r8 = validateSettingsJson(P, null);
check('null raw → present:false ok:true', r8.present === false && r8.ok === true && r8.findings.length === 0);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll settings-validation checks passed.');
