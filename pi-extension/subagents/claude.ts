import { execFileSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { shellQuote } from "./terminal.ts";

const CLAUDE_SESSIONS_DIR = join(
	process.env.HOME ?? "/tmp",
	".pi",
	"agent",
	"sessions",
	"claude-code",
);

export interface ClaudeWorkspace {
	baseline?: Set<string>;
	cwd?: string;
}

export interface ClaudeLaunchParams {
	cwd: string;
	sentinelFile: string;
	pluginDir: string;
	model?: string;
	systemPrompt?: string;
	resumeSessionId?: string;
	task: string;
}

export interface ClaudeCompletionParams extends ClaudeWorkspace {
	sentinelFile: string;
	exitCode: number;
	readTerminal: () => string;
}

export interface ClaudeCompletion {
	summary: string;
	sessionId?: string;
}

export function requireClaudeAdapter(cli?: string): void {
	if (cli && cli !== "claude") {
		throw new Error(`Unsupported subagent CLI ${JSON.stringify(cli)}.`);
	}
}

export function captureClaudeWorkspaceBaseline(cwd: string): Set<string> | undefined {
	try {
		const output = execFileSync(
			"git",
			["status", "--porcelain=v1", "--untracked-files=all", "-z"],
			{ cwd, encoding: "utf8" },
		);
		return new Set(
			output
				.split("\0")
				.filter(Boolean)
				.map((entry) => entry.slice(3)),
		);
	} catch {
		return undefined;
	}
}

export function cleanupClaudeWorkspace({ baseline, cwd }: ClaudeWorkspace): string | undefined {
	if (!baseline || !cwd) return;

	try {
		const output = execFileSync(
			"git",
			["status", "--porcelain=v1", "--untracked-files=all", "-z"],
			{ cwd, encoding: "utf8" },
		);
		const changed = output
			.split("\0")
			.filter(Boolean)
			.map((entry) => ({ status: entry.slice(0, 2), path: entry.slice(3) }));
		const cleaned: string[] = [];

		for (const { status, path } of changed) {
			if (baseline.has(path) || path.startsWith(".reviews/")) continue;
			if (status === "??") {
				rmSync(join(cwd, path), { recursive: true, force: true });
			} else {
				execFileSync("git", ["restore", "--staged", "--worktree", "--", path], {
					cwd,
					stdio: "ignore",
				});
			}
			cleaned.push(path);
		}

		return cleaned.length > 0
			? `Claude workspace guard reverted newly introduced paths: ${cleaned.join(", ")}`
			: undefined;
	} catch (error: any) {
		return `Claude workspace guard failed: ${error?.message ?? String(error)}`;
	}
}

export function buildClaudeLaunchCommand(params: ClaudeLaunchParams): string {
	const parts = [
		`PI_CLAUDE_SENTINEL=${shellQuote(params.sentinelFile)}`,
		"claude",
		"--dangerously-skip-permissions",
	];
	if (existsSync(params.pluginDir)) {
		parts.push("--plugin-dir", shellQuote(params.pluginDir));
	}
	if (params.model) parts.push("--model", shellQuote(params.model));
	if (params.systemPrompt) {
		parts.push("--append-system-prompt", shellQuote(params.systemPrompt));
	}
	if (params.resumeSessionId) parts.push("--resume", shellQuote(params.resumeSessionId));
	parts.push(shellQuote(params.task));
	return `cd ${shellQuote(params.cwd)} && ${parts.join(" ")}; echo '__SUBAGENT_DONE_'$?'__'`;
}

function copyClaudeSession(sentinelFile: string): string | undefined {
	try {
		const transcriptFile = `${sentinelFile}.transcript`;
		if (!existsSync(transcriptFile)) return;
		const transcriptPath = readFileSync(transcriptFile, "utf-8").trim();
		if (!transcriptPath || !existsSync(transcriptPath)) return;
		mkdirSync(CLAUDE_SESSIONS_DIR, { recursive: true });
		const filename = transcriptPath.split("/").pop() ?? `claude-${Date.now()}.jsonl`;
		copyFileSync(transcriptPath, join(CLAUDE_SESSIONS_DIR, filename));
		return filename;
	} catch {
		return undefined;
	}
}

export function completeClaudeRun(params: ClaudeCompletionParams): ClaudeCompletion {
	const guardMessage = cleanupClaudeWorkspace(params);
	let summary = "";
	try {
		summary = readFileSync(params.sentinelFile, "utf-8").trim();
	} catch {}
	if (!summary) {
		summary = params.readTerminal().replace(/__SUBAGENT_DONE_\d+__/, "").trimEnd();
	}
	if (!summary) {
		summary =
		params.exitCode !== 0
			? `Claude Code exited with code ${params.exitCode}`
			: "Claude Code exited without output";
	}
	if (guardMessage) summary += `\n\n${guardMessage}`;

	const sessionId = copyClaudeSession(params.sentinelFile);
	for (const file of [params.sentinelFile, `${params.sentinelFile}.transcript`]) {
		try {
			unlinkSync(file);
		} catch {}
	}
	return { summary, ...(sessionId ? { sessionId } : {}) };
}
