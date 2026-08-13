import { execFile, execSync, execFileSync } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const commandAvailability = new Map<string, boolean>();

function hasCommand(command: string): boolean {
  if (commandAvailability.has(command)) {
    return commandAvailability.get(command)!;
  }

  let available = false;
  if (process.platform === "win32") {
    try {
      execFileSync("where.exe", [command], { stdio: "ignore" });
      available = true;
    } catch {
      try {
        execSync(`command -v ${command}`, { stdio: "ignore" });
        available = true;
      } catch {
        available = false;
      }
    }
  } else {
    try {
      execSync(`command -v ${command}`, { stdio: "ignore" });
      available = true;
    } catch {
      available = false;
    }
  }

  commandAvailability.set(command, available);
  return available;
}

export function isHerdrAvailable(): boolean {
  return process.env.HERDR_ENV === "1" && hasCommand("herdr");
}

function parseHerdrJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractHerdrPaneId(output: string, context: string): string {
  const parsed = parseHerdrJson(output);
	const paneId = (parsed as { result?: { pane?: { pane_id?: unknown } } })
		?.result?.pane?.pane_id;
  if (typeof paneId !== "string" || !paneId) {
		throw new Error(
			`Unexpected herdr ${context} output: ${output.trim() || "(empty)"}`,
		);
  }
  return paneId;
}

function extractHerdrRootPaneId(output: string, context: string): string {
  const parsed = parseHerdrJson(output);
	const paneId = (parsed as { result?: { root_pane?: { pane_id?: unknown } } })
		?.result?.root_pane?.pane_id;
  if (typeof paneId !== "string" || !paneId) {
		throw new Error(
			`Unexpected herdr ${context} output: ${output.trim() || "(empty)"}`,
		);
  }
  return paneId;
}

export interface HerdrWorktreeSurface {
  path: string;
  branch: string;
  workspaceId: string;
  paneId: string;
}

function extractHerdrWorktree(output: string): HerdrWorktreeSurface {
  const parsed = parseHerdrJson(output) as {
    result?: {
      type?: unknown;
      workspace?: { workspace_id?: unknown };
      root_pane?: { pane_id?: unknown };
      worktree?: { path?: unknown; branch?: unknown };
    };
  } | null;
  const result = parsed?.result;
  if (
    result?.type !== "worktree_created" ||
    typeof result.workspace?.workspace_id !== "string" ||
    !result.workspace.workspace_id ||
    typeof result.root_pane?.pane_id !== "string" ||
    !result.root_pane.pane_id ||
    typeof result.worktree?.path !== "string" ||
    !result.worktree.path ||
    typeof result.worktree.branch !== "string" ||
    !result.worktree.branch
  ) {
		throw new Error(
			`Unexpected herdr worktree create output: ${output.trim() || "(empty)"}`,
		);
  }
  return {
    path: result.worktree.path,
    branch: result.worktree.branch,
    workspaceId: result.workspace.workspace_id,
    paneId: result.root_pane.pane_id,
  };
}

function herdrExec(args: string[]): string {
  return execFileSync("herdr", args, { encoding: "utf8" });
}

async function herdrExecAsync(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("herdr", args, { encoding: "utf8" });
  return stdout;
}

function getHerdrParentPaneId(): string {
  const paneId = process.env.HERDR_PANE_ID;
  if (!paneId) {
    throw new Error("HERDR_PANE_ID not set");
  }
  return paneId;
}

function buildCurrentPaneArgs(): string[] {
	return ["pane", "current", "--current"];
}

function getHerdrCurrentPaneInfo(): {
  pane_id: string;
  tab_id: string;
  workspace_id: string;
} {
  const paneId = process.env.HERDR_PANE_ID;
  const tabId = process.env.HERDR_TAB_ID;
  const workspaceId = process.env.HERDR_WORKSPACE_ID;

  // Fall back to `herdr pane current` if any identity env var is missing —
  // older herdr versions may not set all three.
  if (!paneId || !tabId || !workspaceId) {
    const output = herdrExec(buildCurrentPaneArgs());
    const parsed = parseHerdrJson(output);
		const pane = (parsed as { result?: { pane?: unknown } } | null)?.result
			?.pane as
      | { pane_id?: string; tab_id?: string; workspace_id?: string }
      | undefined;
    if (!pane?.pane_id || !pane?.tab_id || !pane?.workspace_id) {
			throw new Error(
				`Unexpected herdr pane current output: ${output.trim() || "(empty)"}`,
			);
    }
    return {
      pane_id: pane.pane_id,
      tab_id: pane.tab_id,
      workspace_id: pane.workspace_id,
    };
  }

  return { pane_id: paneId, tab_id: tabId, workspace_id: workspaceId };
}

