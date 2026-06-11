/**
 * Organization PR/review event contract (#1123).
 *
 * Enterprise review recommendations need a structured review-event source. This
 * contract is intentionally transcript-free: a future GitHub/App sync can provide
 * PR ids, reviewer ids, request states, and timestamps without reading prompt text.
 */

export type PullRequestState = 'open' | 'closed' | 'merged';

export type PullRequestReviewRequestState =
  | 'pending'
  | 'approved'
  | 'changes_requested'
  | 'commented'
  | 'dismissed';

export interface PullRequestReviewRequest {
  /** Source-stable id for this review request, if the connector exposes one. */
  id?: string;
  /** Repository name, preferably owner/name. */
  repository: string;
  /** Pull request number within the repository. */
  pullRequestNumber: number;
  /** Short PR title; may be omitted when the source redacts titles. */
  pullRequestTitle?: string;
  /** PR URL for triage; may be omitted in redacted exports. */
  pullRequestUrl?: string;
  /** Current PR state. Missing is treated as open for older exports. */
  pullRequestState?: PullRequestState;
  /** Source-stable author id or login. */
  authorId?: string;
  /** Source-stable reviewer id or login. Required for bottleneck grouping. */
  reviewerId: string;
  /** Display label from the review source, if available. */
  reviewerDisplayName?: string;
  /** ISO timestamp when review was requested. */
  requestedAt: string;
  /** ISO timestamp when the reviewer responded; absent for pending requests. */
  respondedAt?: string;
  /** Current review request state. */
  state: PullRequestReviewRequestState;
}

export interface OrganizationReviewEventsDataset {
  /** Connector/source name, e.g. "github-review-sync". */
  source?: string;
  /** ISO timestamp for when the aggregate was generated. */
  generatedAt?: string;
  /** Flat review-request records across repositories. */
  reviewRequests: PullRequestReviewRequest[];
}
