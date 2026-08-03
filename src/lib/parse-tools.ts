import { parseIsoInstantMs } from './iso-instant';
import { parseJsonl, parseMessage } from './parse-utils';
import { bashCommandFingerprint } from './bash-command-fingerprint';
import { shellQuoteMinimal } from './shell-quote';
import {
  detectRiskyActionPatternName,
  rmRfCertainty,
  dangerousFragment,
  dangerousPatternCertainty,
  decodeProtectedShellRedirects,
  executableShellListSegments,
  executableShellSkeleton,
  matchingDangerousPermissionRules,
  rawExecutableShellTokens,
  executableShellSegmentsWithSyntaxProvenance as executableShellSegments,
  executableShellSource,
  shellHeredocIdentityDelimiter,
  shellHeredocs,
} from './parse-permissions';
import {
  LEAVE_BEHIND_CONTRACT,
  MAX_PERSISTED_LEAVE_BEHIND_MUTATION_PATHS,
  definiteShellWritePaths,
  hasUnprovenShellExpansion,
  leaveBehindMutationPathsFromExecutableShell,
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
  EditFormatChurn,
  ToolCall,
  ToolUsageData,
} from './parse-tools-types';
export type {
  DistilledToolInput,
  BypassCategory,
  DangerousCommandCertainty,
  DurableCommandKind,
  EditFormatChurn,
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
// Shell parsing is intentionally bounded. Transcript tool input can be tens of
// MiB, while every persisted signal below is only a best-effort static proof.
// Above this limit we store an explicit analysis barrier instead of spending
// seconds (or letting downstream raw fallbacks repeat the work). Sparse command
// classifiers fail closed; final-state consumers treat a successful truncated
// call as mutation-path uncertainty rather than as an analyzed negative.
const MAX_STATIC_SHELL_COMMAND_LENGTH = 64 * 1024;
const MAX_STATIC_SHELL_TRANSCRIPT_CHARS = 128 * 1024;
const MAX_STATIC_SHELL_CALLS_PER_TRANSCRIPT = 1024;
const MAX_STATIC_SHELL_SYNTAX_CHARS = 4096;
const MAX_STATIC_SHELL_TRANSCRIPT_SYNTAX_CHARS = 8192;

const STATIC_SHELL_SYNTAX_CHARS = new Set("'\"`\\;&|<>()\r\n{}[]");

function shellSyntaxCharCount(command: string, stopAfter: number): number {
  let syntaxChars = 0;
  for (let index = 0; index < command.length; index += 1) {
    if (STATIC_SHELL_SYNTAX_CHARS.has(command[index])) {
      syntaxChars += 1;
      if (syntaxChars > stopAfter) return syntaxChars;
    }
  }
  return syntaxChars;
}

function boundedShellAnalysisBarrier(command: string): Partial<ToolCall> {
  return {
    commandAnalysisComplete: true,
    commandAnalysisTruncated: true,
    commandFingerprint: bashCommandFingerprint(command),
    commandPreview: commandPreview(
      command.slice(0, MAX_STATIC_SHELL_COMMAND_LENGTH)
    ),
    ...(command.includes('.claude')
      ? { commandMentionsClaudePath: true }
      : {}),
  };
}

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
  '--as-uid',
  '--cache-dir',
  '--certificate-authority',
  '--client-certificate',
  '--client-key',
  '--cluster',
  '--context',
  '--kubeconfig',
  '--kuberc',
  '--log-flush-frequency',
  '--loglevel',
  '--namespace',
  '-n',
  '--password',
  '--profile',
  '--profile-output',
  '--request-timeout',
  '--server',
  '-s',
  '--tls-server-name',
  '--token',
  '--user',
  '--username',
  '--v',
  '-v',
  '--vmodule',
]);
const HELM_OPTIONS_WITH_ARGUMENT = new Set([
  '--burst-limit',
  '--color',
  '--colour',
  '--content-cache',
  '--kube-apiserver',
  '--kube-as-group',
  '--kube-as-user',
  '--kube-ca-file',
  '--kube-context',
  '--kube-tls-server-name',
  '--kube-token',
  '--kubeconfig',
  '--namespace',
  '-n',
  '--qps',
  '--registry-config',
  '--repository-cache',
  '--repository-config',
]);
const CONTAINER_OPTIONS_WITH_ARGUMENT = new Set([
  '--config',
  '--context',
  '-c',
  '--host',
  '-H',
  '--log-level',
  '-l',
  '--tlscacert',
  '--tlscert',
  '--tlskey',
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
  '-t',
]);
const FLY_OPTIONS_WITH_ARGUMENT = new Set(['--config', '-c', '--org', '-o']);
const APT_OPTIONS_WITH_ARGUMENT = new Set([
  '--config-file',
  '--option',
  '--target-release',
  '-c',
  '-o',
  '-t',
]);
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
  'edit',
  'enable',
  'link',
  'mask',
  'preset',
  'preset-all',
  'reenable',
  'revert',
  'set-default',
  'set-property',
  'unmask',
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
    if (verb === 'certificate') {
      return ['approve', 'deny'].includes(tokens[index + 1]);
    }
    if (verb === 'auth') return tokens[index + 1] === 'reconcile';
    if (
      (verb === 'annotate' || verb === 'label' || verb === 'set') &&
      tokens.includes('--list')
    ) {
      return false;
    }
    return [
      'annotate',
      'apply',
      'autoscale',
      'cordon',
      'create',
      'delete',
      'drain',
      'edit',
      'expose',
      'label',
      'patch',
      'replace',
      'run',
      'scale',
      'set',
      'taint',
      'uncordon',
    ].includes(verb);
  }
  if (head === 'helm') {
    const { command: verb } = firstSubcommand(tokens, HELM_OPTIONS_WITH_ARGUMENT);
    return ['delete', 'install', 'rollback', 'uninstall', 'upgrade'].includes(verb);
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
    if (
      tokens.some(
        (token) =>
          token === '--generate-cli-skeleton' ||
          token.startsWith('--generate-cli-skeleton=')
      )
    ) {
      return false;
    }
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

function remoteAuthorityHasForbiddenCharacters(authority: string): boolean {
  if (/[\s\\'"{},<>&;|()]/.test(authority)) return true;
  return CONTROL_CHARACTER_RE.test(authority);
}

function isValidatedRemoteAuthority(authority: string): boolean {
  if (
    authority.length === 0 ||
    remoteAuthorityHasForbiddenCharacters(authority)
  ) {
    return false;
  }
  const at = authority.lastIndexOf('@');
  const user = at >= 0 ? authority.slice(0, at) : null;
  let hostAndPort = at >= 0 ? authority.slice(at + 1) : authority;
  if (user !== null && user.length === 0) return false;
  if (hostAndPort.startsWith('[')) {
    const close = hostAndPort.indexOf(']');
    if (close <= 1) return false;
    const suffix = hostAndPort.slice(close + 1);
    if (suffix && !/^:\d+$/.test(suffix)) return false;
    hostAndPort = hostAndPort.slice(1, close);
  } else {
    const port = /:(\d+)$/.exec(hostAndPort);
    if (port) hostAndPort = hostAndPort.slice(0, -port[0].length);
  }
  return hostAndPort.length > 0 && !hostAndPort.startsWith('-');
}

function isValidatedUriPort(port: string | undefined): boolean {
  if (port === undefined) return true;
  if (!/^\d{1,5}$/.test(port)) return false;
  const numericPort = Number(port);
  return numericPort >= 1 && numericPort <= 65_535;
}

function isValidatedIpv6Literal(literal: string): boolean {
  if (!literal.includes(':') || !/^[0-9A-Fa-f:.]+$/.test(literal)) {
    return false;
  }
  try {
    // The browser/server URL parser supplies the full IPv6 grammar (including
    // compressed and IPv4-mapped forms) without adding a Node-only dependency.
    new URL(`http://[${literal}]/`);
    return true;
  } catch {
    return false;
  }
}

/** URI authorities are stricter than legacy `[user@]host:path` syntax. In
 * particular, a URI has at most one user delimiter, an unambiguous optional
 * numeric port, and brackets around an IPv6 literal. */
function isValidatedUriAuthority(authority: string): boolean {
  if (
    authority.length === 0 ||
    remoteAuthorityHasForbiddenCharacters(authority) ||
    /[/?#]/.test(authority)
  ) {
    return false;
  }
  const at = authority.indexOf('@');
  if (at !== authority.lastIndexOf('@') || at === 0) return false;
  const hostAndPort = at >= 0 ? authority.slice(at + 1) : authority;
  if (hostAndPort.startsWith('[')) {
    const match = /^\[([0-9A-Fa-f:.]+)](?::(\d+))?$/.exec(hostAndPort);
    return !!(
      match &&
      isValidatedIpv6Literal(match[1]) &&
      isValidatedUriPort(match[2])
    );
  }
  const match = /^([^:[\]]+)(?::(\d+))?$/.exec(hostAndPort);
  return !!(
    match &&
    !match[1].startsWith('-') &&
    isValidatedUriPort(match[2])
  );
}

function isValidatedSshDestination(destination: string): boolean {
  if (/^ssh:\/\//i.test(destination)) {
    const authority = /^ssh:\/\/([^/?#]+)$/i.exec(destination)?.[1];
    return authority != null && isValidatedUriAuthority(authority);
  }
  return isValidatedRemoteAuthority(destination);
}

function isRemoteLocation(token: string | undefined): boolean {
  if (!token || /^[A-Za-z]:[\\/]/.test(token)) return false;
  if (/^(?:scp|rsync):\/\//i.test(token)) {
    const authority = /^(?:scp|rsync):\/\/([^/?#]+)(?:\/.*)?$/i.exec(
      token
    )?.[1];
    return authority != null && isValidatedUriAuthority(authority);
  }
  const bracketEnd = token.indexOf(']');
  const delimiter = token.indexOf(':', bracketEnd >= 0 ? bracketEnd : 0);
  if (delimiter <= 0) return false;
  return isValidatedRemoteAuthority(token.slice(0, delimiter));
}

function isRemoteDiscardLocation(token: string): boolean {
  if (/^rsync:\/\//i.test(token)) return false;
  if (/^scp:\/\//i.test(token)) {
    const path = /^scp:\/\/[^/?#]+(\/[^?#]*)?$/i.exec(token)?.[1];
    return path != null && isDiscardOutputPath(path);
  }
  const bracketEnd = token.indexOf(']');
  const delimiter = token.indexOf(':', bracketEnd >= 0 ? bracketEnd : 0);
  return delimiter > 0 && isDiscardOutputPath(token.slice(delimiter + 1));
}

const SCP_TRANSFER_SHORT_FLAGS = new Set([...'346ABCOpqRrsTv']);
const SCP_TRANSFER_SHORT_OPTIONS_WITH_ARGUMENT = new Set([
  ...'cDFiJloPSX',
]);
const RSYNC_TRANSFER_SHORT_FLAGS = new Set([
  ...'0468ACDEFIJKLNOPRSUWXabcdghiklmnopqrstuvxyz',
]);
const RSYNC_TRANSFER_SHORT_OPTIONS_WITH_ARGUMENT = new Set([
  ...'@BMTef',
]);
const RSYNC_TRANSFER_LONG_FLAGS = new Set([
  '--archive',
  '--backup',
  '--checksum',
  '--compress',
  '--delete',
  '--delete-after',
  '--delete-before',
  '--delete-delay',
  '--delete-during',
  '--dirs',
  '--dry-run',
  '--existing',
  '--force',
  '--fsync',
  '--hard-links',
  '--human-readable',
  '--ignore-existing',
  '--inplace',
  '--ipv4',
  '--ipv6',
  '--links',
  '--list-only',
  '--mkpath',
  '--partial',
  '--perms',
  '--progress',
  '--quiet',
  '--recursive',
  '--relative',
  '--remove-source-files',
  '--sparse',
  '--times',
  '--update',
  '--verbose',
  '--whole-file',
]);
const RSYNC_TRANSFER_LONG_OPTIONS_WITH_ARGUMENT = new Set([
  '--backup-dir',
  '--block-size',
  '--bwlimit',
  '--chmod',
  '--chown',
  '--compare-dest',
  '--compress-level',
  '--copy-dest',
  '--exclude',
  '--exclude-from',
  '--files-from',
  '--filter',
  '--include',
  '--include-from',
  '--link-dest',
  '--max-delete',
  '--max-size',
  '--min-size',
  '--modify-window',
  '--partial-dir',
  '--port',
  '--remote-option',
  '--rsync-path',
  '--rsh',
  '--suffix',
  '--temp-dir',
  '--timeout',
]);

/** Parse only the bounded, ordinary scp/rsync transfer surface. A successful
 * transfer requires at least one source plus a destination; rsync's one-source
 * form is a read-only listing. Option arguments must not become fake operands. */
function validatedRemoteTransfer(
  tokens: readonly string[]
): { destination: string; sources: string[]; removesSources: boolean } | null {
  const head = tokens[0];
  if (head !== 'scp' && head !== 'rsync') return null;
  const operands: string[] = [];
  let removesSources = false;
  let endOfOptions = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!endOfOptions && token === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && token.startsWith('--')) {
      if (head !== 'rsync') return null;
      const equals = token.indexOf('=');
      const option = equals < 0 ? token : token.slice(0, equals);
      if (RSYNC_TRANSFER_LONG_OPTIONS_WITH_ARGUMENT.has(option)) {
        if (equals >= 0) {
          if (equals === token.length - 1) return null;
        } else {
          if (tokens[index + 1] == null) return null;
          index += 1;
        }
        continue;
      }
      if (equals >= 0 || !RSYNC_TRANSFER_LONG_FLAGS.has(option)) return null;
      if (option === '--remove-source-files') removesSources = true;
      continue;
    }
    if (!endOfOptions && /^-[^-]/.test(token)) {
      const flags =
        head === 'scp' ? SCP_TRANSFER_SHORT_FLAGS : RSYNC_TRANSFER_SHORT_FLAGS;
      const withArgument =
        head === 'scp'
          ? SCP_TRANSFER_SHORT_OPTIONS_WITH_ARGUMENT
          : RSYNC_TRANSFER_SHORT_OPTIONS_WITH_ARGUMENT;
      for (let cursor = 1; cursor < token.length; cursor += 1) {
        const flag = token[cursor];
        if (flags.has(flag)) continue;
        if (!withArgument.has(flag)) return null;
        if (cursor === token.length - 1) {
          if (tokens[index + 1] == null) return null;
          index += 1;
        }
        break;
      }
      continue;
    }
    operands.push(token);
  }
  if (operands.length < 2) return null;
  const normalized = operands.map((operand) =>
    operand.replace(/[)}]+$/, '')
  );
  return {
    destination: normalized.at(-1)!,
    sources: normalized.slice(0, -1),
    removesSources,
  };
}

const SSH_OPTIONS_WITH_ARGUMENT = new Set([
  '-B', '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J', '-L', '-l', '-m',
  '-O', '-o', '-P', '-p', '-Q', '-R', '-S', '-W', '-w',
]);
const SSH_NO_ARGUMENT_SHORT_OPTIONS = new Set(
  [...'246AaCfGgKkMNnqsTtVvXxYy']
);
const SSH_ARGUMENT_SHORT_OPTIONS = new Set(
  [...SSH_OPTIONS_WITH_ARGUMENT].map((option) => option.slice(1))
);

function parseSshShortOption(option: string): {
  flags: string;
  argumentOption: string | null;
  argumentAttached: boolean;
} | null {
  if (!/^-[^-]/.test(option)) return null;
  let flags = '';
  for (let index = 1; index < option.length; index += 1) {
    const flag = option[index];
    if (SSH_NO_ARGUMENT_SHORT_OPTIONS.has(flag)) {
      flags += flag;
      continue;
    }
    if (SSH_ARGUMENT_SHORT_OPTIONS.has(flag)) {
      return {
        flags,
        argumentOption: flag,
        argumentAttached: index < option.length - 1,
      };
    }
    return null;
  }
  return { flags, argumentOption: null, argumentAttached: false };
}

function sshShortClusterHas(option: string, flags: string): boolean {
  const parsed = parseSshShortOption(option);
  return !!parsed && [...flags].some((flag) => parsed.flags.includes(flag));
}

function sshOptionConsumesNext(option: string): boolean {
  const parsed = parseSshShortOption(option);
  return !!(
    parsed?.argumentOption &&
    !parsed.argumentAttached
  );
}

function sshArgumentOptionIs(option: string, choices: string): boolean {
  const argumentOption = parseSshShortOption(option)?.argumentOption;
  return argumentOption != null && choices.includes(argumentOption);
}

/** Remove local shell redirections before interpreting ssh argv. Redirections
 * may appear anywhere in a simple command; treating one as the destination or
 * remote payload both loses the effective local fd0 proof and invents remote
 * source that OpenSSH never receives. */
function isShellRedirectionToken(token: string): boolean {
  return (
    /^(?:\d*(?:>>|>\||>&|>)|&>>?)$/.test(token) ||
    (!token.startsWith('<(') && /^\d*(?:<<<|<<-|<<|<>|<&|<)/.test(token))
  );
}

/** Shell IO numbers are decimal even when padded (`00` is stdin, `01` is
 * stdout). Compare their lexical form without converting unbounded attacker-
 * controlled digit strings to an imprecise JavaScript number. */
function shellIoNumberIs(
  raw: string,
  expected: number,
  implicit: number
): boolean {
  if (raw === '') return implicit === expected;
  const normalized = raw.replace(/^0+/, '') || '0';
  return normalized === String(expected);
}

function shellFdDupTargetIsUnproven(target: string): boolean {
  if (!target.startsWith('&')) return false;
  if (target === '&-') return false;
  const fd = /^&(\d+)$/.exec(target)?.[1];
  return !(
    fd &&
    [0, 1, 2].some((expected) => shellIoNumberIs(fd, expected, expected))
  );
}

function shellIoNumberIsProven(raw: string): boolean {
  if (raw === '') return true;
  const normalized = raw.replace(/^0+/, '') || '0';
  // Keep the proof deliberately bounded. Single-digit descriptors cover the
  // ordinary shell fd range (including callers that explicitly use 3-9), while
  // avoiding a claim when Bash will reject an attacker-sized IO number before
  // it executes the owning command.
  return /^\d$/.test(normalized);
}

function shellRedirectTargetHasUnprovenExpansion(target: string): boolean {
  return /[$`*?[\]{}~]/.test(decodeProtectedShellRedirects(target));
}

function shellArgvWithoutRedirections(
  tokens: string[],
  preserveProtectedRedirects = false
): string[] | null {
  const argv: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.startsWith('<(') || token.startsWith('>(')) {
      argv.push(token);
      continue;
    }
    const output = /^(\d*)(&>>|&>|>>|>\||>&|>)$/.exec(token);
    if (output) {
      if (!shellIoNumberIsProven(output[1])) return null;
      const target = tokens[index + 1];
      const decodedTarget =
        target == null ? null : decodeProtectedShellRedirects(target);
      if (
        target == null ||
        decodedTarget === '' ||
        shellRedirectTargetHasUnprovenExpansion(target) ||
        isShellRedirectionToken(target) ||
        (output[2] === '>&' &&
          (output[1] !== '' || /^(?:\d+|-)$/.test(target)) &&
          shellFdDupTargetIsUnproven(`&${target}`)) ||
        target === '(' ||
        target === ')'
      ) {
        return null;
      }
      index += 1;
      continue;
    }
    const input = /^(\d*)(<<<|<<-|<<|<>|<&|<)(.*)$/.exec(token);
    if (input) {
      if (!shellIoNumberIsProven(input[1])) return null;
      let target = input[3];
      if (target === '') {
        target = tokens[index + 1];
        if (
          target == null ||
          isShellRedirectionToken(target) ||
          target === '(' ||
          target === ')'
        ) {
          return null;
        }
        index += 1;
      }
      const decodedTarget = decodeProtectedShellRedirects(target);
      if (
        ((input[2] === '<' || input[2] === '<>') && decodedTarget === '') ||
        ((input[2] === '<' || input[2] === '<>') &&
          shellRedirectTargetHasUnprovenExpansion(target)) ||
        input[2] === '<&' &&
        shellFdDupTargetIsUnproven(`&${target}`)
      ) {
        return null;
      }
      continue;
    }
    argv.push(
      preserveProtectedRedirects
        ? token
        : decodeProtectedShellRedirects(token)
    );
  }
  return argv;
}

function shellListSourceHasProvenRedirections(source: string): boolean {
  const tokens = rawExecutableShellTokens(source);
  return (
    tokens.length > 0 && shellArgvWithoutRedirections(tokens, true) !== null
  );
}

/** Determine which top-level stages remain auditable after a stage whose own
 * redirects are rejected or unproven. Pipelines launch every stage, while an
 * unknown/rejected status makes both `&&` and `||` dependents fail closed until
 * an independent list separator. Ordinary proven-argv statuses stay eligible
 * under the historical attempt-evidence contract. */
function analyzedShellList(command: string) {
  const list = executableShellListSegments(command);
  const eligible = Array.from({ length: list.length }, () => false);
  let booleanChainBlocked = false;
  let previousConnector: string | undefined;
  let start = 0;

  while (start < list.length) {
    let end = start;
    while (
      end < list.length - 1 &&
      (list[end].followingOperator === '|' ||
        list[end].followingOperator === '|&')
    ) {
      end += 1;
    }

    const booleanDependent =
      previousConnector === '&&' || previousConnector === '||';
    if (!booleanDependent) booleanChainBlocked = false;
    const skipped = booleanDependent && booleanChainBlocked;
    if (!skipped) {
      for (let index = start; index <= end; index += 1) {
        eligible[index] = shellListSourceHasProvenRedirections(
          list[index].source
        );
      }

      // `null` can mean deterministic redirect failure or merely an fd whose
      // ambient openness cannot be proven. In either case, do not choose an
      // `&&` or `||` dependent branch from that unknown status. A later `;` or
      // newline resets the barrier, and non-final pipeline stages do not own
      // the pipeline's status.
      booleanChainBlocked = !shellListSourceHasProvenRedirections(
        list[end].source
      );
    }

    previousConnector = list[end].followingOperator;
    start = end + 1;
  }

  // A redirection attached to a compound-command closer is established before
  // any command in that compound body runs. Attribute its deterministic
  // failure back to the matching opener instead of treating the body segments
  // as independent successful invocations.
  type CompoundKind = 'brace' | 'if' | 'loop' | 'case' | 'test';
  type RequiredCompoundKeyword = 'then' | 'do' | 'in';
  const frames: Array<{
    kind: CompoundKind;
    start: number;
    bodyExecutionUnproven: boolean;
    statusUnproven: boolean;
    requiredKeyword: RequiredCompoundKeyword | null;
    requiredKeywordSeen: boolean;
  }> = [];
  const unprovenCompoundStatuses = new Set<number>();
  const parseUnitStart = (index: number) => {
    let unitStart = 0;
    for (let cursor = 0; cursor < index; cursor += 1) {
      if (list[cursor].followingOperator === '\n') unitStart = cursor + 1;
    }
    return unitStart;
  };
  const closerKind = (token: string) =>
    token === '}'
      ? 'brace'
      : token === 'fi'
        ? 'if'
        : token === 'done'
          ? 'loop'
          : token === 'esac'
            ? 'case'
            : token === ']]'
              ? 'test'
            : null;
  const invalidateParseUnit = (index: number) => {
    eligible.fill(false, parseUnitStart(index));
  };
  const activeFrame = (kind: CompoundKind) =>
    frames.findLast((frame) => frame.kind === kind);
  for (let index = 0; index < list.length; index += 1) {
    const tokens = rawExecutableShellTokens(list[index].source);

    // Function bodies are declarations, not executed invocations. Brace
    // bodies are tracked by the compound stack below; a subshell body remains
    // inside one list segment and can be discarded directly. A declaration
    // without either body form is a parse error for the whole current input
    // unit, so no earlier semicolon-separated command in that unit ran.
    const shellName = (token: string | undefined) =>
      token != null && /^[A-Za-z_][A-Za-z0-9_]*$/.test(token);
    let functionBodyStart: number | null = null;
    let functionLike = false;
    if (tokens[0] === 'function') {
      functionLike = true;
      if (shellName(tokens[1])) {
        functionBodyStart =
          tokens[2] === '(' && tokens[3] === ')' ? 4 : 2;
      }
    } else if (
      shellName(tokens[0]) &&
      tokens[1] === '(' &&
      tokens[2] === ')'
    ) {
      functionLike = true;
      functionBodyStart = 3;
    }
    if (functionLike) {
      const bodyToken =
        functionBodyStart == null ? undefined : tokens[functionBodyStart];
      if (bodyToken !== '{' && bodyToken !== '(') {
        invalidateParseUnit(index);
        continue;
      }
      if (bodyToken === '(') {
        eligible[index] = false;
        continue;
      }
    }

    const head = tokens[0];
    const currentIf = activeFrame('if');
    if (head === 'then') {
      if (!currentIf || currentIf.requiredKeywordSeen) {
        invalidateParseUnit(index);
      } else {
        currentIf.requiredKeywordSeen = true;
      }
    } else if (head === 'elif') {
      if (!currentIf || !currentIf.requiredKeywordSeen) {
        invalidateParseUnit(index);
      } else {
        currentIf.requiredKeywordSeen = false;
      }
    } else if (head === 'else') {
      if (!currentIf || !currentIf.requiredKeywordSeen) {
        invalidateParseUnit(index);
      }
    }
    if (head === 'do') {
      const currentLoop = activeFrame('loop');
      if (!currentLoop || currentLoop.requiredKeywordSeen) {
        invalidateParseUnit(index);
      } else {
        currentLoop.requiredKeywordSeen = true;
      }
    }
    if (head === 'in') {
      const currentCase = activeFrame('case');
      if (
        !currentCase ||
        currentCase.requiredKeywordSeen ||
        list[index - 1]?.followingOperator !== '\n'
      ) {
        invalidateParseUnit(index);
      } else {
        currentCase.requiredKeywordSeen = true;
      }
    }
    if (head === 'coproc' && tokens.length === 1) {
      invalidateParseUnit(index);
      continue;
    }

    for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
      const token = tokens[tokenIndex];
      if (token === '{') {
        const functionBody =
          tokens[0] === 'function' ||
          (tokenIndex >= 2 &&
            tokens[tokenIndex - 1] === ')' &&
            tokens[tokenIndex - 2] === '(');
        frames.push({
          kind: 'brace',
          start: index,
          bodyExecutionUnproven: functionBody,
          // Defining a function succeeds without running its body. Ordinary
          // brace groups keep the historical attempt-evidence treatment of
          // their final simple command's status.
          statusUnproven: false,
          requiredKeyword: null,
          requiredKeywordSeen: true,
        });
      } else if (tokenIndex === 0 && token === 'if') {
        frames.push({
          kind: 'if',
          start: index,
          bodyExecutionUnproven: true,
          statusUnproven: true,
          requiredKeyword: 'then',
          requiredKeywordSeen: false,
        });
      } else if (
        tokenIndex === 0 &&
        (token === 'while' ||
          token === 'until' ||
          token === 'for' ||
          token === 'select')
      ) {
        frames.push({
          kind: 'loop',
          start: index,
          bodyExecutionUnproven: true,
          statusUnproven: true,
          requiredKeyword: 'do',
          requiredKeywordSeen: false,
        });
      } else if (tokenIndex === 0 && token === 'case') {
        frames.push({
          kind: 'case',
          start: index,
          bodyExecutionUnproven: true,
          statusUnproven: true,
          requiredKeyword: 'in',
          requiredKeywordSeen: tokens.slice(2).includes('in'),
        });
      } else if (tokenIndex === 0 && token === '[[') {
        frames.push({
          kind: 'test',
          start: index,
          bodyExecutionUnproven: false,
          statusUnproven: false,
          requiredKeyword: null,
          requiredKeywordSeen: true,
        });
      }
      const kind =
        tokenIndex === 0 || token === '}' || token === ']]'
          ? closerKind(token)
          : null;
      if (!kind) continue;
      if (token === '}' && tokenIndex > 0) {
        invalidateParseUnit(index);
      }
      const frameIndex = frames.findLastIndex((frame) => frame.kind === kind);
      if (frameIndex < 0) {
        invalidateParseUnit(index);
        continue;
      }
      const [frame] = frames.splice(frameIndex, 1);
      if (frame.requiredKeyword && !frame.requiredKeywordSeen) {
        invalidateParseUnit(index);
      }
      if (frame.statusUnproven) unprovenCompoundStatuses.add(index);
      if (
        frame.bodyExecutionUnproven ||
        !shellListSourceHasProvenRedirections(list[index].source)
      ) {
        eligible.fill(false, frame.start, index + 1);
      }
    }
    if (
      ['then', 'elif', 'else'].includes(tokens[0] ?? '') &&
      !frames.some((frame) => frame.kind === 'if')
    ) {
      invalidateParseUnit(index);
    }
    if (
      tokens[0] === 'do' &&
      !frames.some((frame) => frame.kind === 'loop')
    ) {
      invalidateParseUnit(index);
    }
    if (
      [';;', ';&', ';;&'].includes(list[index].followingOperator ?? '') &&
      !frames.some((frame) => frame.kind === 'case')
    ) {
      invalidateParseUnit(index);
    }
  }
  for (const frame of frames) {
    eligible.fill(false, parseUnitStart(frame.start));
  }

  // A completed if/loop/case can produce different statuses depending on
  // runtime conditions that this bounded parser deliberately does not model.
  // Its following `&&`/`||` arm therefore has unknown reachability, as do the
  // remaining arms in that same boolean chain. An independent separator
  // restores the historical attempt-evidence behavior.
  let unprovenBooleanChain = false;
  let precedingOperator: string | undefined;
  start = 0;
  while (start < list.length) {
    let end = start;
    while (
      end < list.length - 1 &&
      (list[end].followingOperator === '|' ||
        list[end].followingOperator === '|&')
    ) {
      end += 1;
    }
    const booleanDependent =
      precedingOperator === '&&' || precedingOperator === '||';
    if (!booleanDependent) unprovenBooleanChain = false;
    const skipped = booleanDependent && unprovenBooleanChain;
    if (skipped) eligible.fill(false, start, end + 1);
    if (!skipped) {
      // Only the final pipeline stage determines the pipeline status.
      unprovenBooleanChain = unprovenCompoundStatuses.has(end);
    }
    precedingOperator = list[end].followingOperator;
    start = end + 1;
  }

  return { list, eligible };
}

function leaveBehindEligibleShellSource(command: string): string {
  const { list, eligible } = analyzedShellList(command);
  const retained: string[] = [];
  let start = 0;
  while (start < list.length) {
    let end = start;
    while (
      end < list.length - 1 &&
      (list[end].followingOperator === '|' ||
        list[end].followingOperator === '|&')
    ) {
      end += 1;
    }
    // Append-mode tee proof depends on an unbroken producer-to-consumer path.
    // Dropping one rejected stage and rejoining its neighbors would manufacture
    // bytes that never reached tee, so retain only wholly auditable pipelines.
    if (eligible.slice(start, end + 1).every(Boolean)) {
      for (let index = start; index <= end; index += 1) {
        retained.push(
          `${list[index].source}${list[index].followingOperator ?? ''}`
        );
      }
    }
    start = end + 1;
  }
  return retained.join('\n');
}

const INCOMPLETE_TRAILING_REDIRECTION_RE =
  /(?:<<<|<<-|<<|<>|<&|<|>>|>\||>&|>)\s*$/;

/** A syntax error in one list stage prevents the shell from executing later
 * stages in the same `Bash` command. Segment-local argv validation is not
 * enough because the risky token may live after the malformed separator. */
function hasMalformedShellRedirection(command: string): boolean {
  if (command.includes('\0')) return true;
  const executable = executableShellSource(command);
  return executableShellListSegments(executable).some(({ source }) => {
    const malformedTokens = [rawExecutableShellTokens(source)].some((tokens) => {
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (token.startsWith('<(') || token.startsWith('>(')) continue;
        const output = /^(\d*)(?:&>>|&>|>>|>\||>&|>)$/.exec(token);
        const input = /^(\d*)(?:<<<|<<-|<<|<>|<&|<)(.*)$/.exec(token);
        if (!output && !input) continue;
        if (input?.[2]) continue;
        const target = tokens[index + 1];
        if (
          target == null ||
          isShellRedirectionToken(target) ||
          /^[|;&()]+$/.test(target)
        ) {
          return true;
        }
        index += 1;
      }
      return false;
    });
    if (INCOMPLETE_TRAILING_REDIRECTION_RE.test(source.trimEnd())) {
      if (malformedTokens) return true;
    }
    // Only syntax errors taint the whole list. A validly parsed invocation may
    // still fail its own redirection at runtime (for example `2>&foo`); the
    // owning invocation is rejected by shellArgvWithoutRedirections, but Bash
    // may continue with a later `;`-separated command.
    return malformedTokens;
  });
}

function isValidatedSshConfig(value: string): boolean {
  const match = /^([A-Za-z][A-Za-z0-9]*)(?:\s+|=)([\s\S]+)$/.exec(
    value.trim()
  );
  if (!match) return false;
  const name = match[1].toLowerCase();
  const configured = match[2].trim();
  if (!configured) return false;
  if (name === 'forkafterauthentication' || name === 'stdinnull') {
    return /^(?:yes|no)$/i.test(configured);
  }
  if (name === 'sessiontype') {
    return /^(?:none|default|subsystem)$/i.test(configured);
  }
  if (name === 'stricthostkeychecking') {
    return /^(?:yes|no|ask|accept-new|off)$/i.test(configured);
  }
  if (name === 'hostkeyalias') return /^[A-Za-z0-9._-]+$/.test(configured);
  if (name === 'globalknownhostsfile') {
    return /^\/[A-Za-z0-9._/-]+$/.test(configured);
  }
  return [
    'include',
    'remotecommand',
  ].includes(name);
}

function isValidatedSshOptionArgument(option: string, value: string): boolean {
  if (!value) return false;
  if (option === 'o') return isValidatedSshConfig(value);
  if (option === 'p') {
    if (!/^\d+$/.test(value)) return false;
    const port = Number.parseInt(value, 10);
    return port >= 1 && port <= 65_535;
  }
  if (option === 'P' || option === 'F') return !/\s/.test(value);
  if (option === 'W') return /^[^\s:]+:\d+$/.test(value);
  if (option === 'O') {
    return /^(?:check|forward|cancel|exit|stop)$/.test(value);
  }
  if (option === 'Q') {
    return /^(?:cipher|cipher-auth|help|mac|kex|key|key-cert|key-plain|protocol-version|sig)$/.test(
      value
    );
  }
  // Other argument-bearing options can fail locally based on value syntax or
  // alter command routing in ways this bounded proof does not model.
  return false;
}

function validatedSshArgv(tokens: string[]): string[] | null {
  const argv = shellArgvWithoutRedirections(tokens, true);
  if (!argv || argv[0] !== 'ssh') return null;
  let index = 1;
  for (; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--') {
      index += 1;
      break;
    }
    if (!option.startsWith('-')) break;
    const parsed = parseSshShortOption(option);
    if (!parsed) return null;
    if (parsed.argumentOption) {
      const value = parsed.argumentAttached
        ? option.slice(option.indexOf(parsed.argumentOption, 1) + 1)
        : argv[index + 1];
      if (
        value == null ||
        !isValidatedSshOptionArgument(parsed.argumentOption, value)
      ) {
        return null;
      }
      if (!parsed.argumentAttached) index += 1;
    }
  }
  if (index >= argv.length) return null;
  const destination = decodeProtectedShellRedirects(argv[index]);
  if (!isValidatedSshDestination(destination)) return null;
  return argv;
}

/** ssh modes that inspect local state, establish forwarding and exit, or
 * request a subsystem without evaluating trailing argv as a shell command. */
function isSshQueryInvocation(tokens: string[]): boolean {
  const argv = validatedSshArgv(tokens);
  if (!argv) return true;
  if (
    sshInlineConfigValue(argv, 'SessionType')?.toLowerCase() === 'none'
  ) {
    return true;
  }
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--' || !option.startsWith('-')) return false;
    if (
      sshShortClusterHas(option, 'GNsV') ||
      sshArgumentOptionIs(option, 'QOW')
    ) {
      return true;
    }
    if (sshOptionConsumesNext(option)) index += 1;
  }
  return false;
}

function sshRunsInBackground(tokens: string[]): boolean {
  const argv = validatedSshArgv(tokens);
  if (!argv) return true;
  if (
    sshInlineConfigValue(
      argv,
      'ForkAfterAuthentication'
    )?.toLowerCase() === 'yes'
  ) {
    return true;
  }
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--' || !option.startsWith('-')) return false;
    if (sshShortClusterHas(option, 'f')) return true;
    if (sshOptionConsumesNext(option)) index += 1;
  }
  return false;
}

/** `ssh -n` detaches stdin and `ssh -f` implies it. An explicit payload still
 * executes, but a local heredoc cannot become the remote program. */
function sshDisablesStdin(tokens: string[]): boolean {
  const argv = validatedSshArgv(tokens);
  if (!argv) return true;
  if (
    sshRunsInBackground(argv) ||
    sshInlineConfigValue(argv, 'StdinNull')?.toLowerCase() === 'yes'
  ) {
    return true;
  }
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--' || !option.startsWith('-')) return false;
    if (sshShortClusterHas(option, 'fn')) return true;
    if (sshOptionConsumesNext(option)) index += 1;
  }
  return false;
}

function sshPayloadTokens(tokens: string[]): string[] | null {
  const argv = validatedSshArgv(tokens);
  if (!argv) return null;
  let index = 1;
  while (index < argv.length && argv[index].startsWith('-')) {
    if (argv[index] === '--') {
      index += 1;
      break;
    }
    const option = argv[index];
    index += sshOptionConsumesNext(option) ? 2 : 1;
  }
  if (index >= argv.length) return [];
  index += 1; // destination host
  if (argv[index] === '--') index += 1;
  return argv.slice(index);
}

// Re-serialize argv back into shell source so the analyzer can re-parse it one
// level down (`kubectl exec … -- <payload>`). Uses the shared minimal quoter
// (#3379) rather than a local copy. The contract that matters here is that each
// element round-trips to exactly one token, which quoting preserves: the
// re-parse unquotes before matching, so an option like `-rf` is still read as
// an option whether or not the quoter passed it through unquoted.
function shellSourceFromArgv(argv: string[]): string {
  return argv.map(shellQuoteMinimal).join(' ');
}

function sshPayload(tokens: string[]): string | null {
  // OpenSSH concatenates trailing local argv with spaces before handing the
  // resulting source to the remote shell; local quote boundaries are gone.
  const argv = sshPayloadTokens(tokens);
  if (!argv) return null;
  return argv.map(decodeProtectedShellRedirects).join(' ');
}

interface SshConfiguredCommand {
  configured: boolean;
  payload: string;
}

/** Read a command-line `-o Key=Value` / `-o 'Key Value'` setting without
 * consulting ambient ssh configuration. OpenSSH uses the first value obtained
 * for a keyword, so return the first matching command-line occurrence. */
function sshInlineConfigValue(
  tokens: string[],
  name: string
): string | null {
  for (let index = 1; index < tokens.length; index += 1) {
    const option = tokens[index];
    if (option === '--' || !option.startsWith('-')) break;
    const parsed = parseSshShortOption(option);
    if (parsed?.argumentOption === 'o') {
      const value = parsed.argumentAttached
        ? option.slice(option.indexOf('o', 1) + 1)
        : (tokens[index + 1] ?? '');
      const match = /^([A-Za-z][A-Za-z0-9]*)(?:\s+|=)([\s\S]*)$/.exec(
        value.trim()
      );
      if (match?.[1].toLowerCase() === name.toLowerCase()) {
        return match[2].trim();
      }
    }
    if (sshOptionConsumesNext(option)) index += 1;
  }
  return null;
}

/** Extract an inline `-o RemoteCommand=…` without consulting ambient ssh
 * configuration. OpenSSH rejects an invocation that supplies both this option
 * and a trailing command, so callers can fail closed on that combination. */
function sshConfiguredRemoteCommand(tokens: string[]): SshConfiguredCommand {
  const configured = sshInlineConfigValue(tokens, 'RemoteCommand');
  const payload =
    configured == null ? null : decodeProtectedShellRedirects(configured);
  if (payload == null) return { configured: false, payload: '' };
  return {
    configured: payload.toLowerCase() !== 'none',
    payload: payload.toLowerCase() === 'none' ? '' : payload,
  };
}

/** `-F` and command-line Include delegate stdin/command semantics to an opaque
 * file. Decline execution claims rather than assuming its RemoteCommand,
 * StdinNull, or SessionType settings. */
function sshHasOpaqueConfig(tokens: string[]): boolean {
  const argv = validatedSshArgv(tokens);
  if (!argv) return true;
  if (sshInlineConfigValue(argv, 'Include') != null) return true;
  for (let index = 1; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--' || !option.startsWith('-')) break;
    if (sshArgumentOptionIs(option, 'F')) return true;
    if (sshOptionConsumesNext(option)) index += 1;
  }
  return false;
}

function sshEffectivePayload(tokens: string[]): {
  payload: string;
  implicitShell: boolean;
  valid: boolean;
} {
  const explicit = sshPayload(tokens);
  if (explicit == null) {
    return { payload: '', implicitShell: false, valid: false };
  }
  const configured = sshConfiguredRemoteCommand(tokens);
  if (explicit && configured.configured) {
    return { payload: '', implicitShell: false, valid: false };
  }
  if (explicit) return { payload: explicit, implicitShell: false, valid: true };
  if (configured.configured) {
    return { payload: configured.payload, implicitShell: false, valid: true };
  }
  return { payload: '', implicitShell: true, valid: true };
}

const SHELL_EXECUTABLES = new Set(['bash', 'dash', 'ksh', 'sh', 'zsh']);
const SHELL_TERMINAL_LONG_OPTIONS = new Set([
  '--dump-po-strings',
  '--dump-strings',
  '--help',
  '--pretty-print',
  '--rpm-requires',
  '--version',
]);
const SHELL_EXECUTING_LONG_OPTIONS = new Set([
  '--debugger',
  '--login',
  '--noediting',
  '--noprofile',
  '--norc',
  '--posix',
  '--restricted',
  '--verbose',
]);
const SHELL_SET_OPTION_NAMES = new Set([
  'allexport', 'braceexpand', 'emacs', 'errexit', 'errtrace', 'functrace',
  'hashall', 'histexpand', 'history', 'ignoreeof', 'keyword', 'monitor',
  'noclobber', 'noexec', 'noglob', 'nolog', 'notify', 'nounset', 'onecmd',
  'physical', 'pipefail', 'posix', 'privileged', 'verbose', 'vi', 'xtrace',
]);
const SHELL_SHOPT_OPTION_NAMES = new Set([
  'autocd', 'assoc_expand_once', 'cdable_vars', 'cdspell', 'checkhash',
  'checkjobs', 'checkwinsize', 'cmdhist', 'complete_fullquote', 'direxpand',
  'dirspell', 'dotglob', 'execfail', 'expand_aliases', 'extdebug', 'extglob',
  'extquote', 'failglob', 'force_fignore', 'globasciiranges', 'globskipdots',
  'globstar', 'gnu_errfmt', 'histappend', 'histreedit', 'histverify',
  'hostcomplete', 'huponexit', 'inherit_errexit', 'interactive_comments',
  'lastpipe', 'lithist', 'localvar_inherit', 'localvar_unset', 'login_shell',
  'mailwarn', 'no_empty_cmd_completion', 'nocaseglob', 'nocasematch',
  'noexpand_translation', 'nullglob', 'patsub_replacement', 'progcomp',
  'progcomp_alias', 'promptvars', 'restricted_shell', 'shift_verbose',
  'sourcepath', 'varredir_close', 'xpg_echo',
]);
const SHELL_SHORT_OPTION_FLAGS = new Set([
  ...'abefhkmnptuvxBCEHPT',
  'c', 'D', 'i', 'l', 'r', 's', 'O', 'o',
]);

interface ShellInvocation {
  noExec: boolean;
  errexit: boolean;
  nounset: boolean;
  onecmd: boolean;
  commandPayload: string | null;
  hasCommandFlag: boolean;
  readsStdin: boolean;
  scriptOperand: string | null;
}

function parseShellInvocation(tokens: string[]): ShellInvocation | null {
  if (!SHELL_EXECUTABLES.has(tokens[0])) return null;
  const argv = shellArgvWithoutRedirections(tokens);
  if (!argv) return null;
  let noExec = false;
  let dumpOnly = false;
  let errexit = false;
  let nounset = false;
  let onecmd = false;
  let readsStdin = false;
  let sawShortOption = false;
  let index = 1;

  for (; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      index += 1;
      break;
    }
    if (SHELL_TERMINAL_LONG_OPTIONS.has(token)) {
      if (tokens[0] !== 'bash' || sawShortOption) return null;
      return {
        noExec: true,
        errexit,
        nounset,
        onecmd,
        commandPayload: null,
        hasCommandFlag: false,
        readsStdin: false,
        scriptOperand: null,
      };
    }
    if (token === '--init-file' || token === '--rcfile') {
      if (tokens[0] !== 'bash' || sawShortOption) return null;
      if (argv[index + 1] == null) return null;
      index += 1;
      continue;
    }
    if (token === '-O' || token === '+O') {
      sawShortOption = true;
      if (!SHELL_SHOPT_OPTION_NAMES.has(argv[index + 1] ?? '')) return null;
      index += 1;
      continue;
    }
    if (token === '-o' || token === '+o') {
      sawShortOption = true;
      const optionName = argv[index + 1] ?? '';
      if (!SHELL_SET_OPTION_NAMES.has(optionName)) return null;
      if (optionName === 'noexec') noExec = token.startsWith('-');
      if (optionName === 'errexit') errexit = token.startsWith('-');
      if (optionName === 'nounset') nounset = token.startsWith('-');
      if (optionName === 'onecmd') onecmd = token.startsWith('-');
      index += 1;
      continue;
    }
    if (/^[+-][^-]+$/.test(token)) {
      sawShortOption = true;
      const enabled = token.startsWith('-');
      const flags = token.slice(1);
      if ([...flags].some((flag) => !SHELL_SHORT_OPTION_FLAGS.has(flag))) {
        return null;
      }
      if (!enabled && flags.includes('c')) return null;
      if (flags.includes('n')) noExec = enabled;
      // Bash's `+D` is a dump mode too, not the inverse of `-D`. Either form
      // implies noexec, and a later flag cannot make the payload executable.
      if (flags.includes('D')) dumpOnly = true;
      if (flags.includes('e')) errexit = enabled;
      if (flags.includes('u')) nounset = enabled;
      if (flags.includes('t')) onecmd = enabled;
      if (flags.includes('s')) readsStdin = enabled;
      let optionNameOffset = 0;
      for (const flag of flags) {
        if (flag !== 'O' && flag !== 'o') continue;
        const optionName = argv[index + 1 + optionNameOffset];
        if (
          (flag === 'O' && !SHELL_SHOPT_OPTION_NAMES.has(optionName ?? '')) ||
          (flag === 'o' && !SHELL_SET_OPTION_NAMES.has(optionName ?? ''))
        ) {
          return null;
        }
        if (flag === 'o' && optionName === 'noexec') noExec = enabled;
        if (flag === 'o' && optionName === 'errexit') errexit = enabled;
        if (flag === 'o' && optionName === 'nounset') nounset = enabled;
        if (flag === 'o' && optionName === 'onecmd') onecmd = enabled;
        optionNameOffset += 1;
      }
      if (enabled && flags.includes('c')) {
        const payload = argv[index + 1 + optionNameOffset];
        return {
          noExec: noExec || dumpOnly,
          errexit,
          nounset,
          onecmd,
          commandPayload: payload && !payload.startsWith('<') ? payload : null,
          hasCommandFlag: true,
          readsStdin,
          scriptOperand: null,
        };
      }
      index += optionNameOffset;
      continue;
    }
    if (token.startsWith('--')) {
      if (
        tokens[0] !== 'bash' ||
        sawShortOption ||
        !SHELL_EXECUTING_LONG_OPTIONS.has(token)
      ) {
        return null;
      }
      continue;
    }
    break;
  }

  const operands = argv.slice(index);
  const scriptOperand = operands[0] ?? null;
  const readsProgramFromStdin =
    scriptOperand == null ||
    scriptOperand === '-' ||
    /^(?:\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/.test(scriptOperand);
  return {
    noExec: noExec || dumpOnly,
    errexit,
    nounset,
    onecmd,
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

function riskyShellCommandPayload(tokens: string[]): string | null {
  const invocation = parseShellInvocation(tokens);
  const payload =
    invocation && !invocation.noExec ? invocation.commandPayload : null;
  if (
    !payload ||
    !invocation ||
    (!invocation.errexit && !invocation.nounset && !invocation.onecmd)
  ) {
    return payload;
  }
  return executableShellListSegments(payload).length === 1 ? payload : null;
}

function shellReadsProgramFromStdin(tokens: string[]): boolean {
  const invocation = parseShellInvocation(tokens);
  return !!(
    invocation &&
    !invocation.noExec &&
    !invocation.hasCommandFlag &&
    invocation.scriptOperand == null
  );
}

interface ShellStdinRedirection {
  kind: 'heredoc' | 'override';
  delimiter?: string;
}

function shellStdinRedirections(tokens: string[]): ShellStdinRedirection[] {
  const redirections: ShellStdinRedirection[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const hereString = /^(\d*)<<<(.*)$/.exec(token);
    if (hereString) {
      if (shellIoNumberIs(hereString[1], 0, 0)) {
        redirections.push({ kind: 'override' });
      }
      if (!hereString[2]) index += 1;
      continue;
    }
    const heredoc = /^(\d*)<<(-?)(.*)$/.exec(token);
    if (heredoc) {
      const delimiter = heredoc[3] || tokens[index + 1] || '';
      if (shellIoNumberIs(heredoc[1], 0, 0)) {
        redirections.push({ kind: 'heredoc', delimiter });
      }
      if (!heredoc[3]) index += 1;
      continue;
    }
    const input = /^(\d*)(?:<>|<&|<)(.*)$/.exec(token);
    if (!input || token.startsWith('<(')) continue;
    if (shellIoNumberIs(input[1], 0, 0)) {
      redirections.push({ kind: 'override' });
    }
    if (!input[2]) index += 1;
  }
  return redirections;
}

function shellConsumesStdinProgram(tokens: string[]): boolean {
  return (
    shellReadsProgramFromStdin(tokens) &&
    shellStdinRedirections(tokens).length === 0
  );
}

function shellRunsWithReachabilityShortCircuit(tokens: string[]): boolean {
  const invocation = parseShellInvocation(tokens);
  return !!(
    invocation &&
    !invocation.noExec &&
    (invocation.errexit || invocation.nounset || invocation.onecmd)
  );
}

function shellConsumesStdinProgramWithReachabilityShortCircuit(
  tokens: string[]
): boolean {
  return (
    shellRunsWithReachabilityShortCircuit(tokens) &&
    shellConsumesStdinProgram(tokens)
  );
}

function commandConsumesHeredocInput(
  tokens: string[],
  delimiter: string
): boolean {
  const effective = shellStdinRedirections(tokens).at(-1);
  return (
    effective?.kind === 'heredoc' && effective.delimiter === delimiter
  );
}

/** Whether this shell reads its program from stdin rather than -c or a file. */
function shellConsumesHeredoc(
  tokens: string[],
  delimiter: string
): boolean {
  return (
    shellReadsProgramFromStdin(tokens) &&
    commandConsumesHeredocInput(tokens, delimiter)
  );
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
  includeProcessSubstitutions = true,
  heredocExpansionMode = false
): string[] {
  const bodies: string[] = [];
  let quote: "'" | '"' | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const ch = command[index];
    if (!heredocExpansionMode && quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (
      ch === '\\' &&
      (heredocExpansionMode
        ? command[index + 1] != null && /[$`\\\n\r]/.test(command[index + 1])
        : scannerBackslashEscapes(quote, command[index + 1]))
    ) {
      escaped = true;
      continue;
    }
    if (!heredocExpansionMode && quote === '"' && ch === '"') {
      quote = null;
      continue;
    }
    if (!heredocExpansionMode && quote === null && ch === "'") {
      quote = "'";
      continue;
    }
    if (!heredocExpansionMode && quote === null && ch === '"') {
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
    } else {
      // Every later opener is nested inside this unmatched substitution.
      // Resuming at the next byte would only rescan the same suffix and can
      // make malformed transcript input quadratic.
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

function hasUnsafePipelineRedirection(
  tokens: string[],
  allowFd0HereInput: boolean
): boolean {
  // Every redirect is established before cat/tee runs. An unrelated bad fd or
  // missing file therefore prevents all transport even if stdin/stdout would
  // otherwise still point at the pipeline. Producers may have the bounded
  // in-memory here-doc/string chain whose final fd0 heredoc was selected;
  // intermediates may not redirect input at all.
  for (let index = 0; index < tokens.length; index += 1) {
    const input = /^(\d*)(<<<|<<-|<<|<>|<&|<)(.*)$/.exec(tokens[index]);
    if (input) {
      const target = input[3] || tokens[index + 1];
      if (!target) return true;
      if (!input[3]) index += 1;
      if (
        allowFd0HereInput &&
        shellIoNumberIs(input[1], 0, 0) &&
        (input[2] === '<<<' || input[2] === '<<' || input[2] === '<<-')
      ) {
        continue;
      }
      return true;
    }
    const output = /^(\d*)(&>>|&>|>>|>\||>&|>)(.*)$/.exec(tokens[index]);
    if (!output) continue;
    if (!shellIoNumberIsProven(output[1])) return true;
    const target = output[3] || tokens[index + 1];
    if (!target) return true;
    if (!output[3]) index += 1;
    // `2>&1` is the explicit spelling of the already-supported `|&`: fd1 is
    // still the pipeline and the duplication cannot fail.
    if (
      output[2] === '>&' &&
      shellIoNumberIs(output[1], 2, 1) &&
      shellIoNumberIs(target, 1, 1)
    ) {
      continue;
    }
    return true;
  }
  return false;
}

function validCatPassThroughArgv(argv: string[]): boolean {
  let endOfOptions = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!endOfOptions && argument === '--') {
      endOfOptions = true;
      continue;
    }
    if (
      argument !== '-' &&
      argument !== '/dev/stdin' &&
      argument !== '/dev/fd/0' &&
      argument !== '/proc/self/fd/0'
    ) {
      return false;
    }
  }
  return true;
}

function validTeePassThroughArgv(argv: string[]): boolean {
  let endOfOptions = false;
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!endOfOptions && argument === '--') {
      endOfOptions = true;
      continue;
    }
    if (endOfOptions || !argument.startsWith('-') || argument === '-') continue;
    if (/^-[aip]+$/.test(argument)) continue;
    if (
      argument === '--append' ||
      argument === '--ignore-interrupts' ||
      argument === '--output-error' ||
      /^--output-error=(?:warn|warn-nopipe|exit|exit-nopipe)$/.test(argument)
    ) {
      continue;
    }
    return false;
  }
  return true;
}

/** Commands whose stdin bytes are copied unchanged to the next pipeline stage.
 * The producer may own the selected heredoc; intermediates must still read the
 * prior pipe. Any stdout override, transforming/unknown option, or extra cat
 * file makes the transport proof ambiguous and therefore fails closed. */
function isPipelinePassThrough(
  tokens: string[],
  allowInputRedirection = false
): boolean {
  if (
    isNonMutatingInvocation(tokens) ||
    hasShortHelpFlag(tokens) ||
    tokens.includes('-V') ||
    hasUnsafePipelineRedirection(tokens, allowInputRedirection)
  ) {
    return false;
  }
  const argv = shellArgvWithoutRedirections(tokens);
  if (!argv) return false;
  if (argv[0] === 'tee') return validTeePassThroughArgv(argv);
  return argv[0] === 'cat' && validCatPassThroughArgv(argv);
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

function pipelineConsumesHeredoc(
  commandLine: string,
  delimiter: string,
  consumes: (tokens: string[]) => boolean = shellConsumesStdinProgram
): boolean {
  const executableHeader = executableShellSource(commandLine);
  for (const stages of shellPipelineGroups(executableHeader)) {
    for (let index = 0; index < stages.length - 1; index += 1) {
      const producer = pipelineStageTokens(stages[index]);
      const ownsHeredoc =
        producer != null && commandConsumesHeredocInput(producer, delimiter);
      if (!ownsHeredoc) continue;
      if (!isPipelinePassThrough(producer, true)) continue;
      if (pipelineReachesConsumer(stages, index, consumes)) {
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
    sshDisablesStdin(tokens) ||
    sshHasOpaqueConfig(tokens) ||
    shellStdinRedirections(tokens).length > 0
  ) {
    return false;
  }
  const effective = sshEffectivePayload(tokens);
  if (!effective.valid || effective.implicitShell) return false;
  const consumer = executableShellSegments(effective.payload)[0];
  return !!(consumer && shellConsumesStdinProgram(consumer));
}

function sshConsumesStdinProgramWithReachabilityShortCircuit(
  tokens: string[]
): boolean {
  if (
    tokens[0] !== 'ssh' ||
    isSshQueryInvocation(tokens) ||
    sshDisablesStdin(tokens) ||
    sshHasOpaqueConfig(tokens) ||
    shellStdinRedirections(tokens).length > 0
  ) {
    return false;
  }
  const effective = sshEffectivePayload(tokens);
  if (!effective.valid || effective.implicitShell) return false;
  const consumer = executableShellSegments(effective.payload)[0];
  return !!(
    consumer && shellConsumesStdinProgramWithReachabilityShortCircuit(consumer)
  );
}

function pipelineFeedsRemoteShell(
  commandLine: string,
  delimiter: string,
  consumes: (tokens: string[]) => boolean = sshConsumesStdinProgram
): boolean {
  const executableHeader = executableShellSource(commandLine);
  for (const stages of shellPipelineGroups(executableHeader)) {
    for (let index = 0; index < stages.length - 1; index += 1) {
      const producer = pipelineStageTokens(stages[index]);
      const ownsHeredoc =
        producer != null && commandConsumesHeredocInput(producer, delimiter);
      if (!ownsHeredoc) continue;
      if (!isPipelinePassThrough(producer, true)) continue;
      if (pipelineReachesConsumer(stages, index, consumes)) {
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
  return commandSubstitutionBodies(executableShellSource(commandLine), true).some((body) => {
    const segments = executableShellSegments(body);
    return (
      segments.some((segment) => shellConsumesHeredoc(segment, delimiter)) ||
      pipelineConsumesHeredoc(body, delimiter)
    );
  });
}

function nestedReachabilityShortCircuitCommandConsumesHeredoc(
  commandLine: string,
  delimiter: string
): boolean {
  return commandSubstitutionBodies(executableShellSource(commandLine), true).some(
    (body) => {
      const segments = executableShellSegments(body);
      return (
        segments.some(
          (segment) =>
            shellRunsWithReachabilityShortCircuit(segment) &&
            shellConsumesHeredoc(segment, delimiter)
        ) ||
        pipelineConsumesHeredoc(
          body,
          delimiter,
          shellConsumesStdinProgramWithReachabilityShortCircuit
        )
      );
    }
  );
}

// Static durable-state proof is deliberately sparse. Beyond this point,
// reparsing a shared heredoc header for every opener is both expensive and
// unnecessary: declining the claim is safer than inferring execution from an
// adversarial shell program.
const MAX_STATIC_HEREDOC_PROOFS = 128;

function heredocExecutableBodies(
  command: string,
  failClosedOnReachabilityShortCircuitLists = false
): string[] {
  const bodies: string[] = [];
  const heredocs = shellHeredocs(command);
  if (heredocs.length > MAX_STATIC_HEREDOC_PROOFS) return bodies;
  for (const heredoc of heredocs) {
    const identityCommandLine = heredoc.identityCommandLine;
    const identityDelimiter = shellHeredocIdentityDelimiter(
      heredoc.openerIndex
    );
    const headerSegments = executableShellSegments(identityCommandLine);
    const consumedDirectly = headerSegments.some((segment) =>
      shellConsumesHeredoc(segment, identityDelimiter)
    );
    const consumedByPipeline = pipelineConsumesHeredoc(
      identityCommandLine,
      identityDelimiter
    );
    const consumedByNestedCommand = nestedCommandConsumesHeredoc(
      identityCommandLine,
      identityDelimiter
    );
    if (consumedDirectly || consumedByPipeline || consumedByNestedCommand) {
      const consumedWithReachabilityShortCircuit =
        headerSegments.some(
          (segment) =>
            shellRunsWithReachabilityShortCircuit(segment) &&
            shellConsumesHeredoc(segment, identityDelimiter)
        ) ||
        pipelineConsumesHeredoc(
          identityCommandLine,
          identityDelimiter,
          shellConsumesStdinProgramWithReachabilityShortCircuit
        ) ||
        nestedReachabilityShortCircuitCommandConsumesHeredoc(
          identityCommandLine,
          identityDelimiter
        );
      if (
        !failClosedOnReachabilityShortCircuitLists ||
        !consumedWithReachabilityShortCircuit ||
        executableShellListSegments(heredoc.body).length === 1
      ) {
        bodies.push(heredoc.body);
      }
    } else if (!heredoc.quoted) {
      // An unquoted delimiter enables command substitution even when the
      // receiving command treats the heredoc as plain data (for example cat).
      bodies.push(
        ...commandSubstitutionBodies(heredoc.body, false, false, true)
      );
    }
  }
  return bodies;
}

function remoteHeredocBodies(
  command: string,
  failClosedOnReachabilityShortCircuitLists = false
): string[] {
  const bodies: string[] = [];
  const heredocs = shellHeredocs(command);
  if (heredocs.length > MAX_STATIC_HEREDOC_PROOFS) return bodies;
  for (const heredoc of heredocs) {
    const identityCommandLine = heredoc.identityCommandLine;
    const identityDelimiter = shellHeredocIdentityDelimiter(
      heredoc.openerIndex
    );
    const executableHeader = executableShellSource(identityCommandLine);
    const contexts = [
      executableHeader,
      ...commandSubstitutionBodies(executableHeader, true),
    ];
    const bodyIsOneStage =
      executableShellListSegments(heredoc.body).length === 1;
    if (
      pipelineFeedsRemoteShell(identityCommandLine, identityDelimiter) &&
      (!failClosedOnReachabilityShortCircuitLists ||
        bodyIsOneStage ||
        !pipelineFeedsRemoteShell(
          identityCommandLine,
          identityDelimiter,
          sshConsumesStdinProgramWithReachabilityShortCircuit
        ))
    ) {
      bodies.push(heredoc.body);
    }
    for (const context of contexts) {
      const headerSegments = executableShellSegments(context);
      for (const segment of headerSegments) {
        if (segment[0] !== 'ssh') continue;
        if (
          isSshQueryInvocation(segment) ||
          sshDisablesStdin(segment) ||
          sshHasOpaqueConfig(segment)
        ) {
          continue;
        }
        if (!commandConsumesHeredocInput(segment, identityDelimiter)) {
          continue;
        }
        const effective = sshEffectivePayload(segment);
        if (!effective.valid) continue;
        if (effective.implicitShell) continue;
        const payloadSegments = executableShellSegments(effective.payload);
        const firstPayloadSegment = payloadSegments[0];
        const consumesBody =
          firstPayloadSegment != null &&
          (shellConsumesStdinProgram(firstPayloadSegment) ||
            shellConsumesHeredoc(firstPayloadSegment, identityDelimiter) ||
            firstPayloadSegment.every((token) => token.startsWith('<<')));
        const consumesBodyWithReachabilityShortCircuit =
          firstPayloadSegment != null &&
          (shellConsumesStdinProgramWithReachabilityShortCircuit(
            firstPayloadSegment
          ) ||
            (shellRunsWithReachabilityShortCircuit(firstPayloadSegment) &&
              shellConsumesHeredoc(firstPayloadSegment, identityDelimiter)));
        if (
          consumesBody &&
          (!failClosedOnReachabilityShortCircuitLists ||
            bodyIsOneStage ||
            !consumesBodyWithReachabilityShortCircuit)
        ) {
          bodies.push(heredoc.body);
        }
      }
    }
  }
  return bodies;
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
  if (!clean.startsWith('/')) return false;
  // Repeated separators and `.` components preserve absolute path identity.
  // Deliberately retain `..`: resolving it lexically can cross a symlink and
  // turn a real durable path into an invented discard-device alias.
  const normalized = `/${clean
    .split('/')
    .filter((component) => component !== '' && component !== '.')
    .join('/')}`;
  return /^(?:\/dev\/(?:null|zero|stdin|stdout|stderr|fd\/\d+)|\/proc\/self\/fd\/\d+)$/.test(
    normalized
  );
}

function isExternalStatePath(path: string): boolean {
  const clean = path.replace(/[)}]+$/, '');
  if (clean.split('/').includes('..')) return false;
  return /^(?:\/etc\/|\/usr\/local\/etc\/|\/var\/(?:lib|opt)\/|\/opt\/|\/srv\/|\/(?:home\/[^/]+|Users\/[^/]+)\/\.config\/)/.test(
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

/** Editors prove only that an interactive editing surface opened and exited;
 * a zero exit status does not prove the user saved a change. Keep these for
 * risky/attempt evidence, but not durable-state classification by themselves. */
function isInteractiveEditorInvocation(tokens: string[]): boolean {
  const head = tokens[0];
  if (head === 'sudoedit') return true;
  if (
    head === 'crontab' &&
    tokens.slice(1).some((token) => token === '--edit' || /^-[^-]*e/.test(token))
  ) {
    return true;
  }
  if (head === 'systemctl') {
    return (
      firstSubcommand(
        tokens,
        SYSTEMCTL_OPTIONS_WITH_ARGUMENT,
        SYSTEMCTL_COMBINED_OPTION_WITH_ARGUMENT
      ).command === 'edit'
    );
  }
  if (head === 'kubectl' || head === 'k') {
    return (
      firstSubcommand(tokens, KUBECTL_OPTIONS_WITH_ARGUMENT).command === 'edit'
    );
  }
  return false;
}

/** A successful interactive coreutils invocation does not prove that the user
 * confirmed a filesystem change. Reject any interactive spelling even when a
 * later option such as `-f` could override it: fully modeling each utility's
 * order-dependent option precedence would make this sparse proof brittle, and
 * a false negative is safer than claiming durable state from a declined prompt.
 */
function hasInteractiveFilesystemOption(tokens: readonly string[]): boolean {
  const head = tokens[0];
  if (!['cp', 'ln', 'mv', 'rm'].includes(head)) return false;
  for (let index = 1; index < tokens.length; index += 1) {
    const option = tokens[index];
    if (option === '--') break;
    if (
      option === '--interactive' ||
      option.startsWith('--interactive=')
    ) {
      return true;
    }
    if (
      /^-[^-]/.test(option) &&
      (option.slice(1).includes('i') ||
        (head === 'rm' && option.slice(1).includes('I')))
    ) {
      return true;
    }
  }
  return false;
}

function transferOperands(
  tokens: string[],
  head: string
): { targetDirectory?: string; operands: string[] } {
  let targetDirectory: string | undefined;
  const operands: string[] = [];
  let endOfOptions = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!endOfOptions && token === '--') {
      endOfOptions = true;
      continue;
    }
    if (
      !endOfOptions &&
      (token === '-t' || token === '--target-directory')
    ) {
      targetDirectory = tokens[index + 1];
      index += 1;
      continue;
    }
    if (!endOfOptions && token.startsWith('--target-directory=')) {
      targetDirectory = token.slice('--target-directory='.length);
      continue;
    }
    if (
      !endOfOptions &&
      head === 'mv' &&
      (token === '-S' || token === '--suffix')
    ) {
      index += 1;
      continue;
    }
    if (
      !endOfOptions &&
      head === 'mv' &&
      (token.startsWith('-S') || token.startsWith('--suffix='))
    ) {
      continue;
    }
    if (!endOfOptions && token.startsWith('-')) continue;
    operands.push(token);
  }
  return { ...(targetDirectory == null ? {} : { targetDirectory }), operands };
}

function isRemoteFilesystemMutationSegment(
  tokens: string[],
  writePaths: readonly string[]
): boolean {
  // The shell opens redirections before invoking the command, so even a
  // successful `--help`/`--version` invocation can create or truncate a file.
  if (writePaths.some((path) => !isDiscardOutputPath(path))) {
    return true;
  }
  if (isNonMutatingInvocation(tokens)) return false;
  if (hasInteractiveFilesystemOption(tokens)) return false;
  const head = tokens[0];
  if (head === 'sudoedit') return tokens.length > 1;
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
    return (
      SYSTEMCTL_PERSISTENT_MUTATIONS.has(verb) ||
      ['reload', 'restart', 'start', 'stop'].includes(verb)
    );
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
  return false;
}

/** Local mutations count only when their destination is outside the checkout;
 * relative and scratch writes remain ordinary implementation work. */
function isExternalFilesystemMutationSegment(
  tokens: string[],
  writePaths: readonly string[]
): boolean {
  if (writePaths.some(isExternalStatePath)) return true;
  if (isNonMutatingInvocation(tokens)) return false;
  const head = tokens[0];
  if (hasInteractiveFilesystemOption(tokens)) return false;
  if (head === 'sudoedit') {
    return tokens.slice(1).some(isExternalStatePath);
  }
  if (['cp', 'install', 'ln', 'mv'].includes(head)) {
    const { targetDirectory, operands } = transferOperands(tokens, head);
    if (head === 'mv' && operands.some(isExternalStatePath)) return true;
    if (targetDirectory != null) return isExternalStatePath(targetDirectory);
    // One-operand `ln TARGET` creates the link in the current directory using
    // TARGET's basename. An external TARGET is therefore a source, not an
    // external destination.
    if (head === 'ln' && operands.length < 2) return false;
    const destination = operands.at(-1);
    return destination != null && isExternalStatePath(destination);
  }
  if (
    ['chmod', 'chown', 'mkdir', 'rm', 'rmdir', 'touch', 'truncate'].includes(
      head
    )
  ) {
    const optionsWithArgument =
      head === 'touch'
        ? new Set(['-d', '--date', '-r', '--reference', '-t', '--time'])
        : head === 'truncate'
          ? new Set(['-r', '--reference', '-s', '--size'])
          : head === 'chmod' || head === 'chown'
            ? new Set(['--reference'])
            : head === 'mkdir'
              ? new Set(['-m', '--mode', '-Z', '--context'])
              : new Set<string>();
    const targets: string[] = [];
    let endOfOptions = false;
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (!endOfOptions && token === '--') {
        endOfOptions = true;
        continue;
      }
      if (!endOfOptions && token.startsWith('-')) {
        if (optionsWithArgument.has(token)) index += 1;
        continue;
      }
      targets.push(token);
    }
    return targets.some(isExternalStatePath);
  }
  if (
    head !== 'sed' ||
    !optionPrefix(tokens).some(
      (token) => /^-[^-]*i/.test(token) || /^--in-place(?:=|$)/.test(token)
    )
  ) {
    return false;
  }
  const files: string[] = [];
  let hasExplicitExpression = false;
  let endOfOptions = false;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!endOfOptions && token === '--') {
      endOfOptions = true;
      continue;
    }
    if (!endOfOptions && (token === '-e' || token === '--expression')) {
      hasExplicitExpression = true;
      index += 1;
      continue;
    }
    if (!endOfOptions && (token === '-f' || token === '--file')) {
      hasExplicitExpression = true;
      index += 1;
      continue;
    }
    if (
      !endOfOptions &&
      (token.startsWith('--expression=') || token.startsWith('--file='))
    ) {
      hasExplicitExpression = true;
      continue;
    }
    if (
      !endOfOptions &&
      ((token.startsWith('-e') && token.length > 2) ||
        (token.startsWith('-f') && token.length > 2))
    ) {
      hasExplicitExpression = true;
      continue;
    }
    if (!endOfOptions && token.startsWith('-')) continue;
    files.push(token);
  }
  if (!hasExplicitExpression) files.shift();
  return files.some(isExternalStatePath);
}

function isSshRemoteMutation(tokens: string[], depth: number): boolean {
  if (
    isSshQueryInvocation(tokens) ||
    sshRunsInBackground(tokens) ||
    sshHasOpaqueConfig(tokens)
  ) {
    return false;
  }
  const effective = sshEffectivePayload(tokens);
  if (!effective.valid || effective.implicitShell) return false;
  return isRemotePayloadMutation(effective.payload, depth + 1);
}

function isKubectlRemoteMutation(tokens: string[], depth: number): boolean {
  if (tokens[0] !== 'kubectl' && tokens[0] !== 'k') return false;
  const { command: verb, index } = firstSubcommand(
    tokens,
    KUBECTL_OPTIONS_WITH_ARGUMENT
  );
  if (verb === 'cp') {
    const positionals: string[] = [];
    const optionsWithArgument = new Set([
      ...KUBECTL_OPTIONS_WITH_ARGUMENT,
      '-c',
      '--container',
      '--retries',
    ]);
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const token = tokens[cursor];
      if (token === '--') {
        positionals.push(...tokens.slice(cursor + 1));
        break;
      }
      if (token.startsWith('-')) {
        if (optionsWithArgument.has(token)) cursor += 1;
        continue;
      }
      positionals.push(token);
    }
    const destination = positionals[1]?.replace(/[)}]+$/, '');
    return !!destination && !/^[A-Za-z]:[\\/]/.test(destination) && destination.includes(':');
  }
  if (verb !== 'exec') return false;
  const separator = tokens.indexOf('--', index + 1);
  if (separator < 0 || separator === tokens.length - 1) return false;
  return isRemotePayloadMutation(
    shellSourceFromArgv(tokens.slice(separator + 1)),
    depth + 1
  );
}

