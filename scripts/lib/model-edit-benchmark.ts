/**
 * Host-only mutation + scoring mechanics for the structured-edit corpus.
 *
 * Keep npm-heavy Babel/Prettier/diff imports out of the dependency-free
 * receipt contract in `src/lib/structured-edit-eval.ts`, which the server-side
 * model-pin savings slice may consume later.
 */

import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { parse } from '@babel/parser';
import traverseModule, { type NodePath } from '@babel/traverse';
import type {
  BinaryExpression,
  BooleanLiteral,
  LogicalExpression,
  Node,
  TemplateElement,
} from '@babel/types';
import { diffLines } from 'diff';
import { format, type BuiltInParserName, type Options as PrettierOptions } from 'prettier';
import type {
  AppliedStructuredEditMutation,
  StructuredEditMutationKind,
  StructuredEditMutationSpec,
  StructuredEditScore,
} from '../../src/lib/structured-edit-eval';

// Babel 7's CommonJS export is unwrapped by Vite but arrives as
// `{ default: fn }` through the repo's lightweight Node TS loader.
const traverse = (
  typeof traverseModule === 'function'
    ? traverseModule
    : (traverseModule as unknown as { default: typeof traverseModule }).default
) as typeof traverseModule;

interface MutationCandidate {
  start: number;
  end: number;
  nodeStart: number;
  nodeEnd: number;
  lineNumber: number;
  from: string;
  to: string;
}

interface ParserToken {
  start?: number;
  end?: number;
  value?: unknown;
  type?: { label?: unknown };
}

const COMPARISON_SWAP: Readonly<Record<string, string>> = {
  '<': '<=',
  '<=': '<',
  '>': '>=',
  '>=': '>',
};

const EQUALITY_SWAP: Readonly<Record<string, string>> = {
  '===': '!==',
  '!==': '===',
  '==': '!=',
  '!=': '==',
};

const LOGICAL_SWAP: Readonly<Record<string, string>> = {
  '&&': '||',
  '||': '&&',
};

function nodeBounds(node: Node): { start: number; end: number; lineNumber: number } | null {
  if (typeof node.start !== 'number' || typeof node.end !== 'number') return null;
  return { start: node.start, end: node.end, lineNumber: node.loc?.start.line ?? 0 };
}

function operatorCandidate(
  source: string,
  node: BinaryExpression | LogicalExpression,
  replacement: string,
  tokens: readonly ParserToken[]
): MutationCandidate | null {
  const bounds = nodeBounds(node);
  if (
    !bounds ||
    typeof node.left.end !== 'number' ||
    typeof node.right.start !== 'number'
  ) {
    return null;
  }
  const from = node.operator;
  const operator = tokens.find(
    (token) =>
      typeof token.start === 'number' &&
      typeof token.end === 'number' &&
      token.start >= node.left.end &&
      token.end <= node.right.start &&
      typeof token.type?.label === 'string' &&
      token.value === from &&
      source.slice(token.start, token.end) === from
  );
  if (typeof operator?.start !== 'number' || typeof operator.end !== 'number') return null;
  return {
    start: operator.start,
    end: operator.end,
    nodeStart: bounds.start,
    nodeEnd: bounds.end,
    lineNumber: bounds.lineNumber,
    from,
    to: replacement,
  };
}

function booleanCandidate(node: BooleanLiteral): MutationCandidate | null {
  const bounds = nodeBounds(node);
  if (!bounds) return null;
  const from = node.value ? 'true' : 'false';
  return {
    start: bounds.start,
    end: bounds.end,
    nodeStart: bounds.start,
    nodeEnd: bounds.end,
    lineNumber: bounds.lineNumber,
    from,
    to: node.value ? 'false' : 'true',
  };
}

function collectMutationCandidates(
  source: string,
  kind: StructuredEditMutationKind
): MutationCandidate[] {
  const ast = parse(source, {
    sourceType: 'unambiguous',
    errorRecovery: false,
    tokens: true,
    plugins: ['typescript', 'jsx'],
  });
  const tokens = (ast.tokens ?? []) as ParserToken[];
  const candidates: MutationCandidate[] = [];
  traverse(ast, {
    BinaryExpression(path: NodePath<BinaryExpression>) {
      const replacement =
        kind === 'swap-comparison'
          ? COMPARISON_SWAP[path.node.operator]
          : kind === 'swap-equality'
            ? EQUALITY_SWAP[path.node.operator]
            : undefined;
      if (!replacement) return;
      const candidate = operatorCandidate(source, path.node, replacement, tokens);
      if (candidate) candidates.push(candidate);
    },
    LogicalExpression(path: NodePath<LogicalExpression>) {
      if (kind !== 'swap-logical') return;
      const replacement = LOGICAL_SWAP[path.node.operator];
      if (!replacement) return;
      const candidate = operatorCandidate(source, path.node, replacement, tokens);
      if (candidate) candidates.push(candidate);
    },
    BooleanLiteral(path: NodePath<BooleanLiteral>) {
      if (kind !== 'flip-boolean') return;
      const candidate = booleanCandidate(path.node);
      if (candidate) candidates.push(candidate);
    },
  });
  return candidates.sort((a, b) => a.start - b.start);
}

