/**
 * Canonical human-resumable leave-behind contract (#2313, epic #2281).
 *
 * The checker is browser-safe and persists no markdown. Transcript parsers may
 * evaluate a full Write input, keep only the sparse v1 structure marker, and
 * discard the content with the rest of the raw tool input.
 */

const OPERABILITY_HEADING = '## Operability' as const;
const DECISION_LOG_HEADING = '## Decision log' as const;
const OPERABILITY_SUBHEADINGS = [
  '### State and access',
  '### Template map',
  '### Re-run',
  '### Verify and recover',
] as const;
const DECISION_LOG_SUBHEADINGS = [
  '### Decisions',
  '### How to drive it',
] as const;

export const LEAVE_BEHIND_CONTRACT = Object.freeze({
  version: 'v1' as const,
  pathPattern: 'docs/runbooks/<state-scope>/README.md',
  operabilityHeading: OPERABILITY_HEADING,
  decisionLogHeading: DECISION_LOG_HEADING,
  operabilitySubheadings: OPERABILITY_SUBHEADINGS,
  decisionLogSubheadings: DECISION_LOG_SUBHEADINGS,
  requiredSubheadings: [
    ...OPERABILITY_SUBHEADINGS,
    ...DECISION_LOG_SUBHEADINGS,
  ] as const,
});

export type LeaveBehindValidationError =
  | 'invalid-path'
  | 'invalid-content'
  | 'invalid-version'
  | 'invalid-status'
  | 'state-scope-mismatch'
  | 'missing-operability'
  | 'missing-decision-log'
  | 'invalid-section-order'
  | 'empty-state-and-access'
  | 'empty-template-map'
  | 'empty-re-run'
  | 'empty-verify-and-recover'
  | 'empty-decisions'
  | 'empty-how-to-drive-it'
  | 'not-tracked-at-head';

export interface LeaveBehindValidationInput {
  /** False when the task made no material durable-state mutation. */
  required: boolean;
  path: unknown;
  content: unknown;
  /** Null means transcript-observed: structure is known, Git state is not. */
  trackedAtHead: boolean | null;
}

export type LeaveBehindValidationResult =
  | { status: 'not-required'; errors: [] }
  | {
      status: 'invalid' | 'candidate' | 'conformant';
      stateScope?: string;
      errors: LeaveBehindValidationError[];
    };

const RELATIVE_CANONICAL_PATH_RE =
  /^docs\/runbooks\/([a-z0-9]+(?:-[a-z0-9]+)*)\/README\.md$/;
const ABSOLUTE_CANONICAL_PATH_RE =
  /\/docs\/runbooks\/([a-z0-9]+(?:-[a-z0-9]+)*)\/README\.md$/;
const RAW_HTML_BLOCK_TAG_RE = new RegExp(
  '^ {0,3}</?(?:address|article|aside|base|basefont|blockquote|body|caption|' +
    'center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|' +
    'figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|' +
    'legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|' +
    'param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|' +
    'track|ul)(?:[ \\t]+|/?>|$)',
  'i'
);
const RAW_HTML_TAG_NAME = '[A-Za-z][A-Za-z0-9-]*';
const RAW_HTML_ATTRIBUTE_NAME = '[A-Za-z_:][A-Za-z0-9_.:-]*';
const RAW_HTML_ATTRIBUTE_VALUE =
  '(?:[^"\'=<>`\\x00-\\x20]+|"[^"]*"|\'[^\']*\')';
const RAW_HTML_ATTRIBUTE =
  `[ \\t]+${RAW_HTML_ATTRIBUTE_NAME}(?:[ \\t]*=[ \\t]*${RAW_HTML_ATTRIBUTE_VALUE})?`;
const TYPE7_OPEN_TAG_NAME =
  `(?!(?:pre|script|style|textarea)(?:[ \\t]|/?>|$))${RAW_HTML_TAG_NAME}`;
const COMPLETE_RAW_HTML_TAG_RE = new RegExp(
  `^ {0,3}(?:<${TYPE7_OPEN_TAG_NAME}(?:${RAW_HTML_ATTRIBUTE})*[ \\t]*/?>|` +
    `</${RAW_HTML_TAG_NAME}[ \\t]*>)[ \\t]*$`,
  'i'
);
// Static proof is deliberately bounded below the 64 MiB ingest ceiling. A
// human-operable runbook never needs one enormous HTML token or thousands of
// nested elements/code-span delimiters; exceeding these limits is ambiguous
// input and therefore cannot satisfy a required section.
const MAX_MARKDOWN_PROOF_LINE_CHARS = 16_384;
const MAX_MARKDOWN_SECTION_PROJECTION_CHARS = 262_144;
const MAX_LEAVE_BEHIND_ARTIFACT_CHARS = 262_144;
const MAX_INLINE_HTML_TAG_CHARS = 16_384;
const MAX_INLINE_HTML_ATTRIBUTES = 256;
const MAX_INLINE_HTML_NESTING = 1_024;
const MAX_INLINE_HTML_OUTPUT_PARTS = 32_768;
const MAX_MARKDOWN_CODE_SPAN_RUNS = 4_096;

type RawHtmlBlock =
  | { kind: 'closing-tag' }
  | { kind: 'token'; token: string }
  | { kind: 'blank-line'; canInterruptParagraph: boolean };

function rawHtmlBlockStart(line: string): RawHtmlBlock | null {
  if (line.length > MAX_MARKDOWN_PROOF_LINE_CHARS) {
    // Do not feed an attacker-sized attribute repetition into the recursive
    // complete-tag regexp. The later bounded inline projection still rejects
    // an oversized valid tag, while a long sequence of malformed `<tag `
    // fragments remains ordinary visible text rather than a fabricated block.
    return null;
  }
  if (/^ {0,3}<!--/.test(line)) return { kind: 'token', token: '-->' };
  const closingTag =
    /^ {0,3}<(pre|script|style|textarea)(?:[ \t>]|$)/i.exec(line)?.[1];
  if (closingTag) return { kind: 'closing-tag' };
  if (/^ {0,3}<\?/.test(line)) return { kind: 'token', token: '?>' };
  if (/^ {0,3}<!\[CDATA\[/.test(line)) {
    return { kind: 'token', token: ']]>' };
  }
  if (/^ {0,3}<![A-Za-z]/.test(line)) return { kind: 'token', token: '>' };
  if (RAW_HTML_BLOCK_TAG_RE.test(line)) {
    return { kind: 'blank-line', canInterruptParagraph: true };
  }
  if (COMPLETE_RAW_HTML_TAG_RE.test(line)) {
    return { kind: 'blank-line', canInterruptParagraph: false };
  }
  return null;
}

function rawHtmlBlockEnds(block: RawHtmlBlock, line: string): boolean {
  if (block.kind === 'blank-line') return /^[ \t]*$/.test(line);
  if (block.kind === 'token') return line.includes(block.token);
  return /<\/(?:pre|script|style|textarea)>/i.test(line);
}

function stripHtmlComments(
  line: string,
  startsInsideComment: boolean
): { line: string; insideComment: boolean } {
  let visible = '';
  let cursor = 0;
  let insideComment = startsInsideComment;
  while (cursor < line.length) {
    if (insideComment) {
      const end = line.indexOf('-->', cursor);
      if (end < 0) return { line: visible, insideComment: true };
      insideComment = false;
      cursor = end + 3;
      continue;
    }
    const start = line.indexOf('<!--', cursor);
    if (start < 0) {
      visible += line.slice(cursor);
      break;
    }
    visible += line.slice(cursor, start);
    cursor = start + 4;
    insideComment = true;
  }
  return { line: visible, insideComment };
}

type LiteralCodeKind = 'fenced' | 'indented';

interface VisibleMarkdownProjection {
  lines: string[];
  literalCodeLines: Map<number, LiteralCodeKind>;
  atxHeadingLines: Set<number>;
  setextUnderlineLines: Set<number>;
  thematicBreakLines: Set<number>;
}

interface MarkdownContainerLine {
  leaf: string;
  leafStartColumn: number;
  hasContainer: boolean;
  quoteDepth: number;
  listDepth: number;
  listCanInterruptParagraph: boolean;
  containerPath: string;
  firstListPath: string | null;
  quotesBeforeFirstList: number | null;
  startsListItem: boolean;
  listMarkerStartColumn: number | null;
  listMarkerColumn: number | null;
  listContinuationIndent: number | null;
}

interface MarkdownContainerContext {
  quoteDepth: number;
  listDepth: number;
  containerPath: string;
  firstListPath: string | null;
  quotesBeforeFirstList: number | null;
  listMarkerStartColumn: number | null;
  listMarkerColumn: number | null;
  listContinuationIndent: number | null;
}

const MAX_CONTAINER_LINK_DEFINITION_BUFFER_CHARS = 4 * 1024;
const MAX_CONTAINER_LINK_DEFINITION_BUFFER_LINES = 256;

interface PendingContainerLinkDefinition {
  context: MarkdownContainerContext;
  lines: string[];
  complete: boolean;
  outputIndices: number[];
  bufferedChars: number;
  failClosed: boolean;
}

function enterFailClosedLinkDefinition(
  pending: PendingContainerLinkDefinition,
  projectionLines: string[]
): void {
  for (const index of pending.outputIndices) projectionLines[index] = '';
  pending.lines = [];
  pending.outputIndices = [];
  pending.bufferedChars = 0;
  pending.complete = false;
  pending.failClosed = true;
}

function containerContext(
  line: MarkdownContainerLine
): MarkdownContainerContext {
  return {
    quoteDepth: line.quoteDepth,
    listDepth: line.listDepth,
    containerPath: line.containerPath,
    firstListPath: line.firstListPath,
    quotesBeforeFirstList: line.quotesBeforeFirstList,
    listMarkerStartColumn: line.listMarkerStartColumn,
    listMarkerColumn: line.listMarkerColumn,
    listContinuationIndent: line.listContinuationIndent,
  };
}

function sameContainerContext(
  left: MarkdownContainerContext | null,
  right: MarkdownContainerLine
): boolean {
  return !!(
    left &&
    left.quoteDepth === right.quoteDepth &&
    left.listDepth === right.listDepth &&
    left.containerPath === right.containerPath &&
    left.listMarkerStartColumn === right.listMarkerStartColumn &&
    left.listMarkerColumn === right.listMarkerColumn &&
    left.listContinuationIndent === right.listContinuationIndent
  );
}

function markdownColumn(text: string, startColumn = 0): number {
  let column = startColumn;
  for (const character of text) {
    column = character === '\t' ? column + (4 - (column % 4)) : column + 1;
  }
  return column;
}

function stripMarkdownIndent(
  line: string,
  columns: number,
  startColumn = 0
): string | null {
  let column = startColumn;
  const targetColumn = startColumn + columns;
  let index = 0;
  let remainingColumns = 0;
  while (index < line.length && column < targetColumn) {
    const character = line[index];
    if (character !== ' ' && character !== '\t') return null;
    const nextColumn =
      character === '\t' ? column + (4 - (column % 4)) : column + 1;
    index += 1;
    if (nextColumn > targetColumn) {
      remainingColumns = nextColumn - targetColumn;
    }
    column = nextColumn;
  }
  if (column < targetColumn) return null;
  while (line[index] === ' ' || line[index] === '\t') {
    const nextColumn =
      line[index] === '\t' ? column + (4 - (column % 4)) : column + 1;
    remainingColumns += nextColumn - column;
    column = nextColumn;
    index += 1;
  }
  return `${' '.repeat(remainingColumns)}${line.slice(index)}`;
}

/** Peel explicit blockquote/list markers so paragraph state follows the leaf
 * block without allowing headings inside a container to satisfy the contract. */
function markdownContainerLine(
  raw: string,
  startColumn = 0
): MarkdownContainerLine {
  let cursor = 0;
  let cursorColumn = startColumn;
  let quoteDepth = 0;
  let listDepth = 0;
  const containerPath: string[] = [];
  let firstListPath: string | null = null;
  let quotesBeforeFirstList: number | null = null;
  let listCanInterruptParagraph = true;
  let hasContainer = false;
  let quoteEndedWithSpace = false;
  let startsListItem = false;
  let listMarkerStartColumn: number | null = null;
  let listMarkerColumn: number | null = null;
  let listContinuationIndent: number | null = null;
  const mayEndInThematicMarker = /[*_-][ \t]*$/.test(raw);
  while (cursor < raw.length) {
    const rest = raw.slice(cursor);
    const quote = /^( {0,3})>[ \t]?/.exec(rest);
    if (quote) {
      cursorColumn = markdownColumn(quote[0], cursorColumn);
      cursor += quote[0].length;
      quoteDepth += 1;
      containerPath.push('q');
      hasContainer = true;
      quoteEndedWithSpace = quote[0].endsWith(' ');
      continue;
    }
    if (
      mayEndInThematicMarker &&
      /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(
        rest
      )
    ) {
      break;
    }
    const list = /^( {0,3})([-+*]|\d{1,9}[.)])([ \t]*)/.exec(rest);
    if (!list) break;
    if (list[3].length === 0 && list[0].length < rest.length) break;
    const markerStartColumn = markdownColumn(list[1], cursorColumn);
    const markerColumn = markdownColumn(list[2], markerStartColumn);
    if (listMarkerStartColumn == null) {
      listMarkerStartColumn = markerStartColumn;
    }
    if (listMarkerColumn == null) listMarkerColumn = markerColumn;
    const paddedColumn = markdownColumn(list[3], markerColumn);
    const paddingColumns = paddedColumn - markerColumn;
    const consumedPadding = paddingColumns > 4 ? 1 : list[3].length;
    const consumed = `${list[1]}${list[2]}${list[3].slice(0, consumedPadding)}`;
    cursorColumn = markdownColumn(consumed, cursorColumn);
    cursor += consumed.length;
    hasContainer = true;
    startsListItem = true;
    if (listDepth === 0 && /^\d/.test(list[2])) {
      listCanInterruptParagraph = /^1[.)]$/.test(list[2]);
    }
    listDepth += 1;
    containerPath.push('l');
    if (firstListPath == null) {
      firstListPath = containerPath.join('/');
      quotesBeforeFirstList = quoteDepth;
    }
    if (listContinuationIndent == null) {
      listContinuationIndent = Math.max(cursorColumn, markerColumn + 1);
    }
  }
  let leaf = raw.slice(cursor);
  if (quoteEndedWithSpace && leaf.startsWith('\t')) {
    leaf = `${' '.repeat(4 - (cursorColumn % 4))}${leaf.slice(1)}`;
  }
  return {
    leaf,
    leafStartColumn: cursorColumn,
    hasContainer,
    quoteDepth,
    listDepth,
    listCanInterruptParagraph,
    containerPath: containerPath.join('/'),
    firstListPath,
    quotesBeforeFirstList,
    startsListItem,
    listMarkerStartColumn,
    listMarkerColumn,
    listContinuationIndent,
  };
}

