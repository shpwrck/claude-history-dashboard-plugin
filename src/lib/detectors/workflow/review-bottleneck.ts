/**
 * workflow.review-bottleneck - flags stale PR review queues from explicit
 * review-request events. It stays dark unless a structured reviewEvents aggregate
 * is present, so it never infers reviewer latency from transcript/session data.
 *
 * Issue #1123.
 */
import type { Detector } from '../types';
import type { PullRequestReviewRequest } from '../../organization-review-events';
import {
  createContributorAliasResolver,
  normalizeContributorAlias,
  type ContributorAliasResolver,
} from '../../organization-identity';
import { isAsOfStale } from '../provenance';

export const STALE_REVIEW_HOURS = 48;
export const MIN_STALE_REVIEW_REQUESTS = 3;
export const MIN_STALE_REQUESTS_PER_REVIEWER = 2;
export const WARNING_STALE_REQUESTS_PER_REVIEWER = 4;
export const WARNING_OLDEST_REVIEW_HOURS = 120;

/**
 * Dataset freshness window (#3244, the generic #1102 stale-input rule): a
 * `reviewEvents` aggregate is a synchronized SNAPSHOT of an operational queue,
 * so once `generatedAt` is more than a week old the queue has almost certainly
 * moved — the claim is demoted to "As of <date>" historical wording (with
 * `provenance.stale`) instead of asserting a live bottleneck. A snapshot with
 * no readable `generatedAt` cannot be judged and keeps the existing wording.
 */
export const SNAPSHOT_STALE_AFTER_DAYS = 7;

const HOUR_MS = 60 * 60 * 1000;

interface AgedReviewRequest {
  request: PullRequestReviewRequest;
  ageMs: number;
}

