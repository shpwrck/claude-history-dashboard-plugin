/**
 * Shared formatting helpers used by multiple view components.
 *
 * Centralised here so each view doesn't carry its own copy.
 */

/**
 * Format a USD amount.
 *
 * Sub-cent values get four decimals so a long tail of small charges doesn't
 * all read as `$0.00`. Normal values use two decimals.
 */
export function formatUSD(n: number): string {
  if (!isFinite(n)) return '$0.00';
  if (n > 0 && n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

/**
 * Shorten a project path for compact display.
 *
 * `/home/<user>/some/long/path/repo` becomes `~/some/.../repo`. Paths short
 * enough to display whole are returned with the home-dir prefix collapsed but
 * otherwise intact.
 */
export function shortenProject(project: string): string {
  const home = project.replace(/^\/home\/[^/]+\//, '~/');
  const parts = home.split('/');
  if (parts.length <= 3) return home;
  return parts.slice(0, 2).join('/') + '/.../' + parts[parts.length - 1];
}

/**
 * Render an ISO timestamp as a local `HH:MM:SS` clock string.
 *
 * Returns `--:--:--` for unparseable input.
 */
export function formatClock(timestamp: string): string {
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return '--:--:--';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

/**
 * Truncate a string to `max` characters with a MIDDLE ellipsis, so both the
 * start and end stay legible (`compound-engi…reviewer`, `~/proj…dashboard`).
 * Returns the input unchanged when it already fits.
 */
export function truncateMiddle(s: string, max: number): string {
  if (max <= 1 || s.length <= max) return s;
  const keep = max - 1; // one char for the ellipsis
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return s.slice(0, head) + '…' + (tail > 0 ? s.slice(s.length - tail) : '');
}

/**
 * Build a chart tick-label formatter that middle-truncates category-axis
 * labels so long strings (file paths, tool names, project names, agent types)
 * fit the chart's reserved label gutter instead of clipping at the edge. Size
 * `max` to the chart's left padding (~1 char per 5 px at fontSize 9). #457.
 */
export function truncateTick(max: number): (t: unknown) => string {
  return (t: unknown) => truncateMiddle(String(t), max);
}

/**
 * Render a token count with K/M/B/T suffixes.
 *
 * Keeps the one-fixed-decimal style callers depend on (`1.0M`, not `1M`), but
 * carries the same suffix scheme as `formatMetric` so the two compactors no
 * longer drift at billions (#795): a multi-billion total now reads `4.8B`
 * instead of `4813.9M`.
 *
 * 1_234_567 -> `1.2M`; 1_234 -> `1.2K`; 4_813_900_000 -> `4.8B`; 42 -> `42`.
 */
export function formatTokens(n: number): string {
  if (n >= 1_000_000_000_000) return `${(n / 1_000_000_000_000).toFixed(1)}T`;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

/**
 * Render any count compactly with a BOUNDED output length, so a headline metric
 * value always fits its card without overflowing or being clipped (#792).
 *
 * Counts get K/M/B/T suffixes; the magnitude carries at most one decimal place,
 * and that decimal is dropped once the scaled value reaches 100 (`123K`, not
 * `123.5K`) or is a whole number (`1K`, not `1.0K`). Negatives keep their sign.
 * The exact, un-rounded value should be surfaced via a `title` tooltip at the
 * call site.
 *
 *   42 -> `42`; 1_000 -> `1K`; 1_234 -> `1.2K`; 1_234_567 -> `1.2M`;
 *   2_500_000_000 -> `2.5B`.
 *
 * Output is at most six characters for any finite input below 1e15 — the width
 * the metric-card layout and its CI gate (#793) are sized against. Unlike
 * `formatTokens` (one fixed decimal), this never expands a large number to its
 * full `toLocaleString()` form, which is what was overflowing the cards.
 */
export function formatMetric(n: number): string {
  if (!isFinite(n)) return '0';
  const neg = n < 0;
  const abs = Math.abs(n);

  let out: string;
  if (abs < 1_000) {
    out = String(Math.round(abs));
  } else {
    const units = [
      { v: 1e12, s: 'T' },
      { v: 1e9, s: 'B' },
      { v: 1e6, s: 'M' },
      { v: 1e3, s: 'K' },
    ];
    const idx = units.findIndex((x) => abs >= x.v);
    const u = idx === -1 ? units[units.length - 1] : units[idx];
    const scaled = abs / u.v;
    // One decimal below 100 (`1.2K`), whole above it (`123K`); drop a trailing
    // `.0` so 1_000 reads `1K`, not `1.0K`.
    let rounded = scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
    let suffix = u.s;
    // Rounding can push a value just under a boundary up to 1000 (999_999 -> a
    // raw 999.999 -> rounds to 1000). Promote it into the next unit so it reads
    // `1M`, not `1000K` — unless we're already at the top unit.
    if (rounded >= 1000 && idx > 0) {
      rounded /= 1000;
      suffix = units[idx - 1].s;
    }
    out = `${rounded}${suffix}`;
  }

  return neg ? `-${out}` : out;
}
