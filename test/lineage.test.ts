import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendLineageEvent,
  appendLineageInbox,
  claimLineageInboxMaterialization,
  completeLineageInboxMaterialization,
  discoverLineageRoots,
  hasUndrainedDescendants,
  hasLineageEvent,
  pendingLineageInboxes,
  isLineageNodeDrained,
  latestDescendantDeliveryAt,
  reduceLineage,
  registerLineage,
} from "../pi-extension/subagents/lineage.ts";

const tempRoot = () => mkdtempSync(join(tmpdir(), "pi-lineage-test-"));

const observerModule = new URL("../pi-extension/subagents/lineage.ts", import.meta.url).href;

function spawnObserver(options: {
  rootDir: string;
  deliveryId: string;
  nodeId: string;
  sessionFile: string;
  statusFile: string;
  sendLog: string;
  sendPath?: string;
  releasePath?: string;
  startedPath?: string;
  blockedPath?: string;
  mode: "hold" | "crash-before-send" | "crash-after-send" | "recover" | "ordered";
}): Promise<number> {
  const script = `
    import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
    const { claimLineageInboxMaterialization, completeLineageInboxMaterialization } = await import(${JSON.stringify(observerModule)});
    const config = JSON.parse(process.env.LINEAGE_OBSERVER_CONFIG);
    const evidence = () => { try { return readFileSync(config.sessionFile, "utf8").includes(config.deliveryId); } catch { return false; } };
    if (config.startedPath) writeFileSync(config.startedPath, "started");
    let claim = claimLineageInboxMaterialization({ rootDir: config.rootDir, deliveryId: config.deliveryId, nodeId: config.nodeId, hasExactSessionEvidence: evidence });
    if (config.blockedPath && claim.status === "busy") writeFileSync(config.blockedPath, "blocked");
    while (config.mode === "ordered" && claim.status === "busy") {
      await new Promise((resolve) => setTimeout(resolve, 5));
      claim = claimLineageInboxMaterialization({ rootDir: config.rootDir, deliveryId: config.deliveryId, nodeId: config.nodeId, hasExactSessionEvidence: evidence });
    }
    writeFileSync(config.statusFile, JSON.stringify(claim));
    if (claim.status !== "acquired") process.exit(0);
    if (config.mode === "crash-before-send") process.exit(0);
    if (config.mode === "hold") { while (!existsSync(config.sendPath)) await new Promise((resolve) => setTimeout(resolve, 5)); }
    appendFileSync(config.sendLog, config.deliveryId + "\\n");
    appendFileSync(config.sessionFile, config.deliveryId + "\\n");
    if (config.mode === "crash-after-send") process.exit(0);
    if (config.mode === "hold") while (!existsSync(config.releasePath)) await new Promise((resolve) => setTimeout(resolve, 5));
    completeLineageInboxMaterialization(config.rootDir, config.deliveryId, config.nodeId, claim.token);
  `;
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, LINEAGE_OBSERVER_CONFIG: JSON.stringify(options) },
    }, (error) => resolve(error?.code && typeof error.code === "number" ? error.code : 0));
    child.once("error", reject);
  });
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("reduces recursive ownership and drains only after delivery", () => {
  const root = registerLineage({ artifactDir: tempRoot(), nodeId: "root" });
  registerLineage({ artifactDir: tempRoot(), nodeId: "wrong-root" });
  registerLineage({ artifactDir: tempRoot(), nodeId: "unused" });
  appendLineageEvent(root.rootDir, "launch:child", "launch", "child", { parentNodeId: "root" });
  appendLineageEvent(root.rootDir, "launch:grandchild", "launch", "grandchild", { parentNodeId: "child" });
  assert.equal(hasUndrainedDescendants(reduceLineage(root.rootDir), "root"), true);
  appendLineageEvent(root.rootDir, "terminal:grandchild", "terminal", "grandchild", { outcome: "done" });
  appendLineageEvent(root.rootDir, "terminal-delivered:grandchild", "terminal_delivered", "grandchild");
  appendLineageEvent(root.rootDir, "terminal:child", "terminal", "child", { outcome: "done" });
  appendLineageEvent(root.rootDir, "terminal-delivered:child", "terminal_delivered", "child");
  appendLineageEvent(root.rootDir, "terminal:root", "terminal", "root", { outcome: "done" });
  appendLineageEvent(root.rootDir, "terminal-delivered:root", "terminal_delivered", "root");
  assert.equal(isLineageNodeDrained(reduceLineage(root.rootDir), "root"), true);
  assert.equal(appendLineageEvent(root.rootDir, "terminal:root", "terminal", "root"), false);
});