function buildTabCreateArgs(
	name: string,
	cwd: string,
	workspaceId: string,
): string[] {
  return [
    "tab",
    "create",
    "--workspace",
    workspaceId,
    "--label",
    name,
    "--cwd",
    cwd,
    "--no-focus",
  ];
}

function buildWorktreeCreateArgs(
  name: string,
  cwd: string,
  branch: string,
  base: string,
): string[] {
  return [
    "worktree",
    "create",
    "--cwd",
    cwd,
    "--branch",
    branch,
    "--base",
    base,
    "--label",
    name,
    "--no-focus",
  ];
}

export function createHerdrSurface(name: string): string {
  // Create a new tab per subagent so parallel spawns each get a full tab
  // instead of ever-narrower splits of the parent pane. Target the current
  // workspace explicitly because Herdr's implicit default may be another space.
  const { workspace_id: workspaceId } = getHerdrCurrentPaneInfo();
	const output = herdrExec(
		buildTabCreateArgs(name, process.cwd(), workspaceId),
	);
  const paneId = extractHerdrRootPaneId(output, "tab create");
  try {
    herdrExec(["pane", "rename", paneId, name]);
  } catch {
    // Optional — pane label is cosmetic.
  }
  return paneId;
}

export function createHerdrWorktree(
  name: string,
  cwd: string,
  branch: string,
  base: string,
): HerdrWorktreeSurface {
  const output = herdrExec(buildWorktreeCreateArgs(name, cwd, branch, base));
  return extractHerdrWorktree(output);
}

export function createHerdrSurfaceSplit(
  name: string,
  direction: "right" | "down",
): string {
  const parentPaneId = getHerdrParentPaneId();
  const output = herdrExec([
    "pane",
    "split",
    parentPaneId,
    "--direction",
    direction,
    "--no-focus",
    "--cwd",
    process.cwd(),
  ]);
  const paneId = extractHerdrPaneId(output, "pane split");
  try {
    herdrExec(["pane", "rename", paneId, name]);
  } catch {
    // Optional.
  }
  return paneId;
}

export function readHerdrScreen(surface: string, lines = 50): string {
  // `visible` is reliable for freshly created panes where herdr's `recent`
  // scrollback may not be populated yet.
	return herdrExec([
		"pane",
		"read",
		surface,
		"--source",
		"visible",
		"--lines",
		String(lines),
	]);
}

export async function readHerdrScreenAsync(
	surface: string,
	lines = 50,
): Promise<string> {
	return herdrExecAsync([
		"pane",
		"read",
		surface,
		"--source",
		"visible",
		"--lines",
		String(lines),
	]);
}

export type { PaneInspection, HerdrAgentStatus } from "./lifecycle.ts";

type PaneInspectionResult =
	| {
			kind: "present";
			agent?: string;
			agentStatus: "idle" | "working" | "blocked" | "done" | "unknown";
	  }
  | { kind: "missing"; error?: string }
  | { kind: "unavailable"; error: string };

