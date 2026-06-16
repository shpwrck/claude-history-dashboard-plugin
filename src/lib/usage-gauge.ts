// Plan-limit usage gauge core for GET /api/usage (#130), extracted from
// scripts/server.mjs (#626, epic #622). The cross-CLI-version credential walk,
// the unified rate-limit header parsing, and the payload assembly were
// HTTP-only-testable and the credential search is fragile across Claude Code
// versions — so they deserve direct unit tests. The route keeps the one piece
// that can't be pure: reading the credential file and making the throwaway ping
// through the server LLM egress chokepoint. Everything here is pure and
// byte-identical to the prior inline implementation.

// The Claude subscription OAuth access token carries the `sk-ant-oat` (OAuth
// Access Token) prefix — distinct from other OAuth blocks now present in
// ~/.claude/.credentials.json (e.g. `mcpOAuth`, which also nests an
// `accessToken` but is an MCP-server credential that Anthropic rejects with 401).
const CLAUDE_OAUTH_PREFIX = 'sk-ant-oat';

// Walk the credential tree collecting every `*accessToken`-ish string along with
// the key of the block that holds it (e.g. `claudeAiOauth`, `mcpOAuth`), so a
// caller can rank candidates instead of taking whichever DFS hits first.
function collectAccessTokens(
  node: unknown,
  parentKey = ''
): { value: string; parentKey: string }[] {
  if (!node || typeof node !== 'object') return [];
  const out: { value: string; parentKey: string }[] = [];
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (/access.?token/i.test(key) && typeof value === 'string') {
      out.push({ value, parentKey });
    } else if (value && typeof value === 'object') {
      out.push(...collectAccessTokens(value, key));
    }
  }
  return out;
}

// The token's exact nesting has shifted across Claude Code versions, so search
// for any *accessToken-ish key rather than hard-coding a path (mirrors
// findAccessToken in ~/.claude/skills/session-usage/scripts/check-usage.mjs).
//
// #1712: a plain "first accessToken-ish key wins" DFS is wrong once the file
// holds more than one OAuth block — `mcpOAuth` sorts before `claudeAiOauth`, so
// the naive walk returned an MCP token and every usage ping 401'd. Rank the
// candidates: a `sk-ant-oat`-prefixed token (the Claude subscription credential)
// wins regardless of position; then a token whose enclosing block name mentions
// "claude"; then the legacy first-found fallback for cross-version resilience.
export function findAccessToken(node: unknown): string | null {
  const candidates = collectAccessTokens(node);
  if (!candidates.length) return null;
  const claudePrefixed = candidates.find((c) => c.value.startsWith(CLAUDE_OAUTH_PREFIX));
  if (claudePrefixed) return claudePrefixed.value;
  const claudeBlock = candidates.find((c) => /claude/i.test(c.parentKey));
  if (claudeBlock) return claudeBlock.value;
  return candidates[0].value;
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
