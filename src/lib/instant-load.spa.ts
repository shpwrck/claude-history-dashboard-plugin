// SPA/sample-build stub for the boot-first loader (#2443).
//
// `vite build --mode spa|sample` aliases `@instant-load` to THIS module (see
// vite.config.ts), so the real loader's `/api/` literals are physically absent
// from the upload-only bundle. The SPA gets its dataset from the in-browser
// upload pipeline, never the server, so this is never called on the SPA path.

/** Mirror of the real module's exported surface (no server strings). Never
 * called on the SPA path (reloadFromDisk returns early when !SERVER_AVAILABLE).
 * The extra `setShellCounts`/`opts` params mirror the real signature
 * (#2448/#2450/#2449); they are intentionally ignored here. */
export async function loadServerDataset(
  apply: (data: unknown) => void,
  setBusy: (busy: boolean) => void,
  setShellCounts: (counts: unknown) => void,
  _opts?: unknown
): Promise<void> {
  void apply;
  void setShellCounts;
  void _opts;
  setBusy(false);
}
