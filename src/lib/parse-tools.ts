import { parseJsonl, parseMessage } from './parse-utils';
import { bashCommandFingerprint } from './bash-command-fingerprint';
import {
  detectRiskyActionPatternName,
  rmRfCertainty,
  dangerousFragment,
  dangerousPatternCertainty,
  executableShellSkeleton,
  matchingDangerousPermissionRules,
  executableShellSegments,
  executableShellSource,
  shellHeredocs,
} from './parse-permissions';
import {
  LEAVE_BEHIND_CONTRACT,
  leaveBehindStateScope,
  validateLeaveBehindArtifact,
} from './leave-behind';
// The tool-call shapes live in a dependency-free leaf (#1582) so `parse-permissions`
// can import `ToolUsageData` WITHOUT a (type-only) cycle back through this module,
// which imports its classifier VALUES. Re-exported so every existing
// `from './parse-tools'` importer is unaffected.
import type {
  DistilledToolInput,
  BypassCategory,
  DurableCommandKind,
  ToolCall,
  ToolUsageData,
} from './parse-tools-types';
export type {
  DistilledToolInput,
  BypassCategory,
  DangerousCommandCertainty,
  DurableCommandKind,
  ToolCall,
  ToolUsageData,
} from './parse-tools-types';

// `DistilledToolInput`, `BypassCategory`, `ToolCall`, and `ToolUsageData` are
// defined in the `./parse-tools-types` leaf and re-exported above (#1582). The
// `input` consumer map for reference: Bash `command` → parse-tools (topBashCommands
// / bypass / subcommand / repeated) + parse-permissions (detectDangerousCommands);
// file tools `file_path` → parse-files; Task `subagent_type` and Skill `skill` →
// parse-agents.

export interface ToolAggregate {
  toolName: string;
  count: number;
  errorCount: number;
  errorRate: number;
}

export interface BashCommandStat {
  command: string;
  count: number;
}

const MAX_COMMAND_PREVIEW_LEN = 200;
const MAX_COMMAND_GIT_SEGMENTS = 12;

const CONFIG_SOURCE_RE = /\.(?:tmpl|template|example|sample|dist)$/i;
const CONFIG_OUTPUT_RE = /\.(?:ya?ml|json|env|conf|toml|ini|service)$/i;

function optionPrefix(tokens: string[]): string[] {
  const end = tokens.indexOf('--', 1);
  return tokens.slice(1, end < 0 ? undefined : end);
}

function hasHelpFlag(tokens: string[]): boolean {
  return optionPrefix(tokens).some(
    (token) =>
      token === '--help' || token === '-help' || token === '--version'
  );
}

function hasShortHelpFlag(tokens: string[]): boolean {
  return optionPrefix(tokens).includes('-h');
}

function hasDryRunFlag(tokens: string[]): boolean {
  return optionPrefix(tokens).some(
    (token) =>
      token === '--dry' ||
      token === '--dry-run' ||
      token.startsWith('--dry-run=')
  );
}

function isNonMutatingInvocation(tokens: string[]): boolean {
  return hasHelpFlag(tokens) || hasDryRunFlag(tokens);
}

function firstSubcommand(
  tokens: string[],
  optionsWithArgument: ReadonlySet<string> = new Set(),
  combinedOptionWithArgument?: RegExp
): { command: string; index: number } {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--') {
      return { command: tokens[index + 1] ?? '', index: index + 1 };
    }
    if (!token.startsWith('-')) return { command: token, index };
    if (
      optionsWithArgument.has(token) ||
      combinedOptionWithArgument?.test(token)
    ) {
      index += 1;
    }
  }
  return { command: '', index: -1 };
}

const KUBECTL_OPTIONS_WITH_ARGUMENT = new Set([
  '--as',
  '--as-group',
  '--cache-dir',
  '--certificate-authority',
  '--client-certificate',
  '--client-key',
  '--cluster',
  '--context',
  '--kubeconfig',
  '--namespace',
  '-n',
  '--request-timeout',
  '--server',
  '-s',
  '--token',
  '--user',
]);
const HELM_OPTIONS_WITH_ARGUMENT = new Set([
  '--kube-apiserver',
  '--kube-context',
  '--kube-token',
  '--kubeconfig',
  '--namespace',
  '-n',
  '--registry-config',
  '--repository-cache',
  '--repository-config',
]);
const CONTAINER_OPTIONS_WITH_ARGUMENT = new Set([
  '--context',
  '-c',
  '--host',
  '-H',
  '--log-level',
]);
const COMPOSE_OPTIONS_WITH_ARGUMENT = new Set([
  '--env-file',
  '-f',
  '--file',
  '--parallel',
  '--profile',
  '-p',
  '--project-directory',
  '--project-name',
  '--progress',
]);
const VERCEL_OPTIONS_WITH_ARGUMENT = new Set([
  '--cwd',
  '--global-config',
  '--scope',
  '-S',
  '--token',
]);
const FLY_OPTIONS_WITH_ARGUMENT = new Set(['--config', '-c', '--org', '-o']);
const SYSTEMCTL_OPTIONS_WITH_ARGUMENT = new Set([
  '--boot-loader-entry',
  '--boot-loader-menu',
  '--capsule',
  '--check-inhibitors',
  '--drop-in',
  '--host',
  '-H',
  '--image',
  '--image-policy',
  '--job-mode',
  '--kill-subgroup',
  '--kill-value',
  '--kill-whom',
  '--legend',
  '--lines',
  '--machine',
  '-M',
  '--message',
  '--output',
  '-o',
  '--preset-mode',
  '--property',
  '-p',
  '--reboot-argument',
  '--root',
  '--signal',
  '-s',
  '--state',
  '--timestamp',
  '--type',
  '-t',
  '--what',
  '--when',
]);
const SYSTEMCTL_COMBINED_OPTION_WITH_ARGUMENT = /^-[halrTiqvf]*[CHMPtnpso]$/;
const SYSTEMCTL_HELP_SHORT_CLUSTER = /^-[alrTiqvfh]+[CHMPtnpso]?$/;
const SYSTEMCTL_PERSISTENT_MUTATIONS = new Set([
  'add-requires',
  'add-wants',
  'disable',
  'enable',
  'link',
  'mask',
  'preset',
  'preset-all',
  'reenable',
  'revert',
  'unmask',
]);
const SYSTEMCTL_REMOTE_MUTATIONS = new Set([
  ...SYSTEMCTL_PERSISTENT_MUTATIONS,
  'reload',
  'restart',
  'start',
  'stop',
]);

function hasSystemctlShortHelpFlag(tokens: string[]): boolean {
  return optionPrefix(tokens).some(
    (token) =>
      token.includes('h') && SYSTEMCTL_HELP_SHORT_CLUSTER.test(token)
  );
}

function isDeploymentMutationSegment(tokens: string[]): boolean {
  if (isNonMutatingInvocation(tokens) || hasShortHelpFlag(tokens)) return false;
  const head = tokens[0];
  if (head === 'kubectl' || head === 'k') {
    if (
      optionPrefix(tokens).some(
        (token) => token === '--local' || token === '--local=true'
      )
    ) {
      return false;
    }
    const { command: verb, index } = firstSubcommand(
      tokens,
      KUBECTL_OPTIONS_WITH_ARGUMENT
    );
    if (verb === 'rollout') {
      return ['restart', 'undo', 'pause', 'resume'].includes(tokens[index + 1]);
    }
    if (
      (verb === 'annotate' || verb === 'label' || verb === 'set') &&
      tokens.includes('--list')
    ) {
      return false;
    }
    return [
      'annotate',
      'apply',
      'cordon',
      'create',
      'delete',
      'drain',
      'label',
      'patch',
      'replace',
      'scale',
      'set',
      'taint',
      'uncordon',
    ].includes(verb);
  }
  if (head === 'helm') {
    const { command: verb } = firstSubcommand(tokens, HELM_OPTIONS_WITH_ARGUMENT);
    return ['install', 'rollback', 'uninstall', 'upgrade'].includes(verb);
  }
  if (head === 'terraform' || head === 'tofu') {
    const { command: verb } = firstSubcommand(tokens);
    return ['apply', 'destroy', 'import', 'taint'].includes(verb);
  }
  if (head === 'pulumi') {
    const { command: verb } = firstSubcommand(tokens);
    return (
      ['up', 'destroy', 'import'].includes(verb) &&
      !tokens.includes('--preview-only')
    );
  }
  if (head === 'cdk') {
    return firstSubcommand(tokens).command === 'deploy';
  }
  if (head === 'aws') {
    const { command: service, index } = firstSubcommand(tokens);
    const action = firstSubcommand(tokens.slice(index)).command;
    return (
      (service === 'cloudformation' && action === 'deploy') ||
      (service === 'ecs' && action === 'update-service') ||
      (service === 'ssm' && action === 'put-parameter')
    );
  }
  if (head === 'ansible-playbook') {
    if (tokens.includes('--version')) return false;
    return !tokens.some((token) =>
      [
        '--check',
        '-C',
        '--syntax-check',
        '--list-hosts',
        '--list-tags',
        '--list-tasks',
      ].includes(token)
    );
  }
  if (head === 'docker' || head === 'podman') {
    const compose = firstSubcommand(tokens, CONTAINER_OPTIONS_WITH_ARGUMENT);
    if (compose.command !== 'compose') return false;
    const action = firstSubcommand(
      tokens.slice(compose.index),
      COMPOSE_OPTIONS_WITH_ARGUMENT
    );
    return ['down', 'restart', 'start', 'stop', 'up'].includes(action.command);
  }
  if (head === 'flyctl' || head === 'fly') {
    return firstSubcommand(tokens, FLY_OPTIONS_WITH_ARGUMENT).command === 'deploy';
  }
  if (head === 'vercel') {
    const top = firstSubcommand(tokens, VERCEL_OPTIONS_WITH_ARGUMENT);
    if (top.command === 'deploy') return true;
    if (top.command !== 'env') return false;
    const action = firstSubcommand(tokens.slice(top.index));
    return ['add', 'rm', 'remove', 'update'].includes(action.command);
  }
  return head === 'netlify' && firstSubcommand(tokens).command === 'deploy';
}

