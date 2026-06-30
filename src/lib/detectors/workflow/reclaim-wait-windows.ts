import type { Detector, Recommendation, RecObservation, RecFix } from '../types';
import type { WaitClass } from '../../parse-timeline';
import { collectSessionStalls, type Stall } from '../reliability/passive-wait-stall';

/**
 * `workflow.reclaim-wait-windows` (#1880, part of #867).
 *
 * The ACTUATION that follows the `reliability.passive-wait-stall` detector
 * (#1873). Passive-wait *measures* the dead-air; this detector is the engine-side
 * **policy author** for reclaiming it: from the same stall signature it learns
 * which classes of external wait recur (CI, deploy, push, remote-queue, watcher)
 * and emits a **wait-class ruleset** — "a turn ending on a wait of class C is a
 * reclaim opportunity; suggest safe, non-interfering backlog work meanwhile." A
 * live Stop-hook (the `meta` enforcer half of #1880, deferred to a sibling child
 * and mirrored to shpwrck/claude) consumes this ruleset to surface exactly one
 * suggestion at a matching turn-end. v1 is **suggest-only** — the engine programs
 * the policy; it never acts.
 *
 * The wait CLASS is what makes a candidate's non-interference checkable, because
 * the class implies the waited-on task's footprint. The ruleset's action carries
 * the filter the enforcer must apply, so the safety contract is authored here
 * once rather than re-derived live:
 *   - branch / worktree / HEAD — filler runs in its OWN worktree, never the tree
 *     the waited-on task owns (shared-checkout discipline);
 *   - files — disjoint from the waited-on change;
 *   - external target — never the same deploy target, container, preview port, or
 *     remote queue in use;
 *   - resume action — nothing may race the wait's resume (e.g. a "merge PR #X");
 *   - budget — must pass the 5h/weekly capacity gate; if tight, suggest nothing.
 *
 * Reuse, not re-derivation: the stall collector is imported from the #1873
 * detector so the two share ONE definition of "passive-wait turn-end that forced
 * a human turn" and can never drift. The wait class itself is set at parse time
 * (`entries[].waitClass`), so this detector fires identically on the slim
 * bulk/server dataset and on client-parsed timelines.
 */

const MIN_STALLS = 3; // noise floor — same as #1873; never fire on one or two.
const HIGH_CONFIDENCE_GAP_MS = 5 * 60 * 1000; // the "likely genuine stall" floor (#1873).
const MAX_EVIDENCE = 6;

/** Stable display order for the ruleset rows (most footprint-specific first). */
const CLASS_ORDER: readonly WaitClass[] = [
  'ci',
  'deploy',
  'push',
  'remote-queue',
  'watcher',
  'generic',
];

const CLASS_LABEL: Record<WaitClass, string> = {
  ci: 'CI / PR checks',
  deploy: 'deploy / rollout',
  push: 'push / merge',
  'remote-queue': 'remote queue / worker',
  watcher: 'watcher / monitor',
  generic: 'generic wait',
};

function fmtGap(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0s';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function median(valuesAsc: number[]): number {
  if (valuesAsc.length === 0) return 0;
  const mid = Math.floor(valuesAsc.length / 2);
  return valuesAsc.length % 2
    ? valuesAsc[mid]
    : (valuesAsc[mid - 1] + valuesAsc[mid]) / 2;
}

interface ClassRule {
  waitClass: WaitClass;
  count: number;
  medianGapMs: number;
  totalGapMs: number;
}

/** Roll the flat stall list up into one rule per observed wait class. */
function buildRuleset(stalls: Stall[]): ClassRule[] {
  const byClass = new Map<WaitClass, number[]>();
  for (const s of stalls) {
    const arr = byClass.get(s.waitClass) ?? [];
    arr.push(s.silenceGapMs);
    byClass.set(s.waitClass, arr);
  }
  const rules: ClassRule[] = [];
  for (const cls of CLASS_ORDER) {
    const gaps = byClass.get(cls);
    if (!gaps || gaps.length === 0) continue;
    gaps.sort((a, b) => a - b);
    rules.push({
      waitClass: cls,
      count: gaps.length,
      medianGapMs: median(gaps),
      totalGapMs: gaps.reduce((sum, g) => sum + g, 0),
    });
  }
  // Rank by reclaimable time so the highest-value class leads the ruleset.
  return rules.sort((a, b) => b.totalGapMs - a.totalGapMs);
}

const NON_INTERFERENCE_FILTER = [
  'separate worktree (never the waited-on HEAD/branch)',
  'disjoint files',
  'distinct deploy target / container / preview port / remote queue',
  'must not race the wait’s resume action (e.g. a pending merge)',
  'must pass the 5h/weekly capacity gate — if tight, suggest nothing',
].join('; ');

