import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SETTLED_OUTCOME_POLICY,
  SETTLED_TOOL_ERROR_POLICY,
  classifySettledOutcome,
  createDeliveryGates,
  settledDeliveryKey,
  type NewestAssistantEntry,
} from "../pi-extension/subagents/settled-contract.ts";

function assistant(
  overrides: Partial<NewestAssistantEntry> = {},
): NewestAssistantEntry {
  return {
    id: "assistant-1",
    text: "A settled response",
    contentLength: 18,
    stopReason: "stop",
    empty: false,
    ...overrides,
  };
}

describe("settled lifecycle contract", () => {
  it("classifies clean, empty, and provider-error responses", () => {
    assert.equal(
      classifySettledOutcome({ assistant: assistant(), interruptRequested: false }),
      "clean",
    );
    assert.equal(
      classifySettledOutcome({
        assistant: assistant({ text: null, contentLength: 0, empty: true }),
        interruptRequested: false,
      }),
      "empty",
    );
    assert.equal(
      classifySettledOutcome({
        assistant: assistant({
          text: null,
          contentLength: 0,
          stopReason: "error",
          errorMessage: "provider unavailable",
          empty: true,
        }),
        interruptRequested: false,
      }),
      "error",
    );
  });

  it("distinguishes intentional and unexpected aborts", () => {
    const aborted = assistant({
      text: null,
      contentLength: 0,
      stopReason: "aborted",
      empty: true,
    });
    assert.equal(
      classifySettledOutcome({ assistant: aborted, interruptRequested: true }),
      "intentional-abort",
    );
    assert.equal(
      classifySettledOutcome({ assistant: aborted, interruptRequested: false }),
      "unexpected-abort",
    );
  });

  it("freezes delivery and child-retention behavior for every outcome", () => {
    assert.deepEqual(SETTLED_OUTCOME_POLICY, {
      clean: { parentDelivery: "deliver", childLifecycle: "auto-exit" },
      empty: { parentDelivery: "deliver", childLifecycle: "auto-exit" },
      error: { parentDelivery: "deliver", childLifecycle: "keep-open" },
      "intentional-abort": {
        parentDelivery: "suppress",
        childLifecycle: "keep-open",
      },
      "unexpected-abort": {
        parentDelivery: "deliver",
        childLifecycle: "keep-open",
      },
    });
  });

  it("keeps an earlier tool error recoverable when the final response is clean", () => {
    assert.equal(SETTLED_TOOL_ERROR_POLICY, "recoverable-before-clean-final");
    assert.equal(
      classifySettledOutcome({
        assistant: assistant(),
        interruptRequested: false,
        hadToolError: true,
      }),
      "clean",
    );
  });

  it("uses child, session, and assistant id together for deduplication", () => {
    const first = settledDeliveryKey({
      childId: "child/a",
      sessionFile: "/tmp/session/one.jsonl",
      assistantEntryId: "entry-1",
    });
    const second = settledDeliveryKey({
      childId: "child",
      sessionFile: "a/session/one.jsonl",
      assistantEntryId: "entry-1",
    });
    assert.notEqual(first, second);
    assert.equal(
      settledDeliveryKey({
        childId: "child/a",
        sessionFile: "/tmp/session/one.jsonl",
        assistantEntryId: "entry-1",
      }),
      first,
    );
  });

  it("starts settled and terminal delivery gates independently", () => {
    const gates = createDeliveryGates();
    assert.equal(gates.settled.lastActivitySequence, null);
    assert.equal(gates.settled.delivered.size, 0);
    assert.equal(gates.terminal, "pending");
  });
});
