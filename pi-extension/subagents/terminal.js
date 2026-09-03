import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { closeHerdrSurface, createHerdrSurface, createHerdrSurfaceInWorkspace, createHerdrSurfaceSplit, createHerdrWorktree, focusHerdrWorkspace, getHerdrPaneProcessInfo, waitForHerdrPiReady, waitForHerdrShellReady, isHerdrAvailable, isProcessAlive, readHerdrScreen, readHerdrScreenAsync, inspectHerdrPane, renameHerdrTab, renameHerdrWorkspace, sendHerdrCommand, sendHerdrEscape, waitForHerdrPaneAbsence, waitForProcessesExit, } from "./herdr.js";
const SETUP_HINT = "Start pi inside herdr (`herdr`, then run `pi`).";
export function isTerminalAvailable() {
    return isHerdrAvailable();
}
export function terminalSetupHint() {
    return SETUP_HINT;
}
function assertTerminalAvailable() {
    if (!isTerminalAvailable())
        throw new Error(`herdr is not available. ${SETUP_HINT}`);
}
export function shellQuote(value) {
    return "'" + value.replace(/'/g, "'\\''") + "'";
}
/** Create a new herdr tab and return its root pane ID. */
export function createSubagentPane(name) {
    assertTerminalAvailable();
    return createHerdrSurface(name);
}
/** Create a subagent tab in an exact existing Herdr workspace. */
export function createSubagentPaneInWorkspace(name, cwd, workspaceId) {
    assertTerminalAvailable();
    return createHerdrSurfaceInWorkspace(name, cwd, workspaceId);
}
/** Create a Git worktree in its own herdr workspace and return its root surface. */
export function createSubagentWorktree(name, cwd, branch, base) {
    assertTerminalAvailable();
    return createHerdrWorktree(name, cwd, branch, base);
}
/** Split the current herdr pane and return the child pane ID. */
export function splitCurrentPane(name, direction) {
    assertTerminalAvailable();
    return createHerdrSurfaceSplit(name, direction);
}
export function renameCurrentTab(title) {
    assertTerminalAvailable();
    renameHerdrTab(title);
}
export function renameCurrentWorkspace(title) {
    assertTerminalAvailable();
    renameHerdrWorkspace(title);
}
export function focusWorkspace(workspaceId) {
    assertTerminalAvailable();
    focusHerdrWorkspace(workspaceId);
}
export function runInPane(paneId, command) {
    assertTerminalAvailable();
    sendHerdrCommand(paneId, command);
}
export function interruptPane(paneId) {
    assertTerminalAvailable();
    sendHerdrEscape(paneId);
}
export function runScriptInPane(paneId, command, options) {
    const scriptPath = options?.scriptPath ??
        join(tmpdir(), "pi-herdr-subagent-scripts", `cmd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.sh`);
    mkdirSync(dirname(scriptPath), { recursive: true });
    const scriptLines = ["#!/bin/bash"];
    if (options?.scriptPreamble)
        scriptLines.push(options.scriptPreamble.trimEnd());
    scriptLines.push(command);
    writeFileSync(scriptPath, `${scriptLines.join("\n")}\n`, { mode: 0o755 });
    runInPane(paneId, `bash ${shellQuote(scriptPath)}`);
    return scriptPath;
}
export function readPane(paneId, lines = 50) {
    assertTerminalAvailable();
    return readHerdrScreen(paneId, lines);
}
export async function readPaneAsync(paneId, lines = 50) {
    assertTerminalAvailable();
    return readHerdrScreenAsync(paneId, lines);
}
export async function inspectPane(paneId) {
    assertTerminalAvailable();
    const result = await inspectHerdrPane(paneId);
    if (result.kind === "present") {
        return { ...result, observedAt: Date.now() };
    }
    return result;
}
export function closePane(paneId) {
    assertTerminalAvailable();
    closeHerdrSurface(paneId);
}
export function getPaneProcessInfo(paneId) {
    assertTerminalAvailable();
    return getHerdrPaneProcessInfo(paneId);
}
export async function waitForShellReady(paneId, options) {
    assertTerminalAvailable();
    return waitForHerdrShellReady(paneId, options);
}
export async function waitForPiReady(paneId, sessionFile, cwd) {
    assertTerminalAvailable();
    return waitForHerdrPiReady(paneId, sessionFile, cwd);
}
export async function waitForPaneAbsence(paneId, options) {
    assertTerminalAvailable();
    return waitForHerdrPaneAbsence(paneId, options);
}
export { isProcessAlive, waitForProcessesExit };
