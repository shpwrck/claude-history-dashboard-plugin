/**
 * fs-free leaf: the reliability-event kind check used by the server-side
 * reliability parser (`parse-telemetry.ts`). It was split out so the browser
 * upload parser (retired with File Upload, epic #3736) could share it (#3613).
 *
 * This lives in its OWN dependency-free leaf — NOT in `parse-telemetry.ts` —
 * on purpose. `parse-telemetry.ts` transitively imports `node:fs` (via
 * `bounded-fs`, which `parseTelemetryDir` needs). A runtime import edge from
 * browser-bundled code into `parse-telemetry.ts` perturbed
 * Rollup's chunking enough to pull that fs graph into a browser VIEW chunk — the
 * `node:fs` `O_RDONLY` constant leaked into the Recommendations render path and
 * the render-smoke e2e failed. (The bundle-size / sample-boundary gates don't catch
 * an fs leak; only render-smoke does.) Keeping the predicate in a pure leaf lets
 * any browser caller import the SAME predicate with no fs edge.
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
 * event". `parse-telemetry.ts`'s `parseTelemetryLine` filters through it, so a
 * `1p_failed_events*.json` that also carries `tengu_exit`/MCP/retry events cannot
 * re-introduce the #3159 totalEvents dilution / retryStormPct depression (#3613).
 * An empty `event_name` is rejected too.
 */
export function isSlowFirstByteEvent(eventName: string): boolean {
  return eventName === SLOW_FIRST_BYTE_EVENT
}
