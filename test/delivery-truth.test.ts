/**
 * TS-06 (widget truth) and TS-07 (observable unbounded drain wait).
 *
 * Two seams are exercised here:
 *
 * - `pi-extension/subagents/lifecycle.ts` — the existing widget projection. At
 *   `eacd653` it reports `completed` as soon as completion is detected, no
 *   matter whether the result ever reached the exact parent session. That is
 *   the R57-7 defect and the behavioural RED captured below.
 * - `pi-extension/subagents/delivery.ts` and `delivery-drain.ts` — the new
 *   projection, transaction, and drain seams (capability absent at `eacd653`).
 *
 * Frozen contract for the Coder:
 *
 * ```ts
 * export function projectDeliveryState(facts: {
 *   hasInbox?: boolean;
 *   materialized?: boolean;
 *   failure?: string;
 *   resultPath?: string;
 * }): DeliveryProjection;            // none | delivery-pending | delivery-failed | delivered
 *
 * export async function runDeliveryTransaction(input: {
 *   sessionsDir: string;
 *   childSessionId: string;
 *   childSessionFile?: string;
 *   deliveryId: string;
 *   status: DeliveryStatus;
 *   agentName: string;
 *   answer?: string;
 *   parent: { sessionId: string; sessionFile: string; active: boolean };
 *   sidecarPath?: string;
 *   now?: () => number;
 *   sinks?: {
 *     materializeResultFile?: (input) => { path: string; sequence: number };
 *     publishInbox?: (payload) => boolean;
 *     acknowledgeSidecar?: (path: string) => void;
 *     claimMaterialization?: () => { status: "acquired" | "materialized" | "busy"; token?: string };
 *     completeMaterialization?: (token: string) => boolean;
 *     releaseMaterialization?: (token: string) => void;
 *     sendSteer?: (payload: string) => void;
 *     log?: (event: string, fields?: Record<string, unknown>) => void;
 *     projectWidget?: (projection: DeliveryProjection) => void;
 *   };
 * }): Promise<{ projection: DeliveryProjection; resultPath?: string }>;
 *
 * export async function waitForDeliveryDrain(options: {
 *   isDrained: () => boolean;
 *   delay?: (ms: number) => Promise<void>;   // injected wait seam, no real timers
 *   now?: () => number;                      // injected clock
 *   onWaitOpen?: (info: { waitedSince: number }) => void;
 *   onWaitRelease?: (info: { waitedSince: number; waitedMs: number }) => void;
 *   signal?: AbortSignal;
 * }): Promise<void>;
 * ```
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createLifecycle,
	markCompleted,
	markCompletionDetected,
	markDelivery,
	projectLifecycle,
} from "../pi-extension/subagents/lifecycle.ts";
import {
	loadSeam,
	requireExport,
	requireSeam,
	type DeliveryProjection,
	type DeliveryStatus,
} from "./delivery-seam-support.ts";

const DELIVERY_SEAM = "../pi-extension/subagents/delivery.ts";
const DRAIN_SEAM = "../pi-extension/subagents/delivery-drain.ts";

interface LogCall {
	event: string;
	fields?: Record<string, unknown>;
}

/** Test doubles for one transaction run; every sink is injected, never a production branch. */
function transactionHarness(options: {
	fail?: "result-file" | "inbox" | "claim" | "steer" | "log" | "widget";
} = {}) {
	const calls: string[] = [];
	const logCalls: LogCall[] = [];
	const widgetProjections: DeliveryProjection[] = [];
	const acknowledged: string[] = [];
	const released: string[] = [];
	const completed: string[] = [];
	return {
		calls,
		logCalls,
		widgetProjections,
		acknowledged,
		released,
		completed,
		sinks: {
			materializeResultFile(input: {
				sessionsDir: string;
				childSessionId: string;
				deliveryId: string;
				status: DeliveryStatus;
				agentName: string;
				answer?: string;
				now: number;
			}) {
				calls.push("materializeResultFile");
				if (options.fail === "result-file") throw new Error("result file write failed");
				return {
					path: `${input.sessionsDir}/${input.childSessionId}/01-${input.status}.md`,
					sequence: 1,
					filename: `01-${input.status}.md`,
				};
			},
			publishInbox() {
				calls.push("publishInbox");
				if (options.fail === "inbox") throw new Error("inbox publication failed");
				return true;
			},
			acknowledgeSidecar(path: string) {
				calls.push("acknowledgeSidecar");
				acknowledged.push(path);
			},
			claimMaterialization() {
				calls.push("claimMaterialization");
				if (options.fail === "claim") throw new Error("claim failed");
				return { status: "acquired", token: "claim-token" };
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
				if (options.fail === "steer") throw new Error("steer delivery failed");
				return payload;
			},
			log(event: string, fields?: Record<string, unknown>) {
				if (options.fail === "log") throw new Error("log write failed");
				logCalls.push({ event, fields });
			},
			projectWidget(projection: DeliveryProjection) {
				if (options.fail === "widget") throw new Error("widget refresh failed");
				widgetProjections.push(projection);
			},
		},
	};
}

