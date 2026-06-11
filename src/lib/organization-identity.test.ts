import { describe, expect, it } from 'vitest';
import {
  createContributorAliasResolver,
  normalizeContributorAlias,
  resolveContributorAlias,
  type OrganizationIdentityDataset,
} from './organization-identity';

const identity: OrganizationIdentityDataset = {
  source: 'test identity map',
  contributors: [
    {
      id: 'u-alice',
      displayName: 'Alice Smith',
      email: 'Alice@example.com',
      teamIds: ['platform'],
      aliases: [
        { kind: 'task-owner', value: 'alice', source: 'fixture' },
        { kind: 'username', value: 'asmith', source: 'fixture' },
      ],
    },
    {
      id: 'u-bob',
      displayName: 'Bob Lee',
      aliases: [{ kind: 'task-owner', value: 'bob', source: 'fixture' }],
    },
  ],
};

describe('organization identity resolver (#1122)', () => {
  it('normalizes explicit aliases without preserving case noise', () => {
    expect(normalizeContributorAlias('task-owner', ' Alice ')).toBe('alice');
    expect(normalizeContributorAlias('email', 'Alice@Example.COM')).toBe('alice@example.com');
  });

  it('resolves only explicit aliases to stable contributors', () => {
    const rec = resolveContributorAlias(identity, { kind: 'task-owner', value: ' Alice ' });
    expect(rec.status).toBe('known');
    if (rec.status === 'known') {
      expect(rec.contributor.id).toBe('u-alice');
      expect(rec.contributor.displayName).toBe('Alice Smith');
    }
  });

  it('creates a reusable alias resolver from one identity index', () => {
    const resolveAlias = createContributorAliasResolver(identity);
    const byOwner = resolveAlias({ kind: 'task-owner', value: 'alice' });
    const byEmail = resolveAlias({ kind: 'email', value: 'ALICE@example.com' });

    expect(byOwner.status).toBe('known');
    expect(byEmail.status).toBe('known');
    if (byOwner.status === 'known' && byEmail.status === 'known') {
      expect(byOwner.contributor.id).toBe('u-alice');
      expect(byEmail.contributor.id).toBe('u-alice');
    }
  });

  it('treats email as an explicit alias when the contributor supplies one', () => {
    const rec = resolveContributorAlias(identity, { kind: 'email', value: 'alice@example.com' });
    expect(rec.status).toBe('known');
    if (rec.status === 'known') expect(rec.contributor.id).toBe('u-alice');
  });

  it('does not infer from display names or missing identity data', () => {
    expect(
      resolveContributorAlias(identity, { kind: 'task-owner', value: 'Alice Smith' }).status
    ).toBe('unknown');
    expect(
      resolveContributorAlias(null, { kind: 'task-owner', value: 'alice' }).status
    ).toBe('unknown');
  });

  it('returns ambiguous when one alias maps to multiple contributors', () => {
    const ambiguous: OrganizationIdentityDataset = {
      contributors: [
        { id: 'u-1', displayName: 'One', aliases: [{ kind: 'task-owner', value: 'shared' }] },
        { id: 'u-2', displayName: 'Two', aliases: [{ kind: 'task-owner', value: 'shared' }] },
      ],
    };
    const rec = resolveContributorAlias(ambiguous, { kind: 'task-owner', value: 'shared' });
    expect(rec.status).toBe('ambiguous');
    if (rec.status === 'ambiguous') expect(rec.contributorIds).toEqual(['u-1', 'u-2']);
  });
});
