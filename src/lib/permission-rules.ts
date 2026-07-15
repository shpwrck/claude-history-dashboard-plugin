/**
 * Dependency-free conservative permission-rule parsing and matching.
 *
 * Parsers use this leaf while deriving compact truth from full Bash command
 * bodies; detectors re-export the same helpers from their shared module. Keep
 * this file free of parser and detector imports so parse-time derivation cannot
 * create a dependency cycle. This models the repository's direct-prefix subset,
 * not Claude Code's full wildcard, compound-command, or wrapper semantics.
 */

export interface PermRule {
  tool: string;
  /** null = bare `Tool` rule (matches any use of the tool). */
  specifier: string | null;
}

export function parsePermRule(rule: string): PermRule {
  const m = /^([A-Za-z][\w-]*)\((.*)\)$/.exec(rule.trim());
  if (m) return { tool: m[1], specifier: m[2] };
  return { tool: rule.trim(), specifier: null };
}

/** Bash specifier -> its literal prefix and whether it is a prefix (`:*`) match. */
export function bashSpec(specifier: string): {
  literal: string;
  prefix: boolean;
} {
  if (specifier.endsWith(':*')) {
    return { literal: specifier.slice(0, -2).trim(), prefix: true };
  }
  return { literal: specifier.trim(), prefix: false };
}

/**
 * Does a recorded tool call match a permission rule? Returns `null` when the
 * rule cannot be evaluated confidently. Raw `input.command` is authoritative;
 * `commandPreview` remains available for legacy detector callers, but must not
 * be used to derive persisted coverage truth.
 */
export function permRuleMatchesCall(
  rule: string,
  call: { toolName: string; input: { command?: string }; commandPreview?: string }
): boolean | null {
  const { tool, specifier } = parsePermRule(rule);
  if (call.toolName !== tool) return false;
  if (specifier === null) return true;
  if (tool === 'Bash') {
    const cmd =
      typeof call.input?.command === 'string'
        ? call.input.command.trim()
        : call.commandPreview?.trim() ?? '';
    if (!cmd) return false;
    const { literal, prefix } = bashSpec(specifier);
    return prefix
      ? cmd === literal || cmd.startsWith(literal + ' ')
      : cmd === literal;
  }
  return null;
}

/** Is `allow` fully shadowed by `deny`? */
export function allowShadowedByDeny(allow: string, deny: string): boolean {
  const A = parsePermRule(allow);
  const D = parsePermRule(deny);
  if (A.tool !== D.tool) return false;
  if (D.specifier === null) return true;
  if (A.specifier === null) return false;
  if (A.tool === 'Bash') {
    const a = bashSpec(A.specifier);
    const d = bashSpec(D.specifier);
    if (d.prefix) {
      return a.literal === d.literal || a.literal.startsWith(d.literal + ' ');
    }
    return !a.prefix && a.literal === d.literal;
  }
  return A.specifier === D.specifier;
}