async function loadProject(): Promise<
	(facts: {
		hasInbox?: boolean;
		materialized?: boolean;
		failure?: string;
		resultPath?: string;
	}) => DeliveryProjection
> {
	const seam = requireSeam(await loadSeam(DELIVERY_SEAM), DELIVERY_SEAM);
	return requireExport<any>(seam, "projectDeliveryState", DELIVERY_SEAM);
}

async function loadTransaction(): Promise<
	(input: Record<string, unknown>) => Promise<{
		projection: DeliveryProjection;
		resultPath?: string;
	}>
> {
	const seam = requireSeam(await loadSeam(DELIVERY_SEAM), DELIVERY_SEAM);
	return requireExport<any>(seam, "runDeliveryTransaction", DELIVERY_SEAM);
}

describe("TS-06 widget truth at the existing lifecycle seam", () => {
	it("TS-06 does not project a completed delivery while materialization is pending", () => {
		const detected = markCompletionDetected(
			createLifecycle(1_000),
			{ reason: "done", exitCode: 0, summary: "captured answer" },
			2_000,
		);
		const lifecycle = markCompleted(detected, 3_000);

		assert.equal(lifecycle.delivery, "pending", "no delivery was materialized");
		const projection = projectLifecycle(lifecycle, 4_000);
		assert.notEqual(
			projection.kind,
			"completed",
			"the widget must not claim a finished delivery before exact-parent materialization",
		);
	});

	it("TS-06 keeps the completed projection once the delivery is materialized", () => {
		const lifecycle = markDelivery(
			markCompleted(
				markCompletionDetected(
					createLifecycle(1_000),
					{ reason: "done", exitCode: 0, summary: "captured answer" },
					2_000,
				),
				3_000,
			),
			"delivered",
		);

		assert.equal(projectLifecycle(lifecycle, 4_000).kind, "completed");
	});
});

describe("TS-06 delivery projection from durable facts", () => {
	it("TS-06 projects pending, failed, and delivered from the ledger", async () => {
		const project = await loadProject();

		assert.equal(project({ hasInbox: false }).state, "none");
		assert.equal(project({ hasInbox: true }).state, "delivery-pending");
		assert.equal(
			project({ hasInbox: true, materialized: false }).state,
			"delivery-pending",
		);
		assert.equal(
			project({ hasInbox: true, materialized: true }).state,
			"delivered",
		);

		const failed = project({
			hasInbox: true,
			materialized: false,
			failure: "steer delivery failed",
		});
		assert.equal(failed.state, "delivery-failed");
		assert.match(failed.error ?? "", /steer delivery failed/);
	});
});

