import { settledDeliveryKey } from "./settled-contract.js";
export function createLifecycle(startedAt) {
    return {
        process: {
            kind: "starting",
            startedAt
        },
        turn: {
            kind: "unknown"
        },
        activityHealth: {
            kind: "unseen"
        },
        activityDetail: null,
        pane: {
            kind: "unknown"
        },
        hasWorked: false,
        lastActivitySequence: null,
        delivery: "pending",
        settledDelivery: {
            lastActivitySequence: null,
            delivered: new Set()
        }
    };
}
function isTerminal(process) {
    return process.kind === "completed" || process.kind === "failed";
}
function startedAt(process) {
    return process.startedAt;
}
export function observePaneInspection(lifecycle, inspection, observedAt) {
    if (isTerminal(lifecycle.process)) return lifecycle;
    if (lifecycle.process.kind === "finalizing") return lifecycle;
    if (inspection.kind === "unavailable") {
        const previous = lifecycle.pane.kind === "read-error" ? lifecycle.pane : null;
        return {
            ...lifecycle,
            pane: {
                kind: "read-error",
                firstFailedAt: previous?.firstFailedAt ?? observedAt,
                lastFailedAt: observedAt,
                consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
                error: inspection.error
            }
        };
    }
    if (inspection.kind === "missing") {
        return {
            ...lifecycle,
            pane: {
                kind: "missing",
                detectedAt: observedAt,
                ...inspection.error ? {
                    error: inspection.error
                } : {}
            }
        };
    }
    const agentStatus = inspection.agentStatus;
    const hasWorked = lifecycle.hasWorked || agentStatus === "working" || agentStatus === "blocked" || agentStatus === "done";
    const pane = {
        kind: "present",
        observedAt,
        agentStatus
    };
    const process = lifecycle.process.kind === "starting" ? {
        kind: "running",
        startedAt: lifecycle.process.startedAt,
        confirmedAt: observedAt
    } : lifecycle.process;
    if (lifecycle.turn.kind === "interrupted") {
        return {
            ...lifecycle,
            process,
            pane,
            hasWorked
        };
    }
    let turn = lifecycle.turn;
    if (agentStatus === "blocked") {
        turn = hasWorked ? {
            kind: "blocked",
            startedAt: lifecycle.turn.kind === "blocked" ? lifecycle.turn.startedAt : observedAt
        } : {
            kind: "starting",
            observedAt: lifecycle.turn.kind === "starting" ? lifecycle.turn.observedAt : observedAt
        };
    } else if (agentStatus === "working") {
        turn = {
            kind: "active",
            startedAt: lifecycle.turn.kind === "active" ? lifecycle.turn.startedAt : observedAt,
            source: "herdr",
            ...lifecycle.activityDetail ? {
                activity: lifecycle.activityDetail
            } : {}
        };
    } else if (agentStatus === "done" || agentStatus === "idle") {
        turn = hasWorked ? {
            kind: "waiting",
            startedAt: lifecycle.turn.kind === "waiting" ? lifecycle.turn.startedAt : observedAt
        } : {
            kind: "starting",
            observedAt: lifecycle.turn.kind === "starting" ? lifecycle.turn.observedAt : observedAt
        };
    } else if (agentStatus === "unknown") {
        return {
            ...lifecycle,
            process,
            pane
        };
    }
    return {
        ...lifecycle,
        process,
        turn,
        pane,
        hasWorked
    };
}
export function observeActivity(lifecycle, read, observedAt) {
    if (lifecycle.process.kind === "finalizing" || isTerminal(lifecycle.process)) return lifecycle;
    const detail = (()=>{
        if (!read.ok) return null;
        const activity = read.activity;
        if (lifecycle.lastActivitySequence != null && activity.sequence < lifecycle.lastActivitySequence) {
            return null;
        }
        if (activity.phase !== "active") return null;
        if (activity.activeScope === "tool") {
            return {
                kind: "scope",
                scope: "tool",
                since: activity.toolStartedAt ?? activity.activeSince ?? activity.updatedAt,
                observedAt: activity.updatedAt,
                sequence: activity.sequence,
                ...activity.toolName ? {
                    label: activity.toolName
                } : {}
            };
        }
        if (activity.activeScope === "provider") {
            return {
                kind: "scope",
                scope: "provider",
                since: activity.activeSince ?? activity.updatedAt,
                observedAt: activity.updatedAt,
                sequence: activity.sequence,
                label: "provider"
            };
        }
        if (activity.activeScope === "streaming") {
            return {
                kind: "scope",
                scope: "streaming",
                since: activity.activeSince ?? activity.updatedAt,
                observedAt: activity.updatedAt,
                sequence: activity.sequence,
                label: "streaming"
            };
        }
        if (activity.activeScope === "agent" || activity.activeScope === "turn") {
            return {
                kind: "scope",
                scope: activity.activeScope,
                since: activity.activeSince ?? activity.updatedAt,
                observedAt: activity.updatedAt,
                sequence: activity.sequence
            };
        }
        return null;
    })();
    if (!read.ok) {
        const since = lifecycle.activityHealth.kind === "problem" ? lifecycle.activityHealth.since : observedAt;
        return {
            ...lifecycle,
            activityHealth: {
                kind: "problem",
                reason: read.reason,
                since,
                ...read.error ? {
                    error: read.error
                } : {}
            }
        };
    }
    if (!detail) {
        return {
            ...lifecycle,
            activityDetail: null,
            activityHealth: {
                kind: "healthy",
                observedAt
            },
            lastActivitySequence: Math.max(lifecycle.lastActivitySequence ?? -1, read.activity.sequence)
        };
    }
    let resumesInterruptedTurn = false;
    if (lifecycle.turn.kind === "interrupted") {
        const staleInterruptSnapshot = detail.observedAt < lifecycle.turn.requestedAt || detail.observedAt === lifecycle.turn.requestedAt && lifecycle.turn.previousActivitySequence != null && detail.sequence <= lifecycle.turn.previousActivitySequence;
        if (staleInterruptSnapshot) return lifecycle;
        resumesInterruptedTurn = true;
    }
    const process = lifecycle.process.kind === "starting" ? {
        kind: "running",
        startedAt: lifecycle.process.startedAt,
        confirmedAt: observedAt
    } : lifecycle.process;
    let turn = lifecycle.turn;
    const sameDetail = lifecycle.activityDetail?.kind === "scope" && lifecycle.activityDetail.scope === detail.scope && lifecycle.activityDetail.label === detail.label;
    const detailStartedAt = sameDetail && lifecycle.turn.kind === "active" ? lifecycle.turn.startedAt : detail.since;
    if (resumesInterruptedTurn) {
        turn = {
            kind: "active",
            startedAt: detailStartedAt,
            source: "activity",
            activity: detail
        };
    } else if (lifecycle.turn.kind !== "interrupted") {
        if (lifecycle.pane.kind === "present" && lifecycle.pane.agentStatus === "working") {
            turn = {
                kind: "active",
                startedAt: detailStartedAt,
                source: "activity",
                activity: detail
            };
        } else if (lifecycle.pane.kind === "unknown" || lifecycle.pane.kind === "read-error") {
            turn = {
                kind: "active",
                startedAt: detailStartedAt,
                source: "fallback",
                activity: detail
            };
        }
    }
    return {
        ...lifecycle,
        process,
        turn,
        activityDetail: detail,
        activityHealth: {
            kind: "healthy",
            observedAt
        },
        lastActivitySequence: detail.sequence
    };
}
export function markProcessRunning(lifecycle, confirmedAt) {
    if (lifecycle.process.kind !== "starting") return lifecycle;
    return {
        ...lifecycle,
        process: {
            kind: "running",
            startedAt: lifecycle.process.startedAt,
            confirmedAt
        }
    };
}
export function markInterruptRequested(lifecycle, requestedAt) {
    if (lifecycle.process.kind === "finalizing" || isTerminal(lifecycle.process)) return lifecycle;
    return {
        ...lifecycle,
        turn: {
            kind: "interrupted",
            requestedAt,
            previousActivitySequence: lifecycle.lastActivitySequence
        }
    };
}
export function consumeInterruptBoundary(lifecycle, sequence) {
    if (lifecycle.turn.kind !== "interrupted") return lifecycle;
    return {
        ...lifecycle,
        interruptSettledSequence: sequence,
        turn: {
            kind: "waiting",
            startedAt: lifecycle.turn.requestedAt
        }
    };
}
export function markCompletionDetected(lifecycle, completion, detectedAt) {
    if (lifecycle.process.kind === "finalizing" || isTerminal(lifecycle.process)) return lifecycle;
    return {
        ...lifecycle,
        process: {
            kind: "finalizing",
            startedAt: startedAt(lifecycle.process),
            detectedAt: Math.max(startedAt(lifecycle.process), detectedAt),
            completion
        }
    };
}
export function markCompleted(lifecycle, completedAt) {
    if (isTerminal(lifecycle.process)) return lifecycle;
    if (lifecycle.process.kind !== "finalizing") return lifecycle;
    return {
        ...lifecycle,
        process: {
            kind: "completed",
            startedAt: lifecycle.process.startedAt,
            detectedAt: lifecycle.process.detectedAt,
            completedAt: Math.max(lifecycle.process.detectedAt, completedAt),
            completion: lifecycle.process.completion
        }
    };
}
export function markFailed(lifecycle, error, detectedAt, exitCode) {
    if (isTerminal(lifecycle.process)) return lifecycle;
    const start = startedAt(lifecycle.process);
    const detected = lifecycle.process.kind === "finalizing" ? lifecycle.process.detectedAt : Math.max(start, detectedAt);
    return {
        ...lifecycle,
        process: {
            kind: "failed",
            startedAt: start,
            detectedAt: detected,
            completedAt: Math.max(detected, detectedAt),
            error,
            ...exitCode == null ? {} : {
                exitCode
            }
        }
    };
}
export function markDelivery(lifecycle, delivery) {
    if (lifecycle.delivery !== "pending") return lifecycle;
    return {
        ...lifecycle,
        delivery
    };
}
function settledGate(lifecycle) {
    return lifecycle.settledDelivery ?? {
        lastActivitySequence: null,
        delivered: new Set()
    };
}
export function observeSettledActivity(lifecycle, activitySequence) {
    const gate = settledGate(lifecycle);
    if (gate.lastActivitySequence != null && activitySequence <= gate.lastActivitySequence) {
        return lifecycle;
    }
    return {
        ...lifecycle,
        settledDelivery: {
            ...gate,
            lastActivitySequence: activitySequence
        }
    };
}
export function hasSettledAssistant(lifecycle, identity) {
    return settledGate(lifecycle).delivered.has(settledDeliveryKey(identity));
}
export function markSettledAssistantDelivered(lifecycle, identity, activitySequence) {
    const gate = settledGate(lifecycle);
    const key = settledDeliveryKey(identity);
    if (gate.delivered.has(key)) return lifecycle;
    if (gate.lastActivitySequence != null && activitySequence < gate.lastActivitySequence) {
        return lifecycle;
    }
    const delivered = new Set(gate.delivered);
    delivered.add(key);
    return {
        ...lifecycle,
        settledDelivery: {
            lastActivitySequence: gate.lastActivitySequence == null ? activitySequence : Math.max(gate.lastActivitySequence, activitySequence),
            delivered
        }
    };
}
export function projectLifecycle(lifecycle, now) {
    const process = lifecycle.process;
    if (process.kind === "finalizing") return {
        kind: "finalizing",
        runtimeEndedAt: process.detectedAt
    };
    if (process.kind === "completed") return {
        kind: "completed",
        runtimeEndedAt: process.completedAt
    };
    if (process.kind === "failed") return {
        kind: "failed",
        label: process.error,
        runtimeEndedAt: process.completedAt
    };
    if (lifecycle.pane.kind === "read-error" && now - lifecycle.pane.firstFailedAt >= 60_000) {
        return {
            kind: "stalled",
            stateDurationSince: lifecycle.pane.firstFailedAt
        };
    }
    const turn = lifecycle.turn;
    switch(turn.kind){
        case "interrupted":
            return {
                kind: "interrupted",
                stateDurationSince: turn.requestedAt
            };
        case "active":
            {
                if (turn.activity?.kind === "scope") {
                    const label = turn.activity.label ?? turn.activity.scope;
                    return {
                        kind: "active",
                        label,
                        stateDurationSince: turn.startedAt
                    };
                }
                return {
                    kind: "active",
                    label: turn.source === "herdr" ? "agent working" : "agent active",
                    stateDurationSince: turn.startedAt
                };
            }
        case "blocked":
            return {
                kind: "blocked",
                stateDurationSince: turn.startedAt
            };
        case "waiting":
            return {
                kind: "waiting",
                stateDurationSince: turn.startedAt
            };
        case "starting":
            return {
                kind: "starting",
                stateDurationSince: turn.observedAt
            };
        case "unknown":
            return process.kind === "running" ? {
                kind: "running"
            } : {
                kind: "starting"
            };
    }
}
export function lifecycleTransition(previous, next) {
    if (previous !== "stalled" && next === "stalled") return "stalled";
    if (previous === "stalled" && (next === "active" || next === "blocked" || next === "waiting" || next === "interrupted" || next === "running" || next === "starting")) {
        return "recovered";
    }
    return null;
}
export function formatLifecycleTransitionLine(name, projection, transition, now, startedAt, formatElapsed) {
    const runtime = formatElapsed(Math.max(0, now - startedAt));
    const duration = projection.stateDurationSince == null ? "" : ` ${formatElapsed(now - projection.stateDurationSince)}`;
    if (transition === "stalled") {
        return `${name} running ${runtime}, stalled${duration}.`;
    }
    if (projection.kind === "waiting") {
        return `${name} running ${runtime}, recovered; waiting${duration}.`;
    }
    if (projection.kind === "active") {
        const detail = projection.label ? ` (${projection.label}${duration})` : duration;
        return `${name} running ${runtime}, recovered; active${detail}.`;
    }
    if (projection.kind === "blocked") {
        return `${name} running ${runtime}, recovered; blocked${duration}.`;
    }
    if (projection.kind === "interrupted") {
        return `${name} running ${runtime}, recovered; interrupted${duration}.`;
    }
    return `${name} running ${runtime}, recovered; running.`;
}
