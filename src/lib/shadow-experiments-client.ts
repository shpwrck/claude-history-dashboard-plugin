/**
 * Client for GET /api/shadow-experiments.json (#2152/#2153) — the SERVER build.
 *
 * A SECOND mode-swapped seam beside `@api-client`, split out for the frozen
 * first-paint shell budget (ADR 0016, #2371): `api-client.ts` is imported
 * eagerly by the app shell, so every byte added there lands in the frozen
 * `index` chunk. This fetcher is consumed only by the lazy Shadow Calls chunk,
 * so it lives in its own module that the lazy chunk imports via the
 * `@shadow-experiments-client` alias — `vite build --mode sample` swaps in
 * `shadow-experiments-client.spa.ts` (no URL literals, no fetch), keeping the
 * public-sample boundary provable exactly like the main chokepoint.
 */
import { serverFetch } from '@api-client';
import type { ExperimentRow, Gate2702Projection } from './shadow-experiments';

/**
 * Wire shape of GET /api/shadow-experiments.json: the flat per-experiment row
 * log with every bound surfaced (`ledgerTruncated`, `rowsDropped`), paginated
 * newest-first. `counted`/`synthetic`/`skipped` are WHOLE-LEDGER counts, so
 * they reconcile to `total` even when `rows` is a bounded window.
 */
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
  /** Verified, bounded C5 summaries; absent when no #2702 state root was found. */
  gate2702?: Gate2702Projection;
}

const EMPTY: ShadowExperimentsResponse = {
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

/**
 * Fetch the per-experiment drill-down rows (#2153). Never rejects — a transient
 * failure collapses to the zero response so the view shows its empty state.
 * Delegates to api-client's serverFetch so auth/headers/failure behavior stay
 * owned by the one chokepoint; only the URL literal lives here (for the SPA
 * swap) and only the bytes live in the lazy chunk (for the shell budget).
 */
export async function fetchShadowExperiments(
  options: { limit?: number; offset?: number } = {}
): Promise<ShadowExperimentsResponse> {
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set('limit', String(options.limit));
  if (options.offset !== undefined) query.set('offset', String(options.offset));
  const qs = query.toString();
  try {
    const res = await serverFetch(`/api/shadow-experiments.json${qs ? `?${qs}` : ''}`);
    if (!res.ok) return { ...EMPTY };
    return (await res.json()) as ShadowExperimentsResponse;
  } catch {
    return { ...EMPTY };
  }
}
