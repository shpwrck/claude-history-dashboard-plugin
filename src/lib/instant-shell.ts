// Instant above-the-fold shell (#2444, epic #1852, Layer B).
//
// The keystone (#2443) cut the server landing to a few hundred ms by shipping a
// boot payload + lazy slices instead of the 98 MB monolith. The remaining cost
// is the JS-boot wait: `index.html` shipped an empty `<div id="root">`, so the
// cold-load harness's Content-Painted metric (time until #root first has a child
// element) could not fire until ~430 KB of JS parsed and React mounted.
//
// This module is the CROSS-STAGE CONTRACT for painting the above-the-fold chrome
// in the *first HTML response* so CP fires at HTML parse:
//
//   - BUILD time  (vite `transformIndexHtml`, server flavor only): inject a
//     SKELETON shell into #root + a `<script id="__BOOT__">` carrying the skeleton
//     envelope. This is what the cold-load harness measures, because it serves the
//     built `dist-server/index.html` via `vite preview` (it never runs
//     scripts/server.mjs). See scripts/cold-load-measure.mjs FLAVORS.server.
//   - RUNTIME     (scripts/server.mjs `serveStatic` .html branch): rewrite the
//     shell + boot script in place with the REAL data-driven shell (derived from
//     the same boot payload buildBootPayload() serves), so deployed users get real
//     KPIs at parse. server.mjs runs under `register-ts` with the zero-node_modules
//     import guard, so this module MUST stay dependency-free (no bare-package
//     imports) — that is why the shell is rendered to a plain HTML STRING, not via
//     react-dom/server (which the runtime image does not ship).
//   - CLIENT      (src/main.tsx / src/App.tsx): when the shell is present, React
//     HYDRATES it instead of blowing it away with a fresh createRoot. The client
//     re-feeds the already-present shell innerHTML through `dangerouslySetInnerHTML`
//     on a bare `<div data-instant-shell>`; React skips child reconciliation for
//     such nodes, so hydration never mismatches regardless of shell markup, AND
//     `renderShellInner` (this module's heavy part) never enters the byte-frozen
//     (#2446) browser shell chunk. After the hydration commit the app flips to the
//     real PFLayout, seeded with the boot KPIs so there is no number flash.
//
// Why the wrapper carries ONLY `data-instant-shell` (no inline style) and all CSS
// lives in a scoped `<style>` INSIDE it: React's hydration must match the wrapper
// element's tag + attributes exactly, but treats a `dangerouslySetInnerHTML`
// subtree as opaque. Keeping styling in the opaque subtree means the client only
// has to reproduce `<div data-instant-shell>` — trivially matchable, and it need
// not know the styles at all. The region markers also live inside that opaque
// subtree, so their comment nodes never reach React's child diff.
//
// Static sample hosting is unaffected by design: the Vite plugin only injects for
// the default (server) build, so the sample index.html remains static and
// src/main.tsx falls back to createRoot when the shell is absent.

import type { DatasetBoot } from './dataset-boot';

// --- DOM-facing constants -------------------------------------------------
// src/main.tsx / src/App.tsx intentionally hard-code these literals rather than
// importing them, so the byte-frozen browser shell chunk pays ZERO bytes for this
// module. instant-shell.test.ts asserts the literals match, so the deliberate
// duplication cannot drift silently.
export const BOOT_SCRIPT_ID = '__BOOT__';
export const INSTANT_SHELL_ATTR = 'data-instant-shell';

// HTML-comment markers delimiting the rewritable shell region. They sit INSIDE the
// `<div data-instant-shell>` wrapper (i.e. inside React's opaque subtree), so the
// runtime splice is a plain indexOf — no regex, no injection surface — and the
// comment nodes never affect hydration.
export const SHELL_REGION_OPEN = '<!--chd:shell-->';
export const SHELL_REGION_CLOSE = '<!--/chd:shell-->';

// --- Types ----------------------------------------------------------------
/** The three headline counts painted in the masthead meta line (mirrors
 * DatasetShellCounts, named for the shell's own use). */
export interface BootShellKpis {
  sessions: number;
  entries: number;
  tokenFiles: number;
}

