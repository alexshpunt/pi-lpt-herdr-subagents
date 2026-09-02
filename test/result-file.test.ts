/**
 * TS-01 / TS-02 / TS-05 — durable result-file materialization.
 *
 * Seam under test: `pi-extension/subagents/delivery-files.ts`
 *
 * Frozen contract for the Coder:
 *
 * ```ts
 * export function materializeResultFile(input: {
 *   sessionsDir: string;      // parent process sessions directory
 *   childSessionId: string;   // result subdirectory name
 *   deliveryId: string;       // stable per-delivery id; one id maps to one file
 *   status: DeliveryStatus;   // file name suffix
 *   agentName: string;
 *   answer?: string;          // verbatim complete answer; absent means nothing captured
 *   now: number;              // injected clock, epoch ms, written as UTC in the header
 * }): { path: string; sequence: number; filename: string };
 * ```
 *
 * Required behavior:
 * - file path `<sessionsDir>/<childSessionId>/<NN>-<status>.md`, `NN` zero-padded from `01`
 * - a delivery id already present in a file header is recovered, never rewritten
 * - a new delivery id takes the next free sequence; no existing file is replaced
 * - the header carries status, agent name, child session id, injected UTC time,
 *   delivery sequence, and delivery id
 * - the body is the verbatim answer, or an explicit statement that nothing was captured
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	cleanupTempDirs,
	countOccurrences,
	loadSeam,
	requireExport,
	requireSeam,
	tempDir,
	writeSessionFile,
	type DeliveryStatus,
} from "./delivery-seam-support.ts";

const SEAM = "../pi-extension/subagents/delivery-files.ts";

type Materialize = (input: {
	sessionsDir: string;
	childSessionId: string;
	deliveryId: string;
	status: DeliveryStatus;
	agentName: string;
	answer?: string;
	now: number;
}) => { path: string; sequence: number; filename: string };

/** Header block = everything before the first blank line. */
function headerOf(contents: string): string {
	return contents.split(/\r?\n\r?\n/)[0] ?? "";
}

function resultDir(sessionsDir: string, childSessionId: string): string {
	return join(sessionsDir, childSessionId);
}

function filesIn(dir: string): string[] {
	return readdirSync(dir).sort();
}

async function loadMaterialize(): Promise<Materialize> {
	const seam = requireSeam(await loadSeam(SEAM), SEAM);
	return requireExport<Materialize>(seam, "materializeResultFile", SEAM);
}

after(cleanupTempDirs);

