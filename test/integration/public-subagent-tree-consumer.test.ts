import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
	getProviderRequests,
	resetProviderRequests,
} from "./fake-provider.ts";
import {
	PI_TIMEOUT,
	cleanupTestEnv,
	closePane,
	createTestEnv,
	createTrackedSurface,
	getAvailableBackends,
	getPaneProcessInfo,
	interruptPane,
	readPane,
	restoreBackend,
	runInPane,
	setBackend,
	sleep,
	startPi,
	waitForPaneAbsence,
	waitForPaneReady,
	waitForProcessesExit,
	type TestEnv,
} from "./harness.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const scopedPackageName = "@alexshp/pi-lpt-herdr-subagents";
const forbiddenTools = [
	"subagent",
	"subagent_interrupt",
	"subagent_resume",
	"subagents_list",
	"herdr_workflow",
	"caller_ping",
	"subagent_done",
];

interface PaneRecord {
	pane_id?: string;
	label?: string;
	agent_session?: { value?: string };
}

function installPackedConsumer(env: TestEnv): void {
	const sourcePack = JSON.parse(
		execFileSync(
			"npm",
			["pack", "--json", "--pack-destination", env.dir],
			{ cwd: root, encoding: "utf8" },
		),
	)[0] as { filename: string };
	const staging = join(env.dir, "scoped-package");
	mkdirSync(staging, { recursive: true });
	execFileSync("tar", ["-xzf", join(env.dir, sourcePack.filename), "-C", staging]);
	const stagedRoot = join(staging, "package");
	const manifestPath = join(stagedRoot, "package.json");
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	manifest.name = scopedPackageName;
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
	const packed = JSON.parse(
		execFileSync(
			"npm",
			["pack", "--json", "--pack-destination", env.dir],
			{ cwd: stagedRoot, encoding: "utf8" },
		),
	)[0] as { filename: string };
	const tarball = join(env.dir, packed.filename);
	writeFileSync(
		join(env.dir, "package.json"),
		`${JSON.stringify({
			name: "ale-46-real-pi-consumer",
			private: true,
			type: "module",
			dependencies: { [scopedPackageName]: `file:${tarball}` },
		}, null, 2)}\n`,
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
		{ cwd: env.dir, encoding: "utf8" },
	);
}

function writeRole(env: TestEnv, name: string, frontmatter: string): void {
	const directory = join(env.dir, ".pi", "agents");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, `${name}.md`),
		`---\nname: ${name}\ndescription: ALE-46 real tree fixture\n${frontmatter}\ndisable-model-invocation: true\n---\n\nReturn the exact marker requested by the task.\n`,
	);
}

function consumerExtensionSource(options: {
	probeName: string;
	files: Record<string, string>;
	executeBody: string;
	nestedToolBody?: string;
	commandBody?: string;
	enableTransitions?: boolean;
}): string {
	return [
		`import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";`,
		`import { createSubagentTree, attachSubagentTree } from ${JSON.stringify(scopedPackageName)};`,
		`const files = ${JSON.stringify(options.files)};`,

		`let herdrDisabled = false;`,
		`if (files.disableHerdr && files.unavailablePath && files.herdrDisabled) {`,
		`  const timer = setInterval(() => {`,
		`    if (herdrDisabled || !existsSync(files.disableHerdr)) return;`,
		`    process.env.PATH = files.unavailablePath;`,
		`    herdrDisabled = true;`,
		`    appendFileSync(files.herdrDisabled, JSON.stringify({ pid: process.pid, subagentId: process.env.PI_SUBAGENT_ID ?? null }) + "\\n");`,
		`  }, 25);`,
		`  timer.unref();`,
		`}`,
		`let activeTree;`,
		`function append(path, value) { appendFileSync(path, JSON.stringify(value) + "\\n"); }`,
		`function write(path, value) { writeFileSync(path, JSON.stringify(value)); }`,
		`function message(error) { return error instanceof Error ? error.message : String(error); }`,
		`function bind(handle, bindingId) {`,
		`  handle.bindFinalCallback(async (result) => append(files.deliveries, { bindingId, result }));`,
		`  void handle.result.then(`,
		`    (result) => append(files.awaits, { bindingId, result }),`,
		`    (error) => append(files.failures, { bindingId, error: message(error) }),`,
		`  );`,
		`}`,
		`async function rejectAttach(pi, context, values) {`,
		`  try { await Promise.resolve(attachSubagentTree({ pi, ctx: context, ...values })); return { rejected: false }; }`,
		`  catch (error) { return { rejected: true, error: message(error) }; }`,
		`}`,
		`export default function consumerExtension(pi) {`,
		`  pi.on("session_start", async (event, context) => {`,
		`    const currentSessionFile = context.sessionManager.getSessionFile();`,
		`    const previousSessionFile = event.previousSessionFile ?? null;`,
		`    const header = currentSessionFile && existsSync(currentSessionFile)`,
		`      ? JSON.parse(readFileSync(currentSessionFile, "utf8").split("\\n")[0])`,
		`      : null;`,
		`    const forkLineage = event.reason === "fork" ? { previousSessionFile: event.previousSessionFile } : undefined;`,
		...(options.nestedToolBody ? [
			`    if (process.env.PI_SUBAGENT_ID) {`,
			`      try {`,
			`        const lineageRejections = event.reason === "fork" ? {`,
			`          missing: await rejectAttach(pi, context, { forkLineage: {} }),`,
			`          mismatched: await rejectAttach(pi, context, { forkLineage: { previousSessionFile: event.previousSessionFile + "-wrong" } }),`,
			`        } : undefined;`,
			`        const attached = await Promise.resolve(attachSubagentTree({ pi, ctx: context, ...(forkLineage ? { forkLineage } : {}) }));`,
			`        activeTree = attached;`,
			`        const bindingId = event.reason + "-" + Date.now();`,
			`        append(files.nestedAttachments, { reason: event.reason, bindingId, processId: process.pid, callerId: attached.callerId, treeId: attached.treeId, ownerId: attached.ownerId, childIds: [...attached.children.keys()].sort(), previousSessionFile, currentSessionFile, parentSession: header?.parentSession ?? null, lineageRejections });`,
			`        if (files.nestedRecovered) {`,
			`          for (const child of attached.children.values()) {`,
			`            void child.result.then((result) => append(files.nestedRecovered, { reason: event.reason, bindingId, processId: process.pid, nodeId: child.nodeId, result }));`,
			`          }`,
			`        }`,
			`      } catch (error) { append(files.failures, { stage: "nested_session_start", reason: event.reason, error: message(error) }); }`,
			`      return;`,
			`    }`,
		] : []),
		`    if (!existsSync(files.credentials)) return;`,
		`    try {`,
		`      const credentials = JSON.parse(readFileSync(files.credentials, "utf8"));`,
		`      const lineageRejections = event.reason === "fork" ? {`,
		`        missing: await rejectAttach(pi, context, { ...credentials, forkLineage: {} }),`,
		`        mismatched: await rejectAttach(pi, context, { ...credentials, forkLineage: { previousSessionFile: event.previousSessionFile + "-wrong" } }),`,
		`      } : undefined;`,
		`      const attached = await Promise.resolve(attachSubagentTree({ pi, ctx: context, ...credentials, ...(forkLineage ? { forkLineage } : {}) }));`,
		`      activeTree = attached;`,
		`      const bindingId = event.reason + "-" + Date.now();`,
		`      append(files.attachments, {`,
		`        reason: event.reason,`,
		`        bindingId,`,
		`        processId: process.pid,`,
		`        callerId: attached.callerId,`,
		`        treeId: attached.treeId,`,
		`        ownershipToken: attached.ownershipToken,`,
		`        childIds: [...attached.children.keys()].sort(),`,
		`        previousSessionFile,`,
		`        currentSessionFile,`,
		`        parentSession: header?.parentSession ?? null,`,
		`        lineageRejections,`,
		`      });`,
		`      bind(attached, bindingId);`,
		`      if (files.callerRecovered) {`,
		`        for (const child of attached.children.values()) {`,
		`          void child.result.then((result) => append(files.callerRecovered, { reason: event.reason, bindingId, processId: process.pid, nodeId: child.nodeId, result }));`,
		`        }`,
		`      }`,
		`    } catch (error) { append(files.failures, { stage: "session_start", reason: event.reason, error: message(error) }); }`,
		`  });`,
		`  pi.registerTool({`,
		`    name: ${JSON.stringify(options.probeName)},`,
		`    label: "Public tree consumer probe",`,
		`    description: "Exercise the installed public subagent tree API through Pi and Herdr.",`,
		`    parameters: { type: "object", properties: {}, additionalProperties: false },`,
		`    async execute(_id, _params, _signal, _update, context) {`,
		`      try {`,
		options.executeBody,
		`      } catch (error) {`,
		`        append(files.failures, { stage: "execute", error: message(error), stack: error?.stack });`,
		`        throw error;`,
		`      }`,
		`    },`,
		`  });`,
		...(options.nestedToolBody ? [
			`  pi.registerTool({`,
			`    name: "consumer_tree_nested_launch",`,
			`    label: "Nested tree launch",`,
			`    description: "Launch one direct child through the attached tree branch.",`,
			`    parameters: { type: "object", properties: {}, additionalProperties: false },`,
			`    async execute() {`,
			`      if (!activeTree) throw new Error("nested tree branch is not attached");`,
			options.nestedToolBody,
			`    },`,
			`  });`,
		] : []),
		...(options.commandBody ? [
			`  pi.registerCommand("tree-cancel", {`,
			`    description: "Cancel the ALE-46 test tree",`,
			`    async handler(_args, context) {`,
			`      try {`,
			options.commandBody,
			`      } catch (error) { append(files.failures, { stage: "cancel", error: message(error), stack: error?.stack }); }`,
			`    },`,
			`  });`,
		] : []),
		...(options.enableTransitions ? [
			`  pi.registerCommand("tree-transition", {`,
			`    description: "Run one supported same-process Pi session transition",`,
			`    async handler(args, context) {`,
			`      try {`,
			`        const transition = args.trim();`,
			`        if (files.transitions) append(files.transitions, { transition, processId: process.pid, sessionFile: context.sessionManager.getSessionFile() });`,
			`        if (transition === "reload") { await context.reload(); return; }`,
			`        if (transition === "new") { await context.newSession(); return; }`,
			`        if (transition === "resume") {`,
			`          const target = context.sessionManager.getSessionFile();`,
			`          if (!target) throw new Error("resume transition needs a persisted session");`,
			`          await context.newSession({ withSession: async (fresh) => { await fresh.switchSession(target); } });`,
			`          return;`,
			`        }`,
			`        if (transition === "fork") {`,
			`          const entries = context.sessionManager.getEntries();`,
			`          const entry = entries.findLast((candidate) => candidate.type === "message" && candidate.message?.role === "assistant")`,
			`            ?? entries.find((candidate) => candidate.type === "message" && candidate.message?.role === "user");`,
			`          if (!entry) throw new Error("fork transition needs a conversation entry");`,
			`          await context.fork(entry.id, { position: "at" });`,
			`          return;`,
			`        }`,
			`        throw new Error("unsupported test transition: " + transition);`,
			`      } catch (error) { append(files.failures, { stage: "transition", transition: args.trim(), error: message(error), stack: error?.stack }); }`,
			`    },`,
			`  });`,
		] : []),
		`}`,
	].join("\n");
}

function listWorkspacePanes(workspaceId: string): PaneRecord[] {
	return JSON.parse(
		execFileSync("herdr", ["pane", "list", "--workspace", workspaceId], {
			encoding: "utf8",
		}),
	).result.panes as PaneRecord[];
}


function listWorkspaceIds(): string[] {
	const workspaces = JSON.parse(
		execFileSync("herdr", ["workspace", "list"], { encoding: "utf8" }),
	).result.workspaces as Array<{ workspace_id?: unknown }>;
	return workspaces
		.map((workspace) => workspace.workspace_id)
		.filter((id): id is string => typeof id === "string")
		.sort();
}