function buildFix(): RecFix {
  const snippet = `## Reclaim wait windows (suggest-only)

When a turn would END on a pending external wait (CI, deploy, push, remote queue,
a watcher) with no harness-backed background mechanism, don't sit idle. Instead,
either background the wait so the session self-resumes (run_in_background / Monitor
/ ScheduleWakeup), OR suggest one piece of backlog work that is provably
non-interfering with the waited-on task and let the user greenlight it. A candidate
qualifies ONLY if ALL hold:
- it runs in its own git worktree — never the branch/HEAD the waited-on task owns;
- it touches files disjoint from the waited-on change;
- it uses no shared external target (same deploy target, container, preview port,
  or remote queue) as the wait;
- it cannot race the wait's resume action (e.g. never start work that would
  collide with a pending "merge PR #X");
- it fits the remaining 5h/weekly capacity — if the budget is tight, suggest
  nothing and idle instead.
Suggest only; never auto-execute. The human authorizes the filler.`;
  return {
    target: 'CLAUDE.md',
    label: 'Add wait-reclaim guidance',
    note: 'Merge into your CLAUDE.md so wait turn-ends propose safe parallel work instead of stalling.',
    snippet,
    // Names harness-specific mechanisms (run_in_background / Monitor / worktree),
    // so it is an example to adapt, not a copy-paste-safe config fragment.
    fixKind: 'illustrative',
  };
}

export const detector: Detector = {
  id: 'workflow.reclaim-wait-windows',
  category: 'workflow',
  dataDeps: ['timelines'],
  dependsOn: ['reliability.passive-wait-stall'],
  rule(input): Recommendation | null {
    const timelines = input.timelines;
    if (!timelines || timelines.length === 0) return null;

    const stalls: Stall[] = [];
    for (const tl of timelines) {
      if (!tl.entries || tl.entries.length === 0) continue;
      stalls.push(...collectSessionStalls(tl));
    }
    if (stalls.length < MIN_STALLS) return null;

    const ruleset = buildRuleset(stalls);
    const sessions = new Set(stalls.map((s) => s.sessionId)).size;
    const totalGapMin = Math.round(
      stalls.reduce((sum, s) => sum + s.silenceGapMs, 0) / 60000
    );
    const highConf = stalls.filter(
      (s) => s.silenceGapMs >= HIGH_CONFIDENCE_GAP_MS
    ).length;
    const severity = highConf > 0 ? 'warning' : 'info';

    // The ruleset as human-readable rows: one rule per recurring wait class.
    const evidence = ruleset
      .slice(0, MAX_EVIDENCE)
      .map(
        (r) =>
          `${CLASS_LABEL[r.waitClass]}: ${r.count} wait-end(s), median idle ${fmtGap(
            r.medianGapMs
          )} → reclaim with non-interfering backlog work`
      );

    // The ruleset as machine-auditable observations: one per class, each citing
    // the parse-timeline field an auditor recomputes from.
    const classObservations: RecObservation[] = ruleset.map((r) => ({
      claim: `${r.count} turn-end(s) waited on a ${CLASS_LABEL[r.waitClass]} (class '${r.waitClass}'), median idle ${fmtGap(r.medianGapMs)}`,
      source: 'parse-timeline',
      field: 'entries[].waitClass',
      value: r.count,
    }));

    const observations: RecObservation[] = [
      {
        claim: `${stalls.length} passive-wait turn-end(s) across ${sessions} session(s) forced a human re-engagement and are classifiable into ${ruleset.length} reclaimable wait class(es)`,
        source: 'parse-timeline',
        field: 'entries[].waitLanguage / entries[].backgrounded / entries[].waitClass',
        value: stalls.length,
      },
      ...classObservations,
    ];

    const leadClass = ruleset[0];
    const classSummary = ruleset
      .map((r) => `${CLASS_LABEL[r.waitClass]} (${r.count})`)
      .join(', ');

    return {
      id: 'workflow.reclaim-wait-windows',
      category: 'workflow',
      severity,
      claimClass: 'accounting',
      proofTier: 'accounting',
      title: 'Reclaim the wait: suggest safe parallel work when a turn stalls on a pending task',
      detail: `${stalls.length} assistant turn-end(s) across ${sessions} session(s) stalled on a pending external wait and forced a human to re-engage (${totalGapMin} idle minute(s) total; ${highConf} over 5 min). They fall into ${ruleset.length} recurring wait class(es): ${classSummary}. The biggest reclaimable bucket is ${CLASS_LABEL[leadClass.waitClass]} (${leadClass.count} turn-end(s)). Each is a window where the agent could safely advance other backlog work — different worktree, disjoint files, no shared deploy/queue — instead of going idle.`,
      action: `When a turn would end on one of these waits, suggest (suggest-only) one piece of backlog work that is provably non-interfering with the waited-on task: ${NON_INTERFERENCE_FILTER}. The user greenlights; nothing auto-executes. Background the wait itself (run_in_background / Monitor / ScheduleWakeup) so the session self-resumes.`,
      affected: stalls.length,
      estTimeReclaimedMin: totalGapMin,
      view: 'timeline',
      evidence,
      fix: buildFix(),
      provenance: {
        observations,
        inference:
          'Passive-wait turn-ends recur in stable classes (CI/deploy/push/remote-queue/watcher), and each class implies the waited-on task’s footprint — so the engine can emit a per-class ruleset that lets a live enforcer pick provably non-interfering, in-budget backlog work to suggest instead of stalling, reclaiming the idle window without disturbing the wait.',
      },
    };
  },
};
