/**
 * TS-08 — completion evidence is acknowledged only after durable delivery.
 *
 * Two seams are exercised:
 *
 * - `pi-extension/subagents/completion.ts` — the existing exit-sidecar reader.
 *   At `eacd653` it removes the `.exit` sidecar as soon as it parses it
 *   (`rmSync` right after `interpretExitSidecar`), so a crash before the result
 *   file and the lineage inbox are durable loses the evidence forever. That is
 *   the R57-9 defect and the behavioural RED captured below.
 * - `pi-extension/subagents/delivery.ts` — the transaction seam that orders
 *   materialize → publish → acknowledge, then claim → steer → complete (capability absent at `eacd653`).
 *
 * Frozen contract for the Coder — see `test/delivery-truth.test.ts` for the
 * `runDeliveryTransaction` signature. Additional requirements frozen here:
 * - the sidecar is removed only after the result file and the inbox event are durable
 * - an injected failure before that boundary leaves the sidecar in place
 * - a second pass over the same delivery id neither re-sends nor re-writes
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { waitForCompletion } from "../pi-extension/subagents/completion.ts";
import {
	cleanupTempDirs,
	loadSeam,
	requireExport,
	requireSeam,
	tempDir,
	type DeliveryProjection,
} from "./delivery-seam-support.ts";

const DELIVERY_SEAM = "../pi-extension/subagents/delivery.ts";

type Transaction = (input: Record<string, unknown>) => Promise<{
	projection: DeliveryProjection;
	resultPath?: string;
}>;

async function loadTransaction(): Promise<Transaction> {
	const seam = requireSeam(await loadSeam(DELIVERY_SEAM), DELIVERY_SEAM);
	return requireExport<Transaction>(
		seam,
		"runDeliveryTransaction",
		DELIVERY_SEAM,
	);
}

/** Sink recorder with optional injected failures; the sinks are the test's own, never production. */
function harness(options: { fail?: "result-file" | "inbox" | "steer"; alreadyMaterialized?: boolean } = {}) {
	const calls: string[] = [];
	const acknowledged: string[] = [];
	const released: string[] = [];
	const completed: string[] = [];
	const steers: string[] = [];
	const inboxPayloads: unknown[] = [];
	let steerFailurePending = options.fail === "steer";
	return {
		calls,
		acknowledged,
		released,
		completed,
		steers,
		inboxPayloads,
		sinks: {
			materializeResultFile() {
				calls.push("materializeResultFile");
				if (options.fail === "result-file") throw new Error("result file write failed");
				return {
					path: "/tmp/sessions/9b5db0d9/01-completed.md",
					sequence: 1,
					filename: "01-completed.md",
				};
			},
			publishInbox(payload: unknown) {
				calls.push("publishInbox");
				inboxPayloads.push(payload);
				if (options.fail === "inbox") throw new Error("inbox publication failed");
				return true;
			},
			acknowledgeSidecar(path: string) {
				calls.push("acknowledgeSidecar");
				acknowledged.push(path);
				rmSync(path, { force: true });
			},
			claimMaterialization() {
				calls.push("claimMaterialization");
				return options.alreadyMaterialized
					? { status: "materialized" as const }
					: { status: "acquired" as const, token: "claim-token" };
			},
			completeMaterialization(token: string) {
				calls.push("completeMaterialization");
				completed.push(token);
				return true;
			},
			releaseMaterialization(token: string) {
				calls.push("releaseMaterialization");
				released.push(token);
			},
			sendSteer(payload: string) {
				calls.push("sendSteer");
				steers.push(payload);
				if (steerFailurePending) {
					steerFailurePending = false;
					throw new Error("steer delivery failed");
				}
			},
			log() {},
			projectWidget() {},
		},
	};
}

after(cleanupTempDirs);