function isRemoteLocation(token: string | undefined): boolean {
  if (!token || /^[A-Za-z]:[\\/]/.test(token)) return false;
  return (
    /^(?:scp|rsync):\/\//i.test(token) ||
    /^(?:[^@\s/:]+@)?[^\s/:]+:.+$/.test(token)
  );
}

const SSH_OPTIONS_WITH_ARGUMENT = new Set([
  '-B', '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m',
  '-O', '-o', '-P', '-p', '-Q', '-R', '-S', '-W', '-w',
]);
const SSH_NO_ARGUMENT_SHORT_CLUSTER = /^-[1246AaCfGgKkMNnqsTtVvXxYy]+$/;

function sshShortClusterHas(option: string, flags: string): boolean {
  return (
    SSH_NO_ARGUMENT_SHORT_CLUSTER.test(option) &&
    [...flags].some((flag) => option.includes(flag))
  );
}

/** ssh modes that inspect local state or establish forwarding and exit without
 * running the command-looking operands on the destination. */
function isSshQueryInvocation(tokens: string[]): boolean {
  for (let index = 1; index < tokens.length; index += 1) {
    const option = tokens[index];
    if (option === '--' || !option.startsWith('-')) return false;
    if (
      sshShortClusterHas(option, 'GNV') ||
      option === '-W' ||
      option.startsWith('-W') ||
      option === '-Q' ||
      option.startsWith('-Q') ||
      option === '-O' ||
      option.startsWith('-O')
    ) {
      return true;
    }
    if (option.length === 2 && SSH_OPTIONS_WITH_ARGUMENT.has(option)) index += 1;
  }
  return false;
}

/** `ssh -n` detaches stdin and `ssh -f` implies it. The explicit remote
 * payload still executes, but a local heredoc cannot become its program. */
function sshDisablesStdin(tokens: string[]): boolean {
  for (let index = 1; index < tokens.length; index += 1) {
    const option = tokens[index];
    if (option === '--' || !option.startsWith('-')) return false;
    if (sshShortClusterHas(option, 'fn')) return true;
    if (option.length === 2 && SSH_OPTIONS_WITH_ARGUMENT.has(option)) index += 1;
  }
  return false;
}

function sshPayload(tokens: string[]): string {
  let index = 1;
  while (index < tokens.length && tokens[index].startsWith('-')) {
    if (tokens[index] === '--') {
      index += 1;
      break;
    }
    const option = tokens[index];
    index += option.length === 2 && SSH_OPTIONS_WITH_ARGUMENT.has(option) ? 2 : 1;
  }
  if (index >= tokens.length) return '';
  index += 1; // destination host
  if (tokens[index] === '--') index += 1;
  return tokens.slice(index).join(' ');
}

const SHELL_EXECUTABLES = new Set(['bash', 'dash', 'ksh', 'sh', 'zsh']);
const SHELL_NON_EXECUTING_LONG_OPTIONS = new Set([
  '--dump-po-strings',
  '--dump-strings',
  '--help',
  '--rpm-requires',
  '--version',
]);

interface ShellInvocation {
  noExec: boolean;
  commandPayload: string | null;
  hasCommandFlag: boolean;
  readsStdin: boolean;
  scriptOperand: string | null;
}

function parseShellInvocation(tokens: string[]): ShellInvocation | null {
  if (!SHELL_EXECUTABLES.has(tokens[0])) return null;
  const argv = [tokens[0]];
  for (let index = 1; index < tokens.length; index += 1) {
    if (/^\d*>>?$/.test(tokens[index])) {
      index += 1;
      continue;
    }
    if (tokens[index] === '<<' || tokens[index] === '<<-') {
      index += 1;
      continue;
    }
    if (tokens[index].startsWith('<<')) continue;
    argv.push(tokens[index]);
  }
  let noExec = false;
  let readsStdin = false;
  let index = 1;

  for (; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      index += 1;
      break;
    }
    if (token === '--noexec') {
      noExec = true;
      continue;
    }
    if (SHELL_NON_EXECUTING_LONG_OPTIONS.has(token)) {
      noExec = true;
      continue;
    }
    if (token === '--stdin') {
      readsStdin = true;
      continue;
    }
    if (token.startsWith('--command=')) {
      return {
        noExec,
        commandPayload: token.slice('--command='.length) || null,
        hasCommandFlag: true,
        readsStdin,
        scriptOperand: null,
      };
    }
    if (token === '--command') {
      const payload = argv[index + 1];
      return {
        noExec,
        commandPayload: payload && !payload.startsWith('<') ? payload : null,
        hasCommandFlag: true,
        readsStdin,
        scriptOperand: null,
      };
    }
    if (token === '--init-file' || token === '--rcfile') {
      index += 1;
      continue;
    }
    if (token === '-O' || token === '+O' || token === '-o' || token === '+o') {
      index += 1;
      continue;
    }
    if (/^[+-][^-]+$/.test(token)) {
      const enabled = token.startsWith('-');
      const flags = token.slice(1);
      const optionArgumentCount = [...flags].filter(
        (flag) => flag === 'o' || flag === 'O'
      ).length;
      if (flags.includes('n')) noExec = enabled;
      if (flags.includes('D')) noExec = enabled;
      if (flags.includes('s')) readsStdin = enabled;
      if (enabled && flags.includes('c')) {
        const payload = argv[index + 1 + optionArgumentCount];
        return {
          noExec,
          commandPayload: payload && !payload.startsWith('<') ? payload : null,
          hasCommandFlag: true,
          readsStdin,
          scriptOperand: null,
        };
      }
      index += optionArgumentCount;
      continue;
    }
    if (token.startsWith('--')) continue;
    break;
  }

  const operands = argv.slice(index);
  const scriptOperand = operands[0] ?? null;
  const readsProgramFromStdin =
    scriptOperand == null ||
    scriptOperand === '-' ||
    /^(?:\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/.test(scriptOperand);
  return {
    noExec,
    commandPayload: null,
    hasCommandFlag: false,
    readsStdin,
    scriptOperand: readsStdin || readsProgramFromStdin ? null : scriptOperand,
  };
}

function shellCommandPayload(tokens: string[]): string | null {
  const invocation = parseShellInvocation(tokens);
  return invocation && !invocation.noExec ? invocation.commandPayload : null;
}

function shellConsumesStdinProgram(tokens: string[]): boolean {
  const invocation = parseShellInvocation(tokens);
  return !!(
    invocation &&
    !invocation.noExec &&
    !invocation.hasCommandFlag &&
    invocation.scriptOperand == null
  );
}

/** Whether this shell reads its program from stdin rather than -c or a file. */
function shellConsumesHeredoc(
  tokens: string[],
  delimiter: string
): boolean {
  if (
    !shellConsumesStdinProgram(tokens) ||
    !tokens.some(
      (token, index) =>
        token === `<<${delimiter}` ||
        token === `<<-${delimiter}` ||
        ((token === '<<' || token === '<<-') &&
          tokens[index + 1] === delimiter)
    )
  ) {
    return false;
  }

  return true;
}

/** Commands inside `$()`, backticks, and process substitutions execute even
 * when embedded in another command. Single quotes keep them literal. */
function scannerBackslashEscapes(
  quote: "'" | '"' | '`' | null,
  next: string | undefined
): boolean {
  if (quote === "'") return false;
  if (quote === '"') return next != null && /[$`"\\\n\r]/.test(next);
  if (quote === '`') return next != null && /[$`\\\n\r]/.test(next);
  return next != null;
}

function commandSubstitutionBodies(
  command: string,
  includeUnclosed = false,
  includeProcessSubstitutions = true
): string[] {
  const bodies: string[] = [];
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && scannerBackslashEscapes(quote, command[index + 1])) {
      escaped = true;
      continue;
    }
    if (quote === '"' && ch === '"') {
      quote = null;
      continue;
    }
    if (quote === null && ch === "'") {
      quote = "'";
      continue;
    }
    if (quote === null && ch === '"') {
      quote = '"';
      continue;
    }

    if (ch === '`') {
      let end = index + 1;
      let backtickEscaped = false;
      for (; end < command.length; end += 1) {
        const inner = command[end];
        if (backtickEscaped) {
          backtickEscaped = false;
          continue;
        }
        if (inner === '\\') {
          backtickEscaped = true;
          continue;
        }
        if (inner === '`') break;
      }
      if (end < command.length) {
        bodies.push(command.slice(index + 1, end));
        index = end;
      }
      continue;
    }

    const commandSubstitution =
      ch === '$' && command[index + 1] === '(' && command[index + 2] !== '(';
    const processSubstitution =
      includeProcessSubstitutions &&
      quote === null &&
      (ch === '<' || ch === '>') &&
      command[index + 1] === '(';
    if (!commandSubstitution && !processSubstitution) {
      continue;
    }
    let depth = 1;
    let end = index + 2;
    let innerQuote: "'" | '"' | null = null;
    let innerEscaped = false;
    for (; end < command.length; end += 1) {
      const inner = command[end];
      if (innerQuote === "'") {
        if (inner === "'") innerQuote = null;
        continue;
      }
      if (innerEscaped) {
        innerEscaped = false;
        continue;
      }
      if (
        inner === '\\' &&
        scannerBackslashEscapes(innerQuote, command[end + 1])
      ) {
        innerEscaped = true;
        continue;
      }
      if (innerQuote) {
        if (inner === innerQuote) innerQuote = null;
        continue;
      }
      if (inner === "'" || inner === '"') {
        innerQuote = inner;
        continue;
      }
      if (inner === '(') depth += 1;
      if (inner === ')') depth -= 1;
      if (depth === 0) break;
    }
    if (depth === 0) {
      bodies.push(command.slice(index + 2, end));
      index = end;
    } else if (includeUnclosed) {
      bodies.push(command.slice(index + 2));
      break;
    }
  }
  return bodies;
}

/** Split unquoted shell pipelines while keeping control operators as group
 * breaks. `|&` is one pipeline operator, while `>&`/`<&` and `>|` remain
 * redirections inside their stage. */
