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
 *     claimMaterialization?: (parent: { sessionId: string; sessionFile: string }) => { status: "acquired" | "materialized" | "busy"; token?: string };
 *     completeMaterialization?: (token: string) => boolean;
 *     releaseMaterialization?: (token: string) => void;
 *     sendSteer?: (parent: { sessionId: string; sessionFile: string }, payload: string) => void;
 *     log?: (event: string, fields?: Record<string, unknown>) => void;
 *     projectWidget?: (projection: DeliveryProjection) => void;
 *     // Fallback sink for failures raised while logging or projecting failure.
 *     onFailure?: (error: unknown, fields?: Record<string, unknown>) => void;
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
 *
 * Both real drain routes must become thin adapters over that seam and must let a
 * caller replace the observer hooks, so the wait can be proven without a live
 * Herdr pane:
 *
 * ```ts
 * // pi-extension/subagents/index.ts — parent-side route, exported on __test__
 * export function waitForDescendantDrain(
 *   running: Pick<RunningSubagent, "lineage" | "id">,
 *   options?: {
 *     delay?: (ms: number) => Promise<void>;
 *     now?: () => number;
 *     onWaitOpen?: (info: { waitedSince: number }) => void;
 *     onWaitRelease?: (info: { waitedSince: number; waitedMs: number }) => void;
 *     projectWidget?: (projection: unknown) => void; // "waiting-on-descendants" while gated
 *     log?: (event: string, fields?: Record<string, unknown>) => void;
 *   },
 * ): Promise<void>;
 * ```
 *
 * `pi-extension/subagents/subagent-done.ts` owns the child-side route. It
 * exports the same adapter seam for deterministic contract checks; the runtime
 * route supplies the lineage from environment and forwards these observer hooks:
 *
 * ```ts
 * export function waitForDescendantDrain(options?: {
 *   lineage?: { rootDir: string; parentNodeId: string };
 *   delay?: (ms: number) => Promise<void>;
 *   now?: () => number;
 *   onWaitOpen?: (info: { waitedSince: number }) => void;
 *   onWaitRelease?: (info: { waitedSince: number; waitedMs: number }) => void;
 *   projectWidget?: (projection: unknown) => void;
 *   log?: (event: string, fields?: Record<string, unknown>) => void;
 * }): Promise<void>;
 * ```
 *
 * The test calls that real child adapter with an on-disk lineage fixture, not a
 * source-text approximation, and releases it only through durable gate events.
 *
 * R57-5 / R57-6 — a failure caught by a delivery adapter is recorded, never
 * dropped:
 * - every `.catch` in `startRecoveredWatcher`, `startRecoveredWorkflowWatcher`,
 *   `observeSettledRunningSubagent`, and `attemptPendingTerminalDelivery` binds
 *   and uses the error it receives;
 * - a terminal delivery whose parent send throws leaves exactly one failure
 *   record in `<sessionsDir>/subagent-delivery.log`, where `sessionsDir` is the
 *   directory holding the child session file.
 */

