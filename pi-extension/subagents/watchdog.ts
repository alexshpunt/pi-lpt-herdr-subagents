import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import type { SubagentActivityState } from "./activity.ts";

export const DEFAULT_QUIET_THRESHOLD_MS = 120_000;
export const MAX_RECOVERY_ATTEMPTS = 3;

export type RecoveryCause = "crash" | "stale";
export type StaleVerdict = "active" | "waiting" | "stale";

/** Resolve the watchdog threshold with environment precedence and strict validation. */
export function resolveQuietThreshold(
  envValue: string | undefined,
  configuredValue: number | undefined,
): number {
  if (envValue !== undefined) {
    const parsed = Number(envValue);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new Error("Invalid PI_SUBAGENT_QUIET_THRESHOLD_MS: expected a positive integer");
    }
    return parsed;
  }
  if (configuredValue !== undefined) {
    if (!Number.isInteger(configuredValue) || configuredValue <= 0) {
      throw new Error("Invalid status.quietThresholdMs: expected a positive integer");
    }
    return configuredValue;
  }
  return DEFAULT_QUIET_THRESHOLD_MS;
}

/** Classify observable inactivity without bounding tools, streams, or descendant drain. */
export function classifyStaleness(input: {
  autonomous: boolean;
  activity?: SubagentActivityState;
  startedAt: number;
  now: number;
  quietThresholdMs: number;
  waitingForDescendants: boolean;
  /** Latest result delivered by an owned descendant, which wakes the owner. */
  descendantActivityAt?: number;
}): StaleVerdict {
  if (!input.autonomous) return "active";
  if (input.waitingForDescendants) return "waiting";
  if (input.activity?.compactionActive) return "active";
  if (input.activity?.toolActive) return "active";

  if (input.descendantActivityAt !== undefined && input.activity?.providerActive) return "active";
  const lastEventAt = Math.max(
    input.activity?.updatedAt ?? input.startedAt,
    input.descendantActivityAt ?? 0,
  );
  return input.now - lastEventAt > input.quietThresholdMs ? "stale" : "active";
}

interface RecoveryRecord {
  event?: unknown;
  childId?: unknown;
  attempt?: unknown;
  cause?: unknown;
}

function records(logPath: string, childId: string): RecoveryRecord[] {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as RecoveryRecord;
      } catch (error) {
        throw new Error(`Invalid recovery ledger record ${index + 1} in ${logPath}`, { cause: error });
      }
    })
    .filter((record) => record.event === "recovery-attempt" && record.childId === childId);
}

function appendRecoveryRecord(logPath: string, record: Record<string, unknown>): void {
  mkdirSync(dirname(logPath), { recursive: true });
  const descriptor = openSync(logPath, "a");
  try {
    writeSync(descriptor, `${JSON.stringify(record)}\n`, undefined, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/** Consume one durable attempt from the shared crash-and-stale recovery budget. */
export function consumeRecoveryAttempt(input: {
  logPath: string;
  childId: string;
  cause: RecoveryCause;
  now?: () => number;
}): { attempt: number; exhausted: boolean; reason: string } {
  const previous = records(input.logPath, input.childId);
  const attemptedCauses = previous
    .map((record) => record.cause)
    .filter((cause): cause is RecoveryCause => cause === "crash" || cause === "stale");
  const reasonFor = (causes: RecoveryCause[]): string => {
    if (new Set(causes).size > 1) return "Recovery failed after mixed crash and stale attempts.";
    return causes[0] === "crash"
      ? "Recovery failed after repeated child process crashes."
      : "Recovery failed after repeated stale watchdog kills.";
  };
  if (previous.length >= MAX_RECOVERY_ATTEMPTS) {
    return {
      attempt: MAX_RECOVERY_ATTEMPTS,
      exhausted: true,
      reason: reasonFor(attemptedCauses),
    };
  }

  const attempt = previous.length + 1;
  const now = input.now ?? Date.now;
  appendRecoveryRecord(input.logPath, {
    version: 1,
    time: new Date(now()).toISOString(),
    event: "recovery-attempt",
    childId: input.childId,
    attempt,
    cause: input.cause,
  });
  return {
    attempt,
    exhausted: false,
    reason: reasonFor([...attemptedCauses, input.cause]),
  };
}