describe("TS-01 result file materialization", () => {
	it("TS-01 writes one zero-padded result file per accepted delivery", async () => {
		const materialize = await loadMaterialize();
		const sessionsDir = tempDir("pi-ts01-");
		const childSessionId = "9b5db0d9";

		const first = materialize({
			sessionsDir,
			childSessionId,
			deliveryId: "terminal:9b5db0d9",
			status: "completed",
			agentName: "reviewer",
			answer: "first answer",
			now: 1_788_247_000_000,
		});
		const second = materialize({
			sessionsDir,
			childSessionId,
			deliveryId: "settled:9b5db0d9:2",
			status: "completed",
			agentName: "reviewer",
			answer: "second answer",
			now: 1_788_247_060_000,
		});

		assert.equal(filesIn(resultDir(sessionsDir, childSessionId)).length, 2);
		assert.equal(first.filename, "01-completed.md");
		assert.equal(second.filename, "02-completed.md");
		assert.equal(first.sequence, 1);
		assert.equal(second.sequence, 2);
		assert.ok(first.path.endsWith(join(childSessionId, "01-completed.md")));
		assert.ok(second.path.endsWith(join(childSessionId, "02-completed.md")));
		assert.ok(existsSync(first.path) && existsSync(second.path));
		assert.ok(first.path.includes(childSessionId), "result file lives under the child session id");
	});

	it("TS-01 never overwrites the file of an already materialized delivery id", async () => {
		const materialize = await loadMaterialize();
		const sessionsDir = tempDir("pi-ts01-retry-");
		const childSessionId = "37721bc6";
		const input = {
			sessionsDir,
			childSessionId,
			deliveryId: "terminal:37721bc6",
			status: "completed" as DeliveryStatus,
			agentName: "reviewer",
			answer: "immutable answer",
			now: 1_788_247_000_000,
		};

		const first = materialize(input);
		const before = readFileSync(first.path, "utf8");
		const retry = materialize({ ...input, now: input.now + 60_000 });

		assert.equal(retry.path, first.path);
		assert.equal(retry.sequence, first.sequence);
		assert.equal(readFileSync(first.path, "utf8"), before);
		assert.equal(filesIn(resultDir(sessionsDir, childSessionId)).length, 1);
	});


	it("TS-01 recovers the same delivery id from disk after a process restart", async () => {
		const materialize = await loadMaterialize();
		const sessionsDir = tempDir("pi-ts01-restart-");
		const input = {
			sessionsDir,
			childSessionId: "37721bc6",
			deliveryId: "terminal:37721bc6",
			status: "completed" as DeliveryStatus,
			agentName: "reviewer",
			answer: "restart-safe answer",
			now: 1_788_247_000_000,
		};
		const first = materialize(input);
		const before = readFileSync(first.path, "utf8");
		const seamUrl = new URL("../pi-extension/subagents/delivery-files.ts", import.meta.url).href;
		const script = [
			`const module = await import(process.env.LPT57_SEAM_URL);`,
			`const result = module.materializeResultFile(JSON.parse(process.env.LPT57_INPUT));`,
			`process.stdout.write(JSON.stringify(result));`,
		].join("\n");
		const childOutput = execFileSync(
			process.execPath,
			["--experimental-strip-types", "-e", script],
			{
				encoding: "utf8",
				env: {
					...process.env,
					LPT57_SEAM_URL: seamUrl,
					LPT57_INPUT: JSON.stringify(input),
				},
			},
		);
		const recovered = JSON.parse(childOutput) as typeof first;

		assert.equal(recovered.path, first.path, "restart recovers the original result path");
		assert.equal(recovered.sequence, first.sequence);
		assert.equal(readFileSync(first.path, "utf8"), before, "restart leaves bytes immutable");
		assert.deepEqual(filesIn(resultDir(sessionsDir, input.childSessionId)), ["01-completed.md"]);
	});

	it("TS-01 names each result file after its delivery status", async () => {
		const materialize = await loadMaterialize();
		const sessionsDir = tempDir("pi-ts01-status-");
		const childSessionId = "abc12345";

		for (const [index, status] of [
			"completed",
			"settled",
			"help-request",
		].entries()) {
			const handle = materialize({
				sessionsDir,
				childSessionId,
				deliveryId: `delivery:${status}`,
				status: status as DeliveryStatus,
				agentName: "reviewer",
				answer: `${status} answer`,
				now: 1_788_247_000_000 + index * 1000,
			});
			assert.equal(
				handle.filename,
				`0${index + 1}-${status}.md`,
				`expected sequence ${index + 1} for status ${status}`,
			);
		}

		assert.deepEqual(filesIn(resultDir(sessionsDir, childSessionId)), [
			"01-completed.md",
			"02-settled.md",
			"03-help-request.md",
		]);
	});
});

describe("TS-02 result file contents", () => {
	it("TS-02 writes the full delivery header and the verbatim answer body", async () => {
		const materialize = await loadMaterialize();
		const sessionsDir = tempDir("pi-ts02-");
		const childSessionId = "9b5db0d9";
		const now = 1_788_247_116_000;
		const answer = "Line one.\n\nLine two with **markdown**.";

		const handle = materialize({
			sessionsDir,
			childSessionId,
			deliveryId: "terminal:9b5db0d9",
			status: "completed",
			agentName: "lpt57-reviewer",
			answer,
			now,
		});

		const contents = readFileSync(handle.path, "utf8");
		const header = headerOf(contents);
		assert.match(header, /completed/, "header carries the status");
		assert.match(header, /lpt57-reviewer/, "header carries the agent name");
		assert.match(header, /9b5db0d9/, "header carries the child session id");
		assert.match(header, /terminal:9b5db0d9/, "header carries the delivery id");
		assert.match(
			header,
			new RegExp(new Date(now).toISOString().replace(/\./g, "\\.")),
			"header carries the injected UTC time",
		);
		assert.match(header, /sequence/i, "header names the delivery sequence");
		assert.ok(contents.includes(answer), "body keeps the complete answer");
		assert.equal(countOccurrences(contents, answer), 1);
		assert.ok(
			contents.trimEnd().endsWith(answer.trimEnd()),
			"the answer is the tail of the result file",
		);
	});

	it("TS-02 round-trips a 200k-character answer character for character", async () => {
		const materialize = await loadMaterialize();
		const sessionsDir = tempDir("pi-ts02-large-");
		const answer = `HEAD-${"h".repeat(100_000)}-MIDDLE-${"t".repeat(99_960)}-TAIL`;
		assert.equal(answer.length, 200_000);

		const handle = materialize({
			sessionsDir,
			childSessionId: "37721bc6",
			deliveryId: "terminal:37721bc6",
			status: "completed",
			agentName: "reviewer",
			answer,
			now: 1_788_247_000_000,
		});

		const contents = readFileSync(handle.path, "utf8");
		const index = contents.indexOf(answer);
		assert.notEqual(index, -1, "the complete answer is present");
		assert.equal(
			contents.slice(index, index + answer.length),
			answer,
			"the answer is byte-for-byte identical",
		);
		assert.equal(countOccurrences(contents, answer), 1);
		assert.doesNotMatch(contents, /abbreviated/i, "no abbreviation marker");
	});

	it("TS-02 states explicitly that nothing was captured when there is no answer", async () => {
		const materialize = await loadMaterialize();
		const sessionsDir = tempDir("pi-ts02-empty-");

		const handle = materialize({
			sessionsDir,
			childSessionId: "abc12345",
			deliveryId: "terminal:abc12345",
			status: "empty",
			agentName: "reviewer",
			now: 1_788_247_000_000,
		});

		const contents = readFileSync(handle.path, "utf8");
		assert.match(headerOf(contents), /empty/, "header carries the status");
		assert.match(
			contents.slice(headerOf(contents).length),
			/no (answer|result|output).*(captured|available|recorded)|nothing (was )?captured/i,
			"an empty delivery says explicitly that nothing was captured",
		);
	});
});

