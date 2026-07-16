# UI Consistency Audit

Issue #1591 found that the dashboard had a shared heading convention, but it had
not been rolled out beyond a small set of views. This document records the
page-header convention established by #1592 so follow-up rollout batches can
move view by view without re-deciding the structure.

## Findings

- Only 5 of 31 registered views used `PageTitle` as an `h1` at size `3xl`.
- The remaining views mostly used `Title headingLevel="h2" size="xl"` as the
  page title, leaving those pages with no `h1`.
- Several views inverted the hierarchy: sub-headings such as `h3 size="2xl"`
  outweighed or appeared before the page title.
- Page title spacing drifted across views, with local `marginBottom` values of
  4, 8, 16, and 24 pixels.
- Explainer copy was hard-coded where it existed at all. `NAV_ITEMS` carried the
  view label and domain, but not the page-header description.

## Convention

- Every registered view should render exactly one `PageHeader` at the top of
  the view.
- `PageHeader` owns the page title as `h1` / `3xl`, the optional subtle
  explainer line, and the standard bottom spacing before page content.
- Explainer copy comes from `NAV_ITEMS[].description`. Views should look up the
  relevant nav item instead of hard-coding the line beside the title.
- Section headings stay below the page title: `SectionHeader` is for `h2` / `xl`
  sections, and `SubSectionHeader` is for `h3` or `h4` groupings.
- No sub-heading should be visually larger than the page title.

## Rollout Notes

The #1592 reference migration covers `cost` and `tokens`. Later batches should
apply the same pattern by domain, then the drift guard should enforce one `h1`
per registered view and prevent oversized sub-headings from returning.
