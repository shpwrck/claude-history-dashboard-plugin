import { describe, expect, it } from 'vitest';
import {
  LEAVE_BEHIND_CONTRACT,
  leaveBehindStateScope,
  validateLeaveBehindArtifact,
} from './leave-behind';

const PATH = 'docs/runbooks/app-production/README.md';

const CONFORMANT = `---
leave-behind: v1
state-scope: app-production
status: current
---
# App production

## Operability

### State and access

The kubeconfig reference is documented in the team password manager; no credential value is copied here.

### Template map

\`deploy/app.yaml.tmpl\` -> \`/etc/app/app.yaml\`

### Re-run

Run \`./scripts/install-app.sh\`; it converges an existing installation without duplicating state.

### Verify and recover

Run \`./scripts/verify-app.sh\`; use \`./scripts/remove-app.sh\` to return to the prior state.

## Decision log

### Decisions

The generated config remains outside the checkout so rotation does not rewrite the template.

### How to drive it

Edit the source template, re-run the installer, execute verification, and record a new decision here.
`;

describe('leave-behind artifact contract (#2313)', () => {
  it('accepts the one-artifact marker with both required halves at tracked HEAD', () => {
    const result = validateLeaveBehindArtifact({
      required: true,
      path: PATH,
      content: CONFORMANT,
      trackedAtHead: true,
    });

    expect(result).toEqual({
      status: 'conformant',
      stateScope: 'app-production',
      errors: [],
    });
    expect(LEAVE_BEHIND_CONTRACT.version).toBe('v1');
  });

  it('rejects Markdown-only section bodies and a mapping with empty endpoints', () => {
    const content = CONFORMANT
      .replace(
        'The kubeconfig reference is documented in the team password manager; no credential value is copied here.',
        '---'
      )
      .replace('`deploy/app.yaml.tmpl` -> `/etc/app/app.yaml`', '->')
      .replace(
        'Run `./scripts/install-app.sh`; it converges an existing installation without duplicating state.',
        '***'
      )
      .replace(
        'Run `./scripts/verify-app.sh`; use `./scripts/remove-app.sh` to return to the prior state.',
        '___'
      )
      .replace(
        'The generated config remains outside the checkout so rotation does not rewrite the template.',
        '[ ]'
      )
      .replace(
        'Edit the source template, re-run the installer, execute verification, and record a new decision here.',
        '[]()'
      );

    expect(
      validateLeaveBehindArtifact({
        required: true,
        path: PATH,
        content,
        trackedAtHead: true,
      })
    ).toMatchObject({
      status: 'invalid',
      errors: [
        'empty-state-and-access',
        'empty-template-map',
        'empty-re-run',
        'empty-verify-and-recover',
        'empty-decisions',
        'empty-how-to-drive-it',
      ],
    });
  });

  it('accepts canonical absolute tool paths without accepting prefixed relative or traversal paths', () => {
    expect(
      leaveBehindStateScope(
        '/workspace/repo/docs/runbooks/app-production/README.md'
      )
    ).toBe('app-production');
    expect(
      leaveBehindStateScope(
        'C:\\workspace\\repo\\docs\\runbooks\\app-production\\README.md'
      )
    ).toBe('app-production');
    expect(
      leaveBehindStateScope(
        'prefix/docs/runbooks/app-production/README.md'
      )
    ).toBeNull();
    expect(
      leaveBehindStateScope(
        '/workspace/repo/docs/runbooks/../app-production/README.md'
      )
    ).toBeNull();

    expect(
      validateLeaveBehindArtifact({
        required: true,
        path: '/workspace/repo/docs/runbooks/app-production/README.md',
        content: CONFORMANT,
        trackedAtHead: true,
      })
    ).toMatchObject({
      status: 'conformant',
      stateScope: 'app-production',
      errors: [],
    });
  });

  it('rejects an operability-only artifact', () => {
    const content = CONFORMANT.slice(0, CONFORMANT.indexOf('## Decision log'));

    expect(
      validateLeaveBehindArtifact({
        required: true,
        path: PATH,
        content,
        trackedAtHead: true,
      }).errors
    ).toContain('missing-decision-log');
  });

  it('rejects a decision-log-only artifact', () => {
    const content = CONFORMANT.replace(
      /## Operability[\s\S]*?(?=## Decision log)/,
      ''
    );

    expect(
      validateLeaveBehindArtifact({
        required: true,
        path: PATH,
        content,
        trackedAtHead: true,
      }).errors
    ).toContain('missing-operability');
  });

  it('rejects required subsections placed under the wrong half', () => {
    const content = CONFORMANT.replace(
      '## Decision log\n\n### Decisions',
      '### Decisions'
    ).replace(
      '### How to drive it',
      '## Decision log\n\n### How to drive it'
    );

    expect(
      validateLeaveBehindArtifact({
        required: true,
        path: PATH,
        content,
        trackedAtHead: true,
      }).errors
    ).toContain('invalid-section-order');
  });

  it('does not treat headings hidden in code fences or HTML comments as rendered structure', () => {
    const body = CONFORMANT.slice(CONFORMANT.indexOf('# App production'));
    const uninterruptedBody = body.replace(/\n\n/g, '\n');
    const declarationBody = uninterruptedBody.replace(/>/g, 'to');
    for (const hiddenBody of [
      `# Placeholder\n\n\`\`\`markdown\n${body}\n\`\`\``,
      `# Placeholder\n\n\`\`\`markdown\n\`\`\`sh\n${body}\n\`\`\``,
      `# Placeholder\n\n\`\`\`markdown\n\`\`\`\u00a0\n${body}\n\`\`\``,
      `# Placeholder\n\n<!--\n${body}\n-->`,
      `# Placeholder\n\n<pre>\n${body}\n</pre>`,
      `# Placeholder\n\n<div>\n${uninterruptedBody}\n</div>`,
      `# Placeholder\n\n<table>\n<tr><td>\n${uninterruptedBody}\n</td></tr>\n</table>`,
      `# Placeholder\n\n<?tool\n${uninterruptedBody}\n?>`,
      `# Placeholder\n\n<!DECLARATION\n${declarationBody}\n>`,
      `# Placeholder\n\n<![CDATA[\n${uninterruptedBody}\n]]>`,
      `# Placeholder\n\n<x-widget>\n${uninterruptedBody}\n</x-widget>\n`,
      `# Placeholder\n\n<x-widget data-value=">">\n${uninterruptedBody}\n</x-widget>\n`,
      `# Placeholder\n\n${body.replace(/^(#{1,6}\s)/gm, '<!-- -->$1')}`,
      `# Placeholder\n\n${body.replace(
        /^(#{1,6}\s.*)$/gm,
        'ordinary paragraph <!--\n-->$1'
      )}`,
    ]) {
      const content = CONFORMANT.replace(body, hiddenBody);
      const result = validateLeaveBehindArtifact({
        required: true,
        path: PATH,
        content,
        trackedAtHead: true,
      });

      expect(result.errors).toContain('missing-operability');
      expect(result.errors).toContain('missing-decision-log');
    }

    const frontmatterHidden = `---
leave-behind: v1
state-scope: app-production
status: current
${body}
---
# Placeholder`;
    const frontmatterResult = validateLeaveBehindArtifact({
      required: true,
      path: PATH,
      content: frontmatterHidden,
      trackedAtHead: true,
    });
    expect(frontmatterResult.errors).toContain('missing-operability');
    expect(frontmatterResult.errors).toContain('missing-decision-log');
  });

  it('preserves literal HTML-comment syntax inside fenced section content', () => {
    const content = CONFORMANT.replace(
      'The kubeconfig reference is documented in the team password manager; no credential value is copied here.',
      '```text\n<!-- literal template opener\n```'
    );

    expect(
      validateLeaveBehindArtifact({
        required: true,
        path: PATH,
        content,
        trackedAtHead: true,
      })
    ).toEqual({
      status: 'conformant',
      stateScope: 'app-production',
      errors: [],
    });
  });

  it('does not leak comment state from literal syntax inside raw HTML blocks', () => {
    const content = CONFORMANT.replace(
      '# App production',
      '# App production\n\n<script>const marker = "<!--";</script>'
    );

    expect(
      validateLeaveBehindArtifact({
        required: true,
        path: PATH,
        content,
        trackedAtHead: true,
      })
    ).toEqual({
      status: 'conformant',
      stateScope: 'app-production',
      errors: [],
    });
  });

  it('does not require an artifact when no material durable state changed', () => {
    expect(
      validateLeaveBehindArtifact({
        required: false,
        path: undefined,
        content: undefined,
        trackedAtHead: false,
      })
    ).toEqual({ status: 'not-required', errors: [] });
  });

  it('rejects traversal, scope-marker drift, placeholders, and untracked files', () => {
    const traversal = validateLeaveBehindArtifact({
      required: true,
      path: 'docs/runbooks/../app-production/README.md',
      content: CONFORMANT,
      trackedAtHead: true,
    });
    expect(traversal.errors).toContain('invalid-path');

    const wrongScope = validateLeaveBehindArtifact({
      required: true,
      path: PATH,
      content: CONFORMANT.replace('state-scope: app-production', 'state-scope: other'),
      trackedAtHead: true,
    });
    expect(wrongScope.errors).toContain('state-scope-mismatch');

    const placeholder = validateLeaveBehindArtifact({
      required: true,
      path: PATH,
      content: CONFORMANT.replace(
        'Edit the source template, re-run the installer, execute verification, and record a new decision here.',
        'TBD'
      ),
      trackedAtHead: true,
    });
    expect(placeholder.errors).toContain('empty-how-to-drive-it');

    const untracked = validateLeaveBehindArtifact({
      required: true,
      path: PATH,
      content: CONFORMANT,
      trackedAtHead: false,
    });
    expect(untracked.errors).toContain('not-tracked-at-head');
  });

  it.each(['- TBD', '> TODO', 'TODO:'])(
    'rejects the Markdown-wrapped placeholder %s',
    (placeholderText) => {
      const content = CONFORMANT.replace(
        'Edit the source template, re-run the installer, execute verification, and record a new decision here.',
        placeholderText
      );

      expect(
        validateLeaveBehindArtifact({
          required: true,
          path: PATH,
          content,
          trackedAtHead: true,
        }).errors
      ).toContain('empty-how-to-drive-it');
    }
  );

  it('rejects non-exact frontmatter markers', () => {
    const nested = CONFORMANT.replace(
      'leave-behind: v1\nstate-scope: app-production\nstatus: current',
      'marker:\n  leave-behind: v1\n  state-scope: app-production\n  status: current'
    );
    const duplicate = CONFORMANT.replace(
      'leave-behind: v1',
      'leave-behind: v1\nleave-behind : v2'
    );
    const compactScalars = CONFORMANT.replace(
      'leave-behind: v1\nstate-scope: app-production\nstatus: current',
      'leave-behind:v1\nstate-scope:app-production\nstatus:current'
    );
    const quotedDuplicate = CONFORMANT.replace(
      'leave-behind: v1',
      'leave-behind: v1\n"leave-behind": v2'
    );
    const extraKey = CONFORMANT.replace(
      'status: current',
      'status: current\nowner: platform'
    );

    for (const content of [
      nested,
      duplicate,
      compactScalars,
      quotedDuplicate,
      extraKey,
    ]) {
      const result = validateLeaveBehindArtifact({
        required: true,
        path: PATH,
        content,
        trackedAtHead: true,
      });
      expect(result.status).toBe('invalid');
      expect(result.errors).toContain('invalid-version');
    }
  });

  it('rejects deeply wrapped placeholders without quadratic rescanning', () => {
    const wrappers = '**'.repeat(20_000);
    const content = CONFORMANT.replace(
      'Edit the source template, re-run the installer, execute verification, and record a new decision here.',
      `${wrappers}TBD${wrappers}`
    );

    expect(
      validateLeaveBehindArtifact({
        required: true,
        path: PATH,
        content,
        trackedAtHead: true,
      }).errors
    ).toContain('empty-how-to-drive-it');
  }, 1_000);

  it.each([
    '# Reset',
    '## Other',
    '#\tReset',
    '##\tOther',
    '#',
    '##',
  ])('rejects a %s ancestor boundary before a required subsection', (boundary) => {
    const content = CONFORMANT.replace(
      '### State and access',
      `${boundary}\n### State and access`
    );
    const result = validateLeaveBehindArtifact({
      required: true,
      path: PATH,
      content,
      trackedAtHead: true,
    });

    expect(result.status).toBe('invalid');
    expect(result.errors).toContain('invalid-section-order');
  });

  it('does not treat mixed space-tab indented code lines as structural headings', () => {
    const content = CONFORMANT
      .replace('## Operability', ' \t## Operability')
      .replace('## Decision log', ' \t## Decision log');
    const result = validateLeaveBehindArtifact({
      required: true,
      path: PATH,
      content,
      trackedAtHead: true,
    });

    expect(result.status).toBe('invalid');
    expect(result.errors).toContain('missing-operability');
    expect(result.errors).toContain('missing-decision-log');
  });

  it('does not erase non-CommonMark Unicode indentation before parsing headings', () => {
    const content = CONFORMANT
      .replace('## Operability', '\u00a0## Operability')
      .replace('## Decision log', '\u00a0## Decision log');
    const result = validateLeaveBehindArtifact({
      required: true,
      path: PATH,
      content,
      trackedAtHead: true,
    });

    expect(result.status).toBe('invalid');
    expect(result.errors).toContain('missing-operability');
    expect(result.errors).toContain('missing-decision-log');
  });

  it.each([
    ['Setext H2', 'Other\n-----'],
    ['Setext H1', 'Reset\n====='],
  ])('rejects a required subsection re-parented by an intervening %s', (_label, boundary) => {
    const content = CONFORMANT.replace(
      '### State and access',
      `${boundary}\n\n### State and access`
    );
    const result = validateLeaveBehindArtifact({
      required: true,
      path: PATH,
      content,
      trackedAtHead: true,
    });

    expect(result.status).toBe('invalid');
    expect(result.errors).toContain('invalid-section-order');
  });

  it('rejects NBSP-normalized frontmatter lookalikes', () => {
    const lookalikes = [
      CONFORMANT.replace(/^---/, '\u00a0---'),
      CONFORMANT.replace('status: current\n---', 'status: current\n\u00a0---'),
      CONFORMANT.replace('leave-behind: v1', 'leave-behind: v1\u00a0'),
    ];

    for (const content of lookalikes) {
      expect(
        validateLeaveBehindArtifact({
          required: true,
          path: PATH,
          content,
          trackedAtHead: true,
        }).status
      ).toBe('invalid');
    }
  });

  it('reports a structurally valid transcript observation as a candidate when HEAD is unknown', () => {
    expect(
      validateLeaveBehindArtifact({
        required: true,
        path: PATH,
        content: CONFORMANT,
        trackedAtHead: null,
      })
    ).toEqual({
      status: 'candidate',
      stateScope: 'app-production',
      errors: [],
    });
  });
});
