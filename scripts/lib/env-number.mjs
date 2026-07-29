// Fail-closed numeric env parsing for benchmark / gate scripts (#3076).
//
// The bug this exists to make unrepresentable: `Number(process.env.X || '2')`
// turns an operator typo into `NaN`, and EVERY comparison against `NaN` is
// false — so a threshold gate prints its verdict, exits 0, and has compared
// against nothing. `parseInt` hides the same shape differently: it reads
// `'12g'` as `12`, silently benchmarking a corpus 32x smaller than the one that
// was asked for. Both failures are invisible in the exit code, which is exactly
// what makes them expensive: the number they produce still looks like a number.
//
// The rule here has no third outcome, so no value can quietly mean something
// other than what it says:
//
//   - UNSET or empty/whitespace-only -> the caller's documented default.
//   - anything the operator actually SET -> must parse to a finite number
//     inside the declared range (and be an integer when `integer` is set), or
//     this throws and the caller stops.
//
// Deliberately NOT clamping: silently pulling an out-of-range request back to a
// bound is the same class of lie as `NaN` — the run reports a number the
// operator never asked for. Out of range is an error.

/** Thrown when an env var is set to a value that is not a usable number. */
export class EnvNumberError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EnvNumberError';
  }
}

/**
 * Parse `env[name]` as a bounded finite number, failing closed.
 *
 * @param {string} name             env var name (used in the error message)
 * @param {object} spec
 * @param {number} spec.fallback    value used when the var is unset/empty
 * @param {number} [spec.min]       inclusive lower bound. Pass
 *                                  `Number.MIN_VALUE` to mean "strictly
 *                                  positive" — it is the smallest positive
 *                                  double, so `0` and every negative fail it.
 * @param {number} [spec.max]       inclusive upper bound
 * @param {boolean} [spec.integer]  require an integer
 * @param {Record<string, string|undefined>} [env]
 * @returns {number}
 * @throws {EnvNumberError} when the var is set to anything else
 */
export function envNumber(name, spec, env = process.env) {
  const { fallback, min = -Infinity, max = Infinity, integer = false } = spec;
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;

  const text = String(raw).trim();
  const value = Number(text);
  const expected = `${integer ? 'an integer' : 'a finite number'} in [${min}, ${max}]`;

  if (!Number.isFinite(value)) {
    throw new EnvNumberError(
      `${name}=${JSON.stringify(raw)} is not a finite number (expected ${expected})`
    );
  }
  if (integer && !Number.isInteger(value)) {
    throw new EnvNumberError(
      `${name}=${JSON.stringify(raw)} is not an integer (expected ${expected})`
    );
  }
  if (value < min || value > max) {
    throw new EnvNumberError(
      `${name}=${JSON.stringify(raw)} is out of range (expected ${expected})`
    );
  }
  return value;
}
