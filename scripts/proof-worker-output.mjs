// Bounded, incremental collector for a jailed proof worker's stdout/stderr
// (#3098), extracted from proof-batch.mjs runWorker so it is testable without
// spawning a real srt-jailed worker.
//
// The old runWorker appended EVERY stdout/stderr byte to a string with no cap,
// then at close `stdout.split('\n')` re-materialized the whole transcript and
// walked it twice (once for the last result line, once to count stable-file
// reads). A runaway or hostile worker could therefore pin memory to the full
// output size, and the end-of-run re-split doubled it transiently.
//
// This collector instead parses the NDJSON stream incrementally as chunks
// arrive, retaining only what the caller actually needs:
//   - the last parseable object and the last `type:"result"` object (the cost /
//     usage summary),
//   - a running adherence counter (tool_use blocks that reference a stable
//     path — the #2083 proxy, folded in so the stream is walked ONCE),
//   - a bounded stderr tail,
// and it trips an over-budget flag once total stdout passes a documented byte
// ceiling so the caller can terminate and mark the run unresolved. Pure string /
// JSON work only — no `.ts` imports — so proof-batch.test.mjs (run without the
// register-ts hook) can drive it directly.

/** Parse a non-negative-int env override, else fall back. */
function envInt(name, fallback) {
  const raw = process.env[name];
  const parsed = raw == null || raw === '' ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Per-worker stdout byte budget (#3098). A stream-json coding session emits at
 * most a few MiB of NDJSON; 64 MiB is generous headroom while still bounding a
 * worker that never stops writing. Overridable via
 * PROOF_WORKER_STDOUT_MAX_BYTES.
 */
export const PROOF_WORKER_STDOUT_MAX_BYTES = envInt(
  'PROOF_WORKER_STDOUT_MAX_BYTES',
  64 * 1024 * 1024
);

/** How many trailing stderr bytes to retain for diagnostics. */
export const PROOF_WORKER_STDERR_TAIL_BYTES = envInt(
  'PROOF_WORKER_STDERR_TAIL_BYTES',
  8 * 1024
);

/**
 * Create an incremental output collector for one worker.
 *
 * @param {object} opts
 * @param {string[]} [opts.stablePaths] Stable paths whose tool_use references
 *   are counted (the adherence proxy).
 * @param {number} [opts.stdoutBudgetBytes] Total stdout ceiling before the run
 *   is flagged over-budget.
 * @param {number} [opts.stderrTailBytes] Retained stderr tail size.
 */
export function createWorkerOutputCollector({
  stablePaths = [],
  stdoutBudgetBytes = PROOF_WORKER_STDOUT_MAX_BYTES,
  stderrTailBytes = PROOF_WORKER_STDERR_TAIL_BYTES,
} = {}) {
  let totalStdoutBytes = 0;
  let overBudget = false;
  let lineBuf = '';
  let sawParsedLine = false;
  // Retained ONLY until the first line parses as NDJSON, and only up to this
  // size — the fallback for a single-object `--output-format json` build whose
  // whole output is one (small) JSON object with no per-line structure.
  let singleObjectBuf = '';
  const singleObjectMax = Math.min(stdoutBudgetBytes, 4 * 1024 * 1024);
  let lastParsedText = null;
  let lastParsedObj = null;
  let lastResultText = null;
  let lastResultObj = null;
  let stableReads = 0;
  let stderrTail = '';

  const paths = (stablePaths ?? []).filter(Boolean);

  function countStable(obj) {
    if (paths.length === 0) return;
    const content = obj?.message?.content ?? obj?.content;
    if (!Array.isArray(content)) return;
    for (const b of content) {
      if (!b || b.type !== 'tool_use') continue;
      const s = JSON.stringify(b.input ?? {});
      if (paths.some((p) => s.includes(p))) stableReads++;
    }
  }

  function processLine(raw) {
    const line = raw.trim();
    if (!line) return;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      return; // verbose preamble / non-JSON line
    }
    if (!obj || typeof obj !== 'object') return;
    // NDJSON confirmed: drop the single-object fallback buffer so retained
    // memory is just the last line(s) + counters from here on.
    sawParsedLine = true;
    singleObjectBuf = '';
    lastParsedObj = obj;
    lastParsedText = line;
    if (obj.type === 'result') {
      lastResultObj = obj;
      lastResultText = line;
    }
    countStable(obj);
  }

  return {
    pushStdout(chunk) {
      if (overBudget) return;
      const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      totalStdoutBytes += Buffer.byteLength(str, 'utf8');
      if (totalStdoutBytes > stdoutBudgetBytes) {
        // Stop retaining anything further; the run is unresolved regardless.
        overBudget = true;
        lineBuf = '';
        singleObjectBuf = '';
        return;
      }
      if (!sawParsedLine && singleObjectBuf.length <= singleObjectMax) {
        singleObjectBuf += str;
        if (singleObjectBuf.length > singleObjectMax) singleObjectBuf = '';
      }
      lineBuf += str;
      let idx;
      while ((idx = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        processLine(line);
      }
      // A single unterminated line must not grow without bound either.
      if (Buffer.byteLength(lineBuf, 'utf8') > stdoutBudgetBytes) {
        overBudget = true;
        lineBuf = '';
        singleObjectBuf = '';
      }
    },

    pushStderr(chunk) {
      const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      stderrTail = (stderrTail + str).slice(-stderrTailBytes);
    },

    isOverBudget: () => overBudget,
    stderrTail: () => stderrTail,

    /**
     * Bytes currently retained from stdout — the assertion surface for the
     * memory-bound probe. Stays a small multiple of the last line even after
     * arbitrarily large input.
     */
    retainedStdoutBytes() {
      return (
        Buffer.byteLength(lineBuf, 'utf8') +
        Buffer.byteLength(singleObjectBuf, 'utf8') +
        (lastParsedText ? Buffer.byteLength(lastParsedText, 'utf8') : 0) +
        (lastResultText ? Buffer.byteLength(lastResultText, 'utf8') : 0)
      );
    },

    /**
     * Finalize after the stream closed. Returns `{ overBudget: true }` when the
     * budget was tripped, else `{ overBudget: false, cj, selectedResultText,
     * stableReads }` where `cj` is the chosen result object (last `result` line,
     * else last parseable object, else the single-object fallback), or null when
     * nothing parsed.
     */
    finalize() {
      if (overBudget) return { overBudget: true };
      if (lineBuf) {
        processLine(lineBuf);
        lineBuf = '';
      }
      let cj = lastResultObj ?? lastParsedObj;
      let selectedResultText = lastResultText ?? lastParsedText;
      if (!cj && !sawParsedLine) {
        const trimmed = singleObjectBuf.trim();
        if (trimmed) {
          try {
            const o = JSON.parse(trimmed);
            if (o && typeof o === 'object') {
              cj = o;
              selectedResultText = trimmed;
              countStable(o);
            }
          } catch {
            /* give up */
          }
        }
      }
      return { overBudget: false, cj, selectedResultText, stableReads };
    },
  };
}
