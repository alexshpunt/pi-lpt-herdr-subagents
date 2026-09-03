/** Fixed statuses used for durable subagent result delivery. */
export const DELIVERY_STATUSES = [
  "completed",
  "settled",
  "help-request",
  "closed",
  "crashed",
  "recovery-failed",
  "cancelled",
  "error",
  "empty",
] as const;

/** Status stored in result files, inbox entries, and model-visible payloads. */
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export interface DeliveryPayloadInput {
  status: DeliveryStatus;
  agentName: string;
  childSessionId: string;
  childSessionFile?: string;
  answer?: string;
  resultPath?: string;
  deliveryId?: string;
  elapsed?: number;
  exitCode?: number;
}

/** Build one complete direct-child payload without truncating the answer or references. */
export function frameDeliveryPayload(input: DeliveryPayloadInput): string {
  if (!(DELIVERY_STATUSES as readonly string[]).includes(input.status)) {
    throw new Error(`Unsupported delivery status: ${String(input.status)}`);
  }

  const lines = [
    `Subagent ${input.agentName} ${input.status}.`,
    "",
    input.answer ?? "No answer was captured.",
  ];
  if (input.resultPath) lines.push("", `Result file: ${input.resultPath}`);
  if (input.childSessionFile) {
    lines.push(
      "",
      `Session: ${input.childSessionFile}`,
      `Resume: pi --session ${input.childSessionFile}`,
    );
  } else {
    lines.push("", `Child session: ${input.childSessionId}`);
  }
  if (input.deliveryId) lines.push(`Delivery: ${input.deliveryId}`);
  return lines.join("\n");
}
