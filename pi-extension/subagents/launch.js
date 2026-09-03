import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { appendLineageEvent, lineageFromEnvironment, lineageEnvironment, registerLineage, isLineageNodeDrained, reduceLineage, } from "./lineage.js";
import { getSubagentActivityFile, getSubagentSettledEventsFile, } from "./activity.js";
import { createLifecycle } from "./lifecycle.js";
import { HerdrWorktreeCreateError } from "./herdr.js";
import { captureSessionBaseline, createWorktreeSessionFork, seedStandaloneSessionFile, seedSubagentSessionFile, } from "./session.js";
import { createSubagentPane, createSubagentPaneInWorkspace, closePane, getPaneTabId, createSubagentWorktree, runScriptInPane, shellQuote, waitForPiReady, waitForShellReady, focusWorkspace, } from "./terminal.js";
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));
const defaultOperations = {
    createPane: (name, workspace) => workspace
        ? createSubagentPaneInWorkspace(name, workspace.cwd, workspace.id)
        : createSubagentPane(name),
    closePane,
    createWorktree: createSubagentWorktree,
    waitForShellReady,
    runScript: runScriptInPane,
    waitForPiReady,
    focusWorkspace,
};
/**
 * Launch one validated Pi-backed request. Lifecycle watching and parent
 * delivery begin only after this transaction returns the running child.
 */
