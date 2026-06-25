import { describe, expect, it } from 'vitest';
import {
  DOMAIN_REGISTRY,
  ALL_DOMAINS,
  ACTION_DOMAIN_NAMES,
  DOMAIN_OUTCOME_VERB,
  DOMAIN_LANDING_VIEW,
  CATEGORY_TO_DOMAIN,
  domainEntry,
} from './domain-registry';
import type { RecCategory } from './recommendations';
import type { ActionDomain } from '../types';
import { NAV_ITEMS } from './nav-prefs';

// The full RecCategory union, listed literally so the completeness test fails
// to compile (and to run) if a new category is added without a domain home.
const ALL_REC_CATEGORIES: readonly RecCategory[] = [
  'cost',
  'context',
  'workflow',
  'safety',
  'security',
  'reliability',
  'speed',
  'activity',
  'maintenance',
];

// The full ActionDomain union, listed literally for the same reason.
const ALL_ACTION_DOMAINS: readonly ActionDomain[] = [
  'home',
  'safety',
  'cost',
  'success-rate',
  'speed',
  'context-health',
  'workflow-hygiene',
  'discovery',
  'raw',
];

describe('domain registry — single source of truth (#2079)', () => {
  it('has exactly one entry per ActionDomain', () => {
    const names = DOMAIN_REGISTRY.map((d) => d.name).sort();
    expect(names).toEqual([...ALL_ACTION_DOMAINS].sort());
    expect(new Set(names).size).toBe(DOMAIN_REGISTRY.length);
  });

  it('is stored in ascending order and every domain has a landing view', () => {
    const orders = DOMAIN_REGISTRY.map((d) => d.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
    for (const d of DOMAIN_REGISTRY) {
      expect(d.landing, `${d.name} must have a landing view`).toBeTruthy();
      expect(d.outcomeVerb, `${d.name} must have an outcome-verb`).toBeTruthy();
    }
  });

  it('maps every detector RecCategory to exactly one domain (exhaustive, no double-claim)', () => {
    const claimed = DOMAIN_REGISTRY.flatMap((d) => d.categories);
    // No category claimed by two domains.
    expect(new Set(claimed).size).toBe(claimed.length);
    // Every category has a home.
    for (const cat of ALL_REC_CATEGORIES) {
      expect(CATEGORY_TO_DOMAIN[cat], `category ${cat} must map to a domain`).toBeTruthy();
    }
    // No phantom categories beyond the union.
    expect([...claimed].sort()).toEqual([...ALL_REC_CATEGORIES].sort());
  });

  it('every domain that owns at least one view in NAV_ITEMS is in the registry', () => {
    const navDomains = new Set(NAV_ITEMS.map((i) => i.domain));
    for (const d of navDomains) {
      expect(ALL_DOMAINS, `nav domain ${d} must be registered`).toContain(d);
    }
  });

  it('derives the legacy domain order (DOMAIN_ORDER)', () => {
    expect(ALL_DOMAINS).toEqual([
      'home',
      'safety',
      'cost',
      'success-rate',
      'speed',
      'context-health',
      'workflow-hygiene',
      'discovery',
      'raw',
    ]);
  });

  it('derives the six action-domains in safety-first order (ACTION_DOMAINS)', () => {
    expect(ACTION_DOMAIN_NAMES).toEqual([
      'safety',
      'cost',
      'success-rate',
      'speed',
      'context-health',
      'workflow-hygiene',
    ]);
  });

  it('derives the outcome-verb labels (DOMAIN_LABEL) unchanged', () => {
    expect(DOMAIN_OUTCOME_VERB).toEqual({
      home: 'Overview',
      safety: 'Stay safe',
      cost: 'Cut cost',
      'success-rate': 'Fail less',
      speed: 'Go faster',
      'context-health': 'Tame context',
      'workflow-hygiene': 'Clean workflow',
      discovery: 'Find',
      raw: 'Raw data',
    });
  });

  it('derives the landing views (DOMAIN_LANDING) unchanged', () => {
    expect(DOMAIN_LANDING_VIEW).toEqual({
      home: 'home',
      safety: 'permissions',
      cost: 'cost',
      'success-rate': 'errors',
      speed: 'evaluator',
      'context-health': 'context',
      'workflow-hygiene': 'tools',
      discovery: 'search',
      raw: 'stats',
    });
  });

  it('derives the category→domain mapping (DOMAIN_FOR_CATEGORY) unchanged', () => {
    expect(CATEGORY_TO_DOMAIN).toEqual({
      cost: 'cost',
      reliability: 'success-rate',
      safety: 'safety',
      security: 'safety',
      context: 'context-health',
      workflow: 'workflow-hygiene',
      speed: 'speed',
      activity: 'workflow-hygiene',
      maintenance: 'workflow-hygiene',
    });
  });

  it('domainEntry looks up by name and throws on an unknown domain', () => {
    expect(domainEntry('safety').outcomeVerb).toBe('Stay safe');
    expect(() => domainEntry('nope' as ActionDomain)).toThrow(/Unknown action-domain/);
  });
});
