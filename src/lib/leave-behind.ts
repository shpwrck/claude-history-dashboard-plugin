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
const PLACEHOLDER_RE = /^(?:tbd|todo|n\/a|none|placeholder|coming soon)$/i;
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
const COMPLETE_RAW_HTML_TAG_RE = new RegExp(
  `^ {0,3}(?:<${RAW_HTML_TAG_NAME}(?:${RAW_HTML_ATTRIBUTE})*[ \\t]*/?>|` +
    `</${RAW_HTML_TAG_NAME}[ \\t]*>)[ \\t]*$`
);

type RawHtmlBlock =
  | { kind: 'closing-tag'; tag: string }
  | { kind: 'token'; token: string }
  | { kind: 'blank-line' };

function rawHtmlBlockStart(line: string): RawHtmlBlock | null {
  if (/^ {0,3}<!--/.test(line)) return { kind: 'token', token: '-->' };
  const closingTag =
    /^ {0,3}<(pre|script|style|textarea)(?:[ \t>]|$)/i.exec(line)?.[1];
  if (closingTag) return { kind: 'closing-tag', tag: closingTag.toLowerCase() };
  if (/^ {0,3}<\?/.test(line)) return { kind: 'token', token: '?>' };
  if (/^ {0,3}<!\[CDATA\[/i.test(line)) {
    return { kind: 'token', token: ']]>' };
  }
  if (/^ {0,3}<![A-Z]/.test(line)) return { kind: 'token', token: '>' };
  if (RAW_HTML_BLOCK_TAG_RE.test(line) || COMPLETE_RAW_HTML_TAG_RE.test(line)) {
    return { kind: 'blank-line' };
  }
  return null;
}

function rawHtmlBlockEnds(block: RawHtmlBlock, line: string): boolean {
  if (block.kind === 'blank-line') return line.trim().length === 0;
  if (block.kind === 'token') return line.includes(block.token);
  return new RegExp(`</${block.tag}[ \\t]*>`, 'i').test(line);
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

function visibleMarkdownLines(markdown: string): string[] {
  const sourceLines = markdown.split(/\r?\n/);
  let body = markdown;
  if (sourceLines[0]?.replace(/^\uFEFF/, '') === '---') {
    const closing = sourceLines
      .slice(1)
      .findIndex((line) => line === '---');
    if (closing >= 0) body = sourceLines.slice(closing + 2).join('\n');
  }
  const lines: string[] = [];
  let fence: { marker: '`' | '~'; length: number } | null = null;
  let rawHtmlBlock: RawHtmlBlock | null = null;
  let insideComment = false;
  for (const raw of body.split(/\r?\n/)) {
    if (rawHtmlBlock) {
      if (rawHtmlBlockEnds(rawHtmlBlock, raw)) {
        const endedOnBlank = rawHtmlBlock.kind === 'blank-line';
        rawHtmlBlock = null;
        if (endedOnBlank) lines.push(raw);
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
      } else {
        // Preserve fenced command/text bodies as usable section content, but
        // indent Markdown-looking lines so they cannot become structure.
        lines.push(`    ${raw}`);
      }
      continue;
    }

    // Raw HTML blocks are non-structural. Recognize them before comment
    // stripping so literal `<!--` text inside script/style bodies cannot leak
    // comment state into later Markdown headings.
    const rawHtmlBlockOpen = !insideComment ? rawHtmlBlockStart(raw) : null;
    if (rawHtmlBlockOpen) {
      if (!rawHtmlBlockEnds(rawHtmlBlockOpen, raw)) {
        rawHtmlBlock = rawHtmlBlockOpen;
      }
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
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(visible);
    if (fenceMatch) {
      const marker = fenceMatch[1][0] as '`' | '~';
      fence = { marker, length: fenceMatch[1].length };
      continue;
    }
    const rawHtmlOpen = rawHtmlBlockStart(visible);
    if (rawHtmlOpen) {
      if (!rawHtmlBlockEnds(rawHtmlOpen, visible)) rawHtmlBlock = rawHtmlOpen;
      continue;
    }
    lines.push(visible);
  }
  return lines;
}

export function leaveBehindStateScope(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  const normalized = path.replace(/\\/g, '/');
  if (normalized.split('/').some((segment) => segment === '.' || segment === '..')) {
    return null;
  }
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
  index: number
): StructuralBoundary | null {
  const atx = structuralHeading(lines[index]);
  if (atx) {
    const level = /^#+/.exec(atx)?.[0].length;
    if (level === 1 || level === 2 || level === 3) {
      return { heading: atx, level };
    }
  }

  const nextLine = lines[index + 1];
  if (nextLine == null) return null;
  const indent = permittedMarkdownIndent(lines[index]);
  const underlineIndent = permittedMarkdownIndent(nextLine);
  if (indent == null || underlineIndent == null) return null;
  const text = lines[index].slice(indent).replace(/[ \t]+$/, '');
  if (!text || structuralHeading(lines[index])) return null;
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

function sectionContent(lines: string[], heading: string): string | null {
  const matches = lines
    .map((line, index) => (structuralHeading(line) === heading ? index : -1))
    .filter((index) => index >= 0);
  if (matches.length !== 1) return null;
  const start = matches[0] + 1;
  let end = lines.length;
  for (let index = start; index < lines.length; index += 1) {
    if (structuralBoundaryAt(lines, index)) {
      end = index;
      break;
    }
  }
  return lines
    .slice(start, end)
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n');
}

function hasSubstantiveMarkdownText(content: string): boolean {
  const normalized = normalizePlaceholder(content);
  return !PLACEHOLDER_RE.test(normalized) && /[\p{L}\p{N}]/u.test(normalized);
}

function hasUsableSectionContent(
  content: string | null,
  requireMapping = false
): boolean {
  if (!content || !hasSubstantiveMarkdownText(content)) return false;
  if (!requireMapping) return true;
  return content.split('\n').some((line) => {
    const arrow = line.indexOf('->');
    if (arrow < 0) return false;
    return (
      hasSubstantiveMarkdownText(line.slice(0, arrow)) &&
      hasSubstantiveMarkdownText(line.slice(arrow + 2))
    );
  });
}

function normalizePlaceholder(content: string): string {
  // Strip any number of common quote/list/task prefixes and inline emphasis
  // delimiters in a fixed number of linear passes. Repeatedly peeling one
  // wrapper makes adversarially nested Markdown quadratic in the Write size.
  return content
    .trim()
    .replace(/^(?:(?:>\s*)|(?:(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?))+/, '')
    .trim()
    .replace(/^[`*_]+/, '')
    .replace(/[`*_:!.]+$/, '')
    .trim();
}

function exactHeadingIndices(lines: string[], heading: string): number[] {
  return lines
    .map((line, index) =>
      structuralHeading(line) === heading ? index : -1
    )
    .filter((index) => index >= 0);
}

function hasValidHeadingHierarchy(lines: string[]): boolean {
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
    exactHeadingIndices(lines, heading)
  );
  if (occurrences.some((matches) => matches.length > 1)) return false;
  if (occurrences.some((matches) => matches.length === 0)) return true;

  const indices = occurrences.map(([index]) => index);
  if (indices.some((index, position) => position > 0 && index <= indices[position - 1])) {
    return false;
  }

  for (const section of REQUIRED_CONTENT_SECTIONS) {
    const index = exactHeadingIndices(lines, section.heading)[0];
    let parent: string | undefined;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const boundary = structuralBoundaryAt(lines, cursor);
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

  if (typeof input.content !== 'string' || input.content.trim().length === 0) {
    errors.push('invalid-content');
  } else {
    const markdown = input.content;
    const lines = visibleMarkdownLines(markdown);
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
      (line) => structuralHeading(line) === LEAVE_BEHIND_CONTRACT.operabilityHeading
    );
    const decisionLog = lines.findIndex(
      (line) => structuralHeading(line) === LEAVE_BEHIND_CONTRACT.decisionLogHeading
    );
    if (operability < 0) errors.push('missing-operability');
    if (decisionLog < 0) errors.push('missing-decision-log');
    if (
      operability >= 0 &&
      decisionLog >= 0 &&
      !hasValidHeadingHierarchy(lines)
    ) {
      errors.push('invalid-section-order');
    }

    for (const section of REQUIRED_CONTENT_SECTIONS) {
      if (
        !hasUsableSectionContent(
          sectionContent(lines, section.heading),
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
}

export interface LeaveBehindWriteTransition {
  /** Stable key shared by relative and absolute aliases of the same artifact. */
  key: string;
  /** Original observed path retained for human-facing candidate evidence. */
  path: string;
  stateScope: string;
  status: 'candidate' | 'invalidated';
}

/**
 * Reduce a successful canonical-path file mutation to its final-state effect.
 * A transcript can prove v1 structure but not Git commitment, so Write yields
 * only `candidate`. A later nonconformant full Write or partial edit invalidates
 * it; a later conformant full Write restores the structural candidate.
 */
export function observeLeaveBehindWrite(
  call: LeaveBehindWriteObservation
): LeaveBehindWriteTransition | null {
  if (call.isError !== false) return null;
  const path = call.input.file_path;
  const stateScope = leaveBehindStateScope(path);
  if (typeof path !== 'string' || !stateScope) return null;
  const key = `docs/runbooks/${stateScope}/README.md`;
  if (call.toolName === 'Write') {
    return {
      key,
      path,
      stateScope,
      status:
        call.leaveBehindStructure === LEAVE_BEHIND_CONTRACT.version
          ? 'candidate'
          : 'invalidated',
    };
  }
  return /^(?:Edit|MultiEdit)$/.test(call.toolName)
    ? { key, path, stateScope, status: 'invalidated' }
    : null;
}
