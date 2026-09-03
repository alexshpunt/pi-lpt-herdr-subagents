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
  appendLineageEvent,
  registerLineage,
} from "../pi-extension/subagents/lineage.ts";
import {
  getSubagentActivityFile,
  getSubagentSettledEventsFile,
  readSubagentActivityFile,
  readSubagentSettledEventsFile,
} from "../pi-extension/subagents/activity.ts";

function createApi() {
  const handlers = new Map<
    string,
    Array<(event: unknown, ctx: unknown) => void | Promise<void>>
  >();
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
    async emitAsync(
      event: string,
      payload: unknown = {},
      ctx: unknown = { shutdown: () => { shutdowns += 1; } },
    ) {
      await Promise.all(
        (handlers.get(event) ?? []).map((handler) => handler(payload, ctx)),
      );
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


async function withOwnedDescendant(
  run: (paths: {
    session: string;
    descendantId: string;
    lineageRoot: string;
  }) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "settled-owner-descendant-"));
  const session = join(dir, "owner.jsonl");
  const owner = registerLineage({ artifactDir: dir, nodeId: "child-1" });
  const descendantId = "descendant-1";
  registerLineage({
    artifactDir: dir,
    nodeId: descendantId,
    parentNodeId: owner.nodeId,
    inheritedRootDir: owner.rootDir,
    inheritedRootId: owner.rootId,
  });
  appendLineageEvent(
    owner.rootDir,
    `metadata:${descendantId}:1`,
    "launch_metadata",
    descendantId,
    { autoExit: true, startTime: 1 },
  );
  const old = {
    autoExit: process.env.PI_SUBAGENT_AUTO_EXIT,
    session: process.env.PI_SUBAGENT_SESSION,
    id: process.env.PI_SUBAGENT_ID,
    activity: process.env.PI_SUBAGENT_ACTIVITY_FILE,
    settledEvents: process.env.PI_SUBAGENT_SETTLED_EVENTS_FILE,
    lineageDir: process.env.PI_SUBAGENT_LINEAGE_DIR,
    lineageRoot: process.env.PI_SUBAGENT_LINEAGE_ROOT,
  };
  process.env.PI_SUBAGENT_AUTO_EXIT = "1";
  process.env.PI_SUBAGENT_SESSION = session;
  process.env.PI_SUBAGENT_ID = owner.nodeId;
  process.env.PI_SUBAGENT_ACTIVITY_FILE = getSubagentActivityFile(dir, owner.nodeId);
  process.env.PI_SUBAGENT_SETTLED_EVENTS_FILE = getSubagentSettledEventsFile(dir, owner.nodeId);
  process.env.PI_SUBAGENT_LINEAGE_DIR = owner.rootDir;
  process.env.PI_SUBAGENT_LINEAGE_ROOT = owner.rootId;
  try {
    await run({ session, descendantId, lineageRoot: owner.rootDir });
  } finally {
    const values: Record<string, string | undefined> = {
      PI_SUBAGENT_AUTO_EXIT: old.autoExit,
      PI_SUBAGENT_SESSION: old.session,
      PI_SUBAGENT_ID: old.id,
      PI_SUBAGENT_ACTIVITY_FILE: old.activity,
      PI_SUBAGENT_SETTLED_EVENTS_FILE: old.settledEvents,
      PI_SUBAGENT_LINEAGE_DIR: old.lineageDir,
      PI_SUBAGENT_LINEAGE_ROOT: old.lineageRoot,
    };
    for (const [key, value] of Object.entries(values)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
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


  it("waits for a new settled turn after the last descendant result", async () => {
    await withOwnedDescendant(async ({ session, descendantId, lineageRoot }) => {
      const fake = createApi();
      subagentDoneExtension(fake.api);

      fake.emit("agent_end", { messages: [clean("owner-before-child")] });
      fake.emit("agent_settled");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(fake.shutdowns, 0);
      assert.equal(existsSync(`${session}.exit`), false);

      appendLineageEvent(
        lineageRoot,
        `terminal:${descendantId}`,
        "terminal",
        descendantId,
        { outcome: "success" },
      );
      appendLineageEvent(
        lineageRoot,
        `terminal-delivered:${descendantId}`,
        "terminal_delivered",
        descendantId,
        { deliveryId: `terminal:${descendantId}` },
      );
      await new Promise((resolve) => setTimeout(resolve, 100));

      assert.equal(
        fake.shutdowns,
        0,
        "descendant drain alone must not close its owner",
      );
      assert.equal(existsSync(`${session}.exit`), false);

      fake.emit("before_agent_start");
      fake.emit("agent_end", { messages: [clean("owner-after-child")] });
      await fake.emitAsync("agent_settled");

      assert.equal(fake.shutdowns, 1);
      assert.deepEqual(JSON.parse(readFileSync(`${session}.exit`, "utf8")), {
        type: "done",
      });
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
  it("settles after processing the last autonomous child before terminal delivery finishes", async () => {
    await withOwnedDescendant(async ({ session, descendantId, lineageRoot }) => {
      const fake = createApi();
      subagentDoneExtension(fake.api);

      fake.emit("agent_end", { messages: [clean("owner-before-child")] });
      fake.emit("agent_settled");
      assert.equal(fake.shutdowns, 0);

      fake.emit("message_start", {
        message: {
          customType: "subagent_result",
          content: "Subagent Descendant settled.",
          details: {
            kind: "settled",
            outcome: "clean",
            childId: descendantId,
          },
        },
      });
      fake.emit("before_agent_start");
      fake.emit("agent_end", { messages: [clean("owner-after-child")] });
      fake.emit("agent_settled");
      await new Promise((resolve) => setTimeout(resolve, 25));

      assert.equal(fake.shutdowns, 0);
      assert.equal(existsSync(`${session}.exit`), false);

      appendLineageEvent(
        lineageRoot,
        `terminal:${descendantId}`,
        "terminal",
        descendantId,
        { outcome: "success" },
      );
      appendLineageEvent(
        lineageRoot,
        `terminal-delivered:${descendantId}`,
        "terminal_delivered",
        descendantId,
        { deliveryId: `terminal:${descendantId}` },
      );
      await new Promise((resolve) => setTimeout(resolve, 150));

      assert.equal(fake.shutdowns, 1);
      assert.deepEqual(JSON.parse(readFileSync(`${session}.exit`, "utf8")), {
        type: "done",
      });
    });
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
