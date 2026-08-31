import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = join(root, ".agents", "tmp");
const scopedPackageName = "@alexshp/pi-lpt-herdr-subagents";
const typescriptVersion = "5.9.2";
const modelFacingTools = [
	"subagent",
	"subagent_interrupt",
	"subagent_resume",
	"subagents_list",
	"herdr_workflow",
	"caller_ping",
	"subagent_done",
];

let runDirectory: string;
let consumerDirectory: string;
let tarballPath: string;
let packageFiles: Set<string>;

before(() => {
	mkdirSync(temporaryRoot, { recursive: true });
	runDirectory = mkdtempSync(join(temporaryRoot, "ale-46-packed-consumer-"));
	const sourcePack = JSON.parse(
		execFileSync(
			"npm",
			["pack", "--json", "--pack-destination", runDirectory],
			{ cwd: root, encoding: "utf8" },
		),
	)[0] as { filename: string };
	const staging = join(runDirectory, "scoped-package");
	mkdirSync(staging, { recursive: true });
	execFileSync("tar", ["-xzf", join(runDirectory, sourcePack.filename), "-C", staging]);
	const stagedRoot = join(staging, "package");
	const stagedManifestPath = join(stagedRoot, "package.json");
	const stagedManifest = JSON.parse(readFileSync(stagedManifestPath, "utf8"));
	stagedManifest.name = scopedPackageName;
	writeFileSync(stagedManifestPath, `${JSON.stringify(stagedManifest, null, 2)}\n`);
	const pack = JSON.parse(
		execFileSync(
			"npm",
			["pack", "--json", "--pack-destination", runDirectory],
			{ cwd: stagedRoot, encoding: "utf8" },
		),
	)[0] as {
		filename: string;
		files: Array<{ path: string }>;
	};
	tarballPath = join(runDirectory, pack.filename);
	packageFiles = new Set(pack.files.map(({ path }) => path));

	consumerDirectory = join(runDirectory, "consumer");
	mkdirSync(consumerDirectory, { recursive: true });
	writeFileSync(
		join(consumerDirectory, "package.json"),
		`${JSON.stringify(
			{
				name: "ale-46-installed-typescript-consumer",
				private: true,
				type: "module",
				dependencies: { [scopedPackageName]: `file:${tarballPath}` },
				devDependencies: { typescript: typescriptVersion },
			},
			null,
			2,
		)}\n`,
	);
	execFileSync(
		"npm",
		[
			"install",
			"--ignore-scripts",
			"--legacy-peer-deps",
			"--no-audit",
			"--no-fund",
		],
		{ cwd: consumerDirectory, encoding: "utf8" },
	);
});

after(() => {
	if (runDirectory) rmSync(runDirectory, { recursive: true, force: true });
});

function runInstalledProbe(name: string, source: string) {
	const probe = join(consumerDirectory, `${name}.mjs`);
	writeFileSync(probe, source);
	return spawnSync(process.execPath, ["--experimental-strip-types", probe], {
		cwd: consumerDirectory,
		encoding: "utf8",
		timeout: 10_000,
	});
}