function shellPipelineGroups(command: string): string[][] {
  const groups: string[][] = [[]];
  let start = 0;
  let quote: "'" | '"' | '`' | null = null;
  let escaped = false;
  const pushStage = (end: number) => {
    const stage = command.slice(start, end).trim();
    if (stage) groups[groups.length - 1].push(stage);
  };

  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index];
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\' && scannerBackslashEscapes(quote, command[index + 1])) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    const previous = command[index - 1];
    const next = command[index + 1];
    const pipeAnd = ch === '|' && next === '&';
    const singlePipe =
      ch === '|' && previous !== '|' && previous !== '>' && next !== '|';
    const redirectedAmpersand =
      ch === '&' && (previous === '>' || previous === '<' || next === '>');
    const doubleControl =
      (ch === '&' && next === '&') || (ch === '|' && next === '|');
    const controlBreak =
      ch === ';' ||
      ch === '\n' ||
      doubleControl ||
      (ch === '&' && !redirectedAmpersand);
    if (!singlePipe && !controlBreak) continue;
    pushStage(index);
    const operatorLength = pipeAnd || doubleControl ? 2 : 1;
    start = index + operatorLength;
    if (controlBreak) groups.push([]);
    if (operatorLength === 2) index += 1;
  }
  pushStage(command.length);
  return groups.filter((group) => group.length > 0);
}

function pipelineStageTokens(stage: string): string[] | null {
  return executableShellSegments(stage)[0] ?? null;
}

/** Commands whose stdout remains the pipeline's input stream. Keep this
 * deliberately narrow: `tee` always copies stdin to stdout, and operand-free
 * `cat` does too. */
function isPipelinePassThrough(tokens: string[]): boolean {
  if (tokens[0] === 'tee') return true;
  return (
    tokens[0] === 'cat' &&
    tokens.slice(1).every((token) => token === '-' || token.startsWith('-'))
  );
}

function pipelineReachesConsumer(
  stages: string[],
  producerIndex: number,
  consumes: (tokens: string[]) => boolean
): boolean {
  for (let index = producerIndex + 1; index < stages.length; index += 1) {
    const tokens = pipelineStageTokens(stages[index]);
    if (!tokens) return false;
    if (consumes(tokens)) return true;
    if (!isPipelinePassThrough(tokens)) return false;
  }
  return false;
}

function pipelineConsumesHeredoc(commandLine: string, delimiter: string): boolean {
  for (const stages of shellPipelineGroups(commandLine)) {
    for (let index = 0; index < stages.length - 1; index += 1) {
      const ownsHeredoc = shellHeredocs(stages[index]).some(
        (heredoc) => heredoc.delimiter === delimiter
      );
      if (!ownsHeredoc) continue;
      if (pipelineReachesConsumer(stages, index, shellConsumesStdinProgram)) {
        return true;
      }
    }
  }
  return false;
}

function sshConsumesStdinProgram(tokens: string[]): boolean {
  if (
    tokens[0] !== 'ssh' ||
    isSshQueryInvocation(tokens) ||
    sshDisablesStdin(tokens)
  ) {
    return false;
  }
  const payload = sshPayload(tokens);
  if (!payload) return true;
  const consumer = executableShellSegments(payload)[0];
  return !!(consumer && shellConsumesStdinProgram(consumer));
}

function pipelineFeedsRemoteShell(
  commandLine: string,
  delimiter: string
): boolean {
  for (const stages of shellPipelineGroups(commandLine)) {
    for (let index = 0; index < stages.length - 1; index += 1) {
      const ownsHeredoc = shellHeredocs(stages[index]).some(
        (heredoc) => heredoc.delimiter === delimiter
      );
      if (!ownsHeredoc) continue;
      if (pipelineReachesConsumer(stages, index, sshConsumesStdinProgram)) {
        return true;
      }
    }
  }
  return false;
}

function nestedCommandConsumesHeredoc(
  commandLine: string,
  delimiter: string
): boolean {
  return commandSubstitutionBodies(commandLine, true).some((body) => {
    const segments = executableShellSegments(body);
    return (
      segments.some((segment) => shellConsumesHeredoc(segment, delimiter)) ||
      pipelineConsumesHeredoc(body, delimiter)
    );
  });
}

function heredocExecutableBodies(command: string): string[] {
  const bodies: string[] = [];
  for (const heredoc of shellHeredocs(command)) {
    const headerSegments = executableShellSegments(heredoc.commandLine);
    if (
      headerSegments.some((segment) =>
        shellConsumesHeredoc(segment, heredoc.delimiter)
      ) ||
      pipelineConsumesHeredoc(heredoc.commandLine, heredoc.delimiter) ||
      nestedCommandConsumesHeredoc(heredoc.commandLine, heredoc.delimiter)
    ) {
      bodies.push(heredoc.body);
    } else if (!heredoc.quoted) {
      // An unquoted delimiter enables command substitution even when the
      // receiving command treats the heredoc as plain data (for example cat).
      bodies.push(...commandSubstitutionBodies(heredoc.body, false, false));
    }
  }
  return bodies;
}

function remoteHeredocBodies(command: string): string[] {
  const bodies: string[] = [];
  for (const heredoc of shellHeredocs(command)) {
    const contexts = [
      heredoc.commandLine,
      ...commandSubstitutionBodies(heredoc.commandLine, true),
    ];
    if (pipelineFeedsRemoteShell(heredoc.commandLine, heredoc.delimiter)) {
      bodies.push(heredoc.body);
    }
    for (const context of contexts) {
      const headerSegments = executableShellSegments(context);
      for (const segment of headerSegments) {
        if (segment[0] !== 'ssh') continue;
        if (isSshQueryInvocation(segment) || sshDisablesStdin(segment)) continue;
        const payload = sshPayload(segment);
        if (!payload) {
          bodies.push(heredoc.body);
          continue;
        }
        const payloadSegments = executableShellSegments(payload);
        if (
          payloadSegments.some((payloadSegment) =>
            shellConsumesHeredoc(payloadSegment, heredoc.delimiter)
          ) ||
          payloadSegments.every((payloadSegment) =>
            payloadSegment.every((token) => token.startsWith('<<'))
          )
        ) {
          bodies.push(heredoc.body);
        }
      }
    }
  }
  return bodies;
}

function shellOutputPaths(tokens: string[]): string[] {
  const paths: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (!/^\d*>>?$/.test(tokens[index])) continue;
    const target = tokens[index + 1];
    if (!target || /^&(?:\d+|-)$/.test(target)) continue;
    paths.push(target.startsWith('&') ? target.slice(1) : target);
  }
  return paths;
}

function commandOutputPaths(tokens: string[]): string[] {
  const paths: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--output' || token === '-o') {
      if (tokens[index + 1]) paths.push(tokens[index + 1]);
    } else if (token.startsWith('--output=')) {
      paths.push(token.slice('--output='.length));
    }
  }
  return paths;
}

function isDiscardOutputPath(path: string): boolean {
  const clean = path.replace(/[)}]+$/, '');
  return /^(?:\/dev\/(?:null|stdin|stdout|stderr|fd\/\d+)|\/proc\/self\/fd\/\d+)$/.test(
    clean
  );
}

function isCrontabMutation(tokens: string[]): boolean {
  return (
    tokens.length > 1 &&
    !tokens.some((token) =>
      ['-l', '--list', '-T', '--test', '--help'].includes(token)
    )
  );
}

function isRemoteFilesystemMutationSegment(tokens: string[]): boolean {
  if (isNonMutatingInvocation(tokens)) return false;
  const head = tokens[0];
  if (head === 'tee') {
    return tokens
      .slice(1)
      .some(
        (token) => !token.startsWith('-') && !isDiscardOutputPath(token)
      );
  }
  if (
    [
      'chmod',
      'chown',
      'cp',
      'install',
      'ln',
      'mkdir',
      'mv',
      'rm',
      'rmdir',
      'touch',
      'truncate',
    ].includes(head)
  ) {
    return true;
  }
  if (head === 'systemctl') {
    if (hasShortHelpFlag(tokens) || hasSystemctlShortHelpFlag(tokens)) {
      return false;
    }
    const { command: verb } = firstSubcommand(
      tokens,
      SYSTEMCTL_OPTIONS_WITH_ARGUMENT,
      SYSTEMCTL_COMBINED_OPTION_WITH_ARGUMENT
    );
    return SYSTEMCTL_REMOTE_MUTATIONS.has(verb);
  }
  if (head === 'launchctl') {
    return ['bootstrap', 'bootout', 'kickstart', 'load', 'unload'].includes(tokens[1]);
  }
  if (head === 'crontab') return isCrontabMutation(tokens);
  if (
    head === 'sed' &&
    optionPrefix(tokens).some(
      (token) => /^-[^-]*i/.test(token) || /^--in-place(?:=|$)/.test(token)
    )
  ) {
    return true;
  }
  return shellOutputPaths(tokens).some((path) => !isDiscardOutputPath(path));
}

function isSshRemoteMutation(tokens: string[], depth: number): boolean {
  if (isSshQueryInvocation(tokens)) return false;
  const payload = sshPayload(tokens);
  if (!payload) return false;
  return isRemotePayloadMutation(payload, depth + 1);
}

function isRemoteStateSegment(tokens: string[], depth: number): boolean {
  if (isNonMutatingInvocation(tokens)) return false;
  if (isDeploymentMutationSegment(tokens)) return true;
  const head = tokens[0];
  if (head === 'scp' || head === 'rsync') {
    if (
      head === 'rsync' &&
      optionPrefix(tokens).some(
        (token) =>
          token === '--list-only' ||
          token === '-n' ||
          /^-[^-]*n/.test(token)
      )
    ) {
      return false;
    }
    return isRemoteLocation(tokens[tokens.length - 1]?.replace(/[)}]+$/, ''));
  }
  return head === 'ssh' && isSshRemoteMutation(tokens, depth);
}

function isExternalConfigOutput(path: string | null): boolean {
  if (!path) return false;
  const clean = path.replace(/[)}]+$/, '');
  const external = /^(?:~\/\.config\/|\/etc\/|\/usr\/local\/etc\/|\/var\/(?:lib|opt)\/|\/opt\/|\/srv\/|\/(?:home\/[^/]+|Users\/[^/]+)\/\.config\/)/.test(
    clean
  );
  return external && CONFIG_OUTPUT_RE.test(clean);
}

