import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
	launchFreshPiSubagent,
	type FreshPiLaunchOperations,
	type FreshPiLaunchRequest,
} from "../pi-extension/subagents/launch.ts";

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "subagent-launch-test-"));
	const project = join(root, "project");
	const agentDir = join(root, "agent");
	const sessionDir = join(root, "parent-sessions");
	const parentSessionFile = join(sessionDir, "parent.jsonl");
	mkdirSync(project, { recursive: true });
	mkdirSync(sessionDir, { recursive: true });
	writeFileSync(
		parentSessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "parent", cwd: project })}\n`,
	);

	const request: FreshPiLaunchRequest = {
		id: "child-1",
		name: "Worker",
		task: "Implement the bounded change.",
		agent: "worker",
		parent: {
			cwd: project,
			sessionFile: parentSessionFile,
			sessionId: "parent",
			sessionDir,
			agentDir,
		},
		runtimePlan: {
			provider: "fake",
			modelId: "worker",
			model: "fake/worker",
			thinking: "high",
			modelSource: "request",
			thinkingSource: "request",
		},
		behavior: {
			tools: "read,bash",
			skills: "tdd",
			deniedTools: ["subagent", "subagent_resume"],
			autoExit: true,
			interactive: false,
			identity: "You are a focused worker.",
			systemPromptMode: "append",
			sessionMode: "standalone",
		},
	};
	return { root, project, agentDir, sessionDir, request };
}

function withFixture(
	run: (value: ReturnType<typeof fixture>) => Promise<void> | void,
) {
	const value = fixture();
	return Promise.resolve(run(value)).finally(() => {
		rmSync(value.root, { recursive: true, force: true });
	});
}

describe("fresh Pi launch", () => {
	it("launches an ordinary child through one transaction", async () => {
		await withFixture(async ({ request, project, agentDir }) => {
			const projectAgentDir = join(project, ".pi", "agent");
			mkdirSync(projectAgentDir, { recursive: true });
			const events: string[] = [];
			let command = "";
			let scriptPath = "";
			const operations: FreshPiLaunchOperations = {
				createPane(name) {
					assert.equal(name, "Worker");
					events.push("create");
					return "pane-1";
				},
				createWorktree() {
					throw new Error("unexpected worktree creation");
				},
				async waitForShellReady(surface) {
					assert.equal(surface, "pane-1");
					events.push("ready");
				},
				runScript(surface, value, options) {
					assert.equal(surface, "pane-1");
					events.push("run");
					command = value;
					scriptPath = options.scriptPath;
					return options.scriptPath;
				},
			};

			const running = await launchFreshPiSubagent(request, operations);

			assert.deepEqual(events, ["create", "ready", "run"]);
			assert.equal(running.id, "child-1");
			assert.equal(running.surface, "pane-1");
			assert.equal(running.launchScriptFile, scriptPath);
			assert.ok(running.sessionFile.startsWith(join(agentDir, "sessions")));
			assert.equal(command.includes(projectAgentDir), false);
			assert.match(command, new RegExp(`^cd '${project}' && `));
			assert.match(command, /--model 'fake\/worker'/);
			assert.match(command, /--thinking 'high'/);
			assert.match(
				command,
				/--tools 'read,bash,caller_ping,subagent_done'/,
			);
			assert.match(command, /PI_DENY_TOOLS='subagent,subagent_resume'/);
			assert.match(command, /PI_SUBAGENT_AUTO_EXIT=1/);
			assert.match(command, /'' '\/skill:tdd' '@[^']+\.md'/);

			const taskPath = command.match(/'@([^']+\.md)'/)?.[1];
			assert.ok(taskPath, "expected artifact-backed task delivery");
			assert.match(
				readFileSync(taskPath, "utf8"),
				/Complete your task autonomously\.[\s\S]*Implement the bounded change\./,
			);
			const systemPromptPath = command.match(
				/--append-system-prompt '([^']+\.md)'/,
			)?.[1];
			assert.ok(systemPromptPath, "expected system prompt artifact");
			assert.equal(
				readFileSync(systemPromptPath, "utf8"),
				"You are a focused worker.",
			);
		});
	});

	it("records worktree ownership before creation and targets its root pane", async () => {
		await withFixture(async ({ request, project, sessionDir, root }) => {
			execFileSync("git", ["init", "-q"], { cwd: project });
			execFileSync("git", ["config", "user.email", "test@example.com"], {
				cwd: project,
			});
			execFileSync("git", ["config", "user.name", "Test"], { cwd: project });
			writeFileSync(join(project, "base.txt"), "base\n");
			execFileSync("git", ["add", "base.txt"], { cwd: project });
			execFileSync("git", ["commit", "-qm", "base"], { cwd: project });
			const baseSha = execFileSync("git", ["rev-parse", "HEAD"], {
				cwd: project,
				encoding: "utf8",
			}).trim();
			const worktreePath = join(root, "worker-tree");
			const worktreeRequest: FreshPiLaunchRequest = {
				...request,
				worktree: { branch: "issue/7", base: "HEAD" },
			};
			const manifestFile = join(
				sessionDir,
				"artifacts",
				"parent",
				"worktree-runs",
				"child-1.json",
			);
			const events: string[] = [];
			let command = "";
			const operations: FreshPiLaunchOperations = {
				createPane() {
					throw new Error("unexpected pane creation");
				},
				createWorktree(name, cwd, branch, base) {
					assert.equal(name, "Worker");
					assert.equal(cwd, project);
					assert.equal(branch, "issue/7");
					assert.equal(base, baseSha);
					assert.equal(JSON.parse(readFileSync(manifestFile, "utf8")).state, "provisioning");
					events.push("create");
					execFileSync("git", ["worktree", "add", "-q", "-b", branch, worktreePath, base], {
						cwd: project,
					});
					return {
						path: worktreePath,
						branch,
						workspaceId: "workspace-1",
						paneId: "root-pane-1",
					};
				},
				async waitForShellReady(surface) {
					assert.equal(surface, "root-pane-1");
					events.push("ready");
				},
				runScript(surface, value, options) {
					assert.equal(surface, "root-pane-1");
					events.push("run");
					command = value;
					return options.scriptPath;
				},
			};

			const running = await launchFreshPiSubagent(worktreeRequest, operations);

			assert.deepEqual(events, ["create", "ready", "run"]);
			assert.equal(running.worktree?.baseSha, baseSha);
			assert.equal(running.worktree?.path, worktreePath);
			assert.equal(running.worktree?.sessionFile, running.sessionFile);
			assert.match(command, new RegExp(`^cd '${worktreePath}' && `));
			const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
			assert.equal(manifest.state, "running");
			assert.equal(manifest.owner, "pi-herdr-subagents");
			assert.equal(manifest.paneId, "root-pane-1");
		});
	});

	it("retains an explicit failed worktree handoff when process start fails", async () => {
		await withFixture(async ({ request, project, sessionDir, root }) => {
			execFileSync("git", ["init", "-q"], { cwd: project });
			execFileSync("git", ["config", "user.email", "test@example.com"], {
				cwd: project,
			});
			execFileSync("git", ["config", "user.name", "Test"], { cwd: project });
			writeFileSync(join(project, "base.txt"), "base\n");
			execFileSync("git", ["add", "base.txt"], { cwd: project });
			execFileSync("git", ["commit", "-qm", "base"], { cwd: project });
			const worktreePath = join(root, "failed-tree");
			const manifestFile = join(
				sessionDir,
				"artifacts",
				"parent",
				"worktree-runs",
				"child-1.json",
			);
			const operations: FreshPiLaunchOperations = {
				createPane() {
					throw new Error("unexpected pane creation");
				},
				createWorktree(_name, cwd, branch, base) {
					execFileSync("git", ["worktree", "add", "-q", "-b", branch, worktreePath, base], {
						cwd,
					});
					return {
						path: worktreePath,
						branch,
						workspaceId: "workspace-failed",
						paneId: "root-pane-failed",
					};
				},
				async waitForShellReady() {},
				runScript() {
					throw new Error("pane rejected command");
				},
			};

			await assert.rejects(
				launchFreshPiSubagent(
					{ ...request, worktree: { branch: "issue/7-failed" } },
					operations,
				),
				/worktree retained.*pane rejected command/i,
			);
			const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
			assert.equal(manifest.state, "failed");
			assert.equal(manifest.path, worktreePath);
			assert.equal(manifest.clean, true);
		});
	});
});
