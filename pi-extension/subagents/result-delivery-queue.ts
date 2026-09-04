/** A small promise queue keyed by child id. Unrelated children can finalize concurrently. */
export interface ResultDeliveryQueue {
  enqueue<T>(childId: string, job: () => T | Promise<T>): Promise<T>;
}

/** Create the process-local queue used to serialize one child's terminal delivery. */
export function createResultDeliveryQueue(): ResultDeliveryQueue {
  const tails = new Map<string, Promise<void>>();
  return {
    enqueue<T>(childId: string, job: () => T | Promise<T>): Promise<T> {
      const previous = tails.get(childId) ?? Promise.resolve();
      const run = previous.then(job);
      const tail = run.then(
        () => undefined,
        () => undefined,
      );
      tails.set(childId, tail);
      void tail.finally(() => {
        if (tails.get(childId) === tail) tails.delete(childId);
      });
      return run;
    },
  };
}

/** Queue the one terminal delivery for a child. */
export function enqueueResultDelivery<T>(options: {
  queue: ResultDeliveryQueue;
  childId: string;
  deliver: () => T | Promise<T>;
}): Promise<T> {
  return options.queue.enqueue(options.childId, options.deliver);
}