function isGeneratedConfigSegment(tokens: string[]): boolean {
  if (hasHelpFlag(tokens)) return false;
  const [head, verb] = tokens;
  if (
    ['envsubst', 'gomplate', 'jinja2', 'mustache', 'ytt'].includes(head) ||
    (head === 'kustomize' && verb === 'build') ||
    (head === 'helm' &&
      firstSubcommand(tokens, HELM_OPTIONS_WITH_ARGUMENT).command === 'template')
  ) {
    return [...shellOutputPaths(tokens), ...commandOutputPaths(tokens)].some(
      isExternalConfigOutput
    );
  }
  if (head === 'cp' || head === 'install') {
    const positional = tokens.slice(1).filter((token) => !token.startsWith('-'));
    return (
      positional.length >= 2 &&
      CONFIG_SOURCE_RE.test(positional[positional.length - 2]) &&
      isExternalConfigOutput(positional[positional.length - 1])
    );
  }
  if (head === 'tee') {
    return tokens.slice(1).some(isExternalConfigOutput);
  }
  if (!['sed', 'perl', 'python', 'node'].includes(head)) return false;
  return shellOutputPaths(tokens).some(isExternalConfigOutput);
}

function isDurableInstallSegment(tokens: string[]): boolean {
  if (isNonMutatingInvocation(tokens) || hasShortHelpFlag(tokens)) return false;
  const [head, verb, subverb] = tokens;
  if (['apt-get', 'apt'].includes(head)) {
    if (verb === 'help') return false;
    if (
      optionPrefix(tokens).some((token) =>
        [
          '-s',
          '-d',
          '--simulate',
          '--just-print',
          '--no-act',
          '--download-only',
        ].includes(token)
      )
    ) {
      return false;
    }
    return tokens.includes('install');
  }
  if (head === 'brew') return firstSubcommand(tokens).command === 'install';
  if (head === 'systemctl') {
    if (hasSystemctlShortHelpFlag(tokens)) return false;
    return SYSTEMCTL_PERSISTENT_MUTATIONS.has(
      firstSubcommand(
        tokens,
        SYSTEMCTL_OPTIONS_WITH_ARGUMENT,
        SYSTEMCTL_COMBINED_OPTION_WITH_ARGUMENT
      ).command
    );
  }
  if (head === 'launchctl') return verb === 'load' || verb === 'bootstrap';
  if (head === 'crontab') return isCrontabMutation(tokens);
  return (
    (head === 'docker' || head === 'podman') &&
    verb === 'volume' &&
    subverb === 'create'
  );
}

function nestedExecutableBodies(
  rawCommand: string,
  executableSource: string,
  segments: string[][]
): string[] {
  return [
    ...commandSubstitutionBodies(executableSource),
    ...segments
      .map(shellCommandPayload)
      .filter((payload): payload is string => payload !== null),
    ...heredocExecutableBodies(rawCommand),
  ];
}

/** Classify a payload while retaining the fact that its filesystem is remote. */
function isRemotePayloadMutation(command: string, depth: number): boolean {
  const executableSource = executableShellSource(command);
  const segments = executableShellSegments(command);
  if (
    segments.some(
      (segment) =>
        isRemoteStateSegment(segment, depth) ||
        isRemoteFilesystemMutationSegment(segment) ||
        isGeneratedConfigSegment(segment) ||
        isDurableInstallSegment(segment)
    )
  ) {
    return true;
  }
  if (depth >= 4) return false;
  if (
    remoteHeredocBodies(command).some((body) =>
      isRemotePayloadMutation(body, depth + 1)
    )
  ) {
    return true;
  }
  return nestedExecutableBodies(command, executableSource, segments).some(
    (body) => isRemotePayloadMutation(body, depth + 1)
  );
}

function isPipeToShellInstall(command: string): boolean {
  for (const stages of shellPipelineGroups(command)) {
    for (let index = 0; index < stages.length - 1; index += 1) {
      const producer = pipelineStageTokens(stages[index]);
      if (!producer || !['curl', 'wget'].includes(producer[0])) continue;
      if (pipelineReachesConsumer(stages, index, shellConsumesStdinProgram)) {
        return true;
      }
    }
  }
  return false;
}

function classifyDurableCommandInternal(
  command: string,
  depth: number
): DurableCommandKind | null {
  const executableSource = executableShellSource(command);
  const segments = executableShellSegments(command);
  if (segments.some((segment) => isRemoteStateSegment(segment, depth))) {
    return 'remote-state';
  }
  if (
    depth < 4 &&
    remoteHeredocBodies(command).some((body) =>
      isRemotePayloadMutation(body, depth + 1)
    )
  ) {
    return 'remote-state';
  }
  if (segments.some(isGeneratedConfigSegment)) return 'generated-config';
  if (segments.some(isDurableInstallSegment)) return 'multi-step-install';
  if (depth < 4) {
    for (const body of nestedExecutableBodies(command, executableSource, segments)) {
      const nestedKind = classifyDurableCommandInternal(body, depth + 1);
      if (nestedKind) return nestedKind;
    }
  }
  if (isPipeToShellInstall(executableSource)) return 'multi-step-install';
  return null;
}

/** Classify a full Bash command before its body is stripped from bulk data. */
export function classifyDurableCommand(
  command: string
): DurableCommandKind | null {
  return classifyDurableCommandInternal(command, 0);
}

/**
 * Character length of a tool_result `content` value, used as a cheap proxy for
 * the result's token cost. `content` is either a string or an array of content
 * blocks (e.g. `[{ type: 'text', text: '...' }]`); for arrays we sum the length
 * of each block's `text`/`content` (falling back to a JSON encoding for opaque
 * blocks). Returns 0 for null/empty content.
 *
 * Exported so parse-sessions can size the SAME tool_result payloads while
 * threading the `tool_use_id` linkage onto `TokenEntry` (#1928) — both parsers
 * then measure the result byte cost identically.
 */
export function resultContentSize(content: unknown): number {
  if (content == null) return 0;
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    let sum = 0;
    for (const block of content) {
      if (typeof block === 'string') {
        sum += block.length;
      } else if (block && typeof block === 'object') {
        const b = block as { text?: unknown; content?: unknown };
        if (typeof b.text === 'string') sum += b.text.length;
        else if (typeof b.content === 'string') sum += b.content.length;
        else sum += JSON.stringify(block).length;
      }
    }
    return sum;
  }
  if (typeof content === 'object') return JSON.stringify(content).length;
  return String(content).length;
}

/**
 * Reduce a raw tool_use `input` to the small set of sub-fields consumed
 * client-side (see DistilledToolInput). Only string values are kept, and large
 * free-text bodies (Write/Edit contents, MCP arg blobs, etc.) are dropped by
 * virtue of not being on the allowlist. The `command` string is kept in FULL
 * for the per-session session_blob row, while parseToolUsage also emits compact
 * command-derived fields on the ToolCall. assembleDataset() strips the raw
 * command from the bulk dataset after those fields are available.
 */
export function distillToolInput(input: unknown): DistilledToolInput {
  if (!input || typeof input !== 'object') return {};
  const src = input as Record<string, unknown>;
  const out: DistilledToolInput = {};
  if (typeof src.command === 'string') out.command = src.command;
  if (typeof src.file_path === 'string') out.file_path = src.file_path;
  if (typeof src.subagent_type === 'string') out.subagent_type = src.subagent_type;
  if (typeof src.skill === 'string') out.skill = src.skill;
  return out;
}

function deriveLeaveBehindStructure(
  toolName: unknown,
  rawInput: unknown
): Pick<ToolCall, 'leaveBehindStructure'> | Record<string, never> {
  if (toolName !== 'Write' || !rawInput || typeof rawInput !== 'object') {
    return {};
  }
  const source = rawInput as Record<string, unknown>;
  if (!leaveBehindStateScope(source.file_path)) return {};
  const result = validateLeaveBehindArtifact({
    required: true,
    path: source.file_path,
    content: source.content,
    trackedAtHead: null,
  });
  return result.status === 'candidate'
    ? { leaveBehindStructure: LEAVE_BEHIND_CONTRACT.version }
    : {};
}

export function parseToolUsage(text: string, fileName: string): ToolUsageData | null {
  const sessionId = fileName.replace(/\.jsonl$/, '');

  // Map of tool_use_id -> ToolCall
  const callsById = new Map<string, ToolCall>();
  // Pending tool_results for tool_use_ids we haven't seen yet:
  // tool_use_id -> { isError, resultBytes }
  const pendingResults = new Map<
    string,
    { isError: boolean; resultBytes: number }
  >();

  for (const entry of parseJsonl(text)) {
    if (!entry.message) continue;
    const msg = parseMessage(entry.message);
    if (!msg || !Array.isArray(msg.content)) continue;

    if (entry.type === 'assistant') {
      for (const block of msg.content) {
        if (block?.type !== 'tool_use') continue;
        const toolUseId = block.id ?? '';
        if (!toolUseId) continue;
        const pending = pendingResults.get(toolUseId);
        const input = distillToolInput(block.input);
        const call: ToolCall = {
          timestamp: entry.timestamp ?? '',
          toolName: block.name ?? 'unknown',
          input,
          toolUseId,
          isError: pending !== undefined ? pending.isError : null,
          resultBytes: pending !== undefined ? pending.resultBytes : 0,
          ...(block.name === 'Bash' && input.command
            ? deriveBashCommandSignals(input.command)
            : {}),
          ...deriveLeaveBehindStructure(block.name, block.input),
        };
        callsById.set(toolUseId, call);
        if (pending !== undefined) pendingResults.delete(toolUseId);
      }
    } else if (entry.type === 'user') {
      for (const block of msg.content) {
        if (block?.type !== 'tool_result') continue;
        const toolUseId = block.tool_use_id ?? '';
        if (!toolUseId) continue;
        const isError = block.is_error === true;
        const resultBytes = resultContentSize(block.content);
        const existing = callsById.get(toolUseId);
        if (existing) {
          existing.isError = isError;
          existing.resultBytes = resultBytes;
        } else {
          // result arrived before tool_use was processed (unusual but defensive)
          pendingResults.set(toolUseId, { isError, resultBytes });
        }
      }
    }
  }

  const calls = Array.from(callsById.values());
  if (calls.length === 0) return null;

  return { sessionId, calls };
}

