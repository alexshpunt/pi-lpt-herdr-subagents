import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import subagents, { __test__ } from "../pi-extension/subagents/index.ts";
import { createLifecycle, markInterruptRequested } from "../pi-extension/subagents/lifecycle.ts";

import {
  orderSettledActivityEvents,
  type SettledActivityEvent,
} from "../pi-extension/subagents/activity.ts";
import { appendLineageEvent, registerLineage } from "../pi-extension/subagents/lineage.ts";
function createApi(send: (message: any) => void) {
  return {
    events: { on() {}, emit() {} },
    on() {},
    registerTool() {},
    registerCommand() {},
    registerMessageRenderer() {},
    registerShortcut() {},
    sendMessage(message: any) { send(message); },
    sendUserMessage() {},
    getAllTools() { return []; },
    getThinkingLevel() { return "off"; },
  } as any;
}

function writeSession(sessionFile: string, messages: Array<{ id: string; text: string; stopReason?: string; toolUse?: boolean }>) {
  const lines = [JSON.stringify({ type: "session", id: "baseline" })];
  for (const message of messages) {
    lines.push(JSON.stringify({
      type: "message",
      id: message.id,
      message: {
        role: "assistant",
        content: message.toolUse
          ? [{ type: "toolCall", name: "read" }]
          : [{ type: "text", text: message.text }],
        stopReason: message.stopReason ?? "stop",
      },
    }));
  }
  writeFileSync(sessionFile, `${lines.join("\n")}\n`);
}

function writeEvents(
  eventsFile: string,
  events: Array<{ sequence: number; outcome: string; assistantId?: string; stopReason?: string; empty?: boolean }>,
) {
  for (const event of events) {
    appendFileSync(eventsFile, `${JSON.stringify({
      schema: 1,
      childId: "child",
      sequence: event.sequence,
      recordedAt: event.sequence,
      outcome: event.outcome,
      ...(event.assistantId ? { assistantId: event.assistantId } : {}),
      ...(event.stopReason ? { stopReason: event.stopReason } : {}),
      empty: event.empty ?? false,
    })}\n`);
  }
}

function makeRunning(
  root: string,
  messages: Array<{ id: string; text: string; stopReason?: string; toolUse?: boolean }>,
  events: Array<{ sequence: number; outcome: string; assistantId?: string; stopReason?: string; empty?: boolean }>,
) {
  const sessionFile = join(root, "child.jsonl");
  const eventsFile = join(root, "child.settled.jsonl");
  writeSession(sessionFile, messages);
  writeEvents(eventsFile, events);
  return {
    id: "child",
    name: "Child",
    task: "task",
    surface: "surface",
    startTime: 1,
    sessionFile,
    activityFile: join(root, "activity.json"),
    settledEventsFile: eventsFile,
    sessionBaseline: { sessionFile, entryCount: 1, leafId: "baseline", assistantEntryIds: [] },
    lifecycle: createLifecycle(1),
    interactive: false,
    runtimePlan: undefined,
  } as any;
}

function appendToolCall(sessionFile: string, id: string): void {
  appendFileSync(sessionFile, `${JSON.stringify({
    type: "message",
    id,
    message: {
      role: "assistant",
      content: [{ type: "toolCall", name: "subagent_done" }],
      stopReason: "toolUse",
    },
  })}\n`);
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

it("orders settled publication permutations by activity sequence", () => {
  const publicationOrder = [4, 2, 1, 3];
  const events: SettledActivityEvent[] = publicationOrder.map((sequence) => ({
    schema: 1,
    childId: "child-1",
    sequence,
    recordedAt: 1000 - sequence,
    assistantId: `assistant-${sequence}`,
    outcome: "clean",
  }));
  assert.deepEqual(
    orderSettledActivityEvents(events).map((event) => event.sequence),
    [1, 2, 3, 4],
  );
});

describe("settled observer boundaries", () => {
  it("keeps settled turns local and only consumes an intentional abort boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "settled-local-only-"));
    try {
      const sent: unknown[] = [];
      subagents(createApi((message) => sent.push(message)));
      __test__.runningSubagents.clear();
      const running = makeRunning(root, [
        { id: "assistant-abort", text: "", stopReason: "aborted" },
        { id: "assistant-one", text: "ONE" },
        { id: "assistant-two", text: "TWO" },
      ], [
        { sequence: 1, outcome: "intentional-abort", stopReason: "aborted", empty: true },
        { sequence: 2, outcome: "clean" },
        { sequence: 3, outcome: "clean" },
      ]);
      running.lifecycle = markInterruptRequested(running.lifecycle, 10);
      __test__.runningSubagents.set(running.id, running);
      __test__.observeRunningSubagent(running);
      await flush();
      assert.deepEqual(sent, [], "settled boundaries must never publish a parent result");
      assert.notEqual(running.lifecycle.turn.kind, "interrupted", "the abort boundary consumes interrupt intent");
    } finally {
      __test__.runningSubagents.clear();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it(
    "correlates terminal subagent_done tool calls with the latest settled assistant",
    () => {
      const root = mkdtempSync(join(tmpdir(), "settled-terminal-identity-"));
      try {
        const running = makeRunning(
          root,
          [
            { id: "assistant-one", text: "ONE" },
            { id: "assistant-two", text: "TWO" },
          ],
          [
            { sequence: 1, outcome: "clean", assistantId: "assistant-1" },
            { sequence: 2, outcome: "clean", assistantId: "assistant-1" },
          ],
        );
        appendToolCall(running.sessionFile, "subagent-done-tool-call");
        assert.deepEqual(__test__.terminalAssistantIdentityFor(running), {
          childId: "child",
          sessionFile: running.sessionFile,
          assistantEntryId: "assistant-two",
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );


  it("retries terminal release when the descendant drains after observation", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "settled-terminal-drain-"));
    try {
      const owner = registerLineage({ artifactDir: rootDir, nodeId: "owner" });
      const running = { id: owner.nodeId, lineage: owner };
      appendLineageEvent(owner.rootDir, "launch:descendant", "launch", "descendant", {
        parentNodeId: owner.nodeId,
      });

      let resolved = false;
      const pending = __test__.waitForDescendantDrain(running).then(() => {
        resolved = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(resolved, false);

      appendLineageEvent(owner.rootDir, "terminal:descendant", "terminal", "descendant", {
        outcome: "done",
      });
      appendLineageEvent(owner.rootDir, "terminal-delivered:descendant", "terminal_delivered", "descendant");
      await pending;
      assert.equal(resolved, true);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
