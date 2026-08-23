import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createSettledDeliveryLedger,
  createSettledDeliveryQueue,
  enqueueSettledDelivery,
  enqueueTerminalFinalization,
  hasSettledDelivery,
  restoreSettledDeliveryLedger,
  serializeSettledDeliveryLedger,
} from "../pi-extension/subagents/settled-delivery.ts";
import {
  createLifecycle,
  hasSettledAssistant,
  markSettledAssistantDelivered,
  observeSettledActivity,
} from "../pi-extension/subagents/lifecycle.ts";
import type { SettledDeliveryIdentity } from "../pi-extension/subagents/settled-contract.ts";

const identity = (childId: string, entryId: string): SettledDeliveryIdentity => ({
  childId,
  sessionFile: `/sessions/${childId}.jsonl`,
  assistantEntryId: entryId,
});

describe("settled delivery ledger", () => {
  it("serializes and restores reload-compatible state", () => {
    const ledger = createSettledDeliveryLedger({ lastActivitySequence: 4 });
    ledger.delivered.add("delivered-key");
    const restored = restoreSettledDeliveryLedger(serializeSettledDeliveryLedger(ledger));
    assert.deepEqual(serializeSettledDeliveryLedger(restored), {
      lastActivitySequence: 4,
      delivered: ["delivered-key"],
    });
  });

  it("delivers duplicate snapshots once and keeps two assistant ids ordered", async () => {
    const ledger = createSettledDeliveryLedger();
    const queue = createSettledDeliveryQueue();
    const delivered: string[] = [];
    const first = identity("child", "assistant-1");
    const second = identity("child", "assistant-2");
    const results = await Promise.all([
      enqueueSettledDelivery({
        queue,
        ledger,
        childId: "child",
        identity: first,
        activitySequence: 1,
        enqueue: async () => {
          delivered.push("one");
          await Promise.resolve();
          return "one";
        },
      }),
      enqueueSettledDelivery({
        queue,
        ledger,
        childId: "child",
        identity: first,
        activitySequence: 1,
        enqueue: () => {
          delivered.push("duplicate");
          return "duplicate";
        },
      }),
      enqueueSettledDelivery({
        queue,
        ledger,
        childId: "child",
        identity: second,
        activitySequence: 2,
        enqueue: () => {
          delivered.push("two");
          return "two";
        },
      }),
    ]);
    assert.deepEqual(delivered, ["one", "two"]);
    assert.deepEqual(results.map((result) => result.status), ["delivered", "duplicate", "delivered"]);
  });

  it("retries after an enqueue failure and marks only the successful attempt", async () => {
    const ledger = createSettledDeliveryLedger();
    const queue = createSettledDeliveryQueue();
    const entry = identity("child", "assistant-1");
    await assert.rejects(
      enqueueSettledDelivery({
        queue,
        ledger,
        childId: "child",
        identity: entry,
        activitySequence: 1,
        enqueue: () => {
          throw new Error("parent unavailable");
        },
      }),
      /parent unavailable/,
    );
    assert.equal(hasSettledDelivery(ledger, entry), false);
    const result = await enqueueSettledDelivery({
      queue,
      ledger,
      childId: "child",
      identity: entry,
      activitySequence: 1,
      enqueue: () => "retried",
    });
    assert.deepEqual(result, { status: "delivered", value: "retried" });
    assert.equal(hasSettledDelivery(ledger, entry), true);
  });


  it("allows an older event to retry after a later boundary succeeds", async () => {
    const ledger = createSettledDeliveryLedger();
    const queue = createSettledDeliveryQueue();
    const first = identity("child", "assistant-1");
    const second = identity("child", "assistant-2");
    let failed = true;
    await assert.rejects(enqueueSettledDelivery({
      queue,
      ledger,
      childId: "child",
      identity: first,
      activitySequence: 1,
      allowOlder: true,
      enqueue: () => {
        if (failed) {
          failed = false;
          throw new Error("first send failed");
        }
        return "one";
      },
    }), /first send failed/);
    assert.deepEqual(
      await enqueueSettledDelivery({
        queue,
        ledger,
        childId: "child",
        identity: second,
        activitySequence: 2,
        allowOlder: true,
        enqueue: () => "two",
      }),
      { status: "delivered", value: "two" },
    );
    assert.deepEqual(
      await enqueueSettledDelivery({
        queue,
        ledger,
        childId: "child",
        identity: first,
        activitySequence: 1,
        allowOlder: true,
        enqueue: () => "one",
      }),
      { status: "delivered", value: "one" },
    );
  });

  it("ignores an older activity sequence", async () => {
    const ledger = createSettledDeliveryLedger();
    const queue = createSettledDeliveryQueue();
    const latest = identity("child", "assistant-2");
    await enqueueSettledDelivery({
      queue,
      ledger,
      childId: "child",
      identity: latest,
      activitySequence: 2,
      enqueue: () => "latest",
    });
    const stale = await enqueueSettledDelivery({
      queue,
      ledger,
      childId: "child",
      identity: identity("child", "assistant-1"),
      activitySequence: 1,
      enqueue: () => "stale",
    });
    assert.deepEqual(stale, { status: "stale" });
  });

  it("runs terminal cleanup while suppressing already-delivered final content", async () => {
    const ledger = createSettledDeliveryLedger();
    const queue = createSettledDeliveryQueue();
    const final = identity("child", "assistant-final");
    await enqueueSettledDelivery({
      queue,
      ledger,
      childId: "child",
      identity: final,
      activitySequence: 1,
      enqueue: () => "settled",
    });
    const terminal = await enqueueTerminalFinalization({
      queue,
      ledger,
      childId: "child",
      finalAssistant: final,
      finalize: (contentAlreadyDelivered) => ({ contentAlreadyDelivered, cleaned: true }),
    });
    assert.deepEqual(terminal, { contentAlreadyDelivered: true, cleaned: true });
  });


  it("leaves terminal finalization retryable after a send failure", async () => {
    const ledger = createSettledDeliveryLedger();
    const queue = createSettledDeliveryQueue();
    let failed = true;
    await assert.rejects(
      enqueueTerminalFinalization({
        queue,
        ledger,
        childId: "child",
        finalize: () => {
          if (failed) {
            failed = false;
            throw new Error("send failed");
          }
          return "delivered";
        },
      }),
      /send failed/,
    );
    assert.equal(
      await enqueueTerminalFinalization({
        queue,
        ledger,
        childId: "child",
        finalize: () => "delivered",
      }),
      "delivered",
    );
  });

  it("isolates queues and ledgers by child id", async () => {
    const queue = createSettledDeliveryQueue();
    const firstLedger = createSettledDeliveryLedger();
    const secondLedger = createSettledDeliveryLedger();
    const first = identity("child-a", "same-entry-id");
    const second = identity("child-b", "same-entry-id");
    await Promise.all([
      enqueueSettledDelivery({ queue, ledger: firstLedger, childId: "child-a", identity: first, activitySequence: 1, enqueue: () => "a" }),
      enqueueSettledDelivery({ queue, ledger: secondLedger, childId: "child-b", identity: second, activitySequence: 1, enqueue: () => "b" }),
    ]);
    assert.equal(hasSettledDelivery(firstLedger, first), true);
    assert.equal(hasSettledDelivery(secondLedger, second), true);
  });

  it("keeps terminal and settled lifecycle gates independent", () => {
    let lifecycle = createLifecycle(1);
    lifecycle = observeSettledActivity(lifecycle, 2);
    lifecycle = markSettledAssistantDelivered(lifecycle, identity("child", "assistant-1"), 2);
    assert.equal(lifecycle.delivery, "pending");
    assert.equal(hasSettledAssistant(lifecycle, identity("child", "assistant-1")), true);
    assert.equal(observeSettledActivity(lifecycle, 1), lifecycle);
  });
});