export function stripToolCommandBodies(data: ToolUsageData): ToolUsageData {
  return {
    ...data,
    calls: data.calls.map((call) => {
      if (typeof call.input.command !== 'string') {
        return call;
      }
      const { command: _command, ...input } = call.input;
      void _command;
      return { ...call, input };
    }),
  };
}

export function aggregateTools(data: ToolUsageData[]): ToolAggregate[] {
  const map = new Map<string, { count: number; errorCount: number }>();

  for (const session of data) {
    for (const call of session.calls) {
      const entry = map.get(call.toolName) ?? { count: 0, errorCount: 0 };
      entry.count += 1;
      if (call.isError === true) entry.errorCount += 1;
      map.set(call.toolName, entry);
    }
  }

  return Array.from(map.entries())
    .map(([toolName, { count, errorCount }]) => ({
      toolName,
      count,
      errorCount,
      errorRate: count === 0 ? 0 : (errorCount / count) * 100,
    }))
    .sort((a, b) => b.count - a.count);
}

export function topBashCommands(
  data: ToolUsageData[],
  limit = 10
): BashCommandStat[] {
  const counts = new Map<string, { command: string; count: number }>();

  for (const session of data) {
    for (const call of session.calls) {
      if (call.toolName !== 'Bash') continue;
      const command = bashCommandPreview(call);
      if (command === null) continue;
      const key = call.commandFingerprint ?? command;
      const current = counts.get(key) ?? { command, count: 0 };
      current.count += 1;
      counts.set(key, current);
    }
  }

  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/**
 * Pull the `command` string out of a Bash ToolCall input, or null if the call
 * isn't a usable Bash invocation. Shared by the analyses below.
 */
function bashCommand(call: ToolCall): string | null {
  if (call.toolName !== 'Bash') return null;
  const input = call.input;
  if (!input || typeof input !== 'object') return null;
  const command = (input as { command?: unknown }).command;
  if (typeof command !== 'string' || command.length === 0) return null;
  return command;
}

function bashCommandPreview(call: ToolCall): string | null {
  const command = bashCommand(call);
  if (command !== null) return command;
  return typeof call.commandPreview === 'string' && call.commandPreview.length > 0
    ? call.commandPreview
    : null;
}

const BYPASS_CATEGORY_VALUES = new Set<BypassCategory>([
  'grep',
  'find',
  'cat',
  'sed',
  'awk',
  'cd',
]);

function isBypassCategory(value: unknown): value is BypassCategory {
  return (
    typeof value === 'string' &&
    BYPASS_CATEGORY_VALUES.has(value as BypassCategory)
  );
}

function bashBypassCategories(call: ToolCall): BypassCategory[] {
  if (call.toolName !== 'Bash') return [];
  if (Array.isArray(call.commandBypassCategories)) {
    // Persisted data can outlive this parser version. Ignore unknown future or
    // malformed categories instead of letting a downstream lookup throw.
    return call.commandBypassCategories.filter(isBypassCategory);
  }
  const command = bashCommand(call);
  if (command === null) return [];
  const trimmed = command.trim();
  return BYPASS_DEFS.filter((def) => def.test(trimmed)).map((def) => def.category);
}

// ---------------------------------------------------------------------------
// Native-tool-bypass detector
// ---------------------------------------------------------------------------

export interface BypassStat {
  category: BypassCategory;
  /** The native tool the user should reach for instead. */
  nativeTool: string;
  count: number;
  hint: string;
  /**
   * Distinct leading command forms proven to produce this category. `null`
   * means at least one contributing call could not be mapped safely (for
   * example a later command in a shell chain, old stripped data, or `cd`).
   */
  observedCommandHeads: string[] | null;
  /**
   * Distinct executable aliases observed for user-facing guidance. Unlike
   * `observedCommandHeads`, these need not start the raw permission prefix.
   */
  observedCommandAliases: string[];
}

export interface NativeToolBypass {
  categories: BypassStat[];
  /** Distinct contributing Bash calls; one call can match multiple categories. */
  distinctBypassCalls: number;
  /** Total category matches; one Bash call can contribute to multiple categories. */
  totalBypass: number;
  /** Newest dated contributing Bash call, normalized to ISO; null when undated. */
  latestTimestamp: string | null;
  /** Category matches backed by a strict RFC3339 timestamp. */
  datedBypassMatches: number;
  /** Category matches whose timestamp is absent or invalid. */
  undatedBypassMatches: number;
  /** grep: native Grep calls vs Bash `grep` invocations. */
  grepRatio: { native: number; bash: number };
  /** find: native Glob calls vs Bash `find` invocations. */
  findRatio: { native: number; bash: number };
}

const RFC3339_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):(\d{2}))$/;

/** Date.parse is permissive; require a real RFC3339 calendar instant. */
function rfc3339TimestampMs(timestamp: string): number | null {
  const match = RFC3339_TIMESTAMP.exec(timestamp);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10] === undefined ? 0 : Number(match[10]);
  const offsetMinute = match[11] === undefined ? 0 : Number(match[11]);
  if (
    month < 1 ||
    month > 12 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
    return null;
  }

  const calendar = new Date(0);
  calendar.setUTCHours(0, 0, 0, 0);
  calendar.setUTCFullYear(year, month - 1, day);
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day
  ) {
    return null;
  }

  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Does `cmd` invoke one of `words` as a command word that is NOT fed from a
 * pipe? (#72)
 *
 * The native tool only replaces a bypass when the shell tool reads its OWN
 * argument (a file path or a search root). When the tool sits on the right of a
 * pipe — `cmd | grep …`, `… | sed …`, `… | awk …` — it consumes another
 * command's stdout, which native Grep/Read/Edit cannot do, so it is NOT a
 * bypass. We therefore match the tool token only at a command-word boundary
 * (start of string, or after `;`/`&`/whitespace) whose effective preceding
 * operator is not `|`. Leading uses and `;`/`&&`-separated uses still count.
 */
function unpipedCommandWords(cmd: string, words: string[]): string[] {
  // All callers pass fixed, shell-command-safe words; keep the expression
  // identical to the long-standing matcher so alias capture cannot drift from
  // category classification.
  const re = new RegExp(`(${words.join('|')})(?=\\s|$)`, 'g');
  const matched = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    const start = m.index;
    // Must sit at a command-word boundary (mirrors the original anchors).
    const boundary = start === 0 || /[|&;\s]/.test(cmd[start - 1]);
    if (!boundary) continue;
    // Walk back over any whitespace to the effective preceding operator; if it
    // is a pipe, this token is stdin-fed and is not a native-tool bypass.
    let j = start - 1;
    while (j >= 0 && (cmd[j] === ' ' || cmd[j] === '\t')) j -= 1;
    if (j >= 0 && cmd[j] === '|') continue;
    matched.add(m[1]);
  }
  return [...matched];
}

function matchesUnpiped(cmd: string, words: string[]): boolean {
  return unpipedCommandWords(cmd, words).length > 0;
}

function leadingCommandWord(cmd: string, words: string[]): string[] {
  const re = new RegExp(`^(${words.join('|')})(?=\\s|$)`);
  const match = re.exec(cmd);
  return match ? [match[1]] : [];
}

const BYPASS_DEFS: Array<{
  category: BypassCategory;
  nativeTool: string;
  /** Matches the command string (whole string, post-trim). */
  test: (cmd: string) => boolean;
  /** Exact executable aliases responsible for this category match. */
  observedAliases: (cmd: string) => string[];
  hint: string;
}> = [
  {
    category: 'grep',
    nativeTool: 'Grep',
    // a `grep`/`rg`/`egrep` invocation as a command word, but NOT when piped
    // stdin (`… | grep`) — native Grep can't read another command's output.
    test: (c) => matchesUnpiped(c, ['grep', 'egrep', 'fgrep', 'rg']),
    observedAliases: (c) =>
      unpipedCommandWords(c, ['grep', 'egrep', 'fgrep', 'rg']),
    hint: 'Prefer native Grep over Bash grep — faster, integrates with permissions.',
  },
  {
    category: 'find',
    nativeTool: 'Glob',
    // find walks a path it is given, so a piped `find` is unusual; still treat
    // a stdin-fed `find` as non-bypass for consistency. Keeps -exec/xargs uses.
    test: (c) => matchesUnpiped(c, ['find']),
    observedAliases: (c) => unpipedCommandWords(c, ['find']),
    hint: 'Prefer native Glob over Bash find — pattern matching without a shell.',
  },
  {
    category: 'cat',
    nativeTool: 'Read',
    // leading cat/head/tail used to view a file
    test: (c) => /^(cat|head|tail)\s/.test(c),
    observedAliases: (c) => leadingCommandWord(c, ['cat', 'head', 'tail']),
    hint: 'Prefer native Read over cat/head/tail — paginates and tracks file state.',
  },
  {
    category: 'sed',
    nativeTool: 'Read/Edit',
    // not a bypass when fed by a pipe (`… | sed`) — Read/Edit edit files, not
    // another command's stdout.
    test: (c) => matchesUnpiped(c, ['sed']),
    observedAliases: (c) => unpipedCommandWords(c, ['sed']),
    hint: 'Prefer native Read/Edit over sed — explicit edits with permission checks.',
  },
  {
    category: 'awk',
    nativeTool: 'Read/Edit',
    // not a bypass when fed by a pipe (`… | awk`).
    test: (c) => matchesUnpiped(c, ['awk']),
    observedAliases: (c) => unpipedCommandWords(c, ['awk']),
    hint: 'Prefer native Read/Edit over awk for reading/transforming files.',
  },
  {
    category: 'cd',
    nativeTool: 'absolute paths',
    // A STANDALONE leading `cd` is wasted — cwd resets between Bash calls, so a
    // lone `cd /tmp` has no effect on the next call. But a `cd <dir> && <cmd>`
    // (or `;`/`|`-chained) form anchors the following command within the SAME
    // invocation — that is the MANDATED cwd-anchor idiom (AGENTS.md "Worktrees &
    // Branches" + the cwd-anchor-guard PreToolUse hook), NOT waste. Counting the
    // chained form mislabels the required anchor as a bypass (#2014), so flag a
    // leading `cd` only when no chain operator (`&&`/`||`/`;`/`|`/`&`) follows.
    test: (c) => /^cd\s/.test(c) && !/[;&|]/.test(c),
    observedAliases: () => [],
    hint: 'A standalone leading cd is wasted — cwd resets between Bash calls; use absolute paths. (A chained `cd <dir> && <cmd>` anchor is fine.)',
  },
];

