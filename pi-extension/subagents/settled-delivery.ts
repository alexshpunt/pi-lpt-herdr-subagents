import {
  settledDeliveryKey,
  type SettledDeliveryIdentity,
} from "./settled-contract.ts";

/** A mutable, reload-safe settled delivery ledger for one or more children. */
export interface SettledDeliveryLedger {
  lastActivitySequence: number | null;
  delivered: Set<string>;
}

/** JSON-compatible form of a settled delivery ledger. */
export interface SettledDeliveryLedgerState {
  lastActivitySequence: number | null;
  delivered: string[];
}

/** Result returned when a settled or terminal delivery job runs. */
export type DeliveryJobResult<T> =
  | { status: "delivered"; value: T }
  | { status: "duplicate" }
  | { status: "stale" };

/** Create a fresh ledger, optionally restoring a previously serialized state. */
export function createSettledDeliveryLedger(
  state?: Partial<SettledDeliveryLedgerState>,
): SettledDeliveryLedger {
  return {
    lastActivitySequence:
      state?.lastActivitySequence == null ? null : state.lastActivitySequence,
    delivered: new Set(state?.delivered ?? []),
  };
}

/** Convert the in-memory Set into a JSON-compatible state for reload retention. */
export function serializeSettledDeliveryLedger(
  ledger: SettledDeliveryLedger,
): SettledDeliveryLedgerState {
  return {
    lastActivitySequence: ledger.lastActivitySequence,
    delivered: [...ledger.delivered],
  };
}

/** Restore a ledger from its JSON-compatible state. */
export function restoreSettledDeliveryLedger(
  state: SettledDeliveryLedgerState,
): SettledDeliveryLedger {
  return createSettledDeliveryLedger(state);
}

/** Return whether an assistant identity has already been delivered. */
export function hasSettledDelivery(
  ledger: SettledDeliveryLedger,
  identity: SettledDeliveryIdentity,
): boolean {
  return ledger.delivered.has(settledDeliveryKey(identity));
}

/**
 * Record a successful settled enqueue.
 *
 * The identity is deliberately marked only after the caller's enqueue callback
 * resolves. A rejected callback leaves the identity retryable.
 */
export function markSettledDelivered(
  ledger: SettledDeliveryLedger,
  identity: SettledDeliveryIdentity,
  activitySequence: number,
): void {
  ledger.delivered.add(settledDeliveryKey(identity));
  if (
    ledger.lastActivitySequence == null ||
    activitySequence > ledger.lastActivitySequence
  ) {
    ledger.lastActivitySequence = activitySequence;
  }
}

/**
 * A small promise queue keyed by child id. Jobs for one child run in insertion
 * order; unrelated children can run concurrently.
 */
export interface SettledDeliveryQueue {
  enqueue<T>(childId: string, job: () => T | Promise<T>): Promise<T>;
}

export function createSettledDeliveryQueue(): SettledDeliveryQueue {
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

/**
 * Queue one settled response and mark it delivered only after enqueue succeeds.
 * Equal/older activity snapshots and identities already delivered are no-ops.
 */
export function enqueueSettledDelivery<T>(options: {
  queue: SettledDeliveryQueue;
  ledger: SettledDeliveryLedger;
  childId: string;
  identity: SettledDeliveryIdentity;
  activitySequence: number;
  enqueue: () => T | Promise<T>;
}): Promise<DeliveryJobResult<T>> {
  const {
    queue,
    ledger,
    childId,
    identity,
    activitySequence,
    enqueue,
  } = options;
  return queue.enqueue(childId, async () => {
    if (hasSettledDelivery(ledger, identity)) return { status: "duplicate" };
    if (
      ledger.lastActivitySequence != null &&
      activitySequence <= ledger.lastActivitySequence
    ) {
      return { status: "stale" };
    }
    const value = await enqueue();
    markSettledDelivered(ledger, identity, activitySequence);
    return { status: "delivered", value };
  });
}

/**
 * Queue terminal finalization behind settled jobs. If the final assistant was
 * already delivered as settled, content delivery is suppressed, but the
 * finalization callback still runs so terminal lifecycle cleanup can complete.
 */
export function enqueueTerminalFinalization<T>(options: {
  queue: SettledDeliveryQueue;
  ledger: SettledDeliveryLedger;
  childId: string;
  finalAssistant?: SettledDeliveryIdentity;
  finalize: (contentAlreadyDelivered: boolean) => T | Promise<T>;
}): Promise<T> {
  const { queue, ledger, childId, finalAssistant, finalize } = options;
  return queue.enqueue(childId, () =>
    finalize(finalAssistant == null ? false : hasSettledDelivery(ledger, finalAssistant)),
  );
}