/** Apply exactly one committed Babel-selected mutation without reprinting the file. */
export function applyStructuredEditMutation(
  source: string,
  spec: StructuredEditMutationSpec
): AppliedStructuredEditMutation {
  const candidates = collectMutationCandidates(source, spec.kind);
  const candidate = candidates[spec.candidateIndex];
  if (!candidate) {
    throw new Error(
      `${spec.kind} candidate ${spec.candidateIndex} is unavailable (${candidates.length} found)`
    );
  }
  if (candidate.from !== spec.from || candidate.to !== spec.to) {
    throw new Error(
      `${spec.kind} candidate ${spec.candidateIndex} drifted: expected ${spec.from}->${spec.to}, found ${candidate.from}->${candidate.to}`
    );
  }
  const content = `${source.slice(0, candidate.start)}${candidate.to}${source.slice(candidate.end)}`;
  const snippetPrefix = source.slice(candidate.nodeStart, candidate.start);
  const snippetSuffix = source.slice(candidate.end, candidate.nodeEnd);
  return {
    content,
    kind: spec.kind,
    candidateIndex: spec.candidateIndex,
    lineNumber: candidate.lineNumber,
    originalSnippet: source.slice(candidate.nodeStart, candidate.nodeEnd),
    mutatedSnippet: `${snippetPrefix}${candidate.to}${snippetSuffix}`,
    from: candidate.from,
    to: candidate.to,
  };
}

const PRETTIER_OPTIONS: PrettierOptions = {
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: true,
  quoteProps: 'as-needed',
  trailingComma: 'all',
  bracketSpacing: true,
  arrowParens: 'always',
  endOfLine: 'lf',
  proseWrap: 'preserve',
};

const PARSER_BY_EXTENSION: Readonly<Partial<Record<string, BuiltInParserName>>> = {
  '.js': 'babel',
  '.jsx': 'babel',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.json': 'json',
  '.md': 'markdown',
};

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

function splitLines(value: string): string[] {
  return value.split('\n').filter((line, index, lines) => index < lines.length - 1 || line);
}

function countIndent(line: string): number {
  let count = 0;
  for (const char of line) {
    if (char === ' ') count += 1;
    else if (char === '\t') count += 2;
    else break;
  }
  return count;
}

function computeIndentScore(actual: string, formatted: string): number {
  const changes = diffLines(actual, formatted);
  let total = 0;
  let samples = 0;
  let removed: string[] = [];
  let added: string[] = [];
  const flush = () => {
    const length = Math.max(removed.length, added.length);
    for (let index = 0; index < length; index += 1) {
      total += Math.abs(countIndent(removed[index] ?? '') - countIndent(added[index] ?? ''));
      samples += 1;
    }
    removed = [];
    added = [];
  };
  for (const change of changes) {
    const lines = splitLines(change.value);
    if (change.removed) removed.push(...lines);
    else if (change.added) added.push(...lines);
    else flush();
  }
  flush();
  return samples > 0 ? total / samples : 0;
}

async function formatContent(filePath: string, content: string): Promise<string> {
  const parser = PARSER_BY_EXTENSION[extname(filePath).toLowerCase()];
  if (!parser) return content;
  try {
    return await format(content, { ...PRETTIER_OPTIONS, parser });
  } catch {
    return content;
  }
}

/**
 * Template quasi bytes are runtime data, not formatting. Prettier may format
 * embedded languages in tagged templates (for example `css`/`gql`) and make
 * two different `strings.raw` values print identically. Capture every Babel
 * TemplateElement's raw+cooked value before the formatter fallback so that
 * equivalence can never erase a semantic template change.
 */
function templateValues(filePath: string, content: string): string[] | null {
  const parser = PARSER_BY_EXTENSION[extname(filePath).toLowerCase()];
  if (parser !== 'babel' && parser !== 'typescript') return [];
  try {
    const ast = parse(content, {
      sourceType: 'unambiguous',
      errorRecovery: false,
      plugins: ['typescript', 'jsx'],
    });
    const values: string[] = [];
    traverse(ast, {
      TemplateElement(path: NodePath<TemplateElement>) {
        values.push(path.node.value.raw, path.node.value.cooked ?? '<null-cooked>');
      },
    });
    return values;
  } catch {
    return null;
  }
}

function sameTemplateValues(filePath: string, expected: string, actual: string): boolean {
  const left = templateValues(filePath, expected);
  const right = templateValues(filePath, actual);
  if (left === null || right === null || left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Score one repaired file, keeping strict bytes distinct from formatter equivalence. */
export async function scoreStructuredEdit(
  expectedRaw: string,
  actualRaw: string,
  filePath = 'task.ts'
): Promise<StructuredEditScore> {
  const byteExactMatch = expectedRaw === actualRaw;
  const expectedNormalized = normalizeLineEndings(expectedRaw);
  const actualNormalized = normalizeLineEndings(actualRaw);
  // Do not rewrite blank lines or edge whitespace before parsing. Both are
  // semantic inside template literals; Prettier is the syntax-aware fallback.
  const normalizedExactMatch = expectedNormalized === actualNormalized;
  const expectedFormatted = await formatContent(filePath, expectedNormalized);
  const actualFormatted = await formatContent(filePath, actualNormalized);
  const normalizedMatch =
    sameTemplateValues(filePath, expectedNormalized, actualNormalized) &&
    expectedFormatted === actualFormatted;
  const comparison = byteExactMatch
    ? 'byte-exact'
    : normalizedExactMatch
      ? 'normalized-exact'
      : normalizedMatch
        ? 'prettier-equivalent'
        : 'mismatch';
  return {
    byte_exact_match: byteExactMatch,
    normalized_exact_match: normalizedExactMatch,
    normalized_match: normalizedMatch,
    verification_passed: normalizedMatch,
    comparison,
    indent_score: computeIndentScore(actualNormalized, actualFormatted),
    expected_sha256: sha256(expectedRaw),
    actual_sha256: sha256(actualRaw),
  };
}
