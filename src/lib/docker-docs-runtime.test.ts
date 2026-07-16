import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('runtime image doc-graph inputs (#2380)', () => {
  it('copies root markdown and docs into the zero-node_modules runtime stage', () => {
    const dockerfile = readFileSync(join(process.cwd(), 'Dockerfile'), 'utf8');

    expect(dockerfile).toMatch(/COPY --from=build \/app\/\*\.md \.\//);
    expect(dockerfile).toContain('COPY --from=build /app/docs ./docs');
  });
});
