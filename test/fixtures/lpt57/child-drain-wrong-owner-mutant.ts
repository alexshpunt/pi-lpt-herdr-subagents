/** Deliberately wrong child route that drains and attributes the current child's parent. */
import {
	hasUndrainedDescendants,
	reduceLineage,
} from "../../../pi-extension/subagents/lineage.ts";

/** Wait on the wrong lineage owner so the child-owned grandchild cannot release this route. */
export async function waitForDescendantDrain(options: any = {}): Promise<void> {
	const rootDir = options.lineage?.rootDir;
	const childNodeId = options.lineage?.parentNodeId;
	if (!rootDir || !childNodeId) return;
	const wrongOwnerId = reduceLineage(rootDir).nodes.get(childNodeId)?.parentNodeId ?? childNodeId;
	const delay = options.delay ?? (async () => {});
	const now = options.now ?? Date.now;
	const startedAt = now();
	const isDrained = () => !hasUndrainedDescendants(reduceLineage(rootDir), wrongOwnerId);
	if (isDrained()) return;
	options.onWaitOpen?.({ waitedSince: startedAt });
	options.projectWidget?.("waiting-on-descendants");
	options.log?.("drain-wait-open", { childId: wrongOwnerId, waitedSince: startedAt });
	while (!isDrained()) await delay(50);
	const waitedMs = now() - startedAt;
	options.projectWidget?.("waiting-on-descendants");
	options.log?.("drain-wait-release", { childId: wrongOwnerId, waitedSince: startedAt, waitedMs });
	options.onWaitRelease?.({ waitedSince: startedAt, waitedMs });
}
