/**
 * Organization contributor identity contract (#1122).
 *
 * Recommendation detectors may use this optional aggregate to connect explicit
 * aliases such as Task/Todo owner strings to stable organization contributors.
 * The resolver intentionally refuses to infer identity from prompts, session
 * ids, cwd, entrypoint, or display names. Unknown and ambiguous aliases remain
 * explicit states so detectors can stay conservative.
 */

export type ContributorAliasKind =
  | 'task-owner'
  | 'email'
  | 'username'
  | 'git-author'
  | 'session-user';

export interface ContributorAlias {
  kind: ContributorAliasKind;
  value: string;
  /**
   * Human-readable source for the alias, e.g. "configured identity map" or a
   * parser name. Optional because callers may construct test fixtures inline.
   */
  source?: string;
}

export interface ContributorIdentity {
  /** Durable organization-scoped contributor id, not a transient session id. */
  id: string;
  /** Display label safe to show in recommendations. */
  displayName: string;
  /** Explicit email, if the organization supplied one. Also acts as an email alias. */
  email?: string;
  /** Optional stable team ids for org rollups. */
  teamIds?: string[];
  /** Explicit aliases that may resolve to this contributor. */
  aliases?: ContributorAlias[];
}

export interface OrganizationIdentityTeam {
  id: string;
  name: string;
  parentId?: string;
}

export interface OrganizationIdentityDataset {
  /**
   * Optional source name for the whole aggregate. This is intentionally generic
   * because the first durable source may be static config, IdP sync, or a
   * future org-members artifact.
   */
  source?: string;
  generatedAt?: string;
  contributors: ContributorIdentity[];
  teams?: OrganizationIdentityTeam[];
}

export type ContributorResolution =
  | {
      status: 'known';
      alias: ContributorAlias;
      contributor: ContributorIdentity;
    }
  | {
      status: 'unknown';
      alias: ContributorAlias;
    }
  | {
      status: 'ambiguous';
      alias: ContributorAlias;
      contributorIds: string[];
    };

export type ContributorAliasResolver = (alias: ContributorAlias) => ContributorResolution;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function normalizeContributorAlias(kind: ContributorAliasKind, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  switch (kind) {
    case 'email':
    case 'username':
    case 'task-owner':
    case 'git-author':
    case 'session-user':
      return trimmed.toLowerCase();
  }
}

function aliasKey(alias: ContributorAlias): string {
  return `${alias.kind}:${normalizeContributorAlias(alias.kind, alias.value)}`;
}

function normalizedAlias(alias: ContributorAlias): ContributorAlias | null {
  if (!isNonEmptyString(alias.value)) return null;
  const value = normalizeContributorAlias(alias.kind, alias.value);
  if (!value) return null;
  return {
    kind: alias.kind,
    value,
    ...(alias.source ? { source: alias.source } : {}),
  };
}

function contributorAliasEntries(contributor: ContributorIdentity): ContributorAlias[] {
  const aliases = contributor.aliases ?? [];
  return [
    ...aliases,
    ...(isNonEmptyString(contributor.email)
      ? [{ kind: 'email' as const, value: contributor.email, source: 'contributor.email' }]
      : []),
  ];
}

export function createContributorAliasResolver(
  identity: OrganizationIdentityDataset | null | undefined
): ContributorAliasResolver {
  const index = new Map<string, Map<string, ContributorIdentity>>();

  if (identity?.contributors?.length) {
    for (const contributor of identity.contributors) {
      if (!isNonEmptyString(contributor.id)) continue;
      for (const candidate of contributorAliasEntries(contributor)) {
        const normalized = normalizedAlias(candidate);
        if (!normalized) continue;
        const key = aliasKey(normalized);
        const matches = index.get(key) ?? new Map<string, ContributorIdentity>();
        matches.set(contributor.id, contributor);
        index.set(key, matches);
      }
    }
  }

  return (alias: ContributorAlias): ContributorResolution => {
    const query = normalizedAlias(alias);
    if (!query || !identity?.contributors?.length) {
      return { status: 'unknown', alias };
    }

    const matches = index.get(aliasKey(query));
    if (!matches || matches.size === 0) return { status: 'unknown', alias: query };
    if (matches.size > 1) {
      return {
        status: 'ambiguous',
        alias: query,
        contributorIds: [...matches.keys()].sort(),
      };
    }

    const contributor = [...matches.values()][0];
    return { status: 'known', alias: query, contributor };
  };
}

export function resolveContributorAlias(
  identity: OrganizationIdentityDataset | null | undefined,
  alias: ContributorAlias
): ContributorResolution {
  return createContributorAliasResolver(identity)(alias);
}
