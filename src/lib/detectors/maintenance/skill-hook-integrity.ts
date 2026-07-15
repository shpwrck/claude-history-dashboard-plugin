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
 * Detectors are PURE and cannot stat the filesystem, so path state is evaluated
 * HOST-SIDE at ingest (`assembleLiveConfig` in `config-loader.ts`): each hook
 * command is annotated with timestamped `referencedPaths: {path, state,
 * checkedAt}[]` and each skill
 * with `danglingRefs: string[]`. This detector reads those pre-computed fields
 * and flags:
 *
 *   1. dangling-hook-script — a hook `command` referencing a path recorded
 *      `missing` by the conservative ingest probe (absolute / `~` / `$HOME` / a resolvable
 *      `$CLAUDE_PROJECT_DIR`; opaque `$VAR` tokens were skipped at ingest as
 *      unverifiable and never reach here).
 *   2. dangling-skill-ref  — a `SKILL.md` link/backtick reference to a bundled
 *      resource path that no longer resolves inside the skill dir.
 *
 * Both are structural breakage → `warning`. Hook findings are timestamped
 * snapshots (the path could be recreated before a reader acts), so wording and
 * `provenance.asOf` derive from the actual path check rather than asserting a
 * bare present-tense "this hook is broken". `unverifiable` and legacy Boolean
 * records stay silent.
 * Recommend-only: it proposes fixing the path or removing the dead entry and
 * never edits settings or a skill.
 *
 * Reads `input.liveConfig`. Null/absent `liveConfig`, or a bundle predating the
 * #2500 fields, yields ZERO findings (filter-nothing degrade, matching the
 * existing `liveConfig` contract) — so the SPA/upload dataset stays dark.
 *
 * Issues: #2500, #2553 (epic #2241 — artifact hygiene)
 */

import type {
  Detector,
  RecommendationInput,
  Recommendation,
  RecObservation,
} from '../types';
import type { LiveConfig, LiveSettings, LiveResource } from '../../../types';
import { STALE_WEEKS } from '../shared';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOOK_EVIDENCE_FRESHNESS_MS = STALE_WEEKS * 7 * DAY_MS;

export interface SkillHookIntegrityCacheValidity {
  /** Exclusive lower clock bound for which the cached detector output is valid. */
  after: number | null;
  /** Inclusive upper clock bound for which the cached detector output is valid. */
  through: number | null;
}

/** The two deterministic reference-integrity signals this detector emits. */
export type IntegritySignal = 'dangling-hook-script' | 'dangling-skill-ref';

/** One flagged dangling reference: where it lives, what it points at, what to do. */
export interface IntegrityItem {
  signal: IntegritySignal;
  /** Provenance key path — the exact settings location or `SKILL.md`. */
  keyPath: string;
  /** The referenced path token that no longer exists. */
  ref: string;
  /** Exact parsed field supporting a hook-path claim. */
  observationField?: string;
  /** Canonical host-side probe instant for a hook-path claim. */
  checkedAt?: string;
}

const SIGNAL_LABEL: Record<IntegritySignal, string> = {
  'dangling-hook-script': 'hook references a missing script',
  'dangling-skill-ref': 'skill references a removed bundled path',
};

/** Scan one merged settings object's hooks for dangling referenced paths. */
function scanSettingsHooks(
  settings: LiveSettings | undefined,
  keyPrefix: string,
  observationPrefix: string
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
        refs.forEach((raw, r) => {
          const rp = raw as unknown;
          if (!rp || typeof rp !== 'object') return;
          const candidate = rp as Record<string, unknown>;
          if (
            candidate.state !== 'missing' ||
            typeof candidate.path !== 'string' ||
            candidate.path.length === 0 ||
            !isCanonicalIsoInstant(candidate.checkedAt)
          ) return;
          items.push({
            signal: 'dangling-hook-script',
            keyPath: `${keyPrefix}hooks.${event}[${g}].hooks[${i}].command`,
            ref: candidate.path,
            observationField:
              `liveConfig.${observationPrefix}hooks.${event}[${g}].hooks[${i}]` +
              `.referencedPaths[${r}].state`,
            checkedAt: candidate.checkedAt,
          });
        });
      });
    });
  }
  return items;
}

function isCanonicalIsoInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
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
      });
    }
  }
  return items;
}

function scanConfig(config: LiveConfig): IntegrityItem[] {
  const items = [
    ...scanSettingsHooks(config.settings, '', 'settings.'),
    ...scanSkills(config.skills),
  ];
  const projectSettings = config.projectSettings;
  if (projectSettings && typeof projectSettings === 'object') {
    for (const [root, ps] of Object.entries(projectSettings)) {
      items.push(
        ...scanSettingsHooks(
          ps,
          `projectSettings["${root}"].`,
          `projectSettings["${root}"].`
        )
      );
    }
  }
  return items;
}

function oldestHookCheck(items: readonly IntegrityItem[]): string | undefined {
  return items
    .map((item) => item.checkedAt)
    .filter((value): value is string => value !== undefined)
    .sort()[0];
}

/**
 * Return the exact transition instant so every recommendation cache can
 * invalidate when fresh hook evidence becomes stale (or the clock moves
 * backward and makes it fresh again). Unlike date-only historical aggregates,
 * hook evidence carries the actual probe instant, so keep its full precision.
 */
