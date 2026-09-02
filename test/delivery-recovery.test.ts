/**
 * TS-26 — incident-state recovery at the ledger seam.
 *
 * The frozen 09:46 incident evidence is read-only. This test copies the needed
 * lineage subtree into a run-owned temp directory with `cpSync` and mutates
 * only that copy: it keeps one durable `inbox:*` event, points it at a
 * synthesized parent session, and creates that parent session as a valid Pi
 * session JSONL with **no** matching `customType: "subagent_result"` entry — the
 * incident's parent-side fingerprint. Nothing is written to the evidence source.
 *
 * Seams:
 * - `pi-extension/subagents/lineage.ts` — existing inbox/claims ledger. The
 *   fixture-truth suite below is green at `eacd653` and proves the durable state
 *   that LPT-57 must recover, with no second ledger.
 * - `pi-extension/subagents/delivery.ts` — the recovery seam (capability absent
 *   at `eacd653`; today nothing consumes an orphaned inbox event).
 *
 * Frozen contract for the Coder:
 *
 * ```ts
 * export function recoverPendingInboxDeliveries(input: {
 *   sessionDir: string;                    // Pi sessions directory
 *   parentSessionId: string;
 *   parentSessionFile: string;
 *   now?: () => number;
 *   deliver: (record: {
 *     deliveryId: string;
 *     nodeId: string;
 *     content: string;
 *     resultPath?: string;
 *   }) => void | Promise<void>;
 *   log?: (event: string, fields?: Record<string, unknown>) => void;
 * }): Promise<{ materialized: string[]; skipped: string[]; failed: string[] }>;
 * ```
 *
 * Required behavior (R57-8, R57-14):
 * - an orphaned inbox projects `delivery-pending`, never finished
 * - resumed supervision materializes it exactly once through the existing
 *   lineage inbox + `materialization-claims` ledger
 * - a second resume produces no duplicate entry and no second acknowledgement
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
	cpSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	hasLineageEvent,
	isLineageInboxMaterialized,
	pendingLineageInboxes,
} from "../pi-extension/subagents/lineage.ts";
import {
	loadSeam,
	requireExport,
	requireSeam,
	writeSessionFile,
} from "./delivery-seam-support.ts";

const DELIVERY_SEAM = "../pi-extension/subagents/delivery.ts";

/** Frozen, read-only incident evidence captured 2026-09-01 09:46. */
const FROZEN_INCIDENT =
	"/root/.herdr/worktrees/pi-lpt-herdr-subagents/lpt-56-subagent-result-delivery/.lpt/project/tasks/LPT-56-subagent-result-delivery/evidence/incident-2026-09-01-0946/lineage-root";

const PARENT_SESSION_ID = "01a05831-0e18-75b8-b891-716c8c93eeb9";
/** The delivery under proof: the resume-created node's terminal inbox. */
const PROOF_DELIVERY_ID = "terminal:9b5db0d9";
const PROOF_NODE_ID = "9b5db0d9";

interface RecoveryFixture {
	rootDir: string;
	parentSessionFile: string;
	root: string;
}