describe("public subagent tree package boundary", () => {
	it("keeps generated runtime imports on shipped JavaScript files", () => {
		const generated = [...packageFiles].filter((path) => path.endsWith(".js"));
		assert.ok(generated.includes("index.js"), "packed root runtime is missing");
		for (const relative of generated) {
			const source = readFileSync(join(root, relative), "utf8");
			assert.doesNotMatch(source, /(?:from|import\()\s*["'].*\.ts["']/,
				`packed JavaScript must not import TypeScript: ${relative}`);
			for (const match of source.matchAll(/(?:from|import\()\s*["'](\.\/[^"']+\.js)["']/g)) {
				const dependency = join(relative, "..", match[1]);
				assert.equal(packageFiles.has(dependency), true, `${relative} imports missing ${dependency}`);
			}
		}
	});

	it("imports the packed scoped package root without extension registration side effects", () => {
		const imported = runInstalledProbe(
			"import-probe",
			[
				`const api = await import(${JSON.stringify(scopedPackageName)});`,
				`if (typeof api.createSubagentTree !== "function") throw new Error("missing createSubagentTree export");`,
				`if (typeof api.attachSubagentTree !== "function") throw new Error("missing attachSubagentTree export");`,
				`if ("default" in api) throw new Error("package root must not export the Pi extension initializer");`,
			].join("\n"),
		);
		assert.equal(
			imported.status,
			0,
			`packed consumer import failed:\n${imported.stderr || imported.stdout}`,
		);
		assert.equal(imported.signal, null, "package-root import must exit normally");
		assert.equal(imported.stdout, "", "package-root import must not write output");
		assert.equal(imported.stderr, "", "package-root import must not write errors");
	});

	it("validates fork lineage before replacing the active Pi context", () => {
		const probeRoot = join(consumerDirectory, "fork-context-probe");
		mkdirSync(probeRoot, { recursive: true });
		const oldSession = join(probeRoot, "old-session.jsonl");
		const invalidSession = join(probeRoot, "invalid-session.jsonl");
		const validSession = join(probeRoot, "valid-session.jsonl");
		writeFileSync(oldSession, `${JSON.stringify({ type: "session", id: "old-session", version: 3, cwd: probeRoot })}\n`);
		for (const [path, id] of [[invalidSession, "invalid-session"], [validSession, "valid-session"]]) {
			writeFileSync(path, `${JSON.stringify({ type: "session", id, version: 3, cwd: probeRoot, parentSession: oldSession })}\n`);
		}

		const probed = runInstalledProbe(
			"fork-context-probe",
			[
				`import { createSubagentTree, attachSubagentTree } from ${JSON.stringify(scopedPackageName)};`,
				`const probeRoot = ${JSON.stringify(probeRoot)};`,
				`const oldSession = ${JSON.stringify(oldSession)};`,
				`const invalidSession = ${JSON.stringify(invalidSession)};`,
				`const validSession = ${JSON.stringify(validSession)};`,
				`const trace = [];`,
				`function makePi(label) {`,
				`  return {`,
				`    getThinkingLevel() {`,
				`      trace.push("pi:" + label);`,
				`      throw new Error("active-pi:" + label);`,
				`    },`,
				`  };`,
				`}`,
				`function makeContext(label, sessionFile) {`,
				`  return {`,
				`    get cwd() { trace.push("ctx:" + label + ":cwd"); return probeRoot; },`,
				`    get model() { trace.push("ctx:" + label + ":model"); return { provider: "sentinel", id: label }; },`,
				`    sessionManager: {`,
				`      getSessionFile() { trace.push("ctx:" + label + ":session-file"); return sessionFile; },`,
				`      getSessionId() { trace.push("ctx:" + label + ":session-id"); return label; },`,
				`      getSessionDir() { trace.push("ctx:" + label + ":session-dir"); return probeRoot; },`,
				`    },`,
				`  };`,
				`}`,
				`const oldPi = makePi("old");`,
				`const invalidPi = makePi("invalid");`,
				`const validPi = makePi("valid");`,
				`const oldContext = makeContext("old", oldSession);`,
				`const invalidContext = makeContext("invalid", invalidSession);`,
				`const validContext = makeContext("valid", validSession);`,
				`const tree = createSubagentTree({ pi: oldPi, ctx: oldContext, metadata: { probe: "fork-context" } });`,
				`const credentials = { callerId: tree.callerId, treeId: tree.treeId, ownershipToken: tree.ownershipToken };`,
				`async function expectRejected(label, options) {`,
				`  try {`,
				`    await Promise.resolve(attachSubagentTree(options));`,
				`  } catch (error) {`,
				`    return { rejected: true, error: error instanceof Error ? error.message : String(error) };`,
				`  }`,
				`  throw new Error(label + " fork lineage attach was accepted");`,
				`}`,
				`async function observeActive(handle, expected) {`,
				`  trace.length = 0;`,
				`  let failure;`,
				`  try {`,
				`    await handle.launchChild({ parentId: handle.ownerId, name: "sentinel-" + expected, task: "must stop before launch", tools: ["read"] });`,
				`  } catch (error) {`,
				`    failure = error instanceof Error ? error.message : String(error);`,
				`  }`,
				`  if (failure !== "active-pi:" + expected) throw new Error("unexpected active Pi: " + failure);`,
				`  const expectedTrace = [`,
				`    "ctx:" + expected + ":session-file",`,
				`    "ctx:" + expected + ":session-id",`,
				`    "ctx:" + expected + ":session-dir",`,
				`    "ctx:" + expected + ":cwd",`,
				`    "ctx:" + expected + ":model",`,
				`    "pi:" + expected,`,
				`  ];`,
				`  if (JSON.stringify(trace) !== JSON.stringify(expectedTrace)) {`,
				`    throw new Error("unexpected active context trace: " + JSON.stringify(trace));`,
				`  }`,
				`  return [...trace];`,
				`}`,
				`trace.length = 0;`,
				`const missing = await expectRejected("missing", { pi: invalidPi, ctx: invalidContext, ...credentials, forkLineage: {} });`,
				`const afterMissing = await observeActive(tree, "old");`,
				`const mismatched = await expectRejected("mismatched", { pi: invalidPi, ctx: invalidContext, ...credentials, forkLineage: { previousSessionFile: oldSession + ".wrong" } });`,
				`const afterMismatched = await observeActive(tree, "old");`,
				`const attached = await Promise.resolve(attachSubagentTree({ pi: validPi, ctx: validContext, ...credentials, forkLineage: { previousSessionFile: oldSession } }));`,
				`const afterValid = await observeActive(attached, "valid");`,
				`process.stdout.write(JSON.stringify({ missing, afterMissing, mismatched, afterMismatched, afterValid }));`,
			].join("\n"),
		);
		assert.equal(
			probed.status,
			0,
			`fork context probe failed:\n${probed.stderr || probed.stdout}`,
		);
		const evidence = JSON.parse(probed.stdout);
		assert.equal(evidence.missing.rejected, true);
		assert.equal(evidence.mismatched.rejected, true);
		for (const observation of [evidence.afterMissing, evidence.afterMismatched]) {
			assert.deepEqual(observation, [
				"ctx:old:session-file",
				"ctx:old:session-id",
				"ctx:old:session-dir",
				"ctx:old:cwd",
				"ctx:old:model",
				"pi:old",
			]);
		}
		assert.deepEqual(evidence.afterValid, [
			"ctx:valid:session-file",
			"ctx:valid:session-id",
			"ctx:valid:session-dir",
			"ctx:valid:cwd",
			"ctx:valid:model",
			"pi:valid",
		]);
	});

	it("reattaches an already accepted fork session during ordinary resume without lineage", () => {
		const probeRoot = join(consumerDirectory, "accepted-fork-resume-probe");
		mkdirSync(probeRoot, { recursive: true });
		const oldSession = join(probeRoot, "old-session.jsonl");
		const forkSession = join(probeRoot, "fork-session.jsonl");
		const newSession = join(probeRoot, "new-session.jsonl");
		writeFileSync(oldSession, `${JSON.stringify({ type: "session", id: "old", version: 3, cwd: probeRoot })}\n`);
		writeFileSync(forkSession, `${JSON.stringify({ type: "session", id: "fork", version: 3, cwd: probeRoot, parentSession: oldSession })}\n`);
		writeFileSync(newSession, `${JSON.stringify({ type: "session", id: "new", version: 3, cwd: probeRoot })}\n`);
		const probed = runInstalledProbe("accepted-fork-resume-probe", [
			`import { createSubagentTree, attachSubagentTree } from ${JSON.stringify(scopedPackageName)};`,
			`const root = ${JSON.stringify(probeRoot)}; const oldSession = ${JSON.stringify(oldSession)}; const forkSession = ${JSON.stringify(forkSession)}; const newSession = ${JSON.stringify(newSession)};`,
			`function context(sessionFile) { return { cwd: root, model: { provider: "sentinel", id: "probe" }, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => sessionFile.split("/").pop().replace(".jsonl", ""), getSessionDir: () => root } }; }`,
			`const pi = { getThinkingLevel: () => "low" };`,
			`const credentials = {}; const first = createSubagentTree({ pi, ctx: context(oldSession) }); Object.assign(credentials, { callerId: first.callerId, treeId: first.treeId, ownershipToken: first.ownershipToken });`,
			`attachSubagentTree({ pi, ctx: context(forkSession), ...credentials, forkLineage: { previousSessionFile: oldSession } });`,
			`attachSubagentTree({ pi, ctx: context(newSession), ...credentials });`,
			`attachSubagentTree({ pi, ctx: context(forkSession), ...credentials });`,
			`process.stdout.write("accepted");`,
		].join("\n"));
		assert.equal(probed.status, 0, `accepted fork resume probe failed:\n${probed.stderr || probed.stdout}`);
		assert.equal(probed.stdout, "accepted");
	});

	it("fails closed when a synthesized branch ack hides a mid-launch pane", () => {
		const probeRoot = join(consumerDirectory, "mid-launch-cancel-probe");
		mkdirSync(probeRoot, { recursive: true });
		const probed = runInstalledProbe("mid-launch-cancel-probe", [
			`import { createSubagentTree } from ${JSON.stringify(scopedPackageName)};`,
			`import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";`,
			`import { join } from "node:path";`,
			`const probeRoot = ${JSON.stringify(probeRoot)};`,
			`const herdr = join(probeRoot, "herdr");`,
			`writeFileSync(herdr, [`,
			`  "#!/bin/sh",`,
			`  'if [ "$1" = "pane" ] && [ "$2" = "process-info" ]; then printf \\'{"result":{"process_info":{"pane_id":"orphan-pane","foreground_processes":[{"pid":999999}]}}}\\'; exit 0; fi',`,
			`  'if [ "$1" = "pane" ] && [ "$2" = "get" ]; then printf \\'{"error":{"code":"pane_not_found","message":"pane not found"}}\\'; exit 1; fi',`,
			`  "exit 0",`,
			`].join("\\n") + "\\n", { mode: 0o755 });`,
			`chmodSync(herdr, 0o755);`,
			`process.env.HERDR_ENV = "1"; process.env.PATH = probeRoot + ":" + process.env.PATH;`,
			`const sessionFile = join(probeRoot, "caller.jsonl");`,
			`writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "caller", version: 3, cwd: probeRoot }) + "\\n");`,
			`const ctx = { cwd: probeRoot, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "caller", getSessionDir: () => probeRoot } };`,
			`const tree = createSubagentTree({ pi: { getThinkingLevel: () => "low" }, ctx });`,
			`const treeDir = join(probeRoot, "artifacts", "caller", "subagent-trees", tree.treeId);`,
			`const branches = join(treeDir, "branches"); const nodes = join(treeDir, "nodes"); const results = join(treeDir, "results");`,
			`mkdirSync(branches, { recursive: true }); mkdirSync(nodes, { recursive: true }); mkdirSync(results, { recursive: true });`,
			`const branchOwner = "branch-owner"; const leaf = "queued-leaf"; const rootResult = join(results, branchOwner + ".json"); const leafResult = join(results, leaf + ".json");`,
			`writeFileSync(join(nodes, branchOwner + ".json"), JSON.stringify({ nodeId: branchOwner, parentId: tree.callerId, ownerId: tree.callerId, name: "orphan", surface: "orphan-pane", status: "running", open: true, resultPath: rootResult }) + "\\n");`,
			`writeFileSync(join(nodes, leaf + ".json"), JSON.stringify({ nodeId: leaf, parentId: branchOwner, ownerId: branchOwner, name: "queued", status: "queued", resultPath: leafResult }) + "\\n");`,
			`const inflight = join(branches, branchOwner + "." + leaf + ".inflight.json");`,
			`writeFileSync(inflight, JSON.stringify({ ownerId: branchOwner, pid: 999999, process: "dead-owner", nodeId: leaf, token: "launch-token" }) + "\\n");`,
			`const result = await tree.cancel();`,
			`const ack = JSON.parse(readFileSync(join(branches, branchOwner + ".cancelled.json"), "utf8"));`,
			`process.stdout.write(JSON.stringify({ state: result.state, errorCode: result.error?.code, synthesized: ack.synthesized, transactionsSettled: ack.transactionsSettled, unresolvedQueued: ack.unresolvedQueued, inflight: ack.inflight, inflightRetained: existsSync(inflight) }));`,
		].join("\n"));
		assert.equal(probed.status, 0, `mid-launch cancellation probe failed:\n${probed.stderr || probed.stdout}`);
		assert.deepEqual(JSON.parse(probed.stdout), {
			state: "failed",
			errorCode: "cancel_termination_failed",
			synthesized: true,
			transactionsSettled: false,
			unresolvedQueued: 1,
			inflight: 1,
			inflightRetained: true,
		});
	});

	it("ignores a stale reservation once its node has a durable pane surface", () => {
		const probeRoot = join(consumerDirectory, "surfaced-stale-inflight-probe");
		mkdirSync(probeRoot, { recursive: true });
		const probed = runInstalledProbe("surfaced-stale-inflight-probe", [
			`import { createSubagentTree } from ${JSON.stringify(scopedPackageName)};`,
			`import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";`,
			`import { join } from "node:path";`,
			`const probeRoot = ${JSON.stringify(probeRoot)};`,
			`const herdr = join(probeRoot, "herdr");`,
			`writeFileSync(herdr, [`,
			`  "#!/bin/sh",`,
			`  'if [ "$1" = "pane" ] && [ "$2" = "process-info" ]; then printf \\'{"result":{"process_info":{"foreground_processes":[{"pid":999999}]}}}\\'; exit 0; fi',`,
			`  'if [ "$1" = "pane" ] && [ "$2" = "get" ]; then printf \\'{"error":{"code":"pane_not_found","message":"pane not found"}}\\'; exit 1; fi',`,
			`  "exit 0",`,
			`].join("\\n") + "\\n", { mode: 0o755 });`,
			`chmodSync(herdr, 0o755);`,
			`process.env.HERDR_ENV = "1"; process.env.PATH = probeRoot + ":" + process.env.PATH;`,
			`const sessionFile = join(probeRoot, "caller.jsonl");`,
			`writeFileSync(sessionFile, JSON.stringify({ type: "session", id: "caller", version: 3, cwd: probeRoot }) + "\\n");`,
			`const ctx = { cwd: probeRoot, sessionManager: { getSessionFile: () => sessionFile, getSessionId: () => "caller", getSessionDir: () => probeRoot } };`,
			`const tree = createSubagentTree({ pi: { getThinkingLevel: () => "low" }, ctx });`,
			`const treeDir = join(probeRoot, "artifacts", "caller", "subagent-trees", tree.treeId);`,
			`const branches = join(treeDir, "branches"); const nodes = join(treeDir, "nodes"); const results = join(treeDir, "results");`,
			`mkdirSync(branches, { recursive: true }); mkdirSync(nodes, { recursive: true }); mkdirSync(results, { recursive: true });`,
			`const branchOwner = "branch-owner"; const leaf = "surfaced-leaf"; const rootResult = join(results, branchOwner + ".json"); const leafResult = join(results, leaf + ".json");`,
			`writeFileSync(join(nodes, branchOwner + ".json"), JSON.stringify({ nodeId: branchOwner, parentId: tree.callerId, ownerId: tree.callerId, name: "orphan", surface: "branch-pane", status: "running", open: true, resultPath: rootResult }) + "\\n");`,
			`writeFileSync(join(nodes, leaf + ".json"), JSON.stringify({ nodeId: leaf, parentId: branchOwner, ownerId: branchOwner, name: "surfaced", surface: "leaf-pane", status: "running", open: true, resultPath: leafResult }) + "\\n");`,
			`const inflight = join(branches, branchOwner + "." + leaf + ".inflight.json");`,
			`writeFileSync(inflight, JSON.stringify({ ownerId: branchOwner, pid: 999999, process: "dead-owner", nodeId: leaf, token: "launch-token" }) + "\\n");`,
			`const result = await tree.cancel();`,
			`const ack = JSON.parse(readFileSync(join(branches, branchOwner + ".cancelled.json"), "utf8"));`,
			`process.stdout.write(JSON.stringify({ state: result.state, errorCode: result.error?.code, synthesized: ack.synthesized, transactionsSettled: ack.transactionsSettled, unresolvedQueued: ack.unresolvedQueued, inflight: ack.inflight, inflightRetained: existsSync(inflight) }));`,
		].join("\n"));
		assert.equal(probed.status, 0, `surfaced stale-inflight probe failed:\n${probed.stderr || probed.stdout}`);
		assert.deepEqual(JSON.parse(probed.stdout), {
			state: "cancelled",
			synthesized: true,
			transactionsSettled: true,
			unresolvedQueued: 0,
			inflight: 0,
			inflightRetained: false,
		});
	});

	it("type-checks a realistic installed consumer against the complete public contract", () => {
		writeFileSync(
			join(consumerDirectory, "typed-consumer.ts"),
			[
				`import {`,
				`  createSubagentTree,`,
				`  attachSubagentTree,`,
				`  type SubagentTreeHandle,`,
				`  type SubagentTreeResult,`,
				`  type SubagentChildHandle,`,
				`  type SubagentChildResult,`,
				`} from ${JSON.stringify(scopedPackageName)};`,
				`declare const pi: any;`,
				`declare const ctx: any;`,
				`const created: SubagentTreeHandle = createSubagentTree({`,
				`  pi,`,
				`  ctx,`,
				`  metadata: { requestId: "request-1", filters: ["src", "docs"] },`,
				`});`,
				`const callerId: string = created.callerId;`,
				`const treeId: string = created.treeId;`,
				`const ownershipToken: string = created.ownershipToken;`,
				`const ownerId: string = created.ownerId;`,
				`const children: ReadonlyMap<string, SubagentChildHandle> = created.children;`,
				`async function consume(): Promise<void> {`,
				`  const child: SubagentChildHandle = await created.launchChild({`,
				`    parentId: callerId,`,
				`    name: "typed-router",`,
				`    task: "Return one answer",`,
				`    agent: "router",`,
				`    model: "pi-integration/test",`,
				`    thinking: "low",`,
				`    cwd: ".",`,
				`    worktree: { branch: "ale-46/typed-router", base: "main" },`,
				`    tools: ["read", "bash"],`,
				`    metadata: { stage: "router", attempt: 1 },`,
				`  });`,
				`  const childNodeId: string = child.nodeId;`,
				`  const childParentId: string = child.parentId;`,
				`  const childResult: SubagentChildResult = await child.result;`,
				`  const childResultId: string = childResult.resultId;`,
				`  const childAssistantEntryId: string = childResult.assistantEntryId;`,
				`  const childAnswer: string | null = childResult.answer;`,
				`  const childOutcome: string = childResult.outcome;`,
				`  const childSession: string | undefined = childResult.sessionReference;`,
				`  const childErrorCode: string | undefined = childResult.error?.code;`,
				`  const childErrorMessage: string | undefined = childResult.error?.message;`,
				`  const worktreePath: string | undefined = childResult.worktree?.path;`,
				`  const worktreeBranch: string | undefined = childResult.worktree?.branch;`,
				`  const worktreeBaseSha: string | undefined = childResult.worktree?.baseSha;`,
				`  const retainedWorkspaceId: string | undefined = childResult.worktree?.workspaceId;`,
				`  created.bindFinalCallback(async (result: SubagentTreeResult) => {`,
				`    const callbackTerminalId: string = result.terminalId;`,
				`    void callbackTerminalId;`,
				`  });`,
				`  const attached: SubagentTreeHandle = await attachSubagentTree({`,
				`    pi,`,
				`    ctx,`,
				`    callerId,`,
				`    treeId,`,
				`    ownershipToken,`,
				`    forkLineage: { previousSessionFile: "/sessions/old.jsonl" },`,
				`  });`,
				`  const nestedBranch: SubagentTreeHandle = await attachSubagentTree({ pi, ctx });`,
				`  const nestedOwnerId: string = nestedBranch.ownerId;`,
				`  const restoredChild: SubagentChildHandle | undefined = attached.children.get(childNodeId);`,
				`  const result: SubagentTreeResult = await attached.result;`,
				`  const terminalId: string = result.terminalId;`,
				`  const rootResult: SubagentChildResult = result.rootResult;`,
				`  const metadataValue: unknown = result.callerMetadata.value;`,
				`  for (const node of result.nodes) {`,
				`    const nodeId: string = node.nodeId;`,
				`    const parentId: string = node.parentId;`,
				`    const outcome: string = node.outcome;`,
				`    const open: boolean = node.open;`,
				`    const sessionReference: string | undefined = node.sessionReference;`,
				`    const errorCode: string | undefined = node.error?.code;`,
				`    void [nodeId, parentId, outcome, open, sessionReference, errorCode];`,
				`  }`,
				`  const cancelled: SubagentTreeResult = await attached.cancel();`,
				`  const cancellationErrorCode: string | undefined = cancelled.error?.code;`,
				`  const cancellationErrorMessage: string | undefined = cancelled.error?.message;`,
				`  void [ownerId, children, childParentId, childResultId, childAssistantEntryId, childAnswer, childOutcome, childSession, childErrorCode, childErrorMessage, worktreePath, worktreeBranch, worktreeBaseSha, retainedWorkspaceId, nestedOwnerId, restoredChild, terminalId, rootResult, metadataValue, cancelled, cancellationErrorCode, cancellationErrorMessage];`,
				`}`,
				`void consume;`,
			].join("\n"),
		);
		writeFileSync(
			join(consumerDirectory, "tsconfig.json"),
			`${JSON.stringify(
				{
					compilerOptions: {
						allowImportingTsExtensions: true,
						module: "NodeNext",
						moduleResolution: "NodeNext",
						noEmit: true,
						skipLibCheck: true,
						strict: true,
						target: "ES2022",
						types: [],
					},
					files: ["typed-consumer.ts"],
				},
				null,
				2,
			)}\n`,
		);
		const checked = spawnSync(
			process.execPath,
			[join(consumerDirectory, "node_modules", "typescript", "bin", "tsc"), "--project", "tsconfig.json"],
			{
				cwd: consumerDirectory,
				encoding: "utf8",
				timeout: 20_000,
			},
		);
		assert.equal(
			checked.status,
			0,
			`installed TypeScript consumer failed:\n${checked.stdout}${checked.stderr}`,
		);
	});

	it("publishes one typed package-root entry while keeping the Pi extension entry separate", () => {
		const manifest = JSON.parse(
			readFileSync(join(root, "package.json"), "utf8"),
		) as {
			exports?: Record<string, unknown>;
			types?: unknown;
			pi?: { extensions?: unknown };
		};
		assert.deepEqual(manifest.pi?.extensions, [
			"./pi-extension/subagents/index.ts",
		]);
		assert.deepEqual(
			{
				hasRootExport: Boolean(manifest.exports?.["."]),
				hasHeadlessExport: Boolean(manifest.exports?.["./headless"]),
				typesKind: typeof manifest.types,
			},
			{ hasRootExport: true, hasHeadlessExport: false, typesKind: "string" },
			"package.json must publish only the typed package-root API",
		);
	});

	it("declares the tested Pi 0.84 compatibility line", () => {
		const manifest = JSON.parse(
			readFileSync(join(root, "package.json"), "utf8"),
		) as { peerDependencies?: Record<string, string> };
		for (const dependency of [
			"@earendil-works/pi-ai",
			"@earendil-works/pi-coding-agent",
			"@earendil-works/pi-tui",
		]) {
			assert.equal(
				manifest.peerDependencies?.[dependency],
				">=0.84.4 <0.85.0",
				`${dependency} must stay on the tested Pi compatibility line`,
			);
		}
	});

	it("keeps runtime files while excluding local coordination evidence", () => {
		for (const required of [
			"README.md",
			"CHANGELOG.md",
			"skills/orchestrate/SKILL.md",
			"pi-extension/subagents/index.ts",
			"pi-extension/subagents/workflow-worker.js",
		]) {
			assert.equal(packageFiles.has(required), true, `missing package file: ${required}`);
		}
		const leaked = [...packageFiles].filter((path) =>
			/(^|\/)(?:\.agents|\.lpt|\.mesh|\.linear-project|sessions|journals?)(?:\/|$)/.test(path),
		);
		assert.deepEqual(leaked, [], "local coordination evidence leaked into the package");
	});

	it("keeps the package root free of model-facing tool registration", () => {
		const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
			exports?: Record<string, string | Record<string, string>>;
		};
		const rootExport = manifest.exports?.["."];
		const entry = typeof rootExport === "string"
			? rootExport
			: rootExport?.import ?? rootExport?.default;
		assert.equal(typeof entry, "string", "root export must identify its side-effect-free entry");
		if (typeof entry !== "string") return;
		const source = readFileSync(join(root, entry), "utf8");
		for (const tool of modelFacingTools) {
			assert.doesNotMatch(source, new RegExp(`registerTool\\([^)]*${tool}`));
		}
	});
});
