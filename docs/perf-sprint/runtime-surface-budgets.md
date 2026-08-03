# Runtime surface performance budgets

These deterministic probes protect two bounded runtime surfaces added during
the v0.6 performance gate. They use synthetic local data and fake network
responses; neither probe makes an external call.

## Automation timeline DOM

`src/components/AutomationView.test.ts` renders 10,000 unattended sessions and
timeline rows through the public `AutomationViewPf` component.

- DOM allocation budget: at most 200 clickable timeline marks.
- Render-latency budget: less than 2,000 ms in the Vitest jsdom process.
- Completeness guard: the timeline accessible label retains the full 10,000-run
  count, while the paginated and searchable run table remains the complete
  session drill-down.

The latency ceiling is deliberately wider than the expected bounded render;
the timeline-node count is the primary deterministic regression gate.

## GitHub review synchronization

`src/lib/github-review-sync.test.ts` exercises the exported synchronization
seam with a fake fetch implementation.

- Concurrency budget: exactly three active timeline requests for a configured
  pool of three, never more.
- Representative latency budget: twelve 40 ms timeline responses complete in
  less than 350 ms (serial work is at least 480 ms).
- Utilization budget: with a two-request pool, later fast jobs start before an
  earlier 120 ms job settles while active requests never exceed two.
- Deadline budget: stalled requests under a configured 120 ms total deadline
  reject in less than 500 ms including CI scheduling headroom.

Production defaults allow four timeline requests in parallel and impose one
15,000 ms deadline over the complete repository synchronization. Existing
request, response-byte, record, repository, pull, and per-request timeout caps
remain enforced independently.
