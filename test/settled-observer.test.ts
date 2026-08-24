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

  it("keeps rapid fallback boundaries on clean final assistants after tool-use entries", async () => {
    const root = mkdtempSync(join(tmpdir(), "settled-fallback-correlation-"));
    try {
      const sent: string[] = [];
      const api = createApi((message) => sent.push(message.details?.text ?? ""));
      subagents(api);
      __test__.runningSubagents.clear();
      const running = makeRunning(root, [
        { id: "assistant-tool-one", text: "", stopReason: "toolUse", toolUse: true },
        { id: "assistant-final-one", text: "FIRST TEXT", stopReason: "stop" },
        { id: "assistant-tool-two", text: "", stopReason: "toolUse", toolUse: true },
        { id: "assistant-final-two", text: "SECOND TEXT", stopReason: "stop" },
      ], [
        { sequence: 113, outcome: "clean", assistantId: "assistant-3", stopReason: "stop" },
        { sequence: 126, outcome: "clean", assistantId: "assistant-4", stopReason: "stop" },
      ]);
      __test__.runningSubagents.set(running.id, running);
      __test__.observeRunningSubagent(running);
      await flush();
      assert.deepEqual(sent, ["FIRST TEXT", "SECOND TEXT"]);
    } finally {
      __test__.runningSubagents.clear();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses outcome evidence for no-id empty, error, and abort boundaries", async () => {
    const root = mkdtempSync(join(tmpdir(), "settled-outcome-correlation-"));
    try {
      const sent: Array<{ outcome: string; text: string | null }> = [];
      const api = createApi((message) => sent.push({
        outcome: message.details?.outcome,
        text: message.details?.text ?? null,
      }));
      subagents(api);
      __test__.runningSubagents.clear();
      const running = makeRunning(root, [
        { id: "assistant-empty", text: "", stopReason: "stop" },
        { id: "assistant-error", text: "", stopReason: "error" },
        { id: "assistant-abort", text: "", stopReason: "aborted" },
      ], [
        { sequence: 1, outcome: "empty", stopReason: "stop", empty: true },
        { sequence: 2, outcome: "error", stopReason: "error", empty: true },
        { sequence: 3, outcome: "unexpected-abort", stopReason: "aborted", empty: true },
      ]);
      __test__.runningSubagents.set(running.id, running);
      __test__.observeRunningSubagent(running);
      await flush();
      assert.deepEqual(sent, [
        { outcome: "empty", text: null },
        { outcome: "error", text: null },
        { outcome: "unexpected-abort", text: null },
      ]);
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
      ], [{ sequence: 1, outcome: "unexpected-abort", empty: true }, { sequence: 2, outcome: "clean", empty: false }]);
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
});