function isRemoteStateSegment(tokens: string[], depth: number): boolean {
  if (isNonMutatingInvocation(tokens)) return false;
  if (isKubectlRemoteMutation(tokens, depth)) return true;
  if (isDeploymentMutationSegment(tokens)) return true;
  const head = tokens[0];
  if (head === 'sudoedit') {
    return tokens
      .slice(1)
      .some((token) => /^(?:\/etc\/|\/usr\/local\/etc\/|\/var\/|\/opt\/|\/srv\/)/.test(token));
  }
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
    const transfer = validatedRemoteTransfer(tokens);
    const removesExternalSource = !!(
      transfer?.removesSources &&
      transfer.sources.some(
        (source) => isRemoteLocation(source) || isExternalStatePath(source)
      )
    );
    return !!(
      transfer &&
      (removesExternalSource ||
        (isRemoteLocation(transfer.destination) &&
          !isRemoteDiscardLocation(transfer.destination)))
    );
  }
  return head === 'ssh' && isSshRemoteMutation(tokens, depth);
}

function isExternalConfigOutput(path: string | null): boolean {
  if (!path) return false;
  const clean = path.replace(/[)}]+$/, '');
  return isExternalStatePath(clean) && CONFIG_OUTPUT_RE.test(clean);
}

function isGeneratedConfigSegment(
  tokens: string[],
  writePaths: readonly string[]
): boolean {
  if (hasHelpFlag(tokens)) return false;
  const [head, verb] = tokens;
  if (
    ['envsubst', 'gomplate', 'jinja2', 'mustache', 'ytt'].includes(head) ||
    (head === 'kustomize' && verb === 'build') ||
    (head === 'helm' &&
      firstSubcommand(tokens, HELM_OPTIONS_WITH_ARGUMENT).command === 'template')
  ) {
    return [...writePaths, ...commandOutputPaths(tokens)].some(
      isExternalConfigOutput
    );
  }
  if (head === 'cp' || head === 'install') {
    const { targetDirectory, operands: positional } = transferOperands(
      tokens,
      head
    );
    if (targetDirectory != null) return false;
    return (
      positional.length >= 2 &&
      CONFIG_SOURCE_RE.test(positional[positional.length - 2]) &&
      isExternalConfigOutput(positional[positional.length - 1])
    );
  }
  if (!['sed', 'perl', 'python', 'node'].includes(head)) return false;
  return writePaths.some(isExternalConfigOutput);
}

