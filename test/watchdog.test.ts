import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SubagentActivityState } from "../pi-extension/subagents/activity.ts";
import {
  classifyStaleness,
  consumeRecoveryAttempt,
  DEFAULT_QUIET_THRESHOLD_MS,
  resolveQuietThreshold,
} from "../pi-extension/subagents/watchdog.ts";

function activity(overrides: Partial<SubagentActivityState> = {}): SubagentActivityState {
  return {
    version: 1,
    runningChildId: "child",
    createdAt: 1,
    updatedAt: 1_000,
    sequence: 1,
    latestEvent: "agent_start",
    phase: "active",
    agentActive: true,
    turnActive: true,
    providerActive: false,
    toolActive: false,
    ...overrides,
  };
}

test("resolves the quiet threshold with environment precedence and strict validation", () => {
  assert.equal(resolveQuietThreshold(undefined, undefined), DEFAULT_QUIET_THRESHOLD_MS);
  assert.equal(resolveQuietThreshold(undefined, 5_000), 5_000);
  assert.equal(resolveQuietThreshold("250", 5_000), 250);
  assert.throws(() => resolveQuietThreshold("0", undefined), /PI_SUBAGENT_QUIET_THRESHOLD_MS/);
  assert.throws(() => resolveQuietThreshold("not-a-number", undefined), /PI_SUBAGENT_QUIET_THRESHOLD_MS/);
});

test("classifies only autonomous observable silence as stale", () => {
  const base = {
    autonomous: true,
    activity: activity(),
    startedAt: 1,
    now: 2_001,
    quietThresholdMs: 1_000,
    waitingForDescendants: false,
  };
  assert.equal(classifyStaleness(base), "stale");
  assert.equal(classifyStaleness({ ...base, autonomous: false }), "active");
  assert.equal(classifyStaleness({ ...base, waitingForDescendants: true }), "waiting");
  assert.equal(classifyStaleness({ ...base, activity: activity({ toolActive: true }) }), "active");
  assert.equal(classifyStaleness({ ...base, activity: activity({ updatedAt: 1_500 }) }), "active");
});

test("never treats active context compaction as stale", () => {
  const compacting = activity({
    updatedAt: 1_000,
    latestEvent: "session_before_compact",
    activeScope: "compaction",
    compactionActive: true,
  });

  assert.equal(
    classifyStaleness({
      autonomous: true,
      activity: compacting,
      startedAt: 1,
      now: 1_000_000,
      quietThresholdMs: 1_000,
      waitingForDescendants: false,
    }),
    "active",
    "normal compaction stays protected beyond the quiet threshold",
  );
});

test("starts a fresh owner quiet window when a descendant result arrives", () => {
  const base = {
    autonomous: true,
    activity: activity({
      updatedAt: 1_000,
      agentActive: false,
      turnActive: false,
      providerActive: false,
    }),
    startedAt: 1,
    quietThresholdMs: 1_000,
    waitingForDescendants: false,
    descendantActivityAt: 1_500,
  };

  assert.equal(
    classifyStaleness({ ...base, now: 2_001 }),
    "active",
    "recent descendant delivery starts a fresh quiet window for its owner",
  );
  assert.equal(
    classifyStaleness({ ...base, now: 2_501 }),
    "stale",
    "the owner becomes eligible again after its fresh quiet window expires",
  );
  assert.equal(
    classifyStaleness({
      ...base,
      now: 10_000,
      activity: activity({ updatedAt: 1_000, providerActive: true }),
    }),
    "active",
    "active model processing of a descendant result is not stale",
  );
});

test("shares and persists one three-attempt budget across crash and stale recovery", () => {
  const dir = mkdtempSync(join(tmpdir(), "subagent-watchdog-"));
  const logPath = join(dir, "delivery.jsonl");
  const first = consumeRecoveryAttempt({ logPath, childId: "child", cause: "crash", now: () => 1 });
  const second = consumeRecoveryAttempt({ logPath, childId: "child", cause: "stale", now: () => 2 });
  const third = consumeRecoveryAttempt({ logPath, childId: "child", cause: "stale", now: () => 3 });
  const exhausted = consumeRecoveryAttempt({ logPath, childId: "child", cause: "crash", now: () => 4 });
  assert.deepEqual([first.attempt, second.attempt, third.attempt, exhausted.attempt], [1, 2, 3, 3]);
  assert.equal(first.exhausted, false);
  assert.equal(second.exhausted, false);
  assert.equal(third.exhausted, false);
  assert.equal(exhausted.exhausted, true);
  assert.match(exhausted.reason, /mixed crash and stale/);
  assert.equal(readFileSync(logPath, "utf8").trim().split("\n").length, 3);
});

test("fails closed when the durable recovery ledger is corrupt", () => {
  const dir = mkdtempSync(join(tmpdir(), "subagent-watchdog-invalid-"));
  const logPath = join(dir, "delivery.jsonl");
  // An invalid prefix must not reset a previously consumed retry budget.
  writeFileSync(logPath, "not-json\n", "utf8");
  assert.throws(
    () => consumeRecoveryAttempt({ logPath, childId: "child", cause: "crash" }),
    /Invalid recovery ledger record 1/,
  );
});
