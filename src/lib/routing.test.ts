import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DASHBOARD_FILTER,
  parseDashboardFilter,
  parseRoute,
  presetToRange,
  routeToHash,
} from './routing';

describe('parseRoute', () => {
  it('parses a bare view hash', () => {
    expect(parseRoute('#/cost')).toEqual({
      view: 'cost',
      filter: DEFAULT_DASHBOARD_FILTER,
    });
  });

  it('parses a view with a session deep-link', () => {
    expect(parseRoute('#/sessions?session=abc123')).toEqual({
      view: 'sessions',
      session: 'abc123',
      filter: DEFAULT_DASHBOARD_FILTER,
    });
  });

  it('tolerates a missing leading slash', () => {
    expect(parseRoute('#cost')).toEqual({
      view: 'cost',
      filter: DEFAULT_DASHBOARD_FILTER,
    });
  });

  it('drops an unknown view', () => {
    expect(parseRoute('#/not-a-view')).toEqual({
      filter: DEFAULT_DASHBOARD_FILTER,
    });
  });

  it('returns empty for an empty hash', () => {
    expect(parseRoute('')).toEqual({ filter: DEFAULT_DASHBOARD_FILTER });
    expect(parseRoute('#')).toEqual({ filter: DEFAULT_DASHBOARD_FILTER });
    expect(parseRoute('#/')).toEqual({ filter: DEFAULT_DASHBOARD_FILTER });
  });

  it('keeps a session param even when the view is the home digest', () => {
    expect(parseRoute('#/home')).toEqual({
      view: 'home',
      filter: DEFAULT_DASHBOARD_FILTER,
    });
  });

  it('parses the URL-backed dashboard filter', () => {
    expect(parseRoute('#/cost?time=7d&project=%2Frepo%2Falpha')).toEqual({
      view: 'cost',
      filter: { time: '7d', project: '/repo/alpha' },
    });
  });

  it('falls back for stale project query values when valid projects are known', () => {
    expect(
      parseRoute('#/cost?time=30d&project=%2Frepo%2Fmissing', {
        validProjects: ['/repo/alpha'],
      })
    ).toEqual({
      view: 'cost',
      filter: { time: '30d', project: 'All projects' },
    });
  });
});

describe('routeToHash', () => {
  it('builds a canonical hash', () => {
    expect(routeToHash('cost')).toBe('#/cost');
    expect(routeToHash('home')).toBe('#/home');
  });

  it('round-trips with parseRoute', () => {
    for (const v of ['home', 'cost', 'reclaim-compass', 'permissions', 'sessions'] as const) {
      expect(parseRoute(routeToHash(v)).view).toBe(v);
    }
  });

  it('serializes dashboard filters and session deep links', () => {
    expect(
      routeToHash('sessions', {
        session: 'abc123',
        filter: { time: 'all', project: '/repo/alpha' },
      })
    ).toBe('#/sessions?session=abc123&time=all&project=%2Frepo%2Falpha');
  });
});

describe('parseDashboardFilter', () => {
  it('normalizes invalid time presets to the default', () => {
    expect(parseDashboardFilter('?time=forever&project=%2Frepo%2Falpha')).toEqual({
      time: '24h',
      project: '/repo/alpha',
    });
  });
});

describe('presetToRange', () => {
  const now = Date.parse('2026-06-11T12:00:00.000Z');

  it('maps bounded presets to inclusive millisecond windows', () => {
    expect(presetToRange('24h', now)).toEqual({
      from: Date.parse('2026-06-10T12:00:00.000Z'),
      to: now,
    });
    expect(presetToRange('7d', now)).toEqual({
      from: Date.parse('2026-06-04T12:00:00.000Z'),
      to: now,
    });
    expect(presetToRange('30d', now)).toEqual({
      from: Date.parse('2026-05-12T12:00:00.000Z'),
      to: now,
    });
  });

  it('leaves all-time unbounded', () => {
    expect(presetToRange('all', now)).toEqual({ from: null, to: null });
  });
});
