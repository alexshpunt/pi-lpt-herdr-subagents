import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import subagents, { __test__ } from "../pi-extension/subagents/index.ts";
import { createLifecycle, markInterruptRequested } from "../pi-extension/subagents/lifecycle.ts";

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

function writeSession(sessionFile: string, messages: Array<{ id: string; text: string; stopReason?: string }>) {
  const lines = [JSON.stringify({ type: "session", id: "baseline" })];
  for (const message of messages) {
    lines.push(JSON.stringify({
      type: "message",
      id: message.id,
      message: {
        role: "assistant",
        content: [{ type: "text", text: message.text }],
        stopReason: message.stopReason ?? "stop",
      },
    }));
  }
  writeFileSync(sessionFile, `${lines.join("\n")}\n`);
}

function writeEvents(eventsFile: string, events: Array<{ sequence: number; outcome: string }>) {
  for (const event of events) {
    appendFileSync(eventsFile, `${JSON.stringify({
      schema: 1,
      childId: "child",
      sequence: event.sequence,
      recordedAt: event.sequence,
      outcome: event.outcome,
      empty: false,
    })}\n`);
  }
}

function makeRunning(root: string, messages: Array<{ id: string; text: string; stopReason?: string }>, events: Array<{ sequence: number; outcome: string }>) {
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

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

describe("settled observer boundaries", () => {
  it("retries an older no-id boundary after a later boundary succeeds", async () => {
    const root = mkdtempSync(join(tmpdir(), "settled-observer-"));
    try {
      const sent: string[] = [];
      let first = true;
      const api = createApi((message) => {
        if (first) {
          first = false;
          throw new Error("send failed");
        }
        sent.push(message.details?.text ?? "");
      });
      subagents(api);
      __test__.runningSubagents.clear();
      const running = makeRunning(root, [
        { id: "assistant-one", text: "ONE" },
        { id: "assistant-two", text: "TWO" },
      ], [{ sequence: 1, outcome: "clean" }, { sequence: 2, outcome: "clean" }]);
      __test__.runningSubagents.set(running.id, running);
      __test__.observeRunningSubagent(running);
      await flush();
      __test__.observeRunningSubagent(running);
      await flush();
      assert.deepEqual(sent, ["TWO", "ONE"]);
    } finally {
      __test__.runningSubagents.clear();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("consumes interrupt intent at the abort boundary and delivers rapid clean recovery", async () => {
    const root = mkdtempSync(join(tmpdir(), "settled-interrupt-"));
    try {
      const sent: string[] = [];
      const api = createApi((message) => sent.push(message.details?.text ?? ""));
      subagents(api);
      __test__.runningSubagents.clear();
      const running = makeRunning(root, [
        { id: "assistant-abort", text: "", stopReason: "aborted" },
        { id: "assistant-clean", text: "RECOVERED" },
      ], [{ sequence: 1, outcome: "unexpected-abort" }, { sequence: 2, outcome: "clean" }]);
      running.lifecycle = markInterruptRequested(running.lifecycle, 10);
      __test__.runningSubagents.set(running.id, running);
      __test__.observeRunningSubagent(running);
      await flush();
      assert.deepEqual(sent, ["RECOVERED"]);
    } finally {
      __test__.runningSubagents.clear();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