const BYPASS_COMMAND_HEADS: Readonly<
  Record<BypassCategory, readonly string[]>
> = {
  grep: ['grep', 'egrep', 'fgrep', 'rg'],
  find: ['find'],
  cat: ['cat', 'head', 'tail'],
  sed: ['sed'],
  awk: ['awk'],
  // A standalone cd is intentionally guidance-only. There is no blanket
  // permission rule that safely represents the path-handling correction.
  cd: [],
};

function commandAliasesForBypass(
  call: ToolCall,
  category: BypassCategory,
  command: string | null
): string[] {
  if (command !== null) {
    const def = BYPASS_DEFS.find((candidate) => candidate.category === category);
    return def?.observedAliases(command.trim()) ?? [];
  }

  const persisted = call.commandBypassAliases as unknown;
  if (persisted && typeof persisted === 'object' && !Array.isArray(persisted)) {
    const candidates = (persisted as Record<string, unknown>)[category];
    if (Array.isArray(candidates)) {
      const aliases = candidates.filter(
        (candidate): candidate is string =>
          typeof candidate === 'string' &&
          BYPASS_COMMAND_HEADS[category].includes(candidate)
      );
      if (aliases.length > 0) return [...new Set(aliases)];
    }
  }

  // Pre-v12 stripped rows have no per-category alias map. Their full-command
  // `commandHead` remains trustworthy only when it is itself a canonical alias;
  // wrapped/chained heads stay unknown rather than inventing a category default.
  return call.commandHead &&
    BYPASS_COMMAND_HEADS[category].includes(call.commandHead)
    ? [call.commandHead]
    : [];
}

function commandPreview(command: string): string {
  const flat = command.replace(/\r?\n/g, ' ');
  return flat.length > MAX_COMMAND_PREVIEW_LEN
    ? flat.slice(0, MAX_COMMAND_PREVIEW_LEN)
    : flat;
}

function commandHead(command: string): string | undefined {
  const tokens = command.trim().split(/\s+/);
  let token = tokens[0] ?? '';
  let i = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) && i < tokens.length - 1) {
    i += 1;
    token = tokens[i];
  }
  return token || undefined;
}

function commandHeadIsPermissionPrefix(command: string, head: string): boolean {
  const trimmed = command.trim();
  return trimmed === head || trimmed.startsWith(`${head} `);
}

const WORKFLOW_GIT_SEGMENT_RE =
  /\bgit\s+(?:stash\b|switch\b|checkout\b|reflog\b|cherry-pick\b|merge\s+--ff-only\b)/;

function compactGitSegment(part: string): string {
  if (part.length <= MAX_COMMAND_PREVIEW_LEN) return part;
  const matchIndex = part.search(WORKFLOW_GIT_SEGMENT_RE);
  if (matchIndex < 0) return part.slice(0, MAX_COMMAND_PREVIEW_LEN);
  const start = Math.max(0, matchIndex - 80);
  return part.slice(start, start + MAX_COMMAND_PREVIEW_LEN);
}

function commandGitSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/)
    .map((part) => part.trim())
    .filter((part) => WORKFLOW_GIT_SEGMENT_RE.test(part))
    .map(compactGitSegment)
    .slice(0, MAX_COMMAND_GIT_SEGMENTS);
}

// Kept in sync with parse-permissions.ts so the bulk toolData payload can drop
// raw command bodies while dangerous-command consumers keep their exact signal.
function hasDangerousRmRfFlags(cmd: string): boolean {
  const m = cmd.match(/\brm\s+-([a-zA-Z]+)\b/);
  if (!m) return false;
  const flags = m[1];
  if (!/^[rRfviIdP]+$/.test(flags)) return false;
  return /[rR]/.test(flags) && flags.includes('f');
}

const COMMAND_DANGEROUS_PATTERNS: Array<{
  name: string;
  test: (cmd: string) => boolean;
}> = [
  { name: 'rm -rf', test: hasDangerousRmRfFlags },
  { name: 'git reset --hard', test: (c) => /\bgit\s+reset\s+--hard/i.test(c) },
  {
    name: 'git push --force',
    // The `(?![\w-])` rejects the SAFE variants `--force-with-lease` /
    // `--force-if-includes` while still matching bare `--force` / `-f` (#2042).
    // Keep in sync with parse-permissions.ts DANGEROUS_PATTERNS.
    test: (c) => /\bgit\s+push\s+(-f|--force)(?![\w-])/i.test(c),
  },
  { name: 'chmod 777', test: (c) => /\bchmod\s+(-R\s+)?[0-7]*777\b/i.test(c) },
  { name: 'dd if=', test: (c) => /\bdd\s+if=/i.test(c) },
  {
    name: 'fork bomb',
    test: (c) => /:\(\)\s*\{\s*:\s*\|\s*:&\s*\}\s*;:/.test(c),
  },
  { name: 'mkfs', test: (c) => /\bmkfs\.\w+|\bmkfs\b/i.test(c) },
  { name: 'disk overwrite', test: (c) => />\s*\/dev\/sd[a-z]/i.test(c) },
  {
    name: 'curl pipe shell',
    test: (c) => /\b(curl|wget)\b[^|]*\|\s*(sh|bash|zsh)\b/i.test(c),
  },
  { name: 'npm publish', test: (c) => /\bnpm\s+publish\b/.test(c) },
];

export function deriveBashCommandSignals(command: string): Partial<ToolCall> {
  const trimmed = command.trim();
  const bypassMatches = BYPASS_DEFS.filter((def) => def.test(trimmed));
  const bypassCategories = bypassMatches.map((def) => def.category);
  const bypassAliases: Partial<Record<BypassCategory, string[]>> = {};
  for (const def of bypassMatches) {
    const aliases = def.observedAliases(trimmed);
    if (aliases.length > 0) bypassAliases[def.category] = aliases;
  }
  // Match dangerous patterns against the executable skeleton (#2039): `rm -rf`
  // (and peers) inside heredoc bodies, quoted literals, or inline-script source
  // (`node -e "…"`) are not executed deletions and must not be flagged.
  const dangerousSkeleton = executableShellSkeleton(command);
  const dangerous = COMMAND_DANGEROUS_PATTERNS.find((pattern) =>
    pattern.test(dangerousSkeleton)
  );
  const riskyAction = detectRiskyActionPatternName(command);
  const durableKind = classifyDurableCommand(command);
  const head = commandHead(command);
  const gitSegments = commandGitSegments(command);
  return {
    commandFingerprint: bashCommandFingerprint(command),
    commandPreview: commandPreview(command),
    ...(durableKind ? { commandDurableKind: durableKind } : {}),
    ...(head ? { commandHead: head } : {}),
    ...(head && commandHeadIsPermissionPrefix(command, head)
      ? { commandHeadIsPermissionPrefix: true }
      : {}),
    ...(gitSegments.length > 0 ? { commandGitSegments: gitSegments } : {}),
    ...(bypassCategories.length > 0
      ? { commandBypassCategories: bypassCategories }
      : {}),
    ...(Object.keys(bypassAliases).length > 0
      ? { commandBypassAliases: bypassAliases }
      : {}),
    ...(dangerous
      ? {
          commandDangerousPattern: dangerous.name,
          commandDangerousRuleMatches: matchingDangerousPermissionRules(
            dangerous.name,
            command
          ),
          // Precompute certainty + fragment from the FULL command now, before the
          // raw body is stripped from the bulk payload (#2036). rm -rf certainty
          // is target-aware; others are static. Without this, downstream sees only
          // the 200-char preview and re-inflates buried scoped deletes to 'high'.
          commandDangerousCertainty:
            dangerous.name === 'rm -rf'
              ? rmRfCertainty(command)
              : dangerousPatternCertainty(dangerous.name),
          commandDangerousFragment: dangerousFragment(command, dangerous.name),
        }
      : {}),
    ...(riskyAction ? { commandRiskyActionPattern: riskyAction } : {}),
    ...(command.includes('.claude') ? { commandMentionsClaudePath: true } : {}),
  };
}

/**
 * Classify every Bash command against the bypass categories above. A single
 * command can count toward multiple categories (e.g. `find … -name … && grep …`).
 * Pipe-fed tool invocations (`cmd | grep …`) are NOT counted — see
 * {@link matchesUnpiped} (#72) — because no native tool replaces a stdin filter.
 * Returns per-category counts plus the native-vs-Bash ratio for grep & find.
 */
