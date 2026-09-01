/**
 * TS-06 / TS-07 — persistent delivery log (log half).
 *
 * Seam under test: `pi-extension/subagents/delivery-log.ts`
 *
 * Frozen contract for the Coder:
 *
 * ```ts
 * export function createDeliveryLog(options: {
 *   logPath: string;                          // injected; production default
 *                                             // <sessionsDir>/subagent-delivery.log
 *   now?: () => number;                       // injected clock
 *   onFailure?: (error: unknown) => void;     // containment sink, never throws into Pi
 * }): { record(event: string, fields?: Record<string, unknown>): void };
 * ```
 *
 * Required behavior (R57-6):
 * - append-only JSON lines at the injected path, one line per record
 * - every record has `version: 1`, an ISO `time` from the injected clock, and `event`
 * - records carry child/delivery ids, status, result path, phase, normalized error
 * - answer text is never copied into the log: unknown fields are dropped
 * - a failing append is reported through `onFailure` and never thrown into the host
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	cleanupTempDirs,
	loadSeam,
	readJsonLines,
	requireExport,
	requireSeam,
	tempDir,
} from "./delivery-seam-support.ts";

const SEAM = "../pi-extension/subagents/delivery-log.ts";

interface DeliveryLog {
	record(event: string, fields?: Record<string, unknown>): void;
}

type CreateLog = (options: {
	logPath: string;
	now?: () => number;
	onFailure?: (error: unknown) => void;
}) => DeliveryLog;

async function loadCreateLog(): Promise<CreateLog> {
	const seam = requireSeam(await loadSeam(SEAM), SEAM);
	return requireExport<CreateLog>(seam, "createDeliveryLog", SEAM);
}

after(cleanupTempDirs);

describe("TS-06 persistent delivery log", () => {
	it("TS-06 appends one timestamped JSON line per record", async () => {
		const createDeliveryLog = await loadCreateLog();
		const dir = tempDir("pi-ts06-log-");
		const logPath = join(dir, "subagent-delivery.log");
		const now = 1_788_247_116_000;
		const log = createDeliveryLog({ logPath, now: () => now });

		log.record("delivery-started", {
			childId: "9b5db0d9",
			deliveryId: "terminal:9b5db0d9",
			status: "completed",
			phase: "materialize",
		});
		log.record("delivery-sent", {
			childId: "9b5db0d9",
			deliveryId: "terminal:9b5db0d9",
			resultPath: join(dir, "9b5db0d9", "01-completed.md"),
		});

		assert.ok(existsSync(logPath), "the log file exists at the injected path");
		const records = readJsonLines(logPath);
		assert.equal(records.length, 2);
		assert.equal(records[0].version, 1);
		assert.equal(records[0].event, "delivery-started");
		assert.equal(records[0].time, new Date(now).toISOString());
		assert.equal(records[0].childId, "9b5db0d9");
		assert.equal(records[0].deliveryId, "terminal:9b5db0d9");
		assert.equal(records[0].status, "completed");
		assert.equal(records[0].phase, "materialize");
		assert.equal(records[1].event, "delivery-sent");
		assert.equal(records[1].resultPath, join(dir, "9b5db0d9", "01-completed.md"));
	});

	it("TS-06 appends a later record without rewriting earlier ones", async () => {
		const createDeliveryLog = await loadCreateLog();
		const dir = tempDir("pi-ts06-append-");
		const logPath = join(dir, "subagent-delivery.log");
		const log = createDeliveryLog({ logPath, now: () => 1_788_247_000_000 });

		log.record("delivery-started", { deliveryId: "a" });
		const afterFirst = readFileSync(logPath, "utf8");
		log.record("delivery-failed", { deliveryId: "b", error: "steer failed" });

		const contents = readFileSync(logPath, "utf8");
		assert.ok(contents.startsWith(afterFirst), "the log is append-only");
		const records = readJsonLines(logPath);
		assert.deepEqual(
			records.map((record) => record.event),
			["delivery-started", "delivery-failed"],
		);
		assert.equal(records[1].error, "steer failed");
	});

	it("TS-06 never copies answer text into the log", async () => {
		const createDeliveryLog = await loadCreateLog();
		const dir = tempDir("pi-ts06-noanswer-");
		const logPath = join(dir, "subagent-delivery.log");
		const log = createDeliveryLog({ logPath, now: () => 1_788_247_000_000 });
		const answer = `SECRET-ANSWER-${"a".repeat(20_000)}`;

		log.record("delivery-sent", {
			deliveryId: "terminal:9b5db0d9",
			answer,
			resultContent: answer,
		});

		const contents = readFileSync(logPath, "utf8");
		assert.doesNotMatch(contents, /SECRET-ANSWER/, "answer text never reaches the log");
		assert.doesNotMatch(contents, /a{100}/, "no duplicated answer body");
		const record = readJsonLines(logPath)[0];
		assert.equal(record.answer, undefined);
		assert.equal(record.resultContent, undefined);
		assert.equal(record.deliveryId, "terminal:9b5db0d9");
	});

	it("TS-06 records drain wait transitions (TS-07 log pair)", async () => {
		const createDeliveryLog = await loadCreateLog();
		const dir = tempDir("pi-ts06-wait-");
		const logPath = join(dir, "subagent-delivery.log");
		const log = createDeliveryLog({ logPath, now: () => 1_788_247_000_000 });

		log.record("drain-wait-open", { childId: "9b5db0d9", phase: "drain" });
		log.record("drain-wait-release", { childId: "9b5db0d9", phase: "drain" });

		const records = readJsonLines(logPath);
		assert.deepEqual(
			records.map((record) => record.event),
			["drain-wait-open", "drain-wait-release"],
		);
		assert.equal(records[0].phase, "drain");
	});

	it("TS-06 contains its own write failure instead of throwing into the host", async () => {
		const createDeliveryLog = await loadCreateLog();
		const dir = tempDir("pi-ts06-containment-");
		const logPath = join(dir, "subagent-delivery.log");
		mkdirSync(logPath, { recursive: true }); // a directory cannot be appended to
		const failures: unknown[] = [];
		const log = createDeliveryLog({
			logPath,
			now: () => 1_788_247_000_000,
			onFailure: (error) => failures.push(error),
		});

		assert.doesNotThrow(() => log.record("delivery-started", { deliveryId: "a" }));
		assert.equal(failures.length, 1, "the failure is reported once");
		assert.ok(failures[0] instanceof Error, "the reported failure is an Error");
	});
});
