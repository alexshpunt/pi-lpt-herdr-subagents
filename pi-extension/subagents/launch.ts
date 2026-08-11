import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { getSubagentActivityFile } from "./activity.ts";
import { createLifecycle, type SubagentLifecycle } from "./lifecycle.ts";
import type { ResolvedRuntimePlan } from "./runtime-routing.ts";
import { seedSubagentSessionFile } from "./session.ts";
import {
	createSubagentPane,
	createSubagentWorktree,
	runScriptInPane,
	shellQuote,
	waitForShellReady,
	type HerdrWorktreeSurface,
} from "./terminal.ts";

const SUBAGENT_CONTROL_TOOLS = ["caller_ping", "subagent_done"] as const;
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

type SubagentSessionMode = "standalone" | "lineage-only" | "fork";

export interface WorktreeLaunch {
	path: string;
	workspaceId: string;
	paneId: string;
	branch: string;
	baseRef: string;
	baseSha: string;
	manifestFile: string;
	sessionFile?: string;
}

export interface WorktreeHandoff extends WorktreeLaunch {
	headSha: string | null;
	commitsAhead: number | null;
	clean: boolean | null;
	conflicted: boolean | null;
	changedFiles: string[] | null;
	untrackedFiles: string[] | null;
	gitError?: string;
}

export interface FreshPiLaunchRequest {
	id?: string;
	name: string;
	task: string;
	agent?: string;
	cwd?: string;
	worktree?: { branch: string; base?: string };
	fork?: boolean;
	surface?: string;
	parent: {
		cwd: string;
		invocationCwd?: string;
		sessionFile: string;
		sessionId: string;
		sessionDir: string;
		agentDir?: string;
	};
	runtimePlan: ResolvedRuntimePlan;
	behavior: {
		tools?: string;
		skills?: string;
		deniedTools: readonly string[];
		autoExit: boolean;
		interactive: boolean;
		identity?: string;
		systemPromptMode?: "append" | "replace";
		sessionMode: SubagentSessionMode;
		cwd?: string;
	};
}

export interface FreshPiRunningChild {
	id: string;
	name: string;
	task: string;
	agent?: string;
	surface: string;
	startTime: number;
	sessionFile: string;
	launchScriptFile: string;
	activityFile: string;
	interactive: boolean;
	runtimePlan: ResolvedRuntimePlan;
	worktree?: WorktreeLaunch;
	lifecycle: SubagentLifecycle;
}

export interface FreshPiLaunchOperations {
	createPane(name: string): string;
	createWorktree(
		name: string,
		cwd: string,
		branch: string,
		base: string,
	): HerdrWorktreeSurface;
	waitForShellReady(surface: string): Promise<void>;
	runScript(
		surface: string,
		command: string,
		options: { scriptPath: string; scriptPreamble: string },
	): string;
}

const defaultOperations: FreshPiLaunchOperations = {
	createPane: createSubagentPane,
	createWorktree: createSubagentWorktree,
	waitForShellReady,
	runScript: runScriptInPane,
};

interface ResolvedLaunch {
	request: FreshPiLaunchRequest;
	id: string;
	startTime: number;
	agentDir: string;
	localAgentDir: string | null;
	sourceCwd: string;
	artifactDir: string;
	sessionMode: SubagentSessionMode;
	taskDelivery: "direct" | "artifact";
}

interface PreparedSurface {
	surface: string;
	targetCwd: string;
	effectiveAgentDir: string;
	localAgentDir: string | null;
	worktree?: WorktreeLaunch;
}

interface PreparedSession extends PreparedSurface {
	sessionFile: string;
	activityFile: string;
}

interface PreparedArtifacts extends PreparedSession {
	taskArg: string;
	systemPromptFile?: string;
}

/**
 * Launch one validated fresh Pi-backed request. Lifecycle watching and parent
 * delivery begin only after this transaction returns the running child.
 */