function activeListContinuationLine(
  raw: string,
  activeIndent: number,
  prior: MarkdownContainerContext | null,
  allowOmittedQuotes: boolean
): MarkdownContainerLine | null {
  if (prior?.listContinuationIndent !== activeIndent) return null;
  if (prior.firstListPath == null || prior.quotesBeforeFirstList == null) {
    return null;
  }
  const requiresExplicitQuotes =
    !allowOmittedQuotes && prior.quotesBeforeFirstList > 0;
  let continued = requiresExplicitQuotes
    ? null
    : stripMarkdownIndent(raw, activeIndent);
  if (continued == null) {
    let cursor = 0;
    for (let index = 0; index < prior.quotesBeforeFirstList; index += 1) {
      const quote = /^( {0,3})>[ \t]?/.exec(raw.slice(cursor));
      if (!quote) return null;
      cursor += quote[0].length;
    }
    const consumedColumn = markdownColumn(raw.slice(0, cursor));
    if (consumedColumn > activeIndent) return null;
    continued = stripMarkdownIndent(
      raw.slice(cursor),
      activeIndent - consumedColumn,
      consumedColumn
    );
  }
  if (continued == null) return null;

  const nested = markdownContainerLine(continued, activeIndent);
  if (!nested.hasContainer) {
    return {
      leaf: nested.leaf,
      leafStartColumn: nested.leafStartColumn,
      hasContainer: true,
      quoteDepth: prior.quoteDepth,
      listDepth: prior.listDepth,
      listCanInterruptParagraph: true,
      containerPath: prior.containerPath,
      firstListPath: prior.firstListPath,
      quotesBeforeFirstList: prior.quotesBeforeFirstList,
      startsListItem: false,
      listMarkerStartColumn: prior.listMarkerStartColumn,
      listMarkerColumn: prior.listMarkerColumn,
      listContinuationIndent: prior.listContinuationIndent,
    };
  }

  const nestedList = nested.listDepth > 0;
  return {
    ...nested,
    leafStartColumn: nested.leafStartColumn,
    quoteDepth: prior.quotesBeforeFirstList + nested.quoteDepth,
    listDepth: 1 + nested.listDepth,
    containerPath: `${prior.firstListPath}/${nested.containerPath}`,
    firstListPath: prior.firstListPath,
    quotesBeforeFirstList: prior.quotesBeforeFirstList,
    listMarkerStartColumn:
      nestedList && nested.listMarkerStartColumn != null
        ? nested.listMarkerStartColumn
        : prior.listMarkerStartColumn,
    listMarkerColumn:
      nestedList && nested.listMarkerColumn != null
        ? nested.listMarkerColumn
        : prior.listMarkerColumn,
    listContinuationIndent:
      nestedList && nested.listContinuationIndent != null
        ? nested.listContinuationIndent
        : prior.listContinuationIndent,
  };
}

function markdownBlockquoteLeaf(raw: string): {
  leaf: string;
  quoteDepth: number;
} {
  let cursor = 0;
  let quoteDepth = 0;
  while (cursor < raw.length) {
    const quote = /^( {0,3})>[ \t]?/.exec(raw.slice(cursor));
    if (!quote) break;
    cursor += quote[0].length;
    quoteDepth += 1;
  }
  return { leaf: raw.slice(cursor), quoteDepth };
}

function commonMarkAtxHeading(line: string): boolean {
  return /^ {0,3}#{1,6}(?:[ \t]+|$)/.test(line);
}

