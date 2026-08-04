// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { DATA_SURFACE, EMPTY_STATE } from '../../e2e/data-surface';

/**
 * Guards the sample-data smoke's data-surface selector (#3305).
 *
 * The OLD selector `table tbody tr, svg` matched ANY <svg>, so a PatternFly icon
 * or an empty-state icon falsely certified that "sample data rendered". These
 * jsdom fixtures FAIL on that bug and PASS on the qualified selector, which
 * matches only real populated surfaces (a table row, a role="img" chart, a
 * timeline entry row) and excludes icons / empty states.
 */
function buildMain(html: string): HTMLElement {
  const main = document.createElement('main');
  main.innerHTML = html;
  document.body.replaceChildren(main);
  return main;
}

describe('sample-data smoke DATA_SURFACE selector (#3305)', () => {
  it('matches a populated LightweightCharts chart (svg[role="img"])', () => {
    // SvgFrame sets role="img" only when the chart carries an aria-label (data).
    const main = buildMain(
      '<svg role="img" aria-label="Tokens by model"><rect></rect></svg>'
    );
    expect(main.querySelectorAll(DATA_SURFACE).length).toBeGreaterThan(0);
  });

  it('matches a populated table row and a timeline entry row', () => {
    const table = buildMain('<table><tbody><tr><td>row</td></tr></tbody></table>');
    expect(table.querySelectorAll(DATA_SURFACE).length).toBeGreaterThan(0);
    const timeline = buildMain('<div class="st-timeline-row"><span>entry</span></div>');
    expect(timeline.querySelectorAll(DATA_SURFACE).length).toBeGreaterThan(0);
  });

  it('does NOT match a decorative / icon svg — the #3305 false positive', () => {
    // PatternFly-style icon: aria-hidden, no role="img". The OLD bare `svg` arm
    // matched this and certified "data rendered"; the qualified selector must not.
    const main = buildMain(
      '<button><svg aria-hidden="true" class="pf-v6-svg"><path></path></svg></button>'
    );
    expect(main.querySelectorAll(DATA_SURFACE).length).toBe(0);
    // Sanity: a bare `svg` selector WOULD have matched it — proving the arm mattered.
    expect(main.querySelectorAll('svg').length).toBe(1);
  });

  it('does NOT match an empty-state rendering only an icon svg + an empty table', () => {
    const main = buildMain(
      `<div class="${EMPTY_STATE.slice(1)}"><svg aria-hidden="true"><path></path></svg>` +
        '<p>No data</p></div><table><tbody></tbody></table>'
    );
    expect(main.querySelectorAll(DATA_SURFACE).length).toBe(0);
  });

  it('retains no unqualified `svg` arm', () => {
    expect(DATA_SURFACE).not.toMatch(/(^|,)\s*svg\s*(,|$)/);
    expect(DATA_SURFACE).toContain('svg[role="img"]');
    expect(DATA_SURFACE).toContain('table tbody tr');
    expect(DATA_SURFACE).toContain('.st-timeline-row');
  });
});
