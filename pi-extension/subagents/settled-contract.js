export const SETTLED_OUTCOME_POLICY = {
    clean: {
        parentDelivery: "deliver",
        childLifecycle: "auto-exit"
    },
    empty: {
        parentDelivery: "deliver",
        childLifecycle: "auto-exit"
    },
    error: {
        parentDelivery: "deliver",
        childLifecycle: "keep-open"
    },
    "intentional-abort": {
        parentDelivery: "suppress",
        childLifecycle: "keep-open"
    },
    "unexpected-abort": {
        parentDelivery: "deliver",
        childLifecycle: "keep-open"
    }
};
export function classifySettledOutcome(evidence) {
    const { assistant } = evidence;
    if (assistant.stopReason === "error") return "error";
    if (assistant.stopReason === "aborted") {
        return evidence.interruptRequested ? "intentional-abort" : "unexpected-abort";
    }
    return assistant.empty || !assistant.text?.trim() ? "empty" : "clean";
}
export const SETTLED_TOOL_ERROR_POLICY = "recoverable-before-clean-final";
export function settledDeliveryKey(identity) {
    return JSON.stringify([
        identity.childId,
        identity.sessionFile,
        identity.assistantEntryId
    ]);
}
export function createDeliveryGates() {
    return {
        settled: {
            lastActivitySequence: null,
            delivered: new Set()
        },
        terminal: "pending"
    };
}