export function nativeToolBypass(data: ToolUsageData[]): NativeToolBypass {
  const counts = new Map<BypassCategory, number>();
  const observedCommandHeads = new Map<BypassCategory, Set<string>>();
  const observedCommandAliases = new Map<BypassCategory, Set<string>>();
  const unmappableCommandCategories = new Set<BypassCategory>();
  let nativeGrep = 0;
  let nativeGlob = 0;
  let distinctBypassCalls = 0;
  let latestBypassMs = Number.NEGATIVE_INFINITY;
  let datedBypassMatches = 0;
  let undatedBypassMatches = 0;

  for (const session of data) {
    for (const call of session.calls) {
      if (call.toolName === 'Grep') {
        nativeGrep += 1;
        continue;
      }
      if (call.toolName === 'Glob') {
        nativeGlob += 1;
        continue;
      }
      const categories = bashBypassCategories(call);
      if (categories.length > 0) {
        distinctBypassCalls += 1;
        const timestampMs = rfc3339TimestampMs(call.timestamp);
        if (timestampMs !== null) {
          latestBypassMs = Math.max(latestBypassMs, timestampMs);
          datedBypassMatches += categories.length;
        } else {
          undatedBypassMatches += categories.length;
        }
      }
      for (const category of categories) {
        counts.set(category, (counts.get(category) ?? 0) + 1);
        const command = bashCommand(call);
        const head =
          call.commandHead ??
          (command === null ? undefined : commandHead(command));
        const hasPermissionPrefix =
          head !== undefined &&
          (command !== null
            ? commandHeadIsPermissionPrefix(command, head)
            : call.commandHeadIsPermissionPrefix === true);
        for (const alias of commandAliasesForBypass(call, category, command)) {
          const aliases =
            observedCommandAliases.get(category) ?? new Set<string>();
          aliases.add(alias);
          observedCommandAliases.set(category, aliases);
        }
        if (
          head &&
          hasPermissionPrefix &&
          BYPASS_COMMAND_HEADS[category].includes(head)
        ) {
          const heads =
            observedCommandHeads.get(category) ?? new Set<string>();
          heads.add(head);
          observedCommandHeads.set(category, heads);
        } else {
          // Category aggregation collapses aliases (grep/rg, cat/head/tail).
          // A policy proves adoption only when it covers the actual observed
          // leading command form; ambiguity keeps the recommendation visible.
          unmappableCommandCategories.add(category);
        }
      }
    }
  }

  const categories = BYPASS_DEFS.filter((d) => (counts.get(d.category) ?? 0) > 0)
    .map((d) => ({
      category: d.category,
      nativeTool: d.nativeTool,
      count: counts.get(d.category) ?? 0,
      hint: d.hint,
      observedCommandHeads: unmappableCommandCategories.has(d.category)
        ? null
        : [...(observedCommandHeads.get(d.category) ?? [])].sort(),
      observedCommandAliases: [
        ...(observedCommandAliases.get(d.category) ?? []),
      ].sort(),
    }))
    .sort((a, b) => b.count - a.count);

  const totalBypass = categories.reduce((sum, c) => sum + c.count, 0);

  return {
    categories,
    distinctBypassCalls,
    totalBypass,
    latestTimestamp: Number.isFinite(latestBypassMs)
      ? new Date(latestBypassMs).toISOString()
      : null,
    datedBypassMatches,
    undatedBypassMatches,
    grepRatio: { native: nativeGrep, bash: counts.get('grep') ?? 0 },
    findRatio: { native: nativeGlob, bash: counts.get('find') ?? 0 },
  };
}

/** Per-session count + result-byte sum of native-tool-bypass Bash commands. */
export interface NativeBypassScope {
  sessionId: string;
  /** Bypass Bash commands in this session (a command can match >1 category once). */
  count: number;
  /** Bypass calls with a positive result payload, counted once per call. */
  resultBearingCalls: number;
  /**
   * Sum of `tool_result` `resultBytes` over those bypass commands — evidence for
   * the detector's causal reclaim hypothesis. A char-count proxy (no per-call
   * token count is on the wire); 0 when no bypass command carried a result payload.
   */
  resultBytes: number;
}

/**
 * Per-session breakdown of native-tool-bypass commands and the result bytes they
 * returned, for the workflow byte-lever reclaim claim (#951). Counts a command
 * once even if it matches several bypass categories (unlike `totalBypass`, which
 * counts category matches), and sums that call's `resultBytes` once. The detector
 * uses that byte total as a counterfactual proxy, not a measured native-tool
 * intervention effect. Sessions with no bypass command are omitted.
 */
