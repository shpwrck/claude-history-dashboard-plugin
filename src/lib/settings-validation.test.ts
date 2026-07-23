import { describe, expect, it } from 'vitest';

import { validateSettingsJson } from './config-hygiene';

// Regression tests for settings.json validation (#167). Relocated from
// scripts/settings-validation.test.mjs into the Vitest suite (#2954): it tests a
// pure src/lib function (validateSettingsJson from config-hygiene.ts), so moving
// it under the `src/**/*.test.ts` glob runs it in CI on every PR instead of only
// when someone remembered `npm run test:settings`.

const P = '~/.claude/settings.json';

describe('validateSettingsJson (#167)', () => {
  it('flags the orphan-brace block (invalid JSON that silently produced no rules) as a syntax error', () => {
    const orphanBrace = `{
  {
    "permissions": { "deny": ["Bash(rm -rf:*)"] },
    "defaultMode": "acceptEdits"
  }
}`;
    const r = validateSettingsJson(P, orphanBrace);
    expect(r.ok).toBe(false);
    expect(r.present).toBe(true);
    const syntax = r.findings.find((f) => f.kind === 'syntax');
    expect(syntax).toBeTruthy();
    expect(typeof syntax?.line).toBe('number');
    expect(syntax?.line ?? 0).toBeGreaterThanOrEqual(1);
    expect(syntax?.severity).toBe('error');
  });

  it('accepts valid settings with no findings', () => {
    const valid = JSON.stringify({
      model: 'claude-opus-4-8',
      permissions: { deny: ['Bash(rm -rf:*)'], allow: ['Bash(ls:*)', 'WebFetch'] },
      cleanupPeriodDays: 30,
      env: { FOO: 'bar' },
    });
    const r = validateSettingsJson(P, valid);
    expect(r.ok).toBe(true);
    expect(r.findings).toHaveLength(0);
  });

  it('warns (still ok) on a misspelled top-level key near a known one', () => {
    const r = validateSettingsJson(P, JSON.stringify({ permisions: {} }));
    expect(r.ok).toBe(true);
    expect(
      r.findings.some((f) => f.kind === 'unknown-key' && f.path === 'permisions')
    ).toBe(true);
  });

  it('does NOT flag genuinely-novel keys (no false "typo" on untracked settings)', () => {
    const r = validateSettingsJson(
      P,
      JSON.stringify({ inputNeededNotifEnabled: true, someFutureKey9000: 1 })
    );
    expect(r.ok).toBe(true);
    expect(r.findings.some((f) => f.path === 'inputNeededNotifEnabled')).toBe(false);
    expect(r.findings.some((f) => f.path === 'someFutureKey9000')).toBe(false);
  });

  it('errors when permissions is the wrong type, with the path', () => {
    const r = validateSettingsJson(P, JSON.stringify({ permissions: ['Bash(ls:*)'] }));
    expect(r.ok).toBe(false);
    expect(
      r.findings.some((f) => f.path === 'permissions' && f.severity === 'error')
    ).toBe(true);
  });

  it('errors on a non-string rule inside deny with an indexed path', () => {
    const r = validateSettingsJson(
      P,
      JSON.stringify({ permissions: { deny: ['Bash(ls:*)', 123] } })
    );
    expect(
      r.findings.some(
        (f) => f.path === 'permissions.deny[1]' && f.severity === 'error'
      )
    ).toBe(true);
  });

  it('warns (not errors) on a malformed rule string', () => {
    const r = validateSettingsJson(
      P,
      JSON.stringify({ permissions: { allow: ['not a rule!'] } })
    );
    expect(r.ok).toBe(true);
    expect(
      r.findings.some(
        (f) => f.kind === 'rule-format' && f.path === 'permissions.allow[0]'
      )
    ).toBe(true);
  });

  it('errors when the top level is not an object', () => {
    const r = validateSettingsJson(P, JSON.stringify(['nope']));
    expect(r.ok).toBe(false);
    expect(r.findings.some((f) => f.kind === 'type' && f.path === '')).toBe(true);
  });

  it('treats an absent file as present:false, ok:true, no findings', () => {
    const r = validateSettingsJson(P, null);
    expect(r.present).toBe(false);
    expect(r.ok).toBe(true);
    expect(r.findings).toHaveLength(0);
  });

  it('reports missing env references by exact path, names-only, warning-only', () => {
    const r = validateSettingsJson(
      P,
      JSON.stringify({
        env: { FROM_SETTINGS: 'configured', CHAINED: '${FROM_HOST}' },
        hooks: {
          PreToolUse: [
            {
              command:
                '${MISSING}/bin/run ${FROM_SETTINGS} $FROM_HOST ${MISSING} \\${LITERAL}',
            },
          ],
        },
      }),
      { source: 'host-launch', definedNames: ['FROM_HOST'] }
    );
    const missing = r.findings.filter((f) => f.kind === 'missing-env');
    expect(missing).toHaveLength(1);
    expect(missing[0].path).toBe('hooks.PreToolUse[0].command');
    expect(missing[0].environmentVariable).toBe('MISSING');
    expect(r.ok).toBe(true);
    expect(missing[0].severity).toBe('warning');
    // Names only: the settings value "configured" must never be echoed back.
    expect(JSON.stringify(r).includes('configured')).toBe(false);
  });

  it('suppresses missing-env when host observation is absent', () => {
    const r = validateSettingsJson(
      P,
      JSON.stringify({ hooks: { Stop: [{ command: '$NOT_OBSERVED' }] } })
    );
    expect(r.findings.some((f) => f.kind === 'missing-env')).toBe(false);
  });

  it('treats a settings.env self-reference as missing unless host-defined', () => {
    const r = validateSettingsJson(
      P,
      JSON.stringify({ env: { TOKEN: '${TOKEN}' } }),
      { source: 'host-launch', definedNames: [] }
    );
    expect(
      r.findings.some(
        (f) =>
          f.kind === 'missing-env' &&
          f.path === 'env.TOKEN' &&
          f.environmentVariable === 'TOKEN'
      )
    ).toBe(true);
  });

  it('keeps settings.env cycle deps missing but resolves a literal-root chain', () => {
    const r = validateSettingsJson(
      P,
      JSON.stringify({
        env: { A: '${B}', B: '${A}', ROOT: 'literal', CHAIN: '${ROOT}' },
        hooks: { Stop: [{ command: '${A} ${CHAIN}' }] },
      }),
      { source: 'host-launch', definedNames: [] }
    );
    expect(
      ['A', 'B'].every((name) =>
        r.findings.some(
          (f) => f.kind === 'missing-env' && f.environmentVariable === name
        )
      )
    ).toBe(true);
    expect(
      r.findings.some(
        (f) =>
          f.kind === 'missing-env' &&
          ['ROOT', 'CHAIN'].includes(f.environmentVariable ?? '')
      )
    ).toBe(false);
  });
});
