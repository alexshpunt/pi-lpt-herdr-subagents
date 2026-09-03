/**
 * Integration tests for the full subagent lifecycle.
 *
 * These tests spawn real pi sessions with real LLM calls.
 * Each test creates a herdr pane, runs pi with a task that uses the subagent
 * tool, and verifies the outcome through marker files and terminal output.
 *
 * Duration: ~30-120s per test, depending on the selected model.
 *
 * Run `PI_TEST_MODEL="openai-codex/gpt-5.6-luna" PI_TEST_TIMEOUT=180000
 * npm run test:integration` from inside herdr. The exact authenticated model keeps
 * real-LLM runs predictable and the longer timeout covers the lifecycle suite.
 *
 * Configuration:
 *   PI_TEST_MODEL     — exact authenticated model for all pi sessions (recommended: openai-codex/gpt-5.6-luna)
 *   PI_TEST_TIMEOUT   — per-test timeout in ms (default: 120000)
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { getProviderRequests, resetProviderRequests } from "./fake-provider.ts";
import {
	getAvailableBackends,

	getPaneProcessInfo,
	setBackend,
	restoreBackend,
	createTestEnv,
	cleanupTestEnv,
	createTrackedSurface,
	closePane,
	focusSurface,
	startPi,
	waitForScreen,
	waitForFile,
	waitForPaneReady,
	waitForPiExit,
	sleep,
	uniqueId,
	trackTempFile,
	readPane,
	runInPane,
	shellQuote,
	PI_TIMEOUT,
	type TestEnv,
} from "./harness.ts";
const backends = getAvailableBackends();

function getWorkspaceActiveTab(workspaceId: string): string | null {
	const workspaces = JSON.parse(
		execFileSync("herdr", ["workspace", "list"], { encoding: "utf8" }),
	).result.workspaces as Array<{
		active_tab_id?: string;
		workspace_id: string;
	}>;
	return (
		workspaces.find((workspace) => workspace.workspace_id === workspaceId)
			?.active_tab_id ?? null
	);
}

function getPaneTab(paneId: string): string | null {
	return (
		JSON.parse(
			execFileSync("herdr", ["pane", "get", paneId], {
				encoding: "utf8",
			}),
		).result.pane?.tab_id ?? null
	);
}

interface IntegrationResultDetails {
	kind?: unknown;
	outcome?: unknown;
	childId?: unknown;
	sessionFile?: unknown;
	deliveryId?: unknown;
	resultContent?: unknown;

	resultPath?: unknown;
	errorMessage?: unknown;
}

interface IntegrationSessionEntry {
	type?: unknown;
	id?: unknown;
	customType?: unknown;
	details?: IntegrationResultDetails;
}

function readSettledResult(sessionFile: string): IntegrationResultDetails {
	const entries = readFileSync(sessionFile, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as IntegrationSessionEntry);
	return (
		entries.find(
			(entry) => entry.type === "custom_message" && entry.customType === "subagent_result",
		)?.details ?? {}
	);
}

function readSessionEntries(sessionFile: string): any[] {
	return readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}


async function waitForParentEvidence(
	sessionFile: string,
	pattern: RegExp,
	surface: string,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const content = existsSync(sessionFile) ? readFileSync(sessionFile, "utf8") : "";
		if (pattern.test(content)) return;
		const screen = readPane(surface, 200);
		if (/__TEST_DONE_-?\d+__/.test(screen)) {
			assert.fail(`Pi exited before parent evidence matched ${pattern}:\n${screen}`);
		}
		await sleep(50);
	}
	assert.fail(`Timeout waiting for parent evidence ${pattern}:\n${readPane(surface, 200)}`);
}


async function waitForCustomResultCount(
	sessionFile: string,
	count: number,
	timeoutMs = PI_TIMEOUT,
): Promise<IntegrationSessionEntry[]> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(sessionFile)) {
			const entries = readSessionEntries(sessionFile) as IntegrationSessionEntry[];
			if (customResultEntries(entries).length >= count) return entries;
		}
		await sleep(50);
	}
	throw new Error(`Timeout waiting for ${count} subagent results in ${sessionFile}`);
}

function writeIntegrationSkill(root: string, name: string, bodyMarker: string): void {
	const directory = join(root, ".pi", "skills", name);
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "SKILL.md"),
		`---\nname: ${name}\ndescription: ALE-54 integration fixture\n---\n\nSkill body marker: ${bodyMarker}\n`,
		"utf8",
	);
}

function writeSkillRole(root: string, name: string, skills: string, autoExit = true): void {
	writeFileSync(
		join(root, ".pi", "agents", `${name}.md`),
		`---\nname: ${name}\ndescription: ALE-54 skill-loading fixture\ntools: read\nskills: ${skills}\nauto-exit: ${autoExit}\n---\nReturn the requested result exactly.\n`,
		"utf8",
	);
}

function countText(source: string, value: string): number {
	return source.split(value).length - 1;
}

interface PaneSessionRecord {
	sessionId?: unknown;
	sessionFile?: unknown;
}

async function waitForReplacementSession(
	parentPaneId: string,
	agentDir: string,
	originalSessionFile: string,
	replacementMarker: string,
	timeout = PI_TIMEOUT,
): Promise<{ sessionFile: string; sessionId: string }> {
	const deadline = Date.now() + timeout;
	const mapFile = join(
		agentDir,
		"pane-session-map",
		`${encodeURIComponent(parentPaneId)}.json`,
	);
	while (Date.now() < deadline) {
		// The marker is sent to and observed in this exact Herdr pane. The
		// session map is written by that pane's Pi process on session_start,
		// including for an otherwise ephemeral /new session.
		if (!readPane(parentPaneId, 300).includes(replacementMarker)) {
			await sleep(100);
			continue;
		}
		try {
			const record = JSON.parse(readFileSync(mapFile, "utf8")) as PaneSessionRecord;
			if (
				typeof record.sessionFile !== "string" ||
				typeof record.sessionId !== "string" ||
				record.sessionFile === originalSessionFile
			) {
				await sleep(100);
				continue;
			}
			const entries = readSessionEntries(record.sessionFile);
			const sessionIds = [
				...new Set(
					entries
						.filter((entry) => entry.type === "session" && typeof entry.id === "string")
						.map((entry) => entry.id as string),
				),
			];
			if (sessionIds.length !== 1 || sessionIds[0] !== record.sessionId) {
				throw new Error(
					`Ambiguous or mismatched session identity for pane ${parentPaneId}`,
				);
			}
			if (readFileSync(record.sessionFile, "utf8").includes(replacementMarker)) {
				return { sessionFile: record.sessionFile, sessionId: record.sessionId };
			}
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("Ambiguous or mismatched")) {
				throw error;
			}
			// The replacement may still be writing its first JSONL record.
		}
		await sleep(100);
	}
	throw new Error(`Timeout waiting for replacement session in parent pane ${parentPaneId}`);
}

function customResultEntries(entries: IntegrationSessionEntry[]): IntegrationSessionEntry[] {
	return entries.filter(
		(entry) => entry.type === "custom_message" && entry.customType === "subagent_result",
	);
}

function listWorkspacePanes(workspaceId: string): Array<{ pane_id?: string; label?: string; agent_session?: { value?: string } }> {
	return JSON.parse(execFileSync("herdr", ["pane", "list", "--workspace", workspaceId], { encoding: "utf8" }))
		.result.panes as Array<{ pane_id?: string; label?: string; agent_session?: { value?: string } }>;
}


function listWorkspaceTabs(
	workspaceId: string,
): Array<{ tab_id: string; label?: string }> {
	return JSON.parse(
		execFileSync("herdr", ["tab", "list", "--workspace", workspaceId], {
			encoding: "utf8",
		}),
	).result.tabs as Array<{ tab_id: string; label?: string }>;
}

async function waitForTabLabelGone(
	workspaceId: string,
	label: string,
	timeout = PI_TIMEOUT,
): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (!listWorkspaceTabs(workspaceId).some((tab) => tab.label === label)) return;
		await sleep(50);
	}
	throw new Error(
		`Timeout waiting for Herdr tab ${label} to close; tabs=${JSON.stringify(listWorkspaceTabs(workspaceId))}`,
	);
}
async function waitForAgentPane(
	paneLabel: string,
	workspaceId: string,
	timeout = PI_TIMEOUT,
): Promise<string> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const match = listWorkspacePanes(workspaceId).find(
			(pane) => pane.label === paneLabel && typeof pane.pane_id === "string",
		);
		if (match?.pane_id) return match.pane_id;
		await sleep(50);
	}
	throw new Error(`Timeout waiting for live pane ${paneLabel}; panes=${JSON.stringify(listWorkspacePanes(workspaceId))}`);
}

async function waitForAgentGone(paneId: string, workspaceId: string, timeout = PI_TIMEOUT): Promise<void> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const pane = listWorkspacePanes(workspaceId).find((candidate) => candidate.pane_id === paneId);
		if (!pane?.agent_session && !pane?.label) return;
		await sleep(50);
	}
	throw new Error(`Timeout waiting for agent pane to close ${paneId}`);
}
function listBtwPanes(workspaceId: string): string[] {

	const tabs = JSON.parse(
		execFileSync("herdr", ["tab", "list", "--workspace", workspaceId], {
			encoding: "utf8",
		}),
	).result.tabs as Array<{ label?: string; tab_id: string }>;
	const btwTabIds = new Set(
		tabs.filter((tab) => tab.label === "BTW").map((tab) => tab.tab_id),
	);
	const panes = JSON.parse(
		execFileSync("herdr", ["pane", "list", "--workspace", workspaceId], {
			encoding: "utf8",
		}),
	).result.panes as Array<{ pane_id: string; tab_id: string }>;
	return panes
		.filter((pane) => btwTabIds.has(pane.tab_id))
		.map((pane) => pane.pane_id);
}

async function waitForBtwPane(
	workspaceId: string,
	previousPane?: string,
	timeout = PI_TIMEOUT,
): Promise<string> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeout) {
		const panes = listBtwPanes(workspaceId);
		if (panes.length === 1 && panes[0] !== previousPane) return panes[0];
		await sleep(500);
	}
	throw new Error(`Timeout waiting for BTW pane in workspace ${workspaceId}`);
}

async function waitForNoBtwPane(
	workspaceId: string,
	timeout = PI_TIMEOUT,
): Promise<void> {
	const startedAt = Date.now();
	while (Date.now() - startedAt < timeout) {
		if (listBtwPanes(workspaceId).length === 0) return;
		await sleep(500);
	}
	throw new Error(
		`Timeout waiting for BTW pane cleanup in workspace ${workspaceId}`,
	);
}

if (backends.length === 0) {
	console.log(
		"⚠️  herdr is unavailable — skipping subagent lifecycle integration tests",
	);
	console.log("   Run inside herdr to enable these tests.");
}

for (const backend of backends) {
	describe(`subagent-lifecycle [${backend}]`, {
		timeout: PI_TIMEOUT * 5,
	}, () => {
		let prevMux: string | undefined;
		let env: TestEnv;

		beforeEach(() => {
			prevMux = setBackend(backend);
			env = createTestEnv(backend);
			resetProviderRequests();
		});


		afterEach(async () => {
			await cleanupTestEnv(env);
			restoreBackend(prevMux);
		});

		// ── Basic spawn + completion ──

		it("opens, replaces, and closes a context-aware BTW pane without steering the parent", async () => {
			const id = uniqueId();
			const contextMarker = `SECRET_${id}`;
			const expectedAnswer = new RegExp(`BTW_CONFIRMED_(?:SECRET_)?${id}`);
			const parentSession = join(env.dir, `btw-parent-${id}.jsonl`);
			const surface = createTrackedSurface(env, `btw-parent-${id}`);
			await waitForPaneReady(surface);
			const parentTab = getPaneTab(surface);
			assert.ok(parentTab, "parent pane must belong to a Herdr tab");

			startPi(surface, env.dir, `Reply with only ${contextMarker}.`, {
				extraArgs: `--session ${shellQuote(parentSession)}`,
			});
			await waitForScreen(surface, new RegExp(contextMarker), PI_TIMEOUT);
			await waitForFile(parentSession, PI_TIMEOUT, new RegExp(contextMarker));
			const parentBefore = readFileSync(parentSession, "utf8");

			focusSurface(backend, surface);
			assert.equal(getWorkspaceActiveTab(env.workspaceId), parentTab);

			runInPane(surface, "/btw Say FIRST and wait for another question");
			const firstBtwPane = await waitForBtwPane(env.workspaceId);
			assert.equal(
				getWorkspaceActiveTab(env.workspaceId),
				parentTab,
				"opening BTW must not change the workspace's active tab",
			);

			runInPane(
				surface,
				"/btw Read the previous assistant answer. Reply with BTW_CONFIRMED_ followed by its secret code, with no spaces.",
			);
			const secondBtwPane = await waitForBtwPane(env.workspaceId, firstBtwPane);
			assert.notEqual(
				secondBtwPane,
				firstBtwPane,
				"second /btw should replace the first pane",
			);
			assert.equal(
				getWorkspaceActiveTab(env.workspaceId),
				parentTab,
				"replacing BTW must not change the workspace's active tab",
			);

			try {
				await waitForScreen(secondBtwPane, expectedAnswer, PI_TIMEOUT);
			} catch (error) {
				let childScreen = "<pane unavailable>";
				try {
					childScreen = readPane(secondBtwPane, 200);
				} catch {
					// Keep the original wait error when diagnostic screen capture fails.
				}
				throw new Error(
					`${error instanceof Error ? error.message : String(error)}\n` +
						`Parent screen:\n${readPane(surface, 200)}\n` +
						`Child screen:\n${childScreen}`,
				);
			}
			assert.equal(
				readFileSync(parentSession, "utf8"),
				parentBefore,
				"BTW must not alter parent history",
			);

			runInPane(surface, "/btw-close");
			await waitForNoBtwPane(env.workspaceId);
		});

		it("spawns a subagent that writes a file and verifies the session", async () => {
			const id = uniqueId();
			const markerFile = `/tmp/pi-integ-echo-${id}.txt`;
			trackTempFile(env, markerFile);

			const surface = createTrackedSurface(env, `echo-${id}`);
			await waitForPaneReady(surface);

			const task = [
				`Call the subagent tool with these EXACT parameters:`,
				`  name: "Echo-${id}"`,
				`  agent: "test-echo"`,
				`  task: "Run this bash command: echo 'PASS_${id}' > '${markerFile}'"`,
				`Do not do anything else. Just call the subagent tool once.`,
				`After you receive the subagent result, say INTEGRATION_COMPLETE.`,
			].join("\n");

			startPi(surface, env.dir, task);

			// Verify: subagent created the marker file
			const content = await waitForFile(markerFile, PI_TIMEOUT, /PASS/);
			assert.ok(
				content.includes(`PASS_${id}`),
				`Marker file should contain PASS_${id}. Got: ${content.trim()}`,
			);

			// Verify: outer pi received the subagent result
			const screen = await waitForScreen(
				surface,
				/INTEGRATION_COMPLETE|completed|Sub-agent.*"Echo/i,
				PI_TIMEOUT,
			);

			// Verify: session file was created (shown in steer result)
			const sessionMatch = screen.match(/Session:\s*(\S+\.jsonl)/);
			if (sessionMatch) {
				const sessionFile = sessionMatch[1];
				assert.ok(
					existsSync(sessionFile),
					`Subagent session file should exist: ${sessionFile}`,
				);

				const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
				assert.ok(
					lines.length >= 2,
					`Session should have ≥2 entries, got ${lines.length}`,
				);

				const header = JSON.parse(lines[0]);
				assert.equal(
					header.type,
					"session",
					"First entry should be session header",
				);
				assert.ok(header.id, "Session header should have an id");
			}
		});

		it("delivers one model-visible completion and closes its dedicated tab", async () => {
			const id = uniqueId();
			const childMarker = `CHILD_RESULT_${id}`;
			const parentMarker = `PARENT_CONTINUED_${id}`;
			const parentSession = join(env.dir, `single-result-parent-${id}.jsonl`);
			const surface = createTrackedSurface(env, `single-result-${id}`);
			await waitForPaneReady(surface);

			startPi(
				surface,
				env.dir,
				[
					"Call the subagent tool with these EXACT parameters:",
					`  name: "SingleResult-${id}"`,
					'  agent: "test-echo"',
					`  task: "Return exactly ${childMarker}"`,
					"Do not do anything else. Just call the subagent tool once.",
					`After you receive the subagent result, say ${parentMarker}.`,
				].join("\n"),
				{ extraArgs: `--session ${shellQuote(parentSession)}` },
			);

			let entries: any[] = [];
			let customIndex = -1;
			let continued = false;
			const deadline = Date.now() + PI_TIMEOUT;
			while (!continued && Date.now() < deadline) {
				if (existsSync(parentSession)) {
					entries = readFileSync(parentSession, "utf8")
						.trim()
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line));
					customIndex = entries.findIndex(
						(entry) =>
							entry.type === "custom_message" &&
							entry.customType === "subagent_result",
					);
					continued =
						customIndex >= 0 &&
						entries
							.slice(customIndex + 1)
							.some(
								(entry) =>
									entry.type === "message" &&
									entry.message?.role === "assistant" &&
									JSON.stringify(entry.message.content).includes(parentMarker),
							);
				}
				if (!continued) await sleep(50);
			}

			assert.equal(continued, true, readPane(surface, 300));
			const customResults = entries.filter(
				(entry) =>
					entry.type === "custom_message" && entry.customType === "subagent_result",
			);
			assert.equal(customResults.length, 1);
			assert.match(customResults[0].content, new RegExp(childMarker));
			assert.match(customResults[0].content, /Parent action:/);
			assert.match(
				customResults[0].details.resultContent,
				new RegExp(childMarker),
			);
			assert.doesNotMatch(
				customResults[0].details.resultContent,
				/Parent action:/,
			);
			assert.equal(
				entries
					.slice(customIndex + 1)
					.some(
						(entry) => entry.type === "message" && entry.message?.role === "user",
					),
				false,
			);

			await waitForTabLabelGone(
				env.workspaceId,
				`SingleResult-${id}`,
				3_000,
			);
		});

		it("injects role-derived skills into the first child request without extra turns", async () => {
			const id = uniqueId();
			const firstBody = `ROLE_SKILL_FIRST_BODY_${id}`;
			const secondBody = `ROLE_SKILL_SECOND_BODY_${id}`;
			const report = `ROLE_SKILL_REPORT_${id}`;
			const role = `ale54-role-${id}`;
			const parentSession = join(env.dir, `role-skills-parent-${id}.jsonl`);
			writeIntegrationSkill(env.dir, "ale54-first", firstBody);
			writeIntegrationSkill(env.dir, "ale54-second", secondBody);
			writeSkillRole(env.dir, role, "ale54-first,ale54-second");

			const surface = createTrackedSurface(env, `role-skills-${id}`);
			await waitForPaneReady(surface);
			startPi(surface, env.dir, [
				"Call the subagent tool with these EXACT parameters:",
				`  name: "RoleSkills-${id}"`,
				`  agent: "${role}"`,
				`  task: "Return exactly ${report}"`,
				"Do not do anything else. Just call the subagent tool once.",
			].join("\n"), { extraArgs: `--session ${shellQuote(parentSession)}` });

			await waitForParentEvidence(parentSession, /"customType":"subagent_result"/, surface, PI_TIMEOUT);
			const parentEntries = readSessionEntries(parentSession);
			const results = parentEntries.filter((entry) =>
				entry.type === "custom_message" && entry.customType === "subagent_result");
			const childSession = results[0]?.details?.sessionFile;
			assert.equal(typeof childSession, "string", "parent result must identify the child session");
			const childEntries = readSessionEntries(childSession);
			const childRequests = getProviderRequests().filter((request) =>
				!request.tools.includes("subagent") &&
				(request.text.includes(firstBody) || request.text.includes(secondBody)));
			const violations = [
				...(childRequests.length !== 1 ? [`expected one skill-bearing provider request, got ${childRequests.length}`] : []),
				...(!childRequests[0]?.text.includes(firstBody) ? ["first role skill was absent from the first child request"] : []),
				...(!childRequests[0]?.text.includes(secondBody) ? ["second role skill was absent from the first child request"] : []),
				...(!childRequests[0]?.text.includes(report) ? ["assigned task was absent from the skill-bearing first child request"] : []),
				...(JSON.stringify(childEntries).includes("/skill:") ? ["child session contains a /skill: user command"] : []),
				...(results.length !== 1 ? [`expected one parent result, got ${results.length}`] : []),
				...(!String(results[0]?.details?.resultContent).includes(report) ? ["parent received a skill response instead of the finished report"] : []),
			];
			assert.deepEqual(violations, []);
		});

		it("uses a direct skill override once and keeps missing skill warnings out of model and parent content", async () => {
			const id = uniqueId();
			const roleBody = `OVERRIDDEN_ROLE_SKILL_BODY_${id}`;
			const directBody = `DIRECT_SKILL_BODY_${id}`;
			const report = `DIRECT_SKILL_REPORT_${id}`;
			const role = `ale54-direct-${id}`;
			const parentSession = join(env.dir, `direct-skills-parent-${id}.jsonl`);
			writeIntegrationSkill(env.dir, "ale54-role-default", roleBody);
			writeIntegrationSkill(env.dir, "ale54-direct", directBody);
			writeSkillRole(env.dir, role, "ale54-role-default", false);

			const childName = `DirectSkills-${id}`;
			const surface = createTrackedSurface(env, `direct-skills-${id}`);
			await waitForPaneReady(surface);
			startPi(surface, env.dir, [
				"Call the subagent tool with these EXACT parameters:",
				`  name: "${childName}"`,
				`  agent: "${role}"`,
				'  skills: "ale54-direct, ale54-missing, ale54-direct, ale54-missing"',
				`  task: "Return exactly ${report}"`,
				"Do not do anything else. Just call the subagent tool once.",
			].join("\n"), { extraArgs: `--session ${shellQuote(parentSession)}` });

			await waitForParentEvidence(
				parentSession,
				new RegExp(`"customType":"subagent_result"[^\\n]*${report}`),
				surface,
				PI_TIMEOUT,
			);
			const childPane = await waitForAgentPane(childName, env.workspaceId);
			const childScreen = await waitForScreen(
				childPane,
				/ale54-missing/i,
				PI_TIMEOUT,
				300,
			);
			const parentEntries = readSessionEntries(parentSession);
			const results = parentEntries.filter((entry) =>
				entry.type === "custom_message" && entry.customType === "subagent_result");
			const childSession = results[0]?.details?.sessionFile;
			assert.equal(typeof childSession, "string", "parent result must identify the child session");
			const childEntries = readSessionEntries(childSession);
			const childRequests = getProviderRequests().filter((request) =>
				!request.tools.includes("subagent") &&
				(request.text.includes(directBody) || request.text.includes(report)));
			const modelText = childRequests.map((request) => request.text).join("\n");
			const childReportText = childEntries
				.filter((entry) => entry.type === "message" && entry.message?.role === "assistant")
				.map((entry) => JSON.stringify(entry.message.content))
				.join("\n");
			const parentResultText = results.map((result) => JSON.stringify(result)).join("\n");
			const violations = [
				...(childRequests.length !== 1 ? [`expected one direct-skill/task provider request, got ${childRequests.length}`] : []),
				...(countText(childRequests[0]?.text ?? "", directBody) !== 1 ? ["duplicate direct skill was not injected exactly once"] : []),
				...(modelText.includes(roleBody) ? ["direct skills did not replace the role default"] : []),
				...(!childRequests[0]?.text.includes(report) ? ["assigned task was absent from the direct-skill first request"] : []),
				...(JSON.stringify(childEntries).includes("/skill:") ? ["child session contains a /skill: user command"] : []),
				...(modelText.includes("ale54-missing") ? ["skill warning leaked into child model context"] : []),
				...(childReportText.includes("ale54-missing") ? ["skill warning leaked into the child report"] : []),
				...(parentResultText.includes("ale54-missing") ? ["skill warning leaked into the parent result"] : []),
				...(results.length !== 1 ? [`expected one parent result, got ${results.length}`] : []),
				...(!String(results[0]?.details?.resultContent).includes(report) ? ["parent did not receive the finished direct-skill report"] : []),
				...(!childScreen.includes("ale54-missing") ? ["child UI did not show the non-blocking skill warning"] : []),
			];
			assert.deepEqual(violations, []);
		});

		it("treats an explicit empty direct skills value as disabling role skills", async () => {
			const id = uniqueId();
			const roleBody = `EMPTY_OVERRIDE_ROLE_BODY_${id}`;
			const report = `EMPTY_OVERRIDE_REPORT_${id}`;
			const role = `ale54-empty-${id}`;
			const parentSession = join(env.dir, `empty-skills-parent-${id}.jsonl`);
			writeIntegrationSkill(env.dir, "ale54-empty-default", roleBody);
			writeSkillRole(env.dir, role, "ale54-empty-default");

			const surface = createTrackedSurface(env, `empty-skills-${id}`);
			await waitForPaneReady(surface);
			startPi(surface, env.dir, [
				"Call the subagent tool with these EXACT parameters:",
				`  name: "EmptySkills-${id}"`,
				`  agent: "${role}"`,
				'  skills: ""',
				`  task: "Return exactly ${report}"`,
				"Do not do anything else. Just call the subagent tool once.",
			].join("\n"), { extraArgs: `--session ${shellQuote(parentSession)}` });

			await waitForParentEvidence(
				parentSession,
				new RegExp(`"customType":"subagent_result"[^\\n]*${report}`),
				surface,
				PI_TIMEOUT,
			);
			const results = readSessionEntries(parentSession).filter((entry) =>
				entry.type === "custom_message" && entry.customType === "subagent_result");
			assert.equal(
				getProviderRequests().some((request) => request.text.includes(roleBody)),
				false,
				"an explicit empty direct value must disable the role skill",
			);
			assert.equal(results.length, 1);
			assert.match(String(results[0].details?.resultContent), new RegExp(report));
		});

		it("runs a writing subagent in a retained Herdr worktree", async () => {
			const id = uniqueId();
			const branch = `integration/ticket-${id}`;
			const ticketFile = `ticket-${id}.txt`;
			const surface = createTrackedSurface(env, `worktree-run-${id}`);
			await waitForPaneReady(surface);

			execFileSync("git", ["init", "-q", "-b", "main"], { cwd: env.dir });
			execFileSync("git", ["config", "user.email", "test@example.com"], {
				cwd: env.dir,
			});
			execFileSync("git", ["config", "user.name", "Integration Test"], {
				cwd: env.dir,
			});
			// Worktrees inherit this repo config; disable signing so non-interactive commits succeed.
			execFileSync("git", ["config", "commit.gpgsign", "false"], {
				cwd: env.dir,
			});
			writeFileSync(join(env.dir, "README.md"), "worktree lifecycle fixture\n");
			// Keep harness .pi/agent config out of the committed base so worktree children
			// inherit PI_CODING_AGENT_DIR instead of writing sessions into the worktree.
			writeFileSync(join(env.dir, ".gitignore"), ".pi/\n");
			execFileSync("git", ["add", "README.md", ".gitignore"], { cwd: env.dir });
			execFileSync("git", ["commit", "-qm", "fixture"], { cwd: env.dir });

			const task = [
				`Call the subagent tool with these EXACT parameters:`,
				`  name: "Worktree-${id}"`,
				`  agent: "test-echo"`,
				`  worktree: { branch: "${branch}" }`,
				`  task: "Run: echo 'WORKTREE_${id}' > '${ticketFile}' && git add '${ticketFile}' && git commit -m 'Implement ${id}'"`,
				`Do not do anything else. Just call the subagent tool once.`,
				`After you receive the result, say WORKTREE_COMPLETE_${id} and repeat its worktree path.`,
			].join("\n");

			startPi(surface, env.dir, task);

			let worktree:
				| { path: string; branch: string; open_workspace_id: string }
				| undefined;
			const startedAt = Date.now();
			while (!worktree && Date.now() - startedAt < PI_TIMEOUT) {
				const output = execFileSync(
					"herdr",
					["worktree", "list", "--cwd", env.dir, "--json"],
					{
						encoding: "utf8",
					},
				);
				worktree = JSON.parse(output).result.worktrees.find(
					(candidate: { branch?: string }) => candidate.branch === branch,
				);
				if (!worktree) await sleep(250);
			}
			assert.ok(
				worktree,
				`Expected Herdr to create branch ${branch}. Parent screen:\n${readPane(surface, 300)}`,
			);

			try {
				const content = await waitForFile(
					join(worktree.path, ticketFile),
					PI_TIMEOUT,
					/WORKTREE_/,
				);
				assert.ok(content.includes(`WORKTREE_${id}`));

				await waitForScreen(
					surface,
					new RegExp(`WORKTREE_COMPLETE_${id}`),
					PI_TIMEOUT,
					300,
				);
				assert.equal(
					execFileSync("git", ["status", "--porcelain"], {
						cwd: worktree.path,
						encoding: "utf8",
					}),
					"",
				);
				assert.match(
					execFileSync("git", ["log", "-1", "--pretty=%s"], {
						cwd: worktree.path,
						encoding: "utf8",
					}),
					new RegExp(`Implement ${id}`),
				);
				assert.ok(
					worktree.open_workspace_id,
					"Completed worktree workspace should remain open",
				);
			} finally {
				// Cleanup must not mask body failures or require a perfectly clean tree.
				if (worktree?.open_workspace_id) {
					try {
						execFileSync("herdr", [
							"worktree",
							"remove",
							"--workspace",
							worktree.open_workspace_id,
							"--force",
							"--json",
						]);
					} catch {
						// Best-effort cleanup for interrupted/dirty retained worktrees.
					}
				}
				try {
					execFileSync("git", ["branch", "-D", branch], {
						cwd: env.dir,
						stdio: "ignore",
					});
				} catch {
					// Branch may already be gone after forced worktree removal.
				}
			}
		});

		it("holds completion in a replacement session and delivers after the exact parent resumes", async () => {
			const id = uniqueId();
			const startFile = `/tmp/pi-integ-switch-start-${id}.txt`;
			const markerFile = `/tmp/pi-integ-switch-done-${id}.txt`;
			const parentSession = join(env.dir, `switch-parent-${id}.jsonl`);
			const childDir = join(env.dir, "sibling-project");
			mkdirSync(childDir);
			trackTempFile(env, startFile);
			trackTempFile(env, markerFile);

			const surface = createTrackedSurface(env, `switch-${id}`);
			await waitForPaneReady(surface);
			const task = [
				`Call the subagent tool with these EXACT parameters:`,
				`  name: "Switch-${id}"`,
				`  agent: "test-echo"`,
				`  cwd: "${childDir}"`,
				`  task: "Run this bash command: echo 'START_${id}' > '${startFile}'; sleep 12; echo 'DONE_${id}' > '${markerFile}'"`,
				`Do not do anything else. Just call the subagent tool once.`,
			].join("\n");

			startPi(surface, env.dir, task, {
				extraArgs: `--session ${shellQuote(parentSession)}`,
				environment: { PI_INTEG_PERSIST_REPLACEMENTS_PANE: surface },
			});
			await waitForFile(startFile, PI_TIMEOUT, /START_/);
			const parentSessionId = JSON.parse(
				readFileSync(parentSession, "utf8").split("\n")[0],
			).id;
			assert.ok(parentSessionId, "the original parent session must have an id");

			// /new makes the original session offline while keeping a replacement
			// process alive. Add a newer unrelated transcript to prove that file
			// recency cannot be used to identify the replacement.
			runInPane(surface, "/new");
			await waitForScreen(surface, /New session started/, PI_TIMEOUT, 300);
			const replacementMarker = `EXACT_REPLACEMENT_${id}`;
			const decoySession = join(
				env.dir,
				".pi",
				"agent",
				`decoy-${id}.jsonl`,
			);
			writeFileSync(
				decoySession,
				[
					JSON.stringify({ type: "session", id: `decoy-${id}` }),
					JSON.stringify({
						type: "custom_message",
						customType: "subagent_result",
						details: {
							kind: "terminal",
							outcome: "decoy",
							childId: `decoy-child-${id}`,
							deliveryId: `decoy-delivery-${id}`,
							sessionFile: parentSession,
						},
					}),
				].join("\n") + "\n",
				"utf8",
			);
			trackTempFile(env, decoySession);
			runInPane(surface, `Reply with exactly ${replacementMarker}.`);
			await waitForScreen(surface, new RegExp(replacementMarker), PI_TIMEOUT, 300);
			const replacement = await waitForReplacementSession(
				surface,
				join(env.dir, ".pi", "agent"),
				parentSession,
				replacementMarker,
			);
			const replacementBeforeRaw = readFileSync(replacement.sessionFile, "utf8");
			const replacementBeforeEntries = readSessionEntries(replacement.sessionFile);
			assert.notEqual(
				replacement.sessionId,
				parentSessionId,
				"/new must create a different session id",
			);
			assert.notEqual(
				replacement.sessionFile,
				parentSession,
				"/new must create a different session file",
			);

			assert.notEqual(
				replacement.sessionFile,
				decoySession,
				"replacement lookup must follow the parent pane, not a newer decoy transcript",
			);
			assert.equal(
				customResultEntries(replacementBeforeEntries).length,
				0,
				"replacement JSONL must have no old result before child completion",
			);
			await waitForFile(markerFile, PI_TIMEOUT, /DONE_/);
			await sleep(3_000);
			const replacementScreen = readPane(surface, 300);
			assert.doesNotMatch(
				replacementScreen,
				new RegExp(`Sub-agent .*Switch-${id}.*completed`, "i"),
				"a replacement session must not receive the old session's completion",
			);
			const deliveredResults = () =>
				readSessionEntries(parentSession).filter(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === "subagent_result" &&
						typeof entry.content === "string" &&
						entry.content.includes(`Switch-${id}`),
				);
			assert.equal(
				deliveredResults().length,
				0,
				"the original parent inbox must remain pending while that session is offline",
			);
			const replacementAfterRaw = readFileSync(replacement.sessionFile, "utf8");
			const replacementAfterEntries = readSessionEntries(replacement.sessionFile);
			assert.equal(
				customResultEntries(replacementAfterEntries).length,
				0,
				"replacement JSONL must have no old result after child completion",
			);

			runInPane(surface, "/quit");
			await waitForPiExit(surface, PI_TIMEOUT);

			const resumeSurface = createTrackedSurface(env, `switch-resume-${id}`);
			await waitForPaneReady(resumeSurface);
			startPi(
				resumeSurface,
				env.dir,
				`Wait for the pending result, then say EXACT_PARENT_RESUMED_${id}.`,
				{ extraArgs: `--session ${shellQuote(parentSession)}` },
			);
			const resumeDeadline = Date.now() + PI_TIMEOUT;
			let resumedResults = deliveredResults();
			while (resumedResults.length === 0 && Date.now() < resumeDeadline) {
				await sleep(100);
				resumedResults = deliveredResults();
			}
			assert.ok(
				resumedResults.length > 0,
				`the exact parent should receive its pending result; screen=${readPane(resumeSurface, 300)}`,
			);
			assert.equal(
				JSON.parse(readFileSync(parentSession, "utf8").split("\n")[0]).id,
				parentSessionId,
				"resuming the exact file must preserve its original session id",
			);
			const deliveryIds = resumedResults.map((entry) => entry.details?.deliveryId);
			assert.ok(
				deliveryIds.every((deliveryId) => typeof deliveryId === "string"),
				"materialized results must carry durable delivery ids",
			);
			assert.equal(
				new Set(deliveryIds).size,
				resumedResults.length,
				"each pending inbox result must materialize exactly once",
			);
			const childIds = resumedResults.map((entry) => entry.details?.childId);
			assert.ok(
				childIds.every((childId) => typeof childId === "string"),
				"materialized results must carry the stable child id",
			);
			assert.equal(
				new Set(childIds).size,
				1,
				"all pending results must identify the same child",
			);
			for (const stableId of [...deliveryIds, ...childIds]) {
				assert.equal(
					replacementBeforeRaw.includes(String(stableId)),
					false,
					`replacement JSONL must not contain ${String(stableId)} before completion`,
				);
				assert.equal(
					replacementAfterRaw.includes(String(stableId)),
					false,
					`replacement JSONL must not contain ${String(stableId)} after completion`,
				);
			}

			runInPane(resumeSurface, "/quit");
			await waitForPiExit(resumeSurface, PI_TIMEOUT);

			// A later startup/resume sees the delivery id already recorded in the
			// session and must not append a duplicate result.
			const secondResumeSurface = createTrackedSurface(env, `switch-resume-again-${id}`);
			await waitForPaneReady(secondResumeSurface);
			startPi(
				secondResumeSurface,
				env.dir,
				`Say EXACT_PARENT_SECOND_START_${id}.`,
				{ extraArgs: `--session ${shellQuote(parentSession)}` },
			);
			await waitForScreen(
				secondResumeSurface,
				new RegExp(`EXACT_PARENT_SECOND_START_${id}`),
				PI_TIMEOUT,
			);
			assert.equal(
				deliveredResults().length,
				resumedResults.length,
				"a subsequent exact-session startup must not duplicate the completion",
			);
			assert.deepEqual(
				deliveredResults().map((entry) => entry.details?.deliveryId),
				deliveryIds,
				"subsequent exact-session startup must preserve the original delivery ids",
			);
			runInPane(secondResumeSurface, "/quit");
			await waitForPiExit(secondResumeSurface, PI_TIMEOUT);
		});


		it("keeps a long active tool call from surfacing false stalled status", async () => {
			const id = uniqueId();
			const startFile = `/tmp/pi-integ-status-start-${id}.txt`;
			const markerFile = `/tmp/pi-integ-status-${id}.txt`;
			trackTempFile(env, startFile);
			trackTempFile(env, markerFile);

			const surface = createTrackedSurface(env, `status-${id}`);
			await waitForPaneReady(surface);

			const task = [
				`Call the subagent tool with these EXACT parameters:`,
				`  name: "Status-${id}"`,
				`  agent: "test-echo"`,
				`  task: "Use the bash tool with a 150-second timeout to run exactly: echo 'START_${id}' > '${startFile}'; sleep 120; echo 'STATUS_${id}' > '${markerFile}'"`,
				`Do not do anything else. Just call the subagent tool once.`,
				`After you receive the subagent result, say STATUS_TEST_DONE.`,
			].join("\n");

			startPi(surface, env.dir, task);

			const activeScreen = await waitForScreen(
				surface,
				/active[\s\S]*bash|bash[\s\S]*active/i,
				PI_TIMEOUT,
				300,
			);
			assert.doesNotMatch(
				activeScreen,
				/Subagent status[\s\S]*stalled|stalled[\s\S]*Subagent status/i,
			);

			await waitForFile(startFile, PI_TIMEOUT, /START_/);
			assert.equal(
				existsSync(markerFile),
				false,
				"Completion marker should not exist before the long sleep",
			);
			await sleep(65_000);
			const watchdogScreen = readPane(surface, 300);
			assert.doesNotMatch(
				watchdogScreen,
				/Subagent status[\s\S]*stalled|stalled[\s\S]*Subagent status/i,
			);

			const content = await waitForFile(markerFile, PI_TIMEOUT, /STATUS_/);
			assert.ok(
				content.includes(`STATUS_${id}`),
				`Marker file should contain STATUS_${id}`,
			);

			const completionScreen = await waitForScreen(
				surface,
				/STATUS_TEST_DONE|completed|Sub-agent.*"Status-/i,
				PI_TIMEOUT,
				300,
			);
			assert.ok(/STATUS_TEST_DONE|completed/i.test(completionScreen));
		});

		// ── Parallel subagent spawn ──

		it("spawns two subagents in parallel and both complete", async () => {
			const id = uniqueId();
			const fileA = `/tmp/pi-integ-para-${id}-a.txt`;
			const fileB = `/tmp/pi-integ-para-${id}-b.txt`;
			trackTempFile(env, fileA);
			trackTempFile(env, fileB);

			const surface = createTrackedSurface(env, `parallel-${id}`);
			await waitForPaneReady(surface);

			const task = [
				`You must call the subagent tool TWICE. Make both calls before waiting for results.`,
				``,
				`First call:`,
				`  name: "ParaA-${id}"`,
				`  agent: "test-echo"`,
				`  task: "Run: echo 'DONE_A_${id}' > '${fileA}'"`,
				``,
				`Second call:`,
				`  name: "ParaB-${id}"`,
				`  agent: "test-echo"`,
				`  task: "Run: echo 'DONE_B_${id}' > '${fileB}'"`,
				``,
				`Call both subagent tools NOW, do not wait between them.`,
			].join("\n");

			startPi(surface, env.dir, task);

			// Both marker files should appear
			const [contentA, contentB] = await Promise.all([
				waitForFile(fileA, PI_TIMEOUT, /DONE_A/),
				waitForFile(fileB, PI_TIMEOUT, /DONE_B/),
			]);

			assert.ok(contentA.includes(`DONE_A_${id}`), `File A should contain marker`);
			assert.ok(contentB.includes(`DONE_B_${id}`), `File B should contain marker`);
		});

		// ── Fork mode ──

		it("delivers a complete large result with its durable file and exact child session", async () => {
			const id = uniqueId();
			const parentSession = join(env.dir, `large-result-parent-${id}.jsonl`);
			const surface = createTrackedSurface(env, `large-result-${id}`);
			await waitForPaneReady(surface);

			startPi(surface, env.dir, [
				"Call the subagent tool with these EXACT parameters:",
				`  name: "Large-${id}"`,
				"  agent: \"test-echo\"",
				"  task: \"INTEGRATION_LARGE_RESULT\"",
				"Wait for the asynchronous result.",
			].join("\n"), { extraArgs: `--session ${shellQuote(parentSession)}` });

			await waitForParentEvidence(parentSession, /LARGE_RESULT_END/, surface, PI_TIMEOUT);
			const entries = readSessionEntries(parentSession) as IntegrationSessionEntry[];
			const details = customResultEntries(entries)[0]?.details ?? {};
			assert.equal(typeof details.sessionFile, "string");
			assert.equal(typeof details.resultPath, "string");
			assert.equal(isAbsolute(details.resultPath as string), true);
			assert.equal(existsSync(details.sessionFile as string), true);
			assert.equal(existsSync(details.resultPath as string), true);
			const durable = readFileSync(details.resultPath as string, "utf8");
			assert.match(durable, /Status: (?:completed|settled)/);
			assert.match(durable, /LARGE_RESULT_BEGIN/);
			assert.match(durable, /LARGE_RESULT_END/);
			assert.ok(durable.length > 20_000, "durable result must retain the unbounded answer");
			assert.match(String(details.resultContent), /LARGE_RESULT_BEGIN/);
			assert.match(String(details.resultContent), /LARGE_RESULT_END/);
		});

		it("recovers a crashed autonomous child in the same session and routes one final result", async () => {
			const id = uniqueId();
			const parentSession = join(env.dir, `crash-parent-${id}.jsonl`);
			const surface = createTrackedSurface(env, `crash-parent-${id}`);
			await waitForPaneReady(surface);

			startPi(surface, env.dir, [
				"Call the subagent tool with these EXACT parameters:",
				`  name: "Crash-${id}"`,
				"  agent: \"test-echo\"",
				"  task: \"INTEGRATION_HOLD_QUIET_ONCE\"",
				"Wait for the asynchronous result.",
			].join("\n"), {
				extraArgs: `--session ${shellQuote(parentSession)}`,
				environment: { PI_SUBAGENT_QUIET_THRESHOLD_MS: "30000" },
			});

			const childPane = await waitForAgentPane(`Crash-${id}`, env.workspaceId);
			const processDeadline = Date.now() + 5_000;
			let childPids = getPaneProcessInfo(childPane).pids;
			while (childPids.length < 2 && Date.now() < processDeadline) {
				await sleep(50);
				childPids = getPaneProcessInfo(childPane).pids;
			}
			assert.ok(childPids.length > 1, "crash fixture must observe the pane shell and Pi process");
			process.kill(Math.max(...childPids), "SIGKILL");
			await waitForCustomResultCount(parentSession, 1);

			await waitForAgentGone(childPane, env.workspaceId);
			const results = customResultEntries(readSessionEntries(parentSession));
			assert.equal(results.length, 1, JSON.stringify(results.map((entry) => entry.details), null, 2));
			const details = results[0]?.details ?? {};
			assert.equal(typeof details.sessionFile, "string");
			const lineage = JSON.parse(readFileSync(`${details.sessionFile}.lineage.json`, "utf8")) as { rootDir?: string };
			assert.equal(typeof lineage.rootDir, "string");
			const ledger = readFileSync(join(lineage.rootDir as string, "subagent-delivery.log"), "utf8");
			assert.equal(ledger.split("\n").filter((line) => line.includes('"event":"recovery-attempt"')).length, 1);
			assert.match(ledger, /"cause":"crash"/);
			assert.match(String(details.resultContent), /QUIET_RECOVERY_COMPLETE/);
		});

		it("cancels a manually closed subagent tab without recovery", async () => {
			const id = uniqueId();
			const parentSession = join(env.dir, `manual-close-parent-${id}.jsonl`);
			const surface = createTrackedSurface(env, `manual-close-parent-${id}`);
			await waitForPaneReady(surface);

			startPi(surface, env.dir, [
				"Call the subagent tool with these EXACT parameters:",
				`  name: "ManualClose-${id}"`,
				'  agent: "test-echo"',
				'  task: "INTEGRATION_HOLD_QUIET_ONCE"',
				"Wait for the asynchronous result.",
			].join("\n"), {
				extraArgs: `--session ${shellQuote(parentSession)}`,
				environment: { PI_SUBAGENT_QUIET_THRESHOLD_MS: "30000" },
			});

			const childPane = await waitForAgentPane(`ManualClose-${id}`, env.workspaceId);
			await waitForScreen(childPane, /INTEGRATION_HOLD_QUIET_ONCE|working|active/i, PI_TIMEOUT, 100);
			closePane(childPane);
			await waitForCustomResultCount(parentSession, 1);

			const results = customResultEntries(readSessionEntries(parentSession));
			assert.equal(results.length, 1);
			const details = results[0]?.details ?? {};
			assert.match(String(details.resultContent), /cancelled[.]\n\nSubagent cancelled by user[.]/);
			assert.match(String(details.resultPath), /-cancelled\.md$/);
			assert.equal(typeof details.sessionFile, "string");
			const lineage = JSON.parse(readFileSync(`${details.sessionFile}.lineage.json`, "utf8")) as { rootDir?: string };
			const ledgerPath = join(String(lineage.rootDir), "subagent-delivery.log");
			const ledger = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "";
			assert.doesNotMatch(ledger, /"event":"recovery-attempt"/);
		});

		it("revives a stale autonomous child three times before one recovery-failed result", async () => {
			const id = uniqueId();
			const parentSession = join(env.dir, `stale-parent-${id}.jsonl`);
			const surface = createTrackedSurface(env, `stale-parent-${id}`);
			await waitForPaneReady(surface);

			startPi(surface, env.dir, [
				"Call the subagent tool with these EXACT parameters:",
				`  name: "Stale-${id}"`,
				"  agent: \"test-echo\"",
				"  task: \"INTEGRATION_ALWAYS_QUIET\"",
				"Wait for the asynchronous result.",
			].join("\n"), {
				extraArgs: `--session ${shellQuote(parentSession)}`,
				environment: { PI_SUBAGENT_QUIET_THRESHOLD_MS: "250" },
			});

			await waitForParentEvidence(parentSession, /Recovery failed after repeated stale watchdog kills/, surface, PI_TIMEOUT);
			const results = customResultEntries(readSessionEntries(parentSession));
			assert.equal(results.length, 1);
			const details = results[0]?.details ?? {};
			assert.equal(typeof details.resultPath, "string");
			assert.match(readFileSync(details.resultPath as string, "utf8"), /Status: recovery-failed/);
			const revives = getProviderRequests().filter((request) =>
				/previous process became stale/.test(request.userText)
			);
			assert.equal(revives.length, 3, "exactly three same-session revives must run");
		});


		it("fork mode creates a child session linked to the parent", async () => {
			const id = uniqueId();
			const markerFile = `/tmp/pi-integ-fork-${id}.txt`;
			trackTempFile(env, markerFile);

			const surface = createTrackedSurface(env, `fork-${id}`);
			await waitForPaneReady(surface);

			const task = [
				`Call the subagent tool with these EXACT parameters:`,
				`  name: "Fork-${id}"`,
				`  fork: true`,
				`  task: "Run this bash command: echo 'FORK_OK_${id}' > '${markerFile}'"`,
				`Do not set the agent or interactive parameters. Just set name, fork, and task.`,
				`After you receive the result, say FORK_COMPLETE.`,
			].join("\n");

			startPi(surface, env.dir, task);

			// Verify: forked subagent created the file
			const content = await waitForFile(markerFile, PI_TIMEOUT, /FORK_OK/);
			assert.ok(
				content.includes(`FORK_OK_${id}`),
				`Fork marker file should exist with content`,
			);

			// Wait for the outer pi to show the result
			const screen = await waitForScreen(
				surface,
				/FORK_COMPLETE|completed|Sub-agent.*"Fork/i,
				PI_TIMEOUT,
			);

			// Receiving the result proves the bare fork auto-exited and its child pane
			// was finalized instead of remaining at the editor as an interactive run.

			// Verify: the forked session has a parent link
			const sessionMatch = screen.match(/Session:\s*(\S+\.jsonl)/);
			if (sessionMatch) {
				const sessionFile = sessionMatch[1];
				assert.ok(
					existsSync(sessionFile),
					`Fork session file should exist: ${sessionFile}`,
				);

				const entries = readFileSync(sessionFile, "utf8")
					.trim()
					.split("\n")
					.map((l) => JSON.parse(l));
				const header = entries[0];
				assert.equal(
					header.type,
					"session",
					"First entry should be session header",
				);
				assert.ok(
					header.parentSession,
					"Fork session should have parentSession field",
				);
				// Fork sessions include parent context (model_change entries etc.)
				assert.ok(
					entries.length >= 2,
					"Fork session should have context entries beyond header",
				);
			}
		});

		// ── caller_ping ──

		it("delivers caller_ping as nonterminal help before the same child settles", async () => {
			const id = uniqueId();
			const childName = `Ping-${id}`;
			const parentSession = join(env.dir, `ping-parent-${id}.jsonl`);
			const surface = createTrackedSurface(env, `ping-${id}`);
			await waitForPaneReady(surface);

			startPi(surface, env.dir, [
				"Call the subagent tool with these EXACT parameters:",
				`  name: "${childName}"`,
				"  agent: \"test-ping\"",
				"  autoExit: false",
				`  task: "PING_TEST_${id}"`,
				"Call it once and wait for asynchronous results.",
			].join("\n"), { extraArgs: `--session ${shellQuote(parentSession)}` });

			const firstEntries = await waitForCustomResultCount(parentSession, 1);
			const first = customResultEntries(firstEntries)[0]?.details ?? {};
			assert.equal(first.kind, "help-request");
			assert.equal(typeof first.sessionFile, "string");
			assert.equal(typeof first.resultPath, "string");
			assert.match(readFileSync(first.resultPath as string, "utf8"), /Status: help-request/);
			assert.match(String(first.resultContent), /PING: integration/);

			const childPane = await waitForAgentPane(childName, env.workspaceId);
			assert.ok(listWorkspacePanes(env.workspaceId).some((pane) => pane.pane_id === childPane));

			const settledEntries = await waitForCustomResultCount(parentSession, 2);
			const results = customResultEntries(settledEntries);
			assert.equal(results.length, 2);
			assert.notEqual(results[1]?.details?.deliveryId, first.deliveryId);
			assert.equal(results[1]?.details?.sessionFile, first.sessionFile);
			assert.match(String(results[1]?.details?.resultContent), /completed/);
			assert.ok(listWorkspacePanes(env.workspaceId).some((pane) => pane.pane_id === childPane), "help and settlement must leave the persistent child open");

			execFileSync("herdr", ["agent", "prompt", childPane, "PING_AGAIN"], { encoding: "utf8" });
			const repeatedEntries = await waitForCustomResultCount(parentSession, 3);
			const repeated = customResultEntries(repeatedEntries);
			assert.equal(repeated[2]?.details?.kind, "help-request");
			assert.notEqual(repeated[2]?.details?.deliveryId, first.deliveryId);
			assert.notEqual(repeated[2]?.details?.resultPath, first.resultPath);
			assert.equal(repeated[2]?.details?.sessionFile, first.sessionFile);

			execFileSync("herdr", ["agent", "prompt", childPane, "CLOSE_PERSISTENT_CHILD"], { encoding: "utf8" });
			await waitForAgentGone(childPane, env.workspaceId);
			const finalResults = customResultEntries(readSessionEntries(parentSession));
			assert.equal(finalResults.filter((entry) => entry.details?.kind === "help-request").length, 2);
			assert.ok(finalResults.length >= 3 && finalResults.length <= 4, "terminal close must not duplicate the final answer");
		});


		it("resumes a Pi session and delivers its new result to the parent", async () => {
			const id = uniqueId();
			const sessionFile = join(env.dir, `resume-child-${id}.jsonl`);
			const seedSurface = createTrackedSurface(env, `resume-seed-${id}`);
			await waitForPaneReady(seedSurface);
			startPi(seedSurface, env.dir, "BTW question: Say FIRST", {
				extraArgs: `--print --session ${shellQuote(sessionFile)}`,
			});
			await waitForScreen(seedSurface, /FIRST/);
			assert.equal(await waitForPiExit(seedSurface), 0);
			assert.equal(existsSync(sessionFile), true);

			const resultMarker = `RESUME_RESULT_${id}`;
			const parentSurface = createTrackedSurface(env, `resume-parent-${id}`);
			await waitForPaneReady(parentSurface);
			startPi(
				parentSurface,
				env.dir,
				[
					"Call the subagent_resume tool with these EXACT parameters:",
					`  sessionPath: "${sessionFile}"`,
					`  name: "Resume-${id}"`,
					`  message: "RESUME_FOLLOWUP_INPUT: ${id}"`,
					"  autoExit: true",
					"Call the tool once and wait for its asynchronous result.",
				].join("\n"),
			);

			const screen = await waitForScreen(
				parentSurface,
				new RegExp(resultMarker),
				PI_TIMEOUT,
			);
			assert.match(screen, new RegExp(resultMarker));
		});

		// ── Agent discovery ──


		it("resumes a non-auto-exit skilled child without reinitializing its session", async () => {
			const id = uniqueId();
			const skillBody = `RESUME_SKILL_BODY_${id}`;
			const initialReport = `RESUME_INITIAL_REPORT_${id}`;
			const resumedReport = `RESUME_RESULT_${id}`;
			const followup = `RESUME_FOLLOWUP_INPUT: ${id}`;
			const role = `ale54-resume-role-${id}`;
			const firstParentSession = join(env.dir, `resume-skilled-parent-${id}.jsonl`);
			writeIntegrationSkill(env.dir, "ale54-resume-skill", skillBody);
			writeSkillRole(env.dir, role, "ale54-resume-skill", false);

			const firstParent = createTrackedSurface(env, `resume-skilled-parent-${id}`);
			await waitForPaneReady(firstParent);
			startPi(
				firstParent,
				env.dir,
				[
					"Call the subagent tool with these EXACT parameters:",
					`  name: "ResumeSkilled-${id}"`,
					`  agent: "${role}"`,
					"  autoExit: false",
					`  task: "Return exactly ${initialReport}"`,
					"Call the tool once and wait for its asynchronous result.",
				].join("\n"),
				{ extraArgs: `--session ${shellQuote(firstParentSession)}` },
			);

			await waitForParentEvidence(
				firstParentSession,
				/"customType":"subagent_result"/,
				firstParent,
				PI_TIMEOUT,
			);
			const firstParentEntries = readSessionEntries(firstParentSession);
			const firstResults = firstParentEntries.filter(
				(entry) =>
					entry.type === "custom_message" &&
					entry.customType === "subagent_result",
			);
			assert.equal(firstResults.length, 1, "initial parent must receive one result");
			assert.match(String(firstResults[0]?.details?.resultContent), new RegExp(initialReport));
			const childSession = firstResults[0]?.details?.sessionFile;
			assert.equal(typeof childSession, "string", "initial result must identify child session");
			if (typeof childSession !== "string") return;

			const initialChildRequests = getProviderRequests().filter(
				(request) =>
					request.text.includes(skillBody) &&
					request.text.includes(initialReport),
			);
			assert.equal(initialChildRequests.length, 1, "skill and task must share the initial child request");
			assert.equal(
				countText(readFileSync(childSession, "utf8"), "subagent_skill_initialization"),
				1,
				"initial child session must persist one skill initialization message",
			);

			const secondParent = createTrackedSurface(env, `resume-skilled-followup-${id}`);
			await waitForPaneReady(secondParent);
			const secondParentSession = join(env.dir, `resume-skilled-followup-${id}.jsonl`);
			startPi(
				secondParent,
				env.dir,
				[
					"Call the subagent_resume tool with these EXACT parameters:",
					`  sessionPath: "${childSession}"`,
					`  name: "ResumeSkilledFollowup-${id}"`,
					`  message: "${followup}"`,
					"  autoExit: false",
					"Call the tool once and wait for its asynchronous result.",
				].join("\n"),
				{ extraArgs: `--session ${shellQuote(secondParentSession)}` },
			);
			await waitForFile(childSession, PI_TIMEOUT, new RegExp(resumedReport));
			assert.equal(
				readSessionEntries(firstParentSession).filter(
					(entry) =>
						entry.type === "custom_message" &&
						entry.customType === "subagent_result",
				).length,
				1,
				"resuming must not duplicate the initial result in its original parent",
			);
			const childEntries = readSessionEntries(childSession);
			const resumedRequests = getProviderRequests().filter(
				(request) =>
					request.text.includes(skillBody) && request.text.includes(followup),
			);
			assert.equal(resumedRequests.length, 1, "resume request must retain the original skill body");
			assert.equal(
				countText(JSON.stringify(childEntries), "subagent_skill_initialization"),
				1,
				"resuming must not add a second skill initialization message",
			);
			assert.equal(
				childEntries.filter((entry) =>
					entry.type === "message" &&
					entry.message?.role === "user" &&
					/\/skill:/.test(JSON.stringify(entry)),
				).length,
				0,
				"child session must not contain skill command turns",
			);
			assert.doesNotMatch(JSON.stringify(childEntries), /Unable to load requested skill/);
			assert.doesNotMatch(
				getProviderRequests()
					.filter((request) => request.text.includes(skillBody))
					.map((request) => request.text)
					.join("\n"),
				/Unable to load requested skill/,
			);
		});

		it("subagent discovers project-local test agents", async () => {
			const id = uniqueId();
			const markerFile = `/tmp/pi-integ-discovery-${id}.txt`;
			trackTempFile(env, markerFile);

			const surface = createTrackedSurface(env, `discovery-${id}`);
			await waitForPaneReady(surface);

			// Use subagents_list to verify test agents are discoverable,
			// then spawn one to prove it works end-to-end.
			const task = [
				`First, call the subagents_list tool to see available agents.`,
				`Then call the subagent tool:`,
				`  name: "Disco-${id}"`,
				`  agent: "test-echo"`,
				`  task: "Run: echo 'DISCO_${id}' > '${markerFile}'"`,
				`After you receive the subagent result, say DISCOVERY_DONE.`,
			].join("\n");

			startPi(surface, env.dir, task);

			// The test-echo agent (discovered from project .pi/agents/) should work
			const content = await waitForFile(markerFile, PI_TIMEOUT, /DISCO/);
			assert.ok(
				content.includes(`DISCO_${id}`),
				`Discovery test marker should exist`,
			);
		});

		// ── Subagent with custom system prompt ──

		it("passes systemPrompt to subagent", async () => {
			const id = uniqueId();
			const markerFile = `/tmp/pi-integ-sysprompt-${id}.txt`;
			trackTempFile(env, markerFile);

			const surface = createTrackedSurface(env, `sysprompt-${id}`);
			await waitForPaneReady(surface);

			const task = [
				`Call the subagent tool with these parameters:`,
				`  name: "SysP-${id}"`,
				`  agent: "test-echo"`,
				`  systemPrompt: "Always start your response with CUSTOM_PROMPT_ACTIVE."`,
				`  task: "Write 'SYSPROMPT_${id}' to ${markerFile} using bash: echo 'SYSPROMPT_${id}' > '${markerFile}'"`,
				`After the subagent completes, say SYSPROMPT_TEST_DONE.`,
			].join("\n");

			startPi(surface, env.dir, task);

			const content = await waitForFile(markerFile, PI_TIMEOUT, /SYSPROMPT/);
			assert.ok(
				content.includes(`SYSPROMPT_${id}`),
				`System prompt test marker should exist`,
			);
		});

		it("keeps an autonomous owner alive past the stale threshold until its child result is processed", async () => {
			const id = uniqueId();
			const ownerName = `AutoOwner-${id}`;
			const gateFile = `/tmp/pi-integ-auto-owner-${id}`;
			const parentSession = join(env.dir, `auto-owner-parent-${id}.jsonl`);
			trackTempFile(env, gateFile);

			const surface = createTrackedSurface(env, `auto-owner-parent-${id}`);
			await waitForPaneReady(surface);
			startPi(
				surface,
				env.dir,
				[
					"Call subagent with these EXACT parameters:",
					`  name: "${ownerName}"`,
					'  agent: "test-autonomous-descendant-owner"',
					`  task: "INTEGRATION_DESCENDANT_GATE: ${gateFile} INTEGRATION_OWNER_AFTER_CHILD INTEGRATION_DELAY_OWNER_AFTER_CHILD Launch the descendant, then process its result."`,
					"Call the tool once and wait for its asynchronous result.",
				].join("\n"),
				{
					extraArgs: `--session ${shellQuote(parentSession)}`,
					environment: { PI_SUBAGENT_QUIET_THRESHOLD_MS: "1000" },
				},
			);

			const ownerPane = await waitForAgentPane(ownerName, env.workspaceId);
			await waitForScreen(ownerPane, /OWNER_WAITING/, PI_TIMEOUT, 300);

			await sleep(1_500);
			writeFileSync(gateFile, "drain\n");

			const deadline = Date.now() + PI_TIMEOUT;
			let ownerResults: IntegrationSessionEntry[] = [];
			while (Date.now() < deadline) {
				ownerResults = existsSync(parentSession)
					? customResultEntries(readSessionEntries(parentSession)).filter(
							(entry) => String(entry.details?.name) === ownerName,
						)
					: [];
				if (ownerResults.length > 0) break;
				await sleep(50);
			}

			assert.equal(ownerResults.length, 1, readPane(surface, 300));
			assert.match(
				String(ownerResults[0].details?.resultContent),
				/^OWNER_AFTER_CHILD$/m,
				"the owner must answer after processing the last descendant result",
			);
			assert.doesNotMatch(
				String(ownerResults[0].details?.resultContent),
				/^OWNER_WAITING$/m,
			);
			assert.equal(
				getProviderRequests().filter((request) =>
					/previous process became stale/i.test(request.userText),
				).length,
				0,
				"waiting for and processing a descendant must not consume owner recovery",
			);
			await waitForTabLabelGone(env.workspaceId, ownerName);
		});

		it("withholds an owner's terminal result until its nested child drains", async () => {
			const id = uniqueId();
			const ownerName = `DescendantOwner-${id}`;
			const gateFile = `/tmp/pi-integ-descendant-gate-${id}`;
			const parentSession = join(env.dir, `descendant-parent-${id}.jsonl`);
			trackTempFile(env, gateFile);

			const surface = createTrackedSurface(env, `descendant-parent-${id}`);
			await waitForPaneReady(surface);
			startPi(
				surface,
				env.dir,
				[
					"Call subagent with these EXACT parameters:",
					`  name: "${ownerName}"`,
					'  agent: "test-descendant-owner"',
					`  task: "INTEGRATION_DESCENDANT_GATE: ${gateFile} Launch the descendant and stay open."`,
					"Call the tool once and wait for its asynchronous result.",
				].join("\n"),
				{ extraArgs: `--session ${shellQuote(parentSession)}` },
			);

			const ownerPane = await waitForAgentPane(ownerName, env.workspaceId);
			await waitForScreen(ownerPane, /Nested-[^\s]+[\s\S]*active/i, PI_TIMEOUT, 300);
			const waitForOwnerResult = (marker: string) =>
				waitForScreen(
					ownerPane,
					new RegExp(`(?:^|\\n)\\s*${marker}\\s*(?:\\n|$)`),
					PI_TIMEOUT,
					300,
				);

			for (const marker of ["OWNER_ONE", "OWNER_TWO", "OWNER_THREE", "OWNER_FOUR"]) {
				const acknowledgement = execFileSync(
					"herdr",
					["agent", "prompt", ownerPane, `Return exactly ${marker}.`],
					{ encoding: "utf8" },
				);
				assert.ok(acknowledgement.trim(), `Herdr must accept the ${marker} prompt`);
				await waitForOwnerResult(marker);
			}

			const readResults = (): IntegrationSessionEntry[] => {
				if (!existsSync(parentSession)) return [];
				return readFileSync(parentSession, "utf8")
					.split("\n")
					.filter(Boolean)
					.flatMap((line) => {
						const entry = JSON.parse(line) as IntegrationSessionEntry;
						return entry.type === "custom_message" && entry.customType === "subagent_result"
							? [entry]
							: [];
					});
			};

			const prematureResults = readResults();
			assert.equal(
				prematureResults.length,
				0,
				"the logical parent must receive no owner result while the nested child is non-drained; " +
					`received ${JSON.stringify(prematureResults.map((entry) => entry.details?.resultContent))}`,
			);

			writeFileSync(gateFile, "drain\n");
			await waitForAgentGone(ownerPane, env.workspaceId);

			const ownerContents = (entries: IntegrationSessionEntry[]) =>
				entries.flatMap((entry) =>
					String(entry.details?.resultContent).match(/^OWNER_(?:ONE|TWO|THREE|FOUR|FINAL)$/gm) ?? [],
				);
			const deadline = Date.now() + PI_TIMEOUT;
			let results = readResults();
			while (!ownerContents(results).includes("OWNER_FINAL") && Date.now() < deadline) {
				await sleep(50);
				results = readResults();
			}
			assert.deepEqual(
				ownerContents(results),
				["OWNER_FINAL"],
				"direct child input suppresses intermediate settles, while explicit completion waits for descendant drain",
			);
		});

		it("destroys a nested branch when its owner pane is manually closed", async () => {
			const id = uniqueId();
			const ownerName = `ClosedOwner-${id}`;
			const gateFile = `/tmp/pi-integ-closed-owner-${id}`;
			const parentSession = join(env.dir, `closed-owner-parent-${id}.jsonl`);
			trackTempFile(env, gateFile);

			const surface = createTrackedSurface(env, `closed-owner-parent-${id}`);
			await waitForPaneReady(surface);
			startPi(
				surface,
				env.dir,
				[
					"Call subagent with these EXACT parameters:",
					`  name: "${ownerName}"`,
					'  agent: "test-descendant-owner"',
					`  task: "INTEGRATION_DESCENDANT_GATE: ${gateFile} Launch the descendant and stay open."`,
					"Call the tool once and wait for its asynchronous result.",
				].join("\n"),
				{ extraArgs: `--session ${shellQuote(parentSession)}` },
			);

			const ownerPane = await waitForAgentPane(ownerName, env.workspaceId);
			await waitForScreen(ownerPane, /Nested-[^\s]+[\s\S]*active/i, PI_TIMEOUT, 300);
			const nestedPane = listWorkspacePanes(env.workspaceId).find(
				(pane) => pane.label?.startsWith("Nested-") && typeof pane.pane_id === "string",
			)?.pane_id;
			assert.equal(typeof nestedPane, "string", "nested child pane must be live before owner destruction");

			closePane(ownerPane);
			await waitForAgentGone(ownerPane, env.workspaceId);
			await waitForAgentGone(nestedPane as string, env.workspaceId);

			const deadline = Date.now() + PI_TIMEOUT;
			let results: IntegrationSessionEntry[] = [];
			while (Date.now() < deadline) {
				results = existsSync(parentSession)
					? customResultEntries(readSessionEntries(parentSession))
					: [];
				if (results.length > 0) break;
				await sleep(50);
			}
			assert.equal(results.length, 1, "manual owner closure must deliver cancellation exactly once");
			const details = results[0]?.details ?? {};
			assert.match(String(details.resultContent), /cancelled[.]\n\nSubagent cancelled by user[.]/);
			assert.match(String(details.resultPath), /-cancelled\.md$/);
			assert.equal(typeof details.sessionFile, "string");
			const lineage = JSON.parse(readFileSync(`${details.sessionFile}.lineage.json`, "utf8")) as { rootDir?: string };
			const ledgerPath = join(String(lineage.rootDir), "subagent-delivery.log");
			const ledger = existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : "";
			assert.doesNotMatch(ledger, /"event":"recovery-attempt"/);
			assert.equal(
				listWorkspacePanes(env.workspaceId).some((pane) =>
					pane.label === ownerName || pane.label?.startsWith("Nested-"),
				),
				false,
				"the destroyed branch must leave no owner or descendant pane",
			);
		});

		it("suppresses settled delivery after direct child input and still delivers explicit completion", async () => {
			const id = uniqueId();
			const childName = `Persistent-${id}`;
			const parentSession = join(env.dir, `persistent-parent-${id}.jsonl`);

			const surface = createTrackedSurface(env, `persistent-${id}`);
			await waitForPaneReady(surface);
			startPi(
				surface,
				env.dir,
				[
					"Call subagent with these EXACT parameters:",
					`  name: "${childName}"`,
					'  agent: "test-persistent"',
					'  task: "Return exactly SETTLED_ONE. Do not call subagent_done yet."',
					"Do not call any other tools.",
				].join("\n"),
				{ extraArgs: `--session ${shellQuote(parentSession)}` },
			);

			const readResults = (): IntegrationSessionEntry[] => {
				const lines = existsSync(parentSession)
					? readFileSync(parentSession, "utf8").split("\n").filter(Boolean)
					: [];
				return lines.flatMap((line) => {
					try {
						const entry = JSON.parse(line) as IntegrationSessionEntry;
						return entry.type === "custom_message" && entry.customType === "subagent_result" ? [entry] : [];
					} catch {
						return [];
					}
				});
			};
			const firstDeadline = Date.now() + PI_TIMEOUT;
			let firstResults = readResults();
			while (firstResults.length < 1 && Date.now() < firstDeadline) {
				await sleep(50);
				firstResults = readResults();
			}
			assert.equal(firstResults.length, 1, "first settled turn must be delivered once");
			assert.match(String(firstResults[0].details?.resultContent), /SETTLED_ONE/);
			const childSession = firstResults[0].details?.sessionFile;
			assert.equal(typeof childSession, "string", "settled result must identify the child session");
			if (typeof childSession !== "string") return;

			const childPane = await waitForAgentPane(childName, env.workspaceId);
			const secondPrompt = execFileSync(
				"herdr",
				["agent", "prompt", childPane, "Return exactly SETTLED_TWO. Do not call subagent_done yet."],
				{ encoding: "utf8" },
			);
			assert.ok(secondPrompt.trim(), "Herdr prompt command must acknowledge the second input");
			const secondDeadline = Date.now() + PI_TIMEOUT;
			let secondAnswerRecorded = false;
			while (!secondAnswerRecorded && Date.now() < secondDeadline) {
				secondAnswerRecorded = readSessionEntries(childSession).some((entry) =>
					entry.type === "message" &&
					entry.message?.role === "assistant" &&
					JSON.stringify(entry.message.content).includes("SETTLED_TWO"),
				);
				if (!secondAnswerRecorded) await sleep(50);
			}
			assert.equal(secondAnswerRecorded, true, "the direct child prompt must finish before checking suppression");
			await sleep(1_500);
			assert.equal(readResults().length, 1, "direct child input must suppress its later settled delivery");
			assert.ok(listWorkspacePanes(env.workspaceId).some((pane) => pane.label === childName), "persistent child must remain live after intervention");

			const closePrompt = execFileSync(
				"herdr",
				["agent", "prompt", childPane, "CLOSE_PERSISTENT_CHILD"],
				{ encoding: "utf8" },
			);
			assert.ok(closePrompt.trim(), "Herdr prompt command must acknowledge the close input");
			await waitForFile(`${childSession}.exit`, PI_TIMEOUT, /"type":"done"/);
			await waitForAgentGone(childPane, env.workspaceId);
			const finalDeadline = Date.now() + PI_TIMEOUT;
			let finalResults = readResults();
			while (finalResults.length < 2 && Date.now() < finalDeadline) {
				await sleep(50);
				finalResults = readResults();
			}
			assert.equal(finalResults.length, 2, "explicit completion must deliver once after intervention");
			assert.match(String(finalResults[0].details?.resultContent), /SETTLED_ONE/);
			assert.match(String(finalResults[1].details?.resultContent), /SETTLED_TWO/);
			assert.match(String(finalResults[1].details?.deliveryId), /^terminal:/);
		});

		it("delivers a settled provider error without ordered model fallback", async () => {
			const id = uniqueId();
			const parentSession = join(env.dir, `fallback-parent-${id}.jsonl`);
			const surface = createTrackedSurface(env, `fallback-${id}`);
			await waitForPaneReady(surface);
			startPi(
				surface,
				env.dir,
				[
					`Call subagent once with name: "Fallback-${id}".`,
					`agent: "test-echo".`,
					`model: "pi-integration/fallback-primary, pi-integration/fallback-secondary".`,
					`task: "Return exactly FALLBACK_ERROR_${id}".`,
				].join("\n"),
				{ extraArgs: `--session ${shellQuote(parentSession)}` },
			);

			await waitForFile(parentSession, PI_TIMEOUT, /"customType":"subagent_result"/);
			const result = readSettledResult(parentSession);
			assert.equal(result.kind, "settled");
			assert.equal(result.outcome, "error");
			assert.equal(
				getProviderRequests().some((request) => request.model === "fallback-secondary"),
				false,
			);
			assert.equal(typeof result.sessionFile, "string");
			if (typeof result.sessionFile === "string") assert.ok(existsSync(result.sessionFile));
		});

		it("reports a settled provider error when every configured model fails", async () => {
			const id = uniqueId();
			const parentSession = join(env.dir, `fallback-fail-parent-${id}.jsonl`);
			const surface = createTrackedSurface(env, `fallback-fail-${id}`);
			await waitForPaneReady(surface);
			startPi(
				surface,
				env.dir,
				[
					`Call subagent once with name: "FallbackFail-${id}".`,
					`agent: "test-echo".`,
					`model: "pi-integration/fallback-primary, pi-integration/fallback-fail".`,
					`task: "Return exactly SHOULD_NOT_COMPLETE".`,
				].join("\n"),
				{ extraArgs: `--session ${shellQuote(parentSession)}` },
			);
			await waitForFile(parentSession, PI_TIMEOUT, /"customType":"subagent_result"/);
			const result = readSettledResult(parentSession);
			assert.equal(result.kind, "settled");
			assert.equal(result.outcome, "error");
			const failedRequests = getProviderRequests().filter((request) =>
				request.model?.startsWith("fallback-"),
			);
			assert.deepEqual(
				[...new Set(failedRequests.map((request) => request.model))],
				["fallback-primary"],
			);
			assert.equal(failedRequests.every((request) => request.status === 503), true);
		});
	});
}
