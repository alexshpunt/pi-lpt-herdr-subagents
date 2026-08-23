import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	launchPiSubagent,
	type FreshPiLaunchRequest,
	type PiLaunchOperations,
	type ResumePiLaunchRequest,
} from "../pi-extension/subagents/launch.ts";
import { readEntriesAfterBaseline } from "../pi-extension/subagents/session.ts";

function entry(id: string, role: "user" | "assistant", text: string) {
	return {
		type: "message",
		id,
		message: {
			role,
			content: [{ type: "text", text }],
			...(role === "assistant" ? { stopReason: "stop" } : {}),
		},
	};
}

function writeSession(file: string, entries: unknown[]) {
	writeFileSync(file, `${entries.map((value) => JSON.stringify(value)).join("\n")}\n`);
}

describe("settled launch baseline", () => {
	it("captures fork history before a fast child appends its first response", async () => {
		const root = mkdtempSync(join(tmpdir(), "settled-launch-test-"));
		try {
			const project = join(root, "project");
			const sessionDir = join(root, "sessions");
			const parentFile = join(sessionDir, "parent.jsonl");
			mkdirSync(project, { recursive: true });
			mkdirSync(sessionDir, { recursive: true });
			writeSession(parentFile, [
				{ type: "session", id: "parent" },
				entry("old-user", "user", "old task"),
				entry("old-assistant", "assistant", "inherited answer"),
				entry("branch-user", "user", "start child"),
			]);
			const request: FreshPiLaunchRequest = {
				kind: "fresh",
				id: "child-fast",
				name: "Fast child",
				task: "Return immediately.",
				fork: true,
				parent: {
					cwd: project,
					sessionFile: parentFile,
					sessionId: "parent",
					sessionDir,
				},
				runtimePlan: {
					provider: "fake",
					modelId: "worker",
					model: "fake/worker",
					thinking: "off",
					modelSource: "request",
					thinkingSource: "request",
				},
				behavior: {
					deniedTools: [],
					autoExit: true,
					interactive: false,
					sessionMode: "standalone",
				},
			};
			let childSessionFile = "";
			const operations: PiLaunchOperations = {
				createPane: () => "pane-fast",
				createWorktree: () => {
					throw new Error("unexpected worktree");
				},
				waitForShellReady: async () => {},
				runScript: (_surface, command, options) => {
					childSessionFile = command.match(/--session '([^']+)'/)?.[1] ?? "";
					assert.ok(childSessionFile);
					appendFileSync(
						childSessionFile,
						`${JSON.stringify(entry("fast-assistant", "assistant", "fast answer"))}\n`,
					);
					return options.scriptPath;
				},
			};

			const running = await launchPiSubagent(request, operations);
			assert.equal(running.sessionBaseline.assistantEntryIds[0], "old-assistant");
			assert.equal(running.sessionBaseline.assistantEntryIds.length, 1);
			const appended = readEntriesAfterBaseline(
				childSessionFile,
				running.sessionBaseline,
			);
			assert.equal(appended.entries.at(-1)?.id, "fast-assistant");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("captures resume history before the resumed process starts", async () => {
		const root = mkdtempSync(join(tmpdir(), "settled-resume-test-"));
		try {
			const sessionDir = join(root, "sessions");
			const sessionFile = join(root, "resume.jsonl");
			mkdirSync(sessionDir, { recursive: true });
			writeSession(sessionFile, [
				{ type: "session", id: "resume" },
				entry("old-assistant", "assistant", "previous turn"),
			]);
			const request: ResumePiLaunchRequest = {
				kind: "resume",
				id: "resume-child",
				name: "Resume child",
				sessionFile,
				message: "Continue now.",
				parent: { sessionId: "parent", sessionDir },
			};
			const operations: PiLaunchOperations = {
				createPane: () => "pane-resume",
				createWorktree: () => {
					throw new Error("unexpected worktree");
				},
				waitForShellReady: async () => {},
				runScript: (_surface, _command, options) => {
					appendFileSync(
						sessionFile,
						`${JSON.stringify(entry("new-assistant", "assistant", "new turn"))}\n`,
					);
					return options.scriptPath;
				},
			};
			const running = await launchPiSubagent(request, operations);
			assert.deepEqual(running.sessionBaseline.assistantEntryIds, ["old-assistant"]);
			assert.equal(
				readEntriesAfterBaseline(sessionFile, running.sessionBaseline).entries.at(-1)?.id,
				"new-assistant",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