function isGeneratedConfigPipeline(command: string): boolean {
  for (const stages of shellPipelineGroups(command)) {
    for (let index = 0; index < stages.length - 1; index += 1) {
      const producer = pipelineStageTokens(stages[index]);
      const consumer = pipelineStageTokens(stages[index + 1]);
      if (!producer || !consumer || consumer[0] !== 'tee') continue;
      const templateProducer =
        (producer[0] === 'cat' &&
          producer.slice(1).some((token) => CONFIG_SOURCE_RE.test(token))) ||
        ['envsubst', 'gomplate', 'jinja2', 'mustache', 'ytt'].includes(
          producer[0]
        );
      if (
        index + 1 === stages.length - 1 &&
        templateProducer &&
        !isNonMutatingInvocation(consumer) &&
        definiteShellWritePaths(stages[index + 1], stages[index]).some(
          isExternalConfigOutput
        )
      ) {
        return true;
      }
    }
  }
  return false;
}

function isDurableInstallSegment(tokens: string[]): boolean {
  if (isNonMutatingInvocation(tokens) || hasShortHelpFlag(tokens)) return false;
  const [head, verb, subverb] = tokens;
  if (['apt-get', 'apt'].includes(head)) {
    if (firstSubcommand(tokens, APT_OPTIONS_WITH_ARGUMENT).command !== 'install') {
      return false;
    }
    if (
      optionPrefix(tokens).some((token) =>
        [
          '-s',
          '-d',
          '--simulate',
          '--just-print',
          '--no-act',
          '--download-only',
        ].includes(token) || /^-(?=[A-Za-z]*[sd])[qmyufbVsd]+$/.test(token)
      )
    ) {
      return false;
    }
    return true;
  }
  if (head === 'brew') return firstSubcommand(tokens).command === 'install';
  if (head === 'systemctl') {
    if (hasSystemctlShortHelpFlag(tokens) || tokens.includes('--runtime')) {
      return false;
    }
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
      .map(riskyShellCommandPayload)
      .filter((payload): payload is string => payload !== null),
    ...heredocExecutableBodies(rawCommand, true),
  ];
}

