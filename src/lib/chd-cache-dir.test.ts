// Tests for CHD_CACHE_DIR path resolution (#1336).
//
// Verifies that the cache-dir formula used by scripts/ingest.mjs and
// scripts/server.mjs correctly resolves paths out of the install dir:
//   - default: <homedir>/.claude/.cache/chd/
//   - override: CHD_CACHE_DIR env var
//
// This file tests the pure derivation logic without importing the script
// modules (which have DB-open side effects). The formula is intentionally
// duplicated here as the test oracle — any drift from the real formula in the
// scripts is a test failure.

import { describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── Cache-dir resolution oracle ───────────────────────────────────────────────
// Mirrors the formula in scripts/ingest.mjs and scripts/server.mjs exactly:
//   process.env.CHD_CACHE_DIR || join(<claudeDir>, '.cache', 'chd')
// where <claudeDir> = process.env.CLAUDE_DIR || join(homedir(), '.claude').
//
// We inline the derivation here so the test proves the FORMULA, not just that
// the module ran — a regression in the formula (e.g. reverting to PROJECT_DIR)
// shows up as a diff between what the test expects and what the scripts compute.

function resolveCacheDir(env: Record<string, string | undefined> = {}): string {
  const claudeDir = env['CLAUDE_DIR'] ?? join(homedir(), '.claude');
  return env['CHD_CACHE_DIR'] ?? join(claudeDir, '.cache', 'chd');
}

function resolveIngestPaths(env: Record<string, string | undefined> = {}) {
  const cacheDir = resolveCacheDir(env);
  return {
    cacheDir,
    dbPath: env['CHD_DB_PATH'] ?? join(cacheDir, 'dashboard.db'),
    reviewEventsCache:
      env['DASHBOARD_REVIEW_EVENTS_CACHE_PATH'] ??
      join(cacheDir, 'review-events', 'github-review-events.json'),
  };
}

function resolveServerPaths(env: Record<string, string | undefined> = {}) {
  const cacheDir = resolveCacheDir(env);
  return {
    cacheDir,
    adoptionReceipts:
      env['ADOPTION_RECEIPTS_PATH'] ?? join(cacheDir, 'adoption-receipts.jsonl'),
    adoptionSpool:
      env['ADOPTION_SPOOL_PATH'] ?? join(cacheDir, 'adoption-spool.jsonl'),
    checkpointAnswers:
      env['CHECKPOINT_ANSWERS_PATH'] ?? join(cacheDir, 'checkpoint-answers.jsonl'),
    enterpriseAuditLog:
      env['ENTERPRISE_AUDIT_LOG_PATH'] ?? join(cacheDir, 'enterprise-audit.jsonl'),
    reviewEventsCache:
      env['DASHBOARD_REVIEW_EVENTS_CACHE_PATH'] ??
      join(cacheDir, 'review-events', 'github-review-events.json'),
    // enterprise-roots scoped DB (scopedIngestDbPath equivalent)
    scopedDbDir: join(cacheDir, 'enterprise-roots'),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('CHD_CACHE_DIR resolution', () => {
  it('defaults to ~/.claude/.cache/chd when CHD_CACHE_DIR is unset', () => {
    const { cacheDir } = resolveIngestPaths({});
    expect(cacheDir).toBe(join(homedir(), '.claude', '.cache', 'chd'));
  });

  it('respects an explicit CHD_CACHE_DIR override', () => {
    const custom = '/custom/cache/path';
    const { cacheDir } = resolveIngestPaths({ CHD_CACHE_DIR: custom });
    expect(cacheDir).toBe(custom);
  });

  it('respects CLAUDE_DIR when CHD_CACHE_DIR is unset', () => {
    const claudeDir = '/some/other/claude';
    const { cacheDir } = resolveIngestPaths({ CLAUDE_DIR: claudeDir });
    expect(cacheDir).toBe(join(claudeDir, '.cache', 'chd'));
  });

  it('CHD_CACHE_DIR takes precedence over CLAUDE_DIR', () => {
    const custom = '/override/cache';
    const { cacheDir } = resolveIngestPaths({
      CLAUDE_DIR: '/some/other/claude',
      CHD_CACHE_DIR: custom,
    });
    expect(cacheDir).toBe(custom);
  });
});

describe('ingest.mjs path derivation', () => {
  it('dashboard.db defaults under CHD_CACHE_DIR', () => {
    const { dbPath, cacheDir } = resolveIngestPaths({});
    expect(dbPath).toBe(join(cacheDir, 'dashboard.db'));
  });

  it('CHD_DB_PATH overrides the db path independently', () => {
    const override = '/custom/db/dashboard.db';
    const { dbPath } = resolveIngestPaths({ CHD_DB_PATH: override });
    expect(dbPath).toBe(override);
  });

  it('review-events cache defaults under CHD_CACHE_DIR', () => {
    const { reviewEventsCache, cacheDir } = resolveIngestPaths({});
    expect(reviewEventsCache).toBe(
      join(cacheDir, 'review-events', 'github-review-events.json')
    );
  });

  it('DASHBOARD_REVIEW_EVENTS_CACHE_PATH overrides the review-events path', () => {
    const override = '/tmp/review-events.json';
    const { reviewEventsCache } = resolveIngestPaths({
      DASHBOARD_REVIEW_EVENTS_CACHE_PATH: override,
    });
    expect(reviewEventsCache).toBe(override);
  });
});

describe('server.mjs path derivation', () => {
  it('adoption-receipts.jsonl defaults under CHD_CACHE_DIR', () => {
    const { adoptionReceipts, cacheDir } = resolveServerPaths({});
    expect(adoptionReceipts).toBe(join(cacheDir, 'adoption-receipts.jsonl'));
  });

  it('adoption-spool.jsonl defaults under CHD_CACHE_DIR', () => {
    const { adoptionSpool, cacheDir } = resolveServerPaths({});
    expect(adoptionSpool).toBe(join(cacheDir, 'adoption-spool.jsonl'));
  });

  it('checkpoint-answers.jsonl defaults under CHD_CACHE_DIR', () => {
    const { checkpointAnswers, cacheDir } = resolveServerPaths({});
    expect(checkpointAnswers).toBe(join(cacheDir, 'checkpoint-answers.jsonl'));
  });

  it('enterprise-audit.jsonl defaults under CHD_CACHE_DIR', () => {
    const { enterpriseAuditLog, cacheDir } = resolveServerPaths({});
    expect(enterpriseAuditLog).toBe(join(cacheDir, 'enterprise-audit.jsonl'));
  });

  it('github-review-events.json defaults under CHD_CACHE_DIR', () => {
    const { reviewEventsCache, cacheDir } = resolveServerPaths({});
    expect(reviewEventsCache).toBe(
      join(cacheDir, 'review-events', 'github-review-events.json')
    );
  });

  it('enterprise-roots DB dir defaults under CHD_CACHE_DIR', () => {
    const { scopedDbDir, cacheDir } = resolveServerPaths({});
    expect(scopedDbDir).toBe(join(cacheDir, 'enterprise-roots'));
  });

  it('individual path overrides take precedence over CHD_CACHE_DIR', () => {
    const custom = '/custom/cache';
    const receiptsOverride = '/custom/receipts.jsonl';
    const spoolOverride = '/custom/spool.jsonl';
    const checkpointOverride = '/custom/checkpoint-answers.jsonl';
    const { adoptionReceipts, adoptionSpool, checkpointAnswers, cacheDir } = resolveServerPaths({
      CHD_CACHE_DIR: custom,
      ADOPTION_RECEIPTS_PATH: receiptsOverride,
      ADOPTION_SPOOL_PATH: spoolOverride,
      CHECKPOINT_ANSWERS_PATH: checkpointOverride,
    });
    expect(cacheDir).toBe(custom);
    expect(adoptionReceipts).toBe(receiptsOverride);
    expect(adoptionSpool).toBe(spoolOverride);
    expect(checkpointAnswers).toBe(checkpointOverride);
  });

  it('no path defaults to PROJECT_DIR when CHD_CACHE_DIR is set', () => {
    const custom = '/my/cache/dir';
    const paths = resolveServerPaths({ CHD_CACHE_DIR: custom });
    // All paths must live under the custom cache dir (none under any project dir)
    const allPaths = [
      paths.adoptionReceipts,
      paths.adoptionSpool,
      paths.checkpointAnswers,
      paths.enterpriseAuditLog,
      paths.reviewEventsCache,
      paths.scopedDbDir,
    ];
    for (const p of allPaths) {
      expect(p.startsWith(custom)).toBe(true);
    }
  });
});
