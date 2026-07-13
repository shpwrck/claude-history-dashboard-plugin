import type { SessionTimeline } from '../../parse-timeline';
import type { ToolCall, ToolUsageData } from '../../parse-tools';
import { MARKERS_GHOST_SESSION } from '../applied-markers';
import { claudeMdMarksApplied } from '../shared';
import type { Detector, RecObservation } from '../types';

const MIN_DISTINCT_READ_FILES = 5;
const ACTIVE_QUIET_MS = 30 * 60 * 1000;
const FRESH_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_PROMPT_PREVIEW_LENGTH = 200;
const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);
const DELEGATED_TOOLS = new Set(['Agent', 'Task', 'Workflow']);
const NON_WORKSPACE_MUTATING_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'TodoRead', 'TodoWrite']);
const AFFIRMATIVE_EDIT_REQUEST = /^\s*(?:(?:(?:please|kindly|now|next)\s+)*(?:go\s+)?|(?:(?:can|could|would|will)\s+you|(?:i|we)\s+(?:need|want|would\s+like)\s+(?:you\s+)?to|you\s+(?:need|must|should)(?:\s+to)?|(?:do\s+not|don['’]t)\s+(?:forget|hesitate)\s+to|(?:task|goal)\s*:)\s+(?:(?:please|kindly)\s+)?)(?:add|apply|create|delete|edit|fix|implement|make|modify|patch|refactor|remove|rename|update|write|change)\b\s+(.+?)\s*$/i;
const DIAGNOSTIC_OR_STATUS_OBJECT = /^(?:(?:on|regarding|about)\b|(?:review|status|progress)(?:$|\s+(?:for|of|on|regarding|about|report|update)\b)|(?:failure|incident|regression)\s+(?:analysis|postmortem|review|report|status)\b)/i;
const WORKSPACE_OBJECT_MODIFIERS = /^(?:(?:the|this|that|these|those|a|an|my|our|your|its|their|requested|old|new|existing|current|legacy|deprecated|unused|broken|failing|failed|stale|incorrect|wrong|affected|relevant|generated|shared|main|public|private|internal|local|remote)\s+)*/i;
const WORKSPACE_FILE_TOKEN = String.raw`(?:\.[\w][\w.-]*|[\w@+-][\w@.+-]*\.(?:[cm]?[jt]sx?|mjs|cjs|json|jsonc|ya?ml|toml|mdx?|css|scss|sass|less|html?|py|go|rs|java|kt|kts|rb|php|sh|bash|zsh|fish|sql|graphql|gql|proto|vue|svelte|c|cc|cpp|h|hpp|cs|fs|fsx|swift|dart|ex|exs|erl|hrl|tf|tfvars|ini|conf|cfg|properties|lock|xml|gradle)|README(?:\.[\w.-]+)?|Dockerfile(?:\.[\w.-]+)?|Makefile|Justfile|Procfile|Gemfile|Rakefile|CMakeLists\.txt|LICENSE|CHANGELOG)`;
const WORKSPACE_PATH_TOKEN = String.raw`(?:(?:(?:[A-Za-z]:)?[\\/]|(?:\.{1,2}|~)[\\/])[\w@./\\+-]+|(?:[.\w@+-]+[\\/])+${WORKSPACE_FILE_TOKEN})`;
const WORKSPACE_PATH_OR_FILE_OBJECT = new RegExp(`^(?:${WORKSPACE_PATH_TOKEN}|${WORKSPACE_FILE_TOKEN})(?:$|\\s)`, 'i');
const WORKSPACE_PATH_OR_FILE_DESTINATION = new RegExp(`\\s(?:to|at|in|into)\\s+(?:${WORKSPACE_PATH_TOKEN}|${WORKSPACE_FILE_TOKEN})(?:$|\\s)`, 'i');
const WORKSPACE_ARTIFACT_OBJECT = /^(?:(?:summary|plan|explanation)\s+(?:file|document)|(?:api|cache|change|changes|class|cli|client|code|codebase|component|config|configuration|detector|diff|directory|directories|docs|documentation|endpoint|file|files|fix|fixture|fixtures|folder|folders|function|handler|hook|implementation|interface|library|loader|manifest|method|migration|migrations|module|package|parser|patch|pipeline|project|repository|repo|route|schema|script|server|service|source|spec|specs|stylesheet|styles|test|tests|type|types|ui|view|workflow|workflows)(?:\s+(?:code|file|files|fix|implementation|internals|module|fixture|fixtures|suite|suites|schema|handler|service|client|server|test|tests|docs|documentation)){0,2})(?:\s+(?:for|in|under|within)\s+.+)?$/i;
const GLOBAL_NON_EDIT_INTENT = /(?:^|[;.!?]\s*)(?:(?:please|just)\s+)?plan only\b/i;
const NO_CHANGE_SEGMENT = /\bno changes?\b/i;
const NEGATED_EDIT_INTENT = /\b(?:do not|don['’]t|never)(?:\s+|,\s*[^,.;!?]{1,40},\s*)(?:edit|fix|implement|change|modify|refactor|remove|delete|rename|patch|add|create|write|update)\b/i;
const EXPLANATORY_FRAMING = /\b(?:research|explain|summari[sz]e)\b.{0,80}\b(?:how|what|whether|ways?)\b/i;
const ADVICE_FRAMING = /(?:\bplan\b.{0,40}\b(?:how|ways?)\b|\b(?:propose|recommend|suggest)\b|\btell me\b|\b(?:research|investigate|review)\b.{0,80}\b(?:propose|recommend|suggest|tell me|explain)\b)/i;
const SUMMARY_OR_STATUS_FRAMING = /(?:\b(?:write|create)\s+(?:(?:me|us)\s+)?(?:an?\s+)?(?:summary|explanation|plan)\b|\bupdate\s+(?:me|us)\b|\b(?:give|send)\s+(?:me|us)\s+(?:an?\s+)?update\b)/i;
const SUMMARY_ARTIFACT_INTENT = /\b(?:write|create)\s+(?:(?:me|us)\s+)?(?:an?\s+)?(?:summary|explanation|plan)(?:\s+(?:file|document)\b|.{0,24}\s(?:to|at|in|into)\s+[\w./-]*[/.][\w.-]+)/i;
const NON_WORKSPACE_OUTPUT_COMPLEMENT = /\s(?:to|in|into|for|from|as)\s+(?:(?:my|our|your|the|this|that|an?)\s+)*(?:(?:answer|response|reply|message|explanation|analysis|output|chat|conversation)(?!\s+(?:api|cache|class|client|code(?!\s+(?:blocks?|examples?|samples?|snippets?|fences?|listings?)\b)|component|config|controller|detector|endpoint|file|handler|implementation|interface|library|loader|middleware|module|package|parser|pipeline|route|schema|script|server|service|source|test|type|ui|view|workflow)\b)|review\s+checklist|checklist)\b/i;
const NOMINAL_EDIT_FRAMING = /\b(?:plan|review|inspect|investigate|research|explain)\b.{0,32}\b(?:the|this|that|an?)\s+(?:update|change|edit|modification|fix|patch|refactor)\b/i;
const NOMINAL_EDIT_CONTINUATION = /^\s*(?:the|this|that|an?)\s+(?:update|change|edit|modification|fix|patch|refactor)\b/i;
const HOW_TO_ADVICE_FRAMING = /\b(?:how|ways?)\s+to\s+(?:edit|fix|implement|change|modify|refactor|remove|delete|rename|patch|add|create|write|update)\b/i;
const DECISION_QUESTION_FRAMING = /\b(?:should|can|could|would)\s+we\b/i;
const SCOPED_NO_CHANGE_COMMA = /(\bno changes?\b[^,;.!?]*),\s*(?=(?:please\s+)?(?:edit|fix|implement|change|modify|refactor|remove|delete|rename|patch|add|create|write|update)\b)/gi;
const SCOPED_NEGATED_EDIT_COMMA = /(\b(?:do not|don['’]t|never)\s+(?:edit|fix|implement|change|modify|refactor|remove|delete|rename|patch|add|create|write|update)\b[^,;.!?]*),\s*(?=(?:please\s+)?(?:edit|fix|implement|change|modify|refactor|remove|delete|rename|patch|add|apply|create|write|update)\b)/gi;
const NEGATED_PLAN_ONLY_IMPLEMENTATION = /^\s*(?:do not|don['’]t)\s+plan only\s*[,;]\s*(?:(?:please|kindly)\s+)?implement\s+(?:the|this)\s+fix[.!]?\s*$/i;
const SENTENCE_BOUNDARY = /[!?](?:\s+|$)|\.(?:\s+|$)/;
const STRONG_CLAUSE_BOUNDARY = /\b(?:then|but)\b|;/i;
const COORDINATED_ACTION_BOUNDARY = /\band\b/i;

type EditIntentSource = 'prompt' | 'failed-native-edit';

export interface GhostCandidate {
  sessionId: string;
  distinctReadFiles: number;
  latestMs: number | null;
  intentSource: EditIntentSource;
}

function isWorkspaceMutationOrAmbiguous(call: ToolCall): boolean {
  if (EDIT_TOOLS.has(call.toolName)) return call.isError === false;
  if (DELEGATED_TOOLS.has(call.toolName)) return true;
  if (NON_WORKSPACE_MUTATING_TOOLS.has(call.toolName)) return false;
  if (call.toolName === 'Bash') return true;
  return true;
}

function isAffirmativeEditRequest(clause: string): boolean {
  const match = clause.match(AFFIRMATIVE_EDIT_REQUEST);
  if (!match) return false;
  const object = match[1]
    .trim()
    .replace(/[.!?]+$/, '')
    .replace(WORKSPACE_OBJECT_MODIFIERS, '');
  if (DIAGNOSTIC_OR_STATUS_OBJECT.test(object)) return false;
  if (NON_WORKSPACE_OUTPUT_COMPLEMENT.test(object)) return false;
  return WORKSPACE_PATH_OR_FILE_OBJECT.test(object)
    || WORKSPACE_PATH_OR_FILE_DESTINATION.test(object)
    || WORKSPACE_ARTIFACT_OBJECT.test(object);
}

function promptHasEditIntent(prompt: string): boolean {
  if (NEGATED_PLAN_ONLY_IMPLEMENTATION.test(prompt)) return true;
  if (GLOBAL_NON_EDIT_INTENT.test(prompt)) return false;
  const scopedPrompt = prompt
    .replace(SCOPED_NO_CHANGE_COMMA, '$1; ')
    .replace(SCOPED_NEGATED_EDIT_COMMA, '$1; ');
  const explicitEdit = scopedPrompt.split(SENTENCE_BOUNDARY).some((sentence) => {
    if (DECISION_QUESTION_FRAMING.test(sentence)) return false;
    return sentence.split(STRONG_CLAUSE_BOUNDARY).some((segment) => {
      let coordinatedSuppression = false;
      for (const clause of segment.split(COORDINATED_ACTION_BOUNDARY)) {
        if (NO_CHANGE_SEGMENT.test(clause)) continue;
        if (NEGATED_EDIT_INTENT.test(clause) || HOW_TO_ADVICE_FRAMING.test(clause)) {
          coordinatedSuppression = true;
          continue;
        }
        if (coordinatedSuppression) continue;
        if (
          EXPLANATORY_FRAMING.test(clause)
          || ADVICE_FRAMING.test(clause)
          || NOMINAL_EDIT_FRAMING.test(clause)
          || NOMINAL_EDIT_CONTINUATION.test(clause)
        ) continue;
        const summaryArtifact = SUMMARY_ARTIFACT_INTENT.test(clause);
        if (SUMMARY_OR_STATUS_FRAMING.test(clause) && !summaryArtifact) continue;
        if (isAffirmativeEditRequest(clause)) return true;
      }
      return false;
    });
  });
  return explicitEdit;
}

function editIntentSource(
  session: ToolUsageData,
  timeline: SessionTimeline
): EditIntentSource | null {
  if (session.calls.some((call) => EDIT_TOOLS.has(call.toolName) && call.isError === true)) {
    return 'failed-native-edit';
  }
  const prompt = timeline.firstPromptPreview;
  return prompt && prompt.length < MAX_PROMPT_PREVIEW_LENGTH && promptHasEditIntent(prompt)
    ? 'prompt'
    : null;
}

function validMs(timestamp: string | null | undefined): number | null {
  if (!timestamp) return null;
  const date = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(timestamp);
  if (!date) return null;
  const year = Number(date[1]);
  const month = Number(date[2]);
  const day = Number(date[3]);
  if (
    year < 1000 || month < 1 || month > 12 || day < 1 ||
    day > new Date(Date.UTC(year, month, 0)).getUTCDate()
  ) return null;
  const value = Date.parse(timestamp);
  if (!Number.isFinite(value)) return null;
  // A date-only artifact has day, not instant, precision. Use the latest
  // possible instant in that UTC day so it cannot manufacture 30 minutes of
  // quiet at 00:30 while still allowing genuinely old date-only evidence.
  return /^\d{4}-\d{2}-\d{2}$/.test(timestamp)
    ? value + 24 * 60 * 60 * 1000 - 1
    : value;
}

function normalizedPath(path: string): string {
  const absolute = path.replaceAll('\\', '/').startsWith('/');
  const segments: string[] = [];
  for (const segment of path.replaceAll('\\', '/').split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..' && segments.length > 0 && segments.at(-1) !== '..') {
      segments.pop();
    } else if (segment !== '..' || !absolute) {
      segments.push(segment);
    }
  }
  return `${absolute ? '/' : ''}${segments.join('/')}`;
}

export function classifyGhostSession(
  session: ToolUsageData,
  timeline: SessionTimeline,
  now: number
): GhostCandidate | null {
  if (session.calls.some((call) => call.isError === null)) return null;
  if (timeline.entries.some((entry) => entry.interrupted === true)) return null;
  const userTurns = new Set(
    timeline.entries.filter((entry) => entry.kind === 'user').map((entry) => entry.timestamp)
  );
  if (userTurns.size > 1) return null;
  if (session.calls.some(isWorkspaceMutationOrAmbiguous)) return null;
  const intentSource = editIntentSource(session, timeline);
  if (!intentSource) return null;

  const reads = session.calls.filter(
    (call) => call.toolName === 'Read' && call.isError === false && call.input.file_path
  );
  const distinct = new Set(reads.map((call) => normalizedPath(call.input.file_path!))).size;
  if (distinct < MIN_DISTINCT_READ_FILES) return null;

  if ([timeline.startTime, timeline.endTime].some((timestamp) => validMs(timestamp) === null)) {
    return null;
  }
  const timestamps = [
    ...session.calls.map((call) => validMs(call.timestamp)),
    ...timeline.entries.map((entry) => validMs(entry.timestamp)),
  ];
  if (timestamps.length === 0 || timestamps.some((value) => value === null)) return null;
  const validTimestamps = timestamps.filter((value): value is number => value !== null);
  const latestMs = Math.max(...validTimestamps);
  if (!Number.isFinite(now) || now - latestMs < ACTIVE_QUIET_MS) return null;
  return {
    sessionId: session.sessionId,
    distinctReadFiles: distinct,
    latestMs,
    intentSource,
  };
}

export const detector: Detector = {
  id: 'reliability.ghost-session',
  category: 'reliability',
  dataDeps: ['toolData', 'timelines', 'liveConfig'],
  appliedMarkers: MARKERS_GHOST_SESSION,
  rule(input, now) {
    if (claudeMdMarksApplied(input.liveConfig, MARKERS_GHOST_SESSION)) return null;
    if (!input.toolData?.length || !input.timelines?.length) return null;
    const timelines = new Map(input.timelines.map((timeline) => [timeline.sessionId, timeline]));
    const candidates: GhostCandidate[] = [];
    for (const session of input.toolData) {
      const timeline = timelines.get(session.sessionId);
      if (!timeline) continue;
      const candidate = classifyGhostSession(session, timeline, now);
      if (candidate) candidates.push(candidate);
    }
    if (candidates.length === 0) return null;

    const dated = candidates.filter((candidate) => candidate.latestMs !== null);
    const newestMs = dated.length ? Math.max(...dated.map((candidate) => candidate.latestMs!)) : null;
    const asOf = newestMs === null ? undefined : new Date(newestMs).toISOString().slice(0, 10);
    const stale = newestMs !== null && Number.isFinite(now) && now - newestMs > FRESH_MS;
    const freshCount = candidates.filter(
      (candidate) => candidate.latestMs !== null && Number.isFinite(now) && now - candidate.latestMs <= FRESH_MS
    ).length;
    const promptIntentCount = candidates.filter((candidate) => candidate.intentSource === 'prompt').length;
    const failedEditIntentCount = candidates.length - promptIntentCount;
    const observations: RecObservation[] = [
      {
        claim: `${candidates.length} edit-intent session(s) read ${MIN_DISTINCT_READ_FILES}+ normalized paths with no successful native edit or delegation and no unknown tool attempt (a potentially workspace-mutating tool even after failure)`,
        source: 'parse-tools',
        field: 'toolData[].calls[].toolName / input.file_path / isError',
        value: candidates.length,
      },
      {
        claim: 'candidate sessions had no Bash calls and were quiet for at least 30 minutes after valid tool/timeline times; host helpers mean command text cannot prove no execution',
        source: 'parse-tools / parse-timeline',
        field: 'toolData[].calls[].toolName / input.command / commandPreview / commandFingerprint / calls[].timestamp / timelines[].startTime / endTime / entries[].timestamp',
        value: 0,
      },
      {
        claim: 'candidate sessions had one distinct user turn and no interrupt sentinel',
        source: 'parse-timeline',
        field: 'entries[].kind / entries[].timestamp / entries[].interrupted',
        value: '1 turn each; 0 interrupts',
      },
      {
        claim: `${promptIntentCount} candidate session(s) had conservative edit intent in the first prompt`,
        source: 'parse-timeline',
        field: 'firstPromptPreview',
        value: promptIntentCount,
      },
      {
        claim: `${failedEditIntentCount} candidate session(s) demonstrated edit intent through a failed native edit attempt`,
        source: 'parse-tools',
        field: 'toolData[].calls[].toolName / isError',
        value: failedEditIntentCount,
      },
    ];
    const datedPrefix = asOf
      ? `Transcript history through ${asOf} contained`
      : 'Undated transcript history contained';
    return {
      id: 'reliability.ghost-session',
      category: 'reliability',
      severity: freshCount >= 3 ? 'warning' : 'info',
      title: stale && asOf
        ? `Edit-intent sessions may have stopped after discovery as of ${asOf}`
        : 'Edit-intent sessions may have stopped after discovery',
      detail: `${datedPrefix} ${candidates.length} workspace-edit session(s) with ${MIN_DISTINCT_READ_FILES}+ distinct successful reads and no successful native mutation, delegated or unknown tool attempt, Bash call, or interrupt. This completion-risk signal does not prove failure.`,
      action: 'Review each session; make and verify the edit or state the blocker.',
      affected: candidates.length,
      view: 'timeline',
      evidence: candidates
        .sort((a, b) => b.distinctReadFiles - a.distinctReadFiles)
        .slice(0, 5)
        .map((candidate) => `${candidate.sessionId}: ${candidate.distinctReadFiles} distinct reads; 0 edits, 0 delegated/unknown tool attempts, 0 Bash calls, no interrupt`),
      provenance: {
        observations,
        inference: 'Prompt intent is conservative; every Bash and unknown tool attempt is excluded as ambiguous, as is delegation. The remaining sessions may have stopped after discovery, so this asks for review rather than asserting failure.',
        asOf,
        stale: stale || undefined,
      },
      claimClass: 'accounting',
      proofTier: 'auditable',
      fix: {
        target: 'CLAUDE.md',
        fixKind: 'validated',
        label: 'Add an edit-completion checkpoint',
        note: 'Add to CLAUDE.md to require edit completion.',
        snippet: `## Edit-session completion

When a task requests workspace changes, do not stop after discovery. Before ending, either make and verify the requested edit or state the concrete blocker explicitly.`,
        appliedMarkers: MARKERS_GHOST_SESSION,
      },
    };
  },
};
