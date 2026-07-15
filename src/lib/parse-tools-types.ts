/**
 * Leaf type module for the tool-call parser graph (#1582).
 *
 * `parse-tools.ts` imports VALUES from `parse-permissions.ts` (the dangerous- and
 * risky-command classifiers it precomputes per call), and `parse-permissions.ts`
 * imported the `ToolUsageData` TYPE back from `parse-tools.ts` (`import type`),
 * closing a runtime-erased madge cycle. The tangle is structural: `ToolCall` also
 * carries a `DangerousCommandCertainty`, a type owned by `parse-permissions`.
 *
 * Hoisting both sides' shared shapes into this dependency-free leaf lets each
 * module import the type from a non-cyclic path. `parse-tools.ts` and
 * `parse-permissions.ts` re-export the relevant types, so every existing importer
 * is unaffected, with zero runtime change (the back-edge was already `import
 * type`). This file imports nothing, so it stays a true leaf.
 */

/** Certainty that a Bash command is dangerous (target-aware for `rm -rf`). */
export type DangerousCommandCertainty = 'high' | 'medium';

/**
 * Categories of shell command that re-implement a first-class Claude tool.
 * Using the native tool is cheaper (no shell spin-up / output streaming) and
 * goes through permission integration, so each detected use is a nudge.
 */
export type BypassCategory = 'grep' | 'find' | 'cat' | 'sed' | 'awk' | 'cd';

/**
 * Distilled tool-call `input`. The raw `call.input` blob is the single largest
 * contributor to the dataset payload (file contents, full command bodies, MCP
 * argument blobs), but only a handful of small sub-fields are ever read
 * client-side. Session-detail rows keep those fields under the same names, but
 * the bulk dataset strips `input.command` after deriving compact Bash command
 * signals. Any field not listed here is intentionally dropped on the wire.
 */
export interface DistilledToolInput {
  command?: string;
  file_path?: string;
  subagent_type?: string;
  skill?: string;
}

export interface ToolCall {
  timestamp: string;
  toolName: string;
  input: DistilledToolInput;
  toolUseId: string;
  isError: boolean | null;
  /**
   * Size of the tool_result content in characters, used as a cheap proxy for
   * how many tokens the result consumed (no actual token count is available
   * per tool_result on the wire). 0 when no result was seen or it was empty.
   * Additive field — see cost-attribution's token-weighted attribution.
   */
  resultBytes: number;
  /** Compact fingerprint for repeat grouping after raw Bash text is stripped. */
  commandFingerprint?: string;
  /** Small redacted-ish display preview; raw command bodies stay out of bulk JSON. */
  commandPreview?: string;
  /** First executable token after leading env assignments. */
  commandHead?: string;
  /**
   * True only when `commandHead` is also the exact raw Bash permission prefix
   * (`cmd === head || cmd.startsWith(head + ' ')`). Precomputed before bulk
   * ingest strips the raw command because `commandPreview` flattens newlines and
   * cannot prove permission-rule coverage losslessly.
   */
  commandHeadIsPermissionPrefix?: true;
  /** Git-related command segments needed by workflow detectors after stripping. */
  commandGitSegments?: string[];
  /** Precomputed native-tool-bypass categories for Bash commands. */
  commandBypassCategories?: BypassCategory[];
  /**
   * Exact executable aliases that produced each native-tool-bypass category.
   * Derived from the full Bash command before bulk ingest strips `input.command`,
   * including aliases behind wrappers/assignments and later shell-chain segments.
   */
  commandBypassAliases?: Partial<Record<BypassCategory, string[]>>;
  /** First dangerous-command pattern matched by the Bash command, if any. */
  commandDangerousPattern?: string;
  /**
   * Precomputed dangerous-command certainty (target-aware for `rm -rf`), derived
   * from the FULL command at parse time so it survives raw-body stripping (#2036).
   * Consumers (detectDangerousCommands) must prefer this over recomputing from the
   * truncated `commandPreview`, which can't see a `rm -rf <target>` buried past it.
   */
  commandDangerousCertainty?: DangerousCommandCertainty;
  /**
   * Precomputed display fragment centered on the dangerous match (e.g.
   * `rm -rf <target>`) so cited evidence isn't a misleading leading `cd …`/`mkdir`
   * prefix once the raw body is dropped (#2036).
   */
  commandDangerousFragment?: string;
  /** First high-impact action pattern matched by the Bash command, if any. */
  commandRiskyActionPattern?: string;
  /** Whether the command references Claude-specific paths such as `.claude`. */
  commandMentionsClaudePath?: boolean;
}

export interface ToolUsageData {
  sessionId: string;
  calls: ToolCall[];
}