test("projects the latest delivery activity from recursive descendants", () => {
  const root = registerLineage({ artifactDir: tempRoot(), nodeId: "root" });
  appendLineageEvent(root.rootDir, "launch:child", "launch", "child", { parentNodeId: "root" });
  appendLineageEvent(root.rootDir, "launch:grandchild", "launch", "grandchild", { parentNodeId: "child" });
  appendLineageEvent(root.rootDir, "settled-delivered:child:1", "settled_delivered", "child", { resultId: "child-answer" });
  appendLineageEvent(root.rootDir, "materialized:grandchild", "inbox_materialized", "grandchild", { deliveryId: "grandchild-answer" });

  const state = reduceLineage(root.rootDir);
  assert.equal(
    latestDescendantDeliveryAt(state, "root"),
    Math.max(state.nodes.get("child")!.lastDeliveredAt!, state.nodes.get("grandchild")!.lastDeliveredAt!),
  );
  assert.equal(latestDescendantDeliveryAt(state, "grandchild"), undefined);
});

test("a durable inbox event satisfies terminal delivery once", () => {
  const root = registerLineage({ artifactDir: tempRoot(), nodeId: "owner" });
  appendLineageEvent(root.rootDir, "terminal:owner", "terminal", "owner", { outcome: "done" });
  assert.equal(
    appendLineageInbox(root.rootDir, "owner", "terminal:owner", {
      sessionId: "parent",
      sessionFile: "/tmp/parent.jsonl",
    }, { kind: "terminal", resultContent: "done" }),
    true,
  );
  assert.equal(appendLineageInbox(root.rootDir, "owner", "terminal:owner", {}), false);
  assert.equal(isLineageNodeDrained(reduceLineage(root.rootDir), "owner"), true);
  assert.equal(pendingLineageInboxes(root.rootDir, "parent", "/tmp/parent.jsonl").length, 1);
  appendLineageEvent(root.rootDir, "materialized:terminal:owner", "inbox_materialized", "owner", { deliveryId: "terminal:owner" });
  assert.equal(pendingLineageInboxes(root.rootDir, "parent", "/tmp/parent.jsonl").length, 0);
});

test("one durable claim serializes observers and recovers send/ack crashes", async () => {
  const dir = tempRoot();
  const sessionFile = join(dir, "parent.jsonl");
  const sendLog = join(dir, "sends.log");
  const root = registerLineage({ artifactDir: dir, nodeId: "owner", parentSessionId: "parent", parentSessionFile: sessionFile });
  writeFileSync(sessionFile, "");
  const addInbox = (deliveryId: string, sequence: number) => {
    assert.equal(appendLineageInbox(root.rootDir, "owner", deliveryId, {
      sessionId: "parent", sessionFile,
    }, { kind: "settled", resultContent: deliveryId, activitySequence: sequence }), true);
  };
  addInbox("settled:owner:1", 1);
  const statusOne = join(dir, "observer-one.json");
  const sendGate = join(dir, "send-now");
  const release = join(dir, "release");
  const observerOne = spawnObserver({ rootDir: root.rootDir, deliveryId: "settled:owner:1", nodeId: "owner", sessionFile, statusFile: statusOne, sendLog, sendPath: sendGate, releasePath: release, mode: "hold" });
  await waitForFile(statusOne);
  const firstClaim = JSON.parse(readFileSync(statusOne, "utf8")) as { status: string; token?: string };
  assert.equal(firstClaim.status, "acquired");
  assert.equal(typeof firstClaim.token, "string");
  const statusTwo = join(dir, "observer-two.json");
  const observerTwo = spawnObserver({ rootDir: root.rootDir, deliveryId: "settled:owner:1", nodeId: "owner", sessionFile, statusFile: statusTwo, sendLog, mode: "recover" });
  await waitForFile(statusTwo);
  assert.deepEqual(JSON.parse(readFileSync(statusTwo, "utf8")), { status: "busy" });
  writeFileSync(sendGate, "");
  await waitForFile(sendLog);
  writeFileSync(release, "");
  assert.equal(await observerOne, 0);
  assert.equal(await observerTwo, 0);
  assert.equal(readFileSync(sendLog, "utf8").trim().split("\n").length, 1);
  assert.equal(isLineageNodeDrained(reduceLineage(root.rootDir), "owner"), false);

  addInbox("settled:owner:2", 2);
  const crashBeforeStatus = join(dir, "crash-before-status.json");
  assert.equal(await spawnObserver({ rootDir: root.rootDir, deliveryId: "settled:owner:2", nodeId: "owner", sessionFile, statusFile: crashBeforeStatus, sendLog, mode: "crash-before-send" }), 0);
  const recoveredStatus = join(dir, "recovered-status.json");
  assert.equal(await spawnObserver({ rootDir: root.rootDir, deliveryId: "settled:owner:2", nodeId: "owner", sessionFile, statusFile: recoveredStatus, sendLog, mode: "recover" }), 0);
  assert.equal((JSON.parse(readFileSync(recoveredStatus, "utf8")) as { status: string }).status, "acquired");

  addInbox("settled:owner:3", 3);
  const crashAfterStatus = join(dir, "crash-after-status.json");
  assert.equal(await spawnObserver({ rootDir: root.rootDir, deliveryId: "settled:owner:3", nodeId: "owner", sessionFile, statusFile: crashAfterStatus, sendLog, mode: "crash-after-send" }), 0);
  const ackRecoveryStatus = join(dir, "ack-recovery-status.json");
  assert.equal(await spawnObserver({ rootDir: root.rootDir, deliveryId: "settled:owner:3", nodeId: "owner", sessionFile, statusFile: ackRecoveryStatus, sendLog, mode: "recover" }), 0);
  assert.deepEqual(JSON.parse(readFileSync(ackRecoveryStatus, "utf8")), { status: "materialized" });
  assert.deepEqual(readFileSync(sendLog, "utf8").trim().split("\n"), ["settled:owner:1", "settled:owner:2", "settled:owner:3"]);
  const session = readFileSync(sessionFile, "utf8");
  assert.ok(session.indexOf("settled:owner:1") < session.indexOf("settled:owner:2"));
  assert.ok(session.indexOf("settled:owner:2") < session.indexOf("settled:owner:3"));
});