export async function launchFreshPiSubagent(
	request: FreshPiLaunchRequest,
	operations: FreshPiLaunchOperations = defaultOperations,
): Promise<FreshPiRunningChild> {
	const resolved = resolveLaunchRequest(request);
	const surface = prepareLaunchSurface(resolved, operations);

	try {
		const session = prepareChildSession(resolved, surface);
		await confirmShellReady(session, operations);
		const artifacts = prepareTaskArtifacts(resolved, session);
		const command = buildPiCommand(resolved, artifacts);
		const launchScriptFile = startPiProcess(
			resolved,
			artifacts,
			command,
			operations,
		);
		return createRunningChild(resolved, artifacts, launchScriptFile);
	} catch (error) {
		if (!surface.worktree) throw error;
		const handoff = captureWorktreeHandoff(surface.worktree);
		try {
			persistWorktreeResult(surface.worktree, "failed", handoff);
		} catch {
			// The launch error remains authoritative when persistence also fails.
		}
		throw new Error(
			`Failed to launch subagent; worktree retained at ${surface.worktree.path} ` +
				`(workspace ${surface.worktree.workspaceId}): ${errorMessage(error)}`,
		);
	}
}

function resolveLaunchRequest(request: FreshPiLaunchRequest): ResolvedLaunch {
	const id = request.id ?? Math.random().toString(16).slice(2, 10);
	const agentDir =
		request.parent.agentDir ??
		process.env.PI_CODING_AGENT_DIR ??
		join(homedir(), ".pi", "agent");
	const rawCwd = request.cwd ?? request.behavior.cwd;
	const cwdBase =
		request.cwd == null && request.behavior.cwd != null
			? agentDir
			: (request.parent.invocationCwd ?? request.parent.cwd);
	const sourceCwd = rawCwd
		? rawCwd.startsWith("/")
			? rawCwd
			: join(cwdBase, rawCwd)
		: request.parent.cwd;
	const localAgentDir = rawCwd ? join(sourceCwd, ".pi", "agent") : null;
	const sessionMode = request.fork ? "fork" : request.behavior.sessionMode;
	return {
		request,
		id,
		startTime: Date.now(),
		agentDir,
		localAgentDir:
			localAgentDir && existsSync(localAgentDir) ? localAgentDir : null,
		sourceCwd,
		artifactDir: join(
			request.parent.sessionDir,
			"artifacts",
			request.parent.sessionId,
		),
		sessionMode,
		taskDelivery: sessionMode === "fork" ? "direct" : "artifact",
	};
}

function prepareLaunchSurface(
	resolved: ResolvedLaunch,
	operations: FreshPiLaunchOperations,
): PreparedSurface {
	const { request } = resolved;
	if (!request.worktree) {
		return {
			surface: request.surface ?? operations.createPane(request.name),
			targetCwd: resolved.sourceCwd,
			effectiveAgentDir: resolved.localAgentDir ?? resolved.agentDir,
			localAgentDir: resolved.localAgentDir,
		};
	}
	if (request.surface)
		throw new Error("A worktree subagent cannot use a pre-created pane");

	const baseRef = request.worktree.base ?? "HEAD";
	const baseSha = resolveGitCommit(resolved.sourceCwd, baseRef);
	const manifestFile = join(
		resolved.artifactDir,
		"worktree-runs",
		`${resolved.id}.json`,
	);
	const ownership = {
		id: resolved.id,
		name: request.name,
		sourceCwd: resolved.sourceCwd,
		branch: request.worktree.branch,
		baseRef,
		baseSha,
		createdAt: resolved.startTime,
	};
	writeWorktreeManifest(manifestFile, {
		state: "provisioning",
		...ownership,
	});

	let created: HerdrWorktreeSurface;
	try {
		created = operations.createWorktree(
			request.name,
			resolved.sourceCwd,
			request.worktree.branch,
			baseSha,
		);
	} catch (error) {
		writeWorktreeManifest(manifestFile, {
			state: "failed",
			...ownership,
			error: errorMessage(error),
		});
		throw error;
	}

	const worktree: WorktreeLaunch = {
		path: created.path,
		workspaceId: created.workspaceId,
		paneId: created.paneId,
		branch: created.branch,
		baseRef,
		baseSha,
		manifestFile,
	};
	writeWorktreeManifest(manifestFile, {
		state: "provisioned",
		...ownership,
		...worktree,
	});
	const isolatedAgentDir = join(created.path, ".pi", "agent");
	const hasIsolatedAgentDir = existsSync(isolatedAgentDir);
	return {
		surface: created.paneId,
		targetCwd: created.path,
		effectiveAgentDir: hasIsolatedAgentDir
			? isolatedAgentDir
			: resolved.agentDir,
		localAgentDir: hasIsolatedAgentDir ? isolatedAgentDir : null,
		worktree,
	};
}