function interruptsLinkDestinationContinuation(line: string): boolean {
  if (
    /^ {0,3}(?:=+|-+)[ \t]*$/.test(line) ||
    /^ {0,3}(?:`{3,}|~{3,})/.test(line) ||
    /^ {0,3}(?:>|[-+*](?:[ \t]+|$)|\d{1,9}[.)](?:[ \t]+|$))/.test(
      line
    ) ||
    commonMarkAtxHeading(line)
  ) {
    return true;
  }
  const raw = rawHtmlBlockStart(line);
  return !!(
    raw &&
    (raw.kind !== 'blank-line' || raw.canInterruptParagraph)
  );
}

function linkDestinationEnd(line: string, start: number): number | null {
  if (line[start] === '<') {
    for (let index = start + 1; index < line.length; index += 1) {
      if (line[index] === '\\') {
        index += 1;
        continue;
      }
      if (line[index] === '>') return index + 1;
      if (line[index] === '<') return null;
    }
    return null;
  }

  let depth = 0;
  for (let index = start; index < line.length; index += 1) {
    const character = line[index];
    if (character === '\\') {
      index += 1;
      continue;
    }
    if (/[ \t]/.test(character)) return index;
    if (character === '(') depth += 1;
    if (character === ')') {
      if (depth === 0) return null;
      depth -= 1;
    }
  }
  return depth === 0 ? line.length : null;
}

function linkTitleEndLine(
  sourceLines: readonly string[],
  startLine: number,
  startColumn: number
): number | null {
  const opener = sourceLines[startLine]?.[startColumn];
  if (opener !== '"' && opener !== "'" && opener !== '(') return null;
  const closer = opener === '(' ? ')' : opener;
  for (let lineIndex = startLine; lineIndex < sourceLines.length; lineIndex += 1) {
    const line = sourceLines[lineIndex];
    if (lineIndex > startLine && /^[ \t]*$/.test(line)) return null;
    // Only an ordered marker starting at 1 can interrupt a paragraph in
    // CommonMark. A `2.`-`9.` line may therefore remain inside a multiline
    // title, while `1.` ends the definition and must stay rendered.
    if (lineIndex > startLine && /^ {0,3}1[.)](?:[ \t]+|$)/.test(line)) {
      return null;
    }
    const from = lineIndex === startLine ? startColumn + 1 : 0;
    for (let column = from; column < line.length; column += 1) {
      if (line[column] === '\\') {
        column += 1;
        continue;
      }
      if (opener === '(' && line[column] === '(') return null;
      if (line[column] !== closer) continue;
      return /^[ \t]*$/.test(line.slice(column + 1)) ? lineIndex : null;
    }
  }
  return null;
}

/** Whether these lines can still begin a link-reference definition. This is
 * deliberately only a prefix check: a destination/title may not be complete
 * yet, but a closed label not followed by `:` is definitively ordinary prose. */
function potentialLinkReferenceDefinition(
  sourceLines: readonly string[]
): boolean {
  if (!/^ {0,3}\[/.test(sourceLines[0] ?? '')) return false;
  let escaped = false;
  let labelLength = 0;
  for (let lineIndex = 0; lineIndex < sourceLines.length; lineIndex += 1) {
    const line = sourceLines[lineIndex];
    if (lineIndex > 0 && /^[ \t]*$/.test(line)) return false;
    const from = lineIndex === 0 ? line.indexOf('[') + 1 : 0;
    for (let column = from; column < line.length; column += 1) {
      const character = line[column];
      labelLength += 1;
      if (labelLength > 999) return false;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === '\\') {
        escaped = true;
        continue;
      }
      if (character === ']') return line[column + 1] === ':';
    }
  }
  return true;
}

function linkReferenceDefinitionLines(sourceLines: readonly string[]): Set<number> {
  const definitions = new Set<number>();
  for (let start = 0; start < sourceLines.length; start += 1) {
    if (!/^ {0,3}\[/.test(sourceLines[start])) continue;
    let escaped = false;
    let labelLength = 0;
    let end = start;
    let closeColumn = -1;
    for (; end < sourceLines.length; end += 1) {
      const line = sourceLines[end];
      if (end > start && /^[ \t]*$/.test(line)) break;
      const from = end === start ? line.indexOf('[') + 1 : 0;
      for (let index = from; index < line.length; index += 1) {
        const character = line[index];
        labelLength += 1;
        if (labelLength > 999) break;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (character === '\\') {
          escaped = true;
          continue;
        }
        if (character === ']') {
          closeColumn = index;
          break;
        }
      }
      if (closeColumn >= 0 || labelLength > 999) break;
    }
    if (closeColumn < 0 || labelLength <= 1 || labelLength > 999) continue;
    const closingLine = sourceLines[end];
    if (closingLine[closeColumn + 1] !== ':') continue;
    let destinationLine = end;
    let destinationColumn = closeColumn + 2;
    while (/[ \t]/.test(closingLine[destinationColumn] ?? '')) {
      destinationColumn += 1;
    }
    if (destinationColumn === closingLine.length) {
      destinationLine += 1;
      const destination = sourceLines[destinationLine];
      const destinationIndent =
        destination == null ? '' : /^[ \t]*/.exec(destination)?.[0] ?? '';
      if (
        destination == null ||
        destinationIndent.length === destination.length ||
        interruptsLinkDestinationContinuation(destination)
      ) {
        continue;
      }
      destinationColumn = destinationIndent.length;
    }
    const destination = sourceLines[destinationLine];
    const destinationEnd = linkDestinationEnd(destination, destinationColumn);
    if (destinationEnd == null || destinationEnd === destinationColumn) continue;

    let definitionEnd = destinationLine;
    const afterDestination = destination.slice(destinationEnd);
    const titleSeparation = /^[ \t]*/.exec(afterDestination)?.[0] ?? '';
    const sameLineTitleColumn = destinationEnd + titleSeparation.length;
    if (sameLineTitleColumn < destination.length) {
      if (titleSeparation.length === 0) continue;
      const titleEnd = linkTitleEndLine(
        sourceLines,
        destinationLine,
        sameLineTitleColumn
      );
      if (titleEnd == null) continue;
      definitionEnd = titleEnd;
    } else {
      const titleLine = sourceLines[destinationLine + 1];
      const titleIndent =
        titleLine == null
          ? null
          : /^[ \t]*/.exec(titleLine)?.[0].length ?? 0;
      if (
        titleLine != null &&
        titleIndent != null &&
        ['"', "'", '('].includes(titleLine[titleIndent] ?? '')
      ) {
        const titleEnd = linkTitleEndLine(
          sourceLines,
          destinationLine + 1,
          titleIndent
        );
        if (titleEnd != null) definitionEnd = titleEnd;
      }
    }
    for (let index = start; index <= definitionEnd; index += 1) {
      definitions.add(index);
    }
    start = definitionEnd;
  }
  return definitions;
}

function visibleMarkdownLines(markdown: string): VisibleMarkdownProjection {
  const sourceLines = markdown.split(/\r?\n/);
  let body = markdown;
  if (sourceLines[0]?.replace(/^\uFEFF/, '') === '---') {
    const closing = sourceLines
      .slice(1)
      .findIndex((line) => line === '---');
    if (closing >= 0) body = sourceLines.slice(closing + 2).join('\n');
  }
  const bodyLines = body.split(/\r?\n/);
  const linkDefinitionLines = linkReferenceDefinitionLines(bodyLines);
  const lines: string[] = [];
  const literalCodeLines = new Map<number, LiteralCodeKind>();
  const atxHeadingLines = new Set<number>();
  const setextUnderlineLines = new Set<number>();
  const thematicBreakLines = new Set<number>();
  let fence: { marker: '`' | '~'; length: number } | null = null;
  let containerFence: {
    marker: '`' | '~';
    length: number;
    quoteDepth: number;
    listContinuationIndent: number | null;
  } | null = null;
  let containerRawHtmlBlock: {
    block: RawHtmlBlock;
    context: MarkdownContainerContext;
    quoteDepth: number;
    listContinuationIndent: number | null;
  } | null = null;
  let containerLinkDefinition: PendingContainerLinkDefinition | null = null;
  let activeListContinuationIndent: number | null = null;
  let activeListContext: MarkdownContainerContext | null = null;
  let rawHtmlBlock: RawHtmlBlock | null = null;
  let insideComment = false;
  let paragraphOpen = false;
  let paragraphContainer: MarkdownContainerContext | null = null;
  let allowsIndentedCode = true;
  for (const [sourceIndex, raw] of bodyLines.entries()) {
    const activeListLeaf =
      activeListContinuationIndent == null
        ? null
        : stripMarkdownIndent(raw, activeListContinuationIndent);
    const preferActiveListParagraph = !!(
      paragraphOpen &&
      paragraphContainer != null &&
      paragraphContainer.listContinuationIndent ===
        activeListContinuationIndent &&
      activeListLeaf != null &&
      /^ {0,3}(?:=+|-+)[ \t]*$/.test(activeListLeaf)
    );
    const topLevelSetext =
      paragraphOpen &&
      paragraphContainer == null &&
      /^ {0,3}(?:=+|-+)[ \t]*$/.test(raw);
    let container: MarkdownContainerLine = preferActiveListParagraph
      ? {
          leaf: activeListLeaf,
          leafStartColumn: activeListContinuationIndent ?? 0,
          hasContainer: true,
          quoteDepth: paragraphContainer?.quoteDepth ?? 0,
          listDepth: paragraphContainer?.listDepth ?? 1,
          listCanInterruptParagraph: true,
          containerPath: paragraphContainer?.containerPath ?? 'l',
          firstListPath: paragraphContainer?.firstListPath ?? 'l',
          quotesBeforeFirstList:
            paragraphContainer?.quotesBeforeFirstList ?? 0,
          startsListItem: false,
          listMarkerStartColumn:
            paragraphContainer?.listMarkerStartColumn ?? null,
          listMarkerColumn: paragraphContainer?.listMarkerColumn ?? null,
          listContinuationIndent: activeListContinuationIndent,
        }
      : topLevelSetext
      ? {
          leaf: raw,
          leafStartColumn: 0,
          hasContainer: false,
          quoteDepth: 0,
          listDepth: 0,
          listCanInterruptParagraph: true,
          containerPath: '',
          firstListPath: null,
          quotesBeforeFirstList: null,
          startsListItem: false,
          listMarkerStartColumn: null,
          listMarkerColumn: null,
          listContinuationIndent: null,
        }
      : markdownContainerLine(raw);
    if (
      activeListContinuationIndent != null &&
      !preferActiveListParagraph &&
      !/^[ \t]*$/.test(raw)
    ) {
      const continued = activeListContinuationLine(
        raw,
        activeListContinuationIndent,
        paragraphContainer ?? activeListContext,
        paragraphOpen
      );
      if (continued != null) container = continued;
      else {
        activeListContinuationIndent = null;
        activeListContext = null;
      }
    } else if (!container.hasContainer) {
      activeListContinuationIndent = null;
      activeListContext = null;
    }
    if (containerLinkDefinition && !container.hasContainer) {
      // Link-reference definitions may lazily omit an enclosing list/quote
      // marker on multiline labels, destinations, and titles. Buffer the raw
      // paragraph text until the candidate is proven complete; then erase only
      // the definition lines from the rendered projection. A closed label
      // without `:` or a hard block boundary falls through as ordinary prose.
      const pending = containerLinkDefinition;
      const resumedListLine =
        pending.context.listContinuationIndent == null
          ? null
          : activeListContinuationLine(
              raw,
              pending.context.listContinuationIndent,
              pending.context,
              true
            );
      const candidateLeaf = resumedListLine?.leaf ?? raw;
      const optionalTitle =
        pending.complete && /^[ \t]*["'(]/.test(candidateLeaf);
      const hardBoundary =
        /^[ \t]*$/.test(candidateLeaf) ||
        interruptsLinkDestinationContinuation(candidateLeaf);
      const canAttemptContinuation =
        !hardBoundary && (!pending.complete || optionalTitle);
      if (pending.failClosed && canAttemptContinuation) {
        lines.push('');
        paragraphOpen = true;
        paragraphContainer = pending.context;
        allowsIndentedCode = false;
        continue;
      }
      if (canAttemptContinuation) {
        const bufferedChars =
          pending.bufferedChars + candidateLeaf.length + 1;
        if (
          pending.lines.length >=
            MAX_CONTAINER_LINK_DEFINITION_BUFFER_LINES ||
          bufferedChars > MAX_CONTAINER_LINK_DEFINITION_BUFFER_CHARS
        ) {
          enterFailClosedLinkDefinition(pending, lines);
          lines.push('');
          paragraphOpen = true;
          paragraphContainer = pending.context;
          allowsIndentedCode = false;
          continue;
        }
        const candidateLines = [...pending.lines, candidateLeaf];
        const definitionLines = linkReferenceDefinitionLines(candidateLines);
        const candidateComplete =
          definitionLines.has(0) &&
          definitionLines.size === candidateLines.length;
        const canContinue =
          potentialLinkReferenceDefinition(candidateLines);
        if (!canContinue) {
          const completedDefinition = pending.complete;
          containerLinkDefinition = null;
          if (!completedDefinition) {
            paragraphOpen = false;
            paragraphContainer = null;
          }
        } else {
          const outputIndex = lines.length;
          lines.push(raw);
          pending.lines = candidateLines;
          pending.complete = candidateComplete;
          pending.outputIndices.push(outputIndex);
          pending.bufferedChars = bufferedChars;
          if (candidateComplete) {
            for (const index of pending.outputIndices) lines[index] = '';
          }
          paragraphOpen = true;
          paragraphContainer = pending.context;
          allowsIndentedCode = false;
          continue;
        }
      } else {
        // An unfinished candidate remains rendered paragraph text. A completed
        // definition has already been erased; reprocess this non-title line as a
        // new block outside the container.
        const completedDefinition = pending.complete;
        containerLinkDefinition = null;
        if (!completedDefinition) {
          paragraphOpen = false;
          paragraphContainer = null;
        }
      }
    }
    if (containerFence) {
      let fenceLeaf: string | null = null;
      if (
        containerFence.listContinuationIndent != null &&
        raw.startsWith(' '.repeat(containerFence.listContinuationIndent))
      ) {
        fenceLeaf = raw.slice(containerFence.listContinuationIndent);
      } else if (
        container.hasContainer &&
        container.quoteDepth >= containerFence.quoteDepth
      ) {
        fenceLeaf = container.leaf;
      }
      if (fenceLeaf != null) {
        const close = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(fenceLeaf);
        if (
          close &&
          (close[1][0] as '`' | '~') === containerFence.marker &&
          close[1].length >= containerFence.length &&
          /^[ \t]*$/.test(close[2])
        ) {
          containerFence = null;
          lines.push('');
        }
        paragraphOpen = false;
        allowsIndentedCode = true;
        continue;
      }
      // Leaving the container implicitly closes its fence. Reprocess this
      // physical line as top-level Markdown below.
      containerFence = null;
    }
    if (containerRawHtmlBlock) {
      let rawLeaf: string | null = null;
      const startsNewListItem = !!(
        containerRawHtmlBlock.context.listDepth > 0 &&
        container.startsListItem &&
        container.quoteDepth === containerRawHtmlBlock.context.quoteDepth &&
        container.listMarkerStartColumn != null &&
        container.listMarkerStartColumn <
          (containerRawHtmlBlock.context.listContinuationIndent ?? 0)
      );
      if (
        !startsNewListItem &&
        containerRawHtmlBlock.listContinuationIndent != null
      ) {
        rawLeaf = stripMarkdownIndent(
          raw,
          containerRawHtmlBlock.listContinuationIndent
        );
      }
      if (
        !startsNewListItem &&
        rawLeaf == null &&
        container.hasContainer &&
        container.quoteDepth >= containerRawHtmlBlock.quoteDepth
      ) {
        rawLeaf = container.leaf;
      }
      if (rawLeaf != null) {
        if (rawHtmlBlockEnds(containerRawHtmlBlock.block, rawLeaf)) {
          containerRawHtmlBlock = null;
          lines.push('');
        }
        paragraphOpen = false;
        allowsIndentedCode = true;
        continue;
      }
      // Leaving the container implicitly closes its raw block. Reprocess the
      // physical line at top level below.
      containerRawHtmlBlock = null;
    }
    if (rawHtmlBlock) {
      if (rawHtmlBlockEnds(rawHtmlBlock, raw)) {
        const endedOnBlank = rawHtmlBlock.kind === 'blank-line';
        rawHtmlBlock = null;
        // Preserve the block boundary without exposing any hidden structure.
        // Erasing the block would make surrounding paragraph/Setext/indented
        // lines falsely adjacent in the projection.
        lines.push(endedOnBlank ? raw : '');
        paragraphOpen = false;
        allowsIndentedCode = true;
      }
      continue;
    }
    if (fence) {
      const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(raw);
      if (
        fenceMatch &&
        (fenceMatch[1][0] as '`' | '~') === fence.marker &&
        fenceMatch[1].length >= fence.length &&
        /^[ \t]*$/.test(fenceMatch[2])
      ) {
        fence = null;
        lines.push('');
        paragraphOpen = false;
        allowsIndentedCode = true;
      } else {
        // Preserve fenced command/text bodies as usable section content, but
        // indent Markdown-looking lines so they cannot become structure.
        literalCodeLines.set(lines.length, 'fenced');
        lines.push(`    ${raw}`);
        paragraphOpen = false;
        allowsIndentedCode = true;
      }
      continue;
    }

    if (
      linkDefinitionLines.has(sourceIndex) &&
      (!paragraphOpen || linkDefinitionLines.has(sourceIndex - 1))
    ) {
      lines.push('');
      // Definitions are removed from rendered output only when the paragraph
      // is finalized. Until a real block boundary arrives they still keep the
      // paragraph open, so a type-7 HTML tag cannot interrupt them.
      paragraphOpen = true;
      paragraphContainer = null;
      allowsIndentedCode = false;
      continue;
    }

    if (container.hasContainer) {
      if (
        container.listDepth > 0 &&
        container.listContinuationIndent != null
      ) {
        activeListContinuationIndent = container.listContinuationIndent;
        activeListContext = containerContext(container);
      }
      const startsPeerListItem = !!(
        paragraphOpen &&
        paragraphContainer != null &&
        paragraphContainer.listDepth > 0 &&
        container.startsListItem &&
        paragraphContainer.quoteDepth === container.quoteDepth &&
        container.listMarkerStartColumn != null &&
        container.listMarkerStartColumn <
          (paragraphContainer.listContinuationIndent ?? 0)
      );
      if (containerLinkDefinition) {
        const pending = containerLinkDefinition;
        const pendingContext = pending.context;
        const invalidContinuation =
          startsPeerListItem ||
          /^[ \t]*$/.test(container.leaf) ||
          interruptsLinkDestinationContinuation(container.leaf);
        const optionalTitle =
          pending.complete &&
          /^[ \t]*["'(]/.test(container.leaf);
        const canAttemptContinuation =
          !invalidContinuation && (!pending.complete || optionalTitle);
        if (pending.failClosed && canAttemptContinuation) {
          lines.push('');
          paragraphOpen = true;
          paragraphContainer = pendingContext;
          allowsIndentedCode = false;
          continue;
        }
        if (canAttemptContinuation) {
          const bufferedChars =
            pending.bufferedChars + container.leaf.length + 1;
          if (
            pending.lines.length >=
              MAX_CONTAINER_LINK_DEFINITION_BUFFER_LINES ||
            bufferedChars > MAX_CONTAINER_LINK_DEFINITION_BUFFER_CHARS
          ) {
            enterFailClosedLinkDefinition(pending, lines);
            lines.push('');
            paragraphOpen = true;
            paragraphContainer = pendingContext;
            allowsIndentedCode = false;
            continue;
          }
          const candidateLines = [...pending.lines, container.leaf];
          const definitionLines = linkReferenceDefinitionLines(candidateLines);
          const candidateComplete =
            definitionLines.has(0) &&
            definitionLines.size === candidateLines.length;
          // Lazy continuation can omit any mix of enclosing markers, while a
          // marker-looking label/title line can be peeled as a new container by
          // this lightweight projection. Keep the candidate across that ambiguity
          // and fail closed: proven definitions are erased, unproven text is
          // restored, and peer/hard boundaries still stop the speculation.
          const canContinue =
            potentialLinkReferenceDefinition(candidateLines);
          if (!canContinue) {
            containerLinkDefinition = null;
          } else {
            const outputIndex = lines.length;
            lines.push(raw);
            pending.lines = candidateLines;
            pending.complete = candidateComplete;
            pending.outputIndices.push(outputIndex);
            pending.bufferedChars = bufferedChars;
            if (candidateComplete) {
              for (const index of pending.outputIndices) {
                lines[index] = '';
              }
            }
            paragraphOpen = true;
            paragraphContainer = pendingContext;
            allowsIndentedCode = false;
            continue;
          }
        } else {
          containerLinkDefinition = null;
        }
        if (invalidContinuation && !optionalTitle) {
          paragraphOpen = false;
          paragraphContainer = null;
        }
      }
      const sameParagraphContainer =
        paragraphOpen &&
        !startsPeerListItem &&
        sameContainerContext(paragraphContainer, container);
      const quoteLeaf = markdownBlockquoteLeaf(raw);
      const leafSetext =
        (sameParagraphContainer &&
          /^ {0,3}(?:=+|-+)[ \t]*$/.test(container.leaf)) ||
        (paragraphOpen &&
          paragraphContainer != null &&
          paragraphContainer.listDepth === 0 &&
          paragraphContainer.quoteDepth === quoteLeaf.quoteDepth &&
          /^ {0,3}(?:=+|-+)[ \t]*$/.test(quoteLeaf.leaf));
      if (leafSetext) {
        lines.push('');
        paragraphOpen = false;
        allowsIndentedCode = true;
        continue;
      }
      const leafFence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(container.leaf);
      const opensFence =
        leafFence &&
        (leafFence[1][0] === '~' || !leafFence[2].includes('`'));
      const indentedLeaf = /^(?: {4}| {0,3}\t)/.test(container.leaf);
      const rawCandidate = rawHtmlBlockStart(container.leaf);
      const rawCanInterrupt =
        rawCandidate != null &&
        (rawCandidate.kind !== 'blank-line' ||
          rawCandidate.canInterruptParagraph ||
          !sameParagraphContainer);
      const deepContainerListBoundary = !!(
        paragraphContainer &&
        container.startsListItem &&
        paragraphContainer.listDepth > 0 &&
        container.listDepth > paragraphContainer.listDepth &&
        (paragraphContainer.listDepth > 1 ||
          paragraphContainer.containerPath.split('/').includes('q'))
      );
      const emptyListContinuesParagraph =
        paragraphOpen &&
        !startsPeerListItem &&
        !deepContainerListBoundary &&
        container.listDepth > 0 &&
        ((paragraphContainer == null &&
          container.quoteDepth === 0 &&
          container.listDepth === 1) ||
          (paragraphContainer != null &&
            paragraphContainer.quoteDepth === container.quoteDepth &&
            (sameParagraphContainer ||
              (paragraphContainer.listDepth === 0 &&
                container.listDepth > 0 &&
                container.containerPath.startsWith(
                  `${paragraphContainer.containerPath}/l`
                )) ||
              (container.listDepth === paragraphContainer.listDepth + 1 &&
                container.containerPath ===
                  `${paragraphContainer.containerPath}/l`)))) &&
        (!container.listCanInterruptParagraph ||
          (/^[ \t]*$/.test(container.leaf) &&
            ((paragraphContainer == null && container.listDepth === 1) ||
              (paragraphContainer != null &&
                container.listDepth === paragraphContainer.listDepth + 1 &&
                container.containerPath ===
                  `${paragraphContainer.containerPath}/l`))));
      if (emptyListContinuesParagraph) {
        activeListContinuationIndent = null;
        activeListContext = null;
        lines.push(raw);
        paragraphOpen = true;
        allowsIndentedCode = false;
        continue;
      }
      if (
        potentialLinkReferenceDefinition([container.leaf]) &&
        (!sameParagraphContainer || startsPeerListItem)
      ) {
        const definitionLines = linkReferenceDefinitionLines([container.leaf]);
        const outputIndex = lines.length;
        lines.push(raw);
        containerLinkDefinition = {
          context: containerContext(container),
          lines: [container.leaf],
          complete:
            definitionLines.has(0) && definitionLines.size === 1,
          outputIndices: [outputIndex],
          bufferedChars: container.leaf.length,
          failClosed: false,
        };
        if (containerLinkDefinition.complete) lines[outputIndex] = '';
        paragraphOpen = true;
        paragraphContainer = containerContext(container);
        allowsIndentedCode = false;
        continue;
      }
      if (opensFence) {
        containerFence = {
          marker: leafFence[1][0] as '`' | '~',
          length: leafFence[1].length,
          quoteDepth: container.quoteDepth,
          listContinuationIndent: container.listContinuationIndent,
        };
      }
      if (rawCanInterrupt && rawCandidate) {
        if (!rawHtmlBlockEnds(rawCandidate, container.leaf)) {
          containerRawHtmlBlock = {
            block: rawCandidate,
            context: containerContext(container),
            quoteDepth: container.quoteDepth,
            listContinuationIndent: container.listContinuationIndent,
          };
        }
        lines.push('');
        paragraphOpen = false;
        allowsIndentedCode = true;
        continue;
      }
      const leafIsBlock =
        /^[ \t]*$/.test(container.leaf) ||
        (!sameParagraphContainer && indentedLeaf) ||
        commonMarkAtxHeading(container.leaf) ||
        /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(
          container.leaf
        );
      if (opensFence || leafIsBlock) {
        // Container leaf blocks are boundaries, but their headings/content are
        // not top-level contract structure.
        lines.push('');
        paragraphOpen = false;
        allowsIndentedCode = true;
        continue;
      }
      if (sameParagraphContainer && indentedLeaf) {
        lines.push(raw);
        paragraphOpen = true;
        allowsIndentedCode = false;
        continue;
      }
      // Ordinary container text is paragraph content. A following type-7 tag
      // therefore cannot interrupt it (including lazy continuation semantics).
      lines.push(raw);
      paragraphOpen = true;
      paragraphContainer = containerContext(container);
      allowsIndentedCode = false;
      continue;
    }

    if (
      paragraphOpen &&
      paragraphContainer != null &&
      /^ {0,3}(?:=+|-{1,2})[ \t]*$/.test(raw)
    ) {
      // Under-indented text can lazily continue a paragraph inside a quote or
      // list, but it cannot become a top-level Setext underline after shedding
      // the container that owns the paragraph.
      lines.push(raw);
      allowsIndentedCode = false;
      continue;
    }

    const priorIndex = lines.length - 1;
    const physicalIndent = /^(?: {4}| {0,3}\t)/.test(raw);
    const startsLiteralIndentedBlock =
      physicalIndent &&
      !insideComment &&
      allowsIndentedCode;
    if (startsLiteralIndentedBlock) {
      // Indented code renders HTML/comment syntax literally. Establish its
      // provenance before the structure-only HTML projection below can remove
      // those characters.
      literalCodeLines.set(lines.length, 'indented');
      lines.push(raw);
      paragraphOpen = false;
      allowsIndentedCode = true;
      continue;
    }

    // CommonMark decides whether a fence opens from the physical line. Inline
    // comments are part of an info string here, and a backtick anywhere in a
    // backtick-fence info string makes that opener invalid.
    const fenceMatch = !insideComment
      ? /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(raw)
      : null;
    if (
      fenceMatch &&
      (fenceMatch[1][0] === '~' || !fenceMatch[2].includes('`'))
    ) {
      const marker = fenceMatch[1][0] as '`' | '~';
      fence = { marker, length: fenceMatch[1].length };
      paragraphOpen = false;
      allowsIndentedCode = true;
      continue;
    }

    // Raw HTML blocks are non-structural. Recognize them before comment
    // stripping so literal `<!--` text inside script/style bodies cannot leak
    // comment state into later Markdown headings.
    const priorEndsBlock = !paragraphOpen;
    const rawHtmlCandidate = !insideComment ? rawHtmlBlockStart(raw) : null;
    const rawHtmlBlockOpen =
      rawHtmlCandidate &&
      (rawHtmlCandidate.kind !== 'blank-line' ||
        rawHtmlCandidate.canInterruptParagraph ||
        priorEndsBlock)
        ? rawHtmlCandidate
        : null;
    if (rawHtmlBlockOpen) {
      if (!rawHtmlBlockEnds(rawHtmlBlockOpen, raw)) {
        rawHtmlBlock = rawHtmlBlockOpen;
      } else {
        lines.push('');
      }
      paragraphOpen = false;
      allowsIndentedCode = true;
      continue;
    }

    const startedInsideComment = insideComment;
    const stripped = stripHtmlComments(raw, insideComment);
    insideComment = stripped.insideComment;
    const visible = stripped.line;
    // Block structure is determined from the physical Markdown line before
    // inline HTML is removed. If an inline comment carried in from the prior
    // line, a suffix after its terminator (for example `-->## Heading`) cannot
    // become a structural heading, so exclude the whole line from this
    // structure-only projection.
    if (startedInsideComment) continue;
    const visibleHtmlCandidate = rawHtmlBlockStart(visible);
    const rawHtmlOpen =
      visibleHtmlCandidate &&
      (visibleHtmlCandidate.kind !== 'blank-line' ||
        visibleHtmlCandidate.canInterruptParagraph ||
        priorEndsBlock)
        ? visibleHtmlCandidate
        : null;
    if (rawHtmlOpen) {
      if (!rawHtmlBlockEnds(rawHtmlOpen, visible)) rawHtmlBlock = rawHtmlOpen;
      else lines.push('');
      paragraphOpen = false;
      allowsIndentedCode = true;
      continue;
    }
    const outputIndex = lines.length;
    const atxHeading = structuralHeading(raw);
    const atxBlock = commonMarkAtxHeading(raw);
    const setextUnderline = /^ {0,3}(?:=+|-+)[ \t]*$/.test(raw);
    const validatedSetext =
      setextUnderline &&
      paragraphOpen &&
      !atxHeadingLines.has(priorIndex);
    const thematicBreak =
      !validatedSetext &&
      /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(
        raw
      );
    const emptyBlockquote = /^ {0,3}>[ \t]*$/.test(raw);
    const emptyList =
      /^ {0,3}(?:[-+*][ \t]*|\d{1,9}[.)][ \t]*)$/.test(raw);
    const continuesContainerParagraph =
      paragraphOpen && paragraphContainer != null;

    if (atxBlock) {
      if (atxHeading != null) atxHeadingLines.add(outputIndex);
      paragraphOpen = false;
      allowsIndentedCode = true;
    } else if (validatedSetext) {
      setextUnderlineLines.add(outputIndex);
      paragraphOpen = false;
      allowsIndentedCode = true;
    } else if (thematicBreak) {
      thematicBreakLines.add(outputIndex);
      paragraphOpen = false;
      allowsIndentedCode = true;
    } else if (emptyBlockquote) {
      paragraphOpen = false;
      allowsIndentedCode = true;
    } else if (emptyList && !paragraphOpen) {
      // An empty list may begin between blocks, but its ordinary four-space
      // continuation is list-item paragraph content, not top-level code.
      paragraphOpen = false;
      allowsIndentedCode = false;
    } else if (/^[ \t]*$/.test(visible)) {
      paragraphOpen = false;
      allowsIndentedCode = true;
    } else {
      paragraphOpen = true;
      if (!continuesContainerParagraph) paragraphContainer = null;
      allowsIndentedCode = false;
    }
    lines.push(visible);
  }
  return {
    lines,
    literalCodeLines,
    atxHeadingLines,
    setextUnderlineLines,
    thematicBreakLines,
  };
}

export function leaveBehindStateScope(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  const slashPath = path.replace(/\\/g, '/');
  const segments = slashPath.split('/');
  if (segments.some((segment) => segment === '..')) {
    return null;
  }
  const normalized = segments
    .filter((segment, index) => segment !== '.' && (segment !== '' || index === 0))
    .join('/')
    .replace(/\/{2,}/g, '/');
  const isAbsolute = normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized);
  const match = isAbsolute
    ? ABSOLUTE_CANONICAL_PATH_RE.exec(normalized)
    : RELATIVE_CANONICAL_PATH_RE.exec(normalized);
  return match?.[1] ?? null;
}

function structuralHeading(line: string): string | null {
  const indentation = /^[ \t]*/.exec(line)?.[0] ?? '';
  if (indentation.includes('\t') || indentation.length > 3) return null;
  // Remove only the ASCII indentation CommonMark permits. `trim()` would turn
  // a NBSP-prefixed literal line into a structural heading even though Markdown
  // renderers do not treat that character as ATX indentation.
  const heading = line.slice(indentation.length).replace(/[ \t]+$/, '');
  return /^#{1,3}(?:[ \t]+|$)/.test(heading) ? heading : null;
}

interface StructuralBoundary {
  heading: string | null;
  level: 1 | 2 | 3;
}

function permittedMarkdownIndent(line: string): number | null {
  const indentation = /^[ \t]*/.exec(line)?.[0] ?? '';
  return indentation.includes('\t') || indentation.length > 3
    ? null
    : indentation.length;
}

/** Return rendered ATX/Setext heading structure at this source line. Required
 * contract headings remain exact ATX strings; Setext headings are boundaries
 * only, so they cannot silently re-parent a required H3. */
function structuralBoundaryAt(
  lines: string[],
  atxHeadingLines: ReadonlySet<number>,
  setextUnderlineLines: ReadonlySet<number>,
  index: number
): StructuralBoundary | null {
  const atx = atxHeadingLines.has(index)
    ? structuralHeading(lines[index])
    : null;
  if (atx) {
    const level = /^#+/.exec(atx)?.[0].length;
    if (level === 1 || level === 2 || level === 3) {
      return { heading: atx, level };
    }
  }

  const nextLine = lines[index + 1];
  if (nextLine == null) return null;
  if (!setextUnderlineLines.has(index + 1)) return null;
  const underlineIndent = permittedMarkdownIndent(nextLine);
  if (underlineIndent == null) return null;
  const underline = nextLine
    .slice(underlineIndent)
    .replace(/[ \t]+$/, '');
  if (/^=+$/.test(underline)) return { heading: null, level: 1 };
  if (/^-+$/.test(underline)) return { heading: null, level: 2 };
  return null;
}

type RequiredSection = {
  heading: string;
  error: LeaveBehindValidationError;
  parent: typeof OPERABILITY_HEADING | typeof DECISION_LOG_HEADING;
  requireMapping?: boolean;
};

const REQUIRED_CONTENT_SECTIONS: readonly RequiredSection[] = [
  {
    heading: OPERABILITY_SUBHEADINGS[0],
    error: 'empty-state-and-access',
    parent: OPERABILITY_HEADING,
  },
  {
    heading: OPERABILITY_SUBHEADINGS[1],
    error: 'empty-template-map',
    parent: OPERABILITY_HEADING,
    requireMapping: true,
  },
  {
    heading: OPERABILITY_SUBHEADINGS[2],
    error: 'empty-re-run',
    parent: OPERABILITY_HEADING,
  },
  {
    heading: OPERABILITY_SUBHEADINGS[3],
    error: 'empty-verify-and-recover',
    parent: OPERABILITY_HEADING,
  },
  {
    heading: DECISION_LOG_SUBHEADINGS[0],
    error: 'empty-decisions',
    parent: DECISION_LOG_HEADING,
  },
  {
    heading: DECISION_LOG_SUBHEADINGS[1],
    error: 'empty-how-to-drive-it',
    parent: DECISION_LOG_HEADING,
  },
];

function contractFrontmatter(markdown: string): {
  version: string;
  stateScope: string;
  status: string;
} | null {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.replace(/^\uFEFF/, '') !== '---') return null;
  const end = lines.slice(1).findIndex((line) => line === '---');
  if (end < 0) return null;
  // The published contract says this frontmatter must match exactly. Keep the
  // accepted grammar deliberately smaller than YAML: three ordered, unquoted,
  // top-level scalar rows. That fails closed on nested/duplicate/quoted/explicit
  // keys instead of needing a full YAML parser in the browser upload path.
  const rows = lines.slice(1, end + 1);
  const prefixes = ['leave-behind: ', 'state-scope: ', 'status: '] as const;
  if (
    rows.length !== prefixes.length ||
    rows.some((row, index) => !row.startsWith(prefixes[index]))
  ) {
    return null;
  }
  return {
    version: rows[0].slice(prefixes[0].length).replace(/[ \t]+$/, ''),
    stateScope: rows[1].slice(prefixes[1].length).replace(/[ \t]+$/, ''),
    status: rows[2].slice(prefixes[2].length).replace(/[ \t]+$/, ''),
  };
}

interface SectionContentLine {
  text: string;
  literalCodeKind: LiteralCodeKind | null;
}

interface SectionContent {
  text: string;
  lines: SectionContentLine[];
}

function sectionContent(
  lines: string[],
  literalCodeLines: ReadonlyMap<number, LiteralCodeKind>,
  atxHeadingLines: ReadonlySet<number>,
  setextUnderlineLines: ReadonlySet<number>,
  thematicBreakLines: ReadonlySet<number>,
  heading: string
): SectionContent | null {
  const matches = lines
    .map((line, index) =>
      atxHeadingLines.has(index) && structuralHeading(line) === heading
        ? index
        : -1
    )
    .filter((index) => index >= 0);
  if (matches.length !== 1) return null;
  const start = matches[0] + 1;
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (
      structuralBoundaryAt(
        lines,
        atxHeadingLines,
        setextUnderlineLines,
        index
      )
    ) {
      end = index;
      break;
    }
  }
  const contentLines = lines
    .slice(start, end)
    // Preserve leading indentation so callers can distinguish rendered prose
    // from continuation lines in link-reference definitions and fenced code.
    .map((line, offset) => ({
      text: line.trimEnd(),
      literalCodeKind: literalCodeLines.get(start + offset) ?? null,
      thematicBreak: thematicBreakLines.has(start + offset),
    }))
    .filter((line) => line.text.trim().length > 0 && !line.thematicBreak);
  return {
    text: contentLines.map((line) => line.text).join('\n'),
    lines: contentLines,
  };
}

