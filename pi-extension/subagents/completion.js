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
                ...(typeof payload.id === "string"
                    ? { id: payload.id }
                    : {}),
                name: typeof payload.name === "string" ? payload.name : "subagent",
                message: typeof payload.message === "string" ? payload.message : "",
            },
        };
    }
    if (payload?.type === "error") {
        const errorMessage = typeof payload.errorMessage === "string" && payload.errorMessage.trim()
            ? payload.errorMessage
            : "Subagent exited with stopReason=error (no errorMessage in sidecar).";
        return { reason: "error", exitCode: 1, errorMessage };
    }
    if (payload?.type === "done")
        return {
            reason: "done",
            exitCode: 0,
            ...(typeof payload.summary === "string" && payload.summary.trim() ? { summary: payload.summary } : {}),
        };
    return {
        reason: "error",
        exitCode: 1,
        errorMessage: "Invalid subagent completion sidecar: unsupported payload type.",
    };
}
/** Read completion evidence without acknowledging or removing it. */
export function readExitSidecar(sessionFile) {
    if (!sessionFile)
        return null;
    const exitFile = `${sessionFile}.exit`;
    if (!existsSync(exitFile))
        return null;
    try {
        return JSON.parse(readFileSync(exitFile, "utf8"));
    }
    catch {
        return null;
    }
}
/** Remove completion evidence only after durable result and inbox publication. */
export function acknowledgeExitSidecar(sessionFile) {
    rmSync(`${sessionFile}.exit`, { force: true });
}
/** Remove only the exact help evidence that was durably published. */
export function acknowledgePingSidecar(sessionFile, pingId) {
    const payload = readExitSidecar(sessionFile);
    if (payload == null || typeof payload !== "object")
        return;
    const candidate = payload;
    if (candidate.type !== "ping" || candidate.id !== pingId)
        return;
    rmSync(`${sessionFile}.exit`, { force: true });
}
function consumeExitSidecar(sessionFile) {
    const payload = readExitSidecar(sessionFile);
    return payload == null ? null : interpretExitSidecar(payload);
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
    if (immediate)
        return immediate;
    const graceMs = Math.max(0, options.paneDisappearanceGraceMs ?? 500);
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
        const remaining = deadline - Date.now();
        await abortableDelay(Math.min(25, remaining), signal);
        const result = completionArtifact(options);
        if (result)
            return result;
    }
    return null;
}
function abortableDelay(milliseconds, signal) {
    if (signal.aborted)
        return Promise.reject(new Error(ABORT_MESSAGE));
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            reject(new Error(ABORT_MESSAGE));
        };
        const timer = setTimeout(() => {
            signal.removeEventListener("abort", onAbort);
            resolve();
        }, milliseconds);
        signal.addEventListener("abort", onAbort, { once: true });
    });
}
export async function waitForCompletion(signal, options) {
    const startedAt = Date.now();
    for (;;) {
        if (signal.aborted)
            throw new Error(ABORT_MESSAGE);
        const sidecarResult = consumeExitSidecar(options.sessionFile);
        if (sidecarResult)
            return sidecarResult;
        try {
            const exitCode = terminalExitCode(await options.readTerminalTail());
            if (exitCode !== null) {
                // The shell sentinel can race the child-side exit sidecar. Give the
                // durable intent a short chance to win so an explicit final summary is
                // not mistaken for a previously delivered settled turn.
                const sidecarResult = options.sessionFile
                    ? await waitForDisappearanceArtifacts(signal, options)
                    : null;
                return sidecarResult ?? { reason: "sentinel", exitCode };
            }
        }
        catch {
            // Terminal reads are only sentinel/output probes; Herdr status is polled
            // independently below, even when terminal reads succeed.
        }
        if (options.inspectPane) {
            let inspection;
            try {
                inspection = await options.inspectPane();
            }
            catch {
                inspection = { kind: "unavailable", error: "inspectPane threw" };
            }
            const observedAt = Date.now();
            options.onPaneInspection?.(inspection, observedAt);
            if (inspection.kind === "missing") {
                // Pane closure and atomic artifact publication are separate operations.
                // Allow a short bounded grace window before declaring evidence lost.
                const racedCompletion = await waitForDisappearanceArtifacts(signal, options);
                if (racedCompletion)
                    return racedCompletion;
                return {
                    reason: "error",
                    exitCode: 1,
                    errorMessage: "Subagent pane disappeared before completion evidence was recorded.",
                    paneDisappeared: true,
                };
            }
        }
        options.onTick?.(Math.floor((Date.now() - startedAt) / 1000));
        await abortableDelay(options.intervalMs, signal);
    }
}
