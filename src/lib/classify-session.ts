import type { DistilledToolInput, ToolCall } from './parse-tools';
import type { SessionTokenData, TaskCategory } from '../types';
import { DEFAULT_TASK_CATEGORY, TASK_CATEGORY_TAXONOMY } from '../types';

export interface ClassifySessionSignals {
  title?: string | null;
  opener?: string | null;
  prompts?: readonly string[];
  gitBranch?: string | null;
  project?: string | null;
  tokenData?: Pick<SessionTokenData, 'opener' | 'gitBranch' | 'project'> | null;
  toolCalls?: readonly Pick<ToolCall, 'toolName' | 'input'>[];
}

type ScoreMap = Record<TaskCategory, number>;

const CATEGORY_ORDER = TASK_CATEGORY_TAXONOMY.map((c) => c.id);
const SCORABLE_CATEGORIES = CATEGORY_ORDER.filter(
  (c) => c !== DEFAULT_TASK_CATEGORY
);

const TEXT_RULES: Array<[TaskCategory, RegExp, number]> = [
  [
    'debugging',
    /\b(bug|broken|debug|diagnos|error|fail(?:ed|ing)?|fix|flake|regression|stack trace|test failure|traceback)\b/i,
    4,
  ],
  [
    'documentation',
    /\b(changelog|doc(?:s|umentation)?|guide|markdown|readme|release note|write-?up)\b/i,
    4,
  ],
  [
    'operations',
    /\b(ci|deploy|docker|github action|infra|kubernetes|merge|podman|publish|release|rollout|workflow)\b/i,
    4,
  ],
  [
    'review',
    /\b(audit|check|compare|critique|inspect|review|validate|verify)\b/i,
    3,
  ],
  [
    'planning',
    /\b(architecture|break down|decompose|design|estimate|milestone|plan|prd|roadmap|scope|spec|strategy)\b/i,
    3,
  ],
  [
    'implementation',
    /\b(add|build|change|create|implement|integrate|migrate|refactor|remove|rename|ship|update|wire)\b/i,
    3,
  ],
  [
    'research',
    /\b(analy[sz]e|explain|explore|find|how|investigate|list|read|research|search|show|understand|what|why)\b/i,
    2,
  ],
];

function blankScores(): ScoreMap {
  return Object.fromEntries(CATEGORY_ORDER.map((c) => [c, 0])) as ScoreMap;
}

function add(scores: ScoreMap, category: TaskCategory, amount: number): void {
  scores[category] = (scores[category] ?? 0) + amount;
}

function scoreText(scores: ScoreMap, value: unknown, multiplier = 1): void {
  if (typeof value !== 'string' || value.trim().length === 0) return;
  for (const [category, pattern, weight] of TEXT_RULES) {
    if (pattern.test(value)) add(scores, category, weight * multiplier);
  }
}

function scorePath(scores: ScoreMap, path: unknown): void {
  if (typeof path !== 'string') return;
  const lower = path.toLowerCase();
  if (/\.(md|mdx|rst|txt)$/.test(lower)) add(scores, 'documentation', 3);
  if (/(^|[/_.-])(test|spec)([/_.-]|$)/.test(lower)) add(scores, 'debugging', 2);
  if (/\.(ts|tsx|js|jsx|py|go|rs|java|scala|rb|php|css|scss)$/.test(lower)) {
    add(scores, 'implementation', 1);
  }
}

function scoreCommand(scores: ScoreMap, command: unknown): void {
  if (typeof command !== 'string') return;
  scoreText(scores, command, 0.5);
  if (/\b(npm|pnpm|yarn|bun|pytest|vitest|jest|go test|cargo test|tsc|lint)\b/i.test(command)) {
    add(scores, 'debugging', 2);
  }
  if (/\b(git|gh|docker|podman|kubectl|terraform|flyctl|vercel|netlify)\b/i.test(command)) {
    add(scores, 'operations', 2);
  }
}

function scoreToolInput(scores: ScoreMap, input: DistilledToolInput | undefined): void {
  if (!input) return;
  scorePath(scores, input.file_path);
  scoreCommand(scores, input.command);
  scoreText(scores, input.skill, 2);
  scoreText(scores, input.subagent_type, 1);
}

function scoreTools(
  scores: ScoreMap,
  calls: readonly Pick<ToolCall, 'toolName' | 'input'>[] | undefined
): void {
  for (const call of calls ?? []) {
    const toolName = call.toolName;
    if (toolName === 'Read' || toolName === 'Grep' || toolName === 'Glob') {
      add(scores, 'research', 1);
    } else if (
      toolName === 'Edit' ||
      toolName === 'MultiEdit' ||
      toolName === 'NotebookEdit' ||
      toolName === 'Write'
    ) {
      add(scores, 'implementation', 2);
    } else if (toolName === 'Task' || toolName === 'Agent') {
      add(scores, 'planning', 1);
    } else if (toolName === 'Skill') {
      add(scores, 'review', 1);
    }
    scoreText(scores, toolName, 0.5);
    scoreToolInput(scores, call.input);
  }
}

function winner(scores: ScoreMap): TaskCategory {
  let best: TaskCategory = DEFAULT_TASK_CATEGORY;
  let bestScore = 0;
  for (const category of SCORABLE_CATEGORIES) {
    const score = scores[category] ?? 0;
    if (score > bestScore) {
      best = category;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : DEFAULT_TASK_CATEGORY;
}

export function classifySession(
  signals: ClassifySessionSignals = {}
): TaskCategory {
  const scores = blankScores();
  scoreText(scores, signals.title, 1.5);
  scoreText(scores, signals.opener ?? signals.tokenData?.opener, 1.25);
  scoreText(scores, signals.gitBranch ?? signals.tokenData?.gitBranch, 0.75);
  scoreText(scores, signals.project ?? signals.tokenData?.project, 0.5);
  for (const prompt of signals.prompts ?? []) scoreText(scores, prompt);
  scoreTools(scores, signals.toolCalls);
  return winner(scores);
}
