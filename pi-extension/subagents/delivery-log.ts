import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const ALLOWED_FIELDS = [
  "childId",
  "deliveryId",
  "status",
  "resultPath",
  "phase",
  "error",
  "waitedSince",
  "waitedMs",
  "workflowRunId",
  "attempt",
  "cause",
  "reason",
  "surface",
] as const;

function normalizeError(value: unknown): string | undefined {
  if (value == null) return undefined;
  return value instanceof Error ? value.message : String(value);
}

/** Create a contained append-only JSON-lines delivery recorder. */
export function createDeliveryLog(options: {
  logPath: string;
  now?: () => number;
  onFailure?: (error: unknown) => void;
}): { record(event: string, fields?: Record<string, unknown>): void } {
  const now = options.now ?? Date.now;
  return {
    record(event, fields = {}) {
      try {
        mkdirSync(dirname(options.logPath), { recursive: true });
        const record: Record<string, unknown> = {
          version: 1,
          time: new Date(now()).toISOString(),
          event,
        };
        for (const key of ALLOWED_FIELDS) {
          if (!(key in fields)) continue;
          const value = key === "error" ? normalizeError(fields[key]) : fields[key];
          if (value !== undefined) record[key] = value;
        }
        appendFileSync(options.logPath, `${JSON.stringify(record)}\n`, "utf8");
      } catch (error) {
        try { options.onFailure?.(error); } catch { /* containment sink is best effort */ }
      }
    },
  };
}