/** Classify a payload while retaining the fact that its filesystem is remote. */
function isRemotePayloadMutation(command: string, depth: number): boolean {
  return (
    depth < 4 &&
    classifyDurableCommandInternal(command, depth + 1, true) != null
  );
}

interface StatusProvenShellCommand {
  executableSource: string;
  finalTokens: string[];
  finalStage: string;
  producerStage?: string;
}

/** A successful aggregate Bash result proves only the final foreground stage
 * of one pipeline. General lists/boolean chains can exit successfully before a
 * later mutation, while substitutions and expansions can synthesize query
 * argv. This intentionally sparse proof favors missed signals over claims that
 * the observed success cannot substantiate. */
function statusProvenShellCommand(
  command: string
): StatusProvenShellCommand | null {
  const executableSource = executableShellSource(command);
  const groups = shellPipelineGroups(executableSource);
  if (groups.length !== 1) return null;
  const stages = groups[0];
  const pipelineNegated =
    /^\s*(?:time(?:\s+-\S+)*\s+)?!/.test(stages[0] ?? '');
  const finalStage = stages.at(-1);
  if (
    !finalStage ||
    pipelineNegated ||
    hasUnprovenShellExpansion(finalStage) ||
    /^\s*!/.test(finalStage) ||
    /&[ \t\r\n]*$/.test(executableSource)
  ) {
    return null;
  }
  const finalTokens = pipelineStageTokens(finalStage);
  const finalArgv = finalTokens
    ? shellArgvWithoutRedirections(finalTokens, true)
    : null;
  return finalArgv
    ? {
        executableSource,
        finalTokens: finalArgv,
        finalStage,
        producerStage: stages.at(-2),
      }
    : null;
}

