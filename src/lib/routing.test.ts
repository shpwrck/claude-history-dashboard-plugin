// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DASHBOARD_FILTER,
  navigateWithFilter,
  parseDashboardFilter,
  parseRoute,
  presetToRange,
  routeToHash,
  scrollToSignalAnchor,
} from './routing';

describe('parseRoute', () => {
  it('parses a bare view hash', () => {
    expect(parseRoute('#/cost')).toEqual({
      view: 'cost',
      viewFilter: {},
      filter: DEFAULT_DASHBOARD_FILTER,
    });
  });

  it('parses a view with a session deep-link', () => {
    expect(parseRoute('#/sessions?session=abc123')).toEqual({
      view: 'sessions',
      session: 'abc123',
      viewFilter: {},
      filter: DEFAULT_DASHBOARD_FILTER,
    });
  });

  it('tolerates a missing leading slash', () => {
    expect(parseRoute('#cost')).toEqual({
      view: 'cost',
      viewFilter: {},
      filter: DEFAULT_DASHBOARD_FILTER,
    });
  });

  it('drops an unknown view', () => {
    expect(parseRoute('#/not-a-view')).toEqual({
      viewFilter: {},
      filter: DEFAULT_DASHBOARD_FILTER,
    });
  });

  it('returns empty for an empty hash', () => {
    expect(parseRoute('')).toEqual({
      viewFilter: {},
      filter: DEFAULT_DASHBOARD_FILTER,
    });
    expect(parseRoute('#')).toEqual({
      viewFilter: {},
      filter: DEFAULT_DASHBOARD_FILTER,
    });
    expect(parseRoute('#/')).toEqual({
      viewFilter: {},
      filter: DEFAULT_DASHBOARD_FILTER,
    });
  });

  it('keeps a session param even when the view is the home digest', () => {
    expect(parseRoute('#/home')).toEqual({
      view: 'home',
      viewFilter: {},
      filter: DEFAULT_DASHBOARD_FILTER,
    });
  });

  it('parses the URL-backed dashboard filter', () => {
    expect(parseRoute('#/cost?time=7d&project=%2Frepo%2Falpha')).toEqual({
      view: 'cost',
      viewFilter: { project: '/repo/alpha' },
      filter: { time: '7d', project: '/repo/alpha' },
    });
  });

  it('parses per-view evidence filters alongside dashboard filters', () => {
    expect(
      parseRoute(
        '#/errors?tool=Bash&file=src%2FApp.tsx&date=2026-06-15&mode=sdk-cli&from=1781550000000&to=1781553600000&sort=cost'
      )
    ).toEqual({
      view: 'errors',
      viewFilter: {
        tool: 'Bash',
        file: 'src/App.tsx',
        date: '2026-06-15',
        mode: 'sdk-cli',
        from: '1781550000000',
        to: '1781553600000',
        sort: 'cost',
      },
      filter: DEFAULT_DASHBOARD_FILTER,
    });
  });

  it('parses safety drill-through filters', () => {
    expect(
      parseRoute(
        '#/permissions?entrypoint=unattended&pattern=rm+-rf&table=policy'
      )
    ).toEqual({
      view: 'permissions',
      viewFilter: {
        entrypoint: 'unattended',
        pattern: 'rm -rf',
        table: 'policy',
      },
      filter: DEFAULT_DASHBOARD_FILTER,
    });
  });

  it('does not treat the default dashboard project as a per-view filter', () => {
    expect(parseRoute('#/automation?time=24h&project=All+projects&mode=sdk-cli')).toEqual({
      view: 'automation',
      viewFilter: { mode: 'sdk-cli' },
      filter: DEFAULT_DASHBOARD_FILTER,
    });
  });

  it('falls back for stale project query values when valid projects are known', () => {
    expect(
      parseRoute('#/cost?time=30d&project=%2Frepo%2Fmissing', {
        validProjects: ['/repo/alpha'],
      })
    ).toEqual({
      view: 'cost',
      viewFilter: { project: '/repo/missing' },
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

  it('serializes per-view evidence filters', () => {
    expect(
      routeToHash('errors', {
        viewFilter: {
          tool: 'Bash',
          file: 'src/App.tsx',
          date: '2026-06-15',
          from: '1781550000000',
          to: '1781553600000',
          sort: 'cost',
        },
      })
    ).toBe(
      '#/errors?date=2026-06-15&tool=Bash&file=src%2FApp.tsx&from=1781550000000&to=1781553600000&sort=cost'
    );
  });

  it('serializes safety drill-through filters', () => {
    expect(
      routeToHash('permissions', {
        viewFilter: {
          entrypoint: 'unattended',
          pattern: 'rm -rf',
          table: 'policy',
        },
      })
    ).toBe(
      '#/permissions?entrypoint=unattended&pattern=rm+-rf&table=policy'
    );
  });
});

describe('navigateWithFilter', () => {
  it('returns and writes a filtered hash', () => {
    const hash = navigateWithFilter('automation', { mode: 'sdk-cli' }, {
      dashboardFilter: { time: '7d', project: 'All projects' },
    });
    expect(hash).toBe('#/automation?time=7d&project=All+projects&mode=sdk-cli');
    expect(window.location.hash).toBe('#/automation?time=7d&project=All+projects&mode=sdk-cli');
  });
});

describe('scrollToSignalAnchor', () => {
  it('scrolls and focuses a matching data-signal-id node', () => {
    document.body.innerHTML = '<section data-signal-id="token-spend-over-time"></section>';
    const target = document.querySelector('section') as HTMLElement;
    const scrollIntoView = vi.fn();
    target.scrollIntoView = scrollIntoView;

    expect(scrollToSignalAnchor('token-spend-over-time', { focus: true })).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: 'start',
      behavior: 'smooth',
    });
    expect(document.activeElement).toBe(target);
  });

  it('returns false when no anchor matches', () => {
    document.body.innerHTML = '';
    expect(scrollToSignalAnchor('missing')).toBe(false);
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
