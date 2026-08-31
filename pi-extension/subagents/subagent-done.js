import { stripFrontmatter } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSubagentActivityRecorder } from "./activity.js";
import { classifySettledOutcome } from "./settled-contract.js";
import { hasUndrainedDescendants, lineageFromEnvironment, reduceLineage } from "./lineage.js";
export function shouldMarkUserTookOver(agentStarted) {
    return agentStarted;
}
async function waitForDescendantDrain() {
    const lineage = lineageFromEnvironment();
    if (!lineage) return;
    while(hasUndrainedDescendants(reduceLineage(lineage.rootDir), lineage.parentNodeId)){
        await new Promise((resolve)=>setTimeout(resolve, 50));
    }
}
async function waitForOwnedChildren() {
    const contextPath = process.env.PI_SUBAGENT_TREE_CONTEXT;
    if (!contextPath) return;
    let context;
    try {
        context = JSON.parse(readFileSync(contextPath, "utf8"));
    } catch  {
        return;
    }
    if (!context.treeDir || !context.ownerId) return;
    for(;;){
        const nodesDir = join(context.treeDir, "nodes");
        const pending = existsSync(nodesDir) && readdirSync(nodesDir).some((file)=>{
            if (!file.endsWith(".json")) return false;
            try {
                const node = JSON.parse(readFileSync(join(nodesDir, file), "utf8"));
                return node.ownerId === context.ownerId && node.status !== "settled";
            } catch  {
                return true;
            }
        });
        if (!pending) return;
        await new Promise((resolve)=>setTimeout(resolve, 100));
    }
}
function textFromContent(content) {
    if (!Array.isArray(content)) return "";
    return content.filter((part)=>part != null && typeof part === "object").filter((part)=>part.type === "text" && typeof part.text === "string").map((part)=>part.text ?? "").join("");
}
export function newestAssistantEntry(messages) {
    if (!messages || messages.length === 0) return null;
    const latest = messages[messages.length - 1];
    if (latest?.role === "user") return null;
    for(let i = messages.length - 1; i >= 0; i--){
        const msg = messages[i];
        if (msg?.role !== "assistant") continue;
        const text = typeof msg.text === "string" ? msg.text : textFromContent(msg.content);
        const contentLength = text.length;
        return {
            id: typeof msg.id === "string" && msg.id ? msg.id : `assistant-${i}`,
            text: text || null,
            contentLength,
            stopReason: typeof msg.stopReason === "string" ? msg.stopReason : undefined,
            errorMessage: typeof msg.errorMessage === "string" ? msg.errorMessage : undefined,
            empty: contentLength === 0
        };
    }
    return null;
}
export function classifyAutoExitOutcome(messages, interruptRequested = false) {
    const assistant = newestAssistantEntry(messages);
    if (!assistant) return null;
    return classifySettledOutcome({
        assistant,
        interruptRequested
    });
}
export function shouldAutoExitOnAgentEnd(_userTookOver, messages) {
    const outcome = classifyAutoExitOutcome(messages);
    return outcome === "clean" || outcome === "empty";
}
export function findLatestAssistantError(messages) {
    if (!messages) return null;
    for(let i = messages.length - 1; i >= 0; i--){
        const msg = messages[i];
        if (msg?.role !== "assistant") continue;
        if (msg.stopReason !== "error") return null;
        const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
        return {
            errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
            stopReason: "error"
        };
    }
    return null;
}
export function buildCompletionSidecar(messages) {
    const errorInfo = findLatestAssistantError(messages);
    return errorInfo ? {
        type: "error",
        ...errorInfo
    } : {
        type: "done"
    };
}
export function parseDeniedTools(rawValue) {
    return (rawValue ?? "").split(",").map((value)=>value.trim()).filter(Boolean);
}
export function buildSkillInitialization(event, requestedSkills, notify) {
    const names = [
        ...new Set(requestedSkills.split(",").map((name)=>name.trim()).filter(Boolean))
    ];
    if (names.length === 0) return undefined;
    const catalog = event.systemPromptOptions.skills ?? [];
    const blocks = [];
    for (const name of names){
        const skill = catalog.find((candidate)=>candidate.name === name);
        if (!skill) {
            notify(`Unable to load requested skill "${name}": not found in Pi's resolved skill catalog.`, "warning");
            continue;
        }
        try {
            const body = stripFrontmatter(readFileSync(skill.filePath, "utf8")).trim();
            blocks.push(`<skill name="${skill.name}" location="${skill.filePath}">\n` + `References are relative to ${skill.baseDir}.\n\n${body}\n</skill>`);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            notify(`Unable to load requested skill "${name}": ${reason}`, "warning");
        }
    }
    if (blocks.length === 0) return undefined;
    return {
        message: {
            customType: "subagent_skill_initialization",
            content: [
                {
                    type: "text",
                    text: blocks.join("\n\n")
                }
            ],
            display: false
        }
    };
}
export default function(pi) {
    let toolNames = [];
    let denied = [];
    let expanded = false;
    const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
    const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
    const deniedToolsValue = process.env.PI_DENY_TOOLS;
    const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
    const treeOwner = process.env.PI_SUBAGENT_TREE_OWNER === "1";
    const recorder = createSubagentActivityRecorder({
        runningChildId: process.env.PI_SUBAGENT_ID,
        activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
        settledEventsFile: process.env.PI_SUBAGENT_SETTLED_EVENTS_FILE
    });
    function renderWidget(ctx, _theme) {
        ctx.ui.setWidget("subagent-tools", (_tui, theme)=>{
            const box = new Box(1, 0, (text)=>theme.bg("toolSuccessBg", text));
            const label = subagentAgent || subagentName;
            const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";
            if (expanded) {
                const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
                const hint = theme.fg("muted", "  (Ctrl+J to collapse)");
                const toolList = toolNames.map((name)=>theme.fg("dim", name)).join(theme.fg("muted", ", "));
                let deniedLine = "";
                if (denied.length > 0) {
                    const deniedList = denied.map((name)=>theme.fg("error", name)).join(theme.fg("muted", ", "));
                    deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
                }
                const content = new Text(`${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`, 0, 0);
                box.addChild(content);
            } else {
                const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
                const deniedInfo = denied.length > 0 ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} denied`) : "";
                const hint = theme.fg("muted", "  (Ctrl+J to expand)");
                const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
                box.addChild(content);
            }
            return box;
        }, {
            placement: "aboveEditor"
        });
    }
    let latestAgentEndMessages;
    let latestTurnIndex;
    let skillInitializationComplete = false;
    let resumeTurnStarted = process.env.PI_SUBAGENT_RESUME !== "1";
    let resumeInputSeen = process.env.PI_SUBAGENT_RESUME !== "1";
    const resumeBaselineAssistantIds = new Set((()=>{
        if (process.env.PI_SUBAGENT_RESUME !== "1") return [];
        try {
            const value = JSON.parse(process.env.PI_SUBAGENT_RESUME_BASELINE_ASSISTANTS ?? "[]");
            return Array.isArray(value) ? value.filter((id)=>typeof id === "string") : [];
        } catch  {
            return [];
        }
    })());
    let interruptRequested = false;
    pi.on("session_start", (_event, ctx)=>{
        recorder.sessionStart();
        const tools = pi.getAllTools();
        toolNames = tools.map((t)=>t.name).sort();
        denied = parseDeniedTools(deniedToolsValue);
        renderWidget(ctx, null);
    });
    pi.on("input", ()=>{
        resumeInputSeen = true;
        recorder.input();
    });
    pi.on("before_agent_start", (event, ctx)=>{
        latestAgentEndMessages = undefined;
        latestTurnIndex = undefined;
        resumeTurnStarted = true;
        recorder.beforeAgentStart();
        if (skillInitializationComplete) return;
        skillInitializationComplete = true;
        const requestedSkills = process.env.PI_SUBAGENT_SKILLS;
        if (requestedSkills === undefined) return;
        return buildSkillInitialization(event, requestedSkills, (message, type)=>ctx.ui.notify(message, type));
    });
    pi.on("agent_start", ()=>{
        recorder.agentStart();
    });
    let exitRequested = false;
    const finishAfterDrain = async (ctx, payload)=>{
        if (exitRequested) return;
        exitRequested = true;
        const lineage = lineageFromEnvironment();
        const shouldWaitForDescendants = lineage ? hasUndrainedDescendants(reduceLineage(lineage.rootDir), lineage.parentNodeId) : false;
        if (shouldWaitForDescendants) await waitForDescendantDrain();
        if (treeOwner) await waitForOwnedChildren();
        const sessionFile = process.env.PI_SUBAGENT_SESSION;
        if (sessionFile) {
            try {
                writeFileSync(`${sessionFile}.exit`, JSON.stringify(payload));
            } catch  {}
        }
        ctx.shutdown();
    };
    pi.on("agent_end", (event)=>{
        latestAgentEndMessages = event.messages;
        const eventTurnIndex = event.turnIndex;
        if (typeof eventTurnIndex === "number") latestTurnIndex = eventTurnIndex;
        recorder.agentEndWaiting();
    });
    pi.on("agent_settled", (_event, ctx)=>{
        const outcome = classifyAutoExitOutcome(latestAgentEndMessages, interruptRequested);
        const assistant = newestAssistantEntry(latestAgentEndMessages);
        if (!outcome || !assistant) return;
        if (resumeBaselineAssistantIds.has(assistant.id)) {
            return;
        }
        if (!resumeTurnStarted || process.env.PI_SUBAGENT_RESUME === "1" && !resumeInputSeen) return;
        recorder.agentSettled({
            outcome,
            assistantId: assistant.id,
            stopReason: assistant.stopReason,
            errorMessage: assistant.errorMessage,
            empty: assistant.empty,
            turnIndex: latestTurnIndex,
            autoExit
        });
        if (!autoExit || outcome !== "clean" && outcome !== "empty") return;
        void finishAfterDrain(ctx, {
            type: "done"
        });
    });
    pi.on("turn_start", (event)=>{
        latestTurnIndex = event.turnIndex;
        recorder.turnStart(latestTurnIndex);
    });
    pi.on("turn_end", (event)=>{
        recorder.turnEnd(event.turnIndex);
    });
    pi.on("before_provider_request", ()=>{
        recorder.beforeProviderRequest();
    });
    pi.on("after_provider_response", ()=>{
        recorder.afterProviderResponse();
    });
    pi.on("message_update", (event)=>{
        recorder.messageUpdate(event.assistantMessageEvent?.type);
    });
    pi.on("tool_execution_start", (event)=>{
        recorder.toolExecutionStart(event.toolCallId, event.toolName);
    });
    pi.on("tool_call", (event)=>{
        recorder.toolCall(event.toolCallId, event.toolName);
    });
    pi.on("tool_execution_update", (event)=>{
        recorder.toolExecutionUpdate(event.toolCallId, event.toolName);
    });
    pi.on("tool_result", (event)=>{
        recorder.toolResult(event.toolCallId, event.toolName);
    });
    pi.on("tool_execution_end", (event)=>{
        recorder.toolExecutionEnd(event.toolCallId, event.toolName);
    });
    pi.on("session_shutdown", (event)=>{
        recorder.sessionShutdown(event.reason);
    });
    pi.registerShortcut("ctrl+j", {
        description: "Toggle subagent tools widget",
        handler: (ctx)=>{
            expanded = !expanded;
            renderWidget(ctx, null);
        }
    });
    pi.registerTool({
        name: "caller_ping",
        label: "Caller Ping",
        description: "Record a help request for the parent agent. " + "The parent will be notified with your message, and delivery and session exit wait until recursively owned descendants drain. " + "Use when you're stuck, need clarification, or need the parent to take action.",
        parameters: Type.Object({
            message: Type.String({
                description: "What you need help with"
            })
        }),
        async execute (_toolCallId, params, _signal, _onUpdate, ctx) {
            const sessionFile = process.env.PI_SUBAGENT_SESSION;
            if (!sessionFile) {
                throw new Error("caller_ping is only available in subagent contexts. " + "PI_SUBAGENT_SESSION environment variable is not set.");
            }
            recorder.callerPing();
            const exitData = {
                type: "ping",
                name: process.env.PI_SUBAGENT_NAME ?? "subagent",
                message: params.message
            };
            await finishAfterDrain(ctx, exitData);
            return {
                content: [
                    {
                        type: "text",
                        text: "Ping sent. Session will exit and parent will be notified."
                    }
                ],
                details: {}
            };
        }
    });
    if (autoExit) return;
    pi.registerTool({
        name: "subagent_done",
        label: "Subagent Done",
        description: "Record interactive completion intent. " + "Return results and close this session after recursively owned descendants drain. " + "Your LAST assistant message before calling this becomes the summary returned to the caller.",
        parameters: Type.Object({
            summary: Type.Optional(Type.String({
                description: "Optional final summary"
            }))
        }),
        async execute (_toolCallId, params, _signal, _onUpdate, ctx) {
            recorder.subagentDone();
            const payload = {
                type: "done",
                ...typeof params.summary === "string" && params.summary.trim() ? {
                    summary: params.summary
                } : {}
            };
            const lineage = lineageFromEnvironment();
            const pendingDescendants = lineage ? hasUndrainedDescendants(reduceLineage(lineage.rootDir), lineage.parentNodeId) : false;
            if (!pendingDescendants) {
                const sessionFile = process.env.PI_SUBAGENT_SESSION;
                if (sessionFile) {
                    try {
                        writeFileSync(`${sessionFile}.exit`, JSON.stringify(payload));
                    } catch  {}
                }
                ctx.shutdown();
            } else {
                await finishAfterDrain(ctx, payload);
            }
            return {
                content: [
                    {
                        type: "text",
                        text: "Shutting down subagent session."
                    }
                ],
                details: {}
            };
        }
    });
}
