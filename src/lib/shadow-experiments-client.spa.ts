/**
 * `@shadow-experiments-client` — the public-sample stub (#2152/#2153).
 *
 * `vite build --mode sample` aliases the seam to THIS module
 * instead of `shadow-experiments-client.ts`. It mirrors the real module's
 * exported surface but holds no server URL literals and no `fetch`, so the
 * sample bundle stays provably browser-only. The Shadow Calls view gates on
 * `SERVER_AVAILABLE`, so this is never called on the public path.
 */
import type { ExperimentRow, Gate2702Projection } from './shadow-experiments';

export interface ShadowExperimentsResponse {
  total: number;
  counted: number;
  synthetic: number;
  skipped: number;
  ledgerTruncated: boolean;
  rowsDropped: number;
  offset: number;
  limit: number;
  returned: number;
  rows: ExperimentRow[];
  gate2702?: Gate2702Projection;
}

export async function fetchShadowExperiments(
  options: { limit?: number; offset?: number } = {}
): Promise<ShadowExperimentsResponse> {
  void options; // signature parity with the real client; the sample never fetches
  return {
    total: 0,
    counted: 0,
    synthetic: 0,
    skipped: 0,
    ledgerTruncated: false,
    rowsDropped: 0,
    offset: 0,
    limit: 0,
    returned: 0,
    rows: [],
  };
}