function snapshotHerdrResources(env: TestEnv): {
	paneIds: string[];
	workspaceIds: string[];
} {
	return {
		paneIds: listWorkspacePanes(env.workspaceId)
			.map((pane) => pane.pane_id)
			.filter((id): id is string => typeof id === "string")
			.sort(),
		workspaceIds: listWorkspaceIds(),
	};
}

async function waitForJsonLine(
	path: string,
	predicate: (entry: any) => boolean,
	timeout = PI_TIMEOUT,
): Promise<any> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const match = readJsonLines(path).find(predicate);
		if (match) return match;
		await sleep(50);
	}
	assert.fail(`Timeout waiting for matching JSON line in ${path}: ${JSON.stringify(readJsonLines(path))}`);
}

async function waitForPaneNamed(
	env: TestEnv,
	label: string,
	timeout = PI_TIMEOUT,
): Promise<string> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const pane = listWorkspacePanes(env.workspaceId).find(
			(candidate) => candidate.label === label && typeof candidate.pane_id === "string",
		);
		if (pane?.pane_id) return pane.pane_id;
		await sleep(50);
	}
	throw new Error(`Timeout waiting for pane ${label}: ${JSON.stringify(listWorkspacePanes(env.workspaceId))}`);
}





async function waitForPaneSessionReference(paneId: string, timeout = PI_TIMEOUT): Promise<string> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		for (const pid of getPaneProcessInfo(paneId).pids) {
			try {
				const entry = readFileSync(`/proc/${pid}/environ`).toString().split("\0")
					.find((value) => value.startsWith("PI_SUBAGENT_SESSION="));
				if (entry) return entry.slice("PI_SUBAGENT_SESSION=".length);
			} catch {
				// The process may exit while its environment is inspected.
			}
		}
		await sleep(50);
	}
	throw new Error(`Timeout waiting for pane process session reference ${paneId}`);
}
async function waitForFileOrPiExit(
	path: string,
	surface: string,
	timeout = PI_TIMEOUT,
): Promise<string> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (existsSync(path)) return readFileSync(path, "utf8");
		const screen = readPane(surface, 300);
		if (/__TEST_DONE_\d+__/.test(screen)) {
			assert.fail(`Pi exited before producing ${path}:\n${screen}`);
		}
		await sleep(50);
	}
	assert.fail(`Timeout waiting for ${path}:\n${readPane(surface, 300)}`);
}

function readJsonLines(path: string): any[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}


interface AssistantTranscriptEntry {
	id: string;
	text: string;
}

function readAssistantTranscriptEntries(path: string): AssistantTranscriptEntry[] {
	return readJsonLines(path).flatMap((entry) => {
		if (entry?.type !== "message" || entry.message?.role !== "assistant" || typeof entry.id !== "string") return [];
		const content = entry.message.content;
		const text = typeof content === "string"
			? content
			: Array.isArray(content)
				? content
					.filter((part) => part?.type === "text" && typeof part.text === "string")
					.map((part) => part.text)
					.join("\n")
				: "";
		return [{ id: entry.id, text }];
	});
}

async function waitForNewAssistantTranscriptEntry(
	path: string,
	marker: string,
	knownIds: ReadonlySet<string>,
	timeout = PI_TIMEOUT,
): Promise<AssistantTranscriptEntry> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const match = readAssistantTranscriptEntries(path).find(
			(entry) => !knownIds.has(entry.id) && entry.text === marker,
		);
		if (match) return match;
		await sleep(50);
	}
	assert.fail(
		`Timeout waiting for a new assistant transcript entry containing ${JSON.stringify(marker)} in ${path}: ` +
		JSON.stringify(readAssistantTranscriptEntries(path)),
	);
}

function assertChildAnswerMatchesTranscript(result: any, marker: string): void {
	assert.equal(result.answer, marker, "the direct owner must receive the exact settled assistant answer");
	assert.equal(typeof result.assistantEntryId, "string");
	assert.ok(result.assistantEntryId.length > 0, "the settled result must expose its assistant transcript identity");
	assert.equal(typeof result.sessionReference, "string");
	assert.ok(result.sessionReference.length > 0 && result.sessionReference.length <= 10_000);
	const transcriptEntry = readAssistantTranscriptEntries(result.sessionReference).find(
		(entry) => entry.id === result.assistantEntryId,
	);
	assert.deepEqual(
		transcriptEntry,
		{ id: result.assistantEntryId, text: marker },
		"the public child result must correlate to the exact real assistant transcript entry",
	);
}



function assertBoundedNodeRows(nodes: any[], forbiddenAnswers: readonly string[]): void {
	const allowed = new Set([
		"nodeId",
		"parentId",
		"outcome",
		"open",
		"sessionReference",
		"error",
	]);
	const outcomes = new Set([
		"clean",
		"empty",
		"error",
		"intentional-abort",
		"unexpected-abort",
	]);
	for (const node of nodes) {
		assert.ok(node && typeof node === "object" && !Array.isArray(node), "each node row must be an object");
		assert.deepEqual(
			Object.keys(node).filter((key) => !allowed.has(key)),
			[],
			`node metadata contains a non-lifecycle field: ${JSON.stringify(node)}`,
		);
		assert.equal(typeof node.nodeId, "string");
		assert.ok(node.nodeId.length > 0);
		assert.equal(typeof node.parentId, "string");
		assert.ok(node.parentId.length > 0);
		assert.equal(typeof node.outcome, "string");
		assert.equal(outcomes.has(node.outcome), true, `unknown settled outcome: ${JSON.stringify(node.outcome)}`);
		assert.equal(typeof node.open, "boolean");
		if (node.sessionReference !== undefined) {
			assert.equal(typeof node.sessionReference, "string");
			assert.ok(node.sessionReference.length > 0 && node.sessionReference.length <= 10_000);
		}
		if (node.error !== undefined) {
			assert.ok(node.error && typeof node.error === "object" && !Array.isArray(node.error));
			assert.deepEqual(Object.keys(node.error).sort(), ["code", "message"]);
			assert.equal(typeof node.error.code, "string");
			assert.ok(node.error.code.length > 0 && node.error.code.length <= 256);
			assert.equal(typeof node.error.message, "string");
			assert.ok(node.error.message.length > 0 && node.error.message.length <= 4_000);
		}
		const serialized = JSON.stringify(node);
		for (const answer of forbiddenAnswers) {
			assert.equal(serialized.includes(answer), false, "node rows must never copy a full root or descendant answer");
		}
	}
}
function assertPackageToolsStayedInert(registeredTools: unknown): void {
	assert.ok(Array.isArray(registeredTools));
	for (const tool of forbiddenTools) {
		assert.equal(
			registeredTools.includes(tool),
			false,
			`package-root import/use registered model-facing tool ${tool}`,
		);
	}
}

