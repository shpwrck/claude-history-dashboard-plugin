/**
 * Detector: maintenance.skill-hook-integrity
 *
 * A settings.json hook or a skill can point at a script/bundled resource that
 * was renamed or removed off disk. Nothing fails loudly: the hook silently
 * no-ops (or errors deep in a lifecycle event), and the skill's "see
 * `scripts/foo.py`" instruction dangles. This is the reference-integrity
 * member of the artifact-hygiene family (#2241, parent of memory- and
 * doc-hygiene): derived staleness with zero authoring burden, entirely from
 * local `~/.claude` data.
 *
 * Detectors are PURE and cannot stat the filesystem, so existence is evaluated
 * HOST-SIDE at ingest (`assembleLiveConfig` in `config-loader.ts`): each hook
 * command is annotated with `referencedPaths: {path, exists}[]` and each skill
 * with `danglingRefs: string[]`. This detector reads those pre-computed fields
 * and flags:
 *
 *   1. dangling-hook-script — a hook `command` referencing a path that did not
 *      exist at ingest (absolute / `~` / `$HOME` / a resolvable
 *      `$CLAUDE_PROJECT_DIR`; opaque `$VAR` tokens were skipped at ingest as
 *      unverifiable and never reach here).
 *   2. dangling-skill-ref  — a `SKILL.md` link/backtick reference to a bundled
 *      resource path that no longer resolves inside the skill dir.
 *
 * Both are structural breakage → `warning`. The finding is an ingest-time
 * snapshot (the path could be recreated before a reader acts), so the wording is
 * point-in-time ("as of the last ingest") and `provenance.asOf` carries the
 * ingest date rather than asserting a bare present-tense "this hook is broken".
 * Recommend-only: it proposes fixing the path or removing the dead entry and
 * never edits settings or a skill.
 *
 * Reads `input.liveConfig`. Null/absent `liveConfig`, or a bundle predating the
 * #2500 fields, yields ZERO findings (filter-nothing degrade, matching the
 * existing `liveConfig` contract) — so the SPA/upload dataset stays dark.
 *
 * Issue: #2500 (epic #2241 — artifact hygiene)
 */

import type {
  Detector,
  RecommendationInput,
  Recommendation,
  RecObservation,
} from '../types';
import type { LiveConfig, LiveSettings, LiveResource } from '../../../types';

/** The two deterministic reference-integrity signals this detector emits. */
export type IntegritySignal = 'dangling-hook-script' | 'dangling-skill-ref';

/** One flagged dangling reference: where it lives, what it points at, what to do. */
export interface IntegrityItem {
  signal: IntegritySignal;
  /** Provenance key path — the exact settings location or `SKILL.md`. */
  keyPath: string;
  /** The referenced path token that no longer exists. */
  ref: string;
  /** Recommend-only suggested action (never an auto-edit). */
  action: string;
}

const SIGNAL_LABEL: Record<IntegritySignal, string> = {
  'dangling-hook-script': 'hook references a missing script',
  'dangling-skill-ref': 'skill references a removed bundled path',
};

/** Scan one merged settings object's hooks for dangling referenced paths. */
function scanSettingsHooks(
  settings: LiveSettings | undefined,
  keyPrefix: string,
  scopeLabel: string
): IntegrityItem[] {
  const items: IntegrityItem[] = [];
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== 'object') return items;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, g) => {
      const inner = group?.hooks;
      if (!Array.isArray(inner)) return;
      inner.forEach((h, i) => {
        const refs = h?.referencedPaths;
        if (!Array.isArray(refs)) return;
        for (const rp of refs) {
          if (rp?.exists !== false) continue;
          items.push({
            signal: 'dangling-hook-script',
            keyPath: `${keyPrefix}hooks.${event}[${g}].hooks[${i}].command`,
            ref: rp.path,
            action: `The ${scopeLabel} ${event} hook references "${rp.path}", which was not on disk at ingest — fix the path or remove the dead hook entry.`,
          });
        }
      });
    });
  }
  return items;
}

