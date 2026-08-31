import { execFile, execSync, execFileSync } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const commandAvailability = new Map();
function hasCommand(command) {
    if (commandAvailability.has(command)) {
        return commandAvailability.get(command);
    }
    let available = false;
    if (process.platform === "win32") {
        try {
            execFileSync("where.exe", [
                command
            ], {
                stdio: "ignore"
            });
            available = true;
        } catch  {
            try {
                execSync(`command -v ${command}`, {
                    stdio: "ignore"
                });
                available = true;
            } catch  {
                available = false;
            }
        }
    } else {
        try {
            execSync(`command -v ${command}`, {
                stdio: "ignore"
            });
            available = true;
        } catch  {
            available = false;
        }
    }
    commandAvailability.set(command, available);
    return available;
}
export function isHerdrAvailable() {
    return process.env.HERDR_ENV === "1" && hasCommand("herdr");
}
function parseHerdrJson(value) {
    try {
        return JSON.parse(value);
    } catch  {
        return null;
    }
}
function extractHerdrPaneId(output, context) {
    const parsed = parseHerdrJson(output);
    const paneId = parsed?.result?.pane?.pane_id;
    if (typeof paneId !== "string" || !paneId) {
        throw new Error(`Unexpected herdr ${context} output: ${output.trim() || "(empty)"}`);
    }
    return paneId;
}
function extractHerdrRootPaneId(output, context) {
    const parsed = parseHerdrJson(output);
    const paneId = parsed?.result?.root_pane?.pane_id;
    if (typeof paneId !== "string" || !paneId) {
        throw new Error(`Unexpected herdr ${context} output: ${output.trim() || "(empty)"}`);
    }
    return paneId;
}
function extractHerdrWorktree(output) {
    const parsed = parseHerdrJson(output);
    const result = parsed?.result;
    if (result?.type !== "worktree_created" || typeof result.workspace?.workspace_id !== "string" || !result.workspace.workspace_id || typeof result.root_pane?.pane_id !== "string" || !result.root_pane.pane_id || typeof result.worktree?.path !== "string" || !result.worktree.path || typeof result.worktree.branch !== "string" || !result.worktree.branch) {
        throw new Error(`Unexpected herdr worktree create output: ${output.trim() || "(empty)"}`);
    }
    return {
        path: result.worktree.path,
        branch: result.worktree.branch,
        workspaceId: result.workspace.workspace_id,
        paneId: result.root_pane.pane_id
    };
}
function herdrExec(args) {
    return execFileSync("herdr", args, {
        encoding: "utf8"
    });
}
async function herdrExecAsync(args) {
    const { stdout } = await execFileAsync("herdr", args, {
        encoding: "utf8"
    });
    return stdout;
}
function getHerdrParentPaneId() {
    const paneId = process.env.HERDR_PANE_ID;
    if (!paneId) {
        throw new Error("HERDR_PANE_ID not set");
    }
    return paneId;
}
function buildCurrentPaneArgs() {
    return [
        "pane",
        "current",
        "--current"
    ];
}
function getHerdrCurrentPaneInfo() {
    const paneId = process.env.HERDR_PANE_ID;
    const tabId = process.env.HERDR_TAB_ID;
    const workspaceId = process.env.HERDR_WORKSPACE_ID;
    if (!paneId || !tabId || !workspaceId) {
        const output = herdrExec(buildCurrentPaneArgs());
        const parsed = parseHerdrJson(output);
        const pane = parsed?.result?.pane;
        if (!pane?.pane_id || !pane?.tab_id || !pane?.workspace_id) {
            throw new Error(`Unexpected herdr pane current output: ${output.trim() || "(empty)"}`);
        }
        return {
            pane_id: pane.pane_id,
            tab_id: pane.tab_id,
            workspace_id: pane.workspace_id
        };
    }
    return {
        pane_id: paneId,
        tab_id: tabId,
        workspace_id: workspaceId
    };
}
function buildTabCreateArgs(name, cwd, workspaceId) {
    return [
        "tab",
        "create",
        "--workspace",
        workspaceId,
        "--label",
        name,
        "--cwd",
        cwd,
        "--no-focus"
    ];
}
function buildWorktreeCreateArgs(name, cwd, branch, base) {
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
        "--no-focus"
    ];
}
export function createHerdrSurface(name) {
    const { workspace_id: workspaceId } = getHerdrCurrentPaneInfo();
    const output = herdrExec(buildTabCreateArgs(name, process.cwd(), workspaceId));
    const paneId = extractHerdrRootPaneId(output, "tab create");
    try {
        herdrExec([
            "pane",
            "rename",
            paneId,
            name
        ]);
    } catch  {}
    return paneId;
}
export class HerdrWorktreeCreateError extends Error {
    recoveredWorktree;
    constructor(message, recoveredWorktree){
        super(message);
        this.name = "HerdrWorktreeCreateError";
        this.recoveredWorktree = recoveredWorktree;
    }
}
export function parseHerdrWorktreeList(output) {
    const parsed = parseHerdrJson(output);
    const worktrees = parsed?.result?.worktrees;
    if (parsed?.result?.type !== "worktree_list" || !Array.isArray(worktrees)) {
        throw new Error("Unexpected herdr worktree list output");
    }
    return worktrees.map((worktree)=>{
        if (typeof worktree.branch !== "string" || typeof worktree.path !== "string") {
            throw new Error("Unexpected herdr worktree list entry");
        }
        return {
            branch: worktree.branch,
            path: worktree.path,
            ...typeof worktree.label === "string" ? {
                label: worktree.label
            } : {},
            ...typeof worktree.open_workspace_id === "string" ? {
                workspaceId: worktree.open_workspace_id
            } : {},
            isLinkedWorktree: worktree.is_linked_worktree === true
        };
    });
}
export function listHerdrWorktrees(cwd) {
    const args = [
        "worktree",
        "list"
    ];
    if (cwd) args.push("--cwd", cwd);
    return parseHerdrWorktreeList(herdrExec(args));
}
function parseHerdrPaneList(output, workspaceId) {
    const parsed = parseHerdrJson(output);
    if (parsed?.result?.type !== "pane_list" || !Array.isArray(parsed.result.panes)) {
        throw new Error("Unexpected herdr pane list output");
    }
    return parsed.result.panes.filter((pane)=>pane.workspace_id === workspaceId).map((pane)=>pane.pane_id).filter((paneId)=>typeof paneId === "string");
}
function recoverHerdrWorktree(cwd, branch) {
    const matches = listHerdrWorktrees(cwd).filter((worktree)=>worktree.branch === branch);
    if (matches.length !== 1) return undefined;
    const worktree = matches[0];
    if (!worktree.workspaceId) return worktree;
    const panes = parseHerdrPaneList(herdrExec([
        "pane",
        "list",
        "--workspace",
        worktree.workspaceId
    ]), worktree.workspaceId);
    if (panes.length !== 1) return worktree;
    return {
        path: worktree.path,
        branch: worktree.branch,
        workspaceId: worktree.workspaceId,
        paneId: panes[0]
    };
}
export function createHerdrWorktree(name, cwd, branch, base) {
    const output = herdrExec(buildWorktreeCreateArgs(name, cwd, branch, base));
    try {
        return extractHerdrWorktree(output);
    } catch (parseError) {
        let recovered;
        try {
            recovered = recoverHerdrWorktree(cwd, branch);
        } catch  {
            throw parseError;
        }
        if (recovered?.workspaceId && "paneId" in recovered) return recovered;
        if (recovered) {
            throw new HerdrWorktreeCreateError(`Herdr created branch ${branch}, but its workspace response was incomplete`, recovered);
        }
        throw parseError;
    }
}
export function createHerdrSurfaceSplit(name, direction) {
    const parentPaneId = getHerdrParentPaneId();
    const output = herdrExec([
        "pane",
        "split",
        parentPaneId,
        "--direction",
        direction,
        "--no-focus",
        "--cwd",
        process.cwd()
    ]);
    const paneId = extractHerdrPaneId(output, "pane split");
    try {
        herdrExec([
            "pane",
            "rename",
            paneId,
            name
        ]);
    } catch  {}
    return paneId;
}
export function readHerdrScreen(surface, lines = 50) {
    return herdrExec([
        "pane",
        "read",
        surface,
        "--source",
        "visible",
        "--lines",
        String(lines)
    ]);
}
export async function readHerdrScreenAsync(surface, lines = 50) {
    return herdrExecAsync([
        "pane",
        "read",
        surface,
        "--source",
        "visible",
        "--lines",
        String(lines)
    ]);
}
function parsePaneGetOutput(output, surface) {
    const parsed = parseHerdrJson(output);
    const errorObj = parsed?.error;
    if (errorObj?.code === "pane_not_found" || errorObj?.code === "not_found") {
        return {
            kind: "missing",
            error: typeof errorObj.message === "string" ? errorObj.message : "pane not found"
        };
    }
    const pane = parsed?.result?.pane;
    if (!pane || typeof pane !== "object") return {
        kind: "unavailable",
        error: "pane get returned no pane record"
    };
    const record = pane;
    if (record.pane_id !== surface) return {
        kind: "unavailable",
        error: "pane id mismatch"
    };
    const agent = typeof record.agent === "string" ? record.agent : undefined;
    const rawStatus = typeof record.agent_status === "string" ? record.agent_status : "unknown";
    const agentStatus = rawStatus === "idle" || rawStatus === "working" || rawStatus === "blocked" || rawStatus === "done" || rawStatus === "unknown" ? rawStatus : "unknown";
    return {
        kind: "present",
        ...agent ? {
            agent
        } : {},
        agentStatus
    };
}
function parsePaneGetError(error) {
    for (const raw of [
        error?.stderr,
        error?.stdout
    ]){
        if (typeof raw !== "string" || !raw.trim()) continue;
        try {
            const parsed = parsePaneGetOutput(raw, "");
            if (parsed.kind === "missing") return parsed;
        } catch  {}
        if (/\b(?:pane_not_found|not_found)\b/.test(raw)) {
            return {
                kind: "missing",
                error: raw.trim()
            };
        }
    }
    const message = error?.message ? String(error.message) : "herdr pane get failed";
    return {
        kind: "unavailable",
        error: message
    };
}
export async function inspectHerdrPane(surface) {
    try {
        return parsePaneGetOutput(await herdrExecAsync([
            "pane",
            "get",
            surface
        ]), surface);
    } catch (error) {
        return parsePaneGetError(error);
    }
}
export function parsePaneProcessInfo(output, paneId) {
    const parsed = parseHerdrJson(output);
    const info = parsed?.result?.process_info;
    if (!info || typeof info !== "object") {
        throw new Error(`Unexpected herdr pane process-info output: ${output.trim() || "(empty)"}`);
    }
    if (typeof info.pane_id === "string" && info.pane_id !== paneId) {
        throw new Error(`herdr pane process-info pane id mismatch: ${info.pane_id} != ${paneId}`);
    }
    const pids = new Set();
    if (typeof info.shell_pid === "number" && Number.isInteger(info.shell_pid) && info.shell_pid > 0) {
        pids.add(info.shell_pid);
    }
    if (typeof info.foreground_process_group_id === "number" && Number.isInteger(info.foreground_process_group_id) && info.foreground_process_group_id > 0) {
        pids.add(info.foreground_process_group_id);
    }
    const foregroundProcesses = [];
    for (const process1 of info.foreground_processes ?? []){
        if (typeof process1?.pid === "number" && Number.isInteger(process1.pid) && process1.pid > 0) {
            pids.add(process1.pid);
            foregroundProcesses.push({
                pid: process1.pid,
                ...typeof process1.name === "string" ? {
                    name: process1.name
                } : {},
                ...typeof process1.argv0 === "string" ? {
                    argv0: process1.argv0
                } : {},
                ...Array.isArray(process1.argv) && process1.argv.every((value)=>typeof value === "string") ? {
                    argv: process1.argv
                } : {},
                ...typeof process1.cwd === "string" ? {
                    cwd: process1.cwd
                } : {}
            });
        }
    }
    return {
        paneId,
        ...typeof info.shell_pid === "number" ? {
            shellPid: info.shell_pid
        } : {},
        ...typeof info.foreground_process_group_id === "number" ? {
            foregroundProcessGroupId: info.foreground_process_group_id
        } : {},
        pids: [
            ...pids
        ],
        foregroundProcesses
    };
}
export function getHerdrPaneProcessInfo(surface) {
    return parsePaneProcessInfo(herdrExec([
        "pane",
        "process-info",
        "--pane",
        surface
    ]), surface);
}
async function getHerdrPaneProcessInfoAsync(surface) {
    return parsePaneProcessInfo(await herdrExecAsync([
        "pane",
        "process-info",
        "--pane",
        surface
    ]), surface);
}
function isHerdrShellReady(info) {
    return info.shellPid != null && info.foregroundProcessGroupId === info.shellPid;
}
function isExpectedPiProcess(process1, sessionFile, cwd) {
    const sessionIndex = process1.argv?.indexOf("--session") ?? -1;
    return (process1.name === "pi" || process1.argv0?.split("/").pop() === "pi") && sessionIndex >= 0 && process1.argv?.[sessionIndex + 1] === sessionFile && process1.cwd === cwd;
}
export async function waitForHerdrPiReady(surface, sessionFile, cwd, options = {}) {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const intervalMs = options.intervalMs ?? 50;
    const deadline = Date.now() + timeoutMs;
    let lastError = "expected Pi process not observed";
    while(Date.now() <= deadline){
        try {
            const info = await getHerdrPaneProcessInfoAsync(surface);
            if (info.foregroundProcesses.some((process1)=>isExpectedPiProcess(process1, sessionFile, cwd))) {
                return;
            }
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
        if (Date.now() >= deadline) break;
        await new Promise((resolve)=>setTimeout(resolve, intervalMs));
    }
    throw new Error(`Timed out waiting for Pi session ${sessionFile} in Herdr pane ${surface}: ${lastError}`);
}
export async function waitForHerdrShellReady(surface, options = {}) {
    const timeoutMs = options.timeoutMs ?? 10_000;
    const intervalMs = options.intervalMs ?? 50;
    const deadline = Date.now() + timeoutMs;
    let lastError = "no interactive shell foreground process";
    while(Date.now() <= deadline){
        if (options.signal?.aborted) throw new Error("Shell readiness wait cancelled.");
        try {
            if (isHerdrShellReady(await getHerdrPaneProcessInfoAsync(surface))) return;
        } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
        }
        if (Date.now() >= deadline) break;
        await new Promise((resolve)=>setTimeout(resolve, intervalMs));
    }
    throw new Error(`Timed out waiting for interactive shell in Herdr pane ${surface}: ${lastError}`);
}
export function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === "EPERM";
    }
}
export async function waitForProcessesExit(pids, options = {}) {
    const isAlive = options.isAlive ?? isProcessAlive;
    const timeoutMs = options.timeoutMs ?? 5_000;
    const intervalMs = options.intervalMs ?? 50;
    const remaining = new Set(pids.filter((pid)=>Number.isInteger(pid) && pid > 0 && isAlive(pid)));
    const deadline = Date.now() + timeoutMs;
    while(remaining.size > 0 && Date.now() < deadline){
        await new Promise((resolve)=>setTimeout(resolve, intervalMs));
        for (const pid of remaining){
            if (!isAlive(pid)) remaining.delete(pid);
        }
    }
    return [
        ...remaining
    ];
}
export async function waitForHerdrPaneAbsence(surface, options = {}) {
    const inspect = options.inspect ?? inspectHerdrPane;
    const timeoutMs = options.timeoutMs ?? 5_000;
    const intervalMs = options.intervalMs ?? 50;
    const deadline = Date.now() + timeoutMs;
    while(Date.now() <= deadline){
        const inspection = await inspect(surface);
        if (inspection.kind === "missing") return true;
        if (Date.now() >= deadline) break;
        await new Promise((resolve)=>setTimeout(resolve, intervalMs));
    }
    const finalInspection = await inspect(surface);
    return finalInspection.kind === "missing";
}
export function sendHerdrCommand(surface, command) {
    herdrExec([
        "pane",
        "run",
        surface,
        command
    ]);
}
export function sendHerdrEscape(surface) {
    herdrExec([
        "pane",
        "send-keys",
        surface,
        "Escape"
    ]);
}
export function closeHerdrSurface(surface) {
    herdrExec([
        "pane",
        "close",
        surface
    ]);
}
export function renameHerdrTab(title) {
    const { tab_id: tabId } = getHerdrCurrentPaneInfo();
    herdrExec([
        "tab",
        "rename",
        tabId,
        title
    ]);
}
export function renameHerdrWorkspace(title) {
    const { workspace_id: workspaceId } = getHerdrCurrentPaneInfo();
    herdrExec([
        "workspace",
        "rename",
        workspaceId,
        title
    ]);
}
export function focusHerdrWorkspace(workspaceId) {
    herdrExec([
        "workspace",
        "focus",
        workspaceId
    ]);
}
export const __herdrTest__ = {
    buildCurrentPaneArgs,
    buildTabCreateArgs,
    buildWorktreeCreateArgs,
    parseHerdrJson,
    extractHerdrPaneId,
    extractHerdrRootPaneId,
    extractHerdrWorktree,
    parseHerdrWorktreeList,
    parseHerdrPaneList,
    parsePaneGetOutput,
    parsePaneGetError,
    parsePaneProcessInfo,
    isHerdrShellReady,
    isExpectedPiProcess
};
