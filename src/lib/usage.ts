/**
 * Types for the live plan-usage gauge (#130).
 *
 * The browser-side fetch (`fetchUsage`) lives in `api-client.ts` (#324) so the
 * `/api/usage` literal is owned by the single server chokepoint and stays out of
 * the SPA bundle. This module is now types-only; importers pull the `Usage`
 * shapes from here and `fetchUsage` from `@api-client`.
 */

/** One rolling-window snapshot, mirroring the server's parseUsageWindow(). */
export interface UsageWindow {
  /** 0–1 fraction of the window consumed (the header is already a fraction). */
  utilization: number;
  /** Unix seconds at which the window resets, or null when absent. */
  reset: number | null;
  /** Raw status token (e.g. 'allowed' | 'warning' | 'rejected') or null. */
  status: string | null;
}

/** Overage (billed-beyond-plan) snapshot, when the plan is in overage. */
export interface UsageOverage {
  inUse: true;
  /** 0–1 fraction of the overage allowance consumed, or null when absent. */
  utilization: number | null;
}

/** The `available: true` shape from `/api/usage`. */
export interface UsageAvailable {
  available: true;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  overage: UsageOverage | null;
  /** Which window is currently binding (e.g. 'five_hour' | 'seven_day'). */
  representativeClaim: string | null;
}

/** The degraded shape: no credential, no token, no headers, or a fetch error. */
export interface UsageUnavailable {
  available: false;
  /**
   * Why the gauge can't render. 'not-logged-in' | 'auth-failed' | 'no-headers'
   * | 'fetch-failed' from the server; 'client-error' when the browser fetch
   * itself failed before reaching a usable response.
   */
  reason: string;
}

export type Usage = UsageAvailable | UsageUnavailable;
