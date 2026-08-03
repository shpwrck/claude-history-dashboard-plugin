/**
 * safety/config-hygiene-rollup — project the config-hygiene families that have
 * NO existing detector into one summary Recommendation (#1164, epic #866;
 * wrapper slice of the #851 audit).
 *
 * `computeConfigHygiene()` (config-hygiene.ts) flags installed-but-unused
 * resources across five families: skill, subagent, command, mcpServer, plugin.
 * Three of those — skill / subagent / command — are already wrapped by the
 * `workflow.unused-installed-*` detectors. The remaining two — **mcpServer** and
 * **plugin** — had NO detector, so unused MCP servers and plugins never flowed
 * through `buildRecommendations()` and were invisible to
 * `/api/recommendations.json`, the digest, and the recs skill.
 *
 * This detector closes exactly that gap: a thresholded ROLLUP over the unused
 * mcpServer + plugin findings (one summary card, the per-resource findings as
 * evidence — not one card per finding). It is scoped to mcpServer + plugin
 * precisely so it CANNOT double-emit anything the `unused-installed-*` detectors
 * already cover (acceptance: no double-emission). The lower-level
 * `HygieneFinding` analysis is untouched and still backs the Config Hygiene view.
 *
 * Honesty: every finding carries a 30-day window. When the available data window
 * is shorter than 30 days `computeConfigHygiene` sets `hedge:
 * 'window-shorter-than-threshold'`; we demote the wording to "as of <date>,
 * provisional" and mark the provenance stale rather than asserting "unused" as
 * present-tense fact (#1102).
 */

import type { Detector, RecommendationInput } from '../types';
import type { HygieneFinding } from '../../config-hygiene';
import { computeConfigHygiene } from '../../config-hygiene';
import { buildConfigRemovalSnippetBlock } from '../../config-hygiene-actions';
import { unusedWindowWording } from '../workflow/unused-installed-window';

/** Families WITHOUT an existing detector — the only ones this rollup may emit,
 *  so it can never overlap workflow.unused-installed-{skills,subagents,commands}. */
const UNCOVERED_FAMILIES: ReadonlySet<HygieneFinding['resourceType']> = new Set([
  'mcpServer',
  'plugin',
]);

/** Stay quiet below this many unused uncovered resources. */
const MIN_UNUSED = 2;
/** At or above this many, the finding is a warning, else info. */
const WARN_UNUSED = 5;

function scopeLabel(scope: HygieneFinding['scope']): string {
  return scope.kind === 'global' ? 'global' : `project ${scope.project}`;
}

export const detector: Detector = {
  id: 'safety.config-hygiene-rollup',
  category: 'safety',
  dataDeps: ['liveConfig', 'attribution', 'sessions'],
  rule(input: RecommendationInput, now: number) {
    if (!input.liveConfig) return null;

    const sessions = input.sessions.map((s) => ({
      sessionId: s.sessionId,
      startTime: s.startTime,
      project: s.project,
    }));
    const unused = computeConfigHygiene({
      liveConfig: input.liveConfig,
      attribution: input.attribution ?? [],
      sessions,
      now,
    }).filter((f) => UNCOVERED_FAMILIES.has(f.resourceType) && f.windowCount === 0);

    if (unused.length < MIN_UNUSED) return null;

    const mcp = unused.filter((f) => f.resourceType === 'mcpServer');
    const plugins = unused.filter((f) => f.resourceType === 'plugin');
    const window = unusedWindowWording(unused, sessions, now);

    const parts: string[] = [];
    if (mcp.length) parts.push(`${mcp.length} MCP server(s)`);
    if (plugins.length) parts.push(`${plugins.length} plugin(s)`);

    const detail =
      `${unused.length} configured resource(s) — ${parts.join(', ')} — recorded no ` +
      `invocations ${window.detailWindow}. Unused MCP servers and plugins still load at ` +
      `startup, add to the tool list (and its token cost), and widen the config / ` +
      `attack surface.`;

    return {
      id: 'safety.config-hygiene-rollup',
      category: 'safety',
      severity: unused.length >= WARN_UNUSED ? 'warning' : 'info',
      title: `MCP servers / plugins unused ${window.titleWindow} — prune config`,
      detail,
      action:
        'Remove or disable the MCP servers and plugins you are not using — drop the ' +
        'server from ~/.claude.json (or its scope) and uninstall unused plugins. The ' +
        'Config Hygiene view has the per-resource breakdown.',
      affected: unused.length,
      evidence: unused
        .slice(0, 5)
        .map(
          (f) =>
            `${f.resourceType} ${f.resourceId} (${scopeLabel(f.scope)}): ${f.lifetimeCount} lifetime invocation(s)`
        ),
      fix: {
        target: 'command',
        fixKind: 'manual',
        label: 'Prune unused MCP/plugins',
        note: 'Copy and run after confirming each MCP server or plugin is no longer needed.',
        snippet: buildConfigRemovalSnippetBlock(unused),
      },
      provenance: {
        observations: [
          {
            claim:
              `${unused.length} configured mcpServer/plugin resource(s) had zero invocations ` +
              window.detailWindow,
            source: 'config-hygiene',
            field: 'computeConfigHygiene() -> HygieneFinding{resourceType in [mcpServer,plugin], windowCount: 0}',
            value: unused.length,
          },
        ],
        inference:
          'Installed-but-unused MCP servers and plugins are removable config debt: ' +
          'they cost startup time and tool-list tokens and widen the attack surface ' +
          'with no offsetting use. (Skills/subagents/commands are covered by the ' +
          'workflow.unused-installed-* detectors and excluded here to avoid double-count.)',
        ...(window.asOf ? { asOf: window.asOf } : {}),
        stale: window.hedged && window.asOf ? true : undefined,
      },
    };
  },
};
