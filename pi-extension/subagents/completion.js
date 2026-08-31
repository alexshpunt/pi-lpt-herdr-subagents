import { existsSync, readFileSync, rmSync } from "node:fs";
const ABORT_MESSAGE = "Aborted while waiting for subagent to finish";
const TERMINAL_SENTINEL = /__SUBAGENT_DONE_(\d+)__/;
export function interpretExitSidecar(data) {
    const payload = data;
    if (payload?.type === "ping") {
        return {
            reason: "ping",
            exitCode: 0,
            ping: {
                name: typeof payload.name === "string" ? payload.name : "subagent",
                message: typeof payload.message === "string" ? payload.message : ""
            }
        };
    }
    if (payload?.type === "error") {
        const errorMessage = typeof payload.errorMessage === "string" && payload.errorMessage.trim() ? payload.errorMessage : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
        return {
            reason: "error",
            exitCode: 1,
            errorMessage
        };
    }
    if (payload?.type === "done") return {
        reason: "done",
        exitCode: 0,
        ...typeof payload.summary === "string" && payload.summary.trim() ? {
            summary: payload.summary
        } : {}
    };
    return {
        reason: "error",
        exitCode: 1,
        errorMessage: "Invalid subagent completion sidecar: unsupported payload type."
    };
}
function consumeExitSidecar(sessionFile) {
    if (!sessionFile) return null;
    const exitFile = `${sessionFile}.exit`;
    if (!existsSync(exitFile)) return null;
    try {
        const result = interpretExitSidecar(JSON.parse(readFileSync(exitFile, "utf8")));
        rmSync(exitFile, {
            force: true
        });
        return result;
    } catch  {
        return null;
    }
}
function terminalExitCode(screen) {
    const match = screen.match(TERMINAL_SENTINEL);
    return match ? Number.parseInt(match[1], 10) : null;
}
function completionArtifact(options) {
    return consumeExitSidecar(options.sessionFile);
}
async function waitForDisappearanceArtifacts(signal, options) {
    const immediate = completionArtifact(options);
    if (immediate) return immediate;
    const graceMs = Math.max(0, options.paneDisappearanceGraceMs ?? 500);
    const deadline = Date.now() + graceMs;
    while(Date.now() < deadline){
        const remaining = deadline - Date.now();
        await abortableDelay(Math.min(25, remaining), signal);
        const result = completionArtifact(options);
        if (result) return result;
    }
    return null;
}
function abortableDelay(milliseconds, signal) {
    if (signal.aborted) return Promise.reject(new Error(ABORT_MESSAGE));
    return new Promise((resolve, reject)=>{
        const onAbort = ()=>{
            clearTimeout(timer);
            reject(new Error(ABORT_MESSAGE));
        };
        const timer = setTimeout(()=>{
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, milliseconds);
        signal.addEventListener("abort", onAbort, {
            once: true
        });
    });
}
export async function waitForCompletion(signal, options) {
    const startedAt = Date.now();
    for(;;){
        if (signal.aborted) throw new Error(ABORT_MESSAGE);
        const sidecarResult = consumeExitSidecar(options.sessionFile);
        if (sidecarResult) return sidecarResult;
        try {
            const exitCode = terminalExitCode(await options.readTerminalTail());
            if (exitCode !== null) {
                const sidecarResult = options.sessionFile ? await waitForDisappearanceArtifacts(signal, options) : null;
                return sidecarResult ?? {
                    reason: "sentinel",
                    exitCode
                };
            }
        } catch  {}
        if (options.inspectPane) {
            let inspection;
            try {
                inspection = await options.inspectPane();
            } catch  {
                inspection = {
                    kind: "unavailable",
                    error: "inspectPane threw"
                };
            }
            const observedAt = Date.now();
            options.onPaneInspection?.(inspection, observedAt);
            if (inspection.kind === "missing") {
                const racedCompletion = await waitForDisappearanceArtifacts(signal, options);
                if (racedCompletion) return racedCompletion;
                return {
                    reason: "error",
                    exitCode: 1,
                    errorMessage: "Subagent pane disappeared before completion evidence was recorded.",
                    paneDisappeared: true
                };
            }
        }
        options.onTick?.(Math.floor((Date.now() - startedAt) / 1000));
        await abortableDelay(options.intervalMs, signal);
    }
}