function classifyDurableCommandInternal(
  command: string,
  depth: number,
  remoteFilesystem = false
): DurableCommandKind | null {
  if (
    depth >= 4 ||
    hasMalformedShellRedirection(command)
  ) {
    return null;
  }
  const executable = executableShellSource(command).trim();
  const grouped = /^\(([\s\S]*)\)$/.exec(executable);
  if (grouped) {
    return classifyDurableCommandInternal(
      grouped[1],
      depth + 1,
      remoteFilesystem
    );
  }
  const proven = statusProvenShellCommand(command);
  if (!proven) return null;
  const { executableSource, finalTokens, finalStage, producerStage } = proven;
  const writePaths = definiteShellWritePaths(finalStage, producerStage);
  if (
    isInteractiveEditorInvocation(finalTokens) &&
    !writePaths.some((path) => !isDiscardOutputPath(path))
  ) {
    return null;
  }
  if (isRemoteStateSegment(finalTokens, depth)) {
    return 'remote-state';
  }
  if (
    finalTokens[0] === 'ssh' &&
    remoteHeredocBodies(command).some((body) =>
      isRemotePayloadMutation(body, depth + 1)
    )
  ) {
    return 'remote-state';
  }
  if (
    isGeneratedConfigSegment(finalTokens, writePaths) ||
    isGeneratedConfigPipeline(executableSource)
  ) {
    return 'generated-config';
  }
  if (
    (remoteFilesystem &&
      isRemoteFilesystemMutationSegment(finalTokens, writePaths)) ||
    isExternalFilesystemMutationSegment(finalTokens, writePaths)
  ) {
    return 'remote-state';
  }
  if (isDurableInstallSegment(finalTokens)) return 'multi-step-install';
  const shellPayload = shellCommandPayload(finalTokens);
  if (shellPayload != null) {
    const nestedKind = classifyDurableCommandInternal(
      shellPayload,
      depth + 1,
      remoteFilesystem
    );
    if (nestedKind) return nestedKind;
  }
  if (shellReadsProgramFromStdin(finalTokens)) {
    for (const body of heredocExecutableBodies(command)) {
      const nestedKind = classifyDurableCommandInternal(
        body,
        depth + 1,
        remoteFilesystem
      );
      if (nestedKind) return nestedKind;
    }
  }
  return null;
}

