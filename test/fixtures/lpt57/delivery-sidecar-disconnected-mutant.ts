import { existsSync, readFileSync, rmSync } from "node:fs";

/** Deliberately wrong adapter that acknowledges a sidecar without running the durable transaction. */
export async function processCompletionSidecarDelivery(input: any): Promise<any> {
	const sidecarPath = `${input.sessionFile}.exit`;
	if (!existsSync(sidecarPath)) return { projection: { state: "none" } };
	JSON.parse(readFileSync(sidecarPath, "utf8"));
	rmSync(sidecarPath, { force: true });
	return { projection: { state: "delivered" } };
}
