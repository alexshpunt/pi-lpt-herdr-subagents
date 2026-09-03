import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
function safeId(value) {
    return Buffer.from(value, "utf8").toString("base64url");
}
function eventDir(rootDir) {
    const dir = join(rootDir, "events");
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        fsyncDirectory(dirname(dir));
    }
    return dir;
}
function fsyncDirectory(path) {
    try {
        const fd = openSync(path, "r");
        try {
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
    }
    catch {
        // Some filesystems do not permit directory fsync. Publication remains atomic.
    }
}
function writeDurable(path, content) {
    const fd = openSync(path, "wx", 0o600);
    try {
        writeFileSync(fd, content, "utf8");
        fsyncSync(fd);
    }
    finally {
        closeSync(fd);
    }
}
/** Register a node before creating any Herdr pane or workspace. */
export function registerLineage(options) {
    const rootId = options.inheritedRootId ?? `lineage-${safeId(options.nodeId)}-${randomUUID()}`;
    const rootDir = options.inheritedRootDir ?? join(options.artifactDir, "lineage", rootId);
    if (options.parentNodeId === options.nodeId) {
        throw new Error(`Lineage integrity error: node ${options.nodeId} cannot be its own parent`);
    }
    if (options.inheritedRootDir && options.parentNodeId) {
        const inherited = reduceLineage(options.inheritedRootDir);
        const error = lineageIntegrityError(inherited);
        if (error)
            throw new Error(error);
        if (!inherited.nodes.has(options.parentNodeId)) {
            throw new Error(`Lineage integrity error: parent ${options.parentNodeId} does not exist`);
        }
    }
    mkdirSync(rootDir, { recursive: true });
    fsyncDirectory(dirname(rootDir));
    const registration = {
        rootDir,
        rootId,
        nodeId: options.nodeId,
        ...(options.parentNodeId ? { parentNodeId: options.parentNodeId } : {}),
        ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
        ...(options.parentSessionFile ? { parentSessionFile: options.parentSessionFile } : {}),
        ...(options.parentWorkflowRunId ? { parentWorkflowRunId: options.parentWorkflowRunId } : {}),
        launchKind: options.launchKind ?? "fresh",
    };
    appendLineageEvent(rootDir, `launch:${options.nodeId}`, "launch", options.nodeId, {
        rootId,
        parentNodeId: registration.parentNodeId,
        parentSessionId: registration.parentSessionId,
        parentSessionFile: registration.parentSessionFile,
        parentWorkflowRunId: registration.parentWorkflowRunId,
        launchKind: registration.launchKind,
    });
    return registration;
}
/**
 * Publish one immutable event atomically. link(2), rather than rename(2),
 * gives no-replace semantics when two Pi processes race on one effect ID.
 */
export function appendLineageEvent(rootDir, eventId, type, nodeId, data = {}) {
    if (!eventId || !type || !nodeId)
        return false;
    const dir = eventDir(rootDir);
    const encoded = safeId(eventId);
    const file = join(dir, `${encoded}.json`);
    const pending = join(dir, `.${encoded}.${process.pid}.${randomUUID()}.pending`);
    const event = {
        ...data,
        version: 1,
        eventId,
        type,
        nodeId,
        at: Date.now(),
    };
    try {
        writeDurable(pending, JSON.stringify(event));
        // Hard-link publication is exclusive and leaves the pending file harmless
        // if another process won the same stable ID.
        linkSync(pending, file);
        unlinkSync(pending);
        fsyncDirectory(dir);
        return true;
    }
    catch {
        try {
            unlinkSync(pending);
        }
        catch { }
        return false;
    }
}
function validEvent(value, fileName, rootId) {
    const e = value;
    if (!e || e.version !== 1 || typeof e.eventId !== "string" || !e.eventId ||
        typeof e.type !== "string" || !e.type || typeof e.nodeId !== "string" ||
        !e.nodeId || !Number.isFinite(e.at))
        return false;
    if (rootId && e.rootId !== undefined && e.rootId !== rootId)
        return false;
    if (fileName && fileName !== `${safeId(e.eventId)}.json`)
        return false;
    return true;
}
const eventRank = {
    launch: 0,
    launch_metadata: 1,
    cancel_intent: 2,
    cancel_identity: 3,
    cancel_proven: 4,
    settled_delivered: 5,
    terminal: 6,
    inbox: 7,
    terminal_delivered: 8,
    inbox_materialized: 9,
    cleanup_pending: 10,
    cleanup_done: 11,
};
/** Reduce valid immutable events deterministically; wall-clock order is ignored. */
export function reduceLineage(rootDir) {
    const rootId = rootDir.split(/[\\/]/).pop() ?? "unknown";
    const nodes = new Map();
    let events = 0;
    let files = [];
    try {
        files = readdirSync(join(rootDir, "events")).filter((f) => f.endsWith(".json"));
    }
    catch {
        return { rootId, nodes, events };
    }
    const parsed = [];
    for (const file of files) {
        try {
            const value = JSON.parse(readFileSync(join(rootDir, "events", file), "utf8"));
            if (validEvent(value, file, rootId))
                parsed.push(value);
        }
        catch { }
    }
    parsed.sort((a, b) => (eventRank[a.type] ?? 50) - (eventRank[b.type] ?? 50) || a.eventId.localeCompare(b.eventId));
    const launched = new Set();
    for (const event of parsed) {
        if (event.type !== "launch" && !launched.has(event.nodeId))
            continue;
        let node = nodes.get(event.nodeId);
        if (!node) {
            node = { nodeId: event.nodeId, settledDelivered: [] };
            nodes.set(event.nodeId, node);
        }
        if (event.type === "launch") {
            launched.add(event.nodeId);
            // First launch identity wins. A conflicting duplicate is not a legal
            // transition and cannot change the logical parent after publication.
            if (!node.parentNodeId && typeof event.parentNodeId === "string")
                node.parentNodeId = event.parentNodeId;
            if (!node.parentSessionId && typeof event.parentSessionId === "string")
                node.parentSessionId = event.parentSessionId;
            if (!node.parentSessionFile && typeof event.parentSessionFile === "string")
                node.parentSessionFile = event.parentSessionFile;
            if (!node.parentWorkflowRunId && typeof event.parentWorkflowRunId === "string")
                node.parentWorkflowRunId = event.parentWorkflowRunId;
            if (!node.launchKind && typeof event.launchKind === "string")
                node.launchKind = event.launchKind;
        }
        else if (event.type === "launch_metadata") {
            // Metadata may be rewritten by a resume. Prefer the latest recorded run;
            // this comparison is deterministic and does not use event publication time.
            const runStart = typeof event.startTime === "number" ? event.startTime : 0;
            if (node.startTime !== undefined && runStart < node.startTime)
                continue;
            if (typeof event.name === "string")
                node.name = event.name;
            if (typeof event.task === "string")
                node.task = event.task;
            if (typeof event.agent === "string")
                node.agent = event.agent;
            if (typeof event.surface === "string")
                node.surface = event.surface;
            if (typeof event.sessionFile === "string")
                node.sessionFile = event.sessionFile;
            if (typeof event.activityFile === "string")
                node.activityFile = event.activityFile;
            if (typeof event.settledEventsFile === "string")
                node.settledEventsFile = event.settledEventsFile;
            if (typeof event.startTime === "number")
                node.startTime = event.startTime;
            if (typeof event.interactive === "boolean")
                node.interactive = event.interactive;
            if (typeof event.workspaceId === "string")
                node.workspaceId = event.workspaceId;
            if (typeof event.cwd === "string")
                node.cwd = event.cwd;
        }
        else if (event.type === "cancel_intent" || event.type === "cancel_identity" || event.type === "cancel_proven") {
            const prior = node.cancellation ?? { intent: false, pids: [], proven: false };
            prior.intent = true;
            if (typeof event.surface === "string")
                prior.surface = event.surface;
            if (Array.isArray(event.pids)) {
                const pids = event.pids.filter((pid) => Number.isInteger(pid) && pid > 0);
                if (pids.length > 0)
                    prior.pids = [...new Set(pids)];
            }
            if (event.type === "cancel_proven")
                prior.proven = true;
            node.cancellation = prior;
        }
        else if (event.type === "terminal") {
            if (!node.terminal)
                node.terminal = {
                    outcome: typeof event.outcome === "string" ? event.outcome : "unknown",
                    resultId: typeof event.resultId === "string" ? event.resultId : undefined,
                    resultContent: typeof event.resultContent === "string" ? event.resultContent : undefined,
                };
        }
        else if (event.type === "terminal_delivered" || event.type === "inbox") {
            const kind = event.type === "inbox" ? event.kind : undefined;
            const payload = event.payload;
            if (node.terminal && (event.type === "terminal_delivered" || kind === "terminal" || payload?.kind === "terminal")) {
                node.terminalDelivered ??= String(event.deliveryId ?? event.eventId);
            }
        }
        else if (event.type === "settled_delivered" && typeof event.resultId === "string" && !node.settledDelivered.includes(event.resultId)) {
            node.settledDelivered.push(event.resultId);
        }
        else if (event.type === "cleanup_pending") {
            if (!node.terminalDelivered)
                continue;
            node.cleanupPending = true;
        }
        else if (event.type === "cleanup_done") {
            if (node.terminalDelivered)
                node.cleanupPending = false;
        }
        events++;
    }
    return { rootId, nodes, events };
}
/** Return an attributable graph error instead of treating a cycle as an endless drain. */
export function lineageIntegrityError(state) {
    for (const node of state.nodes.values()) {
        if (node.parentNodeId && !state.nodes.has(node.parentNodeId)) {
            return `Lineage integrity error: parent ${node.parentNodeId} of ${node.nodeId} does not exist`;
        }
        const path = new Set();
        let current = node;
        while (current?.parentNodeId) {
            if (path.has(current.nodeId) || current.parentNodeId === current.nodeId) {
                return `Lineage integrity error: cycle contains ${current.nodeId}`;
            }
            path.add(current.nodeId);
            current = state.nodes.get(current.parentNodeId);
        }
    }
    return undefined;
}
/** A node is drained only after terminal delivery and all recursive children. */
export function isLineageNodeDrained(state, nodeId) {
    const integrity = lineageIntegrityError(state);
    if (integrity)
        throw new Error(integrity);
    const visit = (id) => {
        const node = state.nodes.get(id);
        if (!node || !node.terminal || !node.terminalDelivered)
            return false;
        for (const child of state.nodes.values()) {
            if (child.parentNodeId === id && !visit(child.nodeId))
                return false;
        }
        return true;
    };
    return visit(nodeId);
}
export function hasUndrainedDescendants(state, nodeId) {
    const integrity = lineageIntegrityError(state);
    if (integrity)
        throw new Error(integrity);
    return [...state.nodes.values()].some((child) => child.parentNodeId === nodeId && !isLineageNodeDrained(state, child.nodeId));
}
/** Record the once-only durable sink entry used by the drain boundary. */
export function appendLineageInbox(rootDir, nodeId, deliveryId, sink, payload = {}) {
    if (!sink.workflowRunId && (!sink.sessionId || !sink.sessionFile))
        return false;
    const eventId = `inbox:${deliveryId}`;
    const file = join(eventDir(rootDir), `${safeId(eventId)}.json`);
    try {
        const existing = JSON.parse(readFileSync(file, "utf8"));
        if (validEvent(existing, `${safeId(eventId)}.json`, rootDir.split(/[\\/]/).pop()) && existing.type === "inbox" && existing.nodeId === nodeId)
            return true;
    }
    catch { }
    return appendLineageEvent(rootDir, eventId, "inbox", nodeId, {
        deliveryId,
        ...sink,
        payload,
    });
}
function materializationClaimDir(rootDir) {
    const dir = join(rootDir, "materialization-claims");
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
        fsyncDirectory(rootDir);
    }
    return dir;
}
function claimFile(rootDir, deliveryId) {
    return join(materializationClaimDir(rootDir), `${safeId(deliveryId)}.claim`);
}
function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === "EPERM";
    }
}
/** Linux process start time (field 22 of /proc/<pid>/stat). */
function processStartTime(pid) {
    if (process.platform !== "linux")
        return undefined;
    try {
        const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
        const closingParen = stat.lastIndexOf(")");
        const fields = closingParen >= 0 ? stat.slice(closingParen + 2).trim().split(/\s+/) : [];
        return fields[19] || undefined;
    }
    catch {
        return undefined;
    }
}
function currentProcessIncarnation() {
    const startTime = processStartTime(process.pid);
    return { pid: process.pid, ...(startTime ? { startTime } : {}) };
}
function exactSessionEvidence(check) {
    try {
        return check() === true;
    }
    catch {
        return false;
    }
}
function readMaterializationClaim(path, deliveryId, nodeId) {
    try {
        const value = JSON.parse(readFileSync(path, "utf8"));
        const identity = value.process ?? (Number.isInteger(value.pid) ? { pid: value.pid, startTime: value.startTime } : undefined);
        if (value.version !== 1 || value.deliveryId !== deliveryId || value.nodeId !== nodeId ||
            typeof value.token !== "string" || !identity || !Number.isInteger(identity.pid) || (identity.pid ?? 0) <= 0 ||
            (identity.startTime != null && typeof identity.startTime !== "string") || !Number.isFinite(value.claimedAt))
            return undefined;
        return { ...value, process: identity };
    }
    catch {
        return undefined;
    }
}
function readMaterializationGate(path) {
    try {
        const value = JSON.parse(readFileSync(path, "utf8"));
        if (value.version !== 1 || typeof value.token !== "string" || !value.process ||
            !Number.isInteger(value.process.pid) || value.process.pid <= 0 ||
            (value.process.startTime != null && typeof value.process.startTime !== "string") ||
            !Number.isFinite(value.claimedAt))
            return undefined;
        return value;
    }
    catch {
        return undefined;
    }
}
function processIncarnationAlive(identity, observer) {
    if (!processAlive(identity.pid))
        return false;
    const observed = identity.pid === observer.pid ? observer : { pid: identity.pid, startTime: processStartTime(identity.pid) };
    // Portable filesystems/platforms may not expose an incarnation identity. Do
    // not reclaim a live PID unless its identity can be disproved.
    if (!identity.startTime || !observed.startTime)
        return true;
    return identity.startTime === observed.startTime;
}
function materializationGateFile(rootDir) {
    return join(materializationClaimDir(rootDir), "lineage.gate");
}
function acquireMaterializationGate(rootDir, observer) {
    const path = materializationGateFile(rootDir);
    for (let attempt = 0; attempt < 3; attempt += 1) {
        const token = randomUUID();
        const pending = join(dirname(path), `.${process.pid}.${randomUUID()}.gate.pending`);
        try {
            writeDurable(pending, JSON.stringify({ version: 1, token, process: observer, claimedAt: Date.now() }));
            linkSync(pending, path);
            unlinkSync(pending);
            fsyncDirectory(dirname(path));
            return { token };
        }
        catch {
            try {
                unlinkSync(pending);
            }
            catch { }
        }
        const current = readMaterializationGate(path);
        if (!current && existsSync(path))
            return null;
        if (current && processIncarnationAlive(current.process, observer))
            return null;
        try {
            const tombstone = `${path}.${process.pid}.${randomUUID()}.stale`;
            renameSync(path, tombstone);
            try {
                unlinkSync(tombstone);
            }
            catch { }
        }
        catch { }
    }
    return null;
}
function releaseMaterializationGate(rootDir, token) {
    const path = materializationGateFile(rootDir);
    const current = readMaterializationGate(path);
    if (current?.token === token)
        try {
            unlinkSync(path);
        }
        catch { }
}
function readLineageInboxes(rootDir) {
    const result = [];
    const materialized = new Set();
    let files = [];
    try {
        files = readdirSync(join(rootDir, "events")).filter((f) => f.endsWith(".json"));
    }
    catch {
        return result;
    }
    const records = [];
    for (const file of files) {
        try {
            const value = JSON.parse(readFileSync(join(rootDir, "events", file), "utf8"));
            if (!validEvent(value, file, rootDir.split(/[\\/]/).pop()))
                continue;
            if (value.type === "inbox_materialized" && typeof value.deliveryId === "string")
                materialized.add(value.deliveryId);
            if (value.type !== "inbox" || typeof value.deliveryId !== "string")
                continue;
            const payload = value.payload && typeof value.payload === "object" ? value.payload : {};
            records.push({ rootDir, nodeId: value.nodeId, deliveryId: value.deliveryId, sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined, sessionFile: typeof value.sessionFile === "string" ? value.sessionFile : undefined, workflowRunId: typeof value.workflowRunId === "string" ? value.workflowRunId : undefined, payload, activitySequence: typeof payload.activitySequence === "number" ? payload.activitySequence : undefined });
        }
        catch { }
    }
    return records.map((record) => ({ record, materialized: materialized.has(record.deliveryId) }));
}
function sameMaterializationSink(left, right) {
    return left.workflowRunId ? left.workflowRunId === right.workflowRunId :
        Boolean(left.sessionId && left.sessionFile && left.sessionId === right.sessionId && left.sessionFile === right.sessionFile);
}
function pendingBefore(rootDir, deliveryId) {
    const entries = readLineageInboxes(rootDir);
    const target = entries.find((entry) => entry.record.deliveryId === deliveryId)?.record;
    if (!target)
        return false;
    const pending = entries.filter((entry) => !entry.materialized && sameMaterializationSink(entry.record, target)).map((entry) => entry.record);
    pending.sort((left, right) => (left.activitySequence ?? Number.MAX_SAFE_INTEGER) - (right.activitySequence ?? Number.MAX_SAFE_INTEGER) || left.deliveryId.localeCompare(right.deliveryId));
    return pending.findIndex((record) => record.deliveryId === deliveryId) > 0;
}
/**
 * Acquire the cross-process claim used before materializing one inbox entry.
 * The durable lineage gate makes all delivery IDs for one sink observe the
 * same activity order, not merely one claim per delivery.
 */