function hasSubstantiveMarkdownText(content: SectionContent): boolean {
  // A section made of several placeholder rows is still empty. Normalize each
  // rendered line independently instead of letting the newline/list syntax make
  // `- TODO\n- TBD` look like one novel, substantive string.
  // Raw HTML is markup only on ordinary Markdown lines. Its spelling remains
  // visible inside fenced/indented code, so keep literal lines out of the HTML
  // projection and test them directly below.
  if (content.text.length > MAX_MARKDOWN_SECTION_PROJECTION_CHARS) {
    return false;
  }
  const ordinary = content.lines
    .map((line) => (line.literalCodeKind == null ? line.text : ''))
    .join('\n');
  const visibleOrdinary = stripInlineHtmlTags(ordinary);
  if (visibleOrdinary == null) return false;
  // Inline destinations and titles may span physical lines. Project wrappers
  // across the whole ordinary section before judging rows independently, or a
  // hidden title continuation can masquerade as visible prose on its own row.
  const projectedOrdinary = renderedMarkdownLinkText(visibleOrdinary);
  const renderedLines = [
    ...projectedOrdinary.split('\n'),
    ...content.lines
      .filter((line) => line.literalCodeKind != null)
      .map((line) => line.text),
  ];
  return renderedLines.some((line) => {
    const normalized = normalizePlaceholder(line);
    return !isPlaceholderOnly(normalized) && /[\p{L}\p{N}]/u.test(normalized);
  });
}

