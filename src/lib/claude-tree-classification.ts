// The ONE canonical claude-tree-classification (ADR 0009 invariant): every ~/.claude relative path
// maps to exactly one of config | session-data | secret. The config bake consumes `config`, the
// session-data shipper consumes `session-data`, and BOTH refuse `secret`. This is the single home of
// the `.credentials*` / `paste-cache/` exclusion — a misroute here would either exfiltrate the OAuth
// refresh token into the artifact store or silently drop a reliability signal, so there is exactly
// one classifier, not one per consumer.
//
// The session-data shipper (operator/dispatch, a zero-dep .mjs in a separate image) mirrors this
// byte-for-byte; a drift test guards the two copies (the same pattern as provision-naming).

export type ClaudePathClass = 'config' | 'session-data' | 'secret';

// secret — never baked, never shipped, never accepted by ingest. Checked FIRST so a credential file
// anywhere in the tree is denied regardless of where it sits.
const SECRET_RE: RegExp[] = [
  /(^|\/)\.credentials(\.|\/|$)/i, // .credentials.json, .credentials/
  /(^|\/)paste-cache(\/|$)/i,
  /(^|\/)\.ssh(\/|$)/i,
  /\.(pem|key|p12|pfx)$/i,
];

// session-data — the session-generated artifacts the dashboard parses (transcripts + the out-of-band
// telemetry/debug/stats/file-history/todos that feed the reliability detectors + Agent Report Card).
const SESSION_DATA_RE: RegExp[] = [
  /(^|\/)projects(\/|$)/i,
  /(^|\/)history\.jsonl$/i,
  /(^|\/)history\.d(\/|$)/i, // per-session history parts (collision-free shipping)
  /(^|\/)telemetry(\/|$)/i,
  /(^|\/)debug(\/|$)/i,
  /(^|\/)stats-cache\.json$/i,
  /(^|\/)file-history(\/|$)/i,
  /(^|\/)todos(\/|$)/i,
];

// Normalize a relative path for matching: drop a leading ./, use forward slashes, no trailing slash.
function norm(relPath: string): string {
  return String(relPath)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

export function classifyClaudePath(relPath: string): ClaudePathClass {
  const p = norm(relPath);
  for (const re of SECRET_RE) if (re.test(p)) return 'secret';
  for (const re of SESSION_DATA_RE) if (re.test(p)) return 'session-data';
  return 'config';
}

export function isSessionData(relPath: string): boolean {
  return classifyClaudePath(relPath) === 'session-data';
}
