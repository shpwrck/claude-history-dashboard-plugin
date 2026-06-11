import { describe, expect, it } from 'vitest';
import { createUploadResultScheduler } from './upload-result-scheduler';

function scheduledQueue() {
  const tasks: Array<{ cancelled: boolean; run: () => void }> = [];
  return {
    tasks,
    scheduleTask(task: () => void) {
      const entry = {
        cancelled: false,
        run() {
          if (!entry.cancelled) task();
        },
      };
      tasks.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
  };
}

describe('createUploadResultScheduler', () => {
  it('defers upload results until the scheduled task runs', () => {
    const applied: number[] = [];
    const scheduled = scheduledQueue();
    const scheduler = createUploadResultScheduler(
      (item: number) => applied.push(item),
      { scheduleTask: scheduled.scheduleTask }
    );

    scheduler.enqueue(1);

    expect(applied).toEqual([]);
    expect(scheduler.pendingCount()).toBe(1);

    scheduled.tasks[0].run();

    expect(applied).toEqual([1]);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('flushes large queues in bounded batches', () => {
    const applied: number[] = [];
    const scheduled = scheduledQueue();
    const scheduler = createUploadResultScheduler(
      (item: number) => applied.push(item),
      { maxBatchSize: 2, scheduleTask: scheduled.scheduleTask }
    );

    scheduler.enqueue(1);
    scheduler.enqueue(2);
    scheduler.enqueue(3);
    scheduler.enqueue(4);
    scheduler.enqueue(5);

    expect(scheduled.tasks).toHaveLength(1);
    scheduled.tasks[0].run();

    expect(applied).toEqual([1, 2]);
    expect(scheduler.pendingCount()).toBe(3);
    expect(scheduled.tasks).toHaveLength(2);

    scheduled.tasks[1].run();
    expect(applied).toEqual([1, 2, 3, 4]);

    scheduled.tasks[2].run();
    expect(applied).toEqual([1, 2, 3, 4, 5]);
    expect(scheduler.pendingCount()).toBe(0);
  });

  it('flushNow applies all pending results and cancels the scheduled batch', () => {
    const applied: number[] = [];
    const scheduled = scheduledQueue();
    const scheduler = createUploadResultScheduler(
      (item: number) => applied.push(item),
      { maxBatchSize: 1, scheduleTask: scheduled.scheduleTask }
    );

    scheduler.enqueue(1);
    scheduler.enqueue(2);
    scheduler.flushNow();

    expect(applied).toEqual([1, 2]);
    expect(scheduler.pendingCount()).toBe(0);

    scheduled.tasks[0].run();
    expect(applied).toEqual([1, 2]);
  });

  it('cancel drops pending and future results', () => {
    const applied: number[] = [];
    const scheduled = scheduledQueue();
    const scheduler = createUploadResultScheduler(
      (item: number) => applied.push(item),
      { scheduleTask: scheduled.scheduleTask }
    );

    scheduler.enqueue(1);
    scheduler.cancel();
    scheduler.enqueue(2);

    scheduled.tasks[0].run();

    expect(applied).toEqual([]);
    expect(scheduler.pendingCount()).toBe(0);
  });
});
