/** Deliberately wrong recovery seam that ignores the requested parent filter. */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	claimLineageInboxMaterialization,
	completeLineageInboxMaterialization,
} from "../../../pi-extension/subagents/lineage.ts";

function lineageRoots(sessionDir: string): string[] {
	const lineageDir = join(sessionDir, "lineage-root");
	return readdirSync(lineageDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => join(lineageDir, entry.name));
}

/** Materialize every inbox in every discovered root, regardless of requested parent identity. */
export async function recoverPendingInboxDeliveries(input: any): Promise<any> {
	const materialized: string[] = [];
	for (const rootDir of lineageRoots(input.sessionDir)) {
		for (const file of readdirSync(join(rootDir, "events")).filter((name) => name.endsWith(".json"))) {
			const event = JSON.parse(readFileSync(join(rootDir, "events", file), "utf8"));
			if (event.type !== "inbox" || typeof event.deliveryId !== "string") continue;
			const claim = claimLineageInboxMaterialization({
				rootDir,
				deliveryId: event.deliveryId,
				nodeId: event.nodeId,
				hasExactSessionEvidence: () => false,
			});
			if (claim.status !== "acquired") continue;
			await input.deliver({
				deliveryId: event.deliveryId,
				nodeId: event.nodeId,
				content: event.payload?.resultContent ?? "",
				resultPath: event.payload?.resultPath,
			});
			completeLineageInboxMaterialization(
				rootDir,
				event.deliveryId,
				event.nodeId,
				claim.token,
			);
			materialized.push(event.deliveryId);
		}
	}
	return { materialized, skipped: [], failed: [] };
}