function prepareChildSession(
	resolved: ResolvedLaunch,
	surface: PreparedSurface,
): PreparedSession {
	const sessionDir = getDefaultSessionDirFor(
		surface.targetCwd,
		surface.effectiveAgentDir,
	);
	const timestamp = timestampForFile();
	const uuid = [
		resolved.id,
		Math.random().toString(16).slice(2, 10),
		Math.random().toString(16).slice(2, 10),
		Math.random().toString(16).slice(2, 6),
	].join("-");
	const sessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);
	if (surface.worktree) {
		surface.worktree.sessionFile = sessionFile;
		writeWorktreeManifest(surface.worktree.manifestFile, { sessionFile });
	}
	const activityFile = getSubagentActivityFile(
		resolved.artifactDir,
		resolved.id,
	);
	return { ...surface, sessionFile, activityFile };
}

async function confirmShellReady(
	session: PreparedSession,
	operations: FreshPiLaunchOperations,
): Promise<void> {
	await operations.waitForShellReady(session.surface);
}

function prepareTaskArtifacts(
	resolved: ResolvedLaunch,
	session: PreparedSession,
): PreparedArtifacts {
	const { request } = resolved;
	if (resolved.sessionMode !== "standalone") {
		seedSubagentSessionFile({
			mode: resolved.sessionMode,
			parentSessionFile: request.parent.sessionFile,
			childSessionFile: session.sessionFile,
			childCwd: session.targetCwd,
		});
	}
	mkdirSync(dirname(session.activityFile), { recursive: true });

	const identityInSystemPrompt =
		request.behavior.systemPromptMode && request.behavior.identity;
	const roleBlock =
		request.behavior.identity && !identityInSystemPrompt
			? `\n\n${request.behavior.identity}`
			: "";
	const modeHint = request.behavior.autoExit
		? "Complete your task autonomously."
		: "Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.";
	const summaryInstruction = request.behavior.autoExit
		? "Your FINAL assistant message should summarize what you accomplished."
		: "Your FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished.";
	const fullTask =
		resolved.sessionMode === "fork"
			? request.task
			: `${roleBlock}\n\n${modeHint}\n\n${request.task}\n\n${summaryInstruction}`;
	let taskArg = fullTask;
	if (resolved.taskDelivery === "artifact") {
		const artifactPath = join(
			resolved.artifactDir,
			`context/${safeName(request.name) || "subagent"}-${timestampForFile(false)}.md`,
		);
		mkdirSync(dirname(artifactPath), { recursive: true });
		writeFileSync(artifactPath, fullTask, "utf8");
		taskArg = `@${artifactPath}`;
	}

	let systemPromptFile: string | undefined;
	if (identityInSystemPrompt) {
		systemPromptFile = join(
			resolved.artifactDir,
			`context/${safeName(request.name) || "subagent"}-sysprompt-${timestampForFile(false)}.md`,
		);
		mkdirSync(dirname(systemPromptFile), { recursive: true });
		writeFileSync(systemPromptFile, identityInSystemPrompt, "utf8");
	}
	return { ...session, taskArg, systemPromptFile };
}