/** Classify a full Bash command before its body is stripped from bulk data. */
export function classifyDurableCommand(
  command: string
): DurableCommandKind | null {
  if (command.length > MAX_STATIC_SHELL_COMMAND_LENGTH) return null;
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

// ── Edit/MultiEdit format-churn metrics (#2507) ─────────────────────────────
// Resource boundaries for the analysis — bounds, not semantic limits. Past
// them the call is marked `truncated` and unanalyzed hunks are never
// classified (fail closed), mirroring the static-shell analysis barrier. The
// per-TRANSCRIPT budget exists because per-call caps reset on every call: a
// session repeatedly rewriting large files must not buy unbounded split/trim
// work during ingest.
const MAX_EDIT_CHURN_HUNKS = 100;
const MAX_EDIT_CHURN_CHARS_PER_CALL = 1_000_000;
const MAX_EDIT_CHURN_TRANSCRIPT_CHARS = 8 * 1024 * 1024;
const MAX_EDIT_CHURN_CALLS_PER_TRANSCRIPT = 2_048;

/** Running per-transcript analysis budget, owned by one parseToolUsage run. */
interface EditChurnTranscriptBudget {
  chars: number;
  calls: number;
  exhausted: boolean;
}

/** Per-line-trimmed, blank-dropped line sequence — the formatting-only basis. */
function trimmedNonblankLines(s: string): string[] {
  const out: string[] = [];
  for (const line of s.split('\n')) {
    const t = line.trim();
    if (t !== '') out.push(t);
  }
  return out;
}

/**
 * Conservative multiline-literal guard: a hunk containing a template-literal
 * backtick, a triple-quoted string, or a heredoc marker may carry whitespace
 * that IS the runtime value (indentation inside the literal), so trim-identical
 * lines do not prove a semantic no-op there. Such hunks are never classified
 * formatting-only (fail closed — under-counting is the accepted direction).
 * `<<` matches heredoc-style tags including the spaced `<< EOF` form; a
 * bit-shift by an identifier (`x << width`) therefore also disqualifies its
 * hunk — accepted, since under-counting is the safe direction and shifts by
 * numeric literals remain unaffected. Rust-style raw strings (`r"…"`/`r#"…"#`),
 * C++ raw strings (`R"(…)"`), and an escaped line continuation (`\` at end of
 * line — a C/C++ string or macro spanning lines) are guarded for the same
 * reason.
 */
const MULTILINE_LITERAL_MARKER = /`|'''|"""|<<[-~]?\s*["']?[A-Za-z_]|\b[rR]#*"|\\\r?\n/;

/**
 * A hunk is formatting-only when the strings differ but their ordered nonblank
 * lines are identical after per-line trim: pure reindentation, trailing-space,
 * blank-line, and line-ending churn. Any internal (semantic-space) or content
 * change — including line splits/joins — breaks the sequence equality and
 * disqualifies the hunk, as does any potential multiline string literal whose
 * leading whitespace is part of the runtime value.
 *
 * Edge-line hardening: an Edit `old_string` can start or end MID-line, so its
 * first/last lines' edge whitespace is not provably indentation. Single-line
 * hunks (edge-whitespace-only by definition) are never formatting-only, and a
 * changed first/last line that carries a quote character is disqualified —
 * the slice could cut through a string literal whose whitespace is value.
 * Interior lines are whole lines by construction, so trim is sound there.
 */
function isFormattingOnlyHunk(oldS: string, newS: string): boolean {
  if (oldS === newS) return false; // a no-op is not churn
  if (!oldS.includes('\n') && !newS.includes('\n')) return false; // single-line
  if (MULTILINE_LITERAL_MARKER.test(oldS) || MULTILINE_LITERAL_MARKER.test(newS)) {
    return false;
  }
  const oldRaw = oldS.split('\n');
  const newRaw = newS.split('\n');
  for (const [i, j] of [
    [0, 0],
    [oldRaw.length - 1, newRaw.length - 1],
  ]) {
    if (oldRaw[i] !== newRaw[j] && /["']/.test(oldRaw[i] + newRaw[j])) {
      return false;
    }
  }
  const a = trimmedNonblankLines(oldS);
  const b = trimmedNonblankLines(newS);
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function rawLineCount(s: string): number {
  return s.length === 0 ? 0 : s.split('\n').length;
}

/**
 * Derive compact formatting-churn metrics from a raw Edit/MultiEdit input
 * before distillation drops the `old_string`/`new_string` bodies (#2507).
 * Counts and sizes only — no source text survives into the ToolCall. Malformed
 * input (missing/non-string hunk fields, non-array `edits`) suppresses the
 * whole call fail-closed rather than emitting a partial claim. Write is
 * excluded: with no local pre-image, formatting-vs-content is unknowable.
 */
function deriveEditFormatChurn(
  toolName: unknown,
  rawInput: unknown,
  budget: EditChurnTranscriptBudget
): Pick<ToolCall, 'editFormatChurn'> | Record<string, never> {
  if (
    (toolName !== 'Edit' && toolName !== 'MultiEdit') ||
    !rawInput ||
    typeof rawInput !== 'object'
  ) {
    return {};
  }
  const metrics: EditFormatChurn = {
    hunks: 0,
    formattingOnlyHunks: 0,
    lines: 0,
    formattingOnlyLines: 0,
    chars: 0,
    formattingOnlyChars: 0,
  };
  // Transcript-level barrier: once the running budget is spent, later calls
  // carry an explicit zero-hunk truncated marker (an analysis boundary the
  // consumers suppress), never a silent "no churn" claim.
  if (budget.exhausted || budget.calls >= MAX_EDIT_CHURN_CALLS_PER_TRANSCRIPT) {
    budget.exhausted = true;
    metrics.truncated = true;
    return { editFormatChurn: metrics };
  }
  budget.calls += 1;
  const src = rawInput as Record<string, unknown>;
  // Iterate the raw hunk entries directly — materializing a normalized pair
  // array first would walk an arbitrarily large `edits` array before the
  // resource boundary below could stop the work.
  let entries: readonly unknown[];
  if (toolName === 'Edit') {
    entries = [src];
  } else {
    if (!Array.isArray(src.edits) || src.edits.length === 0) return {};
    entries = src.edits;
  }
  for (const entry of entries) {
    const hunk = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
    const oldS = hunk?.old_string;
    const newS = hunk?.new_string;
    if (typeof oldS !== 'string' || typeof newS !== 'string') return {};
    const hunkChars = oldS.length + newS.length;
    if (budget.chars + hunkChars > MAX_EDIT_CHURN_TRANSCRIPT_CHARS) {
      budget.exhausted = true;
      metrics.truncated = true;
      break;
    }
    if (
      metrics.hunks >= MAX_EDIT_CHURN_HUNKS ||
      metrics.chars + hunkChars > MAX_EDIT_CHURN_CHARS_PER_CALL
    ) {
      metrics.truncated = true;
      break;
    }
    budget.chars += hunkChars;
    metrics.hunks += 1;
    metrics.chars += hunkChars;
    const hunkLines = Math.max(rawLineCount(oldS), rawLineCount(newS));
    metrics.lines += hunkLines;
    if (isFormattingOnlyHunk(oldS, newS)) {
      metrics.formattingOnlyHunks += 1;
      metrics.formattingOnlyLines += hunkLines;
      metrics.formattingOnlyChars += hunkChars;
    }
  }
  return { editFormatChurn: metrics };
}

export function parseToolUsage(
  text: string,
  fileName: string,
  options: {
    /**
     * Derive `editFormatChurn` metrics (#2507). Default on for ingest /
     * recommendation / upload parsing; the live-session poll path opts out —
     * it reads only error/retry patterns and must not pay the churn budget on
     * every poll.
     */
    editFormatChurn?: boolean;
  } = {}
): ToolUsageData | null {
  const deriveChurn = options.editFormatChurn !== false;
  const sessionId = fileName.replace(/\.jsonl$/, '');
  let staticShellChars = 0;
  let staticShellSyntaxChars = 0;
  let staticShellCalls = 0;
  let staticShellBudgetExhausted = false;
  const editChurnBudget: EditChurnTranscriptBudget = {
    chars: 0,
    calls: 0,
    exhausted: false,
  };

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
        let commandSignals: Partial<ToolCall> = {};
        if (block.name === 'Bash' && input.command) {
          const nextChars = staticShellChars + input.command.length;
          if (
            staticShellBudgetExhausted ||
            staticShellCalls >= MAX_STATIC_SHELL_CALLS_PER_TRANSCRIPT ||
            nextChars > MAX_STATIC_SHELL_TRANSCRIPT_CHARS
          ) {
            staticShellBudgetExhausted = true;
            commandSignals = boundedShellAnalysisBarrier(input.command);
          } else {
            const commandSyntaxChars = shellSyntaxCharCount(
              input.command,
              MAX_STATIC_SHELL_SYNTAX_CHARS
            );
            const nextSyntaxChars =
              staticShellSyntaxChars + commandSyntaxChars;
            if (
              nextSyntaxChars > MAX_STATIC_SHELL_TRANSCRIPT_SYNTAX_CHARS
            ) {
              staticShellBudgetExhausted = true;
              commandSignals = boundedShellAnalysisBarrier(input.command);
            } else {
              staticShellChars = nextChars;
              staticShellSyntaxChars = nextSyntaxChars;
              staticShellCalls += 1;
              commandSignals = deriveBashCommandSignals(input.command);
            }
          }
        }
        const call: ToolCall = {
          timestamp: entry.timestamp ?? '',
          toolName: block.name ?? 'unknown',
          input,
          toolUseId,
          isError: pending !== undefined ? pending.isError : null,
          resultBytes: pending !== undefined ? pending.resultBytes : 0,
          ...commandSignals,
          ...deriveLeaveBehindStructure(block.name, block.input),
          ...(deriveChurn
            ? deriveEditFormatChurn(block.name, block.input, editChurnBudget)
            : {}),
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
  if (
    call.commandAnalysisTruncated === true &&
    typeof call.commandPreview === 'string' &&
    call.commandPreview.length > 0
  ) {
    return call.commandPreview;
  }
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
  if (call.commandAnalysisComplete === true) return [];
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

/**
 * Date.parse is permissive; require a real RFC3339 calendar instant.
 *
 * Exported as the single strict reading of a {@link ToolCall.timestamp}. A
 * `ToolCall` carries `entry.timestamp ?? ''` (see the parse loop above), so an
 * absent transcript timestamp reaches consumers as `''` — and `Date.parse`
 * would happily turn other partial strings (`'2026'`, `'Jun 19 2026'`) into an
 * instant. Any consumer deciding whether a call is DATED must use this, so
 * "dated" means the same thing everywhere instead of being re-derived, more
 * loosely, per caller.
 */
export function rfc3339TimestampMs(timestamp: string): number | null {
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

/** Retain the neighboring pipeline/list operator while testing one viable
 * invocation. `matchesUnpiped` needs the preceding pipe, and the standalone
 * `cd` rule needs to see an operator that follows its source. */
function bypassDetectionSources(command: string): string[] {
  const { list, eligible } = analyzedShellList(command);
  return list.flatMap((segment, index) => {
    if (!eligible[index]) return [];
    const preceding = list[index - 1]?.followingOperator;
    const prefix = preceding === '|' || preceding === '|&' ? `${preceding} ` : '';
    const suffix = segment.followingOperator
      ? ` ${segment.followingOperator}`
      : '';
    return [`${prefix}${segment.source.trim()}${suffix}`];
  });
}

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

// eslint-disable-next-line no-control-regex -- control characters are exactly what this rejects
const CONTROL_CHARACTER_RE = /[\u0000-\u001f\u007f]/;

const WORKFLOW_GIT_SEGMENT_RE =
  /\bgit\s+(?:stash\b|switch\b|checkout\b|reflog\b|cherry-pick\b|merge\s+--ff-only\b)/;

function workflowGitEvidence(tokens: string[]): string | null {
  if (tokens[0] !== 'git') return null;
  const verb = tokens[1];
  if (!verb) return null;
  if (
    tokens
      .slice(1)
      .some((token) => ['--help', '-h', '--version'].includes(token))
  ) {
    return null;
  }
  const safeArgument = (argument: string | undefined) =>
    argument && /^[A-Za-z0-9._/@:+-]+$/.test(argument)
      ? argument
      : argument == null
        ? null
        : '<arg>';
  let evidence: string | null = null;
  if (verb === 'stash') {
    const operation = tokens[2];
    if (operation == null || operation.startsWith('-')) {
      evidence = 'git stash';
    } else if (['push', 'save', 'pop', 'apply'].includes(operation)) {
      evidence = `git stash ${operation}`;
    }
  } else if (verb === 'switch' || verb === 'checkout') {
    const args = tokens.slice(2);
    if (args.length === 0) return null;
    if (
      verb === 'checkout' &&
      (args.includes('--') ||
        args.some((argument) =>
          /^(?:--ours|--theirs|--patch|-p|--pathspec-from-file(?:=|$)|--pathspec-file-nul)$/.test(
            argument
          )
        ))
    ) {
      return null;
    }
    const positionals = args.filter(
      (argument) => !argument.startsWith('-') || argument === '-'
    );
    // `git checkout <tree-ish> <pathspec>` restores a path from a tree and
    // does not move HEAD. Fail closed on every multi-positional checkout;
    // branch-creation forms with extra operands are less important here than
    // avoiding a fabricated shared-checkout incident.
    if (verb === 'checkout') {
      if (positionals.length !== 1) return null;
      const [checkoutTarget] = positionals;
      const checkoutComponents = checkoutTarget.split('/');
      const previousCheckoutTarget = /^@\{-\d+\}$/.test(checkoutTarget);
      const unambiguousPathspec =
        /^(?:\.{1,2}(?:\/|$)|\/|:)/.test(checkoutTarget) ||
        checkoutTarget.endsWith('/') ||
        checkoutTarget.endsWith('.') ||
        checkoutTarget.includes('..') ||
        checkoutTarget.includes('//') ||
        checkoutTarget.includes(':') ||
        checkoutTarget === '@' ||
        (checkoutTarget.includes('@{') && !previousCheckoutTarget) ||
        checkoutComponents.some(
          (component) =>
            component.startsWith('.') || component.endsWith('.lock')
        ) ||
        checkoutTarget.includes('*') ||
        checkoutTarget.includes('?') ||
        checkoutTarget.includes('[') ||
        checkoutTarget.includes('\\') ||
        CONTROL_CHARACTER_RE.test(checkoutTarget) ||
        /\s/.test(checkoutTarget);
      if (unambiguousPathspec) return null;
    }
    const positional = positionals[0] ?? null;
    const target = safeArgument(positional ?? undefined);
    if (target) evidence = `git ${verb} ${target}`;
  } else if (verb === 'reflog') {
    const operation = tokens[2];
    if (operation == null || operation === 'show') {
      evidence = `git reflog${operation === 'show' ? ' show' : ''}`;
    }
  } else if (verb === 'cherry-pick') {
    // Fail closed on option/control parsing. A directly supplied revision or
    // range is the only compact proof that this invocation attempted recovery.
    const target = tokens[2] === '--' ? tokens[3] : tokens[2];
    if (target && !target.startsWith('-')) {
      evidence = `git cherry-pick ${safeArgument(target)}`;
    }
  } else if (verb === 'merge' && tokens[2] === '--ff-only') {
    const target = tokens[3];
    if (target && !target.startsWith('-')) {
      evidence = `git merge --ff-only ${safeArgument(target)}`;
    }
  }
  return evidence && WORKFLOW_GIT_SEGMENT_RE.test(evidence) ? evidence : null;
}

function appendGitUndoFilePaths(tokens: string[], paths: string[]): void {
  if (tokens[0] !== 'git') return;
  const verb = tokens[1];
  const separator = tokens.indexOf('--', 2);
  const prefix = tokens.slice(2, separator < 0 ? tokens.length : separator);
  const candidates =
    separator < 0 ? tokens.slice(2) : tokens.slice(separator + 1);
  if (verb === 'restore') {
    if (
      (prefix.some((token) => token === '-S' || token === '--staged') &&
        !prefix.some((token) => token === '-W' || token === '--worktree')) ||
      (separator < 0 && candidates.some((token) => token.startsWith('-')))
    ) return;
  } else if (
    verb !== 'checkout' ||
    (separator < 0 &&
      (candidates.length !== 1 ||
        !/^(?:\/|\.\.?[\\/]|[A-Za-z]:[\\/])/.test(candidates[0])))
  ) return;
  if (
    candidates.some(
      (path) =>
        path.length > 1024 ||
        CONTROL_CHARACTER_RE.test(path) ||
        /(?:^:\(|[$`*?[\]{}])/.test(path)
    )
  ) return;
  for (const path of candidates) {
    if (paths.push(path) >= MAX_COMMAND_GIT_SEGMENTS) return;
  }
}