function isPlaceholderOnly(content: string): boolean {
  const tokens = content
    .replace(/\bn\s*\/\s*a\b/gi, ' placeholder ')
    .replace(/\bcoming\s+soon\b/gi, ' placeholder ')
    .replace(/\b(?:and|or)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return (
    tokens.length > 0 &&
    tokens.every((token) => /^(?:tbd|todo|none|placeholder)$/i.test(token))
  );
}

interface InlineHtmlAttribute {
  name: string;
  value: string | null;
}

function inlineHtmlAttributes(source: string): InlineHtmlAttribute[] | null {
  const attributes: InlineHtmlAttribute[] = [];
  let index = 0;
  while (index < source.length) {
    while (/[ \t\r\n]/.test(source[index] ?? '')) index += 1;
    if (index >= source.length || source[index] === '/') break;
    const start = index;
    while (!/[ \t\r\n=/>]/.test(source[index] ?? '>')) index += 1;
    if (index === start) {
      index += 1;
      continue;
    }
    const name = source.slice(start, index).toLowerCase();
    while (/[ \t\r\n]/.test(source[index] ?? '')) index += 1;
    let value: string | null = null;
    if (source[index] === '=') {
      index += 1;
      while (/[ \t\r\n]/.test(source[index] ?? '')) index += 1;
      const quote =
        source[index] === '"' || source[index] === "'" ? source[index] : null;
      if (quote) {
        index += 1;
        const valueStart = index;
        while (index < source.length && source[index] !== quote) index += 1;
        value = source.slice(valueStart, index);
        if (source[index] === quote) index += 1;
      } else {
        const valueStart = index;
        while (!/[ \t\r\n>]/.test(source[index] ?? '>')) index += 1;
        value = source.slice(valueStart, index);
      }
    }
    if (attributes.length >= MAX_INLINE_HTML_ATTRIBUTES) return null;
    attributes.push({ name, value });
  }
  return attributes;
}

function htmlElementSuppressesText(
  name: string,
  attributes: readonly InlineHtmlAttribute[]
): boolean {
  // Count prose only through elements whose text is unconditionally exposed by
  // a normal rendered document. Replaced, fallback, closed-by-default,
  // metadata, and scripting-dependent elements deliberately fail closed: text
  // inside them can exist in the DOM while contributing nothing to innerText.
  // Unknown/custom elements fail closed too, rather than turning this proof
  // into an ever-growing blacklist of browser-specific non-rendering contexts.
  const renderedTextContainers = /^(?:a|abbr|address|article|aside|b|bdi|bdo|blockquote|body|button|caption|cite|code|data|dd|del|dfn|div|dl|dt|em|fieldset|figcaption|figure|footer|form|h[1-6]|header|hgroup|html|i|ins|kbd|label|legend|li|main|map|mark|menu|nav|ol|output|p|picture|pre|q|ruby|rt|s|samp|search|section|slot|small|span|strong|sub|summary|sup|table|tbody|td|tfoot|th|thead|time|tr|u|ul|var)$/;
  if (!renderedTextContainers.test(name)) return true;
  if (
    attributes.some(({ name: attribute }) =>
      /^(?:hidden|inert|popover)$/.test(attribute)
    )
  ) {
    return true;
  }
  if (
    attributes
      .filter(({ name: attribute }) => attribute === 'aria-hidden')
      .some(
        ({ value }) =>
          decodeCharacterReferences(value ?? '').trim().toLowerCase() !==
          'false'
      )
  ) {
    return true;
  }
  // Arbitrary CSS visibility is not statically provable here. Fail closed on
  // every inline style rather than maintaining an incomplete hiding-property
  // allowlist that can be bypassed with opacity, clipping, positioning, etc.
  return attributes.some(({ name: attribute }) => attribute === 'style');
}

/** Remove inline HTML markup and content that does not render as prose.
 * Scan quoted attributes so a valid `<span title=">">TODO</span>` wrapper
 * cannot leave the tag name behind as apparently substantive prose. Autolinks
 * such as `<https://example.test>` are preserved because `:` cannot follow an
 * HTML tag name. */
function stripInlineHtmlTags(content: string): string | null {
  const visible: string[] = [];
  let index = 0;
  const openElements: Array<{
    name: string;
    suppressesText: boolean;
    rawText: boolean;
  }> = [];
  let suppressedDepth = 0;
  const append = (text: string): boolean => {
    if (suppressedDepth > 0 || text.length === 0) return true;
    if (visible.length >= MAX_INLINE_HTML_OUTPUT_PARTS) return false;
    visible.push(text);
    return true;
  };
  while (index < content.length) {
    if (content[index] !== '<') {
      const nextTag = content.indexOf('<', index);
      const end = nextTag < 0 ? content.length : nextTag;
      if (!append(content.slice(index, end))) return null;
      index = end;
      continue;
    }
    const currentRawText = openElements.at(-1)?.rawText
      ? openElements.at(-1)?.name
      : null;
    if (
      currentRawText &&
      !content
        .slice(index, index + currentRawText.length + 2)
        .toLowerCase()
        .startsWith(`</${currentRawText}`)
    ) {
      // Script/style/textarea bodies are raw text rather than nested markup.
      // Only their matching end tag can leave the suppressed region.
      index += 1;
      continue;
    }
    const comment = content.startsWith('<!--', index);
    const processingInstruction = content.startsWith('<?', index);
    const cdata = content.startsWith('<![CDATA[', index);
    const declaration = content.startsWith('<!', index);
    const specialEnd = comment
      ? content.indexOf('-->', index + 4)
      : processingInstruction
        ? content.indexOf('?>', index + 2)
        : cdata
          ? content.indexOf(']]>', index + 9)
          : declaration
            ? content.indexOf('>', index + 2)
            : -2;
    if (specialEnd !== -2) {
      // Processing instructions, declarations, CDATA, and comments do not
      // contribute rendered prose. An unterminated candidate is discarded
      // conservatively rather than letting its payload satisfy the contract.
      if (specialEnd < 0) break;
      const tokenLength = comment || cdata ? 3 : processingInstruction ? 2 : 1;
      index = specialEnd + tokenLength;
      continue;
    }
    let cursor = index + 1;
    const closing = content[cursor] === '/';
    if (closing) cursor += 1;
    const nameStart = cursor;
    while (/[A-Za-z0-9-]/.test(content[cursor] ?? '')) cursor += 1;
    if (
      cursor === nameStart ||
      !/[A-Za-z]/.test(content[nameStart]) ||
      !/[\s/>]/.test(content[cursor] ?? '')
    ) {
      if (!append('<')) return null;
      index += 1;
      continue;
    }
    const name = content.slice(nameStart, cursor).toLowerCase();
    const attributesStart = cursor;
    let quote: '"' | "'" | null = null;
    let closed = false;
    let tagEnd = cursor;
    for (; cursor < content.length; cursor += 1) {
      if (cursor - index > MAX_INLINE_HTML_TAG_CHARS) return null;
      const char = content[cursor];
      if (quote) {
        if (char === quote) quote = null;
        continue;
      }
      // A raw `<` is forbidden in an unquoted HTML attribute value. Stop this
      // malformed candidate at the next opener instead of rescanning the rest
      // of the Write once for every `<tag ` prefix.
      if (char === '<') break;
      if (char === '"' || char === "'") {
        quote = char;
        continue;
      }
      if (char === '>') {
        closed = true;
        tagEnd = cursor;
        cursor += 1;
        break;
      }
    }
    if (!closed) {
      if (!append('<')) return null;
      index += 1;
      continue;
    }
    const tagSource = content.slice(attributesStart, tagEnd);
    if (closing) {
      // Match only the current element. Treat malformed cross-nesting as still
      // hidden rather than repeatedly searching a deep stack or accidentally
      // exposing text that the browser may keep under the hidden ancestor.
      const open = openElements.at(-1);
      if (open?.name === name) {
        openElements.pop();
        if (open.suppressesText) suppressedDepth -= 1;
      }
    } else {
      const voidElement = /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(
        name
      );
      // In HTML syntax, a self-closing slash on a non-void element is ignored.
      // `<span hidden/>text` therefore keeps `text` in the hidden span.
      if (!voidElement) {
        if (openElements.length >= MAX_INLINE_HTML_NESTING) return null;
        const attributes = inlineHtmlAttributes(tagSource);
        if (attributes == null) return null;
        const suppressesText = htmlElementSuppressesText(
          name,
          attributes
        );
        openElements.push({
          name,
          suppressesText,
          rawText: /^(?:script|style|textarea|title|iframe|noembed|noframes)$/.test(
            name
          ),
        });
        if (suppressesText) suppressedDepth += 1;
      }
    }
    index = cursor;
  }
  return visible.join('');
}

/** Index the next equal-length backtick run for every possible opener in one
 * pass. Consumers may start at any run, so overlapping A->B and B->C entries
 * are intentional; a forward renderer that consumes A->B never revisits B.
 * Keeping the index per source bounds malformed, unmatched-run input to O(n)
 * instead of rescanning the remainder once for every distinct run length. */
function codeSpanClosingMarkers(
  content: string
): ReadonlyMap<number, number> | null {
  const runs: Array<{ start: number; length: number }> = [];
  for (let index = 0; index < content.length; ) {
    if (content[index] !== '`') {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (content[end] === '`') end += 1;
    if (runs.length >= MAX_MARKDOWN_CODE_SPAN_RUNS) return null;
    runs.push({ start: index, length: end - index });
    index = end;
  }

  const nextByLength = new Map<number, number>();
  const closingByStart = new Map<number, number>();
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    const run = runs[index];
    const closing = nextByLength.get(run.length);
    if (closing != null) closingByStart.set(run.start, closing);
    nextByLength.set(run.length, run.start);
  }
  return closingByStart;
}

/** Project the deliberately small mapping grammar to rendered text. The
 * contract accepts plain text plus inline/fenced code only. Any square-bracket,
 * HTML/autolink, block-container, or multiline-wrapper surface fails closed in
 * {@link renderedMappingLines}; proving all of CommonMark would be larger and
 * less auditable than the leave-behind signal warrants. */
function renderedStaticMappingText(
  content: string,
  codeSpanClosers = codeSpanClosingMarkers(content)
): string | null {
  if (codeSpanClosers == null) return null;
  let visible = '';
  let plain = '';
  const flushPlain = () => {
    visible += decodeCharacterReferences(plain);
    plain = '';
  };

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (char === '\\' && /[!-/:-@[-`{-~]/.test(content[index + 1] ?? '')) {
      plain += content[index + 1];
      index += 1;
      continue;
    }
    if (char === '`') {
      let markerEnd = index + 1;
      while (content[markerEnd] === '`') markerEnd += 1;
      const markerLength = markerEnd - index;
      const end = codeSpanClosers.get(index) ?? null;
      if (end == null) {
        plain += content.slice(index, markerEnd);
        index = markerEnd - 1;
        continue;
      }
      flushPlain();
      // Multiline spans fail closed before projection, so preserve same-line
      // spaces/tabs exactly. CommonMark removes at most one U+0020 from each
      // edge (when both exist and the body is not all spaces); collapsing a
      // wider run first could fabricate a visible `->` that is not rendered.
      let code = content.slice(markerEnd, end);
      if (
        code.startsWith(' ') &&
        code.endsWith(' ') &&
        /[^ ]/.test(code)
      ) {
        code = code.slice(1, -1);
      }
      visible += code;
      index = end + markerLength - 1;
      continue;
    }
    plain += char;
  }
  flushPlain();
  return visible;
}

function renderedMappingLines(lines: readonly SectionContentLine[]): string[] {
  const rendered: string[] = [];
  for (const contentLine of lines) {
    const line = contentLine.text;
    if (contentLine.literalCodeKind === 'fenced') {
      // visibleMarkdownLines adds exactly four spaces so fenced Markdown cannot
      // become structure. Fence provenance proves the raw body is literal, so
      // remove only that synthetic prefix and retain brackets/HTML verbatim.
      rendered.push(line.slice(4));
      continue;
    }
    if (contentLine.literalCodeKind === 'indented') {
      // A physical indented block is literal only when source context proves
      // it starts after a block boundary (or continues a proven code block).
      rendered.push(line.replace(/^(?: {4}| {0,3}\t)/, ''));
      continue;
    }
    // Four-space/tab indentation is literal code only when block context proves
    // it did not continue a paragraph. Since section extraction intentionally
    // drops blank rows, fail closed on link/HTML ambiguity before accepting an
    // indented raw mapping.
    const indentedCode = /^(?: {4}| {0,3}\t)/.test(line);
    if (
      indentedCode &&
      (line.includes('[') || line.includes(']') || line.includes('<'))
    ) {
      return [];
    }
    // An unproven indented line may be a paragraph continuation. Direct arrows
    // remain visible there, but links/HTML above stay fail-closed.
    if (indentedCode) {
      const projected = renderedStaticMappingText(line);
      if (projected == null) return [];
      rendered.push(projected);
      continue;
    }
    // Reject all ambiguous block/inline constructs outside code spans. This
    // covers links and definitions (including container/multiline forms),
    // autolinks/HTML, and multiline inline destinations without attempting a
    // partial CommonMark parser.
    if (/^ {0,3}(?:>|[-+*]|\d+[.)])[ \t]/.test(line)) return [];
    const codeSpanClosers = codeSpanClosingMarkers(line);
    if (codeSpanClosers == null) return [];
    let ambiguous = false;
    for (let index = 0; index < line.length; index += 1) {
      if (
        line[index] === '\\' &&
        /[!-/:-@[-`{-~]/.test(line[index + 1] ?? '')
      ) {
        index += 1;
        continue;
      }
      if (line[index] === '`') {
        let markerEnd = index + 1;
        while (line[markerEnd] === '`') markerEnd += 1;
        const markerLength = markerEnd - index;
        const end = codeSpanClosers.get(index) ?? null;
        if (end == null) return [];
        index = end + markerLength - 1;
        continue;
      }
      // Raw bracket/HTML ambiguity was rejected above; this branch remains a
      // guard for future accepted-markup changes.
      if (line[index] === '[' || line[index] === ']' || line[index] === '<') {
        ambiguous = true;
        break;
      }
    }
    if (ambiguous) return [];
    const projected = renderedStaticMappingText(line, codeSpanClosers);
    if (projected == null) return [];
    rendered.push(projected);
  }
  return rendered;
}

function hasSubstantiveRenderedText(content: string): boolean {
  const normalized = content
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .trim();
  return (
    !isPlaceholderOnly(normalized) && /[\p{L}\p{N}]/u.test(normalized)
  );
}

/** Keep rendered link/alt text while discarding inline destinations and
 * reference labels. The scan advances past each complete wrapper, avoiding the
 * repeated unanchored bracket searches that make malformed Markdown quadratic. */
function markdownClosingBracket(
  content: string,
  open: number,
  codeSpanClosers: ReadonlyMap<number, number>
): number | null {
  let depth = 1;
  for (let index = open + 1; index < content.length; index += 1) {
    if (
      content[index] === '\\' &&
      /[!-/:-@[-`{-~]/.test(content[index + 1] ?? '')
    ) {
      index += 1;
      continue;
    }
    if (content[index] === '`') {
      let markerEnd = index + 1;
      while (content[markerEnd] === '`') markerEnd += 1;
      const markerLength = markerEnd - index;
      const end = codeSpanClosers.get(index) ?? null;
      if (end != null) {
        index = end + markerLength - 1;
        continue;
      }
      // No equal-length closer exists. Skip this complete run so a long
      // unmatched delimiter is not rescanned once per constituent backtick.
      index = markerEnd - 1;
      continue;
    }
    if (content[index] === '[') depth += 1;
    else if (content[index] === ']' && --depth === 0) return index;
  }
  return null;
}

function markdownInlineLinkEnd(content: string, open: number): number | null {
  let depth = 1;
  let quote: '"' | "'" | null = null;
  let angleDestination = false;
  for (let index = open + 1; index < content.length; index += 1) {
    const char = content[index];
    if (char === '\\' && /[!-/:-@[-`{-~]/.test(content[index + 1] ?? '')) {
      index += 1;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (angleDestination) {
      if (char === '>') angleDestination = false;
      continue;
    }
    if (char === '<') {
      angleDestination = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')' && --depth === 0) return index;
  }
  return null;
}

function renderedMarkdownLinkText(content: string): string {
  let visible = '';
  let index = 0;
  const codeSpanClosers = codeSpanClosingMarkers(content);
  if (codeSpanClosers == null) return '';
  while (index < content.length) {
    const image = content[index] === '!' && content[index + 1] === '[';
    if (content[index] !== '[' && !image) {
      visible += content[index];
      index += 1;
      continue;
    }
    const open = image ? index + 1 : index;
    const close = markdownClosingBracket(content, open, codeSpanClosers);
    if (close == null) {
      visible += content.slice(index);
      break;
    }
    const rendered = content.slice(open + 1, close);
    const suffix = content[close + 1];
    if (suffix === '(') {
      const end = markdownInlineLinkEnd(content, close + 1);
      if (end == null) {
        // A link-looking but malformed destination is ambiguous. Keep only
        // text that would be visible if the wrapper were completed; never let
        // destination bytes turn a placeholder label into substantive prose.
        visible += rendered;
        break;
      }
      visible += rendered;
      index = end + 1;
      continue;
    }
    if (suffix === '[') {
      const end = markdownClosingBracket(
        content,
        close + 1,
        codeSpanClosers
      );
      if (end == null) {
        visible += rendered;
        break;
      }
      visible += rendered;
      index = end + 1;
      continue;
    }
    // Shortcut reference links render their bracketed label as visible text.
    visible += rendered;
    index = close + 1;
  }
  return visible;
}

function hasUsableSectionContent(
  content: SectionContent | null,
  requireMapping = false
): boolean {
  if (!content || !hasSubstantiveMarkdownText(content)) return false;
  if (!requireMapping) return true;
  return renderedMappingLines(content.lines).some((rendered) => {
    for (
      let arrow = rendered.indexOf('->');
      arrow >= 0;
      arrow = rendered.indexOf('->', arrow + 2)
    ) {
      if (
        hasSubstantiveRenderedText(rendered.slice(0, arrow)) &&
        hasSubstantiveRenderedText(rendered.slice(arrow + 2))
      ) {
        return true;
      }
    }
    return false;
  });
}

function decodeCharacterReferences(content: string): string {
  const namedPunctuation: Record<string, string> = {
    AMP: '&',
    GT: '>',
    LT: '<',
    QUOT: '"',
    amp: '&',
    apos: "'",
    colon: ':',
    gt: '>',
    hellip: '…',
    lt: '<',
    quot: '"',
  };
  return content
    .replace(
      /&#(?:x([0-9a-f]{1,6})|(\d{1,7}));/gi,
      (_entity, hex: string, decimal: string) => {
        const codePoint = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
        if (
          !Number.isInteger(codePoint) ||
          codePoint === 0 ||
          codePoint > 0x10ffff ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) {
          return '\uFFFD';
        }
        return String.fromCodePoint(codePoint);
      }
    )
    .replace(
      /&(AMP|GT|LT|QUOT|amp|apos|colon|gt|hellip|lt|quot);/g,
      (_entity, name: string) => namedPunctuation[name]
    )
    .replace(/&(?:nbsp|Tab|NewLine);/g, ' ')
    .replace(
      /&(?:ZeroWidthSpace|zwnj|zwj|lrm|rlm|NoBreak|af|ApplyFunction|InvisibleTimes|it|ic|InvisibleComma|shy);/g,
      ''
    )
    .replace(/&[A-Za-z][A-Za-z0-9]+;/g, ' ');
}

function normalizePlaceholder(content: string): string {
  // Strip any number of common quote/list/task prefixes and inline emphasis
  // delimiters in a fixed number of linear passes. Repeatedly peeling one
  // wrapper makes adversarially nested Markdown quadratic in the Write size.
  let normalized = content
    .split('\n')
    // Link-reference definitions do not render as section prose. Keeping one
    // in the final section must not make a rendered `[TODO][ref]` substantive.
    .filter((line) => !/^ {0,3}\[[^\]]+\]:[ \t]*\S/.test(line))
    .join('\n')
    .trim()
    .replace(/^(?:(?:>\s*)|(?:(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?))+/, '')
    .trim()
    .replace(/^ {0,3}#{1,6}(?:[ \t]+|$)/, '')
    .replace(/[ \t]+#{1,}[ \t]*$/, '')
    .trim()
    .replace(/<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?>/g, '');
  const stripInlineDelimiters = (value: string): string =>
    value
      .trim()
      .replace(/^[`*_~]+/, '')
      .replace(/[`*_~:!.,;?]+$/, '')
      .trim();

  // Keep rendered link text while removing wrappers that would otherwise make
  // `[TODO](#)`, `[TODO][ref]`, or `**[TODO](#)**` look substantive. These are
  // whole-body matches: an unanchored `[^]]*` scan can become quadratic on a
  // large malformed Write containing many `[` characters.
  normalized = renderedMarkdownLinkText(normalized)
    // Project links before resolving escapes: an escaped `\)` remains part of
    // the destination and must not masquerade as its closing delimiter.
    // Outside wrappers, CommonMark escapes still render the punctuation, so
    // `TODO\:` is the same placeholder as `TODO:`.
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(/^!?\[([^\]\n]*)\]\([^\n)]*\)$/, '$1')
    .replace(/^!?\[([^\]\n]*)\]\[[^\]\n]*\]$/, '$1')
    .replace(/^!?\[([^\]\n]*)\]$/, '$1')
    // Inline emphasis, code, and strikethrough delimiters do not add rendered
    // prose. Remove them throughout so T*O*DO / T`O`DO / T~~O~~DO remain TODO.
    .replace(/[`*_~]/g, '')
    // Zero-width/default-ignorable code points likewise cannot make a visually
    // empty placeholder substantive (including decoded numeric entities).
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '');
  // Character references are decoded after link projection: a numeric `)` in
  // a destination renders as that character but is not a Markdown delimiter.
  // Unknown named references cannot supply useful prose.
  normalized = decodeCharacterReferences(normalized).replace(
    /\p{Default_Ignorable_Code_Point}/gu,
    ''
  );
  return stripInlineDelimiters(normalized);
}

function exactHeadingIndices(
  lines: string[],
  atxHeadingLines: ReadonlySet<number>,
  heading: string
): number[] {
  return lines
    .map((line, index) =>
      atxHeadingLines.has(index) && structuralHeading(line) === heading
        ? index
        : -1
    )
    .filter((index) => index >= 0);
}

function hasValidHeadingHierarchy(
  lines: string[],
  atxHeadingLines: ReadonlySet<number>,
  setextUnderlineLines: ReadonlySet<number>
): boolean {
  const orderedHeadings = [
    LEAVE_BEHIND_CONTRACT.operabilityHeading,
    ...REQUIRED_CONTENT_SECTIONS.filter(
      (section) => section.parent === LEAVE_BEHIND_CONTRACT.operabilityHeading
    ).map((section) => section.heading),
    LEAVE_BEHIND_CONTRACT.decisionLogHeading,
    ...REQUIRED_CONTENT_SECTIONS.filter(
      (section) => section.parent === LEAVE_BEHIND_CONTRACT.decisionLogHeading
    ).map((section) => section.heading),
  ];
  const occurrences = orderedHeadings.map((heading) =>
    exactHeadingIndices(lines, atxHeadingLines, heading)
  );
  if (occurrences.some((matches) => matches.length > 1)) return false;
  if (occurrences.some((matches) => matches.length === 0)) return true;

  const indices = occurrences.map(([index]) => index);
  if (indices.some((index, position) => position > 0 && index <= indices[position - 1])) {
    return false;
  }

  for (const section of REQUIRED_CONTENT_SECTIONS) {
    const index = exactHeadingIndices(
      lines,
      atxHeadingLines,
      section.heading
    )[0];
    let parent: string | undefined;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const boundary = structuralBoundaryAt(
        lines,
        atxHeadingLines,
        setextUnderlineLines,
        cursor
      );
      if (!boundary || boundary.level > 2) continue;
      if (boundary.level === 2 && boundary.heading) parent = boundary.heading;
      break;
    }
    if (parent !== section.parent) return false;
  }
  return true;
}

export function validateLeaveBehindArtifact(
  input: LeaveBehindValidationInput
): LeaveBehindValidationResult {
  if (!input.required) return { status: 'not-required', errors: [] };

  const errors: LeaveBehindValidationError[] = [];
  const stateScope = leaveBehindStateScope(input.path) ?? undefined;
  if (!stateScope) errors.push('invalid-path');

  if (
    typeof input.content !== 'string' ||
    input.content.length > MAX_LEAVE_BEHIND_ARTIFACT_CHARS ||
    input.content.trim().length === 0
  ) {
    // Reject before line splitting or CommonMark projection: a transcript may
    // be valid at the ingest ceiling while containing millions of tiny lines,
    // which would otherwise amplify into unbounded line/context records.
    errors.push('invalid-content');
  } else {
    const markdown = input.content;
    const {
      lines,
      literalCodeLines,
      atxHeadingLines,
      setextUnderlineLines,
      thematicBreakLines,
    } = visibleMarkdownLines(markdown);
    const frontmatter = contractFrontmatter(markdown);
    if (frontmatter?.version !== LEAVE_BEHIND_CONTRACT.version) {
      errors.push('invalid-version');
    }
    if (frontmatter?.status !== 'current') {
      errors.push('invalid-status');
    }
    if (
      stateScope &&
      frontmatter?.stateScope !== stateScope
    ) {
      errors.push('state-scope-mismatch');
    }

    const operability = lines.findIndex(
      (line, index) =>
        atxHeadingLines.has(index) &&
        structuralHeading(line) === LEAVE_BEHIND_CONTRACT.operabilityHeading
    );
    const decisionLog = lines.findIndex(
      (line, index) =>
        atxHeadingLines.has(index) &&
        structuralHeading(line) === LEAVE_BEHIND_CONTRACT.decisionLogHeading
    );
    if (operability < 0) errors.push('missing-operability');
    if (decisionLog < 0) errors.push('missing-decision-log');
    if (
      operability >= 0 &&
      decisionLog >= 0 &&
      !hasValidHeadingHierarchy(
        lines,
        atxHeadingLines,
        setextUnderlineLines
      )
    ) {
      errors.push('invalid-section-order');
    }

    for (const section of REQUIRED_CONTENT_SECTIONS) {
      if (
        !hasUsableSectionContent(
          sectionContent(
            lines,
            literalCodeLines,
            atxHeadingLines,
            setextUnderlineLines,
            thematicBreakLines,
            section.heading
          ),
          section.requireMapping
        )
      ) {
        errors.push(section.error);
      }
    }
  }

  if (input.trackedAtHead === false) errors.push('not-tracked-at-head');
  if (errors.length > 0) return { status: 'invalid', stateScope, errors };
  return {
    status: input.trackedAtHead === true ? 'conformant' : 'candidate',
    stateScope,
    errors,
  };
}

/** Minimal shape shared by the detector without importing parser modules. */
export interface LeaveBehindWriteObservation {
  toolName: string;
  input: { file_path?: unknown };
  isError: boolean | null;
  leaveBehindStructure?: 'v1';
  /** Canonical path mutation derived from the full raw Bash command before the
   * bulk dataset strips and newline-flattens that command. */
  leaveBehindMutationPath?: unknown;
  leaveBehindMutationPaths?: unknown;
  leaveBehindMutationPathsTruncated?: unknown;
}

export interface LeaveBehindWriteTransition {
  /** Stable key shared by relative and absolute aliases of the same artifact. */
  key: string;
  /** Original observed path retained for human-facing candidate evidence. */
  path: string;
  /** Exact parsed field that proved the observed path mutation. */
  field:
    | 'input.file_path'
    | 'leaveBehindMutationPath'
    | 'leaveBehindMutationPaths';
  stateScope: string;
  status: 'candidate' | 'invalidated';
}

type StaticShellToken =
  | { kind: 'word'; value: string }
  | { kind: 'separator'; value: string }
  | { kind: 'redirect'; value: string; fd?: number };

/** Successful aggregate Bash status proves a file mutation only when argv is
 * fully static. Parameter/command/brace/pathname expansion can synthesize a
 * query or interactive option after parsing (including after the path, because
 * GNU utilities permute options). Reject every expansion-bearing command from
 * this deliberately sparse proof; quoted literals remain acceptable. */
export function hasUnprovenShellExpansion(command: string): boolean {
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let atWordStart = true;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      escaped = false;
      atWordStart = false;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (char === '\\' && /[$`"\\\n\r]/.test(command[index + 1] ?? '')) {
        escaped = true;
        continue;
      }
      if (char === '"') {
        quote = null;
        continue;
      }
      // Within an already-open double quote, `$"` is a literal dollar followed
      // by the quote terminator; it is not Bash's unquoted gettext opener.
      if (char === '$' && command[index + 1] === '"') continue;
      if (char === '$' || char === '`') return true;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      atWordStart = false;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      atWordStart = false;
      continue;
    }
    if (
      (char === '~' && atWordStart) ||
      char === '$' ||
      char === '`' ||
      char === '*' ||
      char === '?' ||
      char === '[' ||
      char === '{' ||
      char === '(' ||
      char === ')'
    ) {
      return true;
    }
    atWordStart = /[\s;|&]/.test(char);
  }
  return false;
}

function hasCurrentShellHeredocSubstitution(body: string): boolean {
  for (let index = 0; index < body.length; index += 1) {
    if (body[index] === '\\') {
      // In an expansion-enabled heredoc, backslash quotes only the next `\\`,
      // `$`, backtick, or line ending. Skipping one character also preserves
      // the correct parity for `\\\\$value`.
      if (/[\\$`\n\r]/.test(body[index + 1] ?? '')) index += 1;
      continue;
    }
    // Bash 5.3's `${ command; }` / `${| command; }` substitutions execute in
    // the current shell, so `exit 0` can suppress the target command while the
    // aggregate status stays successful. Ordinary heredoc expansion only
    // supplies stdin and cannot synthesize argv options; keep accepting it.
    if (
      body[index] === '$' &&
      body[index + 1] === '{' &&
      /[\s|]/.test(body[index + 2] ?? '')
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Tokenize only the static shell surface needed to prove a canonical-path
 * mutation. Quoted operators stay inside words, so `echo 'rm docs/runbooks/…'`
 * cannot fabricate an invalidation. Dynamic paths and nested command/process
 * substitutions fail closed because their status is not the outer Bash status.
 */
function staticShellTokens(command: string): StaticShellToken[] {
  const tokens: StaticShellToken[] = [];
  let word = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  const pushWord = () => {
    if (!word) return;
    tokens.push({ kind: 'word', value: word });
    word = '';
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) {
      word += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      if (quote !== '"' || /[$`"\\\n\r]/.test(command[index + 1] ?? '')) {
        escaped = true;
      } else {
        // In double quotes Bash preserves a backslash before ordinary
        // characters. Retain it so `"docs\\/runbooks/..."` cannot alias the
        // slash-only canonical path.
        word += '\\';
      }
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
      continue;
    }
    if (
      char === '`' ||
      (char === '$' && command[index + 1] === '(') ||
      ((char === '<' || char === '>') && command[index + 1] === '(')
    ) {
      pushWord();
      if (char !== '`') index += 1;
      tokens.push({ kind: 'separator', value: 'nested-command' });
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '#' && word.length === 0) {
      while (index + 1 < command.length && command[index + 1] !== '\n') index += 1;
      continue;
    }
    if (/\s/.test(char)) {
      pushWord();
      if (
        char === '\n' &&
        !['|', '|&'].includes(
          tokens.at(-1)?.kind === 'separator' ? tokens.at(-1)!.value : ''
        )
      ) {
        tokens.push({ kind: 'separator', value: '\n' });
      }
      continue;
    }
    if (char === '<' && command[index + 1] === '>') {
      pushWord();
      index += 1;
      tokens.push({ kind: 'separator', value: '<>' });
      continue;
    }
    if (char === '&' && command[index + 1] === '>') {
      // Bash's `&>file` / `&>>file` forms redirect stdout and stderr together.
      // Model the stdout side: truncation mutates on open, while append still
      // needs static proof that the command produces at least one byte.
      pushWord();
      const append = command[index + 2] === '>';
      index += append ? 2 : 1;
      tokens.push({ kind: 'redirect', value: append ? '>>' : '>' });
      continue;
    }
    if (char === '<') {
      // Input redirections do not mutate their target. Keep the operator and
      // operand out of argv so `rm < canonical unrelated.txt` cannot treat the
      // stdin path as an rm operand. A directly attached decimal word is an fd
      // prefix (`3<file`), not argv.
      if (/^\d+$/.test(word)) word = '';
      else pushWord();
      const next = command[index + 1];
      if (next === '<') {
        index += 1;
        if (command[index + 1] === '<') index += 1;
      } else if (next === '&') {
        index += 1;
      }
      tokens.push({ kind: 'redirect', value: 'input' });
      continue;
    }
    if (char === '>') {
      const next = command[index + 1];
      const fd = /^\d+$/.test(word) ? Number.parseInt(word, 10) : undefined;
      if (fd != null) word = '';
      if (
        next === '&' &&
        /^(?:\d+|-)/.test(command.slice(index + 2))
      ) {
        pushWord();
        index += 2;
        while (/\d/.test(command[index + 1] ?? '')) index += 1;
        tokens.push({ kind: 'redirect', value: 'fd-dup', ...(fd != null ? { fd } : {}) });
        continue;
      }
      if (next === '&') {
        // The legacy `>&file` spelling is the other Bash combined-output
        // redirect only when the leading fd is omitted. `2>&file` is an
        // invalid descriptor duplication and fails before the command runs.
        if (fd != null) return [];
        pushWord();
        index += 1;
        tokens.push({ kind: 'redirect', value: '>' });
        continue;
      }
      pushWord();
      if (next === '>' || next === '|') index += 1;
      tokens.push({
        kind: 'redirect',
        value: next === '>' ? '>>' : next === '|' ? '>|' : '>',
        ...(fd != null ? { fd } : {}),
      });
      continue;
    }
    if (char === ';' || char === '|' || char === '&') {
      pushWord();
      const next = command[index + 1];
      if (next === char) index += 1;
      tokens.push({ kind: 'separator', value: next === char ? char + next : char });
      continue;
    }
    word += char;
  }
  if (quote || escaped) return [];
  pushWord();
  return tokens;
}

const STATIC_SUDO_ARGS_WITH_VALUES = new Set([
  '-C', '-c', '-D', '-g', '-h', '-p', '-R', '-r', '-T', '-t', '-U', '-u',
  '--chdir', '--close-from', '--group', '--host', '--prompt', '--role',
  '--command-timeout', '--chroot', '--other-user', '--type', '--user',
]);
const STATIC_SUDO_VALUE_SHORT_OPTIONS = new Set([...'CcDghpRrTtUu']);
const STATIC_SUDO_NO_VALUE_SHORT_OPTIONS = new Set([...'ABEHknNPS']);
const STATIC_SUDO_QUERY_SHORT_OPTIONS = new Set([...'KlUVv']);

function commandWordIndex(words: string[]): number | null {
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? '')) index += 1;
  while (
    ['if', 'then', 'elif', 'else', 'while', 'until', 'do', '{', '('].includes(
      words[index] ?? ''
    )
  ) {
    index += 1;
  }
  const envArgsWithValues = new Set([
    '-C', '-S', '-u', '--chdir', '--split-string', '--unset',
  ]);
  const envNoValueOptions = new Set([
    '-0', '-i', '-v', '--debug', '--ignore-environment', '--null',
  ]);
  while (index < words.length) {
    const wrapper = words[index];
    if (wrapper === 'command') {
      index += 1;
      while ((words[index] ?? '').startsWith('-')) {
        const option = words[index];
        if (option === '--') {
          index += 1;
          break;
        }
        if (
          option === '--help' ||
          option === '--version' ||
          /^-[^-]*[vV]/.test(option)
        ) {
          return null;
        }
        index += 1;
      }
      continue;
    }
    if (wrapper === 'exec') {
      index += 1;
      while ((words[index] ?? '').startsWith('-')) {
        const option = words[index];
        if (option === '--') {
          index += 1;
          break;
        }
        if (option === '--help' || option === '--version') return null;
        index += option === '-a' ? 2 : 1;
      }
      continue;
    }
    if (wrapper === 'nohup') {
      index += 1;
      if (words[index] === '--help' || words[index] === '--version') {
        return null;
      }
      if (words[index] === '--') index += 1;
      continue;
    }
    if (wrapper === 'env') {
      index += 1;
      while (index < words.length) {
        const option = words[index];
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(option)) {
          index += 1;
          continue;
        }
        if (!option.startsWith('-')) break;
        if (option === '--') {
          index += 1;
          break;
        }
        if (option === '--help' || option === '--version') return null;
        if (
          option === '-C' ||
          option === '--chdir' ||
          /^-C.+/.test(option) ||
          option.startsWith('--chdir=')
        ) {
          return null;
        }
        // Split-string operands contain a separately tokenized command. This
        // small proof parser deliberately fails closed instead of guessing at
        // another shell grammar layer.
        if (
          option === '-S' ||
          option === '--split-string' ||
          option.startsWith('-S') ||
          option.startsWith('--split-string=')
        ) {
          return null;
        }
        if (envArgsWithValues.has(option)) {
          index += 2;
          continue;
        }
        if (
          /^-(?:C|u).+/.test(option) ||
          option.startsWith('--chdir=') ||
          option.startsWith('--unset=') ||
          envNoValueOptions.has(option)
        ) {
          index += 1;
          continue;
        }
        return null;
      }
      continue;
    }
    if (wrapper !== 'sudo') break;
    index += 1;
    while ((words[index] ?? '').startsWith('-')) {
      const option = words[index];
      if (option === '--') {
        index += 1;
        break;
      }
      if (
        ['--help', '--list', '--other-user', '--remove-timestamp', '--validate', '--version'].includes(option) ||
        option.startsWith('--other-user=') ||
        option === '--edit' ||
        option === '--chdir' ||
        option === '--chroot' ||
        option === '--host' ||
        option.startsWith('--chdir=') ||
        option.startsWith('--chroot=') ||
        option.startsWith('--host=')
      ) {
        return null;
      }
      if (option.startsWith('--')) {
        if (STATIC_SUDO_ARGS_WITH_VALUES.has(option)) {
          index += 2;
          continue;
        }
        if (
          [...STATIC_SUDO_ARGS_WITH_VALUES].some((name) => option.startsWith(`${name}=`)) ||
          ['--non-interactive', '--preserve-env', '--reset-timestamp', '--set-home', '--stdin'].includes(option)
        ) {
          index += 1;
          continue;
        }
        return null;
      }
      let consumesNext = false;
      for (let shortIndex = 1; shortIndex < option.length; shortIndex += 1) {
        const flag = option[shortIndex];
        if (
          STATIC_SUDO_QUERY_SHORT_OPTIONS.has(flag) ||
          flag === 'e' ||
          flag === 'b' ||
          flag === 'D' ||
          flag === 'R' ||
          flag === 'h' ||
          flag === 'i' ||
          flag === 's'
        ) {
          return null;
        }
        if (STATIC_SUDO_VALUE_SHORT_OPTIONS.has(flag)) {
          consumesNext = shortIndex === option.length - 1;
          break;
        }
        if (!STATIC_SUDO_NO_VALUE_SHORT_OPTIONS.has(flag)) return null;
      }
      index += consumesNext ? 2 : 1;
    }
    // sudo accepts environment assignments between its options and command.
    // Only the same inert locale/display variables allowed by the outer proof
    // may pass; arbitrary assignments remain fail-closed below.
    while (
      /^(?:LANG|LANGUAGE|LC_[A-Z_]+|TZ|TERM|COLORTERM|NO_COLOR)=/.test(
        words[index] ?? ''
      )
    ) {
      index += 1;
    }
  }
  return index < words.length ? index : null;
}

const UNCERTAIN_SHELL_CONTROL_WORDS = new Set([
  'if',
  'then',
  'elif',
  'else',
  'fi',
  'while',
  'until',
  'for',
  'select',
  'do',
  'done',
  'case',
  'esac',
  'coproc',
  'function',
  'exit',
  'return',
  'break',
  'continue',
  'time',
]);

function firstStructuralWord(words: string[]): string | undefined {
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? '')) index += 1;
  while (['!', '{', '('].includes(words[index] ?? '')) index += 1;
  return words[index];
}