describe("TS-05 result files and Pi session discovery coexistence", () => {
	/** Pi 0.84.4 does not re-export session discovery through its package exports map. */
	async function loadFindMostRecentSession(): Promise<
		(sessionDir: string, cwd?: string) => string | null
	> {
		const root = import.meta.resolve("@earendil-works/pi-coding-agent");
		const { fileURLToPath } = await import("node:url");
		assert.ok(
			fileURLToPath(root).includes("pi-coding-agent"),
			"pi-coding-agent must resolve for TS-05",
		);
		const module = (await import(
			new URL("core/session-manager.js", root).href
		)) as Record<string, any>;
		return requireExport<any>(
			module,
			"findMostRecentSession",
			"@earendil-works/pi-coding-agent/dist/core/session-manager.js",
		);
	}

	it("TS-05 keeps Pi session discovery working next to result subdirectories", async () => {
		const materialize = await loadMaterialize();
		const findMostRecentSession = await loadFindMostRecentSession();
		const sessionsDir = tempDir("pi-ts05-");
		const childSessionId = "9b5db0d9";
		const sessionFile = join(
			sessionsDir,
			"2026-09-01T07-14-26-761Z_37721bc6.jsonl",
		);
		writeSessionFile(sessionFile, { cwd: sessionsDir });
		materialize({
			sessionsDir,
			childSessionId,
			deliveryId: "terminal:9b5db0d9",
			status: "completed",
			agentName: "reviewer",
			answer: "completed answer",
			now: 1_788_247_000_000,
		});

		const found = findMostRecentSession(sessionsDir, sessionsDir);

		assert.equal(found, sessionFile);
	});

	it("TS-05 never reports a result artifact or result directory as a session", async () => {
		const materialize = await loadMaterialize();
		const findMostRecentSession = await loadFindMostRecentSession();
		const sessionsDir = tempDir("pi-ts05-artifacts-");
		const childSessionId = "37721bc6";
		const sessionFile = join(
			sessionsDir,
			"2026-09-01T07-14-26-761Z_37721bc6.jsonl",
		);
		writeSessionFile(sessionFile, { cwd: sessionsDir });
		materialize({
			sessionsDir,
			childSessionId,
			deliveryId: "terminal:37721bc6",
			status: "completed",
			agentName: "reviewer",
			answer: "completed answer",
			now: 1_788_247_000_000,
		});
		materialize({
			sessionsDir,
			childSessionId,
			deliveryId: "settled:37721bc6:2",
			status: "settled",
			agentName: "reviewer",
			answer: "settled answer",
			now: 1_788_247_060_000,
		});

		assert.deepEqual(filesIn(resultDir(sessionsDir, childSessionId)), [
			"01-completed.md",
			"02-settled.md",
		]);
		assert.equal(findMostRecentSession(sessionsDir, sessionsDir), sessionFile);
	});
});
