// Plan-limit usage gauge core for GET /api/usage (#130), extracted from
// scripts/server.mjs (#626, epic #622). The cross-CLI-version credential walk,
// the unified rate-limit header parsing, and the payload assembly were
// HTTP-only-testable and the credential search is fragile across Claude Code
// versions — so they deserve direct unit tests. The route keeps the one piece
// that can't be pure: reading the credential file and making the throwaway ping
// through the server LLM egress chokepoint. Everything here is pure and
// byte-identical to the prior inline implementation.

// The token's exact nesting has shifted across Claude Code versions, so search
// for any *accessToken-ish key rather than hard-coding a path (mirrors
// findAccessToken in ~/.claude/skills/session-usage/scripts/check-usage.mjs).
export function findAccessToken(node: unknown): string | null {
  if (!node || typeof node !== 'object') return null;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (/access.?token/i.test(key) && typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      const found = findAccessToken(value);
      if (found) return found;
    }
  }
  return null;
}

export type UsageWindow = {
  utilization: number;
  reset: number | null;
  status: string | null;
};

// Parse one unified rate-limit window's headers into the shape the client maps.
// `utilization` is a 0–1 float (the headers are already fractions), `reset` is
// unix seconds, `status` is the raw status token (e.g. 'allowed'/'warning'/
// 'rejected') or null. Returns null when the utilization header is absent.
export function parseUsageWindow(
  h: Record<string, string>,
  prefix: string,
): UsageWindow | null {
  const rawUtil = h[`${prefix}-utilization`];
  if (rawUtil === undefined) return null;
  const utilization = Number(rawUtil);
  if (!Number.isFinite(utilization)) return null;
  const rawReset = h[`${prefix}-reset`];
  const reset = rawReset === undefined ? null : Number(rawReset);
  const status = h[`${prefix}-status`] ?? null;
  return {
    utilization,
    reset: Number.isFinite(reset) ? reset : null,
    status,
  };
}

export type UsageOverage = { inUse: true; utilization: number | null };

export type UsagePayload =
  | { available: false; reason: 'auth-failed' | 'no-headers' }
  | {
      available: true;
      fiveHour: UsageWindow | null;
      sevenDay: UsageWindow | null;
      overage: UsageOverage | null;
      representativeClaim: string | null;
    };

// Build the client payload from the scraped short-key rate-limit headers (`h`)
// and the ping's HTTP status. With neither window present the ping didn't carry
// usage headers — auth-failed on 401/403, else no-headers. Otherwise report the
// windows plus any active overage and the representative-claim hint. Pure: the
// route does the credential read + network ping + header scrape; this turns the
// result into the response body.
export function buildUsagePayload(
  h: Record<string, string>,
  status: number,
): UsagePayload {
  const fiveHour = parseUsageWindow(h, '5h');
  const sevenDay = parseUsageWindow(h, '7d');

  if (!fiveHour && !sevenDay) {
    const reason = status === 401 || status === 403 ? 'auth-failed' : 'no-headers';
    return { available: false, reason };
  }

  const overage: UsageOverage | null =
    h['overage-in-use'] === 'true'
      ? {
          inUse: true,
          utilization: Number.isFinite(Number(h['overage-utilization']))
            ? Number(h['overage-utilization'])
            : null,
        }
      : null;

  return {
    available: true,
    fiveHour,
    sevenDay,
    overage,
    representativeClaim: h['representative-claim'] ?? null,
  };
}