function hasStructuralStatusInversion(words: string[]): boolean {
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? '')) index += 1;
  while (['{', '('].includes(words[index] ?? '')) index += 1;
  return words[index] === '!';
}

function staticOperands(
  args: string[],
  allowedOptions: ReadonlySet<string> = new Set()
): string[] | null {
  const operands: string[] = [];
  let endOfOptions = false;
  for (const arg of args) {
    if (!endOfOptions && arg === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && arg.startsWith('-')) {
      if (!allowedOptions.has(arg)) return null;
      continue;
    }
    operands.push(arg);
  }
  return operands;
}

interface StaticTransferOperands {
  operands: string[];
  targetDirectory: string | null;
}

function staticTransferOperands(
  args: string[],
  allowedOptions: ReadonlySet<string>
): StaticTransferOperands | null {
  const operands: string[] = [];
  let targetDirectory: string | null = null;
  let endOfOptions = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!endOfOptions && arg === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && (arg === '-t' || arg === '--target-directory')) {
      const value = args[index + 1];
      if (!value || value.startsWith('-')) return null;
      targetDirectory = value;
      index += 1;
      continue;
    }
    if (!endOfOptions && arg.startsWith('--target-directory=')) {
      const value = arg.slice('--target-directory='.length);
      if (!value) return null;
      targetDirectory = value;
      continue;
    }
    if (!endOfOptions && /^-t.+/.test(arg)) {
      targetDirectory = arg.slice(2);
      continue;
    }
    if (!endOfOptions && allowedOptions.has(arg)) continue;
    if (!endOfOptions && arg.startsWith('-')) return null;
    operands.push(arg);
  }
  return operands.length >= (targetDirectory == null ? 2 : 1)
    ? { operands, targetDirectory }
    : null;
}