/** Copy the frozen lineage subtree and shape it into the incident state under proof. */
function buildIncidentCopy(): RecoveryFixture {
	assert.ok(
		existsSync(FROZEN_INCIDENT),
		`frozen incident evidence is missing at ${FROZEN_INCIDENT}`,
	);
	const root = mkdtempSync(join(tmpdir(), "pi-ts26-incident-"));
	const lineageRoot = join(root, "lineage-root");
	cpSync(FROZEN_INCIDENT, lineageRoot, { recursive: true });

	const rootDir = join(
		lineageRoot,
		readdirSync(lineageRoot)[0] as string,
	);
	const eventsDir = join(rootDir, "events");
	const parentSessionFile = join(root, "parent-session.jsonl");
	writeSessionFile(parentSessionFile, { id: PARENT_SESSION_ID, cwd: root });

	const claimed = new Set<string>();
	for (const file of readdirSync(eventsDir)) {
		const path = join(eventsDir, file);
		const event = JSON.parse(readFileSync(path, "utf8")) as {
			type?: string;
			deliveryId?: string;
			eventId?: string;
		};
		if (event.type !== "inbox") continue;
		if (event.deliveryId !== PROOF_DELIVERY_ID) {
			rmSync(path, { force: true }); // trim the copy to the delivery under proof
			continue;
		}
		claimed.add(event.deliveryId as string);
		// Point the durable sink at the run-owned parent session; the source keeps
		// pointing at the incident machine's session file.
		writeFileSync(
			path,
			JSON.stringify({
				...event,
				sessionId: PARENT_SESSION_ID,
				sessionFile: parentSessionFile,
			}),
			"utf8",
		);
	}
	assert.deepEqual(
		[...claimed],
		[PROOF_DELIVERY_ID],
		"the trimmed fixture keeps exactly the incident's orphaned inbox",
	);

	return { rootDir, parentSessionFile, root };
}

function parentEntriesContaining(parentSessionFile: string, needle: string): string[] {
	return readFileSync(parentSessionFile, "utf8")
		.split("\n")
		.filter((line) => line.includes(needle));
}

/** The existing ledger's stable claim path is derived from the delivery id. */
function materializationClaimPath(rootDir: string, deliveryId: string): string {
	const safeId = Buffer.from(deliveryId, "utf8").toString("base64url");
	return join(rootDir, "materialization-claims", `${safeId}.claim`);
}

function readMaterializationClaim(rootDir: string, deliveryId: string): string {
	const path = materializationClaimPath(rootDir, deliveryId);
	assert.ok(existsSync(path), `the stable materialization claim exists at ${path}`);
	return readFileSync(path, "utf8");
}

const cleanups: string[] = [];
after(() => {
	while (cleanups.length > 0) rmSync(cleanups.pop() as string, { recursive: true, force: true });
});

describe("TS-26 frozen incident state (existing ledger seams)", () => {
	it("TS-26 keeps one pending inbox with an empty claims ledger and no parent entry", () => {
		const fixture = buildIncidentCopy();
		cleanups.push(fixture.root);

		const pending = pendingLineageInboxes(
			fixture.rootDir,
			PARENT_SESSION_ID,
			fixture.parentSessionFile,
		);
		assert.deepEqual(
			pending.map((record) => record.deliveryId),
			[PROOF_DELIVERY_ID],
		);
		assert.equal(pending[0]?.nodeId, PROOF_NODE_ID);
		assert.equal(
			isLineageInboxMaterialized(fixture.rootDir, PROOF_DELIVERY_ID),
			false,
			"the incident inbox was never materialized",
		);
		assert.deepEqual(
			readdirSync(join(fixture.rootDir, "materialization-claims")),
			[],
			"the incident left the claims ledger empty",
		);
		assert.deepEqual(
			parentEntriesContaining(fixture.parentSessionFile, PROOF_DELIVERY_ID),
			[],
			"the parent session never received this result",
		);
		const recordedPayload = pending[0]?.payload?.resultContent;
		assert.equal(typeof recordedPayload, "string");
		assert.ok(
			(recordedPayload as string).length > 0,
			"the durable inbox still carries the recorded payload",
		);
	});
});

