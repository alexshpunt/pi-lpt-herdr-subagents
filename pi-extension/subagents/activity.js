import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
const ACTIVITY_UPDATE_THROTTLE_MS = 500;
const MAX_WRITE_FAILURES = 3;
const KNOWN_PHASES = new Set([
    "starting",
    "active",
    "waiting",
    "done"
]);
const KNOWN_SCOPES = new Set([
    "agent",
    "turn",
    "provider",
    "streaming",
    "tool"
]);
const KNOWN_OUTCOMES = new Set([
    "clean",
    "empty",
    "error",
    "intentional-abort",
    "unexpected-abort"
]);
const KNOWN_EVENTS = new Set([
    "session_start",
    "input",
    "before_agent_start",
    "agent_start",
    "agent_end",
    "agent_settled",
    "turn_start",
    "turn_end",
    "before_provider_request",
    "after_provider_response",
    "message_update",
    "tool_execution_start",
    "tool_call",
    "tool_execution_update",
    "tool_result",
    "tool_execution_end",
    "caller_ping",
    "subagent_done",
    "session_shutdown"
]);
const MAX_ACTIVITY_STRING_LENGTH = 200;
export function getSubagentActivityFile(artifactDir, runningChildId) {
    return join(artifactDir, "subagent-activity", `${runningChildId}.json`);
}
export function getSubagentSettledEventsFile(artifactDir, runningChildId) {
    return join(artifactDir, "subagent-activity", `${runningChildId}.settled.jsonl`);
}
function isSettledActivityEvent(value, childId) {
    const object = requireObject(value);
    return !!object && object.schema === 1 && object.childId === childId && Number.isInteger(object.sequence) && Number.isFinite(object.recordedAt) && typeof object.outcome === "string" && KNOWN_OUTCOMES.has(object.outcome) && (object.turnIndex == null || Number.isInteger(object.turnIndex)) && (object.assistantId == null || typeof object.assistantId === "string") && (object.stopReason == null || typeof object.stopReason === "string") && (object.errorMessage == null || typeof object.errorMessage === "string") && (object.empty == null || typeof object.empty === "boolean");
}
export function orderSettledActivityEvents(events) {
    return [
        ...events
    ].sort((left, right)=>left.sequence - right.sequence || (left.assistantId ?? "").localeCompare(right.assistantId ?? ""));
}
export function readSubagentSettledEventsFile(eventsFile, expectedRunningChildId) {
    if (!existsSync(eventsFile)) return [];
    let text;
    try {
        text = readFileSync(eventsFile, "utf8");
    } catch  {
        return [];
    }
    const lines = text.split("\n");
    const events = [];
    for(let index = 0; index < lines.length; index += 1){
        const line = lines[index]?.trim();
        if (!line) continue;
        try {
            const parsed = JSON.parse(line);
            if (isSettledActivityEvent(parsed, expectedRunningChildId)) events.push(parsed);
        } catch  {
            if (index === lines.length - 1) break;
        }
    }
    return events;
}
function requireObject(value) {
    if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
    return value;
}
function validateFiniteNumber(object, fieldName) {
    return Number.isFinite(object[fieldName]) ? null : `${fieldName} must be finite`;
}
function validateOptionalFiniteNumber(object, fieldName) {
    const value = object[fieldName];
    return value == null || Number.isFinite(value) ? null : `${fieldName} must be finite when present`;
}
function validateInteger(object, fieldName) {
    return Number.isInteger(object[fieldName]) ? null : `${fieldName} must be an integer`;
}
function validateOptionalInteger(object, fieldName) {
    const value = object[fieldName];
    return value == null || Number.isInteger(value) ? null : `${fieldName} must be an integer when present`;
}
function validateBoolean(object, fieldName) {
    return typeof object[fieldName] === "boolean" ? null : `${fieldName} must be a boolean`;
}
function validateOptionalActivityString(object, fieldName) {
    const value = object[fieldName];
    if (value == null) return null;
    if (typeof value !== "string") return `${fieldName} must be a string when present`;
    if (/\r|\n/.test(value)) return `${fieldName} must not contain newlines`;
    return value.length <= MAX_ACTIVITY_STRING_LENGTH ? null : `${fieldName} is too long`;
}
function invalidActivity(error) {
    return {
        ok: false,
        reason: "invalid",
        error
    };
}
function validateActivity(value, expectedRunningChildId) {
    const object = requireObject(value);
    if (!object) return invalidActivity("activity must be an object");
    if (object.version !== 1) return invalidActivity("unsupported activity version");
    if (typeof object.runningChildId !== "string") return invalidActivity("runningChildId must be a string");
    if (object.runningChildId !== expectedRunningChildId) return {
        ok: false,
        reason: "wrong-id"
    };
    if (typeof object.latestEvent !== "string" || !KNOWN_EVENTS.has(object.latestEvent)) {
        return invalidActivity("unknown latestEvent");
    }
    if (typeof object.phase !== "string" || !KNOWN_PHASES.has(object.phase)) {
        return invalidActivity("unknown activity phase");
    }
    if (object.activeScope != null && (typeof object.activeScope !== "string" || !KNOWN_SCOPES.has(object.activeScope))) {
        return invalidActivity("unknown activeScope");
    }
    if (object.settledOutcome != null && (typeof object.settledOutcome !== "string" || !KNOWN_OUTCOMES.has(object.settledOutcome))) {
        return invalidActivity("unknown settledOutcome");
    }
    const settledEmptyError = object.settledEmpty != null && typeof object.settledEmpty !== "boolean" ? "settledEmpty must be a boolean when present" : null;
    if (settledEmptyError) return invalidActivity(settledEmptyError);
    const validationError = [
        validateFiniteNumber(object, "createdAt"),
        validateFiniteNumber(object, "updatedAt"),
        validateInteger(object, "sequence"),
        validateBoolean(object, "agentActive"),
        validateBoolean(object, "turnActive"),
        validateBoolean(object, "providerActive"),
        validateBoolean(object, "toolActive"),
        validateOptionalFiniteNumber(object, "activeSince"),
        validateOptionalFiniteNumber(object, "waitingSince"),
        validateOptionalInteger(object, "turnIndex"),
        validateOptionalFiniteNumber(object, "toolStartedAt"),
        validateOptionalFiniteNumber(object, "toolEndedAt"),
        validateOptionalActivityString(object, "messageEventType"),
        validateOptionalActivityString(object, "toolCallId"),
        validateOptionalActivityString(object, "toolName"),
        validateOptionalActivityString(object, "settledAssistantId"),
        validateOptionalActivityString(object, "settledStopReason"),
        validateOptionalActivityString(object, "settledErrorMessage")
    ].find((error)=>error != null);
    if (validationError) return invalidActivity(validationError);
    return {
        ok: true,
        activity: object
    };
}
export function readSubagentActivityFile(activityFile, expectedRunningChildId) {
    if (!existsSync(activityFile)) return {
        ok: false,
        reason: "missing"
    };
    let parsed;
    try {
        parsed = JSON.parse(readFileSync(activityFile, "utf8"));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            ok: false,
            reason: "invalid",
            error: message
        };
    }
    return validateActivity(parsed, expectedRunningChildId);
}
export function writeSubagentActivityFile(activityFile, activity) {
    const dir = dirname(activityFile);
    mkdirSync(dir, {
        recursive: true
    });
    const tempFile = join(dir, `${activity.runningChildId}.json.${process.pid}.${activity.sequence}.tmp`);
    try {
        writeFileSync(tempFile, `${JSON.stringify(activity)}\n`, "utf8");
        renameSync(tempFile, activityFile);
    } catch (error) {
        try {
            unlinkSync(tempFile);
        } catch (cleanupError) {
            void cleanupError;
        }
        throw error;
    }
}
function createNoopRecorder() {
    return {
        sessionStart () {},
        input () {},
        beforeAgentStart () {},
        agentStart () {},
        agentEndWaiting () {},
        agentEndDone () {},
        agentSettled () {},
        turnStart () {},
        turnEnd () {},
        beforeProviderRequest () {},
        afterProviderResponse () {},
        messageUpdate () {},
        toolExecutionStart () {},
        toolCall () {},
        toolExecutionUpdate () {},
        toolResult () {},
        toolExecutionEnd () {},
        callerPing () {},
        subagentDone () {},
        sessionShutdown () {}
    };
}
function clearActiveState(activity) {
    activity.agentActive = false;
    activity.turnActive = false;
    activity.providerActive = false;
    activity.toolActive = false;
    delete activity.activeScope;
    delete activity.activeSince;
}
function refreshActiveScope(activity) {
    if (activity.toolActive) {
        activity.phase = "active";
        activity.activeScope = "tool";
        return;
    }
    if (activity.providerActive) {
        activity.phase = "active";
        activity.activeScope = "provider";
        return;
    }
    if (activity.turnActive) {
        activity.phase = "active";
        activity.activeScope = "turn";
        return;
    }
    if (activity.agentActive) {
        activity.phase = "active";
        activity.activeScope = "agent";
        return;
    }
    delete activity.activeScope;
    delete activity.activeSince;
}
function markActive(activity, scope, now, resetActiveSince = false) {
    activity.phase = "active";
    activity.activeScope = scope;
    if (activity.activeSince == null || resetActiveSince) activity.activeSince = now;
    delete activity.waitingSince;
}
export function createSubagentActivityRecorder(params) {
    const runningChildId = params.runningChildId?.trim();
    const activityFile = params.activityFile?.trim();
    const settledEventsFile = params.settledEventsFile?.trim();
    if (!runningChildId || !activityFile) return createNoopRecorder();
    const activityPath = activityFile;
    const now = params.now ?? (()=>Date.now());
    const createdAt = now();
    const activity = {
        version: 1,
        runningChildId,
        createdAt,
        updatedAt: createdAt,
        sequence: 0,
        latestEvent: "session_start",
        phase: "starting",
        agentActive: false,
        turnActive: false,
        providerActive: false,
        toolActive: false
    };
    let disabled = false;
    let failureCount = 0;
    let lastFlushAt = 0;
    let pendingFlush = null;
    function clearPendingFlush() {
        if (!pendingFlush) return;
        clearTimeout(pendingFlush);
        pendingFlush = null;
    }
    function disable() {
        disabled = true;
        clearPendingFlush();
    }
    function flushNow() {
        if (disabled) return;
        try {
            writeSubagentActivityFile(activityPath, activity);
            lastFlushAt = now();
            failureCount = 0;
        } catch  {
            failureCount += 1;
            if (failureCount >= MAX_WRITE_FAILURES) disable();
        }
    }
    function scheduleFlush() {
        if (disabled || pendingFlush) return;
        const remainingMs = Math.max(0, ACTIVITY_UPDATE_THROTTLE_MS - (now() - lastFlushAt));
        if (remainingMs === 0) {
            flushNow();
            return;
        }
        pendingFlush = setTimeout(()=>{
            pendingFlush = null;
            flushNow();
        }, remainingMs);
    }
    function record(latestEvent, update, flush) {
        if (disabled) return;
        if (flush === "immediate") clearPendingFlush();
        const observedAt = now();
        activity.latestEvent = latestEvent;
        activity.updatedAt = observedAt;
        activity.sequence += 1;
        update(activity, observedAt);
        if (flush === "immediate") flushNow();
        else scheduleFlush();
    }
    function markDone(latestEvent) {
        record(latestEvent, (current)=>{
            current.phase = "done";
            clearActiveState(current);
            delete current.waitingSince;
        }, "immediate");
        disable();
    }
    return {
        sessionStart () {
            record("session_start", (current)=>{
                current.phase = "starting";
                clearActiveState(current);
                delete current.waitingSince;
            }, "immediate");
        },
        input () {
            record("input", ()=>{}, "immediate");
        },
        beforeAgentStart () {
            record("before_agent_start", (current, observedAt)=>{
                current.agentActive = true;
                markActive(current, "agent", observedAt);
            }, "immediate");
        },
        agentStart () {
            record("agent_start", (current, observedAt)=>{
                current.agentActive = true;
                markActive(current, "agent", observedAt);
            }, "immediate");
        },
        agentEndWaiting () {
            record("agent_end", (current, observedAt)=>{
                clearActiveState(current);
                current.phase = "waiting";
                current.waitingSince = observedAt;
            }, "immediate");
        },
        agentEndDone () {
            markDone("agent_end");
        },
        agentSettled (details) {
            const autoExit = details.autoExit === true && (details.outcome === "clean" || details.outcome === "empty");
            record("agent_settled", (current, observedAt)=>{
                clearActiveState(current);
                current.phase = autoExit ? "done" : "waiting";
                if (autoExit) delete current.waitingSince;
                else current.waitingSince = observedAt;
                current.settledOutcome = details.outcome;
                current.settledAssistantId = details.assistantId;
                current.settledStopReason = details.stopReason;
                current.settledErrorMessage = details.errorMessage;
                current.settledEmpty = details.empty;
                if (details.turnIndex != null) current.turnIndex = details.turnIndex;
            }, "immediate");
            if (settledEventsFile) {
                try {
                    mkdirSync(dirname(settledEventsFile), {
                        recursive: true
                    });
                    const event = {
                        schema: 1,
                        childId: runningChildId,
                        sequence: activity.sequence,
                        recordedAt: activity.updatedAt,
                        outcome: details.outcome,
                        ...details.turnIndex == null ? {} : {
                            turnIndex: details.turnIndex
                        },
                        ...details.assistantId ? {
                            assistantId: details.assistantId
                        } : {},
                        ...details.stopReason ? {
                            stopReason: details.stopReason
                        } : {},
                        ...details.errorMessage ? {
                            errorMessage: details.errorMessage.slice(0, MAX_ACTIVITY_STRING_LENGTH)
                        } : {},
                        ...details.empty == null ? {} : {
                            empty: details.empty
                        }
                    };
                    appendFileSync(settledEventsFile, `${JSON.stringify(event)}\n`, "utf8");
                } catch  {}
            }
            if (autoExit) disable();
        },
        turnStart (turnIndex) {
            record("turn_start", (current, observedAt)=>{
                current.agentActive = true;
                current.turnActive = true;
                if (turnIndex != null) current.turnIndex = turnIndex;
                markActive(current, current.toolActive || current.providerActive ? current.activeScope ?? "turn" : "turn", observedAt);
            }, "immediate");
        },
        turnEnd (turnIndex) {
            record("turn_end", (current)=>{
                current.turnActive = false;
                current.providerActive = false;
                current.toolActive = false;
                if (turnIndex != null) current.turnIndex = turnIndex;
                refreshActiveScope(current);
            }, "immediate");
        },
        beforeProviderRequest () {
            record("before_provider_request", (current, observedAt)=>{
                current.providerActive = true;
                markActive(current, "provider", observedAt, true);
            }, "immediate");
        },
        afterProviderResponse () {
            record("after_provider_response", (current)=>{
                current.providerActive = false;
                refreshActiveScope(current);
            }, "immediate");
        },
        messageUpdate (messageEventType) {
            record("message_update", (current, observedAt)=>{
                current.agentActive = true;
                current.turnActive = true;
                current.messageEventType = messageEventType;
                if (!current.toolActive) markActive(current, "streaming", observedAt);
            }, "throttled");
        },
        toolExecutionStart (toolCallId, toolName) {
            record("tool_execution_start", (current, observedAt)=>{
                current.toolActive = true;
                current.toolCallId = toolCallId;
                current.toolName = toolName;
                current.toolStartedAt = observedAt;
                markActive(current, "tool", observedAt, true);
            }, "immediate");
        },
        toolCall (toolCallId, toolName) {
            record("tool_call", (current, observedAt)=>{
                current.toolActive = true;
                current.toolCallId = toolCallId ?? current.toolCallId;
                current.toolName = toolName ?? current.toolName;
                markActive(current, "tool", observedAt);
            }, "immediate");
        },
        toolExecutionUpdate (toolCallId, toolName) {
            record("tool_execution_update", (current, observedAt)=>{
                current.toolActive = true;
                current.toolCallId = toolCallId ?? current.toolCallId;
                current.toolName = toolName ?? current.toolName;
                markActive(current, "tool", observedAt);
            }, "throttled");
        },
        toolResult (toolCallId, toolName) {
            record("tool_result", (current)=>{
                current.toolCallId = toolCallId ?? current.toolCallId;
                current.toolName = toolName ?? current.toolName;
                refreshActiveScope(current);
            }, "immediate");
        },
        toolExecutionEnd (toolCallId, toolName) {
            record("tool_execution_end", (current, observedAt)=>{
                current.toolActive = false;
                current.toolCallId = toolCallId ?? current.toolCallId;
                current.toolName = toolName ?? current.toolName;
                current.toolEndedAt = observedAt;
                refreshActiveScope(current);
            }, "immediate");
        },
        callerPing () {
            markDone("caller_ping");
        },
        subagentDone () {
            markDone("subagent_done");
        },
        sessionShutdown (reason) {
            if (reason === "quit") markDone("session_shutdown");
            else disable();
        }
    };
}