test("orders independent materialization observers through a shared lineage gate", async () => {
  const dir = tempRoot();
  const sessionFile = join(dir, "parent.jsonl");
  const sendLog = join(dir, "ordered-sends.log");
  const root = registerLineage({ artifactDir: dir, nodeId: "owner", parentSessionId: "parent", parentSessionFile: sessionFile });
  writeFileSync(sessionFile, "");
  const addInbox = (deliveryId: string, sequence: number) => {
    assert.equal(appendLineageInbox(root.rootDir, "owner", deliveryId, { sessionId: "parent", sessionFile }, { kind: "settled", resultContent: deliveryId, activitySequence: sequence }), true);
  };
  addInbox("settled:owner:1", 1);
  addInbox("settled:owner:2", 2);
  const laterStarted = join(dir, "later-started");
  const laterBlocked = join(dir, "later-blocked");
  const laterStatus = join(dir, "later-status.json");
  const later = spawnObserver({ rootDir: root.rootDir, deliveryId: "settled:owner:2", nodeId: "owner", sessionFile, statusFile: laterStatus, startedPath: laterStarted, blockedPath: laterBlocked, sendLog, mode: "ordered" });
  await waitForFile(laterStarted);
  await waitForFile(laterBlocked);
  const earlierStatus = join(dir, "earlier-status.json");
  const earlier = spawnObserver({ rootDir: root.rootDir, deliveryId: "settled:owner:1", nodeId: "owner", sessionFile, statusFile: earlierStatus, sendLog, mode: "ordered" });
  await waitForFile(earlierStatus);
  assert.equal((JSON.parse(readFileSync(earlierStatus, "utf8")) as { status: string }).status, "acquired");
  assert.equal(await earlier, 0);
  assert.equal(await later, 0);
  assert.deepEqual(readFileSync(sendLog, "utf8").trim().split("\n"), ["settled:owner:1", "settled:owner:2"]);
  assert.ok(readFileSync(sessionFile, "utf8").indexOf("settled:owner:1") < readFileSync(sessionFile, "utf8").indexOf("settled:owner:2"));
});

test("keeps error and terminal inbox materialization behind earlier activity", () => {
  const dir = tempRoot();
  const sessionFile = join(dir, "parent.jsonl");
  const root = registerLineage({ artifactDir: dir, nodeId: "owner", parentSessionId: "parent", parentSessionFile: sessionFile });
  writeFileSync(sessionFile, "");
  const inbox = (deliveryId: string, payload: Record<string, unknown>) =>
    assert.equal(appendLineageInbox(root.rootDir, "owner", deliveryId, { sessionId: "parent", sessionFile }, payload), true);
  inbox("error:owner:1", { kind: "settled", resultContent: "error", activitySequence: 1 });
  inbox("settled:owner:2", { kind: "settled", resultContent: "later", activitySequence: 2 });
  inbox("terminal:owner", { kind: "terminal", resultContent: "done" });
  assert.equal(claimLineageInboxMaterialization({ rootDir: root.rootDir, deliveryId: "terminal:owner", nodeId: "owner", hasExactSessionEvidence: () => false }).status, "busy");
  for (const deliveryId of ["error:owner:1", "settled:owner:2", "terminal:owner"]) {
    const claim = claimLineageInboxMaterialization({ rootDir: root.rootDir, deliveryId, nodeId: "owner", hasExactSessionEvidence: () => false });
    assert.equal(claim.status, "acquired");
    if (claim.status === "acquired") assert.equal(completeLineageInboxMaterialization(root.rootDir, deliveryId, "owner", claim.token), true);
  }
});