/** The compact above-the-fold projection. `ready:false` is the skeleton (baked
 * into the static build, no user data); `ready:true` is server-injected real
 * data. `version` is the ingest contentHash (empty for skeleton). */
export interface BootShell {
  kpis: BootShellKpis;
  version: string;
  ready: boolean;
}

/** The `<script id="__BOOT__">` payload. Deliberately tiny — only the shell data.
 * The full boot payload still flows through the existing /api/dataset/boot
 * pipeline unchanged; inlining it here is a noted future optimization, not #2444. */
export interface BootEnvelope {
  shell: BootShell;
}

/** The skeleton shell baked into the static (harness-measured) build. */
export const SKELETON_SHELL: BootShell = {
  kpis: { sessions: 0, entries: 0, tokenFiles: 0 },
  version: '',
  ready: false,
};

// --- Derivation -----------------------------------------------------------
function nonNegInt(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Project the real boot payload down to the shell KPIs. Reads exactly the fields
 * the masthead reads today (App.tsx via shellCountsFromBoot): aggregates.sessions,
 * aggregates.events, counts.tokenData. */
export function deriveBootShell(boot: DatasetBoot | null | undefined): BootShell {
  const aggregates = (boot?.aggregates ?? {}) as Record<string, unknown>;
  const counts = (boot?.counts ?? {}) as Record<string, unknown>;
  return {
    kpis: {
      sessions: nonNegInt(aggregates.sessions),
      entries: nonNegInt(aggregates.events),
      tokenFiles: nonNegInt(counts.tokenData),
    },
    version: typeof boot?.version === 'string' ? boot.version : '',
    ready: true,
  };
}

// --- Rendering ------------------------------------------------------------
/** Locale-independent thousands grouping. We do NOT use toLocaleString: the shell
 * string is produced at build time (Node) and runtime (Node) and must be
 * deterministic; a locale-varying separator would make the two diverge. Coerces to
 * a non-negative integer first, so the output is always pure digits+commas — the
 * ONLY dynamic values in the shell markup, so this coercion is also what keeps the
 * shell HTML injection-safe without a general escaper (deriveBootShell already
 * integer-coerces, and BootShell.kpis is typed `number`; this is defense in depth). */
function groupThousands(n: number): string {
  const int = Math.trunc(Math.abs(Number(n) || 0));
  return String(int).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

// Colors/dimensions matched to the real PatternFly v6 masthead + PageSidebar (light
// theme, the parse-time default before the theme useEffect runs) so the flip from
// shell -> real PFLayout is visually seamless — same masthead background (#f2f2f2)
// and text (#151515), the meta line UNDER the brand (left-aligned, as PFLayout
// renders it), a toolbar-button placeholder cluster on the right, and the exact
// 18.125rem sidebar width. (Chrome swap = React removes the whole shell subtree, so
// the cold-load CLS metric is 0 by construction; these numbers protect PERCEIVED
// jank, not the metric.) Verified against the live app's computed masthead styles.
const SHELL_CSS =
  `[data-instant-shell]{min-height:100vh;display:flex;flex-direction:column;` +
  `background:#f0f0f0;color:#151515;` +
  `font-family:'RedHatText','Helvetica Neue',Arial,sans-serif}` +
  `[data-instant-shell] .ish-m{flex:0 0 4.75rem;min-height:4.75rem;display:flex;` +
  `align-items:center;justify-content:space-between;padding:0 1.5rem;` +
  `background:#f2f2f2;border-bottom:1px solid #d2d2d2;box-sizing:border-box}` +
  `[data-instant-shell] .ish-mleft{display:flex;align-items:center;gap:1rem;min-width:0}` +
  `[data-instant-shell] .ish-burger{flex:0 0 auto;width:1.25rem;height:1rem;` +
  `border-top:2px solid #6a6e73;border-bottom:2px solid #6a6e73;` +
  `box-sizing:border-box;opacity:.7}` +
  `[data-instant-shell] .ish-brandblock{display:flex;flex-direction:column;` +
  `gap:.25rem;min-width:0}` +
  `[data-instant-shell] .ish-brand{font-size:1.25rem;font-weight:700;line-height:1.2;` +
  `white-space:nowrap;overflow:hidden;text-overflow:ellipsis}` +
  `[data-instant-shell] .ish-meta{font-size:.875rem;color:#6a6e73;white-space:nowrap;` +
  `overflow:hidden;text-overflow:ellipsis}` +
  `[data-instant-shell] .ish-meta b{font-weight:600;color:#151515}` +
  `[data-instant-shell] .ish-tools{display:flex;gap:.5rem;align-items:center;flex:0 0 auto}` +
  `[data-instant-shell] .ish-tool{width:2rem;height:2rem;border-radius:4px;background:#e0e0e0}` +
  `[data-instant-shell] .ish-body{flex:1 1 auto;display:flex;min-height:0}` +
  `[data-instant-shell] .ish-side{flex:0 0 18.125rem;max-width:18.125rem;background:#fff;` +
  `border-right:1px solid #d2d2d2;padding:1rem 1.5rem;box-sizing:border-box}` +
  `[data-instant-shell] .ish-navbar{height:.75rem;margin:1rem 0;border-radius:3px;` +
  `background:#d2d2d2;opacity:.6}` +
  `[data-instant-shell] .ish-c{flex:1 1 auto;padding:1.5rem;box-sizing:border-box}` +
  `[data-instant-shell] .ish-title{height:2rem;width:60%;max-width:32rem;` +
  `background:#e0e0e0;border-radius:4px;margin-bottom:1.25rem}` +
  `[data-instant-shell] .ish-alert{height:3.25rem;background:#fff;border:1px solid #d2d2d2;` +
  `border-left:3px solid #b8bbbe;border-radius:6px;margin-bottom:1.5rem}` +
  `[data-instant-shell] .ish-tiles{display:flex;gap:1rem;flex-wrap:wrap}` +
  `[data-instant-shell] .ish-tile{flex:1 1 0;min-height:7rem;background:#fff;` +
  `border:1px solid #d2d2d2;border-radius:8px}`;

/** The above-the-fold markup that goes INSIDE the `<div data-instant-shell>`
 * wrapper. Pure string; styling via the scoped `<style>` above (the app CSS bundle
 * is not parsed yet at HTML-parse time, so the shell carries its own CSS). One
 * source of truth for build + runtime; the client never calls this (it re-feeds
 * the captured DOM innerHTML). A KPI value shows as an em-dash until `ready`. The
 * masthead mirrors PFLayout: brand with the meta line beneath it (left-aligned), so
 * the flip does not reposition the counts. */
export function renderShellInner(shell: BootShell): string {
  const { sessions, entries, tokenFiles } = shell.kpis;
  const val = (n: number): string => (shell.ready ? groupThousands(n) : '&mdash;');
  const meta =
    `<div class="ish-meta">` +
    `<b>${val(sessions)}</b> sessions &middot; ` +
    `<b>${val(entries)}</b> entries &middot; ` +
    `<b>${val(tokenFiles)}</b> token files` +
    `</div>`;
  const tool = `<div class="ish-tool"></div>`;
  const navbar = (w: string): string =>
    `<div class="ish-navbar" style="width:${w}"></div>`;
  return (
    `<style>${SHELL_CSS}</style>` +
    `<header class="ish-m">` +
    `<div class="ish-mleft">` +
    `<div class="ish-burger"></div>` +
    `<div class="ish-brandblock">` +
    `<span class="ish-brand">Coding Agent Dashboard</span>` +
    meta +
    `</div></div>` +
    `<div class="ish-tools">${tool}${tool}${tool}${tool}</div>` +
    `</header>` +
    `<div class="ish-body">` +
    `<nav class="ish-side" aria-hidden="true">` +
    navbar('60%') + navbar('80%') + navbar('50%') + navbar('72%') + navbar('64%') +
    `</nav>` +
    `<main class="ish-c">` +
    `<div class="ish-title"></div>` +
    `<div class="ish-alert"></div>` +
    `<div class="ish-tiles"><div class="ish-tile"></div><div class="ish-tile"></div>` +
    `<div class="ish-tile"></div></div>` +
    `</main></div>`
  );
}

/** The full shell region as it sits inside the wrapper: markers + inner markup.
 * Used by build (initial inject) and runtime (replacement). */
export function renderShellRegion(shell: BootShell): string {
  return SHELL_REGION_OPEN + renderShellInner(shell) + SHELL_REGION_CLOSE;
}

// --- Envelope / script serialization -------------------------------------
/** JSON safe to embed in <script type="application/json">: escape `<` so a
 * `</script` or `<!--` in the data can never terminate the element. JSON.parse on
 * the client decodes `<` back to `<` transparently. */
export function serializeBootEnvelope(envelope: BootEnvelope): string {
  return JSON.stringify(envelope).replace(/</g, '\\u003c');
}

export function parseBootEnvelope(text: string | null | undefined): BootEnvelope | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && 'shell' in parsed) {
      return parsed as BootEnvelope;
    }
  } catch {
    /* malformed — treat as no shell */
  }
  return null;
}