function staticPathBasename(path: string): string | null {
  if (!path || path.endsWith('/') || path.includes('\\')) return null;
  const basename = path.split('/').at(-1);
  return basename && basename !== '.' && basename !== '..' ? basename : null;
}

function staticTargetDirectoryDestination(
  targetDirectory: string,
  source: string
): string | null {
  const basename = staticPathBasename(source);
  if (!basename || targetDirectory.includes('\\')) return null;
  const directory = targetDirectory.replace(/\/+$/, '');
  return directory ? `${directory}/${basename}` : null;
}

function hasUnsafeEnvironmentAssignment(words: string[]): boolean {
  return words.some((word) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(word);
    if (!match) return false;
    return !/^(?:LANG|LANGUAGE|LC_[A-Z_]+|TZ|TERM|COLORTERM|NO_COLOR)$/.test(
      match[1]
    );
  });
}

function staticCommandProducesAppendOutput(words: string[]): boolean {
  const headIndex = commandWordIndex(words);
  if (headIndex == null) return false;
  const head = words[headIndex];
  const args = words.slice(headIndex + 1);
  if (head === 'echo') {
    const optionEnd = args.findIndex((arg) => !/^-[nEe]+$/.test(arg));
    const options = optionEnd < 0 ? args : args.slice(0, optionEnd);
    const payload = optionEnd < 0 ? [] : args.slice(optionEnd);
    // `echo -e '\c'` can suppress every byte, while `-n` suppresses the
    // otherwise guaranteed newline. Avoid implementation-defined option
    // surfaces and prove only an ordinary non-empty payload or that newline.
    if (payload.some((arg) => arg.includes('\\c'))) return false;
    return payload.length > 0 || !options.some((arg) => arg.includes('n'));
  }
  if (head === 'printf') {
    if (args[0]?.startsWith('-') && args[0] !== '--') return false;
    const formatIndex = args[0] === '--' ? 1 : 0;
    const format = args[formatIndex] ?? '';
    const values = args.slice(formatIndex + 1);
    if (!format || format.includes('\\c')) return false;
    if (!format.includes('%')) return true;
    return format === '%s' && (values[0]?.length ?? 0) > 0;
  }
  return false;
}

function directStaticCommandHeadIndex(words: readonly string[]): number {
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? '')) index += 1;
  return index;
}

/** Whether a wrapper before the proven command may consume pipeline stdin.
 * In particular, sudo's `-S` / `--stdin` reads a password before starting the
 * wrapped command, so producer bytes cannot prove append-mode tee received any
 * content even when the final sudo stage succeeds. */
function staticWrapperConsumesStdin(
  words: readonly string[],
  headIndex: number
): boolean {
  let index = 0;
  while (index < headIndex) {
    if (words[index] !== 'sudo') {
      index += 1;
      continue;
    }
    index += 1;
    while (index < headIndex && (words[index] ?? '').startsWith('-')) {
      const option = words[index];
      if (option === '--') {
        index += 1;
        break;
      }
      if (option === '--stdin') return true;
      if (option.startsWith('--')) {
        index += STATIC_SUDO_ARGS_WITH_VALUES.has(option) ? 2 : 1;
        continue;
      }
      let consumesNext = false;
      for (let shortIndex = 1; shortIndex < option.length; shortIndex += 1) {
        const flag = option[shortIndex];
        if (flag === 'S') return true;
        if (STATIC_SUDO_VALUE_SHORT_OPTIONS.has(flag)) {
          consumesNext = shortIndex === option.length - 1;
          break;
        }
      }
      index += consumesNext ? 2 : 1;
    }
  }
  return false;
}

interface StaticSimpleCommandProof {
  tokens: StaticShellToken[];
  words: string[];
  headIndex: number;
}

function staticSimpleCommandProof(
  tokens: StaticShellToken[]
): StaticSimpleCommandProof | null {
  if (tokens.some((token) => token.kind === 'separator')) return null;
  const words: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === 'word') {
      words.push(token.value);
      continue;
    }
    if (
      token.kind === 'redirect' &&
      token.value !== 'fd-dup' &&
      tokens[index + 1]?.kind === 'word'
    ) {
      index += 1;
    }
  }
  const headIndex = commandWordIndex(words);
  if (headIndex == null) return null;
  const rawHead = words[headIndex];
  if (
    !rawHead ||
    rawHead.includes('/') ||
    rawHead.includes('\\') ||
    hasUnsafeEnvironmentAssignment(words) ||
    hasStructuralStatusInversion(words) ||
    UNCERTAIN_SHELL_CONTROL_WORDS.has(firstStructuralWord(words) ?? '')
  ) {
    return null;
  }
  return { tokens, words, headIndex };
}

// Linux PATH_MAX is commonly 4096 bytes. Use the same order-of-magnitude cap
// in UTF-16 code units so parser-owned evidence cannot retain an arbitrarily
// large raw shell token after bulk ingest strips the command body.
const MAX_STATIC_WRITE_PATH_LENGTH = 4096;
export const MAX_PERSISTED_LEAVE_BEHIND_MUTATION_PATHS = 128;

