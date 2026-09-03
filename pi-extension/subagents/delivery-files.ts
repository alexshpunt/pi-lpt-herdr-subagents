import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { DeliveryStatus } from "./delivery-payload.ts";

export interface ResultFileInput {
  sessionsDir: string;
  childSessionId: string;
  deliveryId: string;
  status: DeliveryStatus;
  agentName: string;
  answer?: string;
  now: number;
}

export interface ResultFileHandle {
  path: string;
  sequence: number;
  filename: string;
}

function fsyncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function deliveryIdFromFile(path: string): string | undefined {
  try {
    const header = readFileSync(path, "utf8").split(/\r?\n\r?\n/, 1)[0] ?? "";
    return /^delivery[\s_-]+id\s*[:=]\s*(.+)$/im.exec(header)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

function files(path: string): string[] {
  try { return readdirSync(path).filter((name) => /^\d+-[^/]+\.md$/.test(name)); }
  catch { return []; }
}

function existingDelivery(path: string, deliveryId: string): ResultFileHandle | undefined {
  for (const filename of files(path)) {
    if (deliveryIdFromFile(join(path, filename)) !== deliveryId) continue;
    const sequence = Number.parseInt(filename, 10);
    return { path: join(path, filename), sequence, filename };
  }
  return undefined;
}

function nextSequence(path: string): number {
  return files(path).reduce((max, filename) => {
    const sequence = Number.parseInt(filename, 10);
    return Number.isFinite(sequence) ? Math.max(max, sequence) : max;
  }, 0) + 1;
}

function resultContents(input: ResultFileInput, sequence: number): string {
  return [
    `Status: ${input.status}`,
    `Agent name: ${input.agentName}`,
    `Child session id: ${input.childSessionId}`,
    `Time: ${new Date(input.now).toISOString()}`,
    `Delivery sequence: ${sequence}`,
    `Delivery id: ${input.deliveryId}`,
    "",
    input.answer ?? "Nothing was captured for this delivery.",
  ].join("\n");
}

/** Materialize one immutable result file, recovering the same delivery after races or restart. */
export function materializeResultFile(input: ResultFileInput): ResultFileHandle {
  const sessionsDir = isAbsolute(input.sessionsDir) ? input.sessionsDir : resolve(input.sessionsDir);
  const directory = join(sessionsDir, input.childSessionId);
  mkdirSync(directory, { recursive: true });

  for (;;) {
    const recovered = existingDelivery(directory, input.deliveryId);
    if (recovered) return recovered;

    const sequence = nextSequence(directory);
    const filename = `${String(sequence).padStart(2, "0")}-${input.status}.md`;
    const path = join(directory, filename);
    let fd: number | undefined;
    try {
      fd = openSync(path, "wx", 0o600);
      writeSync(fd, resultContents(input, sequence), undefined, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      fsyncDirectory(directory);
      return { path, sequence, filename };
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
}