/** Scan the installed skills for `SKILL.md` references that no longer resolve. */
function scanSkills(skills: LiveResource[] | undefined): IntegrityItem[] {
  const items: IntegrityItem[] = [];
  if (!Array.isArray(skills)) return items;
  for (const skill of skills) {
    const refs = skill?.danglingRefs;
    if (!Array.isArray(refs) || refs.length === 0) continue;
    for (const ref of refs) {
      items.push({
        signal: 'dangling-skill-ref',
        keyPath: `skills["${skill.id}"]/SKILL.md`,
        ref,
        action: `Skill "${skill.id}" SKILL.md references "${ref}", a bundled path not on disk at ingest — update the reference or restore the file.`,
      });
    }
  }
  return items;
}

function scanConfig(config: LiveConfig): IntegrityItem[] {
  const items = [
    ...scanSettingsHooks(config.settings, '', 'global'),
    ...scanSkills(config.skills),
  ];
  const projectSettings = config.projectSettings;
  if (projectSettings && typeof projectSettings === 'object') {
    for (const [root, ps] of Object.entries(projectSettings)) {
      items.push(
        ...scanSettingsHooks(ps, `projectSettings["${root}"].`, `project (${root})`)
      );
    }
  }
  return items;
}

export const detector: Detector = {
  id: 'maintenance.skill-hook-integrity',
  category: 'maintenance',
  dataDeps: ['liveConfig'],
  rule(input: RecommendationInput, now: number): Recommendation | null {
    const config = input.liveConfig;
    // Null/absent bundle (or one predating #2500) → filter nothing.
    if (!config) return null;

    const items = scanConfig(config);
    if (items.length === 0) return null;

    const hookCount = items.filter((it) => it.signal === 'dangling-hook-script').length;
    const skillCount = items.length - hookCount;
    const breakdown = [
      hookCount ? `${hookCount} ${SIGNAL_LABEL['dangling-hook-script']}` : '',
      skillCount ? `${skillCount} ${SIGNAL_LABEL['dangling-skill-ref']}` : '',
    ]
      .filter(Boolean)
      .join(', ');

    const evidence = items
      .slice(0, 8)
      .map((it) => `${it.keyPath} -> ${it.ref} — ${SIGNAL_LABEL[it.signal]}`);

    // Point-in-time honesty: the existence bit is an ingest-time snapshot, so we
    // date the claim rather than asserting a bare present-tense "is broken".
    const asOf = new Date(now).toISOString().slice(0, 10);

    const observations: RecObservation[] = [
      {
        claim: `${items.length} dangling reference(s) checked host-side at ingest: ${breakdown}`,
        source: 'config-loader (assembleLiveConfig)',
        field:
          'liveConfig.settings.hooks[].hooks[].referencedPaths[].exists / liveConfig.skills[].danglingRefs',
        value: items.length,
      },
    ];

    const n = items.length;
    return {
      id: 'maintenance.skill-hook-integrity',
      category: 'maintenance',
      severity: 'warning', // dead pointers are structural breakage
      title: `Dangling skill/hook references: ${n} broken pointer${n === 1 ? '' : 's'}`,
      detail:
        `As of the last ingest (${asOf}), ${n} skill/hook reference${n === 1 ? '' : 's'} pointed at a path not on disk — ${breakdown}. ` +
        `A hook whose script is gone fails silently at runtime, and a skill that points at a removed bundled file misleads whoever follows it.`,
      action:
        `Review the flagged references (recommend-only — nothing is edited for you): fix the path or remove the dead hook entry, ` +
        `and update or restore the missing bundled skill resource.`,
      affected: n,
      // No honest dollar unit — score on minutes to review each flagged pointer.
      estTimeReclaimedMin: n,
      evidence,
      provenance: {
        observations,
        inference:
          `Each reference's existence was evaluated host-side at ingest (detectors are pure and cannot stat), so all ${n} are ` +
          `reproducible from the cited fields — a maintenance pass to keep hooks and skills pointing at live paths.`,
        asOf,
      },
    };
  },
};