function isStaticWritePathToken(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_STATIC_WRITE_PATH_LENGTH &&
    !/^&(?:\d+|-)$/.test(value) &&
    !value.startsWith('~') &&
    !/[\\$`*?[\]{}()]/.test(value)
  );
}

function hasShellRedirect(tokens: readonly StaticShellToken[]): boolean {
  return tokens.some((token) => token.kind === 'redirect');
}

function staticTeeOperands(proof: StaticSimpleCommandProof): {
  append: boolean;
  paths: string[];
} | null {
  if (proof.words[proof.headIndex] !== 'tee') return null;
  let append = false;
  let endOfOptions = false;
  const paths: string[] = [];
  for (const arg of proof.words.slice(proof.headIndex + 1)) {
    if (!endOfOptions && arg === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && (arg === '-a' || arg === '--append')) {
      append = true;
      continue;
    }
    if (
      !endOfOptions &&
      (arg === '-i' || arg === '--ignore-interrupts')
    ) {
      continue;
    }
    if (!endOfOptions && arg.startsWith('-')) return null;
    if (!isStaticWritePathToken(arg)) return null;
    paths.push(arg);
  }
  return paths.length > 0 ? { append, paths } : null;
}

function definiteStaticShellWritePaths(
  stageTokens: StaticShellToken[],
  canProveOutput: boolean,
  producerTokens?: StaticShellToken[],
  canProveProducerOutput = false
): string[] {
  const structuralWords = stageTokens
    .filter(
      (token): token is Extract<StaticShellToken, { kind: 'word' }> =>
        token.kind === 'word'
    )
    .map((token) => token.value);
  // `>` and `<` inside Bash's `[[ ... ]]` grammar are comparisons. This
  // deliberately declines mixed conditional/redirection stages rather than
  // manufacturing a filesystem write from an operator token.
  if (structuralWords.includes('[[') && structuralWords.includes(']]')) {
    return [];
  }
  const paths = new Set<string>();
  let lastStdoutRedirect = -1;
  let appendCandidate: { index: number; path: string } | null = null;
  for (let index = 0; index < stageTokens.length; index += 1) {
    const token = stageTokens[index];
    if (
      token.kind !== 'redirect' ||
      token.value === 'input'
    ) {
      continue;
    }
    const fd = token.fd ?? 1;
    if (fd === 1) lastStdoutRedirect = index;
    if (token.value === 'fd-dup') continue;
    const target = stageTokens[index + 1];
    if (target?.kind !== 'word' || !isStaticWritePathToken(target.value)) {
      continue;
    }
    if (token.value === '>' || token.value === '>|') {
      // Opening a truncating redirect is itself a mutation even when a later
      // redirect changes where the command's stdout ultimately lands.
      paths.add(target.value);
    } else if (token.value === '>>' && fd === 1) {
      appendCandidate = { index, path: target.value };
    }
  }

  const proof = canProveOutput ? staticSimpleCommandProof(stageTokens) : null;
  if (
    proof &&
    appendCandidate?.index === lastStdoutRedirect &&
    staticCommandProducesAppendOutput(proof.words)
  ) {
    paths.add(appendCandidate.path);
  }

  if (proof) {
    const tee = staticTeeOperands(proof);
    if (tee && !tee.append) {
      for (const path of tee.paths) paths.add(path);
    } else if (
      tee?.append &&
      producerTokens &&
      canProveProducerOutput &&
      !staticWrapperConsumesStdin(proof.words, proof.headIndex) &&
      !proof.tokens.some(
        (token) => token.kind === 'redirect' && token.value === 'input'
      )
    ) {
      const producer = staticSimpleCommandProof(producerTokens);
      if (
        producer &&
        // Any producer redirect can fail before the byte-producing command
        // starts (including input, stderr, or fd duplication) while the final
        // tee still exits successfully after reading EOF. Aggregate pipeline
        // success therefore proves append input only for a redirect-free
        // producer stage.
        !hasShellRedirect(producer.tokens) &&
        producer.headIndex === directStaticCommandHeadIndex(producer.words) &&
        staticCommandProducesAppendOutput(producer.words)
      ) {
        for (const path of tee.paths) paths.add(path);
      }
    }
  }
  return [...paths];
}

/** Paths whose content is proven to change when this final foreground shell
 * stage succeeds. Truncation is a write on open; append requires static proof
 * that at least one byte reaches that exact fd or append-mode tee input. */
export function definiteShellWritePaths(
  stageSource: string,
  producerStageSource?: string
): string[] {
  const stageTokens = staticShellTokens(stageSource);
  const producerTokens =
    producerStageSource == null
      ? undefined
      : staticShellTokens(producerStageSource);
  return definiteStaticShellWritePaths(
    stageTokens,
    !hasUnprovenShellExpansion(stageSource),
    producerTokens,
    producerStageSource != null &&
      !hasUnprovenShellExpansion(producerStageSource)
  );
}

/**
 * Derive a canonical leave-behind path mutation from shell source whose
 * heredoc bodies and comments have already been removed. Callers also pass
 * bodies from expansion-enabled heredocs so a current-shell substitution there
 * cannot disappear with the body. This is parser-owned truth, derived before
 * bulk ingest strips the command. Conditional execution and query/dry-run
 * invocations fail closed because aggregate Bash status does not prove that the
 * path command ran.
 */
export function leaveBehindMutationPathsFromExecutableShell(
  command: string,
  unquotedHeredocBodies: readonly string[] = []
): string[] {
  if (
    hasUnprovenShellExpansion(command) ||
    unquotedHeredocBodies.some(hasCurrentShellHeredocSubstitution)
  ) {
    return [];
  }
  const tokens = staticShellTokens(command);
  // A final `;` or newline only terminates the one foreground command, so its
  // aggregate status still proves that command's status. Keep `&` and `;;`
  // fail-closed: they change execution or grammar rather than merely ending it.
  while (
    tokens.at(-1)?.kind === 'separator' &&
    tokens.at(-1)!.value === '\n'
  ) {
    tokens.pop();
  }
  if (
    tokens.at(-1)?.kind === 'separator' &&
    tokens.at(-1)!.value === ';'
  ) {
    tokens.pop();
  }
  // A successful Bash tool result proves only the aggregate status. Pipelines,
  // asynchronous launches, boolean chains, and status inversion can all return
  // success while the path mutator itself failed or never ran.
  if (
    tokens.some(
      (token) =>
        token.kind === 'separator' &&
        ['&&', '||', '&', '|&', '<>', 'nested-command'].includes(
          token.value
        )
    )
  ) {
    return [];
  }
  const segments: StaticShellToken[][] = [];
  let segment: StaticShellToken[] = [];
  for (const token of tokens) {
    if (token.kind !== 'separator') {
      segment.push(token);
      continue;
    }
    if (segment.length > 0) segments.push(segment);
    segment = [];
  }
  if (segment.length > 0) segments.push(segment);
  const separators = tokens.filter(
    (token): token is Extract<StaticShellToken, { kind: 'separator' }> =>
      token.kind === 'separator'
  );
  if (separators.length > 0) {
    if (
      separators.every((token) => token.value === '|') &&
      segments.length >= 2 &&
      !segments.some((candidate) => {
        const words = candidate
          .filter(
            (token): token is Extract<StaticShellToken, { kind: 'word' }> =>
              token.kind === 'word'
          )
          .map((token) => token.value);
        return (
          hasStructuralStatusInversion(words) ||
          UNCERTAIN_SHELL_CONTROL_WORDS.has(firstStructuralWord(words) ?? '')
        );
      })
    ) {
      const writePaths = definiteStaticShellWritePaths(
        segments.at(-1)!,
        true,
        segments.at(-2),
        true
      );
      return writePaths.filter(
        (path) => !path.includes('\\') && leaveBehindStateScope(path) != null
      );
    }
    return [];
  }
  // Even a final simple command is not execution-proven after an arbitrary
  // prelude: `set -n`, DEBUG traps, sourced `exit`, eval'd exec, or aliases can
  // suppress it while the shell still reports success. Stay deliberately
  // sparse and accept only a single foreground simple command.
  if (segments.length !== 1) return [];

  // Do not infer execution from bodies guarded by shell grammar. Pre-scan the
  // whole command so a later `then rm ...` cannot be inspected independently
  // after the opening `if` segment was discarded.
  if (
    segments.some((candidate) => {
      const words = candidate
        .filter(
          (token): token is Extract<StaticShellToken, { kind: 'word' }> =>
            token.kind === 'word'
        )
        .map((token) => token.value);
      const first = firstStructuralWord(words);
      const firstIndex = first == null ? -1 : words.indexOf(first);
      return (
        hasStructuralStatusInversion(words) ||
        (first != null && UNCERTAIN_SHELL_CONTROL_WORDS.has(first)) ||
        /\(\)$/.test(first ?? '') ||
        (firstIndex >= 0 && words[firstIndex + 1] === '()')
      );
    })
  ) {
    return [];
  }

  segment = [];
  const rawSegment = segments[0];
  for (let index = 0; index < rawSegment.length; index += 1) {
    const token = rawSegment[index];
    if (token.kind === 'redirect' && token.value === 'input') {
      if (rawSegment[index + 1]?.kind === 'word') index += 1;
      continue;
    }
    segment.push(token);
  }
  const isCanonicalShellPath = (value: string): boolean =>
    value.length <= MAX_STATIC_WRITE_PATH_LENGTH &&
    !value.includes('\\') &&
    leaveBehindStateScope(value) != null;

  const inspect = (): string[] => {
    if (segment.length === 0) return [];
    const words: string[] = [];
    for (let index = 0; index < segment.length; index += 1) {
      const token = segment[index];
      if (token.kind === 'word') {
        words.push(token.value);
        continue;
      }
      if (
        token.kind === 'redirect' &&
        token.value !== 'fd-dup' &&
        segment[index + 1]?.kind === 'word'
      ) {
        index += 1;
      }
    }
    // `>` inside `[[ ... ]]` is a comparison, not a redirection.
    const conditional = words.includes('[[') && words.includes(']]');
    const paths = new Set<string>(
      conditional
        ? []
        : definiteStaticShellWritePaths(rawSegment, true).filter(
            isCanonicalShellPath
          )
    );

    const headIndex = commandWordIndex(words);
    if (headIndex == null) return [...paths];
    const rawHead = words[headIndex];
    if (
      !rawHead ||
      rawHead.includes('/') ||
      rawHead.includes('\\') ||
      hasUnsafeEnvironmentAssignment(words)
    ) {
      return [...paths];
    }
    const head = rawHead;
    const args = words.slice(headIndex + 1);
    if (!head) return [...paths];
    if (head === 'git') {
      if (words.some((word) => /^GIT_[A-Za-z0-9_]*=/.test(word))) {
        return [...paths];
      }
      const subcommand = args[0];
      const gitMutationOptions = new Set(['-f', '--force', '-r']);
      for (const arg of args.slice(1)) {
        if (/^-[fr]+$/.test(arg)) gitMutationOptions.add(arg);
      }
      const gitArgs = staticOperands(
        args.slice(1),
        subcommand === 'rm' || subcommand === 'mv'
          ? gitMutationOptions
          : new Set()
      );
      if (!gitArgs) return [...paths];
      if (subcommand === 'rm' || subcommand === 'mv') {
        for (const path of gitArgs.filter(isCanonicalShellPath)) paths.add(path);
      }
      return [...paths];
    }
    const rmMutationOptions = new Set([
      '-f',
      '--force',
      '-r',
      '-R',
      '--recursive',
      '-v',
      '--verbose',
    ]);
    for (const arg of args) {
      if (/^-[fRrv]+$/.test(arg)) rmMutationOptions.add(arg);
    }
    const allowedOptions =
      head === 'tee'
        ? new Set(['-a', '--append', '-i', '--ignore-interrupts'])
        : head === 'rm'
          ? rmMutationOptions
          : head === 'cp' || head === 'mv'
          ? new Set(['-f', '--force'])
          : new Set<string>();
    const transfer = ['mv', 'cp', 'install'].includes(head)
      ? staticTransferOperands(args, allowedOptions)
      : null;
    const operands = transfer?.operands ?? staticOperands(args, allowedOptions);
    if (!operands) return [...paths];
    if (head && ['rm', 'unlink'].includes(head)) {
      for (const path of operands.filter(isCanonicalShellPath)) paths.add(path);
      return [...paths];
    }
    if (head === 'mv') {
      for (const path of operands.filter(isCanonicalShellPath)) paths.add(path);
    }
    if (head === 'cp' || head === 'install') {
      if (transfer?.targetDirectory == null) {
        const destination = operands.at(-1);
        if (destination && isCanonicalShellPath(destination)) paths.add(destination);
      }
    }
    if (transfer) {
      const destinationDirectory =
        transfer.targetDirectory ??
        (transfer.operands.length > 2 ? transfer.operands.at(-1) ?? null : null);
      const sources =
        transfer.targetDirectory != null
          ? transfer.operands
          : transfer.operands.slice(0, -1);
      if (destinationDirectory) {
        for (const source of sources) {
          const destination = staticTargetDirectoryDestination(
            destinationDirectory,
            source
          );
          if (destination && isCanonicalShellPath(destination)) {
            paths.add(destination);
          }
        }
      }
    }
    return [...paths];
  };
  return inspect();
}

/** Backward-compatible scalar view. Multiple proven mutations deliberately do
 * not collapse to an arbitrary first path; bulk callers persist the plural
 * parser truth below. */
export function leaveBehindMutationPathFromExecutableShell(
  command: string,
  unquotedHeredocBodies: readonly string[] = []
): string | null {
  const paths = leaveBehindMutationPathsFromExecutableShell(
    command,
    unquotedHeredocBodies
  );
  return paths.length === 1 ? paths[0] : null;
}

/**
 * Reduce a successful canonical-path file mutation to its final-state effect.
 * A transcript can prove v1 structure but not Git commitment, so Write yields
 * only `candidate`. A later nonconformant full Write or partial edit invalidates
 * it; a later conformant full Write restores the structural candidate.
 */
export function observeLeaveBehindWrites(
  call: LeaveBehindWriteObservation
): LeaveBehindWriteTransition[] {
  if (call.isError !== false) return [];
  const plural = call.leaveBehindMutationPaths;
  const bashPaths = Array.isArray(plural)
    ? plural.length <= MAX_PERSISTED_LEAVE_BEHIND_MUTATION_PATHS &&
      plural.every((path) => typeof path === 'string')
      ? [...new Set(plural as string[])]
      : []
    : typeof call.leaveBehindMutationPath === 'string'
      ? [call.leaveBehindMutationPath]
      : [];
  const paths =
    call.toolName === 'Bash' ? bashPaths : [call.input.file_path];
  const field: LeaveBehindWriteTransition['field'] =
    call.toolName === 'Bash'
      ? Array.isArray(plural)
        ? 'leaveBehindMutationPaths'
        : 'leaveBehindMutationPath'
      : 'input.file_path';
  const transitions: LeaveBehindWriteTransition[] = [];
  for (const path of paths) {
    if (
      typeof path !== 'string' ||
      path.length > MAX_STATIC_WRITE_PATH_LENGTH
    ) {
      continue;
    }
    const stateScope = leaveBehindStateScope(path);
    if (!stateScope) continue;
    const key = `docs/runbooks/${stateScope}/README.md`;
    if (call.toolName === 'Write') {
      transitions.push({
        key,
        path,
        field,
        stateScope,
        status:
          call.leaveBehindStructure === LEAVE_BEHIND_CONTRACT.version
            ? 'candidate'
            : 'invalidated',
      });
    } else if (/^(?:Edit|MultiEdit|Bash)$/.test(call.toolName)) {
      transitions.push({
        key,
        path,
        field,
        stateScope,
        status: 'invalidated',
      });
    }
  }
  return transitions;
}

/** Legacy scalar adapter for callers that cannot represent more than one path. */
export function observeLeaveBehindWrite(
  call: LeaveBehindWriteObservation
): LeaveBehindWriteTransition | null {
  const transitions = observeLeaveBehindWrites(call);
  return transitions.length === 1 ? transitions[0] : null;
}