describe("TS-06 loud failures at the delivery transaction seam", () => {
	for (const failure of ["result-file", "inbox", "claim", "steer"] as const) {
		it(`TS-06 records one attributable failure and one widget projection when ${failure} fails`, async () => {
			const runDeliveryTransaction = await loadTransaction();
			const harness = transactionHarness({ fail: failure });

			const result = await runDeliveryTransaction({
				sessionsDir: "/tmp/sessions",
				childSessionId: "9b5db0d9",
				childSessionFile: "/tmp/sessions/9b5db0d9.jsonl",
				deliveryId: "terminal:9b5db0d9",
				status: "completed",
				agentName: "reviewer",
				answer: "captured answer",
				parent: {
					sessionId: "parent-session",
					sessionFile: "/tmp/sessions/parent.jsonl",
					active: true,
				},
				now: () => 1_788_247_000_000,
				sinks: harness.sinks,
			});

			assert.equal(result.projection.state, "delivery-failed");
			assert.ok(
				result.projection.error,
				"the failure is attributable from the projection",
			);
			const failureRecords = harness.logCalls.filter((call) =>
				/fail|error/i.test(call.event),
			);
			assert.equal(
				failureRecords.length,
				1,
				`exactly one failure log record for ${failure}`,
			);
			assert.equal(
				harness.widgetProjections.filter(
					(projection) => projection.state === "delivery-failed",
				).length,
				1,
				`exactly one widget projection for ${failure}`,
			);
			assert.ok(
				JSON.stringify(failureRecords[0]).includes("failed"),
				"the log record names the failed step",
			);
		});
	}

	it("TS-06 keeps a throwing logger or widget inside the transaction", async () => {
		const runDeliveryTransaction = await loadTransaction();
		const hostErrors: unknown[] = [];
		const onUnhandled = (error: unknown) => hostErrors.push(error);
		process.on("unhandledRejection", onUnhandled);
		process.on("uncaughtException", onUnhandled);
		try {
			for (const fail of ["log", "widget"] as const) {
				const harness = transactionHarness({ fail });
				const result = await runDeliveryTransaction({
					sessionsDir: "/tmp/sessions",
					childSessionId: "9b5db0d9",
					deliveryId: "terminal:9b5db0d9",
					status: "completed",
					agentName: "reviewer",
					answer: "captured answer",
					parent: {
						sessionId: "parent-session",
						sessionFile: "/tmp/sessions/parent.jsonl",
						active: true,
					},
					now: () => 1_788_247_000_000,
					sinks: harness.sinks,
				});
				assert.equal(
					result.projection.state,
					"delivered",
					`a failing ${fail} must not break the delivery itself`,
				);
				assert.ok(harness.calls.includes("sendSteer"));
			}
			// Bounded by the transaction above; no fixed sleep anywhere.
			await new Promise((resolve) => setImmediate(resolve));
			assert.deepEqual(hostErrors, [], "no failure escaped into the Pi host");
		} finally {
			process.off("unhandledRejection", onUnhandled);
			process.off("uncaughtException", onUnhandled);
		}
	});
});

describe("TS-07 observable unbounded drain wait", () => {
	it("TS-07 records one wait-open and one wait-release around the gate", async () => {
		const seam = requireSeam(await loadSeam(DRAIN_SEAM), DRAIN_SEAM);
		const waitForDeliveryDrain = requireExport<any>(
			seam,
			"waitForDeliveryDrain",
			DRAIN_SEAM,
		);
		const events: string[] = [];
		let polls = 0;
		let clock = 0;
		const isDrained = () => {
			polls += 1;
			return polls >= 4;
		};

		await waitForDeliveryDrain({
			isDrained,
			delay: async () => {
				events.push("poll");
			},
			now: () => {
				clock += 60 * 60 * 1000; // one hour per tick, far past any plausible bound
				return clock;
			},
			onWaitOpen: () => events.push("wait-open"),
			onWaitRelease: () => events.push("wait-release"),
		});

		assert.equal(events[0], "wait-open", "the wait announces itself before polling");
		assert.equal(events[events.length - 1], "wait-release");
		assert.equal(events.filter((event) => event === "wait-open").length, 1);
		assert.equal(events.filter((event) => event === "wait-release").length, 1);
		assert.ok(clock >= 60 * 60 * 1000, "no bound fired while the gate was held");
	});

	it("TS-07 keeps the drain wait unbounded under a long gate", async () => {
		const seam = requireSeam(await loadSeam(DRAIN_SEAM), DRAIN_SEAM);
		const waitForDeliveryDrain = requireExport<any>(
			seam,
			"waitForDeliveryDrain",
			DRAIN_SEAM,
		);
		let polls = 0;
		let released = false;

		await waitForDeliveryDrain({
			isDrained: () => {
				polls += 1;
				if (polls >= 500) released = true;
				return released;
			},
			delay: async () => {},
			now: () => 1_788_247_000_000 + polls * 1000,
			onWaitOpen: () => {},
			onWaitRelease: () => {},
		});

		assert.equal(released, true, "the wait finished by release, not by a bound");
		assert.ok(polls >= 500, `expected at least 500 polls, saw ${polls}`);
	});
});
