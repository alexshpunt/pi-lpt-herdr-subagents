import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, it } from "node:test";
import { waitForDescendantDrain } from "./drain-route-no-log-mutant.ts";

const roots: string[] = [];
after(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

it("QB7-001 rejects a real route that never writes its persistent wait pair", async () => {
	const root = mkdtempSync(join(tmpdir(), "lpt57-no-log-mutant-"));
	roots.push(root);
	const logPath = join(root, "subagent-delivery.log");
	await waitForDescendantDrain({
		onWaitOpen: () => {},
		onWaitRelease: () => {},
		projectWidget: () => {},
		log: (event, fields) =>
			appendFileSync(logPath, `${JSON.stringify({ event, ...fields })}\n`, "utf8"),
	});
	assert.ok(existsSync(logPath), "the route must persist drain observability");
	const records = readFileSync(logPath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	assert.deepEqual(records.map((record) => record.event), [
		"drain-wait-open",
		"drain-wait-release",
	]);
});
