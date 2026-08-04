/**
 * fs-free leaf: the reliability-event kind check, shared by the server-side
 * reliability parser (`parse-telemetry.ts`) and the browser/worker upload parser
 * (`upload-artifacts.ts`) so the two can never drift (#3613).
 *
 * This lives in its OWN dependency-free leaf — NOT in `parse-telemetry.ts` —
 * on purpose. `parse-telemetry.ts` transitively imports `node:fs` (via
 * `bounded-fs`, which `parseTelemetryDir` needs). A runtime import edge from the
 * browser-bundled `upload-artifacts.ts` into `parse-telemetry.ts` perturbed
 * Rollup's chunking enough to pull that fs graph into a browser VIEW chunk — the
 * `node:fs` `O_RDONLY` constant leaked into the Recommendations render path and
 * the render-smoke e2e failed. (The bundle-size / spa-boundary gates don't catch
 * an fs leak; only render-smoke does.) Keeping the predicate in a pure leaf lets
 * both parsers import the SAME predicate with no fs edge from the browser side.
 *
 * The only event type the reliability path is about is the 30s slow-first-byte
 * timeout ceiling. The `1p_failed_events*.json` files also carry `tengu_exit`,
 * retries, MCP results, etc.; those are NOT reliability failures and must not
 * enter the retry-storm denominator (#3159). The `tengu_exit` latency path keys
 * on its own event separately.
 */
export const SLOW_FIRST_BYTE_EVENT = 'tengu_api_slow_first_byte'

/**
 * Single source of truth for "is this NDJSON line the slow-first-byte reliability
 * event". BOTH `parse-telemetry.ts`'s `parseTelemetryLine` and
 * `upload-artifacts.ts`'s upload parser filter through this one predicate so they
 * can never drift: an uploaded bundle whose `1p_failed_events*.json` also carries
 * `tengu_exit`/MCP/retry events is filtered identically to the live mount, and
 * uploaded telemetry can never re-introduce the #3159 totalEvents dilution /
 * retryStormPct depression (#3613). An empty `event_name` is rejected too.
 */
export function isSlowFirstByteEvent(eventName: string): boolean {
  return eventName === SLOW_FIRST_BYTE_EVENT
}