function commandGitSegments(
  command: string,
  depth = 0,
  undoFilePaths?: string[]
): string[] {
  const evidence: string[] = [];
  const push = (segments: readonly string[]) => {
    for (const segment of segments) {
      if (evidence.length >= MAX_COMMAND_GIT_SEGMENTS) return;
      evidence.push(segment);
    }
  };
  const { list, eligible } = analyzedShellList(command);
  // Aggregate Bash success cannot prove which arm of a boolean/background
  // list ran (`true || git stash` succeeds without running git). A preceding
  // shell control such as `exit` or `exec` can likewise make a later semicolon
  // segment unreachable. Workflow evidence is an execution-order claim, so
  // use the same conservative reachability boundary as risky-action analysis.
  if (
    list.length === 0 ||
    list.some(
      ({ followingOperator }) =>
        followingOperator != null &&
        RISKY_UNCERTAIN_LIST_OPERATORS.has(followingOperator)
    )
  ) {
    return evidence;
  }
  const structuralHeads = new Set([
    '{',
    '}',
    'case',
    'do',
    'done',
    'elif',
    'else',
    'esac',
    'fi',
    'for',
    'if',
    'in',
    'select',
    'then',
    'until',
    'while',
    '[[',
    ']]',
  ]);
  let reachabilityUnproven = false;
  let undoReachabilityUnproven = false;
  for (let index = 0; index < list.length; index += 1) {
    const { source } = list[index];
    const head = rawExecutableShellTokens(source)[0];
    const blocksFollowing =
      list.length > 1 && riskyListSegmentCanChangeReachability(source);
    if (blocksFollowing) {
      undoReachabilityUnproven = true;
      if (!structuralHeads.has(head ?? '')) reachabilityUnproven = true;
    }
    if (reachabilityUnproven || !eligible[index]) continue;
    const executableSource = executableShellSource(source);
    const executableSegments = executableShellSegments(source);
    if (
      depth < 4 &&
      !/\$\{|\$\(\(|\$\[/.test(executableSource)
    ) {
      // Substitutions execute while the outer argv is being formed, before its
      // command word. Keep that execution order for the detector state machine.
      for (const body of commandSubstitutionBodies(executableSource)) {
        push(commandGitSegments(body, depth + 1));
      }
    }
    for (const tokens of executableSegments) {
      const projected = workflowGitEvidence(tokens);
      if (projected) push([projected]);
      if (!undoReachabilityUnproven && undoFilePaths) {
        appendGitUndoFilePaths(tokens, undoFilePaths);
      }
      if (depth < 4) {
        const payload = shellCommandPayload(tokens);
        if (payload != null) push(commandGitSegments(payload, depth + 1));
      }
    }
    if (evidence.length >= MAX_COMMAND_GIT_SEGMENTS) break;
  }
  return evidence;
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

/** Candidate source units whose own redirections are proven to let their
 * command run. Individual stages cover direct hazards; complete viable
 * pipelines retain cross-stage hazards such as `curl | sh`. */
function dangerousCandidateSources(command: string): string[] {
  const { list, eligible } = analyzedShellList(command);
  const candidates = list.flatMap(({ source }, index) =>
    eligible[index] ? [source] : []
  );
  let pipeline: string[] = [];
  const flushPipeline = () => {
    if (pipeline.length > 1) candidates.push(pipeline.join(' | '));
    pipeline = [];
  };
  for (let index = 0; index < list.length; index += 1) {
    const segment = list[index];
    if (!eligible[index]) {
      flushPipeline();
      continue;
    }
    pipeline.push(segment.source);
    if (segment.followingOperator !== '|' && segment.followingOperator !== '|&') {
      flushPipeline();
    }
  }
  flushPipeline();
  return candidates;
}

/** Inspect only bodies proven to execute. This is attempt/risk evidence, not a
 * durable-state success proof: substitutions and remote shells can fail while
 * the aggregate outer command still exits zero. */
function hasUnprovenDynamicArgv(command: string): boolean {
  // Parentheses that wrap a whole command are execution syntax, not argv
  // expansion. Keep them available to the attempt detector while retaining the
  // stricter durable-state rule for every other expansion-bearing surface.
  const ungrouped = command.replace(/^\s*\(+\s*/, '').replace(/\s*\)+\s*$/, '');
  return hasUnprovenShellExpansion(ungrouped);
}

const RISKY_UNCERTAIN_LIST_OPERATORS = new Set([
  '&',
  '&&',
  '||',
  ';;',
  ';&',
  ';;&',
]);

const RISKY_LIST_CONTROL_HEADS = new Set([
  '.',
  'alias',
  'break',
  'builtin',
  'case',
  'continue',
  'coproc',
  'declare',
  'do',
  'done',
  'elif',
  'else',
  'enable',
  'esac',
  'eval',
  'exec',
  'exit',
  'export',
  'fi',
  'for',
  'function',
  'hash',
  'if',
  'kill',
  'logout',
  'readonly',
  'return',
  'select',
  'set',
  'shopt',
  'source',
  'suspend',
  'time',
  'then',
  'trap',
  'typeset',
  'unalias',
  'unset',
  'until',
  'while',
]);

function riskyListSegmentCanChangeReachability(source: string): boolean {
  const skeleton = executableShellSkeleton(source).trim();
  if (!skeleton) return true;
  const executable = executableShellSegments(source)[0];
  const executableHead = executable?.[0];
  // A standalone assignment can alter PATH, shell options, or a later dynamic
  // argv. An assignment prefix on a real executable is scoped to that command
  // and does not poison the next list stage.
  if (
    /^[A-Za-z_][A-Za-z0-9_]*=/.test(skeleton) &&
    (executable == null || executableHead === ':')
  ) {
    return true;
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*\(\s*\)\s*\{/.test(skeleton)) {
    return true;
  }
  // A group split across list entries has reachability semantics the sparse
  // parser cannot prove. A self-contained `(kubectl ...)` remains eligible.
  if (
    /^(?:(?:!\s+)|(?:time(?:\s+-\S+)*\s+))*[({]/.test(skeleton) &&
    !/[)}]$/.test(skeleton)
  ) {
    return true;
  }
  const withoutAssignments = skeleton.replace(
    /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:''|""|\S+)\s+)*/,
    ''
  );
  const head = /^(?:!\s+)?([A-Za-z_.][A-Za-z0-9_.-]*)\b/.exec(
    withoutAssignments
  )?.[1];
  return (
    (executableHead != null && /[$`{}()[\]*?~]/.test(executableHead)) ||
    (head != null && RISKY_LIST_CONTROL_HEADS.has(head)) ||
    (executableHead != null && RISKY_LIST_CONTROL_HEADS.has(executableHead))
  );
}

function riskyActionPatternForCommand(
  command: string,
  depth = 0
): string | null {
  if (hasMalformedShellRedirection(command)) return null;
  const executableSource = executableShellSource(command);
  const { list, eligible } = analyzedShellList(command);
  if (
    list.length === 0 ||
    list.some(
      ({ followingOperator }) =>
        followingOperator != null &&
        RISKY_UNCERTAIN_LIST_OPERATORS.has(followingOperator)
    ) ||
    (list.length > 1 &&
      list.some(({ source }) => riskyListSegmentCanChangeReachability(source)))
  ) {
    return null;
  }

  // Dynamic argv is scoped to its owning top-level stage. An unrelated
  // `echo "$TOKEN"` must not erase a later static deployment signal. Re-run
  // the central detector over eligible sources so its category priority stays
  // stable regardless of source order.
  const eligibleDirectSources = list.flatMap(({ source }, index) => {
    if (!eligible[index]) return [];
    const detected = detectRiskyActionPatternName(source);
    return detected != null &&
      (!hasUnprovenDynamicArgv(source) ||
        detected === 'secret exposure or mutation')
      ? [source]
      : [];
  });
  const direct =
    eligibleDirectSources.length > 0
      ? detectRiskyActionPatternName(eligibleDirectSources.join('\n'))
      : null;
  if (direct || depth >= 4) return direct;
  const segments = executableShellSegments(command);
  // Substitutions inside parameter/arithmetic expansion can be skipped at
  // runtime (`${x:-$(...)}`, arithmetic short-circuiting). The lightweight
  // parser cannot prove their reachability, so fail the nested claim closed.
  const hasConditionalExpansion = /\$\{|\$\(\(|\$\[/.test(executableSource);
  const bodies = new Set(
    hasConditionalExpansion
      ? []
      : [
          ...nestedExecutableBodies(command, executableSource, segments),
          ...remoteHeredocBodies(command, true),
        ]
  );
  for (const body of bodies) {
    const nested = riskyActionPatternForCommand(body, depth + 1);
    if (nested) return nested;
  }
  return null;
}

export function deriveBashCommandSignals(command: string): Partial<ToolCall> {
  if (
    command.length > MAX_STATIC_SHELL_COMMAND_LENGTH ||
    shellSyntaxCharCount(command, MAX_STATIC_SHELL_SYNTAX_CHARS) >
      MAX_STATIC_SHELL_SYNTAX_CHARS
  ) {
    return boundedShellAnalysisBarrier(command);
  }
  // A shell syntax error aborts parsing of the entire list before any later
  // dangerous/risky/durable token executes. Check the raw lexical surface
  // before normalization can discard redirect-only operators, and persist an
  // analyzed negative so stripped bulk rows never fall back to raw matching.
  if (hasMalformedShellRedirection(command)) {
    return {
      commandAnalysisComplete: true,
      commandFingerprint: bashCommandFingerprint(command),
      commandPreview: commandPreview(command),
      ...(command.includes('.claude')
        ? { commandMentionsClaudePath: true }
        : {}),
    };
  }
  const bypassSources = bypassDetectionSources(command);
  const bypassMatches = BYPASS_DEFS.filter((def) =>
    bypassSources.some((source) => def.test(source))
  );
  const bypassCategories = bypassMatches.map((def) => def.category);
  const bypassAliases: Partial<Record<BypassCategory, string[]>> = {};
  for (const def of bypassMatches) {
    const aliases = [
      ...new Set(
        bypassSources.flatMap((source) => def.observedAliases(source))
      ),
    ];
    if (aliases.length > 0) bypassAliases[def.category] = aliases;
  }
  // Match dangerous patterns against the executable skeleton (#2039): `rm -rf`
  // (and peers) inside heredoc bodies, quoted literals, or inline-script source
  // (`node -e "…"`) are not executed deletions and must not be flagged.
  const dangerousSources = dangerousCandidateSources(command).map((source) => ({
    source,
    skeleton: executableShellSkeleton(source),
  }));
  const dangerous = COMMAND_DANGEROUS_PATTERNS.find((pattern) =>
    dangerousSources.some(({ skeleton }) => pattern.test(skeleton))
  );
  const dangerousSource = dangerous
    ? dangerousSources.find(({ skeleton }) => dangerous.test(skeleton))?.source
    : undefined;
  const riskyAction = riskyActionPatternForCommand(command);
  const durableKind = classifyDurableCommand(command);
  const unquotedHeredocBodies = shellHeredocs(command)
    .filter((heredoc) => !heredoc.quoted)
    .map((heredoc) => heredoc.body);
  const allLeaveBehindMutationPaths =
    leaveBehindMutationPathsFromExecutableShell(
      leaveBehindEligibleShellSource(command),
      unquotedHeredocBodies
    );
  const leaveBehindMutationPaths = allLeaveBehindMutationPaths.slice(
    0,
    MAX_PERSISTED_LEAVE_BEHIND_MUTATION_PATHS
  );
  const head = commandHead(command);
  const undoFilePaths: string[] = [];
  const gitSegments = commandGitSegments(command, 0, undoFilePaths);
  return {
    commandAnalysisComplete: true,
    commandFingerprint: bashCommandFingerprint(command),
    commandPreview: commandPreview(command),
    ...(leaveBehindMutationPaths.length > 0
      ? {
          leaveBehindMutationPaths,
          ...(leaveBehindMutationPaths.length === 1
            ? { leaveBehindMutationPath: leaveBehindMutationPaths[0] }
            : {}),
        }
      : {}),
    ...(allLeaveBehindMutationPaths.length > leaveBehindMutationPaths.length
      ? { leaveBehindMutationPathsTruncated: true }
      : {}),
    ...(durableKind ? { commandDurableKind: durableKind } : {}),
    ...(head ? { commandHead: head } : {}),
    ...(head && commandHeadIsPermissionPrefix(command, head)
      ? { commandHeadIsPermissionPrefix: true }
      : {}),
    ...(gitSegments.length > 0 ? { commandGitSegments: gitSegments } : {}),
    ...(undoFilePaths.length > 0
      ? { commandUndoFilePaths: undoFilePaths }
      : {}),
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
              ? rmRfCertainty(dangerousSource ?? command)
              : dangerousPatternCertainty(dangerous.name),
          commandDangerousFragment: dangerousFragment(
            dangerousSource ?? command,
            dangerous.name
          ),
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
      if (!token && cmd !== null && call.commandAnalysisTruncated !== true) {
        token = commandHead(cmd);
      }
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
 *
 * `succeededTimestamp` is the NEWEST occurrence's, not the first: it is what
 * dates the aggregate, and "when was this path last seen to work" is the
 * question a consumer asks of it. Keeping the first would date a correction
 * re-confirmed yesterday by the day it was first observed, understating its
 * freshness and demoting a live fact.
 */
export function aggregateCorrections(facts: CorrectionFact[]): AggregatedCorrection[] {
  const agg = new Map<string, AggregatedCorrection>();
  for (const f of facts) {
    const key = `${f.category}\0${f.failed}\0${f.succeeded}`;
    const prev = agg.get(key);
    if (prev) {
      prev.occurrences += 1;
      const prevMs = parseIsoInstantMs(prev.succeededTimestamp);
      const nextMs = parseIsoInstantMs(f.succeededTimestamp);
      if (nextMs !== undefined && (prevMs === undefined || nextMs > prevMs)) {
        prev.succeededTimestamp = f.succeededTimestamp;
      }
    } else agg.set(key, { ...f, occurrences: 1 });
  }
  return Array.from(agg.values()).sort((a, b) => b.occurrences - a.occurrences);
}
