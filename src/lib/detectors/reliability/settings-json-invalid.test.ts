import { describe, it, expect } from 'vitest';
import { validateSettingsJson } from '../../config-hygiene';
import { validateFixSnippet } from '../fix-validity';
import { validateRecProvenance } from '../provenance';
import { detector } from './settings-json-invalid';
import type { RecommendationInput } from '../types';
import type { SettingsEnvironmentObservation, SettingsHealthFinding } from '../../../types';

const input = (
  findings: SettingsHealthFinding[] | null,
  environment?: SettingsEnvironmentObservation
): RecommendationInput => ({
  tokenData: [], toolData: [], sessions: [], projects: [], permissionRows: [], apiErrors: [],
  liveConfig: findings === null
    ? null
    : {
        settingsHealth: {
          filePath: '~/.claude/settings.json',
          present: true,
          ok: !findings.some((finding) => finding.severity === 'error'),
          findings,
          environment,
        },
      } as unknown as RecommendationInput['liveConfig'],
});

describe('reliability.settings-json-invalid (#417, #2421)', () => {
  it('emits a path-specific manual fix for a type mismatch', () => {
    const rec = detector.rule(input([
      { kind: 'type', severity: 'error', path: 'model', message: 'expected string' },
    ], { source: 'host-launch', definedNames: [] }), 0);

    expect(rec?.affected).toBe(1);
    expect(rec?.fix).toMatchObject({
      target: 'settings.json',
      label: 'Fix model',
      fixKind: 'manual',
    });
    expect(rec?.fix?.snippet).toContain('model');
    expect(validateFixSnippet(rec!.fix!)).toEqual([]);
  });

  it('prioritizes invalidating errors while retaining missing-variable remediation', () => {
    const rec = detector.rule(input([
      { kind: 'type', severity: 'error', path: 'model', message: 'expected string' },
      {
        kind: 'missing-env', severity: 'warning', path: 'hooks.PreToolUse[0].command',
        environmentVariable: 'CLAUDE_PLUGIN_ROOT', message: 'missing CLAUDE_PLUGIN_ROOT',
      },
    ], { source: 'host-launch', definedNames: [] }), 0);

    expect(rec?.affected).toBe(2);
    expect(rec?.fix).toMatchObject({
      target: 'settings.json',
      label: 'Fix model',
      fixKind: 'manual',
    });
    expect(rec?.fix?.snippet).toContain('model');
    expect(rec?.fixes).toHaveLength(2);
    expect(rec?.fixes?.[1].snippet).toContain('hooks.PreToolUse[0].command');
    expect(rec?.fixes?.[1].snippet).toContain('CLAUDE_PLUGIN_ROOT');
    for (const fix of rec?.fixes ?? []) expect(validateFixSnippet(fix)).toEqual([]);
    expect(rec?.provenance?.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'host-launch environment name snapshot' }),
    ]));
    expect(rec?.provenance?.inference).toContain(
      'Structural findings identify current settings-file problems.'
    );
    expect(rec?.provenance?.inference).toContain(
      "Missing-environment findings establish only that names were absent from the dashboard host launch snapshot; verify Claude Code's launch environment."
    );
    expect(JSON.stringify(rec)).not.toContain('super-secret');
  });

  it('fires for warning-only unknown-key and rule-format findings', () => {
    for (const finding of [
      { kind: 'unknown-key', severity: 'warning', path: 'permisions', message: 'looks like permissions' },
      { kind: 'rule-format', severity: 'warning', path: 'permissions.allow[0]', message: 'bad rule' },
    ] satisfies SettingsHealthFinding[]) {
      const rec = detector.rule(input([finding]), 0);
      expect(rec?.fix?.snippet).toContain(finding.path);
    }
  });

  it('does not expose malformed permission-rule values in health or recommendations', () => {
    const sentinel = 'sentinel-secret-value';
    const health = validateSettingsJson(
      '~/.claude/settings.json',
      JSON.stringify({
        permissions: { allow: [`Bash(curl -H TOKEN=${sentinel}`] },
      })
    );
    const rec = detector.rule(input(health.findings), 0);

    expect(health.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'rule-format',
        path: 'permissions.allow[0]',
        message: 'Permission rule should use "Tool" or "Tool(specifier)" syntax.',
      }),
    ]));
    expect(rec).not.toBeNull();
    expect(JSON.stringify({ health, rec })).not.toContain(sentinel);
  });

  it.each([
    {
      raw: '{"env":{"TOKEN":"quoted-syntax-sentinel",}}',
      sentinel: 'quoted-syntax-sentinel',
    },
    {
      raw: '{"env":{"TOKEN":UNQUOTED_SYNTAX_SENTINEL}}',
      sentinel: 'UNQUOTED_SYNTAX_SENTINEL',
    },
  ])('does not expose malformed JSON input in health or recommendations', ({
    raw,
    sentinel,
  }) => {
    const health = validateSettingsJson('~/.claude/settings.json', raw);
    const rec = detector.rule(input(health.findings), 0);
    const [finding] = health.findings;

    expect(finding).toMatchObject({
      kind: 'syntax',
      message: 'Invalid JSON syntax; repair the document and retry.',
    });
    expect(finding).not.toHaveProperty('excerpt');
    expect(rec).not.toBeNull();
    expect(JSON.stringify({ health, rec })).not.toContain(sentinel);
  });

  it('cites every finding with compliant provenance and proof posture', () => {
    const rec = detector.rule(input([
      { kind: 'type', severity: 'error', path: 'model', message: 'expected string' },
      { kind: 'unknown-key', severity: 'warning', path: 'permisions', message: 'typo' },
    ]), 0)!;

    expect(rec.evidence).toHaveLength(2);
    expect(rec.provenance?.observations).toHaveLength(3);
    expect(validateRecProvenance(rec.provenance!)).toEqual([]);
    expect(rec.claimClass).toBe('accounting');
    expect(rec.proofTier).toBe('accounting');
  });

  it('stays silent when the file, observation, or findings are absent', () => {
    expect(detector.rule(input([]), 0)).toBeNull();
    expect(detector.rule(input(null), 0)).toBeNull();
    const absent = input([]);
    absent.liveConfig!.settingsHealth = { filePath: 'x', present: false, ok: true, findings: [] };
    expect(detector.rule(absent, 0)).toBeNull();
  });

  it('suppresses missing-env findings without a supporting snapshot or when now defined', () => {
    const missing: SettingsHealthFinding = {
      kind: 'missing-env', severity: 'warning', path: 'hooks.Stop[0].command',
      environmentVariable: 'TOKEN', message: 'TOKEN unobserved',
    };
    expect(detector.rule(input([missing]), 0)).toBeNull();
    expect(detector.rule(input([missing], {
      source: 'host-launch', definedNames: ['TOKEN'],
    }), 0)).toBeNull();
    expect(detector.rule(input([missing], {
      source: 'host-launch', definedNames: [],
    }), 0)).not.toBeNull();
  });

  it('uses a finding-specific local source in remediation and provenance', () => {
    const rec = detector.rule(input([{
      kind: 'missing-env',
      severity: 'warning',
      path: 'env.LOCAL_TOKEN',
      environmentVariable: 'TOKEN_ROOT',
      message: 'TOKEN_ROOT unobserved',
      sourcePath: '~/.claude/settings.local.json',
    }], { source: 'host-launch', definedNames: [] }), 0)!;

    expect(rec.fix?.snippet).toContain('~/.claude/settings.local.json');
    expect(rec.provenance?.observations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: '~/.claude/settings.local.json',
        field: 'settingsHealth.findings[0]',
      }),
    ]));
    expect(validateFixSnippet(rec.fix!)).toEqual([]);
    expect(validateRecProvenance(rec.provenance!)).toEqual([]);
  });

  it('bounds detailed remediation while preserving the full affected count', () => {
    const findings: SettingsHealthFinding[] = Array.from({ length: 25 }, (_, index) => ({
      kind: 'type', severity: 'error', path: `hooks.Stop[${index}]`, message: 'expected object',
    }));
    const rec = detector.rule(input(findings), 0);
    expect(rec?.affected).toBe(25);
    expect(rec?.fixes).toHaveLength(10);
    expect(rec?.provenance?.observations).toHaveLength(11);
    expect(rec?.action).toContain('first 10');
  });
});