function buildPiCommand(
	resolved: ResolvedLaunch,
	artifacts: PreparedArtifacts,
): string {
	const { request } = resolved;
	const parts = [
		"pi",
		"--session",
		shellQuote(artifacts.sessionFile),
		"-e",
		shellQuote(join(SUBAGENTS_DIR, "subagent-done.ts")),
		"--model",
		shellQuote(request.runtimePlan.model),
		"--thinking",
		shellQuote(request.runtimePlan.thinking),
	];
	if (artifacts.systemPromptFile) {
		parts.push(
			request.behavior.systemPromptMode === "replace"
				? "--system-prompt"
				: "--append-system-prompt",
			shellQuote(artifacts.systemPromptFile),
		);
	}
	const toolAllowlist = buildToolAllowlist(request.behavior.tools);
	if (toolAllowlist) parts.push("--tools", shellQuote(toolAllowlist));
	for (const prompt of buildPromptArgs(
		request.behavior.skills,
		resolved.taskDelivery,
		artifacts.taskArg,
	)) {
		parts.push(shellQuote(prompt));
	}

	const env: string[] = [];
	if (artifacts.localAgentDir) {
		env.push(`PI_CODING_AGENT_DIR=${shellQuote(artifacts.localAgentDir)}`);
	} else if (process.env.PI_CODING_AGENT_DIR) {
		env.push(
			`PI_CODING_AGENT_DIR=${shellQuote(process.env.PI_CODING_AGENT_DIR)}`,
		);
	}
	if (request.behavior.deniedTools.length > 0) {
		env.push(
			`PI_DENY_TOOLS=${shellQuote(request.behavior.deniedTools.join(","))}`,
		);
	}
	env.push(`PI_SUBAGENT_NAME=${shellQuote(request.name)}`);
	if (request.agent)
		env.push(`PI_SUBAGENT_AGENT=${shellQuote(request.agent)}`);
	if (request.behavior.autoExit) env.push("PI_SUBAGENT_AUTO_EXIT=1");
	env.push(`PI_SUBAGENT_SESSION=${shellQuote(artifacts.sessionFile)}`);
	env.push(`PI_SUBAGENT_ID=${shellQuote(resolved.id)}`);
	env.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellQuote(artifacts.activityFile)}`);
	env.push(`PI_SUBAGENT_SURFACE=${shellQuote(artifacts.surface)}`);

	const piCommand =
		`cd ${shellQuote(artifacts.targetCwd)} && ` +
		`${env.join(" ")} ${parts.join(" ")}`;
	return `${piCommand}; echo '__SUBAGENT_DONE_'$?'__'`;
}

function startPiProcess(
	resolved: ResolvedLaunch,
	artifacts: PreparedArtifacts,
	command: string,
	operations: FreshPiLaunchOperations,
): string {
	const launchScriptFile = join(
		resolved.artifactDir,
		"subagent-scripts",
		`${safeName(resolved.request.name) || "subagent"}-${resolved.id}.sh`,
	);
	if (artifacts.worktree)
		persistWorktreeResult(artifacts.worktree, "running");
	return operations.runScript(artifacts.surface, command, {
		scriptPath: launchScriptFile,
		scriptPreamble: [
			`# Subagent launch script for ${resolved.request.name}`,
			`# Generated: ${new Date().toISOString()}`,
			`# Session: ${artifacts.sessionFile}`,
			`# Surface: ${artifacts.surface}`,
		].join("\n"),
	});
}

function createRunningChild(
	resolved: ResolvedLaunch,
	artifacts: PreparedArtifacts,
	launchScriptFile: string,
): FreshPiRunningChild {
	return {
		id: resolved.id,
		name: resolved.request.name,
		task: resolved.request.task,
		agent: resolved.request.agent,
		surface: artifacts.surface,
		startTime: resolved.startTime,
		sessionFile: artifacts.sessionFile,
		launchScriptFile,
		activityFile: artifacts.activityFile,
		interactive: resolved.request.behavior.interactive,
		runtimePlan: resolved.request.runtimePlan,
		worktree: artifacts.worktree,
		lifecycle: createLifecycle(resolved.startTime),
	};
}

function buildToolAllowlist(tools?: string): string | null {
	const requested = (tools ?? "")
		.split(",")
		.map((tool) => tool.trim())
		.filter(Boolean);
	if (requested.length === 0) return null;
	const allow = new Set(requested);
	for (const tool of SUBAGENT_CONTROL_TOOLS) allow.add(tool);
	return [...allow].join(",");
}

function buildPromptArgs(
	skills: string | undefined,
	taskDelivery: "direct" | "artifact",
	taskArg: string,
): string[] {
	const skillPrompts = (skills ?? "")
		.split(",")
		.map((skill) => skill.trim())
		.filter(Boolean)
		.map((skill) => `/skill:${skill}`);
	return [
		...(taskDelivery === "artifact" && skillPrompts.length > 0 ? [""] : []),
		...skillPrompts,
		taskArg,
	];
}

function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	const sessionDir = join(agentDir, "sessions", safePath);
	mkdirSync(sessionDir, { recursive: true });
	return sessionDir;
}