export function claimLineageInboxMaterialization(options) {
    const { rootDir, deliveryId, nodeId } = options;
    if (isLineageInboxMaterialized(rootDir, deliveryId))
        return { status: "materialized" };
    const observer = options.processIdentity ?? currentProcessIncarnation();
    const gate = acquireMaterializationGate(rootDir, observer);
    if (!gate)
        return { status: "busy" };
    try {
        if (isLineageInboxMaterialized(rootDir, deliveryId))
            return { status: "materialized" };
        const path = claimFile(rootDir, deliveryId);
        const existing = readMaterializationClaim(path, deliveryId, nodeId);
        if (existing) {
            if (exactSessionEvidence(options.hasExactSessionEvidence)) {
                if (appendLineageEvent(rootDir, `materialized:${deliveryId}`, "inbox_materialized", nodeId, { deliveryId })) {
                    try {
                        unlinkSync(path);
                    }
                    catch { }
                    return { status: "materialized" };
                }
                return isLineageInboxMaterialized(rootDir, deliveryId) ? { status: "materialized" } : { status: "busy" };
            }
            if (processIncarnationAlive(existing.process, observer))
                return { status: "busy" };
            try {
                const tombstone = `${path}.${process.pid}.${randomUUID()}.stale`;
                renameSync(path, tombstone);
                try {
                    unlinkSync(tombstone);
                }
                catch { }
            }
            catch {
                return { status: "busy" };
            }
        }
        if (pendingBefore(rootDir, deliveryId))
            return { status: "busy" };
        const token = randomUUID();
        const pending = join(dirname(path), `.${safeId(deliveryId)}.${process.pid}.${randomUUID()}.pending`);
        try {
            writeDurable(pending, JSON.stringify({ version: 1, deliveryId, nodeId, token, process: observer, claimedAt: Date.now() }));
            linkSync(pending, path);
            unlinkSync(pending);
            fsyncDirectory(dirname(path));
            return { status: "acquired", token };
        }
        catch {
            try {
                unlinkSync(pending);
            }
            catch { }
            return { status: "busy" };
        }
    }
    finally {
        releaseMaterializationGate(rootDir, gate.token);
    }
}
/** Acknowledge a materialization and release only the claim held by this observer. */
export function completeLineageInboxMaterialization(rootDir, deliveryId, nodeId, token) {
    const acknowledged = appendLineageEvent(rootDir, `materialized:${deliveryId}`, "inbox_materialized", nodeId, { deliveryId }) ||
        isLineageInboxMaterialized(rootDir, deliveryId);
    if (!acknowledged)
        return false;
    const path = claimFile(rootDir, deliveryId);
    const claim = readMaterializationClaim(path, deliveryId, nodeId);
    return claim?.token === token || isLineageInboxMaterialized(rootDir, deliveryId);
}
/** Release a failed claim only after exact-session evidence is checked. */
export function releaseLineageInboxMaterialization(options) {
    if (isLineageInboxMaterialized(options.rootDir, options.deliveryId))
        return true;
    if (exactSessionEvidence(options.hasExactSessionEvidence)) {
        return completeLineageInboxMaterialization(options.rootDir, options.deliveryId, options.nodeId, options.token);
    }
    const path = claimFile(options.rootDir, options.deliveryId);
    const claim = readMaterializationClaim(path, options.deliveryId, options.nodeId);
    if (claim?.token !== options.token)
        return false;
    try {
        unlinkSync(path);
    }
    catch { }
    return true;
}
/** Return whether an inbox has a durable materialization acknowledgement. */
export function isLineageInboxMaterialized(rootDir, deliveryId) {
    let files = [];
    try {
        files = readdirSync(join(rootDir, "events")).filter((f) => f.endsWith(".json"));
    }
    catch {
        return false;
    }
    for (const file of files) {
        try {
            const value = JSON.parse(readFileSync(join(rootDir, "events", file), "utf8"));
            if (validEvent(value, file, rootDir.split(/[\\/]/).pop()) && value.type === "inbox_materialized" && value.deliveryId === deliveryId)
                return true;
        }
        catch { }
    }
    return false;
}
/** Return whether a specific immutable event was already published. */
export function hasLineageEvent(rootDir, eventId, type) {
    const file = join(eventDir(rootDir), `${safeId(eventId)}.json`);
    try {
        const value = JSON.parse(readFileSync(file, "utf8"));
        return validEvent(value, `${safeId(eventId)}.json`, rootDir.split(/[\\/]/).pop()) && value.eventId === eventId && (!type || value.type === type);
    }
    catch {
        return false;
    }
}
/** Find durable inbox entries not yet materialized for their exact session sink. */
export function pendingLineageInboxes(rootDir, sessionId, sessionFile) {
    const pending = [];
    let files = [];
    try {
        files = readdirSync(join(rootDir, "events")).filter((f) => f.endsWith(".json"));
    }
    catch {
        return pending;
    }
    const materialized = new Set();
    const inboxes = [];
    for (const file of files) {
        try {
            const value = JSON.parse(readFileSync(join(rootDir, "events", file), "utf8"));
            if (!validEvent(value, file, rootDir.split(/[\\/]/).pop()))
                continue;
            if (value.type === "inbox_materialized" && typeof value.deliveryId === "string")
                materialized.add(value.deliveryId);
            else if (value.type === "inbox" && value.sessionId === sessionId && value.sessionFile === sessionFile && typeof value.deliveryId === "string") {
                const payload = value.payload && typeof value.payload === "object" ? value.payload : {};
                inboxes.push({ rootDir, nodeId: value.nodeId, deliveryId: value.deliveryId, sessionId, sessionFile, payload, activitySequence: typeof payload.activitySequence === "number" ? payload.activitySequence : undefined });
            }
        }
        catch { }
    }
    for (const inbox of inboxes)
        if (!materialized.has(inbox.deliveryId))
            pending.push(inbox);
    return pending.sort((a, b) => (a.activitySequence ?? Number.MAX_SAFE_INTEGER) - (b.activitySequence ?? Number.MAX_SAFE_INTEGER) || a.deliveryId.localeCompare(b.deliveryId));
}
/** Read the authoritative lineage pointer attached to a child session. */
export function readLineageAttachment(sessionFile) {
    try {
        const value = JSON.parse(readFileSync(`${sessionFile}.lineage.json`, "utf8"));
        if (typeof value.rootDir !== "string" || typeof value.rootId !== "string" || typeof value.nodeId !== "string")
            return undefined;
        if (!existsSync(join(value.rootDir, "events")))
            return undefined;
        return value;
    }
    catch {
        return undefined;
    }
}
/** Discover durable roots, preferring session attachments over directory guesses. */
export function discoverLineageRoots(sessionDir, sessionFile) {
    const result = new Set();
    if (sessionFile) {
        const attachment = readLineageAttachment(sessionFile);
        if (attachment)
            result.add(attachment.rootDir);
    }
    try {
        for (const entry of readdirSync(sessionDir, { withFileTypes: true })) {
            if (entry.isFile() && entry.name.endsWith(".lineage.json")) {
                const attachment = readLineageAttachment(join(sessionDir, entry.name.slice(0, -".lineage.json".length)));
                if (attachment)
                    result.add(attachment.rootDir);
            }
        }
    }
    catch { }
    try {
        for (const artifact of readdirSync(join(sessionDir, "artifacts"), { withFileTypes: true })) {
            if (!artifact.isDirectory())
                continue;
            const lineageDir = join(sessionDir, "artifacts", artifact.name, "lineage");
            for (const root of readdirSync(lineageDir, { withFileTypes: true })) {
                if (root.isDirectory())
                    result.add(join(lineageDir, root.name));
            }
        }
    }
    catch { }
    return [...result].sort();
}
export function lineageEnvironment(registration) {
    return {
        PI_SUBAGENT_LINEAGE_DIR: registration.rootDir,
        PI_SUBAGENT_LINEAGE_ROOT: registration.rootId,
        ...(registration.parentNodeId ? { PI_SUBAGENT_PARENT_NODE: registration.parentNodeId } : {}),
    };
}
export function lineageFromEnvironment(env = process.env) {
    if (!env.PI_SUBAGENT_LINEAGE_DIR || !env.PI_SUBAGENT_LINEAGE_ROOT || !env.PI_SUBAGENT_ID)
        return undefined;
    return {
        rootDir: env.PI_SUBAGENT_LINEAGE_DIR,
        rootId: env.PI_SUBAGENT_LINEAGE_ROOT,
        nodeId: env.PI_SUBAGENT_ID,
        ...(env.PI_SUBAGENT_PARENT_NODE ? { parentNodeId: env.PI_SUBAGENT_PARENT_NODE } : {}),
    };
}
