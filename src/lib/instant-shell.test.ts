import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  BOOT_SCRIPT_ID,
  INSTANT_SHELL_ATTR,
  SHELL_REGION_OPEN,
  SHELL_REGION_CLOSE,
  SKELETON_SHELL,
  deriveBootShell,
  renderShellInner,
  renderShellRegion,
  renderBootScript,
  serializeBootEnvelope,
  parseBootEnvelope,
  injectShellIntoTemplate,
  rewriteServedHtml,
  type BootShell,
} from './instant-shell';

// Guards the deliberate literal-duplication in src/main.tsx / src/App.tsx (they
// hard-code these to keep the byte-frozen browser shell chunk at zero cost).
describe('DOM-facing constants', () => {
  it('are the exact literals the client hard-codes', () => {
    expect(BOOT_SCRIPT_ID).toBe('__BOOT__');
    expect(INSTANT_SHELL_ATTR).toBe('data-instant-shell');
  });
});

describe('deriveBootShell', () => {
  it('reads the masthead fields (aggregates.sessions/events, counts.tokenData)', () => {
    const shell = deriveBootShell({
      version: 'abc123',
      meta: {},
      aggregates: { sessions: 42, events: 1200 } as never,
      counts: { tokenData: 7 },
      sliceKeys: [],
    });
    expect(shell).toEqual({
      kpis: { sessions: 42, entries: 1200, tokenFiles: 7 },
      version: 'abc123',
      ready: true,
    });
  });

  it('is defensive against missing/garbage fields', () => {
    expect(deriveBootShell(null)).toEqual({
      kpis: { sessions: 0, entries: 0, tokenFiles: 0 },
      version: '',
      ready: true,
    });
    const shell = deriveBootShell({
      aggregates: { sessions: -3, events: 'x' } as never,
      counts: {},
    } as never);
    expect(shell.kpis).toEqual({ sessions: 0, entries: 0, tokenFiles: 0 });
  });
});

describe('renderShellInner', () => {
  it('carries its own scoped <style> (CSS bundle not parsed at HTML parse)', () => {
    const html = renderShellInner(SKELETON_SHELL);
    expect(html).toContain('<style>');
    expect(html).toContain('[data-instant-shell]');
  });

  it('shows em-dash placeholders when not ready (skeleton)', () => {
    const html = renderShellInner(SKELETON_SHELL);
    expect(html).toContain('&mdash;');
    expect(html).not.toMatch(/<b>\d/);
  });

  it('shows grouped real numbers when ready, locale-independently', () => {
    const shell: BootShell = {
      kpis: { sessions: 1234, entries: 5678901, tokenFiles: 12 },
      version: 'v',
      ready: true,
    };
    const html = renderShellInner(shell);
    expect(html).toContain('1,234');
    expect(html).toContain('5,678,901');
    expect(html).not.toContain('&mdash;');
  });

  it('does not emit a raw closing script tag', () => {
    expect(renderShellInner(SKELETON_SHELL)).not.toContain('</script');
  });
});

describe('renderShellRegion / renderBootScript', () => {
  it('wraps the inner markup in the splice markers', () => {
    const region = renderShellRegion(SKELETON_SHELL);
    expect(region.startsWith(SHELL_REGION_OPEN)).toBe(true);
    expect(region.endsWith(SHELL_REGION_CLOSE)).toBe(true);
  });
  it('emits an application/json boot script', () => {
    const s = renderBootScript({ shell: SKELETON_SHELL });
    expect(s).toContain(`<script id="${BOOT_SCRIPT_ID}" type="application/json">`);
    expect(s).toContain('</script>');
  });
});

describe('serializeBootEnvelope / parseBootEnvelope', () => {
  it('round-trips and escapes < for safe <script> embedding', () => {
    const env = { shell: { ...SKELETON_SHELL, version: 'a<b' } };
    const s = serializeBootEnvelope(env);
    expect(s).not.toContain('<');
    expect(s).toContain('\\u003c');
    // JSON.parse decodes < transparently — exactly what the client does.
    expect(parseBootEnvelope(s)).toEqual(env);
  });

  it('parse returns null on garbage / missing shell', () => {
    expect(parseBootEnvelope('')).toBeNull();
    expect(parseBootEnvelope('not json')).toBeNull();
    expect(parseBootEnvelope('{"nope":1}')).toBeNull();
    expect(parseBootEnvelope(null)).toBeNull();
  });
});

const BARE_TEMPLATE =
  `<!doctype html><html><head><title>t</title></head>` +
  `<body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.tsx"></script>\n  </body></html>`;

describe('injectShellIntoTemplate (build time)', () => {
  it('wraps root with a bare data-instant-shell div holding the shell region', () => {
    const out = injectShellIntoTemplate(BARE_TEMPLATE)!;
    // Wrapper carries ONLY the attribute — nothing else — so client hydration
    // matches it trivially.
    expect(out).toContain(`<div id="root"><div ${INSTANT_SHELL_ATTR}>${SHELL_REGION_OPEN}`);
    expect(out).toContain(`${SHELL_REGION_CLOSE}</div></div>`);
    expect(out).toContain(`<script id="${BOOT_SCRIPT_ID}" type="application/json">`);
    expect(out).toContain('&mdash;'); // skeleton placeholders
  });

  it('is idempotent and returns null when the empty-root anchor is gone', () => {
    const once = injectShellIntoTemplate(BARE_TEMPLATE)!;
    expect(injectShellIntoTemplate(once)).toBe(once);
    expect(injectShellIntoTemplate('<html><body>no root</body></html>')).toBeNull();
  });

  it('injects into the real repo index.html (guards the #root anchor against drift)', () => {
    // If index.html's `<div id="root"></div>` shape ever changes, injection
    // silently returns null (plugin warns, app still boots) — this catches that
    // in CI instead of shipping an un-injected server build.
    const indexHtml = readFileSync(
      fileURLToPath(new URL('../../index.html', import.meta.url)),
      'utf8',
    );
    const out = injectShellIntoTemplate(indexHtml);
    expect(out).not.toBeNull();
    expect(out).toContain(`<div ${INSTANT_SHELL_ATTR}>${SHELL_REGION_OPEN}`);
    expect(out).toContain(`<script id="${BOOT_SCRIPT_ID}" type="application/json">`);
  });
});

describe('rewriteServedHtml (runtime)', () => {
  it('replaces skeleton shell + boot script with real data in place', () => {
    const built = injectShellIntoTemplate(BARE_TEMPLATE)!;
    const real: BootShell = {
      kpis: { sessions: 9, entries: 100, tokenFiles: 3 },
      version: 'hash1',
      ready: true,
    };
    const out = rewriteServedHtml(built, real);
    expect(out).toContain('<b>9</b>'); // real session count rendered
    expect(out).not.toContain('&mdash;'); // skeleton placeholders replaced
    // wrapper + markers preserved so the shape stays rewritable/idempotent
    expect(out).toContain(`<div ${INSTANT_SHELL_ATTR}>${SHELL_REGION_OPEN}`);
    // boot script now carries the real version
    const scriptInner = out
      .split(`<script id="${BOOT_SCRIPT_ID}" type="application/json">`)[1]
      .split('</script>')[0];
    expect(parseBootEnvelope(scriptInner)?.shell.version).toBe('hash1');
  });

  it('is a safe no-op when the shell markers are absent (e.g. an spa build)', () => {
    const spa = '<html><body><div id="root"></div></body></html>';
    expect(rewriteServedHtml(spa, deriveBootShell(null))).toBe(spa);
  });
});