function parsePaneGetOutput(
	output: string,
	surface: string,
): PaneInspectionResult {
	const parsed = parseHerdrJson(output) as {
		result?: { pane?: unknown };
		error?: { code?: unknown; message?: unknown };
	} | null;
  const errorObj = parsed?.error;
  if (errorObj?.code === "pane_not_found" || errorObj?.code === "not_found") {
		return {
			kind: "missing",
			error:
				typeof errorObj.message === "string"
					? errorObj.message
					: "pane not found",
		};
  }
  const pane = parsed?.result?.pane;
	if (!pane || typeof pane !== "object")
		return { kind: "unavailable", error: "pane get returned no pane record" };
	const record = pane as {
		pane_id?: unknown;
		agent?: unknown;
		agent_status?: unknown;
	};
	if (record.pane_id !== surface)
		return { kind: "unavailable", error: "pane id mismatch" };
  const agent = typeof record.agent === "string" ? record.agent : undefined;
	const rawStatus =
		typeof record.agent_status === "string" ? record.agent_status : "unknown";
	const agentStatus =
		rawStatus === "idle" ||
      rawStatus === "working" ||
      rawStatus === "blocked" ||
      rawStatus === "done" ||
      rawStatus === "unknown"
    ? rawStatus
    : "unknown";
  return { kind: "present", ...(agent ? { agent } : {}), agentStatus };
}

function parsePaneGetError(error: any): PaneInspectionResult {
  for (const raw of [error?.stderr, error?.stdout]) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    try {
      const parsed = parsePaneGetOutput(raw, "");
      if (parsed.kind === "missing") return parsed;
    } catch {
      // A CLI may emit plain diagnostics on one stream and structured JSON on
      // the other. Parse each stream independently before giving up.
    }
    // Older/alternate Herdr builds may print the stable error code as plain
    // text rather than JSON. Only match explicit identifiers, not generic
    // prose such as "pane unavailable".
    if (/\b(?:pane_not_found|not_found)\b/.test(raw)) {
      return { kind: "missing", error: raw.trim() };
    }
  }
	const message = error?.message
		? String(error.message)
		: "herdr pane get failed";
  return { kind: "unavailable", error: message };
}

/**
 * Structured pane query.
 * - present: pane is reachable; agent/agentStatus may be present when detected
 * - missing: server responded, pane is gone
 * - unavailable: server command failed; caller should keep polling
 */
export async function inspectHerdrPane(
	surface: string,
): Promise<PaneInspectionResult> {
  try {
		return parsePaneGetOutput(
			await herdrExecAsync(["pane", "get", surface]),
			surface,
		);
  } catch (error: any) {
    return parsePaneGetError(error);
  }
}

export interface HerdrPaneProcessInfo {
	paneId: string;
	shellPid?: number;
	foregroundProcessGroupId?: number;
	pids: number[];
}

export function parsePaneProcessInfo(
	output: string,
	paneId: string,
): HerdrPaneProcessInfo {
	const parsed = parseHerdrJson(output) as {
		result?: {
			process_info?: {
				pane_id?: unknown;
				shell_pid?: unknown;
				foreground_process_group_id?: unknown;
				foreground_processes?: Array<{ pid?: unknown }>;
			};
		};
	} | null;
	const info = parsed?.result?.process_info;
	if (!info || typeof info !== "object") {
		throw new Error(
			`Unexpected herdr pane process-info output: ${output.trim() || "(empty)"}`,
		);
	}
	if (typeof info.pane_id === "string" && info.pane_id !== paneId) {
		throw new Error(
			`herdr pane process-info pane id mismatch: ${info.pane_id} != ${paneId}`,
		);
	}
	const pids = new Set<number>();
	if (
		typeof info.shell_pid === "number" &&
		Number.isInteger(info.shell_pid) &&
		info.shell_pid > 0
	) {
		pids.add(info.shell_pid);
	}
	if (
		typeof info.foreground_process_group_id === "number" &&
		Number.isInteger(info.foreground_process_group_id) &&
		info.foreground_process_group_id > 0
	) {
		pids.add(info.foreground_process_group_id);
	}
	for (const process of info.foreground_processes ?? []) {
		if (
			typeof process?.pid === "number" &&
			Number.isInteger(process.pid) &&
			process.pid > 0
		) {
			pids.add(process.pid);
		}
	}
	return {
		paneId,
		...(typeof info.shell_pid === "number" ? { shellPid: info.shell_pid } : {}),
		...(typeof info.foreground_process_group_id === "number"
			? { foregroundProcessGroupId: info.foreground_process_group_id }
			: {}),
		pids: [...pids],
	};
}

