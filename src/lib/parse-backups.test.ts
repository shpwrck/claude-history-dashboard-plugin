/**
 * Tests for parse-backups.ts — ConfigSnapshot parsing and drift diffing.
 *
 * Uses inline fixtures and temp-dir parser checks so tests are fully hermetic
 * and run offline. Covers the five core drift scenarios plus the global-churn
 * counter.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { diffConfigDrift, parseBackupsDir } from './parse-backups';
import type { ConfigSnapshot, DriftEvent } from './parse-backups';

// ── Fixture helpers ──────────────────────────────────────────────────────────

const T0 = 1_717_200_000_000; // arbitrary base epoch-ms
const H = 3_600_000; // 1 hour in ms

function snap(
  offset: number,
  opts: {
    trust?: boolean;
    enableAll?: boolean;
    enabled?: string[];
    disabled?: string[];
    mcpServers?: string[];
    globalMcp?: string[];
  } = {}
): ConfigSnapshot {
  return {
    timestamp: T0 + offset * H,
    filename: `.claude.json.backup.${T0 + offset * H}`,
    projectConfig: {
      hasTrustDialogAccepted: opts.trust ?? true,
      enableAllProjectMcpServers: opts.enableAll ?? false,
      enabledMcpjsonServers: opts.enabled ?? [],
      disabledMcpjsonServers: opts.disabled ?? [],
      mcpServers: Object.fromEntries((opts.mcpServers ?? []).map((k) => [k, {}])),
    },
    globalMcpServerKeys: opts.globalMcp ?? [],
  };
}

const PROJECT = '/home/user/work/payments-monorepo';

// ── diffConfigDrift tests ────────────────────────────────────────────────────

describe('diffConfigDrift', () => {
  it('returns empty when fewer than 2 snapshots', () => {
    expect(diffConfigDrift([], PROJECT)).toEqual([]);
    expect(diffConfigDrift([snap(0)], PROJECT)).toEqual([]);
  });

  it('emits nothing when snapshots are identical', () => {
    const snaps = [
      snap(0, { enabled: ['postgres', 'jira'], mcpServers: ['postgres', 'jira'] }),
      snap(1, { enabled: ['postgres', 'jira'], mcpServers: ['postgres', 'jira'] }),
    ];
    const events = diffConfigDrift(snaps, PROJECT);
    expect(events).toHaveLength(0);
  });

  describe('server-disabled', () => {
    it('emits warning when a server moves into disabledMcpjsonServers', () => {
      const snaps = [
        snap(0, { enabled: ['postgres', 'jira'], disabled: [], mcpServers: ['postgres', 'jira'] }),
        snap(6, { enabled: ['jira'],             disabled: ['postgres'], mcpServers: ['postgres', 'jira'] }),
      ];
      const events = diffConfigDrift(snaps, PROJECT);
      const ev = events.find((e) => e.kind === 'server-disabled');
      expect(ev).toBeDefined();
      expect(ev!.server).toBe('postgres');
      expect(ev!.severity).toBe('warning');
      expect(ev!.project).toBe(PROJECT);
      expect(ev!.from).toBe('enabled');
      expect(ev!.to).toBe('disabled');
    });
  });

  describe('trust-flip', () => {
    it('emits warning when trust flips true -> false', () => {
      const snaps = [
        snap(0, { trust: true }),
        snap(26, { trust: false }),
      ];
      const events = diffConfigDrift(snaps, PROJECT);
      const ev = events.find((e) => e.kind === 'trust-flip');
      expect(ev).toBeDefined();
      expect(ev!.from).toBe(true);
      expect(ev!.to).toBe(false);
      expect(ev!.severity).toBe('warning');
    });

    it('emits warning when trust flips false -> true', () => {
      const snaps = [
        snap(0, { trust: false }),
        snap(1, { trust: true }),
      ];
      const events = diffConfigDrift(snaps, PROJECT);
      const ev = events.find((e) => e.kind === 'trust-flip');
      expect(ev).toBeDefined();
      expect(ev!.severity).toBe('warning');
    });
  });

  describe('enable-all-flip', () => {
    it('emits warning when enableAll flips false -> true', () => {
      const snaps = [
        snap(0, { enableAll: false }),
        snap(30, { enableAll: true }),
      ];
      const events = diffConfigDrift(snaps, PROJECT);
      const ev = events.find((e) => e.kind === 'enable-all-flip');
      expect(ev).toBeDefined();
      expect(ev!.from).toBe(false);
      expect(ev!.to).toBe(true);
      expect(ev!.severity).toBe('warning');
    });

    it('emits info when enableAll flips true -> false (less risky)', () => {
      const snaps = [
        snap(0, { enableAll: true }),
        snap(1, { enableAll: false }),
      ];
      const events = diffConfigDrift(snaps, PROJECT);
      const ev = events.find((e) => e.kind === 'enable-all-flip');
      expect(ev).toBeDefined();
      expect(ev!.severity).toBe('info');
    });
  });

  describe('repo .mcp.json server appearing/vanishing', () => {
    it('emits repo-server-appeared when a new server enters mcpServers', () => {
      const snaps = [
        snap(0, { mcpServers: ['postgres', 'jira'] }),
        snap(6, { mcpServers: ['postgres', 'jira', 'sentry'] }),
      ];
      const events = diffConfigDrift(snaps, PROJECT);
      const ev = events.find((e) => e.kind === 'repo-server-appeared');
      expect(ev).toBeDefined();
      expect(ev!.server).toBe('sentry');
      expect(ev!.severity).toBe('info');
    });

    it('emits repo-server-vanished when a server is removed from mcpServers', () => {
      const snaps = [
        snap(0, { mcpServers: ['postgres', 'jira', 'sentry'] }),
        snap(1, { mcpServers: ['postgres', 'jira'] }),
      ];
      const events = diffConfigDrift(snaps, PROJECT);
      const ev = events.find((e) => e.kind === 'repo-server-vanished');
      expect(ev).toBeDefined();
      expect(ev!.server).toBe('sentry');
      expect(ev!.severity).toBe('info');
    });
  });

  describe('global-churn', () => {
    it('emits global-churn when global mcpServers changes, separate from project events', () => {
      const snaps: ConfigSnapshot[] = [
        { timestamp: T0,       filename: 'a', projectConfig: undefined, globalMcpServerKeys: ['github'] },
        { timestamp: T0 + H,  filename: 'b', projectConfig: undefined, globalMcpServerKeys: ['github', 'playwright'] },
      ];
      const events = diffConfigDrift(snaps); // no projectPath
      expect(events).toHaveLength(1);
      expect(events[0].kind).toBe('global-churn');
      expect(events[0].severity).toBe('info');
      expect(events[0].project).toBeUndefined();
    });

    it('does NOT emit global-churn when global servers are unchanged', () => {
      const snaps: ConfigSnapshot[] = [
        { timestamp: T0,       filename: 'a', projectConfig: undefined, globalMcpServerKeys: ['github'] },
        { timestamp: T0 + H,  filename: 'b', projectConfig: undefined, globalMcpServerKeys: ['github'] },
      ];
      const events = diffConfigDrift(snaps);
      expect(events.filter((e) => e.kind === 'global-churn')).toHaveLength(0);
    });

    it('emits global-churn alongside project events when projectPath is provided', () => {
      const snaps = [
        snap(0, { trust: true,  globalMcp: ['github'] }),
        snap(1, { trust: false, globalMcp: ['github', 'playwright'] }),
      ];
      const events = diffConfigDrift(snaps, PROJECT);
      expect(events.some((e) => e.kind === 'trust-flip')).toBe(true);
      expect(events.some((e) => e.kind === 'global-churn')).toBe(true);
    });
  });

  describe('full prototype story (5-snapshot sequence)', () => {
    // Mirrors the make-fixtures.mjs drift story exactly
    const snaps = [
      snap(0,  { trust: true,  enableAll: false, enabled: ['postgres', 'jira'],          disabled: [],           mcpServers: ['postgres', 'jira'],          globalMcp: ['github', 'playwright'] }),
      snap(6,  { trust: true,  enableAll: false, enabled: ['postgres', 'jira', 'sentry'], disabled: [],           mcpServers: ['postgres', 'jira', 'sentry'], globalMcp: ['github', 'playwright'] }),
      snap(20, { trust: true,  enableAll: false, enabled: ['jira', 'sentry'],             disabled: ['postgres'], mcpServers: ['postgres', 'jira', 'sentry'], globalMcp: ['github', 'playwright'] }),
      snap(26, { trust: false, enableAll: false, enabled: ['jira', 'sentry'],             disabled: ['postgres'], mcpServers: ['postgres', 'jira', 'sentry'], globalMcp: ['github', 'playwright'] }),
      snap(30, { trust: false, enableAll: true,  enabled: ['jira', 'sentry'],             disabled: ['postgres'], mcpServers: ['postgres', 'jira', 'sentry'], globalMcp: ['github', 'playwright'] }),
    ];

    it('emits 4 project-scoped events total', () => {
      const events = diffConfigDrift(snaps, PROJECT).filter((e) => e.kind !== 'global-churn');
      expect(events).toHaveLength(4);
    });

    it('correctly identifies all event kinds', () => {
      const events = diffConfigDrift(snaps, PROJECT).filter((e) => e.kind !== 'global-churn');
      const kinds = events.map((e) => e.kind).sort();
      expect(kinds).toEqual(['enable-all-flip', 'repo-server-appeared', 'server-disabled', 'trust-flip'].sort());
    });

    it('all events are project-scoped', () => {
      const events = diffConfigDrift(snaps, PROJECT).filter((e) => e.kind !== 'global-churn');
      expect(events.every((e) => e.project === PROJECT)).toBe(true);
    });

    it('warning events are postgres-disabled, trust-flip, enable-all-flip', () => {
      const warns: DriftEvent[] = diffConfigDrift(snaps, PROJECT)
        .filter((e) => e.kind !== 'global-churn' && e.severity === 'warning');
      expect(warns).toHaveLength(3);
    });
  });
});

describe('parseBackupsDir', () => {
  it('skips backup snapshots above the configured byte cap', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'parse-backups-'));
    try {
      const smallTs = T0;
      const largeTs = T0 + H;
      await writeFile(
        join(dir, `.claude.json.backup.${smallTs}`),
        JSON.stringify({
          mcpServers: { github: {} },
          projects: { [PROJECT]: { hasTrustDialogAccepted: true } },
        }),
        'utf8'
      );
      await writeFile(
        join(dir, `.claude.json.backup.${largeTs}`),
        `${JSON.stringify({ mcpServers: { sentry: {} }, projects: {} })}${' '.repeat(2_048)}`,
        'utf8'
      );

      const snapshots = parseBackupsDir(dir, PROJECT, { maxFileBytes: 1_024 });

      expect(snapshots).toEqual([
        {
          timestamp: smallTs,
          filename: `.claude.json.backup.${smallTs}`,
          projectConfig: { hasTrustDialogAccepted: true },
          globalMcpServerKeys: ['github'],
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Directory boundary (#3378)
// ---------------------------------------------------------------------------

describe('parseBackupsDir — the backups directory is the boundary (#3378)', () => {
  it('refuses a symlinked backup pointing outside the directory', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'backups-outside-'));
    const dir = await mkdtemp(join(tmpdir(), 'backups-boundary-'));
    try {
      const target = join(outside, 'stolen.json');
      await writeFile(target, JSON.stringify({ mcpServers: { stolen: {} } }));
      symlinkSync(target, join(dir, '.claude.json.backup.1717200000000'));
      // A real sibling proves the parser works on this fixture otherwise.
      await writeFile(
        join(dir, '.claude.json.backup.1717200001000'),
        JSON.stringify({ mcpServers: { real: {} } })
      );

      const snapshots = parseBackupsDir(dir);
      expect(snapshots.map((s) => s.globalMcpServerKeys)).toEqual([['real']]);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
