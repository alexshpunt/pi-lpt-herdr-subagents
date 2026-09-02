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
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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

/** Run one materializer in a separate process and inject one deterministic EEXIST at installation. */
function runConcurrentMaterializer(input: {
	input: Record<string, unknown>;
	seamUrl: string;
	coordDir: string;
	goPath: string;
	readyPath: string;
	collisionLogPath: string;
	collisionClaimPath: string;
}): Promise<string> {
	const script = [
		`const fsModule = await import("node:fs");`,
		`const moduleApi = await import("node:module");`,
		`const fs = fsModule.default;`,
		`const input = JSON.parse(process.env.LPT57_INPUT);`,
		`const append = fs.appendFileSync.bind(fs);`,
		`const originalWriteFileSync = fs.writeFileSync.bind(fs);`,
		`const originalOpenSync = fs.openSync.bind(fs);`,
		`const originalCloseSync = fs.closeSync.bind(fs);`,
		`let armed = false;`,
		`let injected = false;`,
		`const forceCollision = (operation, path) => {`,
		`  if (!armed || injected || !String(path).endsWith(".md")) return false;`,
		`  let claimFd;`,
		`  try { claimFd = originalOpenSync(process.env.LPT57_COLLISION_CLAIM, "wx"); originalCloseSync(claimFd); } catch (error) { if (error?.code === "EEXIST") return false; throw error; }`,
		`  injected = true;`,
		`  append(process.env.LPT57_COLLISION_LOG, operation + "\\n");`,
		`  const error = new Error("forced no-replace collision");`,
		`  error.code = "EEXIST";`,
		`  throw error;`,
		`};`,
		`fs.writeFileSync = (path, data, options) => { if (forceCollision("writeFileSync", path)) return undefined; return originalWriteFileSync(path, data, options); };`,
		`fs.openSync = (path, flags, mode) => { if (forceCollision("openSync", path)) return -1; return originalOpenSync(path, flags, mode); };`,
		`moduleApi.syncBuiltinESMExports();`,
		`fs.writeFileSync(process.env.LPT57_READY, "ready");`,
		`await new Promise((resolve, reject) => {`,
		`  let watcher;`,
		`  const release = () => { watcher?.close(); resolve(); };`,
		`  try { watcher = fs.watch(process.env.LPT57_COORD, (_event, name) => { if (String(name) === "go") release(); }); } catch (error) { reject(error); return; }`,
		`  if (fs.existsSync(process.env.LPT57_GO)) release();`,
		`});`,
		`const module = await import(process.env.LPT57_SEAM_URL);`,
		`armed = true;`,
		`process.stdout.write(JSON.stringify(module.materializeResultFile(input)));`,
	].join("\n");
	return new Promise((resolve, reject) => {
		execFile(
			process.execPath,
			["--experimental-strip-types", "-e", script],
			{
				encoding: "utf8",
				env: {
					...process.env,
					LPT57_INPUT: JSON.stringify(input.input),
					LPT57_SEAM_URL: input.seamUrl,
					LPT57_COORD: input.coordDir,
					LPT57_GO: input.goPath,
					LPT57_READY: input.readyPath,
					LPT57_COLLISION_LOG: input.collisionLogPath,
					LPT57_COLLISION_CLAIM: input.collisionClaimPath,
				},
			},
			(error, stdout, stderr) => {
				if (error) reject(new Error(`${error.message}\n${stderr}`));
				else resolve(stdout);
			},
		);
	});
}

function schedulerTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
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

	it("TS-01 rescans after a same-child no-replace collision and preserves every delivery", async () => {
		const materialize = await loadMaterialize();
		const sessionsDir = tempDir("pi-ts01-collision-");
		const coordDir = tempDir("pi-ts01-coordination-");
		const childSessionId = "same-child-004";
		const seamUrl = new URL("../pi-extension/subagents/delivery-files.ts", import.meta.url).href;
		const workers = 6;
		const inputs = Array.from({ length: workers }, (_, index) => ({
			sessionsDir,
			childSessionId,
			deliveryId: `collision-delivery-${index + 1}`,
			status: "completed" as DeliveryStatus,
			agentName: "lpt57-collision",
			answer: `answer-${index + 1}`,
			now: 1_788_247_000_000 + index,
		}));
		const goPath = join(coordDir, "go");
		const collisionLogPath = join(coordDir, "collisions.log");
		const collisionClaimPath = join(coordDir, "collision.claim");
		const launches = inputs.map((input, index) =>
			runConcurrentMaterializer({
				input,
				seamUrl,
				coordDir,
				goPath,
				readyPath: join(coordDir, `ready-${index}`),
				collisionLogPath,
				collisionClaimPath,
			}),
		);

		for (let turn = 0; turn < 5_000; turn++) {
			if (inputs.every((_, index) => existsSync(join(coordDir, `ready-${index}`)))) break;
			await schedulerTurn();
		}
		assert.ok(
			inputs.every((_, index) => existsSync(join(coordDir, `ready-${index}`))),
			"all materializers reached the shared start gate",
		);
		writeFileSync(goPath, "go", "utf8");
		const results = await Promise.all(launches).then((outputs) => outputs.map((output) => JSON.parse(output) as {
			path: string;
			sequence: number;
			filename: string;
		}));
		const collisions = readFileSync(collisionLogPath, "utf8").trim().split(/\r?\n/).filter(Boolean);
		assert.equal(collisions.length, 1, "the test must observe one injected no-replace collision");
		assert.ok(collisions.every((operation) => operation === "writeFileSync" || operation === "openSync"));

		const files = filesIn(resultDir(sessionsDir, childSessionId));
		assert.deepEqual(
			files,
			inputs.map((_, index) => `0${index + 1}-completed.md`),
			"collision recovery allocates one distinct sequence per delivery",
		);
		assert.equal(new Set(results.map((result) => result.path)).size, workers);
		assert.deepEqual(
			new Set(results.map((result) => result.sequence)),
			new Set(inputs.map((_, index) => index + 1)),
			"racing calls return distinct sequences after rescan",
		);
		const contents = files.map((file) => readFileSync(join(resultDir(sessionsDir, childSessionId), file), "utf8"));
		const deliveryIds = contents.map((contents) => /^delivery[\s_-]+id\s*[:=]\s*(.+)$/im.exec(headerOf(contents))?.[1]?.trim());
		assert.deepEqual(new Set(deliveryIds), new Set(inputs.map((input) => input.deliveryId)));
		assert.equal(deliveryIds.length, new Set(deliveryIds).size, "one file carries each stable delivery id");

		const firstPath = results[0]?.path;
		assert.ok(firstPath);
		const beforeRetry = readFileSync(firstPath, "utf8");
		const retry = materialize({ ...inputs[0], now: inputs[0].now + 60_000 });
		assert.equal(retry.path, firstPath, "retry recovers the immutable delivery file");
		assert.equal(readFileSync(firstPath, "utf8"), beforeRetry, "retry never replaces result bytes");
		assert.equal(filesIn(resultDir(sessionsDir, childSessionId)).length, workers);
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
		const childSessionId = "child-session-alpha";
		const deliveryId = "delivery-immutable-omega";
		const now = 1_788_247_116_000;
		const answer = "Line one.\n\nLine two with **markdown**.";

		const handle = materialize({
			sessionsDir,
			childSessionId,
			deliveryId,
			status: "completed",
			agentName: "lpt57-reviewer",
			answer,
			now,
		});

		const contents = readFileSync(handle.path, "utf8");
		const header = headerOf(contents);
		assert.match(header, /^status\s*[:=]\s*completed$/im, "header carries the status field");
		assert.match(header, /^agent(?:\s+name)?\s*[:=]\s*lpt57-reviewer$/im, "header carries the agent name field");
		const childHeader = /^child[\s_-]+session[\s_-]+id\s*[:=]\s*(.+)$/im.exec(header)?.[1]?.trim();
		const deliveryHeader = /^delivery[\s_-]+id\s*[:=]\s*(.+)$/im.exec(header)?.[1]?.trim();
		assert.equal(childHeader, childSessionId, "header carries a distinct labeled child session id");
		assert.equal(deliveryHeader, deliveryId, "header carries a distinct labeled delivery id");
		assert.notEqual(childHeader, deliveryHeader, "identity fields cannot be satisfied by an overlapping value");
		assert.match(
			header,
			new RegExp(new Date(now).toISOString().replace(/\./g, "\\.")),
			"header carries the injected UTC time",
		);
		const sequence = /(?:delivery\s+)?sequence\s*[:#=-]\s*(\d+)/i.exec(header)?.[1];
		assert.ok(sequence, "header carries a numeric delivery sequence");
		assert.equal(Number(sequence), handle.sequence, "header sequence matches the returned handle");
		assert.equal(handle.sequence, 1, "the first delivery uses sequence one");
		const separator = contents.indexOf("\n\n");
		assert.ok(separator >= 0, "result file has a header/body separator");
		const body = contents.slice(separator + 2);
		assert.ok(body === answer || body === `${answer}\n`, "body is exactly the source answer");
		assert.equal(countOccurrences(body, answer), 1);
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
		const separator = contents.indexOf("\n\n");
		assert.ok(separator >= 0, "result file has a header/body separator");
		const body = contents.slice(separator + 2);
		assert.ok(body === answer || body === `${answer}\n`, "the 200k body is exact");
		assert.equal(countOccurrences(body, answer), 1);
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