/** The boot script element, ready to inline into the template body. */
export function renderBootScript(envelope: BootEnvelope): string {
  return (
    `<script id="${BOOT_SCRIPT_ID}" type="application/json">` +
    serializeBootEnvelope(envelope) +
    `</script>`
  );
}

// --- HTML assembly (build) & rewrite (runtime) ----------------------------
const EMPTY_ROOT = '<div id="root"></div>';

/**
 * BUILD-TIME injection into the raw index.html template. Turns the bare
 * `<div id="root"></div>` into a shell-bearing root and appends the boot script
 * before `</body>`. Idempotent: if a shell is already present, returns html
 * unchanged. Returns null if the empty-root anchor is absent (caller should leave
 * the html untouched and warn — the template changed shape).
 */
export function injectShellIntoTemplate(
  html: string,
  shell: BootShell = SKELETON_SHELL,
): string | null {
  if (html.includes(`${INSTANT_SHELL_ATTR}`)) return html;
  if (!html.includes(EMPTY_ROOT)) return null;
  const withShell = html.replace(
    EMPTY_ROOT,
    `<div id="root"><div ${INSTANT_SHELL_ATTR}>${renderShellRegion(shell)}</div></div>`,
  );
  return withShell.replace(
    '</body>',
    `    ${renderBootScript({ shell })}\n  </body>`,
  );
}

