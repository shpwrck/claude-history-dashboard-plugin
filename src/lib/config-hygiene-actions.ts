import type { HygieneFinding } from './config-hygiene';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function openablePath(path: string): string {
  if (path.startsWith('~')) return `"${path.replace(/^~/, '$HOME')}"`;
  return shellQuote(path);
}

function directRemovalSnippet(finding: HygieneFinding): string | null {
  if (!finding.removalPath) return null;
  const quoted = shellQuote(finding.removalPath);
  if (finding.resourceType === 'skill' || finding.resourceType === 'plugin') {
    return `rm -rf -- ${quoted}`;
  }
  if (finding.resourceType === 'subagent' || finding.resourceType === 'command') {
    return `rm -- ${quoted}`;
  }
  return null;
}

function jsonMutationSnippet(args: {
  sourcePath: string;
  body: string;
  after?: string | null;
}): string {
  const after = args.after ? ` && ${args.after}` : '';
  return [
    `node <<'NODE'${after}`,
    "const fs = require('node:fs');",
    `const path = ${JSON.stringify(args.sourcePath)};`,
    "const data = JSON.parse(fs.readFileSync(path, 'utf8'));",
    args.body,
    "fs.writeFileSync(path, `${JSON.stringify(data, null, 2)}\\n`);",
    'NODE',
  ].join('\n');
}

export function buildConfigRemovalSnippet(
  finding: HygieneFinding
): string {
  if (finding.resourceType === 'mcpServer' && finding.sourcePath) {
    const project =
      finding.scope.kind === 'project' ? finding.scope.project : null;
    const body = project
      ? [
          `const project = ${JSON.stringify(project)};`,
          `const server = ${JSON.stringify(finding.resourceId)};`,
          'if (data.projects?.[project]?.mcpServers) {',
          '  delete data.projects[project].mcpServers[server];',
          '}',
        ].join('\n')
      : [
          `const server = ${JSON.stringify(finding.resourceId)};`,
          'if (data.mcpServers) delete data.mcpServers[server];',
          'for (const project of Object.values(data.projects ?? {})) {',
          '  if (!Array.isArray(project?.enabledMcpjsonServers)) continue;',
          '  project.enabledMcpjsonServers = project.enabledMcpjsonServers.filter((id) => id !== server);',
          '}',
        ].join('\n');
    return jsonMutationSnippet({ sourcePath: finding.sourcePath, body });
  }

  if (
    finding.resourceType === 'plugin' &&
    finding.sourcePath &&
    finding.removalPath
  ) {
    const body = [
      `const plugin = ${JSON.stringify(finding.resourceId)};`,
      `const installPath = ${JSON.stringify(finding.removalPath)};`,
      'if (Array.isArray(data.plugins?.[plugin])) {',
      '  data.plugins[plugin] = data.plugins[plugin].filter((entry) => entry?.installPath !== installPath);',
      '  if (data.plugins[plugin].length === 0) delete data.plugins[plugin];',
      '}',
    ].join('\n');
    return jsonMutationSnippet({
      sourcePath: finding.sourcePath,
      body,
      after: directRemovalSnippet(finding),
    });
  }

  return (
    directRemovalSnippet(finding) ??
    `# Open ${finding.sourcePath ?? 'the owning config file'} and remove ${finding.resourceType} ${finding.resourceId}.`
  );
}

export function buildConfigRemovalSnippetBlock(
  findings: HygieneFinding[]
): string {
  return findings.map(buildConfigRemovalSnippet).join('\n\n');
}

export function buildConfigOpenCommand(finding: HygieneFinding): string {
  const path = finding.sourcePath ?? finding.removalPath;
  if (!path) {
    return `# Locate ${finding.resourceType} ${finding.resourceId} in your Claude config.`;
  }
  return `code -g ${openablePath(path)}`;
}