describe("TS-26 recovery projection and single materialization", () => {
	it("TS-26 projects delivery-pending before resumed supervision", async () => {
		const seam = requireSeam(await loadSeam(DELIVERY_SEAM), DELIVERY_SEAM);
		const project = requireExport<any>(seam, "projectDeliveryState", DELIVERY_SEAM);
		const fixture = buildIncidentCopy();
		cleanups.push(fixture.root);

		const projection = project({
			hasInbox: true,
			materialized: isLineageInboxMaterialized(fixture.rootDir, PROOF_DELIVERY_ID),
		});

		assert.equal(
			projection.state,
			"delivery-pending",
			"a durable inbox without a claim is pending, never finished",
		);
	});

	it("TS-26 materializes the orphaned inbox exactly once through the ledger", async () => {
		const seam = requireSeam(await loadSeam(DELIVERY_SEAM), DELIVERY_SEAM);
		const recover = requireExport<any>(
			seam,
			"recoverPendingInboxDeliveries",
			DELIVERY_SEAM,
		);
		const fixture = buildIncidentCopy();
		cleanups.push(fixture.root);
		const delivered: Array<{ deliveryId: string; content: string }> = [];

		const first = await recover({
			sessionDir: fixture.root,
			parentSessionId: PARENT_SESSION_ID,
			parentSessionFile: fixture.parentSessionFile,
			now: () => 1_788_247_000_000,
			deliver: (record: { deliveryId: string; content: string }) => {
				delivered.push(record);
				writeFileSync(
					fixture.parentSessionFile,
					`${JSON.stringify({
						type: "custom",
						customType: "subagent_result",
						deliveryId: record.deliveryId,
						content: record.content,
					})}\n`,
					{ flag: "a" },
				);
			},
			log: () => {},
		});

		assert.deepEqual(first.materialized, [PROOF_DELIVERY_ID]);
		assert.equal(delivered.length, 1, "resumed supervision delivers the payload once");
		assert.equal(delivered[0]?.deliveryId, PROOF_DELIVERY_ID);
		assert.ok(
			(delivered[0]?.content ?? "").length > 0,
			"the recovered entry carries the recorded payload",
		);
		assert.equal(
			parentEntriesContaining(fixture.parentSessionFile, PROOF_DELIVERY_ID).length,
			1,
			"exactly one parent-session entry",
		);
		assert.ok(
			hasLineageEvent(
				fixture.rootDir,
				`materialized:${PROOF_DELIVERY_ID}`,
				"inbox_materialized",
			),
			"the existing lineage ledger records one materialization acknowledgement",
		);

		const firstClaim = readMaterializationClaim(fixture.rootDir, PROOF_DELIVERY_ID);
		const claim = JSON.parse(firstClaim) as Record<string, unknown>;
		assert.equal(claim.deliveryId, PROOF_DELIVERY_ID, "the claim is for the recovered delivery");
		assert.equal(claim.nodeId, PROOF_NODE_ID, "the claim is for the recovered node");
		assert.equal(
			isLineageInboxMaterialized(fixture.rootDir, PROOF_DELIVERY_ID),
			true,
			"the claim is paired with the durable materialized state",
		);
		assert.deepEqual(
			pendingLineageInboxes(
				fixture.rootDir,
				PARENT_SESSION_ID,
				fixture.parentSessionFile,
			),
			[],
			"the exact parent inbox is no longer pending after materialization",
		);
		assert.equal(
			readdirSync(join(fixture.rootDir, "materialization-claims")).filter((file) =>
				file.endsWith(".claim"),
			).length,
			1,
			"the existing claims ledger contains exactly one stable delivery claim",
		);

		const second = await recover({
			sessionDir: fixture.root,
			parentSessionId: PARENT_SESSION_ID,
			parentSessionFile: fixture.parentSessionFile,
			now: () => 1_788_247_060_000,
			deliver: (record: { deliveryId: string; content: string }) => {
				delivered.push(record);
			},
			log: () => {},
		});

		assert.deepEqual(second.materialized, [], "a second resume materializes nothing");
		assert.equal(delivered.length, 1, "no duplicate delivery after the second resume");
		assert.equal(
			parentEntriesContaining(fixture.parentSessionFile, PROOF_DELIVERY_ID).length,
			1,
		);
		assert.equal(
			readMaterializationClaim(fixture.rootDir, PROOF_DELIVERY_ID),
			firstClaim,
			"the second resume leaves the one exact delivery claim unchanged",
		);
		assert.equal(
			readdirSync(join(fixture.rootDir, "materialization-claims")).filter((file) =>
				file.endsWith(".claim"),
			).length,
			1,
			"the second resume does not create a second materialization claim",
		);
	});
});