export async function launchPiSubagent(request, operations = defaultOperations) {
    return request.kind === "resume"
        ? launchResumedPiSubagent(request, operations)
        : launchFreshPiSubagent(request, operations);
}
export async function launchPiWorktreeHandoff(request, operations = defaultOperations) {
    if (!request.worktree || !request.handoff) {
        throw new Error("A worktree handoff requires a worktree and active leaf");
    }
    const running = await launchPiSubagent(request, operations);
    if (!running.worktree) {
        throw new Error("Worktree handoff did not create a managed worktree");
    }
    try {
        operations.focusWorkspace?.(running.worktree.workspaceId);
    }
    catch (error) {
        const focusError = errorMessage(error);
        writeWorktreeManifest(running.worktree.manifestFile, {
            state: "running",
            focusError,
        });
        return {
            running,
            focusError,
        };
    }
    return { running };
}
async function launchFreshPiSubagent(request, operations) {
    const resolved = resolveLaunchRequest(request);
    // Registration is the ownership boundary: publish lineage before Herdr creates resources.
    const inherited = lineageFromEnvironment();
    resolved.lineage = request.lineage ?? registerLineage({
        artifactDir: resolved.artifactDir,
        nodeId: resolved.id,
        parentNodeId: inherited?.nodeId,
        parentSessionId: request.parent.sessionId,
        parentSessionFile: request.parent.sessionFile,
        launchKind: request.worktree ? "worktree" : request.fork ? "fork" : "fresh",
        inheritedRootDir: inherited?.rootDir,
        inheritedRootId: inherited?.rootId,
    });
    let surface;
    const abort = new AbortController();
    const signal = request.signal ?? abort.signal;
    try {
        surface = prepareLaunchSurface(resolved, operations);
        const session = prepareChildSession(resolved, surface);
        const handoffArtifacts = request.handoff
            ? prepareTaskArtifacts(resolved, session)
            : undefined;
        await confirmShellReady(session, operations, signal);
        if (signal.aborted)
            throw new Error("subagent launch aborted");
        const artifacts = handoffArtifacts ?? prepareTaskArtifacts(resolved, session);
        const sessionBaseline = captureSessionBaseline(artifacts.sessionFile);
        if (resolved.lineage) {
            appendLineageEvent(resolved.lineage.rootDir, `metadata:${resolved.id}:${resolved.startTime}`, "launch_metadata", resolved.id, {
                name: request.name,
                task: request.task,
                agent: request.agent,
                surface: artifacts.surface,
                tabId: artifacts.tabId,
                sessionFile: artifacts.sessionFile,
                activityFile: artifacts.activityFile,
                settledEventsFile: artifacts.settledEventsFile,
                startTime: resolved.startTime,
                interactive: request.behavior.interactive,
                autoExit: request.behavior.autoExit,
                cwd: artifacts.targetCwd,
                ...(artifacts.worktree?.workspaceId ? { workspaceId: artifacts.worktree.workspaceId } : {}),
            });
        }
        const command = buildPiCommand(resolved, artifacts);
        const launchScriptFile = startPiProcess(resolved, artifacts, command, operations);
        if (request.handoff) {
            if (!operations.waitForPiReady)
                throw new Error("Pi startup confirmation is unavailable");
            await operations.waitForPiReady(artifacts.surface, artifacts.sessionFile, artifacts.targetCwd);
            if (artifacts.worktree)
                persistWorktreeResult(artifacts.worktree, "running");
        }
        return createRunningChild(resolved, artifacts, launchScriptFile, sessionBaseline);
    }
    catch (error) {
        abort.abort();
        if (surface && !surface.worktree) {
            try {
                operations.closePane?.(surface.surface);
            }
            catch { /* best effort */ }
        }
        if (!surface?.worktree)
            throw error;
        const handoff = captureWorktreeHandoff(surface.worktree);
        try {
            persistWorktreeResult(surface.worktree, "failed", handoff);
        }
        catch { /* launch error remains authoritative */ }
        throw new Error(`Failed to launch subagent; worktree retained at ${surface.worktree.path} (workspace ${surface.worktree.workspaceId}): ${errorMessage(error)}`);
    }
}
function resolveLaunchRequest(request) {
    const id = request.id ?? randomUUID();
    const agentDir = request.parent.agentDir ??
        process.env.PI_CODING_AGENT_DIR ??
        join(homedir(), ".pi", "agent");
    const rawCwd = request.cwd ?? request.behavior.cwd;
    const cwdBase = request.cwd == null && request.behavior.cwd != null
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
        localAgentDir: localAgentDir && existsSync(localAgentDir) ? localAgentDir : null,
        sourceCwd,
        artifactDir: join(request.parent.sessionDir, "artifacts", request.parent.sessionId),
        sessionMode,
        taskDelivery: sessionMode === "fork" ? "direct" : "artifact",
    };
}
function prepareLaunchSurface(resolved, operations) {
    const { request } = resolved;
    if (!request.worktree) {
        const surface = request.surface ?? operations.createPane(request.name);
        const tabId = getPaneTabId(surface);
        return {
            surface,
            ...(tabId ? { tabId } : {}),
            targetCwd: resolved.sourceCwd,
            effectiveAgentDir: resolved.localAgentDir ?? resolved.agentDir,
            localAgentDir: resolved.localAgentDir,
        };
    }
    if (request.surface)
        throw new Error("A worktree subagent cannot use a pre-created pane");
    const baseRef = request.worktree.base ?? "HEAD";
    const baseSha = resolveGitCommit(resolved.sourceCwd, baseRef);
    const manifestFile = join(resolved.artifactDir, "worktree-runs", `${resolved.id}.json`);
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
    let created;
    try {
        created = operations.createWorktree(request.name, resolved.sourceCwd, request.worktree.branch, baseSha);
    }
    catch (error) {
        writeWorktreeManifest(manifestFile, {
            state: "failed",
            ...ownership,
            ...(error instanceof HerdrWorktreeCreateError
                ? error.recoveredWorktree
                : {}),
            error: errorMessage(error),
        });
        throw error;
    }
    const worktree = {
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
function prepareChildSession(resolved, surface) {
    const sessionDir = getDefaultSessionDirFor(surface.targetCwd, surface.effectiveAgentDir);
    const timestamp = timestampForFile();
    const uuid = [resolved.id, randomUUID(), randomUUID(), randomUUID()].join("-");
    const sessionFile = join(sessionDir, `${timestamp}_${uuid}.jsonl`);
    if (resolved.sessionMode === "standalone") {
        seedStandaloneSessionFile({ childSessionFile: sessionFile, childCwd: surface.targetCwd });
    }
    if (surface.worktree) {
        surface.worktree.sessionFile = sessionFile;
        writeWorktreeManifest(surface.worktree.manifestFile, { sessionFile });
    }
    const activityFile = getSubagentActivityFile(resolved.artifactDir, resolved.id);
    const settledEventsFile = getSubagentSettledEventsFile(resolved.artifactDir, resolved.id);
    if (resolved.lineage) {
        writeFileSync(`${sessionFile}.lineage.json`, JSON.stringify(resolved.lineage), "utf8");
    }
    return { ...surface, sessionFile, activityFile, settledEventsFile };
}
async function confirmShellReady(session, operations, signal) {
    await operations.waitForShellReady(session.surface, { signal });
}
function buildWorktreeHandoffMessage(request, worktree, sessionFile) {
    const task = request.task.slice(0, 2000);
    return [
        "Worktree handoff context:",
        `Branch: ${worktree.branch}`,
        `Base commit: ${worktree.baseSha}`,
        `Worktree: ${worktree.path}`,
        `Source session: ${request.parent.sessionFile}`,
        `Fork session: ${sessionFile}`,
        "",
        "Requested task:",
        task || "Continue the current work in this worktree.",
    ].join("\n");
}
function prepareTaskArtifacts(resolved, session) {
    const { request } = resolved;
    if (request.handoff) {
        if (!session.worktree) {
            throw new Error("A worktree handoff requires a managed worktree");
        }
        const handoffMessage = buildWorktreeHandoffMessage(request, session.worktree, session.sessionFile);
        createWorktreeSessionFork({
            parentSessionFile: request.parent.sessionFile,
            leafId: request.handoff.leafId,
            childSessionFile: session.sessionFile,
            childCwd: session.targetCwd,
            handoffMessage,
        });
        session.worktree.sourceSessionFile = request.parent.sessionFile;
        session.worktree.handoffMessage = handoffMessage;
        writeWorktreeManifest(session.worktree.manifestFile, {
            sourceSessionFile: request.parent.sessionFile,
            handoffMessage,
        });
    }
    else if (resolved.sessionMode !== "standalone") {
        seedSubagentSessionFile({
            mode: resolved.sessionMode,
            parentSessionFile: request.parent.sessionFile,
            childSessionFile: session.sessionFile,
            childCwd: session.targetCwd,
        });
    }
    mkdirSync(dirname(session.activityFile), { recursive: true });
    const identityInSystemPrompt = request.behavior.systemPromptMode && request.behavior.identity;
    const roleBlock = request.behavior.identity && !identityInSystemPrompt
        ? `\n\n${request.behavior.identity}`
        : "";
    const modeHint = request.behavior.autoExit
        ? "Complete your task autonomously."
        : "Complete your task. When finished, call the subagent_done tool. The user can interact with you at any time.";
    const summaryInstruction = request.behavior.autoExit
        ? "Your FINAL assistant message should summarize what you accomplished."
        : "Your FINAL assistant message (before calling subagent_done or before the user exits) should summarize what you accomplished.";
    const fullTask = request.handoff
        ? request.task
        : resolved.sessionMode === "fork"
            ? request.task
            : `${roleBlock}\n\n${modeHint}\n\n${request.task}\n\n${summaryInstruction}`;
    let taskArg = fullTask;
    if (resolved.taskDelivery === "artifact" && !request.handoff) {
        const artifactPath = join(resolved.artifactDir, `context/${safeName(request.name) || "subagent"}-${timestampForFile(false)}.md`);
        mkdirSync(dirname(artifactPath), { recursive: true });
        writeFileSync(artifactPath, fullTask, "utf8");
        taskArg = `@${artifactPath}`;
    }
    let systemPromptFile;
    if (identityInSystemPrompt) {
        systemPromptFile = join(resolved.artifactDir, `context/${safeName(request.name) || "subagent"}-sysprompt-${timestampForFile(false)}.md`);
        mkdirSync(dirname(systemPromptFile), { recursive: true });
        writeFileSync(systemPromptFile, identityInSystemPrompt, "utf8");
    }
    return { ...session, taskArg, systemPromptFile };
}
function buildPiCommand(resolved, artifacts) {
    const { request } = resolved;
    const parts = [
        "pi",
        "--session",
        shellQuote(artifacts.sessionFile),
        ...(request.handoff
            ? []
            : ["-e", shellQuote(join(SUBAGENTS_DIR, "subagent-done.ts"))]),
        ...(process.env.HERDR_ENV === "1" && existsSync(join(process.env.HOME ?? "", ".pi/agent/extensions/herdr-agent-state.ts"))
            ? ["-e", shellQuote(join(process.env.HOME ?? "", ".pi/agent/extensions/herdr-agent-state.ts"))]
            : []),
        "--model",
        shellQuote(request.runtimePlan.model),
        "--thinking",
        shellQuote(request.runtimePlan.thinking),
    ];
    if (artifacts.systemPromptFile) {
        parts.push(request.behavior.systemPromptMode === "replace"
            ? "--system-prompt"
            : "--append-system-prompt", shellQuote(artifacts.systemPromptFile));
    }
    const toolAllowlist = buildSubagentToolAllowlist(request.behavior.tools, request.behavior.autoExit, request.behavior.includeControlTools ?? true);
    if (toolAllowlist)
        parts.push("--tools", shellQuote(toolAllowlist));
    if (!request.handoff) {
        parts.push(shellQuote(artifacts.taskArg));
    }
    const env = [];
    for (const [key, value] of Object.entries(request.environment ?? {})) {
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
            env.push(`${key}=${shellQuote(value)}`);
    }
    if (resolved.lineage && !request.handoff) {
        for (const [key, value] of Object.entries(lineageEnvironment(resolved.lineage))) {
            env.push(`${key}=${shellQuote(value)}`);
        }
    }
    if (artifacts.localAgentDir) {
        env.push(`PI_CODING_AGENT_DIR=${shellQuote(artifacts.localAgentDir)}`);
    }
    else if (process.env.PI_CODING_AGENT_DIR) {
        env.push(`PI_CODING_AGENT_DIR=${shellQuote(process.env.PI_CODING_AGENT_DIR)}`);
    }
    if (!request.handoff) {
        if (request.behavior.deniedTools.length > 0) {
            env.push(`PI_DENY_TOOLS=${shellQuote(request.behavior.deniedTools.join(","))}`);
        }
        env.push(`PI_SUBAGENT_NAME=${shellQuote(request.name)}`);
        if (request.agent)
            env.push(`PI_SUBAGENT_AGENT=${shellQuote(request.agent)}`);
        env.push(`PI_SUBAGENT_SKILLS=${shellQuote(normalizeSkillNames(request.behavior.skills ?? "").join(","))}`);
        env.push(`PI_SUBAGENT_AUTO_EXIT=${request.behavior.autoExit ? "1" : "0"}`);
        env.push(`PI_SUBAGENT_SESSION=${shellQuote(artifacts.sessionFile)}`);
        env.push(`PI_SUBAGENT_ID=${shellQuote(resolved.id)}`);
        env.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellQuote(artifacts.activityFile)}`);
        env.push(`PI_SUBAGENT_SETTLED_EVENTS_FILE=${shellQuote(artifacts.settledEventsFile)}`);
        env.push(`PI_SUBAGENT_SURFACE=${shellQuote(artifacts.surface)}`);
    }
    const piCommand = `cd ${shellQuote(artifacts.targetCwd)} && ` +
        `${env.join(" ")} ${parts.join(" ")}`;
    return request.handoff
        ? piCommand
        : `${piCommand}; echo '__SUBAGENT_DONE_'$?'__'`;
}
function startPiProcess(resolved, artifacts, command, operations) {
    const launchScriptFile = join(resolved.artifactDir, "subagent-scripts", `${safeName(resolved.request.name) || "subagent"}-${resolved.id}.sh`);
    if (artifacts.worktree && !resolved.request.handoff) {
        persistWorktreeResult(artifacts.worktree, "running");
    }
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
function createRunningChild(resolved, artifacts, launchScriptFile, sessionBaseline) {
    return {
        lineage: resolved.lineage,
        id: resolved.id,
        name: resolved.request.name,
        task: resolved.request.task,
        agent: resolved.request.agent,
        surface: artifacts.surface,
        startTime: resolved.startTime,
        sessionFile: artifacts.sessionFile,
        ...(artifacts.tabId ? { tabId: artifacts.tabId } : {}),
        launchScriptFile,
        activityFile: artifacts.activityFile,
        settledEventsFile: artifacts.settledEventsFile,
        interactive: resolved.request.behavior.interactive,
        sessionBaseline,
        runtimePlan: resolved.request.runtimePlan,
        worktree: artifacts.worktree,
        ...(artifacts.worktree?.workspaceId
            ? { recoveryWorkspace: { id: artifacts.worktree.workspaceId, cwd: artifacts.worktree.path } }
            : {}),
        lifecycle: createLifecycle(resolved.startTime),
    };
}
async function launchResumedPiSubagent(request, operations) {
    let id = request.id ?? randomUUID();
    const autoExit = request.behavior?.autoExit ?? true;
    const artifactDir = join(request.parent.sessionDir, "artifacts", request.parent.sessionId);
    const inherited = lineageFromEnvironment();
    let prior;
    try {
        prior = JSON.parse(readFileSync(`${request.sessionFile}.lineage.json`, "utf8"));
        if (!prior.rootDir || !prior.rootId || !prior.nodeId)
            prior = undefined;
    }
    catch { }
    const reusable = prior && !isLineageNodeDrained(reduceLineage(prior.rootDir), prior.nodeId);
    if (reusable && prior)
        id = prior.nodeId;
    const lineage = (reusable ? prior : registerLineage({
        artifactDir,
        nodeId: id,
        parentNodeId: inherited?.nodeId,
        parentSessionId: request.parent.sessionId,
        parentSessionFile: request.parent.sessionFile,
        launchKind: "resume",
        inheritedRootDir: inherited?.rootDir,
        inheritedRootId: inherited?.rootId,
    }));
    const interactive = request.behavior?.interactive ?? !autoExit;
    const startTime = Date.now();
    const surface = request.surface ?? operations.createPane(request.name, request.workspace);
    const allocatedSurface = request.surface === undefined;
    try {
        const tabId = getPaneTabId(surface);
        await operations.waitForShellReady(surface);
        const activityFile = getSubagentActivityFile(artifactDir, id);
        writeFileSync(`${request.sessionFile}.lineage.json`, JSON.stringify(lineage), "utf8");
        const settledEventsFile = getSubagentSettledEventsFile(artifactDir, id);
        mkdirSync(dirname(activityFile), { recursive: true });
        if (lineage) {
            appendLineageEvent(lineage.rootDir, `metadata:${lineage.nodeId}:${startTime}`, "launch_metadata", lineage.nodeId, {
                name: request.name,
                task: request.message ?? "resumed session",
                surface,
                sessionFile: request.sessionFile,
                tabId,
                activityFile,
                settledEventsFile,
                startTime,
                interactive,
                autoExit,
                ...(request.workspace ? { workspaceId: request.workspace.id, cwd: request.workspace.cwd } : {}),
            });
        }
        let messageFile;
        if (request.message) {
            messageFile = join(artifactDir, "subagent-resume", `${safeName(request.name) || "resume"}-${timestampForFile(false)}.md`);
            mkdirSync(dirname(messageFile), { recursive: true });
            writeFileSync(messageFile, request.message, "utf8");
        }
        // Resume must use the existing session position from before the new Pi
        // process starts, not a line count observed after launch.
        const sessionBaseline = captureSessionBaseline(request.sessionFile);
        const env = [
            ...(process.env.PI_CODING_AGENT_DIR
                ? [`PI_CODING_AGENT_DIR=${shellQuote(process.env.PI_CODING_AGENT_DIR)}`]
                : []),
            ...Object.entries(lineageEnvironment(lineage)).map(([key, value]) => `${key}=${shellQuote(value)}`),
            `PI_SUBAGENT_NAME=${shellQuote(request.name)}`,
            `PI_SUBAGENT_SESSION=${shellQuote(request.sessionFile)}`,
            `PI_SUBAGENT_ID=${shellQuote(id)}`,
            `PI_SUBAGENT_ACTIVITY_FILE=${shellQuote(activityFile)}`,
            `PI_SUBAGENT_SETTLED_EVENTS_FILE=${shellQuote(settledEventsFile)}`,
            `PI_SUBAGENT_AUTO_EXIT=${autoExit ? "1" : "0"}`,
            `PI_SUBAGENT_RESUME_BASELINE_ASSISTANTS=${shellQuote(JSON.stringify(sessionBaseline.assistantEntryIds))}`,
            "PI_SUBAGENT_RESUME=1",
        ];
        const command = [
            ...env,
            "pi",
            "--session",
            shellQuote(request.sessionFile),
            "-e",
            shellQuote(join(SUBAGENTS_DIR, "subagent-done.ts")),
            ...(messageFile ? [shellQuote(`@${messageFile}`)] : []),
        ].join(" ");
        const launchScriptFile = operations.runScript(surface, `${command}; echo '__SUBAGENT_DONE_'$?'__'`, {
            scriptPath: join(artifactDir, "subagent-scripts", `${safeName(request.name) || "resume"}-resume-${Date.now()}.sh`),
            scriptPreamble: [
                `# Subagent resume script for ${request.name}`,
                `# Generated: ${new Date().toISOString()}`,
                `# Session: ${request.sessionFile}`,
                `# Surface: ${surface}`,
                ...(messageFile ? [`# Resume message file: ${messageFile}`] : []),
            ].join("\n"),
        });
        return {
            lineage,
            id,
            name: request.name,
            task: request.message ?? "resumed session",
            surface,
            startTime,
            sessionFile: request.sessionFile,
            ...(tabId ? { tabId } : {}),
            launchScriptFile,
            activityFile,
            settledEventsFile,
            interactive,
            runtimePlan: undefined,
            sessionBaseline,
            ...(request.workspace ? { recoveryWorkspace: request.workspace } : {}),
            lifecycle: createLifecycle(startTime),
        };
    }
    catch (error) {
        if (allocatedSurface) {
            try {
                operations.closePane?.(surface);
            }
            catch { }
        }
        throw error;
    }
}
export function buildSubagentToolAllowlist(tools, autoExit = false, includeControlTools = true) {
    const requested = (tools ?? "")
        .split(",")
        .map((tool) => tool.trim())
        .filter(Boolean);
    if (requested.length === 0)
        return null;
    const allow = new Set(requested);
    if (includeControlTools) {
        allow.delete("subagent_done");
        allow.add("caller_ping");
        if (!autoExit)
            allow.add("subagent_done");
    }
    return [...allow].join(",");
}
/** Normalize requested skill names for safe, deterministic child transport. */
export function normalizeSkillNames(skills) {
    return [...new Set(skills
            .split(",")
            .map((skill) => skill.trim())
            .filter(Boolean))];
}
function getDefaultSessionDirFor(cwd, agentDir) {
    const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    const sessionDir = join(agentDir, "sessions", safePath);
    mkdirSync(sessionDir, { recursive: true });
    return sessionDir;
}
function timestampForFile(includeMilliseconds = true) {
    return (new Date()
        .toISOString()
        .replace(/[:.]/g, "-")
        .slice(0, includeMilliseconds ? 23 : 19) +
        (includeMilliseconds ? "Z" : ""));
}
function safeName(name) {
    return name
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, "")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "");
}
function resolveGitCommit(cwd, ref) {
    return execFileSync("git", ["rev-parse", "--verify", `${ref}^{commit}`], {
        cwd,
        encoding: "utf8",
    }).trim();
}
export function writeWorktreeManifest(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    let existing = {};
    if (existsSync(path)) {
        try {
            existing = JSON.parse(readFileSync(path, "utf8"));
        }
        catch {
            existing = {};
        }
    }
    const tempPath = `${path}.tmp`;
    writeFileSync(tempPath, `${JSON.stringify({
        ...existing,
        ...value,
        version: 1,
        kind: "worktree-run",
        owner: "pi-herdr-subagents",
        updatedAt: Date.now(),
    }, null, 2)}\n`);
    renameSync(tempPath, path);
}
function gitPathList(cwd, args) {
    return execFileSync("git", args, { cwd, encoding: "utf8" })
        .split("\0")
        .filter(Boolean);
}
export function captureWorktreeHandoff(worktree) {
    try {
        const headSha = resolveGitCommit(worktree.path, "HEAD");
        const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all", "-z"], { cwd: worktree.path, encoding: "utf8" });
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
            ...gitPathList(worktree.path, ["diff", "--cached", "--name-only", "-z"]),
            ...untrackedFiles,
        ]);
        const commitsAhead = Number.parseInt(execFileSync("git", ["rev-list", "--count", `${worktree.baseSha}..HEAD`], { cwd: worktree.path, encoding: "utf8" }).trim(), 10);
        return {
            ...worktree,
            headSha,
            commitsAhead: Number.isFinite(commitsAhead) ? commitsAhead : 0,
            clean: status.length === 0,
            conflicted: conflictedFiles.length > 0,
            changedFiles: [...changedFiles].sort(),
            untrackedFiles: untrackedFiles.sort(),
        };
    }
    catch (error) {
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
export function persistWorktreeResult(worktree, state, handoff) {
    writeWorktreeManifest(worktree.manifestFile, {
        state,
        ...worktree,
        ...handoff,
    });
}
export function runSubagentScript(surface, command, options, worktree, run = runScriptInPane) {
    if (worktree)
        persistWorktreeResult(worktree, "running");
    try {
        return run(surface, command, options);
    }
    catch (error) {
        if (!worktree)
            throw error;
        const handoff = captureWorktreeHandoff(worktree);
        try {
            persistWorktreeResult(worktree, "failed", handoff);
        }
        catch {
            // The launch error remains authoritative when persistence also fails.
        }
        throw new Error(`Failed to launch subagent; worktree retained at ${worktree.path} ` +
            `(workspace ${worktree.workspaceId}): ${errorMessage(error)}`);
    }
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