interface ReviewerBucket {
  key: string;
  reviewer: string;
  requests: AgedReviewRequest[];
  rawReviewerIds: Set<string>;
  identityId?: string;
  identityStatus: 'known' | 'unknown' | 'ambiguous';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseTimeMs(value: string | undefined): number | null {
  if (!isNonEmptyString(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function asIsoDate(ms: number | null): string | undefined {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return undefined;
  return new Date(ms).toISOString().slice(0, 10);
}

function isOpenPendingRequest(request: PullRequestReviewRequest): boolean {
  if (!isNonEmptyString(request.reviewerId)) return false;
  if (request.state !== 'pending') return false;
  if (isNonEmptyString(request.respondedAt)) return false;
  return request.pullRequestState == null || request.pullRequestState === 'open';
}

function formatAge(ms: number): string {
  const hours = Math.max(1, Math.floor(ms / HOUR_MS));
  if (hours < 48) return `${hours}h`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days}d ${restHours}h` : `${days}d`;
}

function prLabel(request: PullRequestReviewRequest): string {
  const repo = request.repository.trim() || 'unknown-repo';
  const number = Number.isFinite(request.pullRequestNumber)
    ? `#${request.pullRequestNumber}`
    : '#?';
  const title = request.pullRequestTitle?.trim();
  return title ? `${repo}${number} ${title}` : `${repo}${number}`;
}

function reviewerIdentity(
  request: PullRequestReviewRequest,
  resolveAlias: ContributorAliasResolver
): {
  key: string;
  label: string;
  identityId?: string;
  identityStatus: ReviewerBucket['identityStatus'];
} {
  const rawReviewerId = request.reviewerId.trim();
  const resolved = resolveAlias({
    kind: 'username',
    value: rawReviewerId,
    source: 'reviewEvents reviewerId',
  });
  if (resolved.status === 'known') {
    return {
      key: `contributor:${resolved.contributor.id}`,
      label: resolved.contributor.displayName || resolved.contributor.id,
      identityId: resolved.contributor.id,
      identityStatus: 'known',
    };
  }
  const fallbackLabel = request.reviewerDisplayName?.trim() || rawReviewerId;
  if (resolved.status === 'ambiguous') {
    return {
      key: `ambiguous:${normalizeContributorAlias('username', rawReviewerId)}`,
      label: fallbackLabel,
      identityStatus: 'ambiguous',
    };
  }
  return {
    key: `raw:${normalizeContributorAlias('username', rawReviewerId)}`,
    label: fallbackLabel,
    identityStatus: 'unknown',
  };
}

function reviewerAliases(bucket: ReviewerBucket): string {
  const aliases = [...bucket.rawReviewerIds].sort();
  return aliases.length > 1 ? ` via aliases ${aliases.join(', ')}` : '';
}

export const detector: Detector = {
  id: 'workflow.review-bottleneck',
  category: 'workflow',
  dataDeps: ['reviewEvents', 'organizationIdentity'],

  rule(input, now) {
    if (!Number.isFinite(now) || now <= 0) return null;
    const dataset = input.reviewEvents;
    const requests = dataset?.reviewRequests ?? [];
    if (!requests.length) return null;

    const staleThresholdMs = STALE_REVIEW_HOURS * HOUR_MS;
    const pending: AgedReviewRequest[] = [];
    for (const request of requests) {
      if (!isOpenPendingRequest(request)) continue;
      const requestedAtMs = parseTimeMs(request.requestedAt);
      if (requestedAtMs == null || requestedAtMs > now) continue;
      pending.push({ request, ageMs: now - requestedAtMs });
    }
    if (!pending.length) return null;

    const stale = pending.filter((item) => item.ageMs >= staleThresholdMs);
    if (stale.length < MIN_STALE_REVIEW_REQUESTS) return null;

    const resolveReviewerAlias = createContributorAliasResolver(input.organizationIdentity);
    const reviewers = new Map<string, ReviewerBucket>();
    for (const item of stale) {
      const identity = reviewerIdentity(item.request, resolveReviewerAlias);
      const bucket = reviewers.get(identity.key) ?? {
        key: identity.key,
        reviewer: identity.label,
        requests: [],
        rawReviewerIds: new Set<string>(),
        ...(identity.identityId ? { identityId: identity.identityId } : {}),
        identityStatus: identity.identityStatus,
      };
      bucket.requests.push(item);
      bucket.rawReviewerIds.add(item.request.reviewerId.trim());
      reviewers.set(identity.key, bucket);
    }

    const rankedReviewers = [...reviewers.values()].sort((a, b) => {
      const maxA = Math.max(...a.requests.map((item) => item.ageMs));
      const maxB = Math.max(...b.requests.map((item) => item.ageMs));
      return b.requests.length - a.requests.length || maxB - maxA || a.reviewer.localeCompare(b.reviewer);
    });
    const top = rankedReviewers[0];
    if (!top || top.requests.length < MIN_STALE_REQUESTS_PER_REVIEWER) return null;

    top.requests.sort((a, b) => b.ageMs - a.ageMs || prLabel(a.request).localeCompare(prLabel(b.request)));
    const oldestAgeMs = top.requests[0]?.ageMs ?? 0;
    const severity =
      top.requests.length >= WARNING_STALE_REQUESTS_PER_REVIEWER ||
      oldestAgeMs >= WARNING_OLDEST_REVIEW_HOURS * HOUR_MS
        ? 'warning'
        : 'info';
    const source = dataset?.source?.trim() || 'reviewEvents';
    const generatedAtMs = parseTimeMs(dataset?.generatedAt);
    const asOf = asIsoDate(generatedAtMs);
    // #3244: an outdated snapshot must not read as the current queue.
    const snapshotStale = isAsOfStale(asOf, now, SNAPSHOT_STALE_AFTER_DAYS);
    const evidence = [
      `${top.reviewer}: ${top.requests.length}/${stale.length} stale pending review request(s), oldest ${formatAge(oldestAgeMs)}${reviewerAliases(top)}`,
      ...rankedReviewers.slice(1, 4).map((bucket) => {
        const oldest = Math.max(...bucket.requests.map((item) => item.ageMs));
        return `${bucket.reviewer}: ${bucket.requests.length}/${stale.length} stale pending review request(s), oldest ${formatAge(oldest)}${reviewerAliases(bucket)}`;
      }),
      ...top.requests.slice(0, 4).map((item) => {
        const url = item.request.pullRequestUrl?.trim();
        const suffix = url ? ` (${url})` : '';
        return `${prLabel(item.request)}: requested ${formatAge(item.ageMs)} ago${suffix}`;
      }),
    ];

    return {
      id: 'workflow.review-bottleneck',
      category: 'workflow',
      severity,
      title: snapshotStale
        ? `As of ${asOf}, the PR review queue was bottlenecked on ${top.reviewer}`
        : `PR review queue is bottlenecked on ${top.reviewer}`,
      detail: snapshotStale
        ? `As of ${asOf} (review-events snapshot date), ${top.reviewer} had ${top.requests.length} stale pending PR review request(s) older than ` +
          `${STALE_REVIEW_HOURS}h; ${stale.length} of ${pending.length} pending request(s) were stale. The snapshot is outdated, so the queue has likely moved since.`
        : `${top.reviewer} has ${top.requests.length} stale pending PR review request(s) older than ` +
          `${STALE_REVIEW_HOURS}h. Across the source, ${stale.length} of ${pending.length} pending request(s) are stale.`,
      action: snapshotStale
        ? `Re-sync the review-events dataset first — this snapshot is dated ${asOf}. If the pile-up persists, reassign or pair on the oldest reviews and add a reviewer rotation or escalation rule.`
        : 'Reassign or pair on the oldest reviews, then add a reviewer rotation or escalation rule before stale requests pile up behind one person.',
      affected: top.requests.length,
      evidence,
      provenance: {
        observations: [
          {
            claim: `${pending.length} PR review request(s) are pending`,
            source,
            field: 'reviewRequests[state=pending]',
            value: pending.length,
          },
          {
            claim: `${stale.length} pending PR review request(s) are older than ${STALE_REVIEW_HOURS}h`,
            source,
            field: 'reviewRequests.requestedAt',
            value: stale.length,
          },
          {
            claim: `${top.reviewer} has ${top.requests.length} stale pending PR review request(s)`,
            source,
            field: 'reviewRequests.reviewerId / requestedAt',
            value: top.requests.length,
          },
          ...(top.identityStatus === 'known' && top.identityId
            ? [
                {
                  claim: `${top.reviewer} matched explicit contributor id ${top.identityId}`,
                  source: 'organizationIdentity',
                  field: 'contributors[].aliases[kind=username]',
                  value: top.identityId,
                },
              ]
            : []),
        ],
        inference: snapshotStale
          ? `${top.reviewer}'s stale review queue was at least ${MIN_STALE_REQUESTS_PER_REVIEWER} requests in the ${asOf} snapshot, but the snapshot is older than ${SNAPSHOT_STALE_AFTER_DAYS} day(s), so the finding is demoted to a dated historical claim rather than a live bottleneck.`
          : `${top.reviewer}'s stale review queue is at least ${MIN_STALE_REQUESTS_PER_REVIEWER} requests and the oldest pending request has waited ${formatAge(oldestAgeMs)}, so review handoff latency is concentrated on one reviewer.`,
        ...(asOf ? { asOf, stale: snapshotStale } : {}),
      },
    };
  },
};
