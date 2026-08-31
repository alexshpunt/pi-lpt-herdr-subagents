import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { discoverAgentCatalog, effectiveRoleTools, resolveAgent } from "./pi-extension/subagents/role-catalog.js";
import { loadModelConfig, resolveModelDefault } from "./pi-extension/subagents/model-config.js";
import { resolveRuntimePlan, wrapPiModelRegistry } from "./pi-extension/subagents/runtime-routing.js";
const TREE_REGISTRY = Symbol.for("pi-lpt-herdr-subagents/public-tree/v2");
const PROCESS_ID = Symbol.for("pi-lpt-herdr-subagents/public-tree/process");
const MAX_METADATA = 64 * 1024;
const MAX_ERROR = 4000;
const MAX_SESSION = 10000;
const CANCEL_TIMEOUT_MS = 10000;
export class SubagentTreeError extends Error {
    constructor(message){
        super(message);
        this.name = "SubagentTreeError";
    }
}
export class SubagentTreeValidationError extends SubagentTreeError {
    constructor(message){
        super(message);
        this.name = "SubagentTreeValidationError";
    }
}
export class SubagentTreeOwnershipError extends SubagentTreeError {
    constructor(message){
        super(message);
        this.name = "SubagentTreeOwnershipError";
    }
}
function processIdentity() {
    const g = globalThis;
    return g[PROCESS_ID] ??= `${process.pid}-${randomUUID()}`;
}
function registry() {
    const g = globalThis;
    return g[TREE_REGISTRY] ??= new Map();
}
const stateKey = (tree, owner)=>`${tree}:${owner}`;
const readJson = (path)=>{
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch  {
        return undefined;
    }
};
function atomic(path, value) {
    mkdirSync(dirname(path), {
        recursive: true
    });
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(value)}\n`);
    renameSync(tmp, path);
}
function exclusiveAtomic(path, value) {
    mkdirSync(dirname(path), {
        recursive: true
    });
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        writeFileSync(tmp, `${JSON.stringify(value)}\n`);
        linkSync(tmp, path);
        return true;
    } catch (e) {
        if (e.code === "EEXIST") return false;
        throw e;
    } finally{
        try {
            unlinkSync(tmp);
        } catch  {}
    }
}
const bounded = (s, n)=>s.length <= n ? s : s.slice(0, n);
const message = (e)=>e instanceof Error ? e.message : String(e);
function metadata(value) {
    let encoded;
    try {
        encoded = JSON.stringify(value);
    } catch (e) {
        throw new SubagentTreeValidationError(`metadata must be JSON-compatible: ${message(e)}`);
    }
    if (encoded === undefined) throw new SubagentTreeValidationError("metadata must be JSON-compatible");
    if (Buffer.byteLength(encoded, "utf8") > MAX_METADATA) throw new SubagentTreeValidationError("metadata exceeds the 64 KiB limit");
    return deepFreeze({
        value: JSON.parse(encoded)
    });
}
function identityMetadata(base, meta, ownerId, nodeId, parentId) {
    return deepFreeze({
        ...base,
        callerId: meta.callerId,
        treeId: meta.treeId,
        ownerId,
        ...nodeId ? {
            nodeId
        } : {},
        ...parentId ? {
            parentId
        } : {}
    });
}
function context(ctx) {
    const m = ctx.sessionManager;
    const file = m.getSessionFile();
    if (!file) throw new SubagentTreeValidationError("No session file");
    return {
        sessionFile: file,
        sessionId: m.getSessionId(),
        sessionDir: m.getSessionDir(),
        cwd: ctx.cwd ?? process.cwd(),
        agentDir: process.env.PI_CODING_AGENT_DIR
    };
}
function ownerSession(meta, owner) {
    if (owner === meta.callerId) return meta.boundSessionFile;
    return readJson(join(meta.treeDir, "nodes", `${owner}.json`))?.sessionFile;
}
function header(path) {
    try {
        const x = JSON.parse(readFileSync(path, "utf8").split("\n", 1)[0]);
        return typeof x.parentSession === "string" ? x.parentSession : undefined;
    } catch  {
        return undefined;
    }
}
function findTreeMeta(sessionDir, treeId) {
    const root = join(sessionDir, "artifacts");
    if (!existsSync(root)) return;
    for (const sid of readdirSync(root)){
        const p = join(root, sid, "subagent-trees", treeId, "tree.json"), m = readJson(p);
        if (m) return m;
    }
    return;
}
function validateLineage(meta, owner, ctx, lineage, bound) {
    const fresh = context(ctx).sessionFile;
    if (lineage === undefined) return fresh;
    if (typeof lineage.previousSessionFile !== "string" || !lineage.previousSessionFile) throw new SubagentTreeOwnershipError("fork lineage previousSessionFile is required");
    const prior = bound ?? ownerSession(meta, owner);
    if (!prior || prior !== lineage.previousSessionFile) throw new SubagentTreeOwnershipError("fork lineage does not match the currently bound session");
    if (header(fresh) !== lineage.previousSessionFile) throw new SubagentTreeOwnershipError("fork session header does not match the previous session");
    return fresh;
}
function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code !== "ESRCH";
    }
}
function reclaimDeadClaim(path, owner) {
    for(;;){
        if (exclusiveAtomic(path, owner)) return true;
        const old = readJson(path);
        if (old?.process === owner.process) return false;
        if (typeof old?.pid === "number" && processAlive(old.pid)) return false;
        let before;
        try {
            const st = statSync(path);
            before = {
                dev: st.dev,
                ino: st.ino
            };
        } catch  {
            continue;
        }
        const moved = `${path}.${processIdentity()}.${randomUUID()}.stale`;
        try {
            renameSync(path, moved);
        } catch  {
            continue;
        }
        let same = false;
        try {
            const st = statSync(moved);
            same = st.dev === before.dev && st.ino === before.ino;
        } catch  {}
        if (!same) {
            try {
                if (!existsSync(path)) renameSync(moved, path);
            } catch  {}
            continue;
        }
        try {
            unlinkSync(moved);
        } catch  {}
    }
}
function claimBranch(meta, owner) {
    const p = join(meta.treeDir, "branches", `${owner}.claim`), identity = {
        process: processIdentity(),
        pid: process.pid,
        owner,
        token: randomUUID()
    };
    if (reclaimDeadClaim(p, identity)) return;
    throw new SubagentTreeOwnershipError("subagent branch is owned by another process");
}
function claimRoot(s) {
    const p = join(s.meta.treeDir, "root.claim"), identity = {
        process: processIdentity(),
        pid: process.pid,
        token: randomUUID()
    };
    if (exclusiveAtomic(p, identity)) return;
    const old = readJson(p);
    if (old?.process === identity.process) throw new SubagentTreeOwnershipError("subagent tree already has a direct root");
    if (readdirSync(join(s.meta.treeDir, "nodes")).some((x)=>x.endsWith(".json"))) throw new SubagentTreeOwnershipError("subagent tree already has a direct root");
    if (reclaimDeadClaim(p, identity)) return;
    throw new SubagentTreeOwnershipError("subagent tree already has a direct root");
}
function deferred() {
    let resolve;
    const promise = new Promise((r)=>{
        resolve = r;
    });
    return {
        promise,
        resolve
    };
}
function nodePath(s, id) {
    return join(s.meta.treeDir, "nodes", `${id}.json`);
}
function inflightPath(s, id) {
    return join(s.meta.treeDir, "branches", `${s.ownerId}.${id}.inflight.json`);
}
function clearInflight(s, id, token) {
    const p = inflightPath(s, id), record = readJson(p);
    if (record?.token === token) try {
        unlinkSync(p);
    } catch  {}
}
function inflightRecords(s) {
    const dir = join(s.meta.treeDir, "branches");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((x)=>x.endsWith(".inflight.json")).flatMap((x)=>{
        const path = join(dir, x), r = readJson(path);
        return r ? [
            {
                path,
                ...r
            }
        ] : [
            {
                path
            }
        ];
    });
}
function writeNode(s, node) {
    atomic(nodePath(s, node.nodeId), node);
}
function terminalIntentPath(s) {
    return join(s.meta.treeDir, "terminal-intent.json");
}
function claimTerminalIntent(s, kind) {
    return exclusiveAtomic(terminalIntentPath(s), {
        kind,
        ownerId: s.ownerId,
        process: processIdentity(),
        terminalId: randomUUID(),
        at: Date.now()
    });
}
function currentTerminalIntent(s) {
    return readJson(terminalIntentPath(s))?.kind;
}
function branchNodes(s) {
    const d = join(s.meta.treeDir, "nodes");
    if (!existsSync(d)) return [];
    return readdirSync(d).filter((x)=>x.endsWith(".json")).flatMap((f)=>{
        const n = readJson(join(d, f));
        return n?.ownerId === s.ownerId ? [
            n
        ] : [];
    });
}
async function waitBranchTransactions(s) {
    const deadline = Date.now() + CANCEL_TIMEOUT_MS;
    while(s.launchTransactions.size && Date.now() < deadline)await new Promise((r)=>setTimeout(r, 25));
    return s.launchTransactions.size === 0;
}
async function cancelBranch(s) {
    if (s.branchCancellation) return s.branchCancellation;
    s.cancellationRequested = true;
    s.branchCancellation = (async () => {
        const mux = await import("./pi-extension/subagents/terminal.js");
        for (const controller of s.launchControllers) controller.abort();
        const transactionsSettled = await waitBranchTransactions(s), pids = new Set(), nodePids = new Map();
        for (const n of branchNodes(s)) {
            if (n.open === false) continue;
            if (!n.surface) {
                if (n.status !== "settled") {
                    const result = writeResult(s, n, failedResult("tree_cancelled", "queued child cancelled", n.metadata));
                    s.pending.get(n.nodeId)?.resolve(result);
                }
                continue;
            }
            if (n.status !== "settled") try {
                const info = mux.getPaneProcessInfo(n.surface), captured = info.pids.filter((pid) => Number.isInteger(pid) && pid > 0);
                for (const pid of captured) pids.add(pid);
                if (captured.length) nodePids.set(n.nodeId, captured);
            } catch { }
            try { mux.closePane(n.surface); } catch { }
            try { n.open = !(await mux.waitForPaneAbsence(n.surface, { timeoutMs: 5000 })); } catch (e) { n.open = !/pane_not_found|pane not found/i.test(message(e)); }
            if (n.status !== "settled") {
                const result = writeResult(s, n, failedResult("tree_cancelled", "running child cancelled", n.metadata));
                s.pending.get(n.nodeId)?.resolve(result);
            } else writeNode(s, n);
        }
        let remaining = [];
        let processCheckConfirmed = true;
        try { remaining = await mux.waitForProcessesExit([...pids], { timeoutMs: 5000 }); } catch { processCheckConfirmed = false; }
        const inflight = inflightRecords(s).filter((r) => r.ownerId === s.ownerId), ack = { ownerId: s.ownerId, process: processIdentity(), pid: process.pid, at: Date.now(), transactionsSettled, inflight: inflight.length, remainingPids: remaining, nodes: branchNodes(s).map((n) => ({ nodeId: n.nodeId, open: n.open ?? false })) };
        if (!existsSync(join(s.meta.treeDir, "branches", `${s.ownerId}.cancelled.json`))) atomic(join(s.meta.treeDir, "branches", `${s.ownerId}.cancelled.json`), ack);
        if (s.ownerId === s.meta.callerId && processCheckConfirmed && !remaining.length) for (const n of branchNodes(s)) {
            // The root may close a child branch before it can publish its own acknowledgement.
            // Captured process exit plus pane absence is equivalent termination evidence.
            const captured = nodePids.get(n.nodeId);
            if (!captured?.length || n.open !== false || captured.some((pid) => remaining.includes(pid))) continue;
            const childAckPath = join(s.meta.treeDir, "branches", `${n.nodeId}.cancelled.json`);
            if (!existsSync(childAckPath)) atomic(childAckPath, { ownerId: n.nodeId, process: processIdentity(), pid: process.pid, at: Date.now(), transactionsSettled: true, inflight: 0, remainingPids: [], nodes: [{ nodeId: n.nodeId, open: false }] });
        }
    })();
    return s.branchCancellation;
}
function writeResult(s, node, result) {
    const frozen = deepFreeze(result);
    if (!exclusiveAtomic(node.resultPath, frozen)) {
        const winner = readJson(node.resultPath);
        if (winner) {
            atomic(nodePath(s, node.nodeId), {
                ...node,
                status: "settled"
            });
            return deepFreeze(winner);
        }
        return frozen;
    }
    atomic(nodePath(s, node.nodeId), {
        ...node,
        status: "settled"
    });
    return frozen;
}
function isCancelled(s) {
    return s.cancellationRequested || existsSync(join(s.meta.treeDir, "cancel.request"));
}
function failedResult(code, msg, meta) {
    return {
        resultId: randomUUID(),
        assistantEntryId: randomUUID(),
        answer: null,
        outcome: "unexpected-abort",
        error: {
            code,
            message: bounded(msg, MAX_ERROR)
        },
        ...meta ? {
            metadata: meta
        } : {}
    };
}
function rows(s) {
    const d = join(s.meta.treeDir, "nodes");
    if (!existsSync(d)) return [];
    return readdirSync(d).filter((x)=>x.endsWith(".json")).sort().flatMap((f)=>{
        const n = readJson(join(d, f));
        if (!n) return [];
        const r = readJson(n.resultPath);
        return [
            {
                nodeId: n.nodeId,
                parentId: n.parentId,
                outcome: r?.outcome ?? "unexpected-abort",
                open: n.open ?? (r?.outcome !== "clean" && r?.outcome !== "empty"),
                ...n.sessionFile ? {
                    sessionReference: bounded(n.sessionFile, MAX_SESSION)
                } : {},
                ...r?.error ? {
                    error: r.error
                } : {}
            }
        ];
    });
}
function rootResult(s) {
    const d = join(s.meta.treeDir, "nodes");
    if (!existsSync(d)) return undefined;
    const roots = readdirSync(d).filter((x)=>x.endsWith(".json")).map((f)=>readJson(join(d, f))).filter((n)=>Boolean(n && n.parentId === s.meta.callerId));
    if (roots.length !== 1) return undefined;
    return readJson(roots[0].resultPath);
}
async function authoritative(s, candidate) {
    const terminalPath = join(s.meta.treeDir, "terminal.json");
    if (exclusiveAtomic(terminalPath, candidate)) return candidate;
    for(;;){
        const record = readJson(terminalPath);
        if (record) return record;
        await new Promise((r)=>setTimeout(r, 10));
    }
}
function adopt(s, r) {
    if (s.terminal) return;
    s.terminal = deepFreeze(r);
    s.resolveTree(s.terminal);
    void deliver(s, s.terminal);
}
async function finish(s, r) {
    adopt(s, await authoritative(s, r));
}
async function closeCleanPanes(s) {
    const terminal = await import("./pi-extension/subagents/terminal.js"), dir = join(s.meta.treeDir, "nodes");
    for (const f of readdirSync(dir).filter((x)=>x.endsWith(".json"))){
        const n = readJson(join(dir, f)), r = n ? readJson(n.resultPath) : undefined;
        if (!n || !r || !n.surface || r.worktree || r.outcome !== "clean" && r.outcome !== "empty" || n.open === false) continue;
        try {
            terminal.closePane(n.surface);
            n.open = !await terminal.waitForPaneAbsence(n.surface, {
                timeoutMs: 5000
            });
            writeNode(s, n);
        } catch  {
            n.open = true;
            writeNode(s, n);
        }
    }
}
async function maybeFinish(s) {
    if (s.terminal || s.ownerId !== s.meta.callerId) return;
    const existing = readJson(join(s.meta.treeDir, "terminal.json"));
    if (existing) {
        adopt(s, existing);
        return;
    }
    if (isCancelled(s) || currentTerminalIntent(s) === "cancelled") return;
    const root = rootResult(s);
    if (!root) return;
    let all = rows(s);
    if (all.some((r)=>!readJson(join(s.meta.treeDir, "results", `${r.nodeId}.json`)))) return;
    if (!claimTerminalIntent(s, "completed")) {
        if (currentTerminalIntent(s) !== "completed") return;
        return;
    }
    await closeCleanPanes(s);
    all = rows(s);
    const state = root.outcome === "clean" || root.outcome === "empty" ? "completed" : "failed";
    await finish(s, {
        terminalId: randomUUID(),
        state,
        rootResult: root,
        callerMetadata: s.meta.callerMetadata,
        nodes: all
    });
}
async function deliverAttempt(s, r) {
    if (!s.callback || existsSync(join(s.meta.treeDir, "delivery.done"))) return;
    const claimPath = join(s.meta.treeDir, "delivery.claim"), claim = {
        process: processIdentity(),
        pid: process.pid,
        token: randomUUID(),
        terminalId: r.terminalId,
        version: s.callbackVersion
    };
    if (!reclaimDeadClaim(claimPath, claim)) return;
    const callback = s.callback;
    try {
        if (!callback) return;
        await callback(r);
        if (!existsSync(join(s.meta.treeDir, "delivery.done"))) writeFileSync(join(s.meta.treeDir, "delivery.done"), `${r.terminalId}\n`, {
            flag: "wx"
        });
    } catch  {} finally{
        const held = readJson(claimPath);
        if (!existsSync(join(s.meta.treeDir, "delivery.done")) && held?.token === claim.token) try {
            unlinkSync(claimPath);
        } catch  {}
    }
}
async function deliver(s, r) {
    const attempt = s.deliverySerial.then(()=>deliverAttempt(s, r));
    s.deliverySerial = attempt.catch(()=>{});
    return attempt;
}
async function watch(s, node, running, pending) {
    const [{ waitForCompletion }, terminal, session, activity, launchModule] = await Promise.all([
        import("./pi-extension/subagents/completion.js"),
        import("./pi-extension/subagents/terminal.js"),
        import("./pi-extension/subagents/session.js"),
        import("./pi-extension/subagents/activity.js"),
        import("./pi-extension/subagents/launch.js")
    ]);
    const abort = new AbortController();
    try {
        const completion = await Promise.race([
            waitForCompletion(abort.signal, {
                intervalMs: 100,
                sessionFile: running.sessionFile,
                readTerminalTail: ()=>terminal.readPaneAsync(running.surface, 5),
                inspectPane: ()=>terminal.inspectPane(running.surface)
            }),
            (async ()=>{
                for(;;){
                    if (isCancelled(s)) throw new Error("tree cancellation requested");
                    const e = activity.readSubagentSettledEventsFile(running.settledEventsFile, running.id).at(-1);
                    if (e?.outcome === "error") return {
                        reason: "error",
                        exitCode: 1,
                        errorMessage: e.errorMessage
                    };
                    if (e?.outcome === "clean" || e?.outcome === "empty") return {
                        reason: "done",
                        exitCode: 0
                    };
                    await new Promise((r)=>setTimeout(r, 100));
                }
            })()
        ]);
        abort.abort();
        const a = session.inspectNewestAppendedAssistant(running.sessionFile, running.sessionBaseline) ?? {
            id: randomUUID(),
            text: null,
            empty: true,
            stopReason: "error",
            errorMessage: "Subagent produced no settled assistant response"
        };
        const bad = completion.reason === "error" || a.stopReason === "error" || completion.exitCode !== 0;
        if (isCancelled(s)) return;
        let open = true;
        try {
            const inspection = await terminal.inspectPane(running.surface);
            const processInfo = terminal.getPaneProcessInfo(running.surface);
            open = inspection.kind !== "missing" || processInfo.pids.length > 0;
            node.open = open;
        } catch  {
            node.open = true;
        }
        const outcome = a.stopReason === "aborted" ? "unexpected-abort" : bad ? "error" : a.empty ? "empty" : "clean";
        const result = writeResult(s, node, {
            resultId: randomUUID(),
            assistantEntryId: a.id,
            answer: a.text,
            outcome,
            sessionReference: bounded(running.sessionFile, MAX_SESSION),
            ...outcome === "error" || outcome === "unexpected-abort" ? {
                error: {
                    code: a.stopReason === "error" ? "provider_error" : "runtime_error",
                    message: bounded(a.errorMessage ?? completion.errorMessage ?? "Subagent failed", MAX_ERROR)
                }
            } : {},
            ...node.metadata ? {
                metadata: node.metadata
            } : {},
            ...running.worktree ? {
                worktree: launchModule.captureWorktreeHandoff(running.worktree)
            } : {}
        });
        pending.resolve(result);
        if (!isCancelled(s)) void maybeFinish(s);
    } catch (e) {
        if (!readJson(node.resultPath) && !isCancelled(s)) {
            const result = writeResult(s, node, failedResult("runtime_error", message(e), node.metadata));
            pending.resolve(result);
            void maybeFinish(s);
        }
    }
}
async function launch(s, o) {
    if (s.terminal || readJson(join(s.meta.treeDir, "terminal.json")) || isCancelled(s)) throw new SubagentTreeError("subagent tree is terminal");
    if (o.parentId !== s.ownerId) throw new SubagentTreeOwnershipError("parent is not owned by this branch");
    if (!o.name || !o.task) throw new SubagentTreeValidationError("child name and task are required");
    if (!Array.isArray(o.tools) || !o.tools.length) throw new SubagentTreeValidationError("child tools are required");
    const consumerMetadata = o.metadata === undefined ? metadata(null) : metadata(o.metadata);
    const role = o.agent ? resolveAgent(o.agent, s.pi) : undefined;
    if (o.agent && !role) {
        const d = discoverAgentCatalog(s.pi).diagnostics.find((x)=>x.agentName === o.agent);
        throw new SubagentTreeValidationError(d?.message ?? `Agent ${JSON.stringify(o.agent)} was not found`);
    }
    let tools;
    try {
        tools = effectiveRoleTools(o.tools, role);
    } catch (e) {
        throw new SubagentTreeValidationError(message(e));
    }
    if (isCancelled(s)) throw new SubagentTreeError("subagent tree is terminal");
    const parent = context(s.ctx);
    if (!s.ctx.model) throw new SubagentTreeValidationError("No parent model is selected");
    const thinking = s.pi.getThinkingLevel();
    if (typeof thinking !== "string") throw new SubagentTreeValidationError(`Unsupported thinking level: ${thinking}`);
    const registryAdapter = wrapPiModelRegistry(s.ctx.modelRegistry);
    const modelConfig = loadModelConfig();
    const plan = resolveRuntimePlan({
        model: o.model,
        thinking: o.thinking
    }, {
        model: resolveModelDefault(o.agent, role?.model, modelConfig),
        thinking: role?.thinking
    }, {
        provider: s.ctx.model.provider,
        modelId: s.ctx.model.id,
        thinking: thinking
    }, registryAdapter);
    if (o.parentId === s.meta.callerId) claimRoot(s);
    const id = randomUUID(), childMetadata = identityMetadata(consumerMetadata, s.meta, s.ownerId, id, o.parentId), node = {
        nodeId: id,
        parentId: o.parentId,
        ownerId: s.ownerId,
        name: o.name,
        resultPath: join(s.meta.treeDir, "results", `${id}.json`),
        status: "queued",
        metadata: childMetadata
    }, pending = deferred();
    s.pending.set(id, pending);
    s.children.set(id, Object.freeze({
        nodeId: id,
        parentId: o.parentId,
        result: pending.promise
    }));
    writeNode(s, node);
    const transaction = deferred(), controller = new AbortController(), inflightToken = randomUUID();
    s.launchTransactions.add(transaction.promise);
    s.launchControllers.add(controller);
    atomic(inflightPath(s, id), {
        ownerId: s.ownerId,
        pid: process.pid,
        process: processIdentity(),
        nodeId: id,
        token: inflightToken
    });
    const contextPath = join(s.meta.treeDir, "context", `${id}.json`);
    atomic(contextPath, {
        ...s.meta,
        ownerId: id
    });
    try {
        if (isCancelled(s)) {
            const r = writeResult(s, node, failedResult("tree_cancelled", "subagent tree cancellation requested", childMetadata));
            pending.resolve(r);
            return s.children.get(id);
        }
        const { launchPiSubagent } = await import("./pi-extension/subagents/launch.js");
        const effectiveAutoExit = role ? role.autoExit ?? false : true;
        const running = await launchPiSubagent({
            kind: "fresh",
            id,
            name: o.name,
            task: o.task,
            agent: o.agent,
            cwd: o.cwd,
            worktree: o.worktree,
            parent: {
                cwd: parent.cwd,
                invocationCwd: process.cwd(),
                sessionFile: parent.sessionFile,
                sessionId: parent.sessionId,
                sessionDir: parent.sessionDir,
                agentDir: parent.agentDir
            },
            runtimePlan: plan,
            environment: {
                PI_SUBAGENT_TREE_CONTEXT: contextPath,
                PI_SUBAGENT_TREE_OWNER: "1"
            },
            signal: controller.signal,
            behavior: {
                tools: tools.join(","),
                skills: o.skills ?? role?.skills,
                deniedTools: [],
                autoExit: effectiveAutoExit,
                interactive: role?.interactive ?? !effectiveAutoExit,
                includeControlTools: false,
                identity: role?.body,
                systemPromptMode: role?.systemPromptMode,
                sessionMode: role?.sessionMode ?? "standalone",
                cwd: role?.cwd
            }
        });
        node.surface = running.surface;
        node.sessionFile = running.sessionFile;
        node.status = "running";
        writeNode(s, node);
        if (isCancelled(s)) {
            try {
                const terminal = await import("./pi-extension/subagents/terminal.js");
                terminal.closePane(running.surface);
                node.open = !await terminal.waitForPaneAbsence(running.surface, {
                    timeoutMs: 5000
                });
            } catch  {
                node.open = true;
            }
            const r = writeResult(s, node, failedResult("tree_cancelled", "subagent tree cancellation requested", childMetadata));
            pending.resolve(r);
            return s.children.get(id);
        }
        void watch(s, node, running, pending);
    } catch (e) {
        const r = writeResult(s, node, failedResult(isCancelled(s) ? "tree_cancelled" : "launch_failed", message(e), childMetadata));
        pending.resolve(r);
        maybeFinish(s);
        return s.children.get(id);
    } finally{
        clearInflight(s, id, inflightToken);
        transaction.resolve();
        s.launchTransactions.delete(transaction.promise);
        s.launchControllers.delete(controller);
    }
    return s.children.get(id);
}
async function waitTerminal(s) {
    for(;;){
        const r = readJson(join(s.meta.treeDir, "terminal.json"));
        if (r) {
            adopt(s, r);
            return r;
        }
        await new Promise((r)=>setTimeout(r, 25));
    }
}
async function waitBranchAcks(s, failures, includeRoot = true) {
    const owners = new Set();
    if (includeRoot) owners.add(s.meta.callerId);
    for (const f of readdirSync(join(s.meta.treeDir, "nodes")).filter((x)=>x.endsWith(".json"))){
        const n = readJson(join(s.meta.treeDir, "nodes", f));
        if (n) owners.add(n.ownerId);
    }
    if (!includeRoot) owners.delete(s.meta.callerId);
    const deadline = Date.now() + CANCEL_TIMEOUT_MS;
    while(Date.now() < deadline){
        const missing = [
            ...owners
        ].filter((owner)=>!existsSync(join(s.meta.treeDir, "branches", `${owner}.cancelled.json`)));
        if (!missing.length) return;
        await new Promise((r)=>setTimeout(r, 25));
    }
    for (const owner of owners){
        const ack = readJson(join(s.meta.treeDir, "branches", `${owner}.cancelled.json`));
        if (!ack) failures.push(`branch cancellation acknowledgement missing: ${owner}`);
        else {
            if (ack.transactionsSettled === false) failures.push(`branch cancellation transaction did not settle: ${owner}`);
            if ((ack.inflight ?? 0) > 0) failures.push(`branch cancellation reservation remains: ${owner}`);
            if ((ack.remainingPids ?? []).length) failures.push(`branch processes remain: ${(ack.remainingPids ?? []).join(",")}`);
        }
    }
}
async function cancelWork(s) {
    const mux = await import("./pi-extension/subagents/terminal.js");
    atomic(join(s.meta.treeDir, "cancel.request"), {
        process: processIdentity(),
        at: Date.now()
    });
    const failures = [], pids = new Set();
    await cancelBranch(s);
    await waitBranchAcks(s, failures);
    const deadline = Date.now() + CANCEL_TIMEOUT_MS;
    for (const inFlight of inflightRecords(s)){
        if (typeof inFlight.pid !== "number" || !processAlive(inFlight.pid)) {
            try {
                unlinkSync(inFlight.path);
            } catch  {}
        }
    }
    for (const row of rows(s)){
        const n = readJson(join(s.meta.treeDir, "nodes", `${row.nodeId}.json`));
        if (!n || n.open === false) continue;
        if (!n.surface) {
            if (n.status === "running") {
                failures.push(`missing pane identity for ${n.nodeId}`);
                n.open = true;
            } else n.open = false;
            const result = writeResult(s, n, failedResult("tree_cancelled", n.status === "running" ? "running child lost its pane" : "queued child cancelled", n.metadata));
            s.pending.get(n.nodeId)?.resolve(result);
            continue;
        }
        try {
            const info = mux.getPaneProcessInfo(n.surface);
            if (!info.pids.length && n.status !== "settled") failures.push(`missing process identity for ${n.nodeId}`);
            for (const pid of info.pids)pids.add(pid);
        } catch (e) {
            if (!/pane_not_found|pane not found/i.test(message(e))) failures.push(message(e));
        }
        try {
            mux.closePane(n.surface);
        } catch  {}
    }
    for (const row of rows(s)){
        const n = readJson(join(s.meta.treeDir, "nodes", `${row.nodeId}.json`));
        if (!n?.surface || n.open === false) continue;
        try {
            let absent = false;
            for(let attempt = 0; attempt < 3 && !absent; attempt++){
                if (attempt > 0) try {
                    mux.closePane(n.surface);
                } catch  {}
                absent = await mux.waitForPaneAbsence(n.surface, {
                    timeoutMs: 5000
                });
            }
            n.open = !absent;
            writeNode(s, n);
            if (!absent) failures.push(`pane ${n.surface} remains`);
        } catch (e) {
            failures.push(message(e));
        }
    }
    try {
        const left = await mux.waitForProcessesExit([
            ...pids
        ], {
            timeoutMs: 5000
        });
        if (left.length) failures.push(`processes remain: ${left.join(",")}`);
    } catch (e) {
        failures.push(message(e));
    }
    while(Date.now() < deadline && inflightRecords(s).some((x)=>typeof x.pid !== "number" || processAlive(x.pid)))await new Promise((r)=>setTimeout(r, 25));
    if (inflightRecords(s).some((x)=>typeof x.pid !== "number" || processAlive(x.pid))) failures.push("in-flight launch reservation remains");
    const error = failures.length ? {
        code: "cancel_termination_failed",
        message: bounded(failures.join("; "), MAX_ERROR)
    } : undefined;
    const terminal = {
        terminalId: randomUUID(),
        state: error ? "failed" : "cancelled",
        callerMetadata: s.meta.callerMetadata,
        rootResult: failedResult(error ? error.code : "tree_cancelled", error?.message ?? "tree cancelled"),
        ...error ? {
            error
        } : {},
        nodes: error ? rows(s).map((r)=>({
                ...r,
                open: true
            })) : rows(s)
    };
    await finish(s, terminal);
    return s.terminal ?? terminal;
}
function cancel(s) {
    const existing = readJson(join(s.meta.treeDir, "terminal.json"));
    if (existing) {
        adopt(s, existing);
        return Promise.resolve(existing);
    }
    if (s.cancellation) return s.cancellation;
    if (currentTerminalIntent(s) === "completed") {
        s.cancellation = waitTerminal(s);
        return s.cancellation;
    }
    if (!claimTerminalIntent(s, "cancelled")) {
        if (currentTerminalIntent(s) !== "cancelled") {
            s.cancellation = waitTerminal(s);
            return s.cancellation;
        }
    }
    s.cancellationRequested = true;
    s.cancellation = cancelWork(s);
    return s.cancellation;
}
function sync(s) {
    const terminal = readJson(join(s.meta.treeDir, "terminal.json"));
    if (terminal) adopt(s, terminal);
    for (const [id, p] of s.pending){
        const n = readJson(nodePath(s, id));
        const r = n ? readJson(n.resultPath) : undefined;
        if (r) p.resolve(deepFreeze(r));
    }
    if (isCancelled(s) && !s.branchCancellation && s.ownerId !== s.meta.callerId) void cancelBranch(s);
    maybeFinish(s);
}
function makeState(meta, pi, ctx, ownerId) {
    claimBranch(meta, ownerId);
    let resolveTree;
    const treePromise = new Promise((r)=>{
        resolveTree = r;
    });
    const s = {
        meta,
        ownerId,
        pi,
        ctx,
        boundSessionFile: ownerSession(meta, ownerId) ?? context(ctx).sessionFile,
        children: new Map(),
        pending: new Map(),
        launchTransactions: new Set(),
        launchControllers: new Set(),
        callbackVersion: 0,
        deliverySerial: Promise.resolve(),
        resolveTree,
        treePromise,
        cancellationRequested: false
    };
    const dir = join(meta.treeDir, "nodes");
    if (existsSync(dir)) for (const f of readdirSync(dir).filter((x)=>x.endsWith(".json"))){
        const n = readJson(join(dir, f));
        if (n?.ownerId === ownerId) {
            const p = deferred();
            s.pending.set(n.nodeId, p);
            const r = readJson(n.resultPath);
            if (r) p.resolve(deepFreeze(r));
            s.children.set(n.nodeId, Object.freeze({
                nodeId: n.nodeId,
                parentId: n.parentId,
                result: p.promise
            }));
        }
    }
    const terminal = readJson(join(meta.treeDir, "terminal.json"));
    if (terminal) adopt(s, terminal);
    const timer = setInterval(()=>sync(s), 100);
    timer.unref();
    return s;
}
function readonlyChildren(s) {
    const view = {
        get size () {
            return s.children.size;
        },
        get: (key)=>s.children.get(key),
        has: (key)=>s.children.has(key),
        keys: ()=>s.children.keys(),
        values: ()=>s.children.values(),
        entries: ()=>s.children.entries(),
        forEach: (fn)=>s.children.forEach((value, key)=>fn(value, key, view)),
        [Symbol.iterator]: ()=>s.children[Symbol.iterator]()
    };
    return Object.freeze(view);
}
function expose(s) {
    return Object.freeze({
        get callerId () {
            return s.meta.callerId;
        },
        get treeId () {
            return s.meta.treeId;
        },
        get ownershipToken () {
            return s.meta.ownershipToken;
        },
        get ownerId () {
            return s.ownerId;
        },
        get children () {
            return readonlyChildren(s);
        },
        get result () {
            sync(s);
            return s.treePromise;
        },
        launchChild: (o)=>launch(s, o),
        bindFinalCallback: (cb)=>{
            if (s.ownerId !== s.meta.callerId) throw new SubagentTreeOwnershipError("only the original caller may bind the final callback");
            s.callbackVersion++;
            s.callback = cb;
            if (s.terminal) void deliver(s, s.terminal);
        },
        cancel: ()=>cancel(s)
    });
}
export function createSubagentTree(options) {
    const baseMetadata = metadata(options.metadata === undefined ? null : options.metadata), c = context(options.ctx), treeId = randomUUID(), callerId = randomUUID(), token = randomUUID(), treeDir = join(c.sessionDir, "artifacts", c.sessionId, "subagent-trees", treeId), callerMetadata = deepFreeze(identityMetadata(baseMetadata, {
        callerId,
        treeId
    }, callerId, callerId)), meta = {
        version: 2,
        treeId,
        callerId,
        ownershipToken: token,
        artifactDir: join(c.sessionDir, "artifacts", c.sessionId),
        treeDir,
        callerMetadata,
        boundSessionFile: c.sessionFile,
        acceptedSessionFiles: {
            [callerId]: [
                c.sessionFile
            ]
        }
    };
    mkdirSync(join(treeDir, "nodes"), {
        recursive: true
    });
    atomic(join(treeDir, "tree.json"), meta);
    const s = makeState(meta, options.pi, options.ctx, callerId);
    registry().set(stateKey(treeId, callerId), s);
    return expose(s);
}
export function attachSubagentTree(options) {
    const contextPath = process.env.PI_SUBAGENT_TREE_CONTEXT, ctxMeta = contextPath ? readJson(contextPath) : undefined, values = [
        options.callerId,
        options.treeId,
        options.ownershipToken
    ], has = values.some((x)=>x !== undefined);
    if (has && values.some((x)=>x === undefined)) throw new SubagentTreeOwnershipError("callerId, treeId, and ownershipToken must be supplied together");
    const treeId = options.treeId ?? ctxMeta?.treeId, callerId = options.callerId ?? ctxMeta?.callerId, token = options.ownershipToken ?? ctxMeta?.ownershipToken;
    if (!treeId || !callerId || !token) throw new SubagentTreeOwnershipError("tree credentials are required");
    if (ctxMeta && (treeId !== ctxMeta.treeId || callerId !== ctxMeta.callerId || token !== ctxMeta.ownershipToken)) throw new SubagentTreeOwnershipError("invalid tree credentials");
    const meta = readJson(join(ctxMeta?.treeDir ?? "", "tree.json")) ?? ctxMeta ?? findTreeMeta(context(options.ctx).sessionDir, treeId);
    if (!meta || meta.treeId !== treeId || meta.callerId !== callerId || meta.ownershipToken !== token) throw new SubagentTreeOwnershipError("invalid tree credentials");
    const ownerId = ctxMeta?.ownerId ?? callerId;
    if (ownerId !== callerId && !readJson(join(meta.treeDir, "nodes", `${ownerId}.json`))) throw new SubagentTreeOwnershipError("unknown branch owner");
    const keyValue = stateKey(treeId, ownerId), existing = registry().get(keyValue) ?? [
        ...registry().values()
    ].find((v)=>v.meta.treeId === treeId && v.meta.callerId === callerId && v.ownerId === ownerId), freshSession = context(options.ctx).sessionFile, prior = existing?.boundSessionFile ?? ownerSession(meta, ownerId), initialContext = Boolean(ctxMeta && !existing), knownSession = meta.acceptedSessionFiles?.[ownerId]?.includes(freshSession) === true;
    if (!initialContext && !knownSession && options.forkLineage === undefined && header(freshSession) && prior !== freshSession) throw new SubagentTreeOwnershipError("fork lineage is required for a fork session");
    const fresh = initialContext || knownSession ? freshSession : validateLineage(meta, ownerId, options.ctx, options.forkLineage, prior);
    if (initialContext) {
        const claimPath = `${contextPath}.claim`;
        if (!exclusiveAtomic(claimPath, {
            process: processIdentity(),
            ownerId,
            token: randomUUID()
        })) throw new SubagentTreeOwnershipError("package tree context was already claimed");
    }
    const s = existing ?? makeState(meta, options.pi, options.ctx, ownerId);
    s.pi = options.pi;
    s.ctx = options.ctx;
    s.boundSessionFile = fresh;
    meta.acceptedSessionFiles ??= {};
    meta.acceptedSessionFiles[ownerId] ??= [];
    if (!meta.acceptedSessionFiles[ownerId].includes(fresh)) meta.acceptedSessionFiles[ownerId].push(fresh);
    if (ownerId === callerId) {
        meta.boundSessionFile = fresh;
        atomic(join(meta.treeDir, "tree.json"), meta);
    } else {
        const node = readJson(join(meta.treeDir, "nodes", `${ownerId}.json`));
        if (node) {
            node.sessionFile = fresh;
            atomic(join(meta.treeDir, "nodes", `${ownerId}.json`), node);
        }
    }
    registry().set(keyValue, s);
    return expose(s);
}
function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    for (const child of Object.values(value))deepFreeze(child);
    return Object.freeze(value);
}