function hookEvidenceStaleAfter(items: readonly IntegrityItem[]): number | null {
  const checkedAt = oldestHookCheck(items);
  if (!checkedAt) return null;
  const checkedAtMs = Date.parse(checkedAt);
  const staleAfter = checkedAtMs + HOOK_EVIDENCE_FRESHNESS_MS;
  return Number.isFinite(staleAfter) ? staleAfter : null;
}

export function skillHookIntegrityCacheValidity(
  input: RecommendationInput,
  now: number
): SkillHookIntegrityCacheValidity {
  if (!input.liveConfig || !Number.isFinite(now)) {
    return { after: null, through: null };
  }
  const staleAfter = hookEvidenceStaleAfter(scanConfig(input.liveConfig));
  if (staleAfter === null) return { after: null, through: null };
  return now > staleAfter
    ? { after: staleAfter, through: null }
    : { after: null, through: staleAfter };
}

export function skillHookIntegrityCacheValidityContains(
  validity: SkillHookIntegrityCacheValidity,
  now: number
): boolean {
  if (!Number.isFinite(now)) return false;
  return (
    (validity.after === null || now > validity.after) &&
    (validity.through === null || now <= validity.through)
  );
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
      .map((it) =>
        `${it.keyPath} -> ${it.ref} — ${SIGNAL_LABEL[it.signal]}` +
        (it.checkedAt ? `; state=missing checkedAt=${it.checkedAt}` : '')
      );

    const oldestHookCheckAt = oldestHookCheck(items);
    const ingestAsOf = new Date(now).toISOString().slice(0, 10);
    // Skill refs retain the detector/ingest date. Hook claims use their actual
    // probe instant, conservatively choosing the oldest contributing check.
    const asOf = (oldestHookCheckAt ?? ingestAsOf).slice(0, 10);
    const staleAfter = hookEvidenceStaleAfter(items);
    const stale = staleAfter !== null && now > staleAfter;

    const observations: RecObservation[] = [
      {
        claim: `${items.length} dangling reference(s) checked host-side at ingest: ${breakdown}`,
        source: 'config-loader (assembleLiveConfig)',
        field:
          'liveConfig.settings.hooks[].hooks[].referencedPaths[].state/.checkedAt / ' +
          'liveConfig.projectSettings[*].hooks[].hooks[].referencedPaths[].state/.checkedAt / ' +
          'liveConfig.skills[].danglingRefs',
        value: items.length,
      },
      ...items
        .filter((it) => it.observationField && it.checkedAt)
        .slice(0, 8)
        .flatMap((it): RecObservation[] => [
          {
            claim: `${it.keyPath} recorded ${it.ref} with state=missing`,
            source: 'config-loader (assembleLiveConfig)',
            field: it.observationField,
            value: 'missing',
          },
          {
            claim: `${it.keyPath} path state was checked at ${it.checkedAt}`,
            source: 'config-loader (assembleLiveConfig)',
            field: it.observationField!.replace(/\.state$/, '.checkedAt'),
            value: it.checkedAt,
          },
        ]),
    ];

    const n = items.length;
    const actionParts = [
      hookCount
        ? 'Recheck the flagged hook paths; for paths still missing, fix the path or remove the dead hook entry.'
        : '',
      skillCount
        ? 'Update the flagged skill references or restore their missing bundled resources.'
        : '',
    ].filter(Boolean);
    const datedFinding = oldestHookCheckAt
      ? `${stale ? 'Stale hook evidence: recheck before acting. ' : ''}` +
        `At the recorded hook-path check beginning ${oldestHookCheckAt}, ${hookCount} hook ` +
        `reference${hookCount === 1 ? '' : 's'} had a recorded missing state.` +
        (skillCount
          ? ` At the last ingest (${ingestAsOf}), ${skillCount} skill reference${skillCount === 1 ? '' : 's'} had recorded dangling bundled paths.`
          : '')
      : `At the last ingest (${ingestAsOf}), ${skillCount} skill reference${skillCount === 1 ? '' : 's'} had recorded dangling bundled paths.`;
    return {
      id: 'maintenance.skill-hook-integrity',
      category: 'maintenance',
      severity: 'warning', // dead pointers are structural breakage
      claimClass: 'accounting',
      proofTier: 'accounting',
      title: `Recorded dangling skill/hook references: ${n} pointer${n === 1 ? '' : 's'}`,
      detail:
        `${datedFinding} Breakdown: ${breakdown}. ` +
        `A hook recorded missing may fail at runtime, and a skill that points at a removed bundled file can mislead whoever follows it.`,
      action:
        `Recommend-only — nothing is edited for you. ${actionParts.join(' ')}`,
      affected: n,
      // No honest dollar unit — score on minutes to review each flagged pointer.
      estTimeReclaimedMin: n,
      evidence,
      provenance: {
        observations,
        inference:
          `Each hook-path state was evaluated host-side at its cited check instant (detectors are pure and cannot stat), ` +
          `and each skill reference came from the cited ingest field, so all ${n} observations are reproducible without ` +
          `reconstructing missing state from ambiguous probes.`,
        asOf,
        ...(stale ? { stale: true } : {}),
      },
    };
  },
};
