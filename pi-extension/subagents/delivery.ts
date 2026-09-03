import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { interpretExitSidecar, readExitSidecar } from "./completion.ts";
import { materializeResultFile, type ResultFileHandle, type ResultFileInput } from "./delivery-files.ts";
import { frameDeliveryPayload, type DeliveryStatus } from "./delivery-payload.ts";
import {
  claimLineageInboxMaterialization,
  completeLineageInboxMaterialization,
  discoverLineageRoots,
  pendingLineageInboxes,
  releaseLineageInboxMaterialization,
} from "./lineage.ts";

export type DeliveryState = "none" | "delivery-pending" | "delivery-failed" | "delivered";
export interface DeliveryProjection { state: DeliveryState; error?: string; resultPath?: string }

/** Project model-visible delivery truth from durable inbox and acknowledgement facts. */
export function projectDeliveryState(facts: {
  hasInbox?: boolean;
  materialized?: boolean;
  failure?: string;
  resultPath?: string;
}): DeliveryProjection {
  if (facts.failure) return { state: "delivery-failed", error: facts.failure, ...(facts.resultPath ? { resultPath: facts.resultPath } : {}) };
  if (facts.materialized) return { state: "delivered", ...(facts.resultPath ? { resultPath: facts.resultPath } : {}) };
  if (facts.hasInbox) return { state: "delivery-pending", ...(facts.resultPath ? { resultPath: facts.resultPath } : {}) };
  return { state: "none" };
}

interface ParentDestination { sessionId: string; sessionFile: string; active: boolean }
interface DeliverySinks {
  materializeResultFile?: (input: ResultFileInput) => ResultFileHandle;
  publishInbox?: (payload: Record<string, unknown>) => boolean;
  acknowledgeSidecar?: (path: string) => void;
  claimMaterialization?: (parent: Omit<ParentDestination, "active">) => { status: "acquired" | "materialized" | "busy"; token?: string };
  completeMaterialization?: (token: string) => boolean;
  releaseMaterialization?: (token: string) => void;
  sendSteer?: (parent: Omit<ParentDestination, "active">, payload: string) => void | Promise<void>;
  log?: (event: string, fields?: Record<string, unknown>) => void;
  projectWidget?: (projection: DeliveryProjection) => void;
  onFailure?: (error: unknown, fields?: Record<string, unknown>) => void;
}

