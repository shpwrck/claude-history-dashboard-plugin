/**
 * owner-concentration - flags open task queues where one named owner carries
 * most of the team's active work. This is the first multi-user recommendation
 * built from existing Task/TodoWrite ownership fields plus session/project
 * attribution, with no new ingest source.
 *
 * Issue #942.
 */
import type { Detector, RecommendationInput } from '../types';
import { short } from '../shared';
import type { TaskRecord } from '../../parse-tasks';
import {
  createContributorAliasResolver,
  type ContributorAliasResolver,
} from '../../organization-identity';

export const MIN_OPEN_OWNED_TASKS = 6;
export const MIN_TOP_OWNER_TASKS = 4;
export const MIN_TOP_OWNER_SHARE = 0.6;
export const WARNING_TOP_OWNER_SHARE = 0.75;
export const WARNING_TOP_OWNER_TASKS = 8;

interface OwnerBucket {
  key: string;
  owner: string;
  tasks: TaskRecord[];
  projectCounts: Map<string, number>;
  rawOwners: Set<string>;
  identityId?: string;
  identityStatus: 'known' | 'unknown' | 'ambiguous';
}

function isOpenOwnedTask(task: TaskRecord): boolean {
  return (
    (task.status === 'pending' || task.status === 'in_progress') &&
    task.owner.trim().length > 0
  );
}

function pct(value: number): number {
  return Math.round(value * 100);
}

function asIsoDate(ms: number): string | undefined {
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString().slice(0, 10);
}

function taskLabel(task: TaskRecord): string {
  return task.subject.trim() || task.activeForm.trim() || task.id;
}

function projectLabel(
  task: TaskRecord,
  sessions: Map<string, RecommendationInput['sessions'][number]>
): string | null {
  const session = sessions.get(task.sessionId);
  const raw = session?.projectShort || session?.project;
  const label = raw?.trim();
  return label ? label : null;
}

function sortedProjectSummary(projectCounts: Map<string, number>): string[] {
  return [...projectCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 4)
    .map(([project, count]) => `${project} (${count})`);
}

function ownerIdentity(
  rawOwner: string,
  resolveAlias: ContributorAliasResolver
): {
  key: string;
  label: string;
  identityId?: string;
  identityStatus: OwnerBucket['identityStatus'];
} {
  const resolved = resolveAlias({
    kind: 'task-owner',
    value: rawOwner,
    source: '~/.claude/tasks owner',
  });
  if (resolved.status === 'known') {
    return {
      key: `contributor:${resolved.contributor.id}`,
      label: resolved.contributor.displayName || resolved.contributor.id,
      identityId: resolved.contributor.id,
      identityStatus: 'known',
    };
  }
  if (resolved.status === 'ambiguous') {
    return {
      key: `ambiguous:${rawOwner}`,
      label: rawOwner,
      identityStatus: 'ambiguous',
    };
  }
  return {
    key: `raw:${rawOwner}`,
    label: rawOwner,
    identityStatus: 'unknown',
  };
}

function ownerAliases(bucket: OwnerBucket): string {
  const aliases = [...bucket.rawOwners].sort();
  return aliases.length > 1 ? ` via aliases ${aliases.join(', ')}` : '';
}

