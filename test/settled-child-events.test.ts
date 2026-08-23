import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import subagentDoneExtension, {
  classifyAutoExitOutcome,
  newestAssistantEntry,
} from "../pi-extension/subagents/subagent-done.ts";
import {
  getSubagentActivityFile,
  getSubagentSettledEventsFile,
  readSubagentActivityFile,
  readSubagentSettledEventsFile,
} from "../pi-extension/subagents/activity.ts";

function createApi() {
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
  let shutdowns = 0;
  const api = {
    on(event: string, handler: (event: unknown, ctx: unknown) => void) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool() {},
    registerShortcut() {},
    getAllTools() { return []; },
  } as any;
  return {
    api,
    get shutdowns() { return shutdowns; },
    emit(event: string, payload: unknown = {}, ctx: unknown = { shutdown: () => { shutdowns += 1; } }) {
      for (const handler of handlers.get(event) ?? []) handler(payload, ctx);
    },
  };
}

function withChildEnv(
  run: (paths: { dir: string; session: string; activity: string; settledEvents: string }) => void,
  autoExit = true,
) {
  const dir = mkdtempSync(join(tmpdir(), "settled-child-events-"));
  const session = join(dir, "child.jsonl");
  const activity = getSubagentActivityFile(dir, "child-1");
  const settledEvents = getSubagentSettledEventsFile(dir, "child-1");
  const old = {
    autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
    session: process.env.PI_SUBAGENT_SESSION,
    id: process.env.PI_SUBAGENT_ID,
    activity: process.env.PI_SUBAGENT_ACTIVITY_FILE,
    settledEvents: process.env.PI_SUBAGENT_SETTLED_EVENTS_FILE,
  };
  process.env.PI_SUBAGENT_AUTO_EXIT = autoExit ? "1" : "0";
  process.env.PI_SUBAGENT_SESSION = session;
  process.env.PI_SUBAGENT_ID = "child-1";
  process.env.PI_SUBAGENT_ACTIVITY_FILE = activity;
  process.env.PI_SUBAGENT_SETTLED_EVENTS_FILE = settledEvents;
  try {
    run({ dir, session, activity, settledEvents });
  } finally {
    for (const [key, value] of Object.entries({
      PI_SUBAGENT_AUTO_EXIT: old.autoExit,
      PI_SUBAGENT_SESSION: old.session,
      PI_SUBAGENT_ID: old.id,
      PI_SUBAGENT_ACTIVITY_FILE: old.activity,
      PI_SUBAGENT_SETTLED_EVENTS_FILE: old.settledEvents,
    })) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

const clean = (id = "assistant-1") => ({
  id,
  role: "assistant",
  stopReason: "stop",
  content: [{ type: "text", text: "settled response" }],
});

const empty = (id = "assistant-empty") => ({ id, role: "assistant", stopReason: "stop", content: [] });
const error = (id = "assistant-error") => ({ id, role: "assistant", stopReason: "error", errorMessage: "provider failed" });
const aborted = (id = "assistant-aborted") => ({ id, role: "assistant", stopReason: "aborted" });

describe("settled child event boundary", () => {
  it("does not shut down at agent_end and shuts down once at clean agent_settled", () => {
    withChildEnv(({ session, activity }) => {
      const fake = createApi();
      subagentDoneExtension(fake.api);
      fake.emit("turn_start", { turnIndex: 4 });
      fake.emit("agent_end", { messages: [clean()] });

      assert.equal(fake.shutdowns, 0);
      assert.equal(existsSync(`${session}.exit`), false);
      const waiting = readSubagentActivityFile(activity, "child-1");
      assert.equal(waiting.ok, true);
      if (waiting.ok) assert.equal(waiting.activity.latestEvent, "agent_end");

      fake.emit("agent_settled");
      assert.equal(fake.shutdowns, 1);
      assert.deepEqual(JSON.parse(readFileSync(`${session}.exit`, "utf8")), { type: "done" });
      const settled = readSubagentActivityFile(activity, "child-1");
      assert.equal(settled.ok, true);
      if (settled.ok) {
        assert.equal(settled.activity.latestEvent, "agent_settled");
        assert.equal(settled.activity.settledOutcome, "clean");
        assert.equal(settled.activity.turnIndex, 4);
      }
    });
  });

  it("records clean settled turns without closing a persistent child", () => {
    withChildEnv(({ session, activity }) => {
      const fake = createApi();
      subagentDoneExtension(fake.api);
      fake.emit("agent_end", { messages: [clean("assistant-one")] });
      fake.emit("agent_settled");
      fake.emit("agent_end", { messages: [clean("assistant-two")] });
      fake.emit("agent_settled");

      assert.equal(fake.shutdowns, 0);
      assert.equal(existsSync(`${session}.exit`), false);
      const settled = readSubagentActivityFile(activity, "child-1");
      assert.equal(settled.ok, true);
      if (settled.ok) {
        assert.equal(settled.activity.latestEvent, "agent_settled");
        assert.equal(settled.activity.settledOutcome, "clean");
        assert.equal(settled.activity.settledAssistantId, "assistant-two");
      }
    }, false);

  });


  it("appends every settled boundary and ignores an incomplete trailing record", () => {
    withChildEnv(({ settledEvents }) => {
      const fake = createApi();
      subagentDoneExtension(fake.api);
      fake.emit("agent_end", { messages: [clean("assistant-one")] });
      fake.emit("agent_settled");
      fake.emit("before_agent_start");
      fake.emit("agent_end", { messages: [clean("assistant-two")] });
      fake.emit("agent_settled");

      const events = readSubagentSettledEventsFile(settledEvents, "child-1");
      assert.deepEqual(events.map((event) => event.assistantId), ["assistant-one", "assistant-two"]);
      const raw = readFileSync(settledEvents, "utf8");
      appendFileSync(settledEvents, "{\"schema\":1");
      assert.deepEqual(
        readSubagentSettledEventsFile(settledEvents, "child-1").map((event) => event.assistantId),
        ["assistant-one", "assistant-two"],
      );
      assert.equal(raw.length > 0, true);
    }, false);
  });

  it("does not reuse prior agent_end evidence after a new run starts", () => {
    withChildEnv(({ session }) => {
      const fake = createApi();
      subagentDoneExtension(fake.api);
      fake.emit("agent_end", { messages: [clean("assistant-old")] });
      fake.emit("agent_settled");
      fake.emit("before_agent_start");
      fake.emit("agent_settled");
      assert.equal(fake.shutdowns, 0);
      assert.equal(existsSync(`${session}.exit`), false);
    }, false);
  });

  it("waits for the clean settled retry after an earlier error", () => {
    withChildEnv(({ session, activity }) => {
      const fake = createApi();
      subagentDoneExtension(fake.api);
      fake.emit("agent_end", { messages: [error()] });
      assert.equal(fake.shutdowns, 0);
      assert.equal(existsSync(`${session}.exit`), false);

      fake.emit("agent_end", { messages: [error(), clean("assistant-retry-clean")] });
      assert.equal(fake.shutdowns, 0);
      fake.emit("agent_settled");

      assert.equal(fake.shutdowns, 1);
      assert.deepEqual(JSON.parse(readFileSync(`${session}.exit`, "utf8")), { type: "done" });
      const settled = readSubagentActivityFile(activity, "child-1");
      assert.equal(settled.ok, true);
      if (settled.ok) assert.equal(settled.activity.settledOutcome, "clean");
    });
  });

  it("keeps error and abort outcomes open while recording settled evidence", () => {
    for (const [message, expected] of [[error(), "error"], [aborted(), "unexpected-abort"]] as const) {
      withChildEnv(({ session, activity }) => {
        const fake = createApi();
        subagentDoneExtension(fake.api);
        fake.emit("agent_end", { messages: [message] });
        fake.emit("agent_settled");

        assert.equal(fake.shutdowns, 0);
        assert.equal(existsSync(`${session}.exit`), false);
        const settled = readSubagentActivityFile(activity, "child-1");
        assert.equal(settled.ok, true);
        if (settled.ok) {
          assert.equal(settled.activity.latestEvent, "agent_settled");
          assert.equal(settled.activity.settledOutcome, expected);
          assert.equal(settled.activity.phase, "waiting");
        }
      });
    }
  });
});

describe("settled outcome classification", () => {
  it("classifies clean, empty, error, and aborted evidence", () => {
    assert.equal(classifyAutoExitOutcome([clean()]), "clean");
    assert.equal(classifyAutoExitOutcome([empty()]), "empty");
    assert.equal(classifyAutoExitOutcome([error()]), "error");
    assert.equal(classifyAutoExitOutcome([aborted()]), "unexpected-abort");
    assert.equal(classifyAutoExitOutcome([{ role: "user", content: [{ type: "text", text: "retry" }] }]), null);
    assert.equal(newestAssistantEntry([{ role: "assistant", ...clean() }])?.empty, false);
  });
});