/** Adapter-boundary checks below use the real `startRecoveredWatcher` and
 * `observeRunningSubagent` routes with only the parent send/UI sinks replaced.
 * The recovered watcher is exposed through `__test__` for this deterministic
 * check; it must remain the production adapter, not a second test path. A
 * failed send for either route must write one attributable record to the
 * child session directory's `subagent-delivery.log` and project one
 * `delivery-failed` widget row.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import {
	createLifecycle,
	markCompleted,
	markCompletionDetected,
	markDelivery,
	projectLifecycle,
} from "../pi-extension/subagents/lifecycle.ts";
import subagentsExtension, { __test__ } from "../pi-extension/subagents/index.ts";
import {
	appendLineageEvent,
	hasUndrainedDescendants,
	reduceLineage,
	registerLineage,
} from "../pi-extension/subagents/lineage.ts";
import {
	cleanupTempDirs,
	countOccurrences,
	loadSeam,
	readJsonLines,
	requireExport,
	requireSeam,
	tempDir,
	writeSessionFile,
	type DeliveryProjection,
	type DeliveryStatus,
} from "./delivery-seam-support.ts";

const DELIVERY_SEAM =
	process.env.LPT57_DELIVERY_SEAM ?? "../pi-extension/subagents/delivery.ts";
const DRAIN_SEAM =
	process.env.LPT57_DRAIN_SEAM ?? "../pi-extension/subagents/delivery-drain.ts";
const LOG_SEAM =
	process.env.LPT57_DELIVERY_LOG_SEAM ??
	"../pi-extension/subagents/delivery-log.ts";

interface LogCall {
	event: string;
	fields?: Record<string, unknown>;
}

interface ParentDestination {
	sessionId: string;
	sessionFile: string;
}
/** Test doubles for one transaction run; every sink is injected, never a production branch. */
function transactionHarness(options: {
	fail?: "result-file" | "inbox" | "claim" | "steer" | "log" | "widget";
	failDuringFailureHandling?: "log" | "widget";
} = {}) {
	const calls: string[] = [];
	const logCalls: LogCall[] = [];
	const containmentCalls: LogCall[] = [];
	const widgetProjections: DeliveryProjection[] = [];
	const acknowledged: string[] = [];
	const released: string[] = [];
	const completed: string[] = [];
	const inboxPayloads: unknown[] = [];
	const steers: string[] = [];
	const claimDestinations: ParentDestination[] = [];
	const steerDestinations: ParentDestination[] = [];
	return {
		calls,
		logCalls,
		containmentCalls,
		widgetProjections,
		acknowledged,
		released,
		completed,
		inboxPayloads,
		steers,
		claimDestinations,
		steerDestinations,
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
			publishInbox(payload: unknown) {
				calls.push("publishInbox");
				inboxPayloads.push(payload);
				if (options.fail === "inbox") throw new Error("inbox publication failed");
				return true;
			},
			acknowledgeSidecar(path: string) {
				calls.push("acknowledgeSidecar");
				acknowledged.push(path);
			},
			claimMaterialization(destination: ParentDestination) {
				calls.push("claimMaterialization");
				claimDestinations.push(destination);
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
			sendSteer(destination: ParentDestination, payload: string) {
				calls.push("sendSteer");
				steerDestinations.push(destination);
				steers.push(payload);
				if (options.fail === "steer") throw new Error("steer delivery failed");
				return payload;
			},
			log(event: string, fields?: Record<string, unknown>) {
				if (options.fail === "log" || options.failDuringFailureHandling === "log") {
					throw new Error("log write failed");
				}
				logCalls.push({ event, fields });
			},
			projectWidget(projection: DeliveryProjection) {
				if (options.fail === "widget" || options.failDuringFailureHandling === "widget") {
					throw new Error("widget refresh failed");
				}
				widgetProjections.push(projection);
			},
			onFailure(error: unknown, fields?: Record<string, unknown>) {
				containmentCalls.push({
					event: "delivery-failure-contained",
					fields: { error: error instanceof Error ? error.message : String(error), ...fields },
				});
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

async function loadCreateDeliveryLog(): Promise<
	(options: { logPath: string; now?: () => number }) => {
		record(event: string, fields?: Record<string, unknown>): void;
	}
> {
	const seam = requireSeam(await loadSeam(LOG_SEAM), LOG_SEAM);
	return requireExport<any>(seam, "createDeliveryLog", LOG_SEAM);
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
	it("TS-06 composes one complete payload for inbox and exact-parent steer", async () => {
		const runDeliveryTransaction = await loadTransaction();
		const harness = transactionHarness();
		const childSessionFile = "/tmp/sessions/9b5db0d9.jsonl";
		const deliveryId = "terminal:9b5db0d9";
		const answer = "captured answer";
		const parent = {
			sessionId: "parent-session",
			sessionFile: "/tmp/sessions/parent.jsonl",
			active: true,
		};
		const unrelatedParent = {
			sessionId: "unrelated-parent",
			sessionFile: "/tmp/sessions/unrelated-parent.jsonl",
		};

		const result = await runDeliveryTransaction({
			sessionsDir: "/tmp/sessions",
			childSessionId: "9b5db0d9",
			childSessionFile,
			deliveryId,
			status: "completed",
			agentName: "reviewer",
			answer,
			parent,
			now: () => 1_788_247_000_000,
			sinks: harness.sinks,
		});

		assert.equal(result.projection.state, "delivered");
		const resultPath = result.resultPath;
		assert.ok(resultPath && isAbsolute(resultPath), "materialization returns an absolute result path");
		if (!resultPath) throw new Error("missing result path");
		assert.equal(harness.inboxPayloads.length, 1, "one inbox payload is published");
		assert.equal(harness.steers.length, 1, "one exact-parent steer is sent");

		const expectedDestination = {
			sessionId: parent.sessionId,
			sessionFile: parent.sessionFile,
		};
		assert.deepEqual(
			harness.claimDestinations,
			[expectedDestination],
			"the materialization claim targets the supplied creator session",
		);
		assert.deepEqual(
			harness.steerDestinations,
			[expectedDestination],
			"the steer targets the supplied creator session",
		);
		for (const destination of [
			...harness.claimDestinations,
			...harness.steerDestinations,
		]) {
			assert.notDeepEqual(destination, unrelatedParent, "no side effect targets the unrelated parent");
		}
		for (const payload of [harness.inboxPayloads[0], harness.steers[0]]) {
			const text = typeof payload === "string" ? payload : JSON.stringify(payload);
			assert.ok(text, "the delivery payload is serializable");
			for (const value of [answer, resultPath, childSessionFile, deliveryId]) {
				assert.ok(text.includes(value), `payload carries ${value}`);
			}
		}
	});

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

	it("TS-06 contains logger and widget failures during delivery-failure handling", async () => {
		const runDeliveryTransaction = await loadTransaction();
		const hostErrors: unknown[] = [];
		const onUnhandled = (error: unknown) => hostErrors.push(error);
		process.on("unhandledRejection", onUnhandled);
		process.on("uncaughtException", onUnhandled);
		try {
			for (const failDuringFailureHandling of ["log", "widget"] as const) {
				const harness = transactionHarness({
					fail: "steer",
					failDuringFailureHandling,
				});
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
				assert.equal(result.projection.state, "delivery-failed");
				assert.equal(
					harness.containmentCalls.length,
					1,
					`one containment record for a failing ${failDuringFailureHandling}`,
				);
				assert.equal(harness.containmentCalls[0]?.event, "delivery-failure-contained");
				assert.ok(
					JSON.stringify(harness.containmentCalls[0]).includes(failDuringFailureHandling),
					"the containment record names the failed handler",
				);
			}
			// Bounded by the transaction/event marker above; no fixed sleep anywhere.
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

	it("TS-07 rejects every finite-timeout release before the durable gate", async () => {
		const seam = requireSeam(await loadSeam(DRAIN_SEAM), DRAIN_SEAM);
		const waitForDeliveryDrain = requireExport<any>(
			seam,
			"waitForDeliveryDrain",
			DRAIN_SEAM,
		);
		let clock = 1_788_247_000_000;
		let released = false;
		let releaseEvents = 0;
		let outcome: "pending" | "resolved" | "rejected" = "pending";
		const delayReleases: Array<() => void> = [];

		const drain = waitForDeliveryDrain({
			isDrained: () => released,
			delay: () =>
				new Promise<void>((resolve) => {
					// Number.MAX_VALUE is the ceiling of the injected numeric clock contract.
					// Reaching a second delay call proves the seam evaluated that clock value
					// without taking any finite-timeout release path.
					clock = Number.MAX_VALUE;
					delayReleases.push(resolve);
				}),
			now: () => clock,
			onWaitOpen: () => {},
			onWaitRelease: () => {
				releaseEvents += 1;
			},
		}).then(
			() => {
				outcome = "resolved";
			},
			() => {
				outcome = "rejected";
			},
		);

		for (let turn = 0; turn < 200 && delayReleases.length < 1; turn += 1) await tick();
		assert.equal(delayReleases.length, 1, "the held drain reaches its first scheduler marker");
		delayReleases[0]?.();
		for (
			let turn = 0;
			turn < 200 && delayReleases.length < 2 && outcome === "pending";
			turn += 1
		) {
			await tick();
		}
		assert.equal(
			delayReleases.length,
			2,
			"the seam starts another poll after evaluating the largest finite clock value",
		);
		assert.equal(outcome, "pending", "no finite timeout releases the held gate");
		assert.equal(releaseEvents, 0, "the release callback stays silent before the durable gate");

		released = true;
		delayReleases[1]?.();
		await drain;
		assert.equal(outcome, "resolved", "only the positive drain gate releases the wait");
		assert.equal(releaseEvents, 1, "the positive gate emits exactly one release marker");
	});
});
/** Yield one macrotask turn. Never a sleep: bounded by scheduler turns only. */
function tick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

interface TestWidget {
	render(width: number): string[];
}

/** Install the real extension adapter with only Pi/UI sinks replaced. */
function installAdapterRuntime(dir: string, parentSessionFile: string, cwd = process.cwd()) {
	const handlers = new Map<string, (...args: any[]) => unknown>();
	const widgets: TestWidget[] = [];
	const sends: unknown[] = [];
	const pi: any = {
		events: {},
		on(event: string, handler: (...args: any[]) => unknown) {
			handlers.set(event, handler);
		},
		registerTool() {},
		registerCommand() {},
		registerMessageRenderer() {},
		sendUserMessage() {},
		sendMessage(message: unknown) {
			sends.push(message);
			throw new Error("injected parent send failure");
		},
	};
	(__test__.runningSubagents as Map<string, unknown>).clear();
	subagentsExtension(pi);
	const context: any = {
		cwd,
		hasUI: true,
		sessionManager: {
			getSessionId: () => "parent-session",
			getSessionFile: () => parentSessionFile,
			getSessionDir: () => dir,
		},
		modelRegistry: {
			getAll: () => [],
			getAvailable: () => [],
			find: () => undefined,
			hasConfiguredAuth: () => false,
		},
		ui: {
			setWidget(_name: string, widget: unknown) {
				if (typeof widget === "function") widgets.push(widget({ }, { }));
			},
			notify() {},
		},
	};
	handlers.get("session_start")?.({}, context);
	return { widgets, sends };
}

function renderedWidgetText(widgets: TestWidget[]): string {
	const latest = widgets.at(-1);
	return latest ? latest.render(240).join("\n") : "";
}

function failureRecords(path: string, deliveryId: string): any[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim())
		.map((line) => JSON.parse(line))
		.filter((record) =>
			/fail|error/i.test(`${record.event} ${record.error ?? ""}`) &&
			JSON.stringify(record).includes(deliveryId),
		);
}
function recordField(record: any, name: string): unknown {
	return record?.[name] ?? record?.fields?.[name];
}

// Resolved against this file, not the process cwd: `npm test` runs from the
// repository root, but a focused run may not.
const INDEX_SOURCE = new URL("../pi-extension/subagents/index.ts", import.meta.url);
after(cleanupTempDirs);

/** Source of one named function, from `function <name>` to its closing brace. */
function functionSource(source: string, name: string): string {
	const start = source.indexOf(`function ${name}`);
	if (start === -1) return "";
	let depth = 0;
	for (let at = source.indexOf("{", start); at < source.length; at++) {
		if (source[at] === "{") depth += 1;
		else if (source[at] === "}") {
			depth -= 1;
			if (depth === 0) return source.slice(start, at + 1);
		}
	}
	return source.slice(start);
}

/** The argument text of every `.catch(...)` in a body. */
function catchHandlers(body: string): string[] {
	const handlers: string[] = [];
	for (let at = body.indexOf(".catch("); at !== -1; at = body.indexOf(".catch(", at + 1)) {
		const open = at + ".catch(".length - 1;
		let depth = 0;
		for (let index = open; index < body.length; index++) {
			if (body[index] === "(") depth += 1;
			else if (body[index] === ")") {
				depth -= 1;
				if (depth === 0) {
					handlers.push(body.slice(open + 1, index));
					break;
				}
			}
		}
	}
	return handlers;
}

/**
 * A catch that never binds the error it received destroys the only signal the
 * parent has. Comments are stripped first, so a comment cannot stand in for
 * handling.
 */
function swallowedCatches(body: string): string[] {
	return catchHandlers(body).filter((handler) => {
		const arrow = handler.indexOf("=>");
		const params = handler.slice(0, arrow);
		const impl = handler
			.slice(arrow + 2)
			.replace(/\/\/[^\n]*/g, "")
			.replace(/\/\*[\s\S]*?\*\//g, "");
		const error = /\(\s*([A-Za-z_$][\w$]*)\s*\)/.exec(params)?.[1];
		return !error || !new RegExp(`\\b${error}\\b`).test(impl);
	});
}

/** The approved list of adapter sites that used to swallow a delivery failure. */
const FORMER_SWALLOW_SITES = [
	{ fn: "startRecoveredWatcher", label: "recovered subagent watcher" },
	{ fn: "startRecoveredWorkflowWatcher", label: "recovered workflow watcher" },
	{ fn: "attemptPendingTerminalDelivery", label: "terminal delivery catch" },
];

describe("TS-07 visibility on the real drain routes", () => {
	it("TS-07 announces and releases the real parent-side drain wait", async () => {
		const dir = tempDir("pi-ts07-route-");
		const owner = registerLineage({ artifactDir: dir, nodeId: "owner-node" });
		const child = registerLineage({
			artifactDir: dir,
			nodeId: "child-node",
			parentNodeId: owner.nodeId,
			inheritedRootDir: owner.rootDir,
			inheritedRootId: owner.rootId,
		});

		assert.ok(
			hasUndrainedDescendants(reduceLineage(owner.rootDir), owner.nodeId),
			"the fixture starts with one undrained descendant",
		);

		const seen: string[] = [];
		const oneCentury = 100 * 365 * 24 * 60 * 60 * 1000;
		let clock = 0;
		let polls = 0;
		let outcome: "pending" | "resolved" | "rejected" = "pending";
		const createDeliveryLog = await loadCreateDeliveryLog();
		const logPath = join(dir, "subagent-delivery.log");
		const log = createDeliveryLog({ logPath, now: () => clock });
		// The real route, not the seam: production passes its own widget and log
		// sinks, and this call replaces them with observers.
		const drain = (__test__.waitForDescendantDrain as any)(
			{ lineage: { rootDir: owner.rootDir, nodeId: owner.nodeId }, id: owner.nodeId },
			{
				delay: async () => {
					polls += 1;
					clock += oneCentury;
					await tick();
				},
				now: () => clock,
				onWaitOpen: () => seen.push("wait-open"),
				onWaitRelease: () => seen.push("wait-release"),
				log: (event: string, fields?: Record<string, unknown>) =>
					log.record(event, fields),
				projectWidget: (projection: unknown) => {
					const text =
						typeof projection === "string" ? projection : JSON.stringify(projection);
					seen.push(`widget:${text}`);
				},
			},
		).then(
			() => {
				outcome = "resolved";
			},
			() => {
				outcome = "rejected";
			},
		);

		// Hold the gate until the route announces the wait, then release it only
		// after terminal-delivered. Scheduler turns, not wall-clock sleeps, bound
		// both observations.
		for (let turn = 0; turn < 200 && !seen.includes("wait-open"); turn++) await tick();
		assert.ok(seen.includes("wait-open"), "the real parent route announces its wait before polling");
		appendLineageEvent(
			owner.rootDir,
			`terminal:${child.nodeId}`,
			"terminal",
			child.nodeId,
			{ outcome: "success" },
		);
		const originalPolls = polls;
		for (let turn = 0; turn < 200 && polls < originalPolls + 3; turn++) await tick();
		assert.ok(polls >= originalPolls + 3, "the parent route stays active across three centuries");
		assert.equal(outcome, "pending", "no bound releases the parent route while descendants remain");
		assert.ok(!seen.includes("wait-release"), "terminal alone does not release the parent drain wait");
		appendLineageEvent(
			owner.rootDir,
			`terminal-delivered:${child.nodeId}`,
			"terminal_delivered",
			child.nodeId,
			{ deliveryId: `terminal:${child.nodeId}` },
		);
		await drain;

		assert.deepEqual(
			seen.filter((event) => event === "wait-open"),
			["wait-open"],
			"the real drain wait announces itself exactly once while gated",
		);
		assert.ok(
			seen.some((event) => event.includes("waiting-on-descendants")),
			`the widget must project waiting-on-descendants while gated, saw ${JSON.stringify(seen)}`,
		);
		assert.deepEqual(
			seen.filter((event) => event === "wait-release"),
			["wait-release"],
			"the real drain wait records its release exactly once",
		);
		assert.equal(
			seen[seen.length - 1],
			"wait-release",
			"the release is the last thing the wait reports",
		);
		assert.ok(polls > 0, "the wait actually polled the durable drain state");
		assert.ok(clock >= oneCentury * 3, "the route stayed pending for centuries of injected time");
		assert.equal(outcome, "resolved", "terminal-delivered is the only release");
		const waitRecords = readJsonLines(logPath).filter((record) =>
			["drain-wait-open", "drain-wait-release"].includes(record.event),
		);
		assert.deepEqual(
			waitRecords.map((record) => record.event),
			["drain-wait-open", "drain-wait-release"],
			"the real parent route persists one ordered wait pair",
		);
		for (const record of waitRecords) {
			assert.equal(record.childId, owner.nodeId, "the parent route log identifies the drained owner");
		}
	});

	it("TS-07 announces and releases the real child-side drain wait", async () => {
		const childModule =
			process.env.LPT57_CHILD_DRAIN_ROUTE_SEAM ??
			"../pi-extension/subagents/subagent-done.ts";
		const seam = requireSeam(await loadSeam(childModule), childModule);
		const waitForDescendantDrain = requireExport<any>(
			seam,
			"waitForDescendantDrain",
			childModule,
		);
		const dir = tempDir("pi-ts07-child-route-");
		const owner = registerLineage({ artifactDir: dir, nodeId: "owner-node" });
		const child = registerLineage({
			artifactDir: dir,
			nodeId: "child-node",
			parentNodeId: owner.nodeId,
			inheritedRootDir: owner.rootDir,
			inheritedRootId: owner.rootId,
		});
		const grandchild = registerLineage({
			artifactDir: dir,
			nodeId: "grandchild-node",
			parentNodeId: child.nodeId,
			inheritedRootDir: owner.rootDir,
			inheritedRootId: owner.rootId,
		});
		assert.ok(
			hasUndrainedDescendants(reduceLineage(owner.rootDir), child.nodeId),
			"the real child route owns one undrained grandchild",
		);

		const seen: string[] = [];
		const oneCentury = 100 * 365 * 24 * 60 * 60 * 1000;
		let clock = 0;
		let polls = 0;
		let stopRoute = false;
		let outcome: "pending" | "resolved" | "rejected" = "pending";
		const createDeliveryLog = await loadCreateDeliveryLog();
		const logPath = join(dir, "subagent-delivery.log");
		const log = createDeliveryLog({ logPath, now: () => clock });
		const drain = waitForDescendantDrain({
			lineage: { rootDir: owner.rootDir, parentNodeId: child.nodeId },
			delay: async () => {
				polls += 1;
				clock += oneCentury;
				await tick();
				if (stopRoute) throw new Error("test stopped a route that ignored the durable release");
			},
			now: () => clock,
			onWaitOpen: () => seen.push("wait-open"),
			onWaitRelease: () => seen.push("wait-release"),
			log: (event: string, fields?: Record<string, unknown>) =>
				log.record(event, fields),
			projectWidget: (projection: unknown) => {
				const text = typeof projection === "string" ? projection : JSON.stringify(projection);
				seen.push(`widget:${text}`);
			},
		}).then(
			() => {
				outcome = "resolved";
			},
			() => {
				outcome = "rejected";
			},
		);

		// A silent route cannot hang this check: scheduler turns establish the wait,
		// then terminal-delivered is the only event allowed to release it.
		for (let turn = 0; turn < 200 && !seen.includes("wait-open"); turn++) await tick();
		assert.ok(seen.includes("wait-open"), "the real child route announces its wait before polling");
		appendLineageEvent(
			owner.rootDir,
			`terminal:${grandchild.nodeId}`,
			"terminal",
			grandchild.nodeId,
			{ outcome: "success" },
		);
		const originalPolls = polls;
		for (let turn = 0; turn < 200 && polls < originalPolls + 3; turn++) await tick();
		assert.ok(polls >= originalPolls + 3, "the child route stays active across three centuries");
		assert.equal(outcome, "pending", "no bound releases the child route while descendants remain");
		assert.ok(!seen.includes("wait-release"), "grandchild terminal alone does not release the child drain wait");
		appendLineageEvent(
			owner.rootDir,
			`terminal-delivered:${grandchild.nodeId}`,
			"terminal_delivered",
			grandchild.nodeId,
			{ deliveryId: `terminal:${grandchild.nodeId}` },
		);
		const pollsAtRelease = polls;
		for (
			let turn = 0;
			turn < 200 && outcome === "pending" && polls < pollsAtRelease + 3;
			turn += 1
		) {
			await tick();
		}
		if (outcome === "pending") stopRoute = true;
		await drain;
		assert.equal(outcome, "resolved", "the child-owned grandchild release is the only release");

		assert.deepEqual(seen.filter((event) => event === "wait-open"), ["wait-open"]);
		assert.ok(
			seen.some((event) => event.includes("waiting-on-descendants")),
			`the child route must project waiting-on-descendants, saw ${JSON.stringify(seen)}`,
		);
		assert.deepEqual(seen.filter((event) => event === "wait-release"), ["wait-release"]);
		assert.equal(seen[seen.length - 1], "wait-release");
		assert.ok(polls > 0, "the child route polled the durable drain state");
		assert.ok(clock >= oneCentury * 3, "the child route stayed pending for centuries");
		assert.equal(outcome, "resolved", "grandchild terminal-delivered releases the child route");
		const waitRecords = readJsonLines(logPath).filter((record) =>
			["drain-wait-open", "drain-wait-release"].includes(record.event),
		);
		assert.deepEqual(
			waitRecords.map((record) => record.event),
			["drain-wait-open", "drain-wait-release"],
			"the real child route persists one ordered wait pair",
		);
		for (const record of waitRecords) {
			assert.equal(record.childId, child.nodeId, "the child route log identifies the child owner");
		}
	});
});

describe("TS-06 loud failures at the real adapter catches", () => {
	it("TS-06 records a terminal delivery whose parent send throws", async () => {
		const sessionsDir = tempDir("pi-ts06-adapter-");
		const sessionFile = join(sessionsDir, "child.jsonl");
		writeFileSync(sessionFile, "", "utf8");
		const deliveryId = "terminal:9b5db0d9";
		// The real presentation and send paths, against a parent that refuses.
		const failingParent = {
			sendMessage() {
				throw new Error("parent send failed");
			},
		};
		const running: any = {
			id: "9b5db0d9",
			name: "reviewer",
			task: "review",
			surface: "pane",
			startTime: 0,
			sessionFile,
			interactive: false,
			runtimePlan: undefined,
			lifecycle: createLifecycle(0),
			pendingTerminalDelivery: {
				finalAssistant: undefined,
				resultContent: "captured answer",
				queued: false,
				finalize: () => {
					const presentation = (__test__.resolveResultPresentation as any)(
						{ exitCode: 0, summary: "captured answer", sessionFile },
						"reviewer",
					);
					(__test__.sendSubagentResult as any)(failingParent, presentation, {
						name: "reviewer",
						task: "review",
						childId: "9b5db0d9",
						exitCode: 0,
						sessionFile,
						deliveryId,
						resultContent: "captured answer",
					});
				},
			},
		};

		const runtimeHarness = installAdapterRuntime(sessionsDir, join(sessionsDir, "parent.jsonl"));
		(__test__.runningSubagents as Map<string, unknown>).set(running.id, running);
		const hostErrors: unknown[] = [];
		const onHostError = (error: unknown) => hostErrors.push(error);
		process.on("unhandledRejection", onHostError);
		process.on("uncaughtException", onHostError);
		try {
			(__test__.observeRunningSubagent as any)(running, 1_000);
			for (let turn = 0; turn < 20; turn++) await tick();

			const logPath = join(sessionsDir, "subagent-delivery.log");
			assert.ok(
				existsSync(logPath),
				"a failure swallowed by the terminal catch is recorded in the persistent delivery log",
			);
			const records = readFileSync(logPath, "utf8")
				.split("\n")
				.filter((line) => line.trim())
				.map((line) => JSON.parse(line));
			const failures = records.filter((record: any) =>
				/fail|error/i.test(`${record.event} ${record.error ?? ""}`),
			);
			assert.equal(
				failures.length,
				1,
				`exactly one failure record for the swallowed delivery, saw ${JSON.stringify(records)}`,
			);
			assert.ok(
				JSON.stringify(failures[0]).includes(deliveryId),
				"the record names the delivery that failed",
			);
			assert.equal(
				countOccurrences(renderedWidgetText(runtimeHarness.widgets), "delivery-failed"),
				1,
				"the terminal adapter projects exactly one delivery-failed widget row",
			);
			assert.deepEqual(hostErrors, [], "recording the failure never reaches the Pi host");
		} finally {
			process.off("unhandledRejection", onHostError);
			process.off("uncaughtException", onHostError);
		}
	});


	it("TS-06 records one failure and one failed projection at the recovered-watcher adapter", async () => {
		const startRecoveredWatcher = requireExport<any>(
			__test__ as any,
			"startRecoveredWatcher",
			"pi-extension/subagents/index.ts",
		);
		const sessionsDir = tempDir("pi-ts06-recovered-adapter-");
		const parentSessionFile = join(sessionsDir, "parent.jsonl");
		writeFileSync(parentSessionFile, "", "utf8");
		const sessionFile = join(sessionsDir, "recovered-child.jsonl");
		writeSessionFile(sessionFile, { id: "child", cwd: sessionsDir });
		writeFileSync(
			`${sessionFile}.exit`,
			JSON.stringify({ type: "done", summary: "recovered answer" }),
			"utf8",
		);
		const runtimeHarness = installAdapterRuntime(sessionsDir, parentSessionFile);
		const running: any = {
			id: "recovered-child",
			name: "reviewer",
			task: "review",
			surface: "missing-surface",
			startTime: 0,
			sessionFile,
			interactive: false,
			runtimePlan: undefined,
			lifecycle: createLifecycle(0),
		};
		(__test__.runningSubagents as Map<string, unknown>).set(running.id, running);

		const hostErrors: unknown[] = [];
		const onHostError = (error: unknown) => hostErrors.push(error);
		process.on("unhandledRejection", onHostError);
		process.on("uncaughtException", onHostError);
		try {
			// Invoke the actual recovered-watcher adapter with a real completion
			// sidecar; only the parent send sink is replaced with a failing test sink.
			startRecoveredWatcher(running);
			for (let turn = 0; turn < 40; turn += 1) await tick();

			const deliveryId = "terminal:recovered-child";
			assert.equal(runtimeHarness.sends.length, 1, "the recovered adapter attempted one parent delivery");
			const records = failureRecords(join(sessionsDir, "subagent-delivery.log"), deliveryId);
			assert.equal(records.length, 1, `one recovered-watcher failure record, saw ${JSON.stringify(records)}`);
			assert.equal(
				countOccurrences(renderedWidgetText(runtimeHarness.widgets), "delivery-failed"),
				1,
				"the recovered-watcher adapter projects exactly one delivery-failed widget row",
			);
			assert.deepEqual(hostErrors, [], "the recovered-watcher failure stays inside the Pi host");
		} finally {
			process.off("unhandledRejection", onHostError);
			process.off("uncaughtException", onHostError);
		}
	});

	it("TS-06 records a recovered workflow watcher send failure", async () => {
		const startRecoveredWorkflowWatcher = requireExport<any>(
			__test__ as any,
			"startRecoveredWorkflowWatcher",
			"pi-extension/subagents/index.ts",
		);
		const sessionsDir = tempDir("pi-ts06-recovered-workflow-");
		const parentSessionFile = join(sessionsDir, "parent.jsonl");
		writeFileSync(parentSessionFile, "", "utf8");
		const sessionFile = join(sessionsDir, "recovered-workflow-child.jsonl");
		writeSessionFile(sessionFile, { id: "workflow-child", cwd: sessionsDir });
		writeFileSync(
			`${sessionFile}.exit`,
			JSON.stringify({ type: "done", summary: "recovered workflow answer" }),
			"utf8",
		);

		const repoDir = tempDir("pi-ts06-workflow-repo-");
		execFileSync("git", ["init", "-q", repoDir], { stdio: "ignore" });
		const runId = "recovered-workflow-run";
		const journalDir = join(repoDir, ".pi", "plans", runId);
		mkdirSync(journalDir, { recursive: true });
		writeFileSync(
			join(journalDir, "run.jsonl"),
			[
				JSON.stringify({
					type: "approved",
					preparingSession: { id: "parent-session", file: parentSessionFile },
				}),
				JSON.stringify({ type: "started", coordinatorPid: 999_999_999 }),
			].join("\n") + "\n",
			"utf8",
		);
		const lineage = registerLineage({
			artifactDir: sessionsDir,
			nodeId: "workflow-child",
			parentSessionId: "parent-session",
			parentSessionFile,
			parentWorkflowRunId: runId,
			launchKind: "workflow",
		});

		const runtimeHarness = installAdapterRuntime(sessionsDir, parentSessionFile);
		const running: any = {
			id: "workflow-child",
			name: "reviewer",
			task: "review",
			surface: "missing-surface",
			startTime: 0,
			sessionFile,
			interactive: false,
			runtimePlan: undefined,
			lifecycle: createLifecycle(0),
		};
		(__test__.runningSubagents as Map<string, unknown>).set(running.id, running);

		const hostErrors: unknown[] = [];
		const onHostError = (error: unknown) => hostErrors.push(error);
		process.on("unhandledRejection", onHostError);
		process.on("uncaughtException", onHostError);
		try {
			startRecoveredWorkflowWatcher(running, lineage.rootDir, runId, { cwd: repoDir } as any);
			const logPath = join(sessionsDir, "subagent-delivery.log");
			for (let turn = 0; turn < 200; turn += 1) {
				const widgetText = renderedWidgetText(runtimeHarness.widgets);
				if (
					runtimeHarness.sends.length > 0 &&
					failureRecords(logPath, "terminal:workflow-child").length === 1 &&
					countOccurrences(widgetText, "delivery-failed") === 1
				) break;
				await tick();
			}

			const deliveryId = "terminal:workflow-child";
			assert.equal(runtimeHarness.sends.length, 1, "the recovered workflow attempted one parent delivery");
			const failures = failureRecords(logPath, deliveryId);
			assert.equal(failures.length, 1, "one exact recovered workflow failure is durable");
			assert.equal(recordField(failures[0], "deliveryId"), deliveryId, "failure names the exact delivery");
			assert.ok(JSON.stringify(failures[0]).includes(runId), "failure names the exact workflow run");
			const phase = recordField(failures[0], "phase");
			assert.equal(typeof phase, "string", "failure carries an explicit phase");
			assert.match(String(phase), /steer|send/i, "failure names the send phase");
			const widgetText = renderedWidgetText(runtimeHarness.widgets);
			assert.equal(
				countOccurrences(widgetText, "delivery-failed"),
				1,
				"the recovered workflow projects one delivery-failed widget row",
			);
			assert.ok(widgetText.includes(deliveryId), "the failed widget row names the exact delivery");
			assert.deepEqual(hostErrors, [], "the recovered workflow failure stays inside the Pi host");
		} finally {
			process.off("unhandledRejection", onHostError);
			process.off("uncaughtException", onHostError);
		}
	});

	it("TS-06 leaves no silent catch on the approved adapter failure points", () => {

		const source = readFileSync(INDEX_SOURCE, "utf8");
		for (const site of FORMER_SWALLOW_SITES) {
			const body = functionSource(source, site.fn);
			assert.ok(body, `${site.fn} still exists in the subagent adapter`);
			assert.deepEqual(
				swallowedCatches(body),
				[],
				`the ${site.label} must bind and use the error it catches instead of dropping it`,
			);
			for (const handler of catchHandlers(body)) {
				assert.match(
					handler,
					/\berror\b/,
					`the ${site.label} catch must preserve its error for attribution`,
				);
				assert.match(
					handler,
					/(?:log|record|delivery|widget|project|updateWidget)/i,
					`the ${site.label} catch must report failure through durable log/UI handling`,
				);
			}
		}
	});
});