export const detector: Detector = {
  id: 'workflow.owner-concentration',
  category: 'workflow',
  dataDeps: ['tasks', 'sessions', 'organizationIdentity'],

  rule(input: RecommendationInput, now: number) {
    const tasks = input.tasks ?? [];
    if (!tasks.length) return null;

    const sessions = new Map(input.sessions.map((session) => [session.sessionId, session]));
    const resolveOwnerAlias = createContributorAliasResolver(input.organizationIdentity);
    const owners = new Map<string, OwnerBucket>();
    let openOwnedCount = 0;
    let latestMtimeMs = 0;

    for (const task of tasks) {
      if (!isOpenOwnedTask(task)) continue;
      const rawOwner = task.owner.trim();
      const identity = ownerIdentity(rawOwner, resolveOwnerAlias);
      const bucket = owners.get(identity.key) ?? {
        key: identity.key,
        owner: identity.label,
        tasks: [],
        projectCounts: new Map<string, number>(),
        rawOwners: new Set<string>(),
        ...(identity.identityId ? { identityId: identity.identityId } : {}),
        identityStatus: identity.identityStatus,
      };
      bucket.tasks.push(task);
      bucket.rawOwners.add(rawOwner);
      const project = projectLabel(task, sessions);
      if (project) bucket.projectCounts.set(project, (bucket.projectCounts.get(project) ?? 0) + 1);
      owners.set(identity.key, bucket);
      openOwnedCount += 1;
      latestMtimeMs = Math.max(latestMtimeMs, task.mtimeMs);
    }

    if (openOwnedCount < MIN_OPEN_OWNED_TASKS) return null;
    if (owners.size < 2) return null;

    const rankedOwners = [...owners.values()].sort(
      (a, b) => b.tasks.length - a.tasks.length || a.owner.localeCompare(b.owner)
    );
    const top = rankedOwners[0];
    const share = top.tasks.length / openOwnedCount;
    if (top.tasks.length < MIN_TOP_OWNER_TASKS || share < MIN_TOP_OWNER_SHARE) {
      return null;
    }

    const topPct = pct(share);
    const projects = sortedProjectSummary(top.projectCounts);
    const projectDetail = projects.length
      ? ` Top projects for that owner: ${projects.join(', ')}.`
      : '';
    const evidence = [
      `${top.owner}: ${top.tasks.length}/${openOwnedCount} open owned task(s) (${topPct}%)${ownerAliases(top)}`,
      ...rankedOwners.slice(1, 4).map(
        (bucket) =>
          `${bucket.owner}: ${bucket.tasks.length}/${openOwnedCount} open owned task(s) (${pct(bucket.tasks.length / openOwnedCount)}%)${ownerAliases(bucket)}`
      ),
      ...top.tasks.slice(0, 4).map((task) => {
        const project = projectLabel(task, sessions);
        const suffix = project ? ` (${project})` : '';
        return `${short(task.sessionId)}: ${taskLabel(task)}${suffix}`;
      }),
    ];
    const asOf = asIsoDate(latestMtimeMs);
    const stale =
      asOf && Number.isFinite(now) && now > 0
        ? now - latestMtimeMs > 14 * 24 * 60 * 60 * 1000
        : undefined;

    return {
      id: 'workflow.owner-concentration',
      category: 'workflow',
      severity:
        share >= WARNING_TOP_OWNER_SHARE || top.tasks.length >= WARNING_TOP_OWNER_TASKS
          ? 'warning'
          : 'info',
      title: `Open task ownership is concentrated on ${top.owner}`,
      detail:
        `${top.owner} owns ${top.tasks.length} of ${openOwnedCount} open owned task(s) ` +
        `(${topPct}%) across ${owners.size} owner(s).${projectDetail}`,
      action:
        'Rebalance the queue before this becomes a review, support, or handoff bottleneck. ' +
        'Pair on the oldest/highest-risk tasks, or reassign clear follow-up work to another owner.',
      affected: top.tasks.length,
      view: 'tasks',
      evidence,
      provenance: {
        observations: [
          {
            claim: `${openOwnedCount} open tasks have a non-empty owner`,
            source: '~/.claude/tasks/',
            field: 'status / owner',
            value: openOwnedCount,
          },
          {
            claim: `${top.owner} owns ${top.tasks.length} of those open tasks`,
            source: '~/.claude/tasks/',
            field: 'owner / status',
            value: top.tasks.length,
          },
          {
            claim: `${owners.size} distinct owner group(s) have open tasks after explicit aliases are applied when present`,
            source: '~/.claude/tasks/ + organizationIdentity',
            field: 'owner / status / contributors[].aliases[kind=task-owner]',
            value: owners.size,
          },
          ...(top.identityStatus === 'known' && top.identityId
            ? [
                {
                  claim: `${top.owner} matched explicit contributor id ${top.identityId}`,
                  source: 'organizationIdentity',
                  field: 'contributors[].aliases[kind=task-owner]',
                  value: top.identityId,
                },
              ]
            : []),
        ],
        inference:
          `${top.owner}'s ${topPct}% share is above the ${pct(MIN_TOP_OWNER_SHARE)}% ` +
          'multi-owner concentration threshold, so the queue has a single-owner bottleneck risk.',
        ...(asOf ? { asOf } : {}),
        ...(stale !== undefined ? { stale } : {}),
      },
    };
  },
};