function timestampForFile(includeMilliseconds = true): string {
	return new Date()
		.toISOString()
		.replace(/[:.]/g, "-")
		.slice(0, includeMilliseconds ? 23 : 19) +
		(includeMilliseconds ? "Z" : "");
}

function safeName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

function resolveGitCommit(cwd: string, ref: string): string {
	return execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
		cwd,
		encoding: "utf8",
	}).trim();
}

export function writeWorktreeManifest(
	path: string,
	value: Record<string, unknown>,
): void {
	mkdirSync(dirname(path), { recursive: true });
	let existing: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			existing = JSON.parse(readFileSync(path, "utf8"));
		} catch {
			existing = {};
		}
	}
	const tempPath = `${path}.tmp`;
	writeFileSync(
		tempPath,
		`${JSON.stringify(
			{
				...existing,
				...value,
				version: 1,
				kind: "worktree-run",
				owner: "pi-herdr-subagents",
				updatedAt: Date.now(),
			},
			null,
			2,
		)}\n`,
	);
	renameSync(tempPath, path);
}

function gitPathList(cwd: string, args: string[]): string[] {
	return execFileSync("git", args, { cwd, encoding: "utf8" })
		.split("\0")
		.filter(Boolean);
}

export function captureWorktreeHandoff(
	worktree: WorktreeLaunch,
): WorktreeHandoff {
	try {
		const headSha = resolveGitCommit(worktree.path, "HEAD");
		const status = execFileSync(
			"git",
			["status", "--porcelain=v1", "--untracked-files=all", "-z"],
			{ cwd: worktree.path, encoding: "utf8" },
		);
		const untrackedFiles = gitPathList(worktree.path, [
			"ls-files",
			"--others",
			"--exclude-standard",
			"-z",
		]);
		const conflictedFiles = gitPathList(worktree.path, [
			"diff",
			"--name-only",
			"--diff-filter=U",
			"-z",
		]);
		const changedFiles = new Set([
			...gitPathList(worktree.path, [
				"diff",
				"--name-only",
				"-z",
				`${worktree.baseSha}...HEAD`,
			]),
			...gitPathList(worktree.path, ["diff", "--name-only", "-z"]),
			...gitPathList(worktree.path, [
				"diff",
				"--cached",
				"--name-only",
				"-z",
			]),
			...untrackedFiles,
		]);
		const commitsAhead = Number.parseInt(
			execFileSync(
				"git",
				["rev-list", "--count", `${worktree.baseSha}..HEAD`],
				{ cwd: worktree.path, encoding: "utf8" },
			).trim(),
			10,
		);
		return {
			...worktree,
			headSha,
			commitsAhead: Number.isFinite(commitsAhead) ? commitsAhead : 0,
			clean: status.length === 0,
			conflicted: conflictedFiles.length > 0,
			changedFiles: [...changedFiles].sort(),
			untrackedFiles: untrackedFiles.sort(),
		};
	} catch (error) {
		return {
			...worktree,
			headSha: null,
			commitsAhead: null,
			clean: null,
			conflicted: null,
			changedFiles: null,
			untrackedFiles: null,
			gitError: errorMessage(error),
		};
	}
}

export function persistWorktreeResult(
	worktree: WorktreeLaunch,
	state: "running" | "ready_for_review" | "failed" | "needs_help",
	handoff?: WorktreeHandoff,
): void {
	writeWorktreeManifest(worktree.manifestFile, {
		state,
		...worktree,
		...handoff,
	});
}

export function runSubagentScript(
	surface: string,
	command: string,
	options: Parameters<typeof runScriptInPane>[2],
	worktree?: WorktreeLaunch,
	run: typeof runScriptInPane = runScriptInPane,
): string {
	if (worktree) persistWorktreeResult(worktree, "running");
	try {
		return run(surface, command, options);
	} catch (error) {
		if (!worktree) throw error;
		const handoff = captureWorktreeHandoff(worktree);
		try {
			persistWorktreeResult(worktree, "failed", handoff);
		} catch {
			// The launch error remains authoritative when persistence also fails.
		}
		throw new Error(
			`Failed to launch subagent; worktree retained at ${worktree.path} ` +
				`(workspace ${worktree.workspaceId}): ${errorMessage(error)}`,
		);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
