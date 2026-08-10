import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DOC_GIT_TIMES_RELPATH } from './doc-git-times';
import { DOCS_MAP_RELPATH } from './parse-docs-map';

interface WorkflowStep {
  name?: string;
  uses?: string;
  if?: string;
  with?: Record<string, unknown>;
  run?: string;
}

interface WorkflowDocument {
  jobs?: Record<string, { steps?: WorkflowStep[] }>;
}

const SERVER_AWARE_FETCH_DEPTH = "${{ matrix.buildMode == 'server' && '0' || '1' }}";

function publishSteps(source: string): WorkflowStep[] {
  const parsed = parse(source) as WorkflowDocument;
  const steps = parsed.jobs?.['build-and-push']?.steps;
  if (!Array.isArray(steps)) throw new Error('build-and-push job has no steps');
  return steps;
}

function publishCheckoutFetchDepth(source: string): unknown {
  const checkouts = publishSteps(source).filter((step) =>
    step.uses?.startsWith('actions/checkout@')
  );
  if (checkouts.length !== 1) {
    throw new Error(`build-and-push job has ${checkouts.length} checkout steps`);
  }
  return checkouts[0].with?.['fetch-depth'];
}

describe('runtime image doc-graph inputs (#2380)', () => {
  it('copies root markdown and docs into the zero-node_modules runtime stage', () => {
    const dockerfile = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');

    expect(dockerfile).toMatch(/COPY --from=build \/app\/\*\.md \.\//);
    expect(dockerfile).toContain('COPY --from=build /app/docs ./docs');
  });

  it('packages the versioned docs-map contract via the docs COPY (#2709)', () => {
    const dockerfile = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');

    // readDocsMap() reads <DOC_GRAPH_ROOT>/<DOCS_MAP_RELPATH>; the runtime
    // image must carry the committed declaration for the container deploy.
    // The docs/ COPY is what packages it, so the seam relpath must stay
    // inside docs/.
    expect(dockerfile).toContain('COPY --from=build /app/docs ./docs');
    expect(DOCS_MAP_RELPATH.startsWith('docs/')).toBe(true);
    expect(existsSync(join(process.cwd(), DOCS_MAP_RELPATH))).toBe(true);
  });
});

describe('packaged doc git-times manifest (#2707)', () => {
  it('rides the data/ COPY into the runtime stage', () => {
    const dockerfile = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');
    // The manifest lives under data/, so this single COPY is what packages it.
    expect(dockerfile).toContain('COPY --from=build /app/data ./data');
    expect(DOC_GIT_TIMES_RELPATH.startsWith('data/')).toBe(true);
  });

  it('is git-ignored but NOT dockerignored (in the build context, never committed)', () => {
    const gitignore = readFileSync(join(process.cwd(), '.gitignore'), 'utf8');
    expect(gitignore).toContain(`/${DOC_GIT_TIMES_RELPATH}`);

    const dockerignore = readFileSync(join(process.cwd(), '.dockerignore'), 'utf8');
    const ignored = dockerignore
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    expect(ignored).not.toContain('data');
    expect(ignored.some((line) => line.includes('doc-git-times'))).toBe(false);
    // `.git` stays OUT of the image — the manifest replaces it, not the reverse.
    expect(ignored).toContain('.git');
  });

  it('is generated before both the publish build and the local deploy build', () => {
    const workflow = readFileSync(
      join(process.cwd(), '.github', 'workflows', 'docker-publish.yml'),
      'utf8'
    );
    const steps = publishSteps(workflow);
    expect(publishCheckoutFetchDepth(workflow)).toBe(SERVER_AWARE_FETCH_DEPTH);

    const generateIndex = steps.findIndex(
      (step) =>
        step.name === 'Generate doc git-times manifest' &&
        step.if === "matrix.buildMode == 'server'" &&
        step.run?.includes('doc-git-times-generate.mjs')
    );
    const buildIndex = steps.findIndex(
      (step) =>
        step.name === 'Build and push declared image' && step.run?.includes('docker build')
    );
    expect(generateIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeGreaterThan(generateIndex);

    const deploy = readFileSync(join(process.cwd(), 'scripts', 'deploy.sh'), 'utf8');
    expect(deploy).toContain('doc-git-times-generate.mjs');
  });

  it('cannot satisfy publish checkout depth with a comment or a different job', () => {
    const commentDecoy = `
# fetch-depth: \${{ matrix.buildMode == 'server' && '0' || '1' }}
jobs:
  build-and-push:
    steps:
      - uses: actions/checkout@pinned
`;
    expect(publishCheckoutFetchDepth(commentDecoy)).toBeUndefined();

    const otherJobDecoy = `
jobs:
  plan:
    steps:
      - uses: actions/checkout@pinned
        with:
          fetch-depth: \${{ matrix.buildMode == 'server' && '0' || '1' }}
  build-and-push:
    steps:
      - uses: actions/checkout@pinned
`;
    expect(publishCheckoutFetchDepth(otherJobDecoy)).toBeUndefined();
  });
});