describe("TS-08 durable delivery before acknowledgement", () => {
	it("TS-08 keeps the exit sidecar until the delivery acknowledges it", async () => {
		const dir = tempDir("pi-ts08-sidecar-");
		const sessionFile = join(dir, "child.jsonl");
		writeFileSync(sessionFile, "", "utf8");
		writeFileSync(
			`${sessionFile}.exit`,
			JSON.stringify({ type: "done", summary: "captured answer" }),
			"utf8",
		);

		const controller = new AbortController();
		const result = await waitForCompletion(controller.signal, {
			intervalMs: 5,
			readTerminalTail: async () => "",
			sessionFile,
		});

		assert.equal(result.reason, "done", "the sidecar was parsed");
		assert.ok(
			existsSync(`${sessionFile}.exit`),
			"the exit sidecar must survive until the durable delivery acknowledges it",
		);
	});

	it("TS-08 acknowledges the sidecar only after the result file and inbox are durable", async () => {
		const runDeliveryTransaction = await loadTransaction();
		const dir = tempDir("pi-ts08-order-");
		const sidecarPath = join(dir, "child.jsonl.exit");
		writeFileSync(sidecarPath, JSON.stringify({ type: "done" }), "utf8");
		const recorder = harness();

		const result = await runDeliveryTransaction({
			sessionsDir: dir,
			childSessionId: "9b5db0d9",
			deliveryId: "terminal:9b5db0d9",
			status: "completed",
			agentName: "reviewer",
			answer: "captured answer",
			sidecarPath,
			parent: {
				sessionId: "parent-session",
				sessionFile: join(dir, "parent.jsonl"),
				active: true,
			},
			now: () => 1_788_247_000_000,
			sinks: recorder.sinks,
		});

		assert.equal(result.projection.state, "delivered");
		const materialize = recorder.calls.indexOf("materializeResultFile");
		const publish = recorder.calls.indexOf("publishInbox");
		const acknowledge = recorder.calls.indexOf("acknowledgeSidecar");
		const claim = recorder.calls.indexOf("claimMaterialization");
		assert.ok(materialize >= 0, "the result file was materialized");
		assert.ok(publish > materialize, "the inbox is published after the result file");
		assert.ok(
			acknowledge > publish,
			"the sidecar is acknowledged only after result file and inbox are durable",
		);
		const steer = recorder.calls.indexOf("sendSteer");
		const complete = recorder.calls.indexOf("completeMaterialization");
		assert.ok(claim > acknowledge, "the exact-parent claim comes after the acknowledgement");
		assert.ok(steer > claim, "the exact-parent steer follows claim acquisition");
		assert.ok(complete > steer, "claim completion follows the exact-parent steer");
		assert.deepEqual(recorder.acknowledged, [sidecarPath]);
		assert.equal(recorder.inboxPayloads.length, 1, "the inbox receives one payload");
		for (const payload of [recorder.inboxPayloads[0], recorder.steers[0]]) {
			const text = typeof payload === "string" ? payload : JSON.stringify(payload);
			assert.ok(text?.includes("captured answer"), "payload carries the complete answer");
			assert.ok(text?.includes("/tmp/sessions/9b5db0d9/01-completed.md"), "payload carries the result path");
			assert.ok(text?.includes("9b5db0d9"), "payload carries the child session reference");
			assert.ok(text?.includes("terminal:9b5db0d9"), "payload carries the delivery id");
		}
		assert.deepEqual(recorder.completed, ["claim-token"]);
		assert.equal(recorder.released.length, 0, "a delivered claim is completed, not released");
	});

	it("TS-08 leaves the sidecar recoverable when materialization fails", async () => {
		const runDeliveryTransaction = await loadTransaction();
		const dir = tempDir("pi-ts08-crash-");
		const sidecarPath = join(dir, "child.jsonl.exit");
		writeFileSync(sidecarPath, JSON.stringify({ type: "done" }), "utf8");

		for (const fail of ["result-file", "inbox"] as const) {
			const recorder = harness({ fail });
			const result = await runDeliveryTransaction({
				sessionsDir: dir,
				childSessionId: "9b5db0d9",
				deliveryId: `terminal:9b5db0d9:${fail}`,
				status: "completed",
				agentName: "reviewer",
				answer: "captured answer",
				sidecarPath,
				parent: {
					sessionId: "parent-session",
					sessionFile: join(dir, "parent.jsonl"),
					active: true,
				},
				now: () => 1_788_247_000_000,
				sinks: recorder.sinks,
			});

			assert.equal(result.projection.state, "delivery-failed");
			assert.ok(
				existsSync(sidecarPath),
				`an injected ${fail} failure must leave the sidecar recoverable`,
			);
			assert.deepEqual(
				recorder.acknowledged,
				[],
				`an injected ${fail} failure must not acknowledge the retained sidecar`,
			);
		}
	});

	it("TS-08 releases an uncompleted claim when steer fails and retries", async () => {
		const runDeliveryTransaction = await loadTransaction();
		const dir = tempDir("pi-ts08-steer-retry-");
		const sidecarPath = join(dir, "child.jsonl.exit");
		writeFileSync(sidecarPath, JSON.stringify({ type: "done" }), "utf8");
		const input = {
			sessionsDir: dir,
			childSessionId: "9b5db0d9",
			deliveryId: "terminal:9b5db0d9:steer-retry",
			status: "completed" as const,
			agentName: "reviewer",
			answer: "captured answer",
			sidecarPath,
			parent: {
				sessionId: "parent-session",
				sessionFile: join(dir, "parent.jsonl"),
				active: true,
			},
			now: () => 1_788_247_000_000,
		};
		const recorder = harness({ fail: "steer" });

		const failed = await runDeliveryTransaction({ ...input, sinks: recorder.sinks });
		assert.equal(failed.projection.state, "delivery-failed");
		assert.deepEqual(recorder.completed, [], "a failed steer cannot complete the claim");
		assert.deepEqual(recorder.released, ["claim-token"], "a failed steer releases the claim for retry");

		const retried = await runDeliveryTransaction({ ...input, sinks: recorder.sinks });
		assert.equal(retried.projection.state, "delivered");
		assert.equal(recorder.completed.length, 1, "the retry completes the claim after a successful steer");
		assert.equal(recorder.steers.length, 2, "the failed steer is retried once");
	});

	it("TS-08 retries a failed pass once, then stays idempotent", async () => {
		const runDeliveryTransaction = await loadTransaction();
		const dir = tempDir("pi-ts08-once-");
		const sidecarPath = join(dir, "child.jsonl.exit");
		writeFileSync(sidecarPath, JSON.stringify({ type: "done" }), "utf8");
		const input = {
			sessionsDir: dir,
			childSessionId: "9b5db0d9",
			deliveryId: "terminal:9b5db0d9",
			status: "completed" as const,
			agentName: "reviewer",
			answer: "captured answer",
			sidecarPath,
			parent: {
				sessionId: "parent-session",
				sessionFile: join(dir, "parent.jsonl"),
				active: true,
			},
			now: () => 1_788_247_000_000,
		};

		const failed = harness({ fail: "result-file" });
		const first = await runDeliveryTransaction({ ...input, sinks: failed.sinks });
		assert.equal(first.projection.state, "delivery-failed");
		assert.equal(failed.steers.length, 0, "the failed pass sends no steer");
		assert.deepEqual(failed.acknowledged, [], "the failed pass does not acknowledge");
		assert.ok(existsSync(sidecarPath), "the failed pass leaves the sidecar for retry");

		const recovered = harness();
		const second = await runDeliveryTransaction({ ...input, sinks: recovered.sinks });
		assert.equal(second.projection.state, "delivered");
		assert.equal(recovered.steers.length, 1, "the next pass delivers exactly once");
		assert.deepEqual(recovered.acknowledged, [sidecarPath]);
		assert.equal(recovered.calls.filter((call) => call === "materializeResultFile").length, 1);
		assert.equal(recovered.calls.filter((call) => call === "publishInbox").length, 1);
		assert.equal(recovered.calls.filter((call) => call === "acknowledgeSidecar").length, 1);

		const duplicate = harness({ alreadyMaterialized: true });
		const third = await runDeliveryTransaction({ ...input, sinks: duplicate.sinks });
		assert.equal(third.projection.state, "delivered");
		assert.equal(duplicate.steers.length, 0, "a third detection pass delivers nothing");
		assert.equal(duplicate.calls.filter((call) => call === "materializeResultFile").length, 0);
		assert.equal(duplicate.calls.filter((call) => call === "publishInbox").length, 0);
		assert.equal(duplicate.calls.filter((call) => call === "acknowledgeSidecar").length, 0);
	});
});
