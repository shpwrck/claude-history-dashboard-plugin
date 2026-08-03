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

/** Durable external-state mutation derived from a full Bash command. */
export type DurableCommandKind =
  | 'remote-state'
  | 'generated-config'
  | 'multi-step-install';

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

/**
 * Compact formatting-churn metrics derived from ONE Edit/MultiEdit call's raw
 * `old_string`/`new_string` bodies before distillation drops them (#2507).
 * Counts and sizes only — no source text is ever retained. A hunk is
 * formatting-only when its ordered nonblank lines are identical after per-line
 * trim (pure reindent / blank-line churn); any internal (semantic-space) or
 * content change disqualifies it. Write is excluded because no local pre-image
 * exists, so formatting-vs-content is unknowable there.
 */
export interface EditFormatChurn {
  /** Hunks analyzed (1 for Edit; `edits.length` for MultiEdit, bounded). */
  hunks: number;
  /** Hunks whose ordered nonblank lines are identical after per-line trim. */
  formattingOnlyHunks: number;
  /** Total raw lines across analyzed hunks (max of old/new per hunk). */
  lines: number;
  /** Raw lines across formatting-only hunks (max of old/new per hunk). */
  formattingOnlyLines: number;
  /** Total old+new chars across analyzed hunks. */
  chars: number;
  /** Old+new chars across formatting-only hunks only — per-hunk truth, so a
   * mixed MultiEdit can never attribute semantic hunks' bytes to formatting. */
  formattingOnlyChars: number;
  /**
   * Analysis stopped at its documented resource boundary; hunks past it are
   * NOT classified. Consumers must treat the call as suppressed evidence,
   * never infer formatting-dominance from a truncated analysis.
   */
  truncated?: true;
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
  /**
   * Sparse proof that a full-file Write matched the leave-behind v1 structure.
   * The parser derives this before discarding the raw markdown content.
   */
  leaveBehindStructure?: 'v1';
  /**
   * Sparse canonical runbook path in a parser-classified unconditional Bash
   * mutation. Derived from the full raw command before bulk ingest strips it;
   * consumers combine it with result success and never reconstruct this proof
   * from the flattened preview.
   */
  leaveBehindMutationPath?: string;
  /** Bounded complete-prefix of canonical runbook paths mutated by one Bash
   * call. Plural truth prevents a multi-target command from leaving stale
   * candidates behind merely because the legacy scalar could hold one path. */
  leaveBehindMutationPaths?: string[];
  /** The parser proved more mutation paths than the bounded persisted array can
   * retain; consumers must treat this call as a project-wide invalidation
   * barrier for earlier candidates. */
  leaveBehindMutationPathsTruncated?: true;
  /** Compact fingerprint for repeat grouping after raw Bash text is stripped. */
  commandFingerprint?: string;
  /** Small redacted-ish display preview; raw command bodies stay out of bulk JSON. */
  commandPreview?: string;
  /**
   * Sparse durable-state classification derived from the FULL command before
   * bulk ingest strips `input.command`. This keeps late command segments
   * observable without retaining the command body.
   */
  commandDurableKind?: DurableCommandKind;
  /**
   * Positive proof that the parser-owned signal boundary was applied. For an
   * ordinary command this means full analysis completed; an oversized command
   * is deliberately failed closed and also carries `commandAnalysisTruncated`.
   * When present, absence of a sparse positive signal such as
   * `commandDurableKind` or `commandRiskyActionPattern` is an analyzed negative,
   * not permission to reclassify a lossy preview or raw upload command.
   */
  commandAnalysisComplete?: true;
  /** Static shell analysis stopped at its documented resource boundary. A
   * successful call is therefore an uncertainty barrier for consumers that
   * make final-state claims from sparse mutation-path evidence. */
  commandAnalysisTruncated?: true;
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
  /**
   * Bounded exact file pathspecs targeted by parser-proven git
   * checkout/restore undo gestures. Derived from the full command before
   * bulk ingest strips it; absence means no exact path attribution is proven.
   */
  commandUndoFilePaths?: string[];
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
   * Canonical dangerous-pattern rules that matched the full raw Bash invocation
   * under the dashboard's conservative direct-prefix matcher. An empty array
   * positively proves that no mapped rule matched in that model; absence means
   * legacy/unknown truth.
   */
  commandDangerousRuleMatches?: string[];
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
  /**
   * Sparse formatting-churn metrics derived from raw Edit/MultiEdit
   * `old_string`/`new_string` bodies before bulk ingest drops them (#2507).
   * Absent for other tools, for malformed inputs (fail-closed suppression),
   * and for every call parsed before this field existed.
   */
  editFormatChurn?: EditFormatChurn;
}

export interface ToolUsageData {
  sessionId: string;
  calls: ToolCall[];
}