export function getHerdrPaneProcessInfo(surface: string): HerdrPaneProcessInfo {
	return parsePaneProcessInfo(
		herdrExec(["pane", "process-info", "--pane", surface]),
		surface,
	);
}

async function getHerdrPaneProcessInfoAsync(
	surface: string,
): Promise<HerdrPaneProcessInfo> {
	return parsePaneProcessInfo(
		await herdrExecAsync(["pane", "process-info", "--pane", surface]),
		surface,
	);
}

function isHerdrShellReady(info: HerdrPaneProcessInfo): boolean {
	return (
		info.shellPid != null &&
		info.foregroundProcessGroupId === info.shellPid
	);
}

export async function waitForHerdrShellReady(
	surface: string,
	options: { timeoutMs?: number; intervalMs?: number; signal?: AbortSignal } = {},
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 10_000;
	const intervalMs = options.intervalMs ?? 50;
	const deadline = Date.now() + timeoutMs;
	let lastError = "no interactive shell foreground process";

	while (Date.now() <= deadline) {
		if (options.signal?.aborted) throw new Error("Shell readiness wait cancelled.");
		try {
			if (isHerdrShellReady(await getHerdrPaneProcessInfoAsync(surface))) return;
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
		}
		if (Date.now() >= deadline) break;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(
		`Timed out waiting for interactive shell in Herdr pane ${surface}: ${lastError}`,
	);
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export async function waitForProcessesExit(
	pids: readonly number[],
	options: {
		timeoutMs?: number;
		intervalMs?: number;
		isAlive?: (pid: number) => boolean;
	} = {},
): Promise<number[]> {
	const isAlive = options.isAlive ?? isProcessAlive;
	const timeoutMs = options.timeoutMs ?? 5_000;
	const intervalMs = options.intervalMs ?? 50;
	const remaining = new Set(
		pids.filter((pid) => Number.isInteger(pid) && pid > 0 && isAlive(pid)),
	);
	const deadline = Date.now() + timeoutMs;
	while (remaining.size > 0 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
		for (const pid of remaining) {
			if (!isAlive(pid)) remaining.delete(pid);
		}
	}
	return [...remaining];
}

export async function waitForHerdrPaneAbsence(
	surface: string,
	options: {
		timeoutMs?: number;
		intervalMs?: number;
		inspect?: (surface: string) => Promise<PaneInspectionResult>;
	} = {},
): Promise<boolean> {
	const inspect = options.inspect ?? inspectHerdrPane;
	const timeoutMs = options.timeoutMs ?? 5_000;
	const intervalMs = options.intervalMs ?? 50;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		const inspection = await inspect(surface);
		if (inspection.kind === "missing") return true;
		if (Date.now() >= deadline) break;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	const finalInspection = await inspect(surface);
	return finalInspection.kind === "missing";
}

export function sendHerdrCommand(surface: string, command: string): void {
  // pane run sends the text and Enter in a single socket request, avoiding
  // a race where Enter could arrive before the text is fully processed.
  herdrExec(["pane", "run", surface, command]);
}

export function sendHerdrEscape(surface: string): void {
  herdrExec(["pane", "send-keys", surface, "Escape"]);
}

export function closeHerdrSurface(surface: string): void {
  herdrExec(["pane", "close", surface]);
}

export function renameHerdrTab(title: string): void {
  const { tab_id: tabId } = getHerdrCurrentPaneInfo();
  herdrExec(["tab", "rename", tabId, title]);
}

export function renameHerdrWorkspace(title: string): void {
  const { workspace_id: workspaceId } = getHerdrCurrentPaneInfo();
  herdrExec(["workspace", "rename", workspaceId, title]);
}

export function focusHerdrWorkspace(workspaceId: string): void {
  herdrExec(["workspace", "focus", workspaceId]);
}

export const __herdrTest__ = {
  buildCurrentPaneArgs,
  buildTabCreateArgs,
  buildWorktreeCreateArgs,
  parseHerdrJson,
  extractHerdrPaneId,
  extractHerdrRootPaneId,
  extractHerdrWorktree,
  parsePaneGetOutput,
  parsePaneGetError,
	parsePaneProcessInfo,
	isHerdrShellReady,
};
