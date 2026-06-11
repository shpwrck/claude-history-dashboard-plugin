import { describe, expect, it } from 'vitest';
import { validateRecommendationProvenance } from '../provenance';
import type { RecommendationInput } from '../types';
import type {
  OrganizationReviewEventsDataset,
  PullRequestReviewRequest,
} from '../../organization-review-events';
import type { OrganizationIdentityDataset } from '../../organization-identity';
import {
  detector,
  MIN_STALE_REVIEW_REQUESTS,
  STALE_REVIEW_HOURS,
} from './review-bottleneck';

const NOW = Date.parse('2026-06-10T12:00:00Z');

function requestedHoursAgo(hours: number): string {
  return new Date(NOW - hours * 60 * 60 * 1000).toISOString();
}

function reviewRequest(
  overrides: Partial<PullRequestReviewRequest> & { reviewerId: string; pullRequestNumber: number }
): PullRequestReviewRequest {
  return {
    repository: 'acme/app',
    pullRequestTitle: `PR ${overrides.pullRequestNumber}`,
    pullRequestState: 'open',
    requestedAt: requestedHoursAgo(STALE_REVIEW_HOURS + 12),
    state: 'pending',
    ...overrides,
  };
}

function input(
  reviewEvents?: OrganizationReviewEventsDataset | null,
  organizationIdentity?: OrganizationIdentityDataset
): RecommendationInput {
  return {
    tokenData: [],
    toolData: [],
    sessions: [],
    projects: [],
    permissionRows: [],
    apiErrors: [],
    reviewEvents,
    organizationIdentity,
  };
}

describe('workflow.review-bottleneck (#1123)', () => {
  it('stays dark when the review event source is unavailable', () => {
    expect(detector.rule(input(undefined), NOW)).toBeNull();
    expect(detector.rule(input({ source: 'github-review-sync', reviewRequests: [] }), NOW)).toBeNull();
  });

  it('flags stale review latency concentrated on one reviewer', () => {
    const reviewEvents: OrganizationReviewEventsDataset = {
      source: 'github-review-sync',
      generatedAt: new Date(NOW).toISOString(),
      reviewRequests: [
        reviewRequest({ reviewerId: 'alice', reviewerDisplayName: 'Alice', pullRequestNumber: 1, requestedAt: requestedHoursAgo(72) }),
        reviewRequest({ reviewerId: 'alice', reviewerDisplayName: 'Alice', pullRequestNumber: 2, requestedAt: requestedHoursAgo(60) }),
        reviewRequest({ reviewerId: 'alice', reviewerDisplayName: 'Alice', pullRequestNumber: 3, requestedAt: requestedHoursAgo(55) }),
        reviewRequest({ reviewerId: 'bob', reviewerDisplayName: 'Bob', pullRequestNumber: 4, requestedAt: requestedHoursAgo(53) }),
      ],
    };

    const rec = detector.rule(input(reviewEvents), NOW);

    expect(rec?.id).toBe('workflow.review-bottleneck');
    expect(rec?.category).toBe('workflow');
    expect(rec?.severity).toBe('info');
    expect(rec?.affected).toBe(3);
    expect(rec?.detail).toContain('Alice has 3 stale pending PR review request');
    expect(rec?.detail).toContain(`${MIN_STALE_REVIEW_REQUESTS + 1} of ${MIN_STALE_REVIEW_REQUESTS + 1}`);
    expect(rec?.evidence?.join('\n')).toContain('acme/app#1 PR 1');
    expect(validateRecommendationProvenance(rec!)).toEqual([]);
  });

  it('does not flag a balanced stale review load', () => {
    const reviewEvents: OrganizationReviewEventsDataset = {
      reviewRequests: Array.from({ length: MIN_STALE_REVIEW_REQUESTS }, (_, i) =>
        reviewRequest({
          reviewerId: `reviewer-${i}`,
          pullRequestNumber: i + 1,
          requestedAt: requestedHoursAgo(72),
        })
      ),
    };

    expect(detector.rule(input(reviewEvents), NOW)).toBeNull();
  });

  it('ignores responded, closed, fresh, and malformed requests', () => {
    const reviewEvents: OrganizationReviewEventsDataset = {
      reviewRequests: [
        reviewRequest({ reviewerId: 'alice', pullRequestNumber: 1, respondedAt: requestedHoursAgo(2) }),
        reviewRequest({ reviewerId: 'alice', pullRequestNumber: 2, pullRequestState: 'closed' }),
        reviewRequest({ reviewerId: 'alice', pullRequestNumber: 3, requestedAt: requestedHoursAgo(2) }),
        reviewRequest({ reviewerId: 'alice', pullRequestNumber: 4, requestedAt: 'not-a-date' }),
      ],
    };

    expect(detector.rule(input(reviewEvents), NOW)).toBeNull();
  });

  it('groups explicit username aliases into one durable contributor', () => {
    const reviewEvents: OrganizationReviewEventsDataset = {
      source: 'github-review-sync',
      reviewRequests: [
        reviewRequest({ reviewerId: 'alice', pullRequestNumber: 1, requestedAt: requestedHoursAgo(72) }),
        reviewRequest({ reviewerId: 'asmith', pullRequestNumber: 2, requestedAt: requestedHoursAgo(60) }),
        reviewRequest({ reviewerId: 'alice', pullRequestNumber: 3, requestedAt: requestedHoursAgo(55) }),
        reviewRequest({ reviewerId: 'bob', pullRequestNumber: 4, requestedAt: requestedHoursAgo(53) }),
      ],
    };
    const organizationIdentity: OrganizationIdentityDataset = {
      contributors: [
        {
          id: 'u-alice',
          displayName: 'Alice Smith',
          aliases: [
            { kind: 'username', value: 'alice' },
            { kind: 'username', value: 'asmith' },
          ],
        },
        { id: 'u-bob', displayName: 'Bob Lee', aliases: [{ kind: 'username', value: 'bob' }] },
      ],
    };

    const rec = detector.rule(input(reviewEvents, organizationIdentity), NOW);

    expect(rec?.title).toContain('Alice Smith');
    expect(rec?.evidence?.[0]).toContain('via aliases alice, asmith');
    expect(rec?.provenance?.observations.some((obs) => obs.value === 'u-alice')).toBe(true);
  });
});
