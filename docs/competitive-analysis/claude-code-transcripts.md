# simonw/claude-code-transcripts

## Source

- GitHub: https://github.com/simonw/claude-code-transcripts
- Background post: https://simonwillison.net/
- Date captured: 2026-06-09
- Category: Adjacent product
- Related issues: #807, #926

## What It Is

`claude-code-transcripts` converts Claude Code session files into clean,
mobile-friendly, paginated HTML transcript pages. It can select local sessions
from `~/.claude/projects`, convert specific JSON/JSONL files, convert all local
sessions into a browsable archive, and publish generated HTML to GitHub Gist.

The project is focused on readable, shareable transcript publishing rather than
live analytics.

## User Job

When a user wants to inspect, archive, or share a Claude Code session, they need
a durable transcript format that is easier to read than raw JSONL and can be
opened outside the original CLI.

## What It Does Well

- Produces static HTML output from Claude Code session files.
- Supports a broad archive mode across local sessions.
- Offers a direct sharing path through GitHub Gist.
- Keeps the core user task narrow: make transcripts readable and portable.
- Includes source JSON alongside output when requested, preserving provenance.

## Where Claude History Dashboard Is Stronger

- Computes cross-session analytics, not just static transcript pages.
- Parses more behavioral signals into views and recommendations.
- Supports live reload from disk for new sessions in the server build.
- Provides token, cost, tool, context, permission, error, and file-impact
  surfaces.
- Offers an upload-only SPA for local parsing without a backend.

## Product Implications

- Static transcript export is a real gap if the dashboard wants portability and
  sharing.
- Gist publishing is useful but should be treated carefully because transcript
  data may include sensitive prompts, paths, outputs, or secrets.
- A static archive mode would complement the dashboard's live server and SPA
  modes without changing the core analytics product.
- Transcript publishing should preserve evidence links used by session
  drill-ins where possible.

## Existing Coverage

| Observation | Status | Evidence / issue |
|---|---|---|
| Read local Claude Code JSONL sessions | Implemented | README, REFERENCES.md |
| Upload user-provided transcript files or zip bundles | Implemented | #395, #538 |
| Browse session detail inside the app | Implemented | #205, #817 |
| Static HTML transcript/archive export | Deferred | Called out of scope in #807 |
| Gist publishing | Deferred | Called out of scope in #807 |
| Claude web-session import | Deferred / related backlog | #689 and #694 cover central/cloud transcript capture direction |

## Follow-up

Issue #807 tracks competitive-analysis follow-through from the Her and
`claude-code-transcripts` comparison. Static transcript/archive HTML export,
Gist publishing, Claude web-session import, and commit extraction/linking were
explicitly left out of #807's initial scope and should become separate issues if
we decide to pursue them.