for (const backend of getAvailableBackends()) {
	describe(`installed public subagent tree consumer [${backend}]`, {
		timeout: PI_TIMEOUT * 5,
	}, () => {
		let previousBackend: string | undefined;
		let env: TestEnv;
		let gates: string[];

		beforeEach(() => {
			previousBackend = setBackend(backend);
			env = createTestEnv(backend);
			gates = [];
			resetProviderRequests();
		});

		afterEach(async () => {
			for (const gate of gates) {
				try { writeFileSync(gate, "ready\n"); } catch {}
			}
			await sleep(50);
			cleanupTestEnv(env);
			restoreBackend(previousBackend);
		});


		it("rejects non-JSON and oversized caller metadata before launching work", async () => {
			installPackedConsumer(env);
			const id = `metadata-${Date.now()}`;
			const files = {
				credentials: join(env.dir, `${id}-unused-credentials.json`),
				attachments: join(env.dir, `${id}-attachments.jsonl`),
				deliveries: join(env.dir, `${id}-deliveries.jsonl`),
				awaits: join(env.dir, `${id}-awaits.jsonl`),
				failures: join(env.dir, `${id}-failures.jsonl`),
				result: join(env.dir, `${id}-result.json`),
			};
			const extension = join(env.dir, "consumer-tree-metadata.ts");
			writeFileSync(extension, consumerExtensionSource({
				probeName: "consumer_tree_metadata_probe",
				files,
				executeBody: [
					`        const rejected = {};`,
					`        const circular = {}; circular.self = circular;`,
					`        for (const [name, metadata] of [["circular", circular], ["bigint", { value: 1n }], ["oversized", { value: "x".repeat(65_537) }], ["utf8", { value: "€".repeat(21_846) }]]) {`,
					`          try { await Promise.resolve(createSubagentTree({ pi, ctx: context, metadata })); rejected[name] = { rejected: false }; }`,
					`          catch (error) { rejected[name] = { rejected: true, error: message(error) }; }`,
					`        }`,
					`        write(files.result, rejected);`,
					`        return { content: [{ type: "text", text: "metadata validation complete" }], details: rejected };`,
				].join("\n"),
			}));

			const surface = createTrackedSurface(env, `tree-metadata-parent-${id}`);
			await waitForPaneReady(surface);
			const resourcesBefore = snapshotHerdrResources(env);
			startPi(surface, env.dir, "Call consumer_tree_metadata_probe exactly once, then wait.", {
				extensionSource: extension,
				environment: { JITI_FS_CACHE: "0" },
				extraArgs: "--tools consumer_tree_metadata_probe",
			});

			const result = JSON.parse(await waitForFileOrPiExit(files.result, surface));
			assert.deepEqual(Object.keys(result).sort(), ["bigint", "circular", "oversized", "utf8"]);
			for (const attempt of Object.values(result) as Array<{ rejected: boolean; error?: string }>) {
				assert.equal(attempt.rejected, true);
				assert.equal(typeof attempt.error, "string");
				assert.ok(attempt.error && attempt.error.length <= 4_000);
			}
			assert.deepEqual(
				snapshotHerdrResources(env),
				resourcesBefore,
				"invalid metadata must be rejected before Pi/Herdr child launch",
			);
		});

		it("launches a nested tree with exact tools, rejects forbidden parents before work, and delivers through the latest binding", async () => {
			installPackedConsumer(env);
			const id = `nested-${Date.now()}`;
			const role = `tree-restrictive-${id}`;
			writeRole(
				env,
				role,
				[
					"model: pi-integration/test",
					"tools: read, bash, write, edit, subagent, subagents_list, consumer_tree_nested_launch",
					"deny-tools: bash",
					"spawning: false",
					"auto-exit: true",
				].join("\n"),
			);
			const gate = join(env.dir, `${id}.gate`);
			const forbiddenGo = join(env.dir, `${id}-forbidden-go.gate`);
			const forbiddenRelease = join(env.dir, `${id}-forbidden-release.gate`);
			gates.push(gate, forbiddenGo, forbiddenRelease);
			const forbiddenUnknown = `FORBIDDEN_UNKNOWN_${id}`;
			const forbiddenCross = `FORBIDDEN_CROSS_${id}`;
			const files = {
				credentials: join(env.dir, `${id}-credentials.json`),
				attachments: join(env.dir, `${id}-attachments.jsonl`),
				deliveries: join(env.dir, `${id}-deliveries.jsonl`),
				awaits: join(env.dir, `${id}-awaits.jsonl`),
				failures: join(env.dir, `${id}-failures.jsonl`),
				nestedAttachments: join(env.dir, `${id}-nested-attachments.jsonl`),
				nested: join(env.dir, `${id}-nested.json`),
				nestedResult: join(env.dir, `${id}-nested-result.json`),
				forbiddenStart: join(env.dir, `${id}-forbidden-start.json`),
				forbiddenDone: join(env.dir, `${id}-forbidden-done.json`),
				forbiddenGo,
				forbiddenRelease,
				phase: join(env.dir, `${id}-phase.json`),
				complete: join(env.dir, `${id}-complete.json`),
				imports: join(env.dir, `${id}-imports.json`),
			};
			const extension = join(env.dir, "consumer-tree-nested.ts");
			writeFileSync(extension, consumerExtensionSource({
				probeName: "consumer_tree_nested_probe",
				files,
				executeBody: [
					`        write(files.imports, { registeredTools: pi.getAllTools().map((tool) => tool.name).sort() });`,
					`        const tree = await Promise.resolve(createSubagentTree({ pi, ctx: context, metadata: { requestId: ${JSON.stringify(id)}, filters: ["src", "docs"] } }));`,
					`        activeTree = tree;`,
					`        const credentials = { callerId: tree.callerId, treeId: tree.treeId, ownershipToken: tree.ownershipToken };`,
					`        write(files.credentials, credentials);`,
					`        bind(tree, "create");`,
					`        const correct = await Promise.resolve(attachSubagentTree({ pi, ctx: context, ...credentials }));`,
					`        const mismatches = {`,
					`          caller: await rejectAttach(pi, context, { ...credentials, callerId: credentials.callerId + "-wrong" }),`,
					`          tree: await rejectAttach(pi, context, { ...credentials, treeId: credentials.treeId + "-wrong" }),`,
					`          token: await rejectAttach(pi, context, { ...credentials, ownershipToken: credentials.ownershipToken + "-wrong" }),`,
					`        };`,
					`        const other = await Promise.resolve(createSubagentTree({ pi, ctx: context, metadata: { requestId: "other" } }));`,
					`        const ceiling = ["read", "bash", "write", "subagent", "subagents_list", "consumer_tree_nested_launch", "grep"];`,
					`        write(files.forbiddenStart, { ready: true });`,
					`        while (!existsSync(files.forbiddenGo)) await new Promise((resolve) => setTimeout(resolve, 25));`,
					`        let unknownParentRejected = false;`,
					`        try { await tree.launchChild({ parentId: "unknown-node", name: ${JSON.stringify(forbiddenUnknown)}, agent: ${JSON.stringify(role)}, task: ${JSON.stringify(`Return exactly ${forbiddenUnknown}`)}, tools: ceiling }); } catch { unknownParentRejected = true; }`,
					`        let crossTreeParentRejected = false;`,
					`        try { await other.launchChild({ parentId: tree.callerId, name: ${JSON.stringify(forbiddenCross)}, agent: ${JSON.stringify(role)}, task: ${JSON.stringify(`Return exactly ${forbiddenCross}`)}, tools: ceiling }); } catch { crossTreeParentRejected = true; }`,
					`        write(files.forbiddenDone, { unknownParentRejected, crossTreeParentRejected });`,
					`        while (!existsSync(files.forbiddenRelease)) await new Promise((resolve) => setTimeout(resolve, 25));`,
					`        await other.cancel();`,
					`        const rootChild = await tree.launchChild({ parentId: tree.callerId, name: ${JSON.stringify(`Tree-root-${id}`)}, agent: ${JSON.stringify(role)}, task: ${JSON.stringify(`Return exactly TREE_ROOT_${id} after using the nested launch tool`)}, tools: ceiling, metadata: { stage: "root" } });`,
					`        let secondRootRejected = false;`,
					`        try { await tree.launchChild({ parentId: tree.callerId, name: "second-root", agent: ${JSON.stringify(role)}, task: "must not launch", tools: ["read"] }); } catch { secondRootRejected = true; }`,
					`        write(files.phase, {`,
					`          callerId: tree.callerId, treeId: tree.treeId, ownershipToken: tree.ownershipToken,`,
					`          correctAttach: { callerId: correct.callerId, treeId: correct.treeId, ownershipToken: correct.ownershipToken },`,
					`          mismatches, unknownParentRejected, crossTreeParentRejected, secondRootRejected, rootNodeId: rootChild.nodeId, rootParentId: rootChild.parentId,`,
					`        });`,
					`        void Promise.all([tree.result, rootChild.result]).then(async ([terminal, rootResult]) => {`,
					`          let lateLaunchRejected = false;`,
					`          try { await tree.launchChild({ parentId: rootChild.nodeId, name: "late-child", agent: ${JSON.stringify(role)}, task: "must not launch", tools: ["read"] }); } catch { lateLaunchRejected = true; }`,
					`          const immutable = { terminal: Object.isFrozen(terminal), rootResult: Object.isFrozen(terminal.rootResult), callerMetadata: Object.isFrozen(terminal.callerMetadata), nodes: Object.isFrozen(terminal.nodes), children: Object.isFrozen(tree.children), childrenClear: typeof tree.children.clear === "undefined" };`,
					`          write(files.complete, { terminal, rootResult, lateLaunchRejected, immutable });`,
					`        });`,
					`        return { content: [{ type: "text", text: "nested tree launched" }], details: { treeId: tree.treeId } };`,
				].join("\n"),
				nestedToolBody: [
					`      const leafChild = await activeTree.launchChild({ parentId: activeTree.ownerId, name: ${JSON.stringify(`Tree-leaf-${id}`)}, agent: ${JSON.stringify(role)}, task: ${JSON.stringify(`INTEGRATION_WAIT_FOR_FILE:${gate}\nReturn exactly TREE_LEAF_${id}`)}, tools: ["read", "write", "grep"], metadata: { stage: "leaf" } });`,
					`      write(files.nested, { ownerId: activeTree.ownerId, callerId: activeTree.callerId, treeId: activeTree.treeId, leafNodeId: leafChild.nodeId, leafParentId: leafChild.parentId });`,
					`      void leafChild.result.then((result) => write(files.nestedResult, result));`,
					`      return { content: [{ type: "text", text: "nested leaf launched" }], details: { nodeId: leafChild.nodeId } };`,
				].join("\n"),
			}));
			const nestedExtensions = join(env.dir, ".pi", "agent", "extensions");
			mkdirSync(nestedExtensions, { recursive: true });
			writeFileSync(join(nestedExtensions, "consumer-tree-nested.ts"), readFileSync(extension));

			const surface = createTrackedSurface(env, `tree-nested-parent-${id}`);
			await waitForPaneReady(surface);
			startPi(
				surface,
				env.dir,
				"Call consumer_tree_nested_probe exactly once, then wait.",
				{
					extensionSource: extension,
					environment: { JITI_FS_CACHE: "0" },
					extraArgs: "--tools consumer_tree_nested_probe",
				},
			);

			await waitForFileOrPiExit(files.forbiddenStart, surface);
			const resourcesBefore = snapshotHerdrResources(env);
			const requestsBefore = [...getProviderRequests()];
			writeFileSync(forbiddenGo, "ready\n");
			const forbidden = JSON.parse(await waitForFileOrPiExit(files.forbiddenDone, surface));
			const resourcesAfter = snapshotHerdrResources(env);
			const requestsAfter = [...getProviderRequests()];
			assert.deepEqual(resourcesAfter, resourcesBefore, "invalid ownership must fail before Herdr creates panes or workspaces");
			assert.deepEqual(requestsAfter, requestsBefore, "invalid ownership must fail before provider work");
			assert.equal(forbidden.unknownParentRejected, true);
			assert.equal(forbidden.crossTreeParentRejected, true);
			assert.equal(
				requestsAfter.some((request) => request.userText.includes(forbiddenUnknown) || request.userText.includes(forbiddenCross)),
				false,
				"forbidden task markers must never reach the provider",
			);
			writeFileSync(forbiddenRelease, "ready\n");

			const phase = JSON.parse(await waitForFileOrPiExit(files.phase, surface));
			assert.equal(phase.rootParentId, phase.callerId);
			assert.deepEqual(phase.correctAttach, {
				callerId: phase.callerId,
				treeId: phase.treeId,
				ownershipToken: phase.ownershipToken,
			});
			assert.equal(phase.mismatches.caller.rejected, true);
			assert.equal(phase.mismatches.tree.rejected, true);
			assert.equal(phase.mismatches.token.rejected, true);
			assert.equal(phase.unknownParentRejected, true);
			assert.equal(phase.crossTreeParentRejected, true);

			assert.equal(phase.secondRootRejected, true);
			assertPackageToolsStayedInert(JSON.parse(readFileSync(files.imports, "utf8")).registeredTools);

			const nested = JSON.parse(await waitForFileOrPiExit(files.nested, surface));
			assert.equal(nested.ownerId, phase.rootNodeId, "the root Pi process must own the branch that launches the leaf");
			assert.equal(nested.leafParentId, phase.rootNodeId);
			assert.equal(nested.callerId, phase.callerId);
			assert.equal(nested.treeId, phase.treeId);
			const nestedAttachment = readJsonLines(files.nestedAttachments).find((entry) => entry.ownerId === phase.rootNodeId);
			assert.ok(nestedAttachment, "the nested Pi process must claim its package context through attachSubagentTree");
			const leafPane = await waitForPaneNamed(env, `Tree-leaf-${id}`);
			assert.ok(getPaneProcessInfo(leafPane).pids.length > 0, "the leaf must be a real Herdr process");
			const rootRequestDeadline = Date.now() + PI_TIMEOUT;
			while (
				getProviderRequests().filter((request) => request.userText.includes(`TREE_ROOT_${id}`)).length < 2 &&
				Date.now() < rootRequestDeadline
			) await sleep(50);
			await sleep(250);
			assert.equal(existsSync(files.complete), false, "a settled root turn must wait for its queued or launched descendant");
			assert.equal(readJsonLines(files.deliveries).length, 0, "intermediate child work must not invoke the final callback");
			const rootProvider = getProviderRequests().find((request) =>
				request.userText.includes(`TREE_ROOT_${id}`),
			);
			assert.deepEqual(
				rootProvider?.tools,
				["consumer_tree_nested_launch", "read", "write"],
				"consumer ceiling ∩ role allowlist − package deny policy must be exact",
			);

			runInPane(surface, "/reload");
			const firstReload = await waitForJsonLine(files.attachments, (entry) => entry.reason === "reload");
			assert.deepEqual(firstReload.childIds, [phase.rootNodeId]);
			assert.equal(firstReload.callerId, phase.callerId);
			assert.equal(firstReload.treeId, phase.treeId);
			assert.equal(firstReload.ownershipToken, phase.ownershipToken);

			writeFileSync(gate, "ready\n");
			const complete = JSON.parse(await waitForFileOrPiExit(files.complete, surface));
			const leafResult = JSON.parse(await waitForFileOrPiExit(files.nestedResult, surface));
			await waitForJsonLine(files.deliveries, () => true);
			const deliveries = readJsonLines(files.deliveries);
			const awaits = readJsonLines(files.awaits);
			assert.equal(deliveries.length, 1, "the final callback must be delivered exactly once");
			assert.equal(deliveries[0].bindingId, firstReload.bindingId, "final delivery must use the latest post-reload binding");
			assert.ok(awaits.length >= 1, "the same terminal result must remain awaitable");
			assert.deepEqual(deliveries[0].result, awaits.at(-1).result);
			assert.equal(deliveries[0].result.terminalId, complete.terminal.terminalId);
			assert.deepEqual(complete.rootResult, complete.terminal.rootResult);
			assert.equal(complete.rootResult.resultId.length > 0, true);
			assert.equal(leafResult.resultId.length > 0, true);

			assertChildAnswerMatchesTranscript(complete.rootResult, `TREE_ROOT_${id}`);
			assertChildAnswerMatchesTranscript(leafResult, `TREE_LEAF_${id}`);
			assert.deepEqual(complete.terminal.callerMetadata.value, {
				requestId: id,
				filters: ["src", "docs"],
			});
			assert.deepEqual(
				complete.terminal.nodes.map((node: any) => [node.nodeId, node.parentId]).sort(),
				[
					[phase.rootNodeId, phase.callerId],
					[nested.leafNodeId, phase.rootNodeId],
				].sort(),
			);

			assertBoundedNodeRows(complete.terminal.nodes, [`TREE_ROOT_${id}`, `TREE_LEAF_${id}`]);
			assert.equal(complete.lateLaunchRejected, true);

			assert.deepEqual(complete.immutable, { terminal: true, rootResult: true, callerMetadata: true, nodes: true, children: true, childrenClear: true });
			const leafProvider = getProviderRequests().find((request) =>
				request.userText.includes(`TREE_LEAF_${id}`),
			);
			assert.deepEqual(leafProvider?.tools, ["read", "write"]);

			runInPane(surface, "/reload");
			await waitForJsonLine(
				files.attachments,
				(entry) => entry.reason === "reload" && entry.bindingId !== firstReload.bindingId,
			);
			await sleep(500);
			assert.equal(readJsonLines(files.deliveries).length, 1, "a later binding must not replay a delivered result");
		});

		it("holds a settled callback until a later attach binds it and never replays it", async () => {
			installPackedConsumer(env);
			const id = `pending-callback-${Date.now()}`;
			const role = `tree-pending-callback-${id}`;
			writeRole(env, role, [
				"model: pi-integration/test",
				"tools: read",
				"spawning: false",
				"auto-exit: true",
			].join("\n"));
			const files = {
				credentials: join(env.dir, `${id}-credentials.json`),
				attachments: join(env.dir, `${id}-attachments.jsonl`),
				deliveries: join(env.dir, `${id}-deliveries.jsonl`),
				awaits: join(env.dir, `${id}-awaits.jsonl`),
				failures: join(env.dir, `${id}-failures.jsonl`),
				settled: join(env.dir, `${id}-settled.json`),
			};
			const extension = join(env.dir, "consumer-tree-pending-callback.ts");
			writeFileSync(extension, consumerExtensionSource({
				probeName: "consumer_tree_pending_callback_probe",
				files,
				executeBody: [
					`        const tree = await Promise.resolve(createSubagentTree({ pi, ctx: context, metadata: { requestId: ${JSON.stringify(id)} } }));`,
					`        activeTree = tree;`,
					`        write(files.credentials, { callerId: tree.callerId, treeId: tree.treeId, ownershipToken: tree.ownershipToken });`,
					`        const rootChild = await tree.launchChild({ parentId: tree.callerId, name: ${JSON.stringify(`Pending-callback-${id}`)}, agent: ${JSON.stringify(role)}, task: ${JSON.stringify(`Return exactly PENDING_CALLBACK_${id}`)}, tools: ["read"] });`,
					`        void Promise.all([tree.result, rootChild.result]).then(([terminal, rootResult]) => write(files.settled, { terminal, rootResult }));`,
					`        return { content: [{ type: "text", text: "pending callback tree launched" }], details: { treeId: tree.treeId } };`,
				].join("\n"),
			}));

			const surface = createTrackedSurface(env, `tree-pending-callback-parent-${id}`);
			await waitForPaneReady(surface);
			startPi(surface, env.dir, "Call consumer_tree_pending_callback_probe exactly once, then wait.", {
				extensionSource: extension,
				environment: { JITI_FS_CACHE: "0" },
				extraArgs: "--tools consumer_tree_pending_callback_probe",
			});

			const settled = JSON.parse(await waitForFileOrPiExit(files.settled, surface));
			assert.deepEqual(settled.rootResult, settled.terminal.rootResult);
			assert.equal(readJsonLines(files.deliveries).length, 0, "settlement without a callback must remain pending");

			runInPane(surface, "/reload");
			const firstAttachment = await waitForJsonLine(files.attachments, (entry) => entry.reason === "reload");
			const delivery = await waitForJsonLine(files.deliveries, () => true);
			assert.equal(delivery.bindingId, firstAttachment.bindingId);
			assert.deepEqual(delivery.result, settled.terminal, "delayed callback delivery must match handle.result");
			assert.equal(readJsonLines(files.deliveries).length, 1);

			await sleep(750);
			assert.equal(readJsonLines(files.deliveries).length, 1, "a delivered settled callback must not replay");
			assert.deepEqual(readJsonLines(files.failures), []);
		});

		it("keeps a process-local failed descendant pane open with correlated bounded error facts", async () => {
			installPackedConsumer(env);

			const id = `open-${Date.now()}`;
			const role = `tree-open-${id}`;
			writeRole(env, role, [
				"model: pi-integration/test",
				"tools: read, consumer_tree_nested_launch",
				"spawning: false",
				"auto-exit: true",
			].join("\n"));
			const files = {
				credentials: join(env.dir, `${id}-credentials.json`),
				attachments: join(env.dir, `${id}-attachments.jsonl`),
				deliveries: join(env.dir, `${id}-deliveries.jsonl`),
				awaits: join(env.dir, `${id}-awaits.jsonl`),
				failures: join(env.dir, `${id}-failures.jsonl`),
				nestedAttachments: join(env.dir, `${id}-nested-attachments.jsonl`),
				nestedError: join(env.dir, `${id}-nested-error.json`),
				nestedErrorResult: join(env.dir, `${id}-nested-error-result.json`),
				complete: join(env.dir, `${id}-complete.json`),
				imports: join(env.dir, `${id}-imports.json`),
			};
			const extension = join(env.dir, "consumer-tree-open.ts");
			writeFileSync(extension, consumerExtensionSource({
				probeName: "consumer_tree_open_probe",
				files,
				executeBody: [
					`        write(files.imports, { registeredTools: pi.getAllTools().map((tool) => tool.name).sort() });`,
					`        const tree = await Promise.resolve(createSubagentTree({ pi, ctx: context, metadata: { requestId: ${JSON.stringify(id)} } }));`,
					`        activeTree = tree;`,
					`        write(files.credentials, { callerId: tree.callerId, treeId: tree.treeId, ownershipToken: tree.ownershipToken });`,
					`        bind(tree, "create");`,
					`        const rootChild = await tree.launchChild({ parentId: tree.callerId, name: ${JSON.stringify(`Open-root-${id}`)}, agent: ${JSON.stringify(role)}, task: ${JSON.stringify(`Use the nested launch tool, then return exactly OPEN_ROOT_${id}`)}, tools: ["read", "consumer_tree_nested_launch"] });`,
					`        void Promise.all([tree.result, rootChild.result]).then(([terminal, rootResult]) => write(files.complete, { terminal, rootResult, rootNodeId: rootChild.nodeId }));`,
					`        return { content: [{ type: "text", text: "open-error tree launched" }], details: { treeId: tree.treeId } };`,
				].join("\n"),
				nestedToolBody: [
					`      const failedChild = await activeTree.launchChild({ parentId: activeTree.ownerId, name: ${JSON.stringify(`Open-error-${id}`)}, agent: ${JSON.stringify(role)}, model: "pi-integration/fallback-fail", task: ${JSON.stringify(`Return exactly OPEN_ERROR_${id}`)}, tools: ["read"] });`,
					`      write(files.nestedError, { ownerId: activeTree.ownerId, failedNodeId: failedChild.nodeId, failedParentId: failedChild.parentId });`,
					`      void failedChild.result.then((result) => write(files.nestedErrorResult, result));`,
					`      return { content: [{ type: "text", text: "failed descendant launched" }], details: { nodeId: failedChild.nodeId } };`,
				].join("\n"),
			}));
			const nestedExtensions = join(env.dir, ".pi", "agent", "extensions");
			mkdirSync(nestedExtensions, { recursive: true });
			writeFileSync(join(nestedExtensions, "consumer-tree-open.ts"), readFileSync(extension));

			const surface = createTrackedSurface(env, `tree-open-parent-${id}`);
			await waitForPaneReady(surface);
			startPi(surface, env.dir, "Call consumer_tree_open_probe exactly once, then wait.", {
				extensionSource: extension,
				environment: { JITI_FS_CACHE: "0" },
				extraArgs: "--tools consumer_tree_open_probe",
			});

			const nestedError = JSON.parse(await waitForFileOrPiExit(files.nestedError, surface));
			const complete = JSON.parse(await waitForFileOrPiExit(files.complete, surface, PI_TIMEOUT * 3));
			const failedResult = JSON.parse(await waitForFileOrPiExit(files.nestedErrorResult, surface));
			assertPackageToolsStayedInert(JSON.parse(readFileSync(files.imports, "utf8")).registeredTools);
			assert.equal(complete.terminal.state, "completed", "a usable root answer remains authoritative");
			assert.equal(complete.rootResult.outcome, "clean");
			assert.equal(failedResult.outcome, "error");
			assert.equal(failedResult.resultId.length > 0, true);
			assert.equal(nestedError.ownerId, complete.rootNodeId, "the root Pi process must own the failed direct child");
			assert.equal(nestedError.failedParentId, nestedError.ownerId);
			const failedNode = complete.terminal.nodes.find((node: any) => node.nodeId === nestedError.failedNodeId);
			assert.ok(failedNode);
			assert.equal(failedNode.parentId, nestedError.ownerId);
			assert.equal(failedNode.outcome, "error");
			assert.equal(failedNode.open, true);
			assert.equal(typeof failedNode.sessionReference, "string");
			assert.ok(failedNode.sessionReference.length > 0);
			assert.ok(failedNode.sessionReference.length <= 10_000);
			for (const error of [failedResult.error, failedNode.error]) {
				assert.ok(error, "provider failure must keep structured error facts");
				assert.equal(typeof error.code, "string");
				assert.ok(error.code.length > 0 && error.code.length <= 256, "error code must be non-empty and bounded");
				assert.equal(typeof error.message, "string");
				assert.ok(error.message.length > 0 && error.message.length <= 4_000, "error message must be non-empty and bounded");
				assert.match(error.message, /deterministic fallback provider failure/i);
			}
			const failedRequests = getProviderRequests().filter((request) =>
				request.model === "fallback-fail" &&
				request.status === 503 &&
				request.userText.includes(`OPEN_ERROR_${id}`),
			);
			assert.ok(failedRequests.length > 0, "the recorded error must correlate to the deterministic final provider failure");
			const retainedPane = await waitForPaneNamed(env, `Open-error-${id}`);
			assert.ok(getPaneProcessInfo(retainedPane).pids.length > 0, "the reported open error pane must still exist");
		});


		it("returns one tree error after Pi exhausts exactly its built-in root retries", async () => {
			installPackedConsumer(env);
			const id = `root-failure-${Date.now()}`;
			const role = `tree-root-failure-${id}`;
			writeRole(env, role, [
				"model: pi-integration/fallback-fail",
				"tools: read",
				"spawning: false",
				"auto-exit: true",
			].join("\n"));
			const marker = `ROOT_FAILURE_${id}`;

			const rootName = `Root-failure-${id}`;
			const files = {
				credentials: join(env.dir, `${id}-credentials.json`),
				attachments: join(env.dir, `${id}-attachments.jsonl`),
				deliveries: join(env.dir, `${id}-deliveries.jsonl`),
				awaits: join(env.dir, `${id}-awaits.jsonl`),
				failures: join(env.dir, `${id}-failures.jsonl`),
				complete: join(env.dir, `${id}-complete.json`),
			};
			const extension = join(env.dir, "consumer-tree-root-failure.ts");
			writeFileSync(extension, consumerExtensionSource({
				probeName: "consumer_tree_root_failure_probe",
				files,
				executeBody: [
					`        const tree = await Promise.resolve(createSubagentTree({ pi, ctx: context, metadata: { requestId: ${JSON.stringify(id)} } }));`,
					`        activeTree = tree;`,
					`        write(files.credentials, { callerId: tree.callerId, treeId: tree.treeId, ownershipToken: tree.ownershipToken });`,
					`        bind(tree, "create");`,
					`        const rootChild = await tree.launchChild({ parentId: tree.callerId, name: ${JSON.stringify(rootName)}, agent: ${JSON.stringify(role)}, model: "pi-integration/fallback-fail", task: ${JSON.stringify(`Return exactly ${marker}`)}, tools: ["read"] });`,
					`        void Promise.all([tree.result, rootChild.result]).then(([terminal, rootResult]) => write(files.complete, { terminal, rootResult }));`,
					`        return { content: [{ type: "text", text: "root failure tree launched" }], details: { treeId: tree.treeId } };`,
				].join("\n"),
			}));

			const surface = createTrackedSurface(env, `tree-root-failure-parent-${id}`);
			await waitForPaneReady(surface);
			startPi(surface, env.dir, "Call consumer_tree_root_failure_probe exactly once, then wait.", {
				extensionSource: extension,
				environment: { JITI_FS_CACHE: "0" },
				extraArgs: "--tools consumer_tree_root_failure_probe",
			});

			let retainedPane: string | undefined;
			let retainedProcesses: number[] = [];
			try {
				const complete = JSON.parse(await waitForFileOrPiExit(files.complete, surface, PI_TIMEOUT * 2));
				retainedPane = await waitForPaneNamed(env, rootName);
				const delivery = await waitForJsonLine(files.deliveries, () => true, PI_TIMEOUT * 2);
				const failedRequests = getProviderRequests().filter((request) =>
					request.model === "fallback-fail" && request.status === 503 && request.userText.includes(marker),
				);
				assert.equal(failedRequests.length, 4, "Pi must make one initial request plus its built-in three retries");
				assert.equal(complete.rootResult.outcome, "error");
				assert.equal(complete.terminal.state, "failed");
				assert.deepEqual(complete.terminal.rootResult, complete.rootResult);
				assert.deepEqual(delivery.result, complete.terminal);
				assert.equal(readJsonLines(files.deliveries).length, 1, "root failure must produce one terminal tree error");
				assert.equal(complete.terminal.nodes.length, 1);
				assertBoundedNodeRows(complete.terminal.nodes, [marker]);

				const rootNode = complete.terminal.nodes[0];
				assert.equal(rootNode.open, true, "the failed root must remain open for inspection");
				assert.equal(typeof rootNode.sessionReference, "string");
				assert.ok(rootNode.sessionReference.length > 0 && rootNode.sessionReference.length <= 10_000);
				assert.equal(complete.rootResult.sessionReference, rootNode.sessionReference);
				assert.ok(existsSync(rootNode.sessionReference), "the retained root session reference must remain readable");
				const paneRecord = listWorkspacePanes(env.workspaceId).find((pane) => pane.pane_id === retainedPane);
				assert.equal(paneRecord?.label, rootName);
				assert.equal(await waitForPaneSessionReference(retainedPane), rootNode.sessionReference);
				retainedProcesses = getPaneProcessInfo(retainedPane).pids;
				assert.ok(retainedProcesses.length > 0, "the named failed-root Herdr process must remain present");

				await sleep(250);
				assert.equal(
					getProviderRequests().filter((request) => request.model === "fallback-fail" && request.userText.includes(marker)).length,
					4,
					"the public API must not add a retry after Pi's retry loop",
				);
			} finally {
				if (retainedPane) {
					try { closePane(retainedPane); } catch {}
					assert.equal(await waitForPaneAbsence(retainedPane, { timeoutMs: PI_TIMEOUT }), true);
					assert.deepEqual(await waitForProcessesExit(retainedProcesses, { timeoutMs: PI_TIMEOUT }), []);
				}
			}
		});

		it("keeps a real Escape-interrupted root non-terminal until explicit tree cancellation", async () => {
			installPackedConsumer(env);
			const id = `interrupt-${Date.now()}`;
			const role = `tree-interrupt-${id}`;
			writeRole(env, role, [
				"model: pi-integration/test",
				"tools: read",
				"spawning: false",
				"auto-exit: true",
			].join("\n"));
			const gate = join(env.dir, `${id}.gate`);
			gates.push(gate);
			const marker = `INTERRUPTED_ROOT_${id}`;
			const rootName = `Interrupt-root-${id}`;
			const files = {
				credentials: join(env.dir, `${id}-credentials.json`),
				attachments: join(env.dir, `${id}-attachments.jsonl`),
				deliveries: join(env.dir, `${id}-deliveries.jsonl`),
				awaits: join(env.dir, `${id}-awaits.jsonl`),
				failures: join(env.dir, `${id}-failures.jsonl`),
				ready: join(env.dir, `${id}-ready.json`),
				cancelled: join(env.dir, `${id}-cancelled.json`),
			};
			const extension = join(env.dir, "consumer-tree-interrupt.ts");
			writeFileSync(extension, consumerExtensionSource({
				probeName: "consumer_tree_interrupt_probe",
				files,
				executeBody: [
					`        const tree = await Promise.resolve(createSubagentTree({ pi, ctx: context, metadata: { requestId: ${JSON.stringify(id)} } }));`,
					`        activeTree = tree;`,
					`        write(files.credentials, { callerId: tree.callerId, treeId: tree.treeId, ownershipToken: tree.ownershipToken });`,
					`        bind(tree, "create");`,
					`        const rootChild = await tree.launchChild({ parentId: tree.callerId, name: ${JSON.stringify(rootName)}, agent: ${JSON.stringify(role)}, task: ${JSON.stringify(`INTEGRATION_WAIT_FOR_FILE:${gate}\nReturn exactly ${marker}`)}, tools: ["read"] });`,
					`        write(files.ready, { rootNodeId: rootChild.nodeId });`,
					`        return { content: [{ type: "text", text: "interrupt tree ready" }], details: { treeId: tree.treeId } };`,
				].join("\n"),
				commandBody: [
					`        if (!activeTree) throw new Error("no active tree");`,
					`        const terminal = await activeTree.cancel();`,
					`        write(files.cancelled, terminal);`,
				].join("\n"),
			}));

			const surface = createTrackedSurface(env, `tree-interrupt-parent-${id}`);
			await waitForPaneReady(surface);
			startPi(surface, env.dir, "Call consumer_tree_interrupt_probe exactly once, then wait.", {
				extensionSource: extension,
				environment: { JITI_FS_CACHE: "0" },
				extraArgs: "--tools consumer_tree_interrupt_probe",
			});

			await waitForFileOrPiExit(files.ready, surface);
			const rootPane = await waitForPaneNamed(env, rootName);
			const rootSession = await waitForPaneSessionReference(rootPane);
			assert.ok(rootSession, "the real root must publish its Pi session reference");
			const rootProcesses = getPaneProcessInfo(rootPane).pids;
			assert.ok(rootProcesses.length > 0);

			interruptPane(rootPane);
			await sleep(250);
			assert.equal(existsSync(files.cancelled), false);
			assert.equal(readJsonLines(files.deliveries).length, 0, "Escape must not deliver a terminal tree result");
			assert.ok(getPaneProcessInfo(rootPane).pids.length > 0, "Escape must keep the root Pi process open");

			runInPane(surface, "/tree-cancel");
			const cancelled = JSON.parse(await waitForFileOrPiExit(files.cancelled, surface));
			assert.equal(cancelled.state, "cancelled");
			assert.equal(await waitForPaneAbsence(rootPane, { timeoutMs: PI_TIMEOUT }), true);
			assert.deepEqual(await waitForProcessesExit(rootProcesses, { timeoutMs: PI_TIMEOUT }), []);
		});

		for (const transition of ["reload", "new", "resume"] as const) {
			it(`preserves caller and nested direct-child results across /${transition}`, async () => {
				installPackedConsumer(env);
				const id = `transition-${transition}-${Date.now()}`;
				const role = `tree-transition-${id}`;
				writeRole(env, role, [
					"model: pi-integration/test",
					"tools: read, consumer_tree_nested_launch",
					"spawning: false",
					"auto-exit: false",
				].join("\n"));
				const gate = join(env.dir, `${id}.gate`);
				gates.push(gate);
				const files = {
					credentials: join(env.dir, `${id}-credentials.json`),
					attachments: join(env.dir, `${id}-attachments.jsonl`),
					deliveries: join(env.dir, `${id}-deliveries.jsonl`),
					awaits: join(env.dir, `${id}-awaits.jsonl`),
					failures: join(env.dir, `${id}-failures.jsonl`),
					nestedAttachments: join(env.dir, `${id}-nested-attachments.jsonl`),
					nestedRecovered: join(env.dir, `${id}-nested-recovered.jsonl`),
					nested: join(env.dir, `${id}-nested.json`),
					phase: join(env.dir, `${id}-phase.json`),
					complete: join(env.dir, `${id}-complete.json`),
					imports: join(env.dir, `${id}-imports.json`),
				};
				const rootName = `Transition-root-${id}`;
				const leafName = `Transition-leaf-${id}`;
				const extension = join(env.dir, `consumer-tree-transition-${transition}.ts`);
				writeFileSync(extension, consumerExtensionSource({
					probeName: "consumer_tree_transition_probe",
					files,
					enableTransitions: true,
					executeBody: [
						`        write(files.imports, { registeredTools: pi.getAllTools().map((tool) => tool.name).sort() });`,
						`        const tree = await Promise.resolve(createSubagentTree({ pi, ctx: context, metadata: { requestId: ${JSON.stringify(id)} } }));`,
						`        activeTree = tree;`,
						`        write(files.credentials, { callerId: tree.callerId, treeId: tree.treeId, ownershipToken: tree.ownershipToken });`,
						`        bind(tree, "create");`,
						`        const rootChild = await tree.launchChild({ parentId: tree.callerId, name: ${JSON.stringify(rootName)}, agent: ${JSON.stringify(role)}, task: ${JSON.stringify(`Use the nested launch tool, then return exactly TRANSITION_ROOT_${id}`)}, tools: ["read", "consumer_tree_nested_launch"] });`,
						`        write(files.phase, { callerId: tree.callerId, treeId: tree.treeId, ownershipToken: tree.ownershipToken, rootNodeId: rootChild.nodeId, rootParentId: rootChild.parentId });`,
						`        void Promise.all([tree.result, rootChild.result]).then(([terminal, rootResult]) => write(files.complete, { terminal, rootResult }));`,
						`        return { content: [{ type: "text", text: "transition tree launched" }], details: { treeId: tree.treeId } };`,
					].join("\n"),
					nestedToolBody: [
						`      const leafChild = await activeTree.launchChild({ parentId: activeTree.ownerId, name: ${JSON.stringify(leafName)}, agent: ${JSON.stringify(role)}, task: ${JSON.stringify(`INTEGRATION_WAIT_FOR_FILE:${gate}\nReturn exactly TRANSITION_LEAF_${id}`)}, tools: ["read"] });`,
						`      write(files.nested, { ownerId: activeTree.ownerId, callerId: activeTree.callerId, treeId: activeTree.treeId, leafNodeId: leafChild.nodeId, leafParentId: leafChild.parentId });`,
						`      return { content: [{ type: "text", text: "transition leaf launched" }], details: { nodeId: leafChild.nodeId } };`,
					].join("\n"),
				}));
				const nestedExtensions = join(env.dir, ".pi", "agent", "extensions");
				mkdirSync(nestedExtensions, { recursive: true });
				writeFileSync(join(nestedExtensions, "consumer-tree-transition.ts"), readFileSync(extension));

				const surface = createTrackedSurface(env, `tree-transition-parent-${id}`);
				await waitForPaneReady(surface);
				startPi(surface, env.dir, `Call consumer_tree_transition_probe exactly once for TRANSITION_PARENT_${id}, then wait.`, {
					extensionSource: extension,
					environment: { JITI_FS_CACHE: "0" },
					extraArgs: "--tools consumer_tree_transition_probe",
				});

				const phase = JSON.parse(await waitForFileOrPiExit(files.phase, surface));
				const nested = JSON.parse(await waitForFileOrPiExit(files.nested, surface));
				assert.equal(phase.rootParentId, phase.callerId);
				assert.equal(nested.ownerId, phase.rootNodeId);
				assert.equal(nested.leafParentId, phase.rootNodeId);
				assertPackageToolsStayedInert(JSON.parse(readFileSync(files.imports, "utf8")).registeredTools);
				const rootPane = await waitForPaneNamed(env, rootName);
				const leafPane = await waitForPaneNamed(env, leafName);
				assert.ok(getPaneProcessInfo(rootPane).pids.length > 0, "root transition must run in a real Pi/Herdr process");
				assert.ok(getPaneProcessInfo(leafPane).pids.length > 0, "leaf transition must run in a real Pi/Herdr process");
				const idleDeadline = Date.now() + PI_TIMEOUT;
				while (
					(getProviderRequests().filter((request) => request.userText.includes(`TRANSITION_ROOT_${id}`)).length < 2 ||
					getProviderRequests().filter((request) => request.userText.includes(`TRANSITION_PARENT_${id}`)).length < 2) &&
					Date.now() < idleDeadline
				) await sleep(50);

				assert.ok(
					getProviderRequests().filter((request) => request.userText.includes(`TRANSITION_ROOT_${id}`)).length >= 2,
					"root Pi must settle its launch turn before the transition",
				);
				assert.ok(
					getProviderRequests().filter((request) => request.userText.includes(`TRANSITION_PARENT_${id}`)).length >= 2,
					"caller Pi must settle its launch turn before the transition",
				);

				runInPane(rootPane, `/tree-transition ${transition}`);
				const nestedAttachment = await waitForJsonLine(
					files.nestedAttachments,
					(entry) => entry.reason === transition && entry.childIds.includes(nested.leafNodeId),
				);
				assert.equal(nestedAttachment.ownerId, phase.rootNodeId);
				assert.equal(nestedAttachment.callerId, phase.callerId);
				assert.equal(nestedAttachment.treeId, phase.treeId);
				assert.deepEqual(nestedAttachment.childIds, [nested.leafNodeId]);

				runInPane(surface, `/tree-transition ${transition}`);
				const attachment = await waitForJsonLine(
					files.attachments,
					(entry) => entry.reason === transition && entry.childIds.includes(phase.rootNodeId),
				);
				assert.equal(attachment.callerId, phase.callerId);
				assert.equal(attachment.treeId, phase.treeId);
				assert.equal(attachment.ownershipToken, phase.ownershipToken);
				assert.deepEqual(attachment.childIds, [phase.rootNodeId]);
				assert.equal(existsSync(files.complete), false, `/${transition} must not bypass the descendant barrier`);

				writeFileSync(gate, "ready\n");
				const recovered = await waitForJsonLine(
					files.nestedRecovered,
					(entry) => entry.bindingId === nestedAttachment.bindingId && entry.nodeId === nested.leafNodeId,
				);
				const complete = JSON.parse(await waitForFileOrPiExit(files.complete, surface));
				const delivery = await waitForJsonLine(files.deliveries, () => true);
				assert.equal(recovered.result.resultId.length > 0, true);
				assert.equal(recovered.result.outcome, "clean");
				assert.equal(delivery.bindingId, attachment.bindingId, `final delivery after /${transition} must use the latest attachment`);
				assert.deepEqual(delivery.result, complete.terminal);
				assert.deepEqual(complete.rootResult, complete.terminal.rootResult);
				assert.equal(readJsonLines(files.deliveries).length, 1);

				runInPane(surface, `/tree-transition ${transition}`);
				await waitForJsonLine(
					files.attachments,
					(entry) => entry.reason === transition && entry.bindingId !== attachment.bindingId,
				);
				await sleep(250);
				assert.equal(readJsonLines(files.deliveries).length, 1, `a later /${transition} binding must not replay the result`);
				assert.deepEqual(readJsonLines(files.failures), [], `/${transition} must not leave consumer failures`);
			});
		}


		async function runForkLineageScenario(ownerToFork: "nested" | "caller"): Promise<void> {
			installPackedConsumer(env);
			const id = `fork-${ownerToFork}-${Date.now()}`;
			const role = `tree-fork-${id}`;
			writeRole(env, role, [
				"model: pi-integration/test",
				"tools: read, consumer_tree_nested_launch",
				"spawning: false",
				"auto-exit: false",
			].join("\n"));
			const gate = join(env.dir, `${id}.gate`);
			gates.push(gate);
			const rootMarker = `FORK_ROOT_${id}`;
			const leafMarker = `FORK_LEAF_${id}`;
			const rootName = `Fork-root-${id}`;
			const leafName = `Fork-leaf-${id}`;
			const files = {
				credentials: join(env.dir, `${id}-credentials.json`),
				attachments: join(env.dir, `${id}-attachments.jsonl`),
				deliveries: join(env.dir, `${id}-deliveries.jsonl`),
				awaits: join(env.dir, `${id}-awaits.jsonl`),
				failures: join(env.dir, `${id}-failures.jsonl`),
				nestedAttachments: join(env.dir, `${id}-nested-attachments.jsonl`),
				nestedRecovered: join(env.dir, `${id}-nested-recovered.jsonl`),
				callerRecovered: join(env.dir, `${id}-caller-recovered.jsonl`),
				nested: join(env.dir, `${id}-nested.json`),
				phase: join(env.dir, `${id}-phase.json`),
				complete: join(env.dir, `${id}-complete.json`),
				transitions: join(env.dir, `${id}-transitions.jsonl`),
				imports: join(env.dir, `${id}-imports.json`),
			};
			const extension = join(env.dir, `consumer-tree-fork-${ownerToFork}.ts`);
			writeFileSync(extension, consumerExtensionSource({
				probeName: "consumer_tree_transition_probe",
				files,
				enableTransitions: true,
				executeBody: [
					`        write(files.imports, { registeredTools: pi.getAllTools().map((tool) => tool.name).sort() });`,
					`        const tree = await Promise.resolve(createSubagentTree({ pi, ctx: context, metadata: { requestId: ${JSON.stringify(id)} } }));`,
					`        activeTree = tree;`,
					`        write(files.credentials, { callerId: tree.callerId, treeId: tree.treeId, ownershipToken: tree.ownershipToken });`,
					`        bind(tree, "create");`,
					`        const rootChild = await tree.launchChild({ parentId: tree.callerId, name: ${JSON.stringify(rootName)}, agent: ${JSON.stringify(role)}, task: ${JSON.stringify(`Use the nested launch tool, then return exactly ${rootMarker}`)}, tools: ["read", "consumer_tree_nested_launch"] });`,
					`        write(files.phase, { callerId: tree.callerId, treeId: tree.treeId, ownershipToken: tree.ownershipToken, processId: process.pid, sessionFile: context.sessionManager.getSessionFile(), rootNodeId: rootChild.nodeId, rootParentId: rootChild.parentId });`,
					`        void Promise.all([tree.result, rootChild.result]).then(([terminal, rootResult]) => write(files.complete, { terminal, rootResult }));`,
					`        return { content: [{ type: "text", text: "fork tree launched" }], details: { treeId: tree.treeId } };`,
				].join("\n"),
				nestedToolBody: [
					`      const leafChild = await activeTree.launchChild({ parentId: activeTree.ownerId, name: ${JSON.stringify(leafName)}, agent: ${JSON.stringify(role)}, task: ${JSON.stringify(`INTEGRATION_WAIT_FOR_FILE:${gate}\nReturn exactly ${leafMarker}`)}, tools: ["read"] });`,
					`      write(files.nested, { processId: process.pid, ownerId: activeTree.ownerId, callerId: activeTree.callerId, treeId: activeTree.treeId, leafNodeId: leafChild.nodeId, leafParentId: leafChild.parentId });`,
					`      return { content: [{ type: "text", text: "fork leaf launched" }], details: { nodeId: leafChild.nodeId } };`,
				].join("\n"),
			}));
			const nestedExtensions = join(env.dir, ".pi", "agent", "extensions");
			mkdirSync(nestedExtensions, { recursive: true });
			writeFileSync(join(nestedExtensions, "consumer-tree-fork.ts"), readFileSync(extension));

			const surface = createTrackedSurface(env, `tree-fork-parent-${id}`);
			await waitForPaneReady(surface);
			startPi(surface, env.dir, `Call consumer_tree_transition_probe exactly once for FORK_PARENT_${id}, then wait.`, {
				extensionSource: extension,
				environment: { JITI_FS_CACHE: "0" },
				extraArgs: "--tools consumer_tree_transition_probe",
			});

			const phase = JSON.parse(await waitForFileOrPiExit(files.phase, surface));
			const nested = JSON.parse(await waitForFileOrPiExit(files.nested, surface));
			assert.equal(phase.rootParentId, phase.callerId);
			assert.equal(nested.ownerId, phase.rootNodeId);
			assert.equal(nested.leafParentId, phase.rootNodeId);
			assertPackageToolsStayedInert(JSON.parse(readFileSync(files.imports, "utf8")).registeredTools);
			const rootPane = await waitForPaneNamed(env, rootName);
			const leafPane = await waitForPaneNamed(env, leafName);
			assert.ok(getPaneProcessInfo(rootPane).pids.length > 0, "forked nested owner must run in real Pi/Herdr");
			assert.ok(getPaneProcessInfo(leafPane).pids.length > 0, "pending direct child must run in real Pi/Herdr");

			const idleDeadline = Date.now() + PI_TIMEOUT;
			while (
				(getProviderRequests().filter((request) => request.userText.includes(rootMarker)).length < 2 ||
				getProviderRequests().filter((request) => request.userText.includes(`FORK_PARENT_${id}`)).length < 2) &&
				Date.now() < idleDeadline
			) await sleep(50);
			assert.ok(getProviderRequests().filter((request) => request.userText.includes(rootMarker)).length >= 2);
			assert.ok(getProviderRequests().filter((request) => request.userText.includes(`FORK_PARENT_${id}`)).length >= 2);
			assert.equal(existsSync(files.complete), false, "/fork must not bypass the pending descendant barrier");

			const transitionSurface = ownerToFork === "nested" ? rootPane : surface;
			runInPane(transitionSurface, "/tree-transition fork");
			const forkAttachment = await waitForJsonLine(
				ownerToFork === "nested" ? files.nestedAttachments : files.attachments,
				(entry) => entry.reason === "fork" && entry.childIds.includes(ownerToFork === "nested" ? nested.leafNodeId : phase.rootNodeId),
			);
			const transitions = readJsonLines(files.transitions);
			assert.equal(transitions.length, 1, "the scenario must invoke /fork once and send no second old-session command");
			assert.equal(transitions[0].transition, "fork");
			assert.equal(transitions[0].processId, forkAttachment.processId);
			assert.equal(forkAttachment.previousSessionFile, transitions[0].sessionFile);
			assert.notEqual(forkAttachment.currentSessionFile, forkAttachment.previousSessionFile);
			assert.equal(forkAttachment.parentSession, forkAttachment.previousSessionFile);
			assert.equal(readJsonLines(forkAttachment.currentSessionFile)[0]?.parentSession, forkAttachment.previousSessionFile);
			assert.equal(forkAttachment.ownerId ?? phase.callerId, ownerToFork === "nested" ? phase.rootNodeId : phase.callerId);
			assert.deepEqual(
				forkAttachment.childIds,
				[ownerToFork === "nested" ? nested.leafNodeId : phase.rootNodeId],
				"the fresh fork session must rebuild its pending direct-child handles",
			);
			assert.equal(forkAttachment.lineageRejections?.missing?.rejected, true, "fork attach must reject missing lineage");
			assert.equal(forkAttachment.lineageRejections?.mismatched?.rejected, true, "fork attach must reject mismatched lineage");
			assert.equal(existsSync(files.complete), false);

			writeFileSync(gate, "ready\n");
			const recoveryFile = ownerToFork === "nested" ? files.nestedRecovered : files.callerRecovered;
			const recovered = await waitForJsonLine(
				recoveryFile,
				(entry) => entry.bindingId === forkAttachment.bindingId && entry.nodeId === (ownerToFork === "nested" ? nested.leafNodeId : phase.rootNodeId),
			);
			const complete = JSON.parse(await waitForFileOrPiExit(files.complete, surface));
			const delivery = await waitForJsonLine(files.deliveries, () => true);
			assert.equal(recovered.processId, forkAttachment.processId);
			assert.equal(recovered.result.resultId.length > 0, true);
			assert.equal(recovered.result.outcome, "clean");
			assert.deepEqual(complete.rootResult, complete.terminal.rootResult);
			assert.deepEqual(delivery.result, complete.terminal);
			assert.equal(readJsonLines(files.deliveries).length, 1, "the final callback must be delivered once");
			if (ownerToFork === "caller") {
				assert.equal(delivery.bindingId, forkAttachment.bindingId, "the final callback must use the fresh caller fork session");
			} else {
				assert.equal(delivery.bindingId, "create", "a nested fork must not replace the original caller callback");
			}
			await sleep(250);
			assert.equal(readJsonLines(files.transitions).length, 1, "completion must not need another old-session command");
			assert.equal(readJsonLines(recoveryFile).filter((entry) => entry.bindingId === forkAttachment.bindingId).length, 1);
			assert.equal(readJsonLines(files.deliveries).length, 1);
			assert.deepEqual(readJsonLines(files.failures), [], "the fork lineage scenario must leave no consumer failure");
		}

		it("reattaches a nested owner in the new /fork session and settles its pending child upward once", async () => {
			await runForkLineageScenario("nested");
		});

		it("reattaches the original caller in the new /fork session and delivers its child and final result once", async () => {
			await runForkLineageScenario("caller");
		});

		it("launches the packed public API root in a retained managed worktree with an exact base", async () => {
			installPackedConsumer(env);
			const id = `worktree-${Date.now()}`;
			const branch = `ale-46/${id}`;
			const role = `tree-worktree-${id}`;
			writeRole(env, role, [
				"model: pi-integration/test",
				"tools: bash",
				"spawning: false",
				"auto-exit: true",
			].join("\n"));
			execFileSync("git", ["init", "-q", "-b", "main"], { cwd: env.dir });
			execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: env.dir });
			execFileSync("git", ["config", "user.name", "Integration Test"], { cwd: env.dir });
			execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: env.dir });
			writeFileSync(join(env.dir, "README.md"), "ALE-46 managed worktree fixture\n");
			writeFileSync(join(env.dir, ".gitignore"), ".pi/\nnode_modules/\n*.tgz\npackage.json\npackage-lock.json\ntest-launch-*.sh\n");
			execFileSync("git", ["add", "README.md", ".gitignore"], { cwd: env.dir });
			execFileSync("git", ["commit", "-qm", "fixture base"], { cwd: env.dir });
			const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: env.dir, encoding: "utf8" }).trim();
			const files = {
				credentials: join(env.dir, `${id}-credentials.json`),
				attachments: join(env.dir, `${id}-attachments.jsonl`),
				deliveries: join(env.dir, `${id}-deliveries.jsonl`),
				awaits: join(env.dir, `${id}-awaits.jsonl`),
				failures: join(env.dir, `${id}-failures.jsonl`),
				complete: join(env.dir, `${id}-complete.json`),
			};
			const extension = join(env.dir, "consumer-tree-worktree.ts");
			writeFileSync(extension, consumerExtensionSource({
				probeName: "consumer_tree_worktree_probe",
				files,
				executeBody: [
					`        const tree = await Promise.resolve(createSubagentTree({ pi, ctx: context, metadata: { requestId: ${JSON.stringify(id)} } }));`,
					`        activeTree = tree;`,
					`        write(files.credentials, { callerId: tree.callerId, treeId: tree.treeId, ownershipToken: tree.ownershipToken });`,
					`        bind(tree, "create");`,
					`        const rootChild = await tree.launchChild({`,
					`          parentId: tree.callerId, name: ${JSON.stringify(`Worktree-root-${id}`)}, agent: ${JSON.stringify(role)}, cwd: ${JSON.stringify(env.dir)},`,
					`          worktree: { branch: ${JSON.stringify(branch)}, base: ${JSON.stringify(baseSha)} }, tools: ["bash"],`,
					`          task: ${JSON.stringify(`Run: echo "$(pwd)" > child-cwd.txt && git rev-parse HEAD > child-base.txt && git add child-cwd.txt child-base.txt && git commit -m 'Record managed cwd ${id}'`)},`,
					`        });`,
					`        void Promise.all([tree.result, rootChild.result]).then(([terminal, rootResult]) => write(files.complete, { terminal, rootResult }));`,
					`        return { content: [{ type: "text", text: "managed worktree launched" }], details: { treeId: tree.treeId } };`,
				].join("\n"),
			}));

			const surface = createTrackedSurface(env, `tree-worktree-parent-${id}`);
			await waitForPaneReady(surface);
			let retainedWorkspaceId: string | undefined;
			try {
				startPi(surface, env.dir, "Call consumer_tree_worktree_probe exactly once, then wait.", {
					extensionSource: extension,
					environment: { JITI_FS_CACHE: "0" },
					extraArgs: "--tools consumer_tree_worktree_probe",
				});

				const complete = JSON.parse(await waitForFileOrPiExit(files.complete, surface, PI_TIMEOUT * 2));
				const handoff = complete.rootResult.worktree;
				assert.ok(handoff, "the direct owner must receive the retained managed-worktree handoff");
				retainedWorkspaceId = handoff.workspaceId;
				assert.equal(handoff.branch, branch);
				assert.equal(handoff.baseRef, baseSha);
				assert.equal(handoff.baseSha, baseSha);
				assert.equal(readFileSync(join(handoff.path, "child-cwd.txt"), "utf8").trim(), handoff.path);
				assert.equal(readFileSync(join(handoff.path, "child-base.txt"), "utf8").trim(), baseSha);
				assert.equal(handoff.commitsAhead, 1);
				assert.equal(handoff.clean, true);
				assert.equal(handoff.conflicted, false);
				assert.ok(handoff.changedFiles.includes("child-cwd.txt"));
				assert.ok(handoff.changedFiles.includes("child-base.txt"));
				assert.ok(existsSync(handoff.manifestFile));
				assert.equal(JSON.parse(readFileSync(handoff.manifestFile, "utf8")).owner, "pi-herdr-subagents");
				const listed = JSON.parse(execFileSync("herdr", ["worktree", "list", "--cwd", env.dir, "--json"], { encoding: "utf8" }))
					.result.worktrees.find((candidate: any) => candidate.branch === branch);
				assert.ok(listed, "the package must retain the managed worktree for its owner");
				assert.equal(listed.path, handoff.path);
				assert.equal(listed.open_workspace_id, retainedWorkspaceId);
				assert.deepEqual(complete.terminal.rootResult, complete.rootResult);
				assertBoundedNodeRows(complete.terminal.nodes, [`Record managed cwd ${id}`]);
			} finally {
				if (!retainedWorkspaceId) {
					try {
						retainedWorkspaceId = JSON.parse(execFileSync("herdr", ["worktree", "list", "--cwd", env.dir, "--json"], { encoding: "utf8" }))
							.result.worktrees.find((candidate: any) => candidate.branch === branch)?.open_workspace_id;
					} catch {}
				}
				if (retainedWorkspaceId) {
					try { execFileSync("herdr", ["worktree", "remove", "--workspace", retainedWorkspaceId, "--force", "--json"]); } catch {}
				}
				try { execFileSync("git", ["branch", "-D", branch], { cwd: env.dir, stdio: "ignore" }); } catch {}
			}
		});

		it("cancels a real root-to-leaf tree only after both panes and processes terminate", async () => {
			installPackedConsumer(env);
			const id = `cancel-${Date.now()}`;
			const role = `tree-cancel-${id}`;
			writeRole(env, role, [
				"model: pi-integration/test",
				"tools: read, consumer_tree_nested_launch",
				"spawning: false",
				"auto-exit: true",
			].join("\n"));
			const rootGate = join(env.dir, `${id}-root.gate`);
			const leafGate = join(env.dir, `${id}-leaf.gate`);
			gates.push(rootGate, leafGate);
			const rootName = `Cancel-root-${id}`;
			const leafName = `Cancel-leaf-${id}`;
			const files = {
				credentials: join(env.dir, `${id}-credentials.json`),
				attachments: join(env.dir, `${id}-attachments.jsonl`),
				deliveries: join(env.dir, `${id}-deliveries.jsonl`),
				awaits: join(env.dir, `${id}-awaits.jsonl`),
				failures: join(env.dir, `${id}-failures.jsonl`),
				nestedAttachments: join(env.dir, `${id}-nested-attachments.jsonl`),
				nested: join(env.dir, `${id}-nested.json`),
				ready: join(env.dir, `${id}-ready.json`),
				cancelled: join(env.dir, `${id}-cancelled.json`),
				imports: join(env.dir, `${id}-imports.json`),
			};
			const extension = join(env.dir, "consumer-tree-cancel.ts");
			writeFileSync(extension, consumerExtensionSource({
				probeName: "consumer_tree_cancel_probe",
				files,
				executeBody: [
					`        write(files.imports, { registeredTools: pi.getAllTools().map((tool) => tool.name).sort() });`,
					`        const tree = await Promise.resolve(createSubagentTree({ pi, ctx: context, metadata: { requestId: ${JSON.stringify(id)} } }));`,
					`        activeTree = tree;`,
					`        write(files.credentials, { callerId: tree.callerId, treeId: tree.treeId, ownershipToken: tree.ownershipToken });`,
					`        bind(tree, "create");`,
					`        const rootChild = await tree.launchChild({ parentId: tree.callerId, name: ${JSON.stringify(rootName)}, agent: ${JSON.stringify(role)}, task: ${JSON.stringify(`INTEGRATION_WAIT_FOR_FILE:${rootGate}\nUse the nested launch tool, then return exactly CANCEL_ROOT_LATE_${id}`)}, tools: ["read", "consumer_tree_nested_launch"] });`,
					`        write(files.ready, { callerId: tree.callerId, treeId: tree.treeId, rootNodeId: rootChild.nodeId, rootParentId: rootChild.parentId });`,
					`        return { content: [{ type: "text", text: "tree is ready for cancellation" }], details: { treeId: tree.treeId } };`,
				].join("\n"),
				nestedToolBody: [
					`      const leafChild = await activeTree.launchChild({ parentId: activeTree.ownerId, name: ${JSON.stringify(leafName)}, agent: ${JSON.stringify(role)}, task: ${JSON.stringify(`INTEGRATION_WAIT_FOR_FILE:${leafGate}\nReturn exactly CANCEL_LEAF_LATE_${id}`)}, tools: ["read"] });`,
					`      write(files.nested, { ownerId: activeTree.ownerId, leafNodeId: leafChild.nodeId, leafParentId: leafChild.parentId });`,
					`      return { content: [{ type: "text", text: "nested leaf launched" }], details: { nodeId: leafChild.nodeId } };`,
				].join("\n"),
				commandBody: [
					`        if (!activeTree) throw new Error("no active tree");`,
					`        const first = await activeTree.cancel();`,
					`        const second = await activeTree.cancel();`,
					`        const awaited = await activeTree.result;`,
					`        let lateLaunchRejected = false;`,
					`        try { await activeTree.launchChild({ parentId: activeTree.callerId, name: "after-cancel", agent: ${JSON.stringify(role)}, task: "must not launch", tools: ["read"] }); } catch { lateLaunchRejected = true; }`,
					`        write(files.cancelled, { first, second, awaited, lateLaunchRejected });`,
				].join("\n"),
			}));
			const nestedExtensions = join(env.dir, ".pi", "agent", "extensions");
			mkdirSync(nestedExtensions, { recursive: true });
			writeFileSync(join(nestedExtensions, "consumer-tree-cancel.ts"), readFileSync(extension));

			const surface = createTrackedSurface(env, `tree-cancel-parent-${id}`);
			await waitForPaneReady(surface);
			startPi(surface, env.dir, "Call consumer_tree_cancel_probe exactly once, then wait.", {
				extensionSource: extension,
				environment: { JITI_FS_CACHE: "0" },
				extraArgs: "--tools consumer_tree_cancel_probe",
			});

			const ready = JSON.parse(await waitForFileOrPiExit(files.ready, surface));
			const nested = JSON.parse(await waitForFileOrPiExit(files.nested, surface));
			assert.equal(ready.rootParentId, ready.callerId);
			assert.equal(nested.ownerId, ready.rootNodeId);
			assert.equal(nested.leafParentId, ready.rootNodeId);
			assertPackageToolsStayedInert(JSON.parse(readFileSync(files.imports, "utf8")).registeredTools);
			const rootPane = await waitForPaneNamed(env, rootName);
			const leafPane = await waitForPaneNamed(env, leafName);
			const processDeadline = Date.now() + PI_TIMEOUT;
			let rootProcesses = getPaneProcessInfo(rootPane).pids;
			let leafProcesses = getPaneProcessInfo(leafPane).pids;
			while ((rootProcesses.length === 0 || leafProcesses.length === 0) && Date.now() < processDeadline) {
				await sleep(50);
				rootProcesses = getPaneProcessInfo(rootPane).pids;
				leafProcesses = getPaneProcessInfo(leafPane).pids;
			}
			assert.ok(rootProcesses.length > 0, "distributed cancellation needs root process identity");
			assert.ok(leafProcesses.length > 0, "distributed cancellation needs leaf process identity");

			runInPane(surface, "/tree-cancel");
			const cancelled = JSON.parse(await waitForFileOrPiExit(files.cancelled, surface));
			assert.equal(cancelled.first.state, "cancelled");
			assert.equal(cancelled.first.terminalId.length > 0, true);
			assert.equal(cancelled.second.terminalId, cancelled.first.terminalId);
			assert.equal(cancelled.awaited.terminalId, cancelled.first.terminalId);
			assert.deepEqual(cancelled.second, cancelled.first);
			assert.deepEqual(cancelled.awaited, cancelled.first);
			assert.equal(cancelled.lateLaunchRejected, true);
			for (const pane of [rootPane, leafPane]) {
				assert.equal(
					await waitForPaneAbsence(pane, { timeoutMs: PI_TIMEOUT }),
					true,
					`successful distributed cancellation must confirm pane absence: ${pane}`,
				);
			}
			assert.deepEqual(
				await waitForProcessesExit([...new Set([...rootProcesses, ...leafProcesses])], { timeoutMs: PI_TIMEOUT }),
				[],
				"successful distributed cancellation must confirm every root and leaf process exited",
			);
			writeFileSync(rootGate, "ready\n");
			writeFileSync(leafGate, "ready\n");
		});


		it("fails cancellation closed for a real distributed tree and suppresses an observed late leaf answer", async () => {
			installPackedConsumer(env);
			const id = `cancel-unconfirmed-${Date.now()}`;
			const role = `tree-cancel-unconfirmed-${id}`;
			writeRole(env, role, [
				"model: pi-integration/test",
				"tools: read, consumer_tree_nested_launch",
				"spawning: false",
				"auto-exit: true",
			].join("\n"));
			const leafGate = join(env.dir, `${id}-leaf.gate`);
			const disableHerdr = join(env.dir, `${id}-disable-herdr`);
			const unavailablePath = join(env.dir, "herdr-cli-unavailable");
			mkdirSync(unavailablePath, { recursive: true });
			gates.push(leafGate);
			const rootName = `Cancel-unconfirmed-root-${id}`;
			const leafName = `Cancel-unconfirmed-leaf-${id}`;
			const rootMarker = `CANCEL_UNCONFIRMED_ROOT_${id}`;
			const lateLeafMarker = `CANCEL_UNCONFIRMED_LATE_LEAF_${id}`;
			const files = {
				credentials: join(env.dir, `${id}-credentials.json`),
				attachments: join(env.dir, `${id}-attachments.jsonl`),
				deliveries: join(env.dir, `${id}-deliveries.jsonl`),
				awaits: join(env.dir, `${id}-awaits.jsonl`),
				failures: join(env.dir, `${id}-failures.jsonl`),
				nestedAttachments: join(env.dir, `${id}-nested-attachments.jsonl`),
				nested: join(env.dir, `${id}-nested.json`),
				ready: join(env.dir, `${id}-ready.json`),
				cancelled: join(env.dir, `${id}-cancelled.json`),
				afterLate: join(env.dir, `${id}-after-late.json`),
				imports: join(env.dir, `${id}-imports.json`),
				disableHerdr,
				herdrDisabled: join(env.dir, `${id}-herdr-disabled.jsonl`),
				unavailablePath,
			};
			const extension = join(env.dir, "consumer-tree-cancel-unconfirmed.ts");
			writeFileSync(extension, consumerExtensionSource({
				probeName: "consumer_tree_cancel_unconfirmed_probe",
				files,
				executeBody: [
					`        write(files.imports, { registeredTools: pi.getAllTools().map((tool) => tool.name).sort() });`,
					`        const tree = await Promise.resolve(createSubagentTree({ pi, ctx: context, metadata: { requestId: ${JSON.stringify(id)} } }));`,
					`        activeTree = tree;`,
					`        write(files.credentials, { callerId: tree.callerId, treeId: tree.treeId, ownershipToken: tree.ownershipToken });`,
					`        bind(tree, "create");`,
					`        const rootChild = await tree.launchChild({ parentId: tree.callerId, name: ${JSON.stringify(rootName)}, agent: ${JSON.stringify(role)}, task: ${JSON.stringify(`Use the nested launch tool, then return exactly ${rootMarker}`)}, tools: ["read", "consumer_tree_nested_launch"] });`,
					`        write(files.ready, { callerId: tree.callerId, treeId: tree.treeId, rootNodeId: rootChild.nodeId, rootParentId: rootChild.parentId });`,
					`        return { content: [{ type: "text", text: "distributed tree is ready for unconfirmed cancellation" }], details: { treeId: tree.treeId } };`,
				].join("\n"),
				nestedToolBody: [
					`      const leafChild = await activeTree.launchChild({ parentId: activeTree.ownerId, name: ${JSON.stringify(leafName)}, agent: ${JSON.stringify(role)}, task: ${JSON.stringify(`INTEGRATION_WAIT_FOR_FILE:${leafGate}\nReturn exactly ${lateLeafMarker}`)}, tools: ["read"] });`,
					`      write(files.nested, { ownerId: activeTree.ownerId, leafNodeId: leafChild.nodeId, leafParentId: leafChild.parentId });`,
					`      return { content: [{ type: "text", text: "gated late leaf launched" }], details: { nodeId: leafChild.nodeId } };`,
				].join("\n"),
				commandBody: [
					`        if (!activeTree) throw new Error("no active tree");`,
					`        const afterLate = existsSync(files.cancelled);`,
					`        const first = await activeTree.cancel();`,
					`        const second = await activeTree.cancel();`,
					`        const awaited = await activeTree.result;`,
					`        let lateLaunchRejected = false;`,
					`        try { await activeTree.launchChild({ parentId: activeTree.callerId, name: "after-failed-cancel", agent: ${JSON.stringify(role)}, task: "must not launch", tools: ["read"] }); } catch { lateLaunchRejected = true; }`,
					`        const callbackCount = existsSync(files.deliveries) ? readFileSync(files.deliveries, "utf8").trim().split("\\n").filter(Boolean).length : 0;`,
					`        write(afterLate ? files.afterLate : files.cancelled, { first, second, awaited, lateLaunchRejected, callbackCount });`,
				].join("\n"),
			}));
			const nestedExtensions = join(env.dir, ".pi", "agent", "extensions");
			mkdirSync(nestedExtensions, { recursive: true });
			writeFileSync(join(nestedExtensions, "consumer-tree-cancel-unconfirmed.ts"), readFileSync(extension));

			const surface = createTrackedSurface(env, `tree-cancel-unconfirmed-parent-${id}`);
			await waitForPaneReady(surface);
			startPi(surface, env.dir, "Call consumer_tree_cancel_unconfirmed_probe exactly once, then wait.", {
				extensionSource: extension,
				environment: { JITI_FS_CACHE: "0" },
				extraArgs: "--tools consumer_tree_cancel_unconfirmed_probe",
			});

			const ready = JSON.parse(await waitForFileOrPiExit(files.ready, surface));
			const nested = JSON.parse(await waitForFileOrPiExit(files.nested, surface));
			assert.equal(ready.rootParentId, ready.callerId);
			assert.equal(nested.ownerId, ready.rootNodeId);
			assert.equal(nested.leafParentId, ready.rootNodeId);
			assertPackageToolsStayedInert(JSON.parse(readFileSync(files.imports, "utf8")).registeredTools);

			const rootPane = await waitForPaneNamed(env, rootName);
			const leafPane = await waitForPaneNamed(env, leafName);
			const processDeadline = Date.now() + PI_TIMEOUT;
			let rootProcesses = getPaneProcessInfo(rootPane).pids;
			let leafProcesses = getPaneProcessInfo(leafPane).pids;
			while ((rootProcesses.length === 0 || leafProcesses.length === 0) && Date.now() < processDeadline) {
				await sleep(50);
				rootProcesses = getPaneProcessInfo(rootPane).pids;
				leafProcesses = getPaneProcessInfo(leafPane).pids;
			}
			assert.ok(rootProcesses.length > 0, "the failed-cancellation tree needs real root process evidence");
			assert.ok(leafProcesses.length > 0, "the failed-cancellation tree needs real leaf process evidence");

			const [rootSession, leafSession] = await Promise.all([
				waitForPaneSessionReference(rootPane),
				waitForPaneSessionReference(leafPane),
			]);
			assert.equal(listWorkspacePanes(env.workspaceId).find((pane) => pane.pane_id === rootPane)?.label, rootName);
			assert.equal(listWorkspacePanes(env.workspaceId).find((pane) => pane.pane_id === leafPane)?.label, leafName);
			assert.ok(rootSession);
			assert.ok(leafSession);
			const assistantIdsBeforeRelease = new Set(readAssistantTranscriptEntries(leafSession).map((entry) => entry.id));

			writeFileSync(disableHerdr, "disabled\n");
			const disabledDeadline = Date.now() + PI_TIMEOUT;
			while (readJsonLines(files.herdrDisabled).length < 3 && Date.now() < disabledDeadline) await sleep(50);
			assert.ok(readJsonLines(files.herdrDisabled).length >= 3, "caller, root, and leaf must all lose Herdr control before cancellation");

			runInPane(surface, "/tree-cancel");
			const cancelled = JSON.parse(await waitForFileOrPiExit(files.cancelled, surface));
			assert.equal(cancelled.first.state, "failed");
			assert.equal(cancelled.first.terminalId.length > 0, true);
			assert.equal(cancelled.first.error?.code, "cancel_termination_failed");
			assert.equal(typeof cancelled.first.error?.message, "string");
			assert.ok(cancelled.first.error.message.length > 0 && cancelled.first.error.message.length <= 4_000);
			assert.deepEqual(cancelled.second, cancelled.first);
			assert.deepEqual(cancelled.awaited, cancelled.first);
			assert.equal(cancelled.lateLaunchRejected, true);
			assertBoundedNodeRows(cancelled.first.nodes, [rootMarker, lateLeafMarker]);

			const rootRecovery = cancelled.first.nodes.find((node: any) => node.nodeId === ready.rootNodeId);
			const leafRecovery = cancelled.first.nodes.find((node: any) => node.nodeId === nested.leafNodeId);
			for (const [label, recovery] of [["root", rootRecovery], ["leaf", leafRecovery]] as const) {
				assert.ok(recovery, `cancellation failure must retain ${label} recovery evidence`);
				assert.equal(recovery.open, true);
				assert.equal(typeof recovery.sessionReference, "string");
				assert.ok(recovery.sessionReference.length > 0 && recovery.sessionReference.length <= 10_000);
				assert.ok(existsSync(recovery.sessionReference));
			}
			assert.equal(rootRecovery.sessionReference, rootSession);
			assert.equal(leafRecovery.sessionReference, leafSession);
			assert.ok(getPaneProcessInfo(rootPane).pids.length > 0, "failed cancellation must retain the real root process");
			assert.ok(getPaneProcessInfo(leafPane).pids.length > 0, "failed cancellation must retain the gated real leaf process");
			const initialDelivery = await waitForJsonLine(files.deliveries, () => true);
			assert.deepEqual(initialDelivery.result, cancelled.first);
			assert.equal(readJsonLines(files.deliveries).length, 1);

			const callbackCountAtTerminal = readJsonLines(files.deliveries).length;
			assert.equal(callbackCountAtTerminal, 1);

			writeFileSync(leafGate, "ready\n");
			const lateEntry = await waitForNewAssistantTranscriptEntry(
				leafSession,
				lateLeafMarker,
				assistantIdsBeforeRelease,
			);
			assert.equal(assistantIdsBeforeRelease.has(lateEntry.id), false);

			runInPane(surface, "/tree-cancel");
			const afterLate = JSON.parse(await waitForFileOrPiExit(files.afterLate, surface));
			assert.equal(afterLate.first.terminalId, cancelled.first.terminalId);
			assert.deepEqual(afterLate.first, cancelled.first, "late runtime result must not mutate terminal data");
			assert.deepEqual(afterLate.second, cancelled.first);
			assert.deepEqual(afterLate.awaited, cancelled.first);
			assert.equal(afterLate.callbackCount, callbackCountAtTerminal);
			assert.equal(
				readJsonLines(files.deliveries).length,
				callbackCountAtTerminal,
				"late runtime result must not redeliver the callback",
			);
			assertBoundedNodeRows(afterLate.first.nodes, [rootMarker, lateLeafMarker]);
		});
	});
}
