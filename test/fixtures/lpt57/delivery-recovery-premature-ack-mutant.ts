/** Deliberately wrong recovery seam that acknowledges before the delivery callback succeeds. */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import {
	claimLineageInboxMaterialization,
	completeLineageInboxMaterialization,
	pendingLineageInboxes,
} from "../../../pi-extension/subagents/lineage.ts";

/** Prematurely complete each claim, making a thrown callback permanently non-retryable. */
export async function recoverPendingInboxDeliveries(input: any): Promise<any> {
	const materialized: string[] = [];
	const skipped: string[] = [];
	const failed: string[] = [];
	const lineageDir = join(input.sessionDir, "lineage-root");
	for (const entry of readdirSync(lineageDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const rootDir = join(lineageDir, entry.name);
		for (const inbox of pendingLineageInboxes(
			rootDir,
			input.parentSessionId,
			input.parentSessionFile,
		)) {
			const claim = claimLineageInboxMaterialization({
				rootDir,
				deliveryId: inbox.deliveryId,
				nodeId: inbox.nodeId,
				hasExactSessionEvidence: () => false,
			});
			if (claim.status !== "acquired") {
				skipped.push(inbox.deliveryId);
				continue;
			}
			completeLineageInboxMaterialization(
				rootDir,
				inbox.deliveryId,
				inbox.nodeId,
				claim.token as string,
			);
			try {
				await input.deliver({
					deliveryId: inbox.deliveryId,
					nodeId: inbox.nodeId,
					content: inbox.payload?.resultContent ?? "",
					resultPath: inbox.payload?.resultPath,
				});
				materialized.push(inbox.deliveryId);
			} catch {
				failed.push(inbox.deliveryId);
			}
		}
	}
	return { materialized, skipped, failed };
}
