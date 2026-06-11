// Chunked, main-thread-friendly mapping (#758).
//
// The upload parse sweeps the full file set once per parser. For a large
// `~/.claude` bundle a single synchronous `.map` over thousands of files blocks
// the main thread long enough to freeze the tab ("locks for a long time"). This
// helper runs the same map in fixed-size chunks, yielding a macrotask between
// chunks so queued input and React paints get to run mid-parse — keeping the UI
// responsive ("immediate"). Output order and contents are identical to a plain
// `items.map(fn)`.

/** Yield one macrotask so the browser can paint and flush input between chunks. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export interface MapChunkedOptions {
  /** Items processed per synchronous burst before yielding. Default 200. */
  chunkSize?: number;
  /** Called after each chunk with the count processed so far (for progress). */
  onProgress?: (done: number, total: number) => void;
}

/**
 * Map `items` through `fn` in chunks, yielding to the event loop between chunks.
 * Equivalent to `items.map(fn)` but non-blocking for large inputs.
 */
export async function mapChunked<T, R>(
  items: T[],
  fn: (item: T, index: number) => R,
  options: MapChunkedOptions = {}
): Promise<R[]> {
  const chunkSize = Math.max(1, options.chunkSize ?? 200);
  const out: R[] = new Array(items.length);
  for (let i = 0; i < items.length; i += chunkSize) {
    const end = Math.min(i + chunkSize, items.length);
    for (let j = i; j < end; j++) {
      out[j] = fn(items[j], j);
    }
    options.onProgress?.(end, items.length);
    if (end < items.length) await yieldToEventLoop();
  }
  return out;
}