export interface DeliveryTransactionInput {
  sessionsDir: string;
  childSessionId: string;
  childSessionFile?: string;
  deliveryId: string;
  status: DeliveryStatus;
  agentName: string;
  answer?: string;
  parent: ParentDestination;
  sidecarPath?: string;
  now?: () => number;
  sinks?: DeliverySinks;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function containedFailure(sinks: DeliverySinks, error: unknown, fields: Record<string, unknown>): void {
  const projection = projectDeliveryState({ hasInbox: true, failure: errorText(error), resultPath: typeof fields.resultPath === "string" ? fields.resultPath : undefined });
  try { sinks.log?.("delivery-failed", { ...fields, error: errorText(error) }); }
  catch (logError) { try { sinks.onFailure?.(logError, { ...fields, phase: "log" }); } catch { /* contained */ } }
  try { sinks.projectWidget?.(projection); }
  catch (widgetError) { try { sinks.onFailure?.(widgetError, { ...fields, phase: "widget" }); } catch { /* contained */ } }
}

/** Execute the one ordered durable result transaction. Failures stay retryable. */
export async function runDeliveryTransaction(input: DeliveryTransactionInput): Promise<{ projection: DeliveryProjection; resultPath?: string }> {
  const sinks = input.sinks ?? {};
  const destination = { sessionId: input.parent.sessionId, sessionFile: input.parent.sessionFile };
  if (input.sidecarPath && !existsSync(input.sidecarPath)) {
    if (!sinks.claimMaterialization) return { projection: { state: "delivered" } };
    const existing = sinks.claimMaterialization(destination);
    if (existing.status === "materialized") return { projection: { state: "delivered" } };
    if (existing.status === "busy") return { projection: { state: "delivery-pending" } };
    if (existing.token) sinks.releaseMaterialization?.(existing.token);
  }
  let handle: ResultFileHandle | undefined;
  let claimToken: string | undefined;
  let phase = "materialize-result-file";
  try {
    handle = (sinks.materializeResultFile ?? materializeResultFile)({
      sessionsDir: input.sessionsDir,
      childSessionId: input.childSessionId,
      deliveryId: input.deliveryId,
      status: input.status,
      agentName: input.agentName,
      answer: input.answer,
      now: (input.now ?? Date.now)(),
    });
    const payload = frameDeliveryPayload({
      status: input.status,
      agentName: input.agentName,
      childSessionId: input.childSessionId,
      childSessionFile: input.childSessionFile,
      answer: input.answer,
      resultPath: handle.path,
      deliveryId: input.deliveryId,
    });
    phase = "publish-inbox";
    if (!sinks.publishInbox || sinks.publishInbox({
      kind: input.status === "settled" ? "settled" : "terminal",
      status: input.status,
      resultContent: payload,
      answer: input.answer,
      resultPath: handle.path,
      childSessionFile: input.childSessionFile,
      deliveryId: input.deliveryId,
    }) !== true) throw new Error("Inbox publication failed");

    phase = "acknowledge-sidecar";
    if (input.sidecarPath) (sinks.acknowledgeSidecar ?? ((path: string) => rmSync(path, { force: true })))(input.sidecarPath);
    if (!input.parent.active) {
      const projection = projectDeliveryState({ hasInbox: true, resultPath: handle.path });
      try { sinks.projectWidget?.(projection); } catch (error) { try { sinks.onFailure?.(error, { deliveryId: input.deliveryId, phase: "widget" }); } catch { /* contained */ } }
      return { projection, resultPath: handle.path };
    }

    phase = "claim-materialization";
    if (!sinks.claimMaterialization) throw new Error("Materialization claim sink is unavailable");
    const claim = sinks.claimMaterialization(destination);
    if (claim.status === "materialized") return { projection: projectDeliveryState({ hasInbox: true, materialized: true, resultPath: handle.path }), resultPath: handle.path };
    if (claim.status !== "acquired" || !claim.token) throw new Error("Materialization claim is busy");
    claimToken = claim.token;

    phase = "send-steer";
    if (!sinks.sendSteer) throw new Error("Exact-parent steer sink is unavailable");
    await sinks.sendSteer(destination, payload);
    phase = "complete-materialization";
    if (!sinks.completeMaterialization?.(claimToken)) throw new Error("Unable to publish materialization acknowledgement");
    claimToken = undefined;
    const projection = projectDeliveryState({ hasInbox: true, materialized: true, resultPath: handle.path });
    try { sinks.log?.("delivery-sent", { childId: input.childSessionId, deliveryId: input.deliveryId, status: input.status, resultPath: handle.path, phase }); } catch (error) { try { sinks.onFailure?.(error, { deliveryId: input.deliveryId, phase: "log" }); } catch { /* contained */ } }
    try { sinks.projectWidget?.(projection); } catch (error) { try { sinks.onFailure?.(error, { deliveryId: input.deliveryId, phase: "widget" }); } catch { /* contained */ } }
    return { projection, resultPath: handle.path };
  } catch (error) {
    if (claimToken) {
      try { sinks.releaseMaterialization?.(claimToken); } catch { /* later recovery reclaims stale ownership */ }
    }
    const fields = { childId: input.childSessionId, deliveryId: input.deliveryId, status: input.status, resultPath: handle?.path, phase };
    containedFailure(sinks, error, fields);
    return { projection: projectDeliveryState({ hasInbox: Boolean(handle), failure: errorText(error), resultPath: handle?.path }), ...(handle ? { resultPath: handle.path } : {}) };
  }
}

/** Read a retained completion sidecar and route it through the durable transaction. */
export async function processCompletionSidecarDelivery(input: {
  sessionFile: string;
  delivery: Omit<DeliveryTransactionInput, "answer" | "sidecarPath"> & { answer?: string };
}): Promise<{ projection: DeliveryProjection; resultPath?: string }> {
  const sidecarPath = `${input.sessionFile}.exit`;
  const sidecar = readExitSidecar(input.sessionFile);
  if (!sidecar) return { projection: { state: "delivered" } };
  const result = interpretExitSidecar(sidecar);
  const answer = input.delivery.answer ?? result.summary ?? result.errorMessage ?? result.ping?.message;
  return runDeliveryTransaction({ ...input.delivery, answer, sidecarPath });
}

function findLineageRoots(root: string): string[] {
  const found = new Set(discoverLineageRoots(root));
  const visit = (dir: string, depth: number) => {
    if (depth > 4) return;
    let entries: ReturnType<typeof readdirSync>;
    try { entries = readdirSync(dir, { withFileTypes: true }) as any; } catch { return; }
    const names = new Set((entries as any[]).map((entry) => entry.name));
    if (names.has("events") && names.has("materialization-claims")) found.add(dir);
    for (const entry of entries as any[]) if (entry.isDirectory()) visit(join(dir, entry.name), depth + 1);
  };
  visit(root, 0);
  return [...found].sort();
}

/** Recover pending inboxes for one exact parent session, preserving retry ordering. */
export async function recoverPendingInboxDeliveries(input: {
  sessionDir: string;
  parentSessionId: string;
  parentSessionFile: string;
  now?: () => number;
  deliver: (record: { deliveryId: string; nodeId: string; content: string; resultPath?: string }) => void | Promise<void>;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}): Promise<{ materialized: string[]; skipped: string[]; failed: string[] }> {
  const materialized: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const rootDir of findLineageRoots(input.sessionDir)) {
    for (const record of pendingLineageInboxes(rootDir, input.parentSessionId, input.parentSessionFile)) {
      const claim = claimLineageInboxMaterialization({
        rootDir,
        deliveryId: record.deliveryId,
        nodeId: record.nodeId,
        hasExactSessionEvidence: () => {
          try { return existsSync(input.parentSessionFile) && readFileSync(input.parentSessionFile, "utf8").includes(record.deliveryId); }
          catch { return false; }
        },
      });
      if (claim.status !== "acquired") { skipped.push(record.deliveryId); continue; }
      try {
        const content = typeof record.payload.resultContent === "string" ? record.payload.resultContent : "";
        await input.deliver({ deliveryId: record.deliveryId, nodeId: record.nodeId, content, resultPath: typeof record.payload.resultPath === "string" ? record.payload.resultPath : undefined });
        if (!completeLineageInboxMaterialization(rootDir, record.deliveryId, record.nodeId, claim.token)) throw new Error("Unable to publish materialization acknowledgement");
        materialized.push(record.deliveryId);
      } catch (error) {
        releaseLineageInboxMaterialization({
          rootDir,
          deliveryId: record.deliveryId,
          nodeId: record.nodeId,
          token: claim.token,
          hasExactSessionEvidence: () => false,
        });
        failed.push(record.deliveryId);
        try { input.log?.("delivery-recovery-failed", { deliveryId: record.deliveryId, childId: record.nodeId, phase: "deliver", error: errorText(error) }); } catch { /* contained */ }
      }
    }
  }
  return { materialized, skipped, failed };
}
