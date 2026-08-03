import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOC_GIT_TIMES_RELPATH } from './doc-git-times';
import { DOCS_MAP_RELPATH } from './parse-docs-map';

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
    expect(workflow).toContain(
      "fetch-depth: ${{ matrix.buildMode == 'server' && '0' || '1' }}"
    );
    expect(workflow).toMatch(
      /name: Generate doc git-times manifest\n\s+if: matrix\.buildMode == 'server'/
    );
    expect(workflow).toContain('doc-git-times-generate.mjs');
    expect(
      workflow.indexOf('doc-git-times-generate.mjs') < workflow.indexOf('docker build'),
      'generation must precede the image build'
    ).toBe(true);

    const deploy = readFileSync(join(process.cwd(), 'scripts', 'deploy.sh'), 'utf8');
    expect(deploy).toContain('doc-git-times-generate.mjs');
  });
});