test("reclaims a claim when the same PID has a different process incarnation", () => {
  const dir = tempRoot();
  const sessionFile = join(dir, "parent.jsonl");
  const root = registerLineage({ artifactDir: dir, nodeId: "owner", parentSessionId: "parent", parentSessionFile: sessionFile });
  writeFileSync(sessionFile, "");
  assert.equal(appendLineageInbox(root.rootDir, "owner", "settled:owner:reclaim", { sessionId: "parent", sessionFile }, { kind: "settled", resultContent: "reclaim", activitySequence: 1 }), true);
  const first = claimLineageInboxMaterialization({ rootDir: root.rootDir, deliveryId: "settled:owner:reclaim", nodeId: "owner", hasExactSessionEvidence: () => false, processIdentity: { pid: process.pid, startTime: "incarnation-one" } });
  assert.equal(first.status, "acquired");
  if (first.status !== "acquired") return;
  const second = claimLineageInboxMaterialization({ rootDir: root.rootDir, deliveryId: "settled:owner:reclaim", nodeId: "owner", hasExactSessionEvidence: () => false, processIdentity: { pid: process.pid, startTime: "incarnation-two" } });
  assert.equal(second.status, "acquired");
});

test("discovers roots from authoritative child attachments", () => {
  const sessionDir = tempRoot();
  const root = registerLineage({ artifactDir: sessionDir, nodeId: "child" });
  const sessionFile = join(sessionDir, "child.jsonl");
  writeFileSync(`${sessionFile}.lineage.json`, JSON.stringify(root));
  const roots = discoverLineageRoots(sessionDir, sessionFile);
  assert.deepEqual(roots, [root.rootDir]);
});

test("ignores incomplete and invalid event files", () => {
  const root = registerLineage({ artifactDir: tempRoot(), nodeId: "node" });
  writeFileSync(join(root.rootDir, "events", ".pending"), "{");
  writeFileSync(join(root.rootDir, "events", "invalid.json"), "{}", "utf8");
  assert.equal(reduceLineage(root.rootDir).nodes.has("node"), true);
});


test("restores cancellation intent and exact process identity after restart", () => {
  const root = registerLineage({ artifactDir: tempRoot(), nodeId: "cancel-me" });
  appendLineageEvent(root.rootDir, "cancel-intent:cancel-me", "cancel_intent", "cancel-me", { surface: "pane-1" });
  appendLineageEvent(root.rootDir, "cancel-identity:cancel-me", "cancel_identity", "cancel-me", { surface: "pane-1", pids: [123, 456] });
  const restored = reduceLineage(root.rootDir).nodes.get("cancel-me");
  assert.deepEqual(restored?.cancellation, { intent: true, surface: "pane-1", pids: [123, 456], proven: false });
  appendLineageEvent(root.rootDir, "cancel-proven:cancel-me", "cancel_proven", "cancel-me", { surface: "pane-1", pids: [123, 456] });
  assert.equal(reduceLineage(root.rootDir).nodes.get("cancel-me")?.cancellation?.proven, true);
});

test("cleanup pending and acknowledgement use distinct durable effects", () => {
  const root = registerLineage({ artifactDir: tempRoot(), nodeId: "cleanup-me" });
  appendLineageEvent(root.rootDir, "terminal:cleanup-me", "terminal", "cleanup-me", { outcome: "done" });
  appendLineageEvent(root.rootDir, "terminal-delivered:cleanup-me", "terminal_delivered", "cleanup-me");
  appendLineageEvent(root.rootDir, "cleanup-pending:cleanup-me", "cleanup_pending", "cleanup-me", { error: "busy" });
  assert.equal(reduceLineage(root.rootDir).nodes.get("cleanup-me")?.cleanupPending, true);
  appendLineageEvent(root.rootDir, "cleanup-done:cleanup-me", "cleanup_done", "cleanup-me");
  const restored = reduceLineage(root.rootDir).nodes.get("cleanup-me");
  assert.equal(restored?.cleanupPending, false);
  assert.equal(hasLineageEvent(root.rootDir, "cleanup-pending:cleanup-me", "cleanup_pending"), true);
  assert.equal(hasLineageEvent(root.rootDir, "cleanup-done:cleanup-me", "cleanup_done"), true);
});
