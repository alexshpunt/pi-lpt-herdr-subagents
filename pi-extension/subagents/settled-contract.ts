/**
 * The assistant stop reasons Pi can persist for a settled turn.
 *
 * Keep this union open to newer Pi values so the contract can be consumed by
 * a child running a newer provider without losing the recorded reason.
 */
export type AssistantStopReason =
  | "stop"
  | "length"
  | "toolUse"
  | "error"
  | "aborted"
  | "pending"
  | "deferred"
  | (string & {});

/** The newest assistant message observed at a settled session boundary. */
export interface NewestAssistantEntry {
  /** The assistant message id from the session JSONL entry. */
  id: string;
  /** Joined text content, or null when the assistant response is empty. */
  text: string | null;
  /** Number of characters in the joined text before empty-text normalization. */
  contentLength: number;
  /** Pi's final stop reason, when one was persisted. */
  stopReason?: AssistantStopReason;
  /** Provider error detail, when Pi persisted one. */
  errorMessage?: string;
  /** True when this assistant entry has no usable text content. */
  empty: boolean;
}

/** The five outcomes a settled assistant turn can have. */
export type SettledOutcomeKind =
  | "clean"
  | "empty"
  | "error"
  | "intentional-abort"
  | "unexpected-abort";

/** Parent visibility and child lifecycle action for each settled outcome. */
export interface SettledOutcomePolicy {
  parentDelivery: "suppress";
  childLifecycle: "auto-exit" | "keep-open";
}

/** The approved delivery/retention policy for settled outcomes. */
export const SETTLED_OUTCOME_POLICY: Readonly<
  Record<SettledOutcomeKind, SettledOutcomePolicy>
> = {
  clean: { parentDelivery: "suppress", childLifecycle: "auto-exit" },
  empty: { parentDelivery: "suppress", childLifecycle: "auto-exit" },
  error: { parentDelivery: "suppress", childLifecycle: "keep-open" },
  "intentional-abort": {
    parentDelivery: "suppress",
    childLifecycle: "keep-open",
  },
  "unexpected-abort": {
    parentDelivery: "suppress",
    childLifecycle: "keep-open",
  },
};

/**
 * Evidence needed to classify one settled assistant turn.
 *
 * A tool error is deliberately not an outcome by itself. Pi may recover from
 * a tool error and produce a clean final assistant entry in the same settled
 * run; the final assistant entry remains authoritative.
 */
export interface SettledOutcomeEvidence {
  assistant: NewestAssistantEntry;
  /** True when the parent explicitly recorded an interrupt request. */
  interruptRequested: boolean;
  /** True when an earlier tool execution in this run reported an error. */
  hadToolError?: boolean;
}

/**
 * Classify the final assistant evidence without consulting process state.
 *
 * Settled responses stay local. Errors and aborts keep the child open; clean
 * and empty outcomes can drive auto-exit. Tool errors are recoverable when a
 * later clean assistant response exists.
 */
export function classifySettledOutcome(
  evidence: SettledOutcomeEvidence,
): SettledOutcomeKind {
  const { assistant } = evidence;
  if (assistant.stopReason === "error") return "error";
  if (assistant.stopReason === "aborted") {
    return evidence.interruptRequested ? "intentional-abort" : "unexpected-abort";
  }
  return assistant.empty || !assistant.text?.trim() ? "empty" : "clean";
}

/** Tool errors can recover before the final assistant response is settled. */
export type SettledToolErrorPolicy = "recoverable-before-clean-final";

/** The tool-error policy approved by the settled lifecycle plan. */
export const SETTLED_TOOL_ERROR_POLICY: SettledToolErrorPolicy =
  "recoverable-before-clean-final";

/** The child/session/message tuple used to deduplicate settled delivery. */
export interface SettledDeliveryIdentity {
  childId: string;
  sessionFile: string;
  assistantEntryId: string;
}

/** A stable key for a settled delivery identity. */
export type SettledDeliveryKey = string;

/**
 * Serialize a delivery identity without relying on path or id delimiters.
 * JSON tuple encoding keeps each component unambiguous.
 */
export function settledDeliveryKey(
  identity: SettledDeliveryIdentity,
): SettledDeliveryKey {
  return JSON.stringify([
    identity.childId,
    identity.sessionFile,
    identity.assistantEntryId,
  ]);
}

/** The pre-run session position and inherited assistant ids. */
export interface SessionBaselineCursor {
  sessionFile: string;
  /** Number of non-empty JSONL entries present before the child starts. */
  entryCount: number;
  /** Last existing entry id, used to diagnose a moved or replaced session. */
  leafId: string | null;
  /** Assistant ids inherited by a fork and therefore not new responses. */
  assistantEntryIds: readonly string[];
}

/** The independent exactly-once state for settled turns. */
export interface SettledDeliveryGate {
  lastActivitySequence: number | null;
  delivered: Set<SettledDeliveryKey>;
}

/** The independent exactly-once state for terminal completion. */
export type TerminalDeliveryGate = "pending" | "delivered" | "suppressed";

/** Both gates are kept so a settled turn never consumes terminal completion. */
export interface DeliveryGates {
  settled: SettledDeliveryGate;
  terminal: TerminalDeliveryGate;
}

/** Create empty delivery gates for a newly launched child. */
export function createDeliveryGates(): DeliveryGates {
  return {
    settled: { lastActivitySequence: null, delivered: new Set() },
    terminal: "pending",
  };
}

/** Parent-facing payload for one settled assistant response. */
export interface SettledParentPayload {
  kind: "settled";
  childId: string;
  sessionFile: string;
  assistantEntryId: string;
  activitySequence: number;
  turnIndex: number | null;
  outcome: SettledOutcomeKind;
  text: string | null;
  stopReason?: AssistantStopReason;
  errorMessage?: string;
  empty: boolean;
}
