import { describe, expect, it } from 'vitest';
import {
  LEAVE_BEHIND_CONTRACT,
  leaveBehindMutationPathFromExecutableShell,
  leaveBehindMutationPathsFromExecutableShell,
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

  it.each([
    '[source](https://example.test/from->to)',
    '[source](https://example.test/(hidden)->target)',
    '[source](https://example.test/hidden\\)->target)',
    '[source](https://example.test "hidden)->target")',
    '[source [nested]](https://example.test/hidden->target)',
    '[source \\]](https://example.test/hidden->target)',
    '[source `]`](https://example.test/hidden->target)',
    '<https://example.test/hidden->target>',
    '<span data-map="source->target">prose</span>',
    '[source]: https://example.test/from->to',
    '[source]: https://example.test\n"hidden -> target"',
    '[source]:\n  https://example.test/from->to',
    '[source][hidden\\]->target]\n[hidden\\]->target]: https://example.test',
    '[\nhidden -> target\n]: /url',
    '> [source]: /url "hidden -> target"',
    '- [source]: /url "hidden -> target"',
    '[source](   https://example.test\n  "hidden -> target"  )',
    '[source](https://example.test "prefix\nhidden -> target")',
    '\\`[source](https://example.test/hidden->target)`',
    '`prefix\nsource&#45;&gt;target\nsuffix`',
    '`prefix\nsource -> target\nsuffix`',
    '`source&#45;&gt;target`',
    'source-`  >target `',
    'source-` \t>target `',
    '```text\nsource&#45;&gt;target\n```',
    '```text\nsource-\\>target\n```',
    '```bad`info\n[source](https://example.test/hidden->target)\n```',
    '```text<!-- `hidden` -->\n[source](https://example.test/hidden->target)\n```',
    '    source&#45;&gt;target',
    'ordinary prose\n    [source](https://example.test/hidden->target)',
    'ordinary prose\n\t[source](https://example.test/hidden->target)',
    'ordinary prose\n    <span data-map="source->target">text</span>',
    '\u00a0\n    [source](https://example.test/hidden->target)',
    '===\n    [source](https://example.test/hidden->target)',
    'ordinary prose\n+\n    [source](https://example.test/hidden->target)',
    'ordinary prose\n*\n    [source](https://example.test/hidden->target)',
    'ordinary prose\n1.\n    [source](https://example.test/hidden->target)',
    '-\n    [source](https://example.test/hidden->target)',
    '+\n    [source](https://example.test/hidden->target)',
    '*\n    [source](https://example.test/hidden->target)',
    '1.\n    [source](https://example.test/hidden->target)',
    '2.\n    [source](https://example.test/hidden->target)',
    '- >\n    [source](https://example.test/hidden->target)',
    'ordinary prose\n1. # incidental\n    [source](https://example.test/hidden->target)',
    'ordinary prose\n2. # incidental\n    [source](https://example.test/hidden->target)',
    '<hr>\n    values[production] -> config[endpoint]',
    'source&#000000045;&#000000062;target',
    'source&#x000002D;&#x000003E;target',
    'source-&Gt;target',
    'TODO&#1114112; -> TBD&#1114112;',
  ])('rejects a template-map arrow hidden from rendered prose: %s', (mapping) => {
    const content = CONFORMANT.replace(
      '`deploy/app.yaml.tmpl` -> `/etc/app/app.yaml`',
      mapping
    );

    expect(
      validateLeaveBehindArtifact({
        required: true,
        path: PATH,
        content,
        trackedAtHead: true,
      }).errors
    ).toContain('empty-template-map');
  });

  it.each([
    'source&#45;&gt;target',
    'source&#45;&GT;target',
    'source-\\>target',
    '`[source](https://example.test/from->to)`',
    '\\\\`[source](https://example.test/from->to)`',
    'source-` >target `',
    '```text\nsource -> target\n```',
    '```text\nvalues[production] -> config[endpoint]\n```',
    '```text\n[source](https://example.test/hidden->target)\n```',
    '```text\n<span data-map="source->target">text</span>\n```',
    'ordinary prose\n```text\nvalues[production] -> config[endpoint]\n```',
    'ordinary prose\n```\n```\n    values[production] -> config[endpoint]',
    'ordinary prose\n<!-- -->\n    values[production] -> config[endpoint]',
    '---\n    values[production] -> config[endpoint]',
    '* * *\n    values[production] -> config[endpoint]',
    '_\t_\t_\n    values[production] -> config[endpoint]',
    '    source -> target',
    '    values[production] -> config[endpoint]',
    '\tvalues[production] -> config[endpoint]',
    ' \tvalues[production] -> config[endpoint]',
    '  \tvalues[production] -> config[endpoint]',
    '   \tvalues[production] -> config[endpoint]',
    '    <!-- source -> target -->',
  ])('accepts a statically rendered template-map arrow: %s', (mapping) => {
    const content = CONFORMANT.replace(
      '`deploy/app.yaml.tmpl` -> `/etc/app/app.yaml`',
      mapping
    );

    expect(
      validateLeaveBehindArtifact({
        required: true,
        path: PATH,
        content,
        trackedAtHead: true,
      })
    ).toMatchObject({ status: 'conformant', errors: [] });
  });

  it('rejects ATX-heading placeholders, including both Template map endpoints', () => {
    const content = CONFORMANT
      .replace(
        'The kubeconfig reference is documented in the team password manager; no credential value is copied here.',
        '#### TODO ####'
      )
      .replace(
        '`deploy/app.yaml.tmpl` -> `/etc/app/app.yaml`',
        '#### TODO #### -> #### TODO ####'
      )
      .replace(
        'Run `./scripts/install-app.sh`; it converges an existing installation without duplicating state.',
        '#### TODO ####'
      )
      .replace(
        'Run `./scripts/verify-app.sh`; use `./scripts/remove-app.sh` to return to the prior state.',
        '#### TODO ####'
      )
      .replace(
        'The generated config remains outside the checkout so rotation does not rewrite the template.',
        '#### TODO ####'
      )
      .replace(
        'Edit the source template, re-run the installer, execute verification, and record a new decision here.',
        '#### TODO ####'
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

  it.each([
    '#### [TODO](#) ####',
    '#### <span>TODO</span> ####',
    '#### TODO? ####',
  ])('rejects the wrapped ATX placeholder %s in every required body', (placeholder) => {
    const content = CONFORMANT
      .replace(
        'The kubeconfig reference is documented in the team password manager; no credential value is copied here.',
        placeholder
      )
      .replace(
        '`deploy/app.yaml.tmpl` -> `/etc/app/app.yaml`',
        `${placeholder} -> ${placeholder}`
      )
      .replace(
        'Run `./scripts/install-app.sh`; it converges an existing installation without duplicating state.',
        placeholder
      )
      .replace(
        'Run `./scripts/verify-app.sh`; use `./scripts/remove-app.sh` to return to the prior state.',
        placeholder
      )
      .replace(
        'The generated config remains outside the checkout so rotation does not rewrite the template.',
        placeholder
      )
      .replace(
        'Edit the source template, re-run the installer, execute verification, and record a new decision here.',
        placeholder
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

  it('rejects rendered reference-link placeholders in every required body', () => {
    const placeholderOnly = `---
leave-behind: v1
state-scope: app-production
status: current
---
# App production

[placeholder]: #

## Operability

### State and access

[TODO][placeholder]

### Template map

**[TODO][placeholder]** -> *[TODO](#)*

### Re-run

**[TODO](#)**

### Verify and recover

[TODO][placeholder]

## Decision log

### Decisions

*[TBD][placeholder]*

### How to drive it

[TODO][placeholder]
`;

    expect(
      validateLeaveBehindArtifact({
        required: true,
        path: PATH,
        content: placeholderOnly,
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

  it.each([
    '> [foo]:\n> /url',
    '- [foo]:\n  /url',
    '> [\n> foo\n> ]: /url',
  ])('does not count a container link definition as visible section prose: %s', (definition) => {
    const content = CONFORMANT.replace(
      'The kubeconfig reference is documented in the team password manager; no credential value is copied here.',
      definition
    );

    expect(
      validateLeaveBehindArtifact({
        required: true,
        path: PATH,
        content,
        trackedAtHead: true,
      }).errors
    ).toContain('empty-state-and-access');
  });

  it.each([
    '[T&#79;DO](#)',
    '[TODO](https://example.test/(hidden)tail)',
    '[TODO](https://example.test/((deeply)-hidden)tail)',
    '[TODO](https://example.test/hidden\\)tail)',
    '[TODO](https://example.test/hidden&#41;tail)',
    '[TODO](https://example.test "title (hidden)")',
    '[TODO](https://example.test/(unterminated)',
    '[TODO `]`](https://example.test/hidden)',
    '![TODO `]`](https://example.test/hidden)',
    '[TODO `]`][hidden-ref]\n\n[hidden-ref]: https://example.test/hidden',
    '&#84;&#66;&#68;',
    '&nbsp;TODO&nbsp;',
    'TODO&colon;',
    'TODO\\:',
    '<span title=">">TODO</span>',
  ])('rejects the rendered character-reference placeholder %s', (placeholder) => {
    const content = CONFORMANT.replace(
      'Edit the source template, re-run the installer, execute verification, and record a new decision here.',
      placeholder
    );
    expect(
      validateLeaveBehindArtifact({
        required: true,
        path: PATH,
        content,
        trackedAtHead: true,
      }).errors
    ).toContain('empty-how-to-drive-it');
  });

  it(
    'bounds malformed link-label code-span scanning to a single linear pass',
    { timeout: 2_000 },
    () => {
      const unmatchedBacktickRuns =
        `${'`'.repeat(64 * 1_024)}!` +
        Array.from(
          { length: 400 },
          (_, index) => '`'.repeat(index + 1)
        ).join('!');
      const content = CONFORMANT.replace(
        'Edit the source template, re-run the installer, execute verification, and record a new decision here.',
        `[TODO ${unmatchedBacktickRuns}](https://example.test/hidden)`
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

  it.each([
    [
      'dense code-span delimiter runs',
      `Visible recovery instructions ${Array.from(
        { length: 4_097 },
        () => '`!'
      ).join('')}`,
    ],
    [
      'deep inline HTML nesting',
      `${'<span>'.repeat(1_025)}Visible recovery instructions${'</span>'.repeat(1_025)}`,
    ],
    [
      'an oversized inline HTML token',
      `*<span ${'a '.repeat(9_000)}>Visible recovery instructions</span>*`,
    ],
    [
      'too many inline HTML attributes',
      `*<span ${'a '.repeat(257)}>Visible recovery instructions</span>*`,
    ],
  ])('fails the bounded Markdown proof closed for %s', (_label, boundedInput) => {
    const content = CONFORMANT.replace(
      'Edit the source template, re-run the installer, execute verification, and record a new decision here.',
      boundedInput
    );

    expect(
      validateLeaveBehindArtifact({
        required: true,
        path: PATH,
        content,
        trackedAtHead: true,
      }).errors
    ).toContain('empty-how-to-drive-it');
  });

  it.each([
    [
      'one oversized ordinary line',
      `Visible recovery instructions ${'x'.repeat(300_000)}`,
    ],
    [
      'oversized total projection across short lines',
      `${`${'visible '.repeat(25)}\n`.repeat(2_000)}recovery instructions`,
    ],
  ])('rejects %s before allocating Markdown line records', (_label, oversized) => {
    const content = CONFORMANT.replace(
      'Edit the source template, re-run the installer, execute verification, and record a new decision here.',
      oversized
    );

    expect(
      validateLeaveBehindArtifact({
        required: true,
        path: PATH,
        content,
        trackedAtHead: true,
      })
    ).toMatchObject({ status: 'invalid', errors: ['invalid-content'] });
  });

  it('does not run complete-tag regex proof over an oversized raw HTML line', () => {
    const content = CONFORMANT.replace(
      'Edit the source template, re-run the installer, execute verification, and record a new decision here.',
      `<span ${'a '.repeat(9_000)}>Visible recovery instructions</span>`
    );

    expect(
      validateLeaveBehindArtifact({
        required: true,
        path: PATH,
        content,
        trackedAtHead: true,
      }).errors
    ).toContain('empty-how-to-drive-it');
  });

  it.each([
    '*<script>hidden prose</script>*',
    '<style>hidden prose</style>',
    '<template>hidden prose</template>',
    '<textarea>hidden prose</textarea>',
    '<span hidden>hidden prose</span>',
    '<?hidden prose?>',
    '<![CDATA[hidden prose]]>',
    '*<style>hidden prose</style>*',
    '*<template>hidden prose</template>*',
    '*<textarea>hidden prose</textarea>*',
    '*<span hidden>hidden prose</span>*',
    '*<span style="display: none">hidden prose</span>*',
    '*<span style="visibility:hidden">hidden prose</span>*',
    '*<span style="content-visibility: hidden">hidden prose</span>*',
    '*<span style="color: red">hidden prose</span>*',
    '*<span aria-hidden="true">hidden prose</span>*',
    '*<span inert>hidden prose</span>*',
    '*<span hidden/>hidden prose*',
    '*<span aria-hidden="true" aria-hidden="false">hidden prose</span>*',
    '*<?hidden prose?>*',
    '*<!DOCTYPE hidden prose>*',
    '*<![CDATA[hidden prose]]>*',
    '*<![cdata[hidden prose]]>*',
    '*<iframe>hidden prose</iframe>*',
    '*<audio>hidden prose</audio>*',
    '*<video>hidden prose</video>*',
    '*<canvas>hidden prose</canvas>*',
    '*<noembed>hidden prose</noembed>*',
    '*<noframes>hidden prose</noframes>*',
    '*<title>hidden prose</title>*',
    '*<details>hidden prose</details>*',
    '*<dialog>hidden prose</dialog>*',
    '*<datalist>hidden prose</datalist>*',
    '*<meter>hidden prose</meter>*',
    '*<progress>hidden prose</progress>*',
    '*<object data="data:text/html,loaded">hidden prose</object>*',
    '*<noscript>hidden prose</noscript>*',
    '*<svg>hidden prose</svg>*',
    '*<svg><g>hidden prose</g></svg>*',
    '*<svg><switch>hidden prose</switch></svg>*',
    '*<svg><title>hidden prose</title></svg>*',
    '*<svg><desc>hidden prose</desc></svg>*',
    '*<select>hidden prose</select>*',
    '*<select><optgroup>hidden prose</optgroup></select>*',
    '*<math>hidden prose</math>*',
    '*<span popover>hidden prose</span>*',
    '*<div popover="manual">hidden prose</div>*',
  ])('does not count non-rendered HTML as ordinary section prose: %s', (html) => {
    const content = CONFORMANT.replace(
      'The kubeconfig reference is documented in the team password manager; no credential value is copied here.',
      html
    );

    expect(
      validateLeaveBehindArtifact({
        required: true,
        path: PATH,
        content,
        trackedAtHead: true,
      }).errors
    ).toContain('empty-state-and-access');
  });

  it.each([
    '*<span aria-hidden="false">visible prose</span>*',
    '*<span hidden>hidden prose</span>visible prose*',
    '*<script>"<span>"</script>visible prose*',
    '```html\n<script>visible literal code</script>\n```',
  ])('retains actually rendered or literal section prose: %s', (html) => {
    const content = CONFORMANT.replace(
      'The kubeconfig reference is documented in the team password manager; no credential value is copied here.',
      html
    );

    expect(
      validateLeaveBehindArtifact({
        required: true,
        path: PATH,
        content,
        trackedAtHead: true,
      }).errors
    ).not.toContain('empty-state-and-access');
  });

  it('rejects required bodies made only of multiple rendered placeholder rows', () => {
    const placeholderRows = '- TODO\n- TBD';
    const content = CONFORMANT
      .replace(
        'The kubeconfig reference is documented in the team password manager; no credential value is copied here.',
        placeholderRows
      )
      .replace(
        '`deploy/app.yaml.tmpl` -> `/etc/app/app.yaml`',
        'TODO&colon; -> TBD\\:'
      )
      .replace(
        'Run `./scripts/install-app.sh`; it converges an existing installation without duplicating state.',
        placeholderRows
      )
      .replace(
        'Run `./scripts/verify-app.sh`; use `./scripts/remove-app.sh` to return to the prior state.',
        placeholderRows
      )
      .replace(
        'The generated config remains outside the checkout so rotation does not rewrite the template.',
        placeholderRows
      )
      .replace(
        'Edit the source template, re-run the installer, execute verification, and record a new decision here.',
        placeholderRows
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

  it('rejects required bodies made only of combined placeholder tokens', () => {
    const content = CONFORMANT
      .replace('# App production', '# App production\n\n[later]: #')
      .replace(
        'The kubeconfig reference is documented in the team password manager; no credential value is copied here.',
        'TODO or TBD'
      )
      .replace(
        '`deploy/app.yaml.tmpl` -> `/etc/app/app.yaml`',
        'TODO or TBD -> TODO and TBD'
      )
      .replace(
        'Run `./scripts/install-app.sh`; it converges an existing installation without duplicating state.',
        'TODO / TBD'
      )
      .replace(
        'Run `./scripts/verify-app.sh`; use `./scripts/remove-app.sh` to return to the prior state.',
        '[TODO](https://example.test) [TBD][later]'
      )
      .replace(
        'The generated config remains outside the checkout so rotation does not rewrite the template.',
        'TODO, TBD'
      )
      .replace(
        'Edit the source template, re-run the installer, execute verification, and record a new decision here.',
        'TODO and TBD'
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

  it.each(['T*O*DO', 'T`O`DO', 'T~~O~~DO', 'T&#x200B;ODO'])(
    'rejects visually placeholder-only required bodies rendered as %s',
    (placeholder) => {
      const content = CONFORMANT
        .replace(
          'The kubeconfig reference is documented in the team password manager; no credential value is copied here.',
          placeholder
        )
        .replace(
          '`deploy/app.yaml.tmpl` -> `/etc/app/app.yaml`',
          `${placeholder} -> ${placeholder}`
        )
        .replace(
          'Run `./scripts/install-app.sh`; it converges an existing installation without duplicating state.',
          placeholder
        )
        .replace(
          'Run `./scripts/verify-app.sh`; use `./scripts/remove-app.sh` to return to the prior state.',
          placeholder
        )
        .replace(
          'The generated config remains outside the checkout so rotation does not rewrite the template.',
          placeholder
        )
        .replace(
          'Edit the source template, re-run the installer, execute verification, and record a new decision here.',
          placeholder
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
    }
  );

  it.each([
    'false && rm docs/runbooks/app-production/README.md || true',
    'if false; then rm docs/runbooks/app-production/README.md; fi',
    'git rm -n docs/runbooks/app-production/README.md',
    'rm --help docs/runbooks/app-production/README.md',
    'exit 0; rm docs/runbooks/app-production/README.md',
    'exec true; rm docs/runbooks/app-production/README.md',
    'command exec true; rm docs/runbooks/app-production/README.md',
    'builtin exec true; rm docs/runbooks/app-production/README.md',
    'set -n; rm docs/runbooks/app-production/README.md',
    'set -o noexec; rm docs/runbooks/app-production/README.md',
    "trap 'exit 0' DEBUG; rm docs/runbooks/app-production/README.md",
    "eval 'exec true'; rm docs/runbooks/app-production/README.md",
    "eval 'exit 0'; rm docs/runbooks/app-production/README.md",
    'source /tmp/exits-zero.sh; rm docs/runbooks/app-production/README.md',
    "alias rm='true'; rm docs/runbooks/app-production/README.md",
    '! rm docs/runbooks/app-production/README.md',
    'rm docs/runbooks/app-production/README.md | cat',
    'rm docs/runbooks/app-production/README.md |& cat',
    'rm docs/runbooks/app-production/README.md &',
    'rm docs/runbooks/app-production/README.md;;',
    'rm docs/runbooks/app-production/README.md; ;',
    'rm docs/runbooks/app-production/README.md\n;',
    'coproc true > docs/runbooks/app-production/README.md',
    'time ! true > docs/runbooks/app-production/README.md',
    'time coproc true > docs/runbooks/app-production/README.md',
    'true > >(cat > docs/runbooks/app-production/README.md )',
    'echo $(true > docs/runbooks/app-production/README.md )',
    'echo `true > docs/runbooks/app-production/README.md `',
    'rm "$(printf -- --help)" docs/runbooks/app-production/README.md',
    'rm "`printf -- --help`" docs/runbooks/app-production/README.md',
    'rm $MAYBE_OPTION docs/runbooks/app-production/README.md',
    'rm "${opt:=-i}" docs/runbooks/app-production/README.md </dev/null',
    'rm {--help,unused} docs/runbooks/app-production/README.md',
    "rm $'--help' docs/runbooks/app-production/README.md",
    "rm $'\\x2d\\x2dhelp' docs/runbooks/app-production/README.md",
    'rm $"docs/runbooks/app-production/README.md"',
    'LANG=fr_FR.UTF-8 rm $"docs/runbooks/app-production/README.md"',
    'env LANG=fr_FR.UTF-8 rm $"docs/runbooks/app-production/README.md"',
    'rm * docs/runbooks/app-production/README.md',
    'rm ? docs/runbooks/app-production/README.md',
    'rm [a-z] docs/runbooks/app-production/README.md',
    'rm docs/runbooks/app-production/README.md "${ exit 0; }"',
    "rm 'docs\\runbooks\\app-production\\README.md'",
    "true > 'docs\\runbooks\\app-production\\README.md'",
    'true > "docs\\/runbooks/app-production/README.md"',
    'rm docs/runbooks/app-production/README.md; true',
    'git rm docs/runbooks/app-production/README.md; echo $(date)',
    'command -v rm docs/runbooks/app-production/README.md',
    'command -V rm docs/runbooks/app-production/README.md',
    'env --help rm docs/runbooks/app-production/README.md',
    'env -C /tmp rm docs/runbooks/app-production/README.md',
    'env --chdir=/tmp rm docs/runbooks/app-production/README.md',
    'sudo -l rm docs/runbooks/app-production/README.md',
    'sudo -v rm docs/runbooks/app-production/README.md',
    'sudo -D /tmp rm docs/runbooks/app-production/README.md',
    'sudo --chdir=/tmp rm docs/runbooks/app-production/README.md',
    'sudo -R /tmp rm docs/runbooks/app-production/README.md',
    'sudo --chroot=/tmp rm docs/runbooks/app-production/README.md',
    'sudo -h remote rm docs/runbooks/app-production/README.md',
    'sudo --background rm docs/runbooks/app-production/README.md',
    'rm -vi docs/runbooks/app-production/README.md',
    'rm -vI docs/runbooks/app-production/README.md',
    'mv -vn /tmp/source docs/runbooks/app-production/README.md',
    'cp -vn /tmp/source docs/runbooks/app-production/README.md',
    'cp -u /tmp/source docs/runbooks/app-production/README.md',
    'tee < docs/runbooks/app-production/README.md > /tmp/copy',
    'rm < docs/runbooks/app-production/README.md unrelated.txt',
    'mv < docs/runbooks/app-production/README.md source.txt dest.txt',
    'git rm < docs/runbooks/app-production/README.md unrelated.txt',
    'rm 3< docs/runbooks/app-production/README.md unrelated.txt',
    'rm <& docs/runbooks/app-production/README.md unrelated.txt',
    'install -C /tmp/source docs/runbooks/app-production/README.md',
    'git rm -qn docs/runbooks/app-production/README.md',
    'git rm -nq docs/runbooks/app-production/README.md',
    'git --exec-path rm docs/runbooks/app-production/README.md',
    'git -C/tmp rm docs/runbooks/app-production/README.md',
    'git --work-tree=/tmp rm docs/runbooks/app-production/README.md',
    'GIT_WORK_TREE=/tmp git rm docs/runbooks/app-production/README.md',
    'true <> docs/runbooks/app-production/README.md',
    'true 3<>docs/runbooks/app-production/README.md',
    'true >> docs/runbooks/app-production/README.md',
    "printf '' >> docs/runbooks/app-production/README.md",
    "printf '%s' >> docs/runbooks/app-production/README.md",
    "printf '%s' '' >> docs/runbooks/app-production/README.md",
    "printf '%.0s' value >> docs/runbooks/app-production/README.md",
    "printf '%b' '\\c' >> docs/runbooks/app-production/README.md",
    'printf -v output replacement >> docs/runbooks/app-production/README.md',
    'echo -n >> docs/runbooks/app-production/README.md',
    "echo -e '\\c' >> docs/runbooks/app-production/README.md",
    'printf value >> docs/runbooks/app-production/README.md >/dev/null',
    'printf value 2>> docs/runbooks/app-production/README.md',
    'tee -a docs/runbooks/app-production/README.md',
    'tee --append docs/runbooks/app-production/README.md',
    'sudo tee -a docs/runbooks/app-production/README.md',
    'tee -a docs/runbooks/app-production/README.md </dev/null',
    'true | tee -a docs/runbooks/app-production/README.md',
    "printf '' | tee -a docs/runbooks/app-production/README.md",
    'printf x >/dev/null | tee -a docs/runbooks/app-production/README.md',
    'printf x </definitely/missing | tee -a docs/runbooks/app-production/README.md',
    'printf x 2>/definitely/missing/out | tee -a docs/runbooks/app-production/README.md',
    'sudo printf x | tee -a docs/runbooks/app-production/README.md',
    'env printf x | tee -a docs/runbooks/app-production/README.md',
    'nohup printf x | tee -a docs/runbooks/app-production/README.md',
    "printf 'password\\n' | sudo -S tee -a docs/runbooks/app-production/README.md",
    "printf 'password\\n' | sudo --stdin tee -a docs/runbooks/app-production/README.md",
    "printf 'password\\n' | sudo -nS tee -a docs/runbooks/app-production/README.md",
    'echo replacement 2>& docs/runbooks/app-production/README.md',
    'printf x | tee -a docs/runbooks/app-production/README.md </dev/null',
    'printf x | tee -a docs/runbooks/app-production/README.md | cat',
    'true &>> docs/runbooks/app-production/README.md',
    'cp -t /tmp docs/runbooks/app-production/README.md',
    'cp --target-directory=/tmp docs/runbooks/app-production/README.md',
    'install -t /tmp docs/runbooks/app-production/README.md',
    'install --target-directory=/tmp docs/runbooks/app-production/README.md',
    'git checkout -b docs/runbooks/app-production/README.md',
    'git restore --source docs/runbooks/app-production/README.md other-file',
    'git mv -k docs/runbooks/app-production/README.md /tmp/existing',
    './rm docs/runbooks/app-production/README.md',
    '/tmp/rm docs/runbooks/app-production/README.md',
    'sudo ./rm docs/runbooks/app-production/README.md',
    'PATH=/tmp/fake-bin rm docs/runbooks/app-production/README.md',
    'env PATH=/tmp/fake-bin rm docs/runbooks/app-production/README.md',
    'LD_PRELOAD=/tmp/no-unlink.so rm docs/runbooks/app-production/README.md',
    'env LD_PRELOAD=/tmp/no-unlink.so rm docs/runbooks/app-production/README.md',
    'cleanup () {\nrm docs/runbooks/app-production/README.md\n}',
  ])('does not derive a Bash mutation from non-proven execution: %s', (command) => {
    expect(leaveBehindMutationPathFromExecutableShell(command)).toBeNull();
  });

  it('bounds parser-owned shell mutation paths before persistence', () => {
    const oversized = `/${'a'.repeat(5000)}/${PATH}`;
    expect(
      leaveBehindMutationPathFromExecutableShell(`true > ${oversized}`)
    ).toBeNull();
    expect(
      leaveBehindMutationPathFromExecutableShell(`rm ${oversized}`)
    ).toBeNull();
  });

  it.each([
    'rm docs/runbooks/app-production/README.md',
    'rm -- docs/runbooks/app-production/README.md',
    'sudo env LC_ALL=C mv docs/runbooks/app-production/README.md /tmp/old-runbook.md',
    'git rm docs/runbooks/app-production/README.md',
    'git rm -- docs/runbooks/app-production/README.md',
    'exec rm docs/runbooks/app-production/README.md',
    'printf replacement > docs/runbooks/app-production/README.md',
    'printf replacement > docs/runbooks/app-production/README.md 2>&1',
    'true 2> docs/runbooks/app-production/README.md',
    'true 3> docs/runbooks/app-production/README.md',
    'echo replacement &> docs/runbooks/app-production/README.md',
    'echo replacement >& docs/runbooks/app-production/README.md',
    'echo replacement &>> docs/runbooks/app-production/README.md',
    'printf replacement >> docs/runbooks/app-production/README.md',
    "printf '%s' replacement >> docs/runbooks/app-production/README.md",
    'printf replacement >/dev/null >> docs/runbooks/app-production/README.md',
    'printf replacement 1>> docs/runbooks/app-production/README.md',
    'echo replacement >> docs/runbooks/app-production/README.md',
    'echo >> docs/runbooks/app-production/README.md',
    'tee docs/runbooks/app-production/README.md </dev/null',
    'true | tee docs/runbooks/app-production/README.md',
    'printf x | tee -a docs/runbooks/app-production/README.md',
    'printf replacement |\n tee docs/runbooks/app-production/README.md',
    'printf replacement |\n tee -a docs/runbooks/app-production/README.md',
    'echo x | sudo tee --append docs/runbooks/app-production/README.md >/dev/null',
    'sudo LC_ALL=C rm docs/runbooks/app-production/README.md',
    'rm -f docs/runbooks/app-production/README.md',
    'rm -rf docs/runbooks/app-production/README.md',
    'rm -fr docs/runbooks/app-production/README.md',
    'git rm -f docs/runbooks/app-production/README.md',
    'git rm -r docs/runbooks/app-production/README.md',
    'cp -f /tmp/source docs/runbooks/app-production/README.md',
    'mv -t /tmp docs/runbooks/app-production/README.md',
    'mv --target-directory /tmp docs/runbooks/app-production/README.md',
    'mv --target-directory=/tmp docs/runbooks/app-production/README.md',
    'mv -t/tmp docs/runbooks/app-production/README.md',
    'mv -t docs/runbooks/app-production /tmp/README.md',
    'mv --target-directory docs/runbooks/app-production /tmp/README.md',
    'mv --target-directory=docs/runbooks/app-production /tmp/README.md',
    'mv -tdocs/runbooks/app-production /tmp/README.md',
    'cp -t docs/runbooks/app-production /tmp/README.md',
    'cp --target-directory=docs/runbooks/app-production /tmp/README.md',
    'install -t docs/runbooks/app-production /tmp/README.md',
    'install --target-directory=docs/runbooks/app-production /tmp/README.md',
    'rm docs/runbooks/app-production/README.md;',
    'rm docs/runbooks/app-production/README.md\n',
  ])('derives an unconditional canonical Bash mutation: %s', (command) => {
    expect(leaveBehindMutationPathFromExecutableShell(command)).toBe(PATH);
  });

  it.each([
    'rm docs/runbooks/scope-a/README.md docs/runbooks/scope-b/README.md',
    'mv docs/runbooks/scope-a/README.md docs/runbooks/scope-b/README.md',
    'tee docs/runbooks/scope-a/README.md docs/runbooks/scope-b/README.md </dev/null',
    'true > docs/runbooks/scope-a/README.md > docs/runbooks/scope-b/README.md',
  ])('retains every canonical mutation path: %s', (command) => {
    expect(leaveBehindMutationPathsFromExecutableShell(command)).toEqual([
      'docs/runbooks/scope-a/README.md',
      'docs/runbooks/scope-b/README.md',
    ]);
  });

  it.each([
    'cp -t docs/runbooks/scope-a /tmp/README.md /tmp/notes.txt',
    'cp --target-directory=docs/runbooks/scope-a /tmp/README.md /tmp/notes.txt',
    'mv -t docs/runbooks/scope-a /tmp/README.md /tmp/notes.txt',
    'install -t docs/runbooks/scope-a /tmp/README.md /tmp/notes.txt',
    'cp /tmp/README.md /tmp/notes.txt docs/runbooks/scope-a',
    'mv /tmp/README.md /tmp/notes.txt docs/runbooks/scope-a',
    'install /tmp/README.md /tmp/notes.txt docs/runbooks/scope-a',
  ])('reconstructs every canonical multi-source transfer destination: %s', (command) => {
    expect(leaveBehindMutationPathsFromExecutableShell(command)).toContain(
      'docs/runbooks/scope-a/README.md'
    );
  });

  it('preserves substantive text inside ATX link and inline-HTML wrappers', () => {
    const content = CONFORMANT
      .replace(
        'The kubeconfig reference is documented in the team password manager; no credential value is copied here.',
        '#### [Use the documented kubeconfig](#access) ####'
      )
      .replace(
        'The generated config remains outside the checkout so rotation does not rewrite the template.',
        '#### <span>Keep the generated production config outside the checkout</span> ####'
      );

    expect(
      validateLeaveBehindArtifact({
        required: true,
        path: PATH,
        content,
        trackedAtHead: true,
      })
    ).toMatchObject({ status: 'conformant', errors: [] });
  });

  it.each([
    '[TODO](https://example.test\n"hidden prose")',
    '[TODO](<https://example.test>\n"hidden prose")',
  ])(
    'does not count a multiline inline-link title as visible section prose: %s',
    (body) => {
      const content = CONFORMANT.replace(
        'The kubeconfig reference is documented in the team password manager; no credential value is copied here.',
        body
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
        errors: expect.arrayContaining(['empty-state-and-access']),
      });
    }
  );

  it('preserves real prose after a multiline inline-link title', () => {
    const content = CONFORMANT.replace(
      'The kubeconfig reference is documented in the team password manager; no credential value is copied here.',
      '[TODO](https://example.test\n"hidden prose")\nUse the documented production kubeconfig.'
    );

    expect(
      validateLeaveBehindArtifact({
        required: true,
        path: PATH,
        content,
        trackedAtHead: true,
      })
    ).toMatchObject({ status: 'conformant', errors: [] });
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
      leaveBehindStateScope('./docs//runbooks/app-production/README.md')
    ).toBe('app-production');
    expect(
      leaveBehindStateScope(
        '/workspace/repo/./docs/runbooks/app-production/README.md'
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

  it('does not erase an HTML block between paragraph text and a Setext underline', () => {
    const content = CONFORMANT.replace(
      '## Operability',
      'Some intro\n<!-- -->\n---'
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

  it.each([
    'Some heading\n===',
    'ordinary prose\n```text\n```',
    'ordinary prose\n~~~text\n~~~',
    '>',
    '-',
    '*',
    '1.',
  ])('lets a proven block boundary precede a type-7 HTML block: %s', (prefix) => {
    const content = CONFORMANT.replace(
      '## Operability',
      `${prefix}\n<x-widget>\n## Operability`
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

  it.each([
    '> ordinary\n> - -',
    '- - ordinary\n  *',
    '- > ordinary\n  *',
    '- ordinary\n  \t=',
    '- - ordinary\n\t- -',
    '- > ordinary\n\t> -',
    '- 1. ordinary\n\t- -',
    '> - ordinary\n  > -',
    '1. > ordinary\n\t> -',
    '- ordinary\n  - \tcode',
    '* ordinary\n  - \tcode',
    '+ ordinary\n  - \tcode',
    '> 1. ordinary\n   > -',
    '-  ordinary\n\t- > \tcode',
    '> > - ordinary\n  > > -',
    '1. ordinary\n\t- > \tcode',
    '1) ordinary\n\t- > \tcode',
    '2. ordinary\n\t- > \tcode',
    '[foo]:\n-',
    '[foo]:\n---',
    '[foo]:\n=',
    '[foo]:\n===',
    '[foo]:\n~~~',
    '[foo]:\n<div>',
    '[foo]:\n```\n```',
    '> [foo]:\n>',
    '- [foo]:\n-',
    '- [foo]:\n*',
    '- [foo]:\n+',
    '> - [foo]:\n> -',
    '- > [foo]:\n- >',
    'ordinary\n    code\n-',
    'ordinary\n\tcode\n=',
    '=\n    code\n===',
    '> -\n    code',
    '> -\n\tcode',
    '- ordinary\n>\n    code',
    '- > ordinary\n> -\n\tcode',
  ])(
    'fails closed across mixed container, tab, and incomplete-definition boundaries: %s',
    (prefix) => {
      const content = CONFORMANT.replace(
        '## Operability',
        `${prefix}\n<x-widget>\n## Operability`
      );

      expect(
        validateLeaveBehindArtifact({
          required: true,
          path: PATH,
          content,
          trackedAtHead: true,
        }).errors
      ).toContain('missing-operability');
    }
  );

  it.each([
    '[foo]: /url',
    '> [foo]:\n> /url',
    '- [foo]:\n  /url',
    '> - [foo]:\n>   /url',
    '- > [foo]:\n  > /url',
    '- > [\n  > foo\n  > ]: /url',
    '- > [foo]: /url\n  > "title"',
    '1. > [foo]:\n   > /url\n   > "title"',
    '> 1. [foo]:\n>    /url',
    '1. > [foo]:\n   > /url',
    '> - > [foo]:\n>   > /url',
    '- > - [foo]:\n  >   /url',
    '[r]: /u\n"hidden\n2. continued"',
    '[r]: /u\n"hidden\n   9. continued"',
  ])('does not count a nested link definition as section prose: %s', (body) => {
    const content = CONFORMANT.replace(
      'The kubeconfig reference is documented in the team password manager; no credential value is copied here.',
      body
    );

    expect(
      validateLeaveBehindArtifact({
        required: true,
        path: PATH,
        content,
        trackedAtHead: true,
      }).errors
    ).toContain('empty-state-and-access');
  });

  it.each([
    '[r]:\n\t/u',
    '[r]:\n    <u>',
    '- [r]:\n/u',
    '> [r]:\n/u',
    '- [\nr]: /u',
    '- [r\nx]: /u',
    '- [r]: /u\n"hidden"',
    '- [r]: /u\n"hidden\ncontinued"',
    '> > [r]:\n> /u',
    '- > [r\nx]:\n    > /u',
    '- > [r]:\n/u\n    > "hidden"',
    '> - [\n    - r]: /u',
    '> - [r]: /u\n    "hidden\n    - continued"',
  ])(
    'does not count a lazily continued or deeply indented link definition as section prose: %s',
    (body) => {
      const content = CONFORMANT.replace(
        'The kubeconfig reference is documented in the team password manager; no credential value is copied here.',
        body
      );

      expect(
        validateLeaveBehindArtifact({
          required: true,
          path: PATH,
          content,
          trackedAtHead: true,
        }).errors
      ).toContain('empty-state-and-access');
    }
  );

  it.each([
    '[real](https://example.test)',
    '- [real](https://example.test)',
    '> [real][ref]\n\n[ref]: https://example.test',
    '- [not a definition',
    '[r]: /u\nReal prose',
    '- [r]: /u\n\nReal prose',
    '[r]: /u\n"hidden\n1. visible"',
  ])('keeps ordinary bracket prose around link definitions visible: %s', (body) => {
    const content = CONFORMANT.replace(
      'The kubeconfig reference is documented in the team password manager; no credential value is copied here.',
      body
    );

    expect(
      validateLeaveBehindArtifact({
        required: true,
        path: PATH,
        content,
        trackedAtHead: true,
      }).errors
    ).not.toContain('empty-state-and-access');
  });

  it.each(['<x-widget>', '<span>', '<a href="x">', '</span>'])(
    'does not let a type-7 HTML tag interrupt a paragraph: %s',
    (tag) => {
      const content = CONFORMANT.replace(
        '## Operability',
        `ordinary prose\n${tag}\n## Operability`
      );

      expect(
        validateLeaveBehindArtifact({
          required: true,
          path: PATH,
          content,
          trackedAtHead: true,
        })
      ).toMatchObject({ status: 'conformant', errors: [] });
    }
  );

  it.each([
    '#### incidental',
    '##### incidental',
    '###### incidental',
    '> ---',
    '> # quoted heading',
    '> ```\n> code\n> ```',
    '- # list heading',
    '1. ---',
    '>>',
    '> >',
    '- >',
    '- > >',
    '1. >',
    '> -',
    '> 1.',
    '> <div>',
    '- <div>',
    '>     code',
    '>\t\tcode',
    '-     code',
    '-\t\tcode',
    '1.\t\tcode',
    '- ```\n  code\n  ```',
  ])('lets a rendered leaf block precede a type-7 HTML block: %s', (prefix) => {
    const content = CONFORMANT.replace(
      '## Operability',
      `${prefix}\n<x-widget>\n## Operability`
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

  it.each([
    '####### incidental',
    '> quote',
    '- item',
    '1. item',
    '[x]: /url',
    '> [x]: /url',
    '- [x]: /url',
    '- > [foo]: /url\n  > "title"',
    '[Foo*bar\\]]:my_(url)',
    '[\nfoo\n]: /url',
    '[foo]:\n  /url',
    '[foo]: /url\n  "title"',
    "[foo]: /url '\ntitle\nline1\nline2\n'",
    '[\na\nb\nc\nd\ne\nf\ng\nh\ni\n]: /url',
  ])(
    'keeps a paragraph-shaped prefix open before type-7 HTML: %s',
    (prefix) => {
      const content = CONFORMANT.replace(
        '## Operability',
        `${prefix}\n<x-widget>\n## Operability`
      );

      expect(
        validateLeaveBehindArtifact({
          required: true,
          path: PATH,
          content,
          trackedAtHead: true,
        })
      ).toMatchObject({ status: 'conformant', errors: [] });
    }
  );

  it.each(['===', 'ordinary prose\n*', 'ordinary prose\n+', 'ordinary prose\n1.', 'ordinary prose\n2.'])(
    'does not promote a paragraph-continuation marker into a type-7 boundary: %s',
    (prefix) => {
      const content = CONFORMANT.replace(
        '## Operability',
        `${prefix}\n<x-widget>\n## Operability`
      );

      expect(
        validateLeaveBehindArtifact({
          required: true,
          path: PATH,
          content,
          trackedAtHead: true,
        })
      ).toMatchObject({ status: 'conformant', errors: [] });
    }
  );

  it.each([
    'ordinary prose\n-',
    '> heading\n> ===',
    '- heading\n  ===',
    '1. heading\n   ===',
    '> ordinary\n> --',
    '- ordinary\n  --',
    '1. ordinary\n   --',
    'ordinary prose\n---',
    '> ordinary\n---',
    '- ordinary\n ---',
    '1. ordinary\n  ---',
    '- ordinary\n\t>',
    '> ordinary\n- >',
  ])('gives Setext precedence before a following type-7 block: %s', (prefix) => {
    const content = CONFORMANT.replace(
      '## Operability',
      `${prefix}\n<x-widget>\n## Operability`
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

  it.each([
    '> ordinary\n> *',
    '> ordinary\n> +',
    '> ordinary\n> 1.',
    '> ordinary\n> 2.',
    '> ordinary\n> <x-one>',
    '> ordinary\n>     code',
    '- ordinary\n  <x-one>',
    '- ordinary\n      code',
    '1. ordinary\n   <x-one>',
    '1. ordinary\n       code',
    '> \tcode',
    '- <!--\n- -->',
    '1. <?pi\n1. ?>',
  ])('keeps non-interrupting container syntax in its paragraph: %s', (prefix) => {
    const content = CONFORMANT.replace(
      '## Operability',
      `${prefix}\n<x-widget>\n## Operability`
    );

    expect(
      validateLeaveBehindArtifact({
        required: true,
        path: PATH,
        content,
        trackedAtHead: true,
      })
    ).toMatchObject({ status: 'conformant', errors: [] });
  });

  it.each([
    '> <!--\n> hidden\n> -->',
    '- <!--\n  hidden\n  -->',
    '> <?pi\n> hidden\n> ?>',
    '> <![CDATA[\n> hidden\n> ]]>',
  ])('tracks a multiline raw block inside a container: %s', (prefix) => {
    const content = CONFORMANT.replace(
      '## Operability',
      `${prefix}\n<x-widget>\n## Operability`
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

  it('lets a type-6 HTML block interrupt a paragraph until an ASCII blank', () => {
    const content = CONFORMANT.replace(
      '## Operability',
      'ordinary prose\n<div>\n## Operability'
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

  it('keeps the CDATA block opener case-sensitive', () => {
    const content = CONFORMANT.replace(
      '## Operability',
      '<![cdata[\n## Operability\n]]>'
    );

    expect(
      validateLeaveBehindArtifact({
        required: true,
        path: PATH,
        content,
        trackedAtHead: true,
      })
    ).toMatchObject({ status: 'conformant', errors: [] });
  });

  it('recognizes lowercase ASCII letters in declaration block openers', () => {
    const content = CONFORMANT.replace(
      '## Operability',
      '<!doctype\n## Operability\n>'
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

  it('requires an exact type-1 end tag', () => {
    const content = CONFORMANT.replace(
      '## Operability',
      '<pre>\n</pre >\n## Operability\n</pre>'
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

  it.each(['</pre>', '</script>'])(
    'lets any exact type-1 end tag close a pre block: %s',
    (endTag) => {
      const content = CONFORMANT.replace(
        '## Operability',
        `<pre>\n${endTag}\n## Operability`
      );

      expect(
        validateLeaveBehindArtifact({
          required: true,
          path: PATH,
          content,
          trackedAtHead: true,
        })
      ).toMatchObject({ status: 'conformant', errors: [] });
    }
  );

  it.each(['<pre/>', '<script/>', '<style/>', '<textarea/>'])(
    'excludes literal-content open tags from type-7 HTML blocks: %s',
    (tag) => {
      const content = CONFORMANT.replace(
        '## Operability',
        `${tag}\n## Operability`
      );

      expect(
        validateLeaveBehindArtifact({
          required: true,
          path: PATH,
          content,
          trackedAtHead: true,
        })
      ).toMatchObject({ status: 'conformant', errors: [] });
    }
  );

  it.each(['<div\fclass="x">', '<x-widget\fclass="x">'])(
    'does not treat form feed as CommonMark HTML-tag whitespace: %s',
    (tag) => {
      const content = CONFORMANT.replace(
        '## Operability',
        `${tag}\n## Operability`
      );

      expect(
        validateLeaveBehindArtifact({
          required: true,
          path: PATH,
          content,
          trackedAtHead: true,
        })
      ).toMatchObject({ status: 'conformant', errors: [] });
    }
  );

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
      `# Placeholder\n\n<div>\n\u00a0\n${uninterruptedBody.replace(/\n/g, '\n\u00a0\n')}`,
      `# Placeholder\n\n${body.replace(/^(#{1,6}\s)/gm, '<!-- -->$1')}`,
      `# Placeholder\n\n${body
        .replace(/^## /gm, '#<!-- --># ')
        .replace(/^### /gm, '##<!-- --># ')}`,
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

  it('bounds an unterminated multiline link title without losing the next section boundary', () => {
    const unterminatedTitle =
      '- [foo]: /url\n  "unterminated' + '\n  x'.repeat(12_000);
    const content = CONFORMANT.replace(
      'The kubeconfig reference is documented in the team password manager; no credential value is copied here.',
      unterminatedTitle
    );

    const result = validateLeaveBehindArtifact({
      required: true,
      path: PATH,
      content,
      trackedAtHead: true,
    });
    expect(result.status).toBe('invalid');
    expect(result.errors).toEqual(['empty-state-and-access']);
  }, 1_000);

  it('scans repeated malformed inline HTML openers in linear time', () => {
    const content = CONFORMANT.replace(
      'The kubeconfig reference is documented in the team password manager; no credential value is copied here.',
      '<a '.repeat(12_000)
    );

    expect(
      validateLeaveBehindArtifact({
        required: true,
        path: PATH,
        content,
        trackedAtHead: true,
      }).status
    ).toBe('conformant');
  }, 1_000);

  it('reuses deep list-container context across lazy continuations', () => {
    const depth = 8_000;
    const nested = `- ${'> '.repeat(depth)}ordinary\n${'  ordinary\n'.repeat(depth)}`;
    const content = CONFORMANT.replace(
      'The kubeconfig reference is documented in the team password manager; no credential value is copied here.',
      nested
    );

    expect(
      validateLeaveBehindArtifact({
        required: true,
        path: PATH,
        content,
        trackedAtHead: true,
      }).status
    ).toBe('conformant');
  }, 1_000);

  it('scans deeply nested list markers in linear time', () => {
    const nested = `${'- '.repeat(16_000)}ordinary`;
    const content = CONFORMANT.replace(
      'The kubeconfig reference is documented in the team password manager; no credential value is copied here.',
      nested
    );

    expect(
      validateLeaveBehindArtifact({
        required: true,
        path: PATH,
        content,
        trackedAtHead: true,
      }).status
    ).toBe('conformant');
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