/**
 * RUNTIME rewrite of the built index.html, replacing the skeleton shell region +
 * boot script content with real data. Pure string splice on exact markers / tag
 * boundaries (no regex). If the shell markers are absent (e.g. an sample build served
 * here, or a build without injection), returns html UNCHANGED — a safe no-op, so
 * the server path degrades to the static skeleton rather than erroring.
 */
export function rewriteServedHtml(html: string, shell: BootShell): string {
  // Short-circuit when the shell was never injected (e.g. an spa build served by
  // the server): return the input untouched, so we don't build the shell string
  // on every such request. Build+server inject the shell region and boot script
  // together, so the shell marker's absence implies the boot script's absence too.
  if (html.indexOf(SHELL_REGION_OPEN) < 0) return html;
  let out = spliceBetween(
    html,
    SHELL_REGION_OPEN,
    SHELL_REGION_CLOSE,
    renderShellInner(shell),
  );
  out = spliceBootScript(out, { shell });
  return out;
}

function spliceBetween(html: string, open: string, close: string, inner: string): string {
  const start = html.indexOf(open);
  if (start < 0) return html;
  const innerStart = start + open.length;
  const end = html.indexOf(close, innerStart);
  if (end < 0) return html;
  return html.slice(0, innerStart) + inner + html.slice(end);
}

const BOOT_OPEN_TAG = `<script id="${BOOT_SCRIPT_ID}" type="application/json">`;
const BOOT_CLOSE_TAG = '</script>';

function spliceBootScript(html: string, envelope: BootEnvelope): string {
  const start = html.indexOf(BOOT_OPEN_TAG);
  if (start < 0) return html;
  const innerStart = start + BOOT_OPEN_TAG.length;
  const end = html.indexOf(BOOT_CLOSE_TAG, innerStart);
  if (end < 0) return html;
  return html.slice(0, innerStart) + serializeBootEnvelope(envelope) + html.slice(end);
}
