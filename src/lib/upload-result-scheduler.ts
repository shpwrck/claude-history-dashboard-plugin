type CancelScheduledTask = () => void;
type ScheduledTask = () => void;
type ScheduleTask = (task: ScheduledTask) => CancelScheduledTask;

export interface UploadResultScheduler<T> {
  enqueue(item: T): void;
  flushNow(): void;
  cancel(): void;
  pendingCount(): number;
}

interface UploadResultSchedulerOptions {
  maxBatchSize?: number;
  scheduleTask?: ScheduleTask;
}

const DEFAULT_MAX_BATCH_SIZE = 3;
const IDLE_TIMEOUT_MS = 50;

type IdleWindow = Window & {
  requestIdleCallback?: (
    callback: () => void,
    options?: { timeout?: number }
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
};

function defaultScheduleTask(task: ScheduledTask): CancelScheduledTask {
  const browserWindow =
    typeof window === 'undefined' ? null : (window as IdleWindow);

  if (typeof browserWindow?.requestIdleCallback === 'function') {
    const handle = browserWindow.requestIdleCallback(task, {
      timeout: IDLE_TIMEOUT_MS,
    });
    return () => browserWindow.cancelIdleCallback?.(handle);
  }

  const handle = setTimeout(task, 0);
  return () => clearTimeout(handle);
}

export function createUploadResultScheduler<T>(
  apply: (item: T) => void,
  options: UploadResultSchedulerOptions = {}
): UploadResultScheduler<T> {
  const maxBatchSize = Math.max(
    1,
    Math.floor(options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE)
  );
  const scheduleTask = options.scheduleTask ?? defaultScheduleTask;
  let queue: T[] = [];
  let cancelScheduled: CancelScheduledTask | null = null;
  let cancelled = false;

  const schedule = () => {
    if (cancelled || cancelScheduled || queue.length === 0) return;
    cancelScheduled = scheduleTask(flushBatch);
  };

  const clearScheduledTask = () => {
    if (!cancelScheduled) return;
    cancelScheduled();
    cancelScheduled = null;
  };

  function flushBatch() {
    cancelScheduled = null;
    if (cancelled) return;

    const batch = queue.splice(0, maxBatchSize);
    for (const item of batch) apply(item);
    schedule();
  }

  return {
    enqueue(item) {
      if (cancelled) return;
      queue.push(item);
      schedule();
    },
    flushNow() {
      if (cancelled || queue.length === 0) {
        clearScheduledTask();
        return;
      }
      clearScheduledTask();
      const pending = queue;
      queue = [];
      for (const item of pending) apply(item);
    },
    cancel() {
      clearScheduledTask();
      queue = [];
      cancelled = true;
    },
    pendingCount() {
      return queue.length;
    },
  };
}
