import { describe, expect, it } from 'vitest';

import {
  currentRiskIncreasingPolicyChanges,
  detector,
  isRiskIncreasingPolicyChange,
} from './policy-change';
import {
  diffConfigDrift,
  type ConfigSnapshot,
  type DriftEvent,
  type ProjectConfig,
} from '../../parse-backups';
import type { RecommendationInput } from '../types';

const PROJECT = '/repo/app';

function snapshot(timestamp: number, projectConfig: ProjectConfig): ConfigSnapshot {
  return {
    timestamp,
    filename: `.claude.json.backup.${timestamp}`,
    projectConfig,
    globalMcpServerKeys: [],
  };
}

function recFor(events: DriftEvent[]) {
  return detector.rule({ configBackups: events } as RecommendationInput, Date.UTC(2026, 0, 1));
}

describe('safety.policy-change (#1799)', () => {
  it('fires when backup drift expands trust or tool access', () => {
    const events = diffConfigDrift(
      [
        snapshot(1_000, {
          hasTrustDialogAccepted: false,
          enableAllProjectMcpServers: false,
          disabledMcpjsonServers: ['github'],
          enabledMcpjsonServers: [],
          mcpServers: {},
        }),
        snapshot(2_000, {
          hasTrustDialogAccepted: true,
          enableAllProjectMcpServers: true,
          disabledMcpjsonServers: [],
          enabledMcpjsonServers: ['github'],
          mcpServers: { local: {} },
        }),
      ],
      PROJECT
    );

    const rec = recFor(events);

    expect(rec?.id).toBe('safety.policy-change');
    expect(rec?.severity).toBe('warning');
    expect(rec?.view).toBe('permissions');
    expect(rec?.affected).toBe(4);
    expect(rec?.projects).toEqual([PROJECT]);
    expect(rec?.evidence).toEqual(
      expect.arrayContaining([
        expect.stringContaining('trust-flip false -> true'),
        expect.stringContaining('enable-all-flip false -> true'),
        expect.stringContaining('server=github server-enabled disabled -> enabled'),
        expect.stringContaining('server=local repo-server-appeared ? -> local'),
      ])
    );
  });

  it('stays quiet when drift only tightens policy', () => {
    const events = diffConfigDrift(
      [
        snapshot(1_000, {
          hasTrustDialogAccepted: true,
          enableAllProjectMcpServers: true,
          disabledMcpjsonServers: [],
          enabledMcpjsonServers: ['github'],
          mcpServers: { local: {} },
        }),
        snapshot(2_000, {
          hasTrustDialogAccepted: false,
          enableAllProjectMcpServers: false,
          disabledMcpjsonServers: ['github'],
          enabledMcpjsonServers: [],
          mcpServers: {},
        }),
      ],
      PROJECT
    );

    expect(events.map((event) => event.kind)).toEqual(
      expect.arrayContaining([
        'trust-flip',
        'enable-all-flip',
        'repo-server-vanished',
        'server-disabled',
      ])
    );
    expect(recFor(events)).toBeNull();
  });

  it('uses the latest transition per policy dimension', () => {
    const events: DriftEvent[] = [
      {
        kind: 'server-enabled',
        project: PROJECT,
        server: 'github',
        from: 'disabled',
        to: 'enabled',
        timestamp: 1_000,
        severity: 'info',
      },
      {
        kind: 'server-disabled',
        project: PROJECT,
        server: 'github',
        from: 'enabled',
        to: 'disabled',
        timestamp: 2_000,
        severity: 'warning',
      },
      {
        kind: 'trust-flip',
        project: PROJECT,
        from: false,
        to: true,
        timestamp: 3_000,
        severity: 'warning',
      },
      {
        kind: 'trust-flip',
        project: PROJECT,
        from: true,
        to: false,
        timestamp: 4_000,
        severity: 'warning',
      },
    ];

    expect(currentRiskIncreasingPolicyChanges(events)).toEqual([]);
  });

  it('keeps currently expanded dimensions when later tightening happens elsewhere', () => {
    const serverEnabled: DriftEvent = {
      kind: 'server-enabled',
      project: PROJECT,
      server: 'github',
      from: 'disabled',
      to: 'enabled',
      timestamp: 1_000,
      severity: 'info',
    };
    const trustTightened: DriftEvent = {
      kind: 'trust-flip',
      project: PROJECT,
      from: true,
      to: false,
      timestamp: 2_000,
      severity: 'warning',
    };

    expect(currentRiskIncreasingPolicyChanges([serverEnabled, trustTightened])).toEqual([
      serverEnabled,
    ]);
    expect(isRiskIncreasingPolicyChange(trustTightened)).toBe(false);
  });

  it('stays quiet without backup drift data', () => {
    expect(recFor([])).toBeNull();
  });
});