export function nativeBypassByScope(data: ToolUsageData[]): NativeBypassScope[] {
  const out: NativeBypassScope[] = [];
  for (const session of data) {
    let count = 0;
    let resultBearingCalls = 0;
    let resultBytes = 0;
    for (const call of session.calls) {
      // A single command can satisfy multiple BYPASS_DEFS; count it once.
      if (bashBypassCategories(call).length === 0) continue;
      count += 1;
      if (call.resultBytes > 0) {
        resultBearingCalls += 1;
        resultBytes += call.resultBytes;
      }
    }
    if (count > 0) {
      out.push({ sessionId: session.sessionId, count, resultBearingCalls, resultBytes });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tool-call right-sizing (#1924)
// ---------------------------------------------------------------------------
// Two faces of the same waste: a tool call that pulls FAR more into context than
// the task needed, then gets cache-read on every later turn (the steady-state
// tax that `context.compaction-large-tool-outputs` misses because it never forces
// a compaction). Face 1 — a fat FIRST-call over-fetch (whole-file Read where an
// offset/limit/Grep slice would do). Face 2 — chronically verbose USED tools
// (MCP + Bash) whose return payloads are bloated call after call.
//
// DEDUP (acceptance #1924): Bash commands that re-implement a native tool are
// native-bypass's territory (#951, workflow-rework band) — they are excluded here
// so the same bytes are not double-claimed. The reclaim claim books against the
// `cacheRead` pool under the `structural-prefix` cause, which the cascade runs
// AFTER native-bypass's `input`-pool workflow lever, so overlapping tokens carve
// disjoint slices by construction (see reclaim.ts).

/** Chars-per-token proxy (matches native-bypass / parse-file-reread). */
const RIGHTSIZE_CHARS_PER_TOKEN = 4;
/** A single Read whose result payload is at least this large is an over-fetch candidate. */
export const FAT_READ_BYTES = 25_000;
/** Baseline payload a targeted read (offset/limit/Grep) would have returned instead. */
export const TARGET_READ_BYTES = 4_000;
/** A used tool whose MEAN result payload is at least this large is chronically verbose. */
export const VERBOSE_AVG_BYTES = 10_000;
/** Baseline payload a leaner/paginated call to the same tool would return. */
export const TARGET_TOOL_BYTES = 2_000;
/** Minimum calls before a tool's mean payload is trustworthy as "chronic". */
export const MIN_VERBOSE_CALLS = 3;
/**
 * Cap on the cache-read tail multiplier, so one fat call in a very long session
 * can't claim an absurd tail. The cascade's `residual ≥ 0` guard caps the dollars
 * regardless; this just keeps `evidenceTokens` sane.
 */
const MAX_REMAINING_TURNS = 40;

/** One tool's payload footprint across the corpus (used tools only). */
export interface ToolPayloadRanking {
  toolName: string;
  calls: number;
  totalResultBytes: number;
  /** Mean result payload bytes per call (rounded). */
  avgResultBytes: number;
}

/** Per-session compounded excess, the unit the reclaim claim books. */
export interface ToolRightSizingScope {
  sessionId: string;
  /** Compounded excess cache-read tokens (excess payload tokens × remaining turns). */
  excessCacheReadTokens: number;
  /** Over-fetch + verbose calls counted in this session. */
  affectedCalls: number;
}

export interface ToolPayloadRightSizing {
  /** Per-tool payload ranking across USED tools (excl. native-bypass Bash), desc by mean payload. */
  ranking: ToolPayloadRanking[];
  /** Per-session compounded excess + counts, for the reclaim claim. */
  byScope: ToolRightSizingScope[];
  /** Total over-fetch + verbose calls across all sessions. */
  totalAffected: number;
  /** Total compounded excess cache-read tokens. */
  totalExcessTokens: number;
  /** Verbose used-tool offenders (mean payload ≥ threshold over enough MCP/Bash calls). */
  verboseTools: ToolPayloadRanking[];
  /** Total over-fetch Read calls across all sessions (full count, not capped). */
  overFetchCount: number;
  /** Largest single over-fetch reads, for evidence rows (desc, capped). */
  topOverFetch: { sessionId: string; resultBytes: number }[];
}

/** Whether a call belongs to native-bypass (#951) and so is excluded here. */
function isNativeBypassCall(call: ToolCall): boolean {
  return call.toolName === 'Bash' && bashBypassCategories(call).length > 0;
}

/**
 * Rank used tools by payload-bytes-per-call and dollarize the cache-compounded
 * tail of over-fetch reads + chronically verbose MCP/Bash returns. See the
 * section header for the two faces and the native-bypass dedup. Pure over the
 * distilled `toolData` (reads only `toolName`/`resultBytes`), so it runs on the
 * free/local path per ADR 0005.
 */
export function toolPayloadRightSizing(data: ToolUsageData[]): ToolPayloadRightSizing {
  // Pass 1 — global per-tool payload aggregate (excluding native-bypass Bash).
  const agg = new Map<string, { calls: number; totalResultBytes: number }>();
  for (const session of data) {
    for (const call of session.calls) {
      if (isNativeBypassCall(call)) continue;
      const e = agg.get(call.toolName) ?? { calls: 0, totalResultBytes: 0 };
      e.calls += 1;
      e.totalResultBytes += Math.max(0, call.resultBytes);
      agg.set(call.toolName, e);
    }
  }
  const ranking: ToolPayloadRanking[] = Array.from(agg.entries())
    .map(([toolName, { calls, totalResultBytes }]) => ({
      toolName,
      calls,
      totalResultBytes,
      avgResultBytes: calls === 0 ? 0 : Math.round(totalResultBytes / calls),
    }))
    .filter((r) => r.totalResultBytes > 0)
    .sort((a, b) => b.avgResultBytes - a.avgResultBytes);

  // Face 2 scope: chronically verbose MCP + Bash tools.
  const verboseTools = ranking.filter(
    (r) =>
      r.avgResultBytes >= VERBOSE_AVG_BYTES &&
      r.calls >= MIN_VERBOSE_CALLS &&
      (r.toolName.startsWith('mcp__') || r.toolName === 'Bash')
  );
  const verboseSet = new Set(verboseTools.map((t) => t.toolName));

  // Pass 2 — per-session compounded excess.
  const byScope: ToolRightSizingScope[] = [];
  const topOverFetch: { sessionId: string; resultBytes: number }[] = [];
  let totalAffected = 0;
  let totalExcessTokens = 0;
  let overFetchCount = 0;
  for (const session of data) {
    const n = session.calls.length;
    let excessCacheReadTokens = 0;
    let affectedCalls = 0;
    for (let i = 0; i < n; i++) {
      const call = session.calls[i];
      if (isNativeBypassCall(call)) continue;
      const bytes = Math.max(0, call.resultBytes);
      let excessBytes = 0;
      if (call.toolName === 'Read' && bytes >= FAT_READ_BYTES) {
        // Face 1 — first-call over-fetch (whole-file Read).
        excessBytes = bytes - TARGET_READ_BYTES;
        topOverFetch.push({ sessionId: session.sessionId, resultBytes: bytes });
        overFetchCount += 1;
      } else if (verboseSet.has(call.toolName) && bytes > TARGET_TOOL_BYTES) {
        // Face 2 — chronically verbose used tool (MCP/Bash). Read is handled by
        // Face 1 above, so a call is never counted by both faces.
        excessBytes = bytes - TARGET_TOOL_BYTES;
      }
      if (excessBytes <= 0) continue;
      // Cache-compounded tail: the payload is cache-read on every later turn it
      // sits in context. `remaining turns` is proxied by the calls after this one,
      // so a fat call that is the last in its session books a 0 tail (it was
      // never re-read) while still counting as an over-fetch occurrence.
      const remainingTurns = Math.min(MAX_REMAINING_TURNS, n - 1 - i);
      excessCacheReadTokens +=
        (excessBytes / RIGHTSIZE_CHARS_PER_TOKEN) * remainingTurns;
      affectedCalls += 1;
    }
    if (affectedCalls > 0) {
      byScope.push({
        sessionId: session.sessionId,
        excessCacheReadTokens,
        affectedCalls,
      });
      totalAffected += affectedCalls;
      totalExcessTokens += excessCacheReadTokens;
    }
  }
  topOverFetch.sort((a, b) => b.resultBytes - a.resultBytes);

  return {
    ranking,
    byScope,
    totalAffected,
    totalExcessTokens,
    verboseTools,
    overFetchCount,
    topOverFetch: topOverFetch.slice(0, 5),
  };
}

// ---------------------------------------------------------------------------
// Bash subcommand breakdown
// ---------------------------------------------------------------------------

export interface BashSubcommandStat {
  /** First token of the command (ls, git, cd, grep, make, npx, …). */
  token: string;
  count: number;
}

/**
 * Group Bash invocations by their first token, so `git status` and `git log`
 * both roll up under `git`. Sorted descending by count.
 */
export function bashSubcommandStats(
  data: ToolUsageData[],
  limit = 15
): BashSubcommandStat[] {
  const counts = new Map<string, number>();

  for (const session of data) {
    for (const call of session.calls) {
      const cmd = bashCommand(call);
      // First whitespace-delimited token of the trimmed command. Strip a
      // leading env-var assignment prefix (FOO=bar cmd) if present.
      let token = call.commandHead;
      if (!token && cmd !== null) token = commandHead(cmd);
      if (!token) continue;
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([token, count]) => ({ token, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Repeated commands
// ---------------------------------------------------------------------------

export interface RepeatedCommandStat {
  command: string;
  /** Number of distinct sessions in which the command repeated ≥3×. */
  sessions: number;
  /** Total times the command ran across those sessions. */
  totalCount: number;
  /** Highest per-session repeat count. */
  maxPerSession: number;
}

/**
 * Identical Bash command strings run ≥3× within a single session — candidates
 * for a hook, skill, or Makefile target. Counts are scoped per session, then
 * aggregated so a command repeated in several sessions surfaces once.
 */
export function repeatedCommands(
  data: ToolUsageData[],
  minPerSession = 3,
  limit = 15
): RepeatedCommandStat[] {
  const agg = new Map<
    string,
    { sessions: number; totalCount: number; maxPerSession: number }
  >();

  for (const session of data) {
    const perSession = new Map<string, { command: string; count: number }>();
    for (const call of session.calls) {
      const cmd = bashCommandPreview(call);
      if (cmd === null) continue;
      const key = call.commandFingerprint ?? cmd;
      const current = perSession.get(key) ?? { command: cmd, count: 0 };
      current.count += 1;
      perSession.set(key, current);
    }
    for (const { command, count } of perSession.values()) {
      if (count < minPerSession) continue;
      const entry = agg.get(command) ?? {
        sessions: 0,
        totalCount: 0,
        maxPerSession: 0,
      };
      entry.sessions += 1;
      entry.totalCount += count;
      entry.maxPerSession = Math.max(entry.maxPerSession, count);
      agg.set(command, entry);
    }
  }

  return Array.from(agg.entries())
    .map(([command, v]) => ({ command, ...v }))
    .sort((a, b) => b.totalCount - a.totalCount)
    .slice(0, limit);
}

// ── Correction mining (#1040, epic #866) ───────────────────────────────────
// Mine failed→fixed tool pairs: a tool call that errored, followed within a
// small window by a SAME-tool call that succeeded at the same intent, with the
// argument diffed to the corrective fact (wrong path → right path). The
// deterministic counterpart to headroom's `learn`.
//
// SCOPE / PRECISION (deliberately narrow — this feeds a recommendation surface,
// so a false "correction" is worse than a missed one, per epic #866):
//  - Only the FILE-PATH category ships. The command-variant category (e.g.
//    `python3 foo.py` → `uv run python foo.py`) is DEFERRED: a "same target
//    token" gate can't tell a runner swap from a different operation on the same
//    file (`cat foo` → `rm foo`), which would emit a misleading fix.
//  - search-scope / large-file categories need `pattern`/`offset`/`limit`, which
//    `distillToolInput` drops on the wire — also out of scope until distilled.

export type CorrectionCategory = 'file-path';

export interface CorrectionFact {
  category: CorrectionCategory;
  toolName: string;
  /** The argument value on the failed call. */
  failed: string;
  /** The argument value on the subsequent successful call. */
  succeeded: string;
  /** Timestamp of the successful (fix) call — lets time-window joins locate the
   *  correction within a session (consumed by human-input-leverage). */
  succeededTimestamp: string;
  sessionId: string;
}

/** File tools whose `file_path` correction means "same file, wrong location". */
const CORRECTION_FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit', 'MultiEdit']);
/** How many later calls to scan for the fix after a failed call. */
const CORRECTION_WINDOW = 6;
/** Minimum stem length — below this, stem collisions are too likely. */
const MIN_STEM_LEN = 3;
/**
 * Stems too generic to be a reliable "same file" key: the same basename stem
 * recurs across unrelated files (a per-package `index.ts`, a `main`, a `mod`),
 * so matching on them would pair distinct files into a false correction.
 */
const GENERIC_STEMS = new Set([
  'index', 'main', 'mod', 'app', 'lib', 'types', 'type', 'config', 'conf',
  'init', '__init__', 'test', 'tests', 'spec', 'utils', 'util', 'helpers',
  'helper', 'readme', 'makefile', 'dockerfile', 'setup', 'package', 'mode',
]);

/** Filename without directory. */
function pathBasename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}
/** Filename without directory OR extension — the "stem" (FirstClassEntity). */
function pathStem(p: string): string {
  const base = pathBasename(p);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}
/**
 * Whether a stem is distinctive enough to key a "same file" correction: starts
 * with an alphanumeric (excludes dotfiles like `.gitignore`/`.env`), is at least
 * MIN_STEM_LEN long, and is not a generic, collision-prone name.
 */
function isDistinctiveStem(stem: string): boolean {
  return (
    stem.length >= MIN_STEM_LEN &&
    /^[a-z0-9]/i.test(stem) &&
    !GENERIC_STEMS.has(stem.toLowerCase())
  );
}

/**
 * Extract file-path corrective facts from failed→fixed tool sequences within
 * each session.
 *
 * For each errored file-tool call (`isError === true`) with a `file_path`, scan
 * the next `window` calls for the FIRST same-tool success (`isError === false`)
 * whose path differs but shares a DISTINCTIVE stem — same file, different
 * dir/extension, e.g. `…/FirstClassEntity.java` → `…/FirstClassEntity.scala`.
 * Generic stems (`index`, `main`, …) and dotfiles are excluded so distinct files
 * that merely share a basename are never paired into a false correction.
 *
 * Deterministic and transcript-free (reads only the distilled `toolData`), so it
 * runs on the free/local path per ADR 0005.
 */
export function mineCorrections(
  data: ToolUsageData[],
  window = CORRECTION_WINDOW
): CorrectionFact[] {
  const facts: CorrectionFact[] = [];
  for (const session of data) {
    const calls = session.calls;
    for (let i = 0; i < calls.length; i++) {
      const failed = calls[i];
      if (failed.isError !== true) continue;
      if (!CORRECTION_FILE_TOOLS.has(failed.toolName)) continue;
      const failedArg = failed.input.file_path;
      if (!failedArg) continue;
      const stem = pathStem(failedArg);
      if (!isDistinctiveStem(stem)) continue;

      for (let j = i + 1; j < calls.length && j <= i + window; j++) {
        const fix = calls[j];
        if (fix.toolName !== failed.toolName || fix.isError !== false) continue;
        const okArg = fix.input.file_path;
        if (!okArg || okArg === failedArg) continue;
        if (pathStem(okArg) !== stem) continue;

        facts.push({
          category: 'file-path',
          toolName: failed.toolName,
          failed: failedArg,
          succeeded: okArg,
          succeededTimestamp: fix.timestamp,
          sessionId: session.sessionId,
        });
        break; // one correction per failed call
      }
    }
  }
  return facts;
}

export interface AggregatedCorrection extends CorrectionFact {
  /** Number of mined facts with this exact failed→succeeded correction. */
  occurrences: number;
}

/**
 * Group identical `failed → succeeded` corrections and rank by occurrence count
 * (a fact the agent re-guesses repeatedly ranks higher). The `sessionId`
 * retained is the first one seen, for an evidence link.
 */
export function aggregateCorrections(facts: CorrectionFact[]): AggregatedCorrection[] {
  const agg = new Map<string, AggregatedCorrection>();
  for (const f of facts) {
    const key = `${f.category}\0${f.failed}\0${f.succeeded}`;
    const prev = agg.get(key);
    if (prev) prev.occurrences += 1;
    else agg.set(key, { ...f, occurrences: 1 });
  }
  return Array.from(agg.values()).sort((a, b) => b.occurrences - a.occurrences);
}
