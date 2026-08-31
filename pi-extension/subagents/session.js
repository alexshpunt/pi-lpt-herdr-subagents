import { createRequire } from "node:module";
const requirePackage = createRequire(import.meta.url);
function loadCodingAgent() {
    let directory = dirname(new URL(import.meta.url).pathname);
    for(;;){
        const candidate = join(directory, "node_modules/@earendil-works/pi-coding-agent/dist/index.js");
        if (existsSync(candidate)) return requirePackage(candidate);
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }
    throw new Error("Unable to locate @earendil-works/pi-coding-agent runtime");
}
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
export function seedStandaloneSessionFile(params) {
    const header = {
        type: "session",
        version: 3,
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        cwd: params.childCwd
    };
    mkdirSync(dirname(params.childSessionFile), {
        recursive: true
    });
    writeFileSync(params.childSessionFile, `${JSON.stringify(header)}\n`, "utf8");
}
function getForkContentLines(parentSessionFile) {
    const raw = readFileSync(parentSessionFile, "utf8");
    const lines = raw.split("\n").filter((line)=>line.trim());
    let truncateAt = lines.length;
    for(let i = lines.length - 1; i >= 0; i--){
        try {
            const entry = JSON.parse(lines[i]);
            if (entry.type === "message" && entry.message?.role === "user") {
                truncateAt = i;
                break;
            }
        } catch  {}
    }
    return lines.slice(0, truncateAt).filter((line)=>{
        try {
            return JSON.parse(line).type !== "session";
        } catch  {
            return true;
        }
    });
}
export function createBtwSessionSnapshot(parentSessionFile, leafId) {
    const detached = loadCodingAgent().SessionManager.open(parentSessionFile);
    const childSessionFile = detached.createBranchedSession(leafId);
    if (!childSessionFile || !existsSync(childSessionFile)) {
        throw new Error("Pi did not persist the BTW child session");
    }
    return childSessionFile;
}
export function seedSubagentSessionFile(params) {
    const header = {
        type: "session",
        version: 3,
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        cwd: params.childCwd,
        parentSession: params.parentSessionFile
    };
    const contentLines = params.mode === "fork" ? getForkContentLines(params.parentSessionFile) : [];
    const lines = [
        JSON.stringify(header),
        ...contentLines
    ];
    mkdirSync(dirname(params.childSessionFile), {
        recursive: true
    });
    writeFileSync(params.childSessionFile, lines.join("\n") + "\n", "utf8");
}
export function createWorktreeSessionFork(params) {
    const source = loadCodingAgent().SessionManager.open(params.parentSessionFile);
    const temporaryFile = source.createBranchedSession(params.leafId);
    if (!temporaryFile || !existsSync(temporaryFile)) {
        throw new Error("Pi did not persist the worktree session fork");
    }
    try {
        const lines = readFileSync(temporaryFile, "utf8").split("\n").filter((line)=>line.trim());
        const header = JSON.parse(lines[0]);
        header.cwd = params.childCwd;
        header.parentSession = params.parentSessionFile;
        mkdirSync(dirname(params.childSessionFile), {
            recursive: true
        });
        writeFileSync(params.childSessionFile, [
            JSON.stringify(header),
            ...lines.slice(1)
        ].join("\n") + "\n", "utf8");
    } finally{
        rmSync(temporaryFile, {
            force: true
        });
    }
    loadCodingAgent().SessionManager.open(params.childSessionFile).appendCustomMessageEntry("pi-herdr-worktree-handoff", params.handoffMessage, true, {
        sourceSessionFile: params.parentSessionFile,
        childCwd: params.childCwd
    });
    return {
        sessionFile: params.childSessionFile,
        sourceSessionFile: params.parentSessionFile,
        handoffMessage: params.handoffMessage
    };
}
function parseEntry(line) {
    try {
        return JSON.parse(line);
    } catch (error) {
        throw new Error(`Invalid session entry: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function readEntries(sessionFile) {
    return readFileSync(sessionFile, "utf8").split("\n").filter((line)=>line.trim()).map(parseEntry);
}
function readEntriesTolerant(sessionFile) {
    if (!existsSync(sessionFile)) {
        return {
            entries: [],
            partialTrailingLine: false
        };
    }
    const lines = readFileSync(sessionFile, "utf8").split("\n").filter((line)=>line.trim());
    const entries = [];
    let partialTrailingLine = false;
    for(let index = 0; index < lines.length; index++){
        try {
            entries.push(parseEntry(lines[index]));
        } catch (error) {
            if (index === lines.length - 1) {
                partialTrailingLine = true;
                continue;
            }
            throw error;
        }
    }
    return {
        entries,
        partialTrailingLine
    };
}
export function captureSessionBaseline(sessionFile) {
    const { entries } = readEntriesTolerant(sessionFile);
    return {
        sessionFile,
        entryCount: entries.length,
        leafId: entries.length > 0 ? entries[entries.length - 1].id : null,
        assistantEntryIds: entries.filter((entry)=>entry.type === "message" && entry.message.role === "assistant").map((entry)=>entry.id)
    };
}
export function readEntriesAfterBaseline(sessionFile, baseline) {
    const read = readEntriesTolerant(sessionFile);
    return {
        entries: read.entries.slice(baseline.entryCount),
        partialTrailingLine: read.partialTrailingLine
    };
}
export function findNewestAppendedAssistant(entries) {
    for(let index = entries.length - 1; index >= 0; index--){
        const entry = entries[index];
        if (entry.type !== "message") continue;
        const message = entry.message;
        if (message.role !== "assistant") continue;
        const textBlocks = message.content.filter((block)=>block.type === "text" && typeof block.text === "string");
        const text = textBlocks.map((block)=>block.text).join("\n");
        const stopReason = message.stopReason;
        const errorMessage = message.errorMessage;
        return {
            id: entry.id,
            text: text.trim() ? text : null,
            contentLength: text.length,
            empty: !text.trim(),
            ...typeof stopReason === "string" ? {
                stopReason
            } : {},
            ...typeof errorMessage === "string" && errorMessage.trim() ? {
                errorMessage: errorMessage.trim()
            } : {}
        };
    }
    return null;
}
export function inspectNewestAppendedAssistant(sessionFile, baseline) {
    return findNewestAppendedAssistant(readEntriesAfterBaseline(sessionFile, baseline).entries);
}
export function getLeafId(sessionFile) {
    const entries = readEntries(sessionFile);
    return entries.length > 0 ? entries[entries.length - 1].id : null;
}
export function getNewEntries(sessionFile, afterLine) {
    return readFileSync(sessionFile, "utf8").split("\n").filter((line)=>line.trim()).slice(afterLine).map(parseEntry);
}
export function findObservedSessionRuntime(entries) {
    const observed = {};
    for (const entry of entries){
        if (entry.type === "model_change") {
            if (typeof entry.provider === "string") observed.provider = entry.provider;
            if (typeof entry.modelId === "string") observed.modelId = entry.modelId;
        } else if (entry.type === "thinking_level_change" && typeof entry.thinkingLevel === "string") {
            observed.thinking = entry.thinkingLevel;
        }
    }
    return observed;
}
export function inspectFinalAssistantMessage(entries) {
    for(let i = entries.length - 1; i >= 0; i--){
        const entry = entries[i];
        if (entry.type !== "message") continue;
        const msg = entry;
        if (msg.message.role !== "assistant") continue;
        const texts = msg.message.content.filter((block)=>block.type === "text" && typeof block.text === "string").map((block)=>block.text);
        const text = texts.join("\n");
        const stopReason = msg.message.stopReason;
        return {
            text: text.trim() ? text : null,
            contentLength: text.length,
            ...typeof stopReason === "string" ? {
                stopReason
            } : {}
        };
    }
    return {
        text: null,
        contentLength: 0
    };
}
export function findLastAssistantMessage(entries) {
    for(let i = entries.length - 1; i >= 0; i--){
        const entry = entries[i];
        if (entry.type !== "message") continue;
        const msg = entry;
        if (msg.message.role !== "assistant") continue;
        const texts = msg.message.content.filter((block)=>block.type === "text" && typeof block.text === "string" && block.text.trim() !== "").map((block)=>block.text);
        if (texts.length > 0 && texts.join("").trim()) return texts.join("\n");
        const stopReason = msg.message.stopReason;
        const errorMessage = msg.message.errorMessage;
        if (stopReason === "error" && typeof errorMessage === "string" && errorMessage.trim() !== "") {
            return `Subagent error: ${errorMessage.trim()}`;
        }
    }
    return null;
}
export function appendBranchSummary(sessionFile, branchPointId, fromId, summary) {
    const id = randomBytes(4).toString("hex");
    const entry = {
        type: "branch_summary",
        id,
        parentId: branchPointId,
        timestamp: new Date().toISOString(),
        fromId: fromId ?? branchPointId,
        summary
    };
    appendFileSync(sessionFile, JSON.stringify(entry) + "\n", "utf8");
    return id;
}
export function copySessionFile(sessionFile, destDir) {
    const id = randomBytes(4).toString("hex");
    const dest = join(destDir, `subagent-${id}.jsonl`);
    copyFileSync(sessionFile, dest);
    return dest;
}
export function mergeNewEntries(sourceFile, targetFile, afterLine) {
    const entries = getNewEntries(sourceFile, afterLine);
    for (const entry of entries){
        appendFileSync(targetFile, JSON.stringify(entry) + "\n", "utf8");
    }
    return entries;
}
