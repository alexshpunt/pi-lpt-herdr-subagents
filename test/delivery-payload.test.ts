/**
 * TS-03 — full-fidelity delivery payload at the framing seam.
 *
 * The in-place replacement of the six obsolete abbreviation tests lives in
 * `test/test.ts` (they exercise the live `resolveResultPresentation` /
 * `sendSubagentResult` seams of `pi-extension/subagents/index.ts`). This file
 * freezes the same contract at the extracted framing seam.
 *
 * Seam under test: `pi-extension/subagents/delivery-payload.ts`
 *
 * Frozen contract for the Coder:
 *
 * ```ts
 * export const DELIVERY_STATUSES: readonly DeliveryStatus[];   // fixed vocabulary
 * export function frameDeliveryPayload(input: {
 *   status: DeliveryStatus;
 *   agentName: string;
 *   childSessionId: string;
 *   childSessionFile?: string;   // session reference source
 *   answer?: string;             // verbatim complete answer
 *   resultPath?: string;         // absolute result-file path
 *   deliveryId?: string;
 *   elapsed?: number;
 *   exitCode?: number;
 * }): string;
 * ```
 *
 * Required behavior:
 * - the payload carries the complete verbatim answer, never an abbreviation
 * - it carries `Result file: <absolute path>` and the child session reference
 * - no 16 000-character cap, no "result abbreviated" marker
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	loadSeam,
	requireExport,
	requireSeam,
	type DeliveryStatus,
} from "./delivery-seam-support.ts";

const SEAM = "../pi-extension/subagents/delivery-payload.ts";

type Frame = (input: {
	status: DeliveryStatus;
	agentName: string;
	childSessionId: string;
	childSessionFile?: string;
	answer?: string;
	resultPath?: string;
	deliveryId?: string;
	elapsed?: number;
	exitCode?: number;
}) => string;

async function loadFrame(): Promise<Frame> {
	const seam = requireSeam(await loadSeam(SEAM), SEAM);
	return requireExport<Frame>(seam, "frameDeliveryPayload", SEAM);
}

describe("TS-03 full-fidelity delivery payload", () => {
	it("TS-03 frames the complete answer with its result path and session reference", async () => {
		const frame = await loadFrame();
		const answer = `HEAD-${"h".repeat(100_000)}-MIDDLE-${"t".repeat(99_960)}-TAIL`;
		const resultPath = "/tmp/sessions/9b5db0d9/01-completed.md";
		const childSessionFile = "/tmp/sessions/2026-09-01T07-14-26-761Z_9b5db0d9.jsonl";

		const payload = frame({
			status: "completed",
			agentName: "reviewer",
			childSessionId: "9b5db0d9",
			childSessionFile,
			answer,
			resultPath,
			elapsed: 42,
		});

		assert.ok(payload.includes(answer), "the payload carries the complete answer");
		assert.equal(
			payload.slice(payload.indexOf(answer), payload.indexOf(answer) + answer.length),
			answer,
			"the answer is byte-for-byte identical",
		);
		assert.doesNotMatch(payload, /abbreviated/i, "no abbreviation marker");
		assert.match(payload, /Result file: \/tmp\/sessions\/9b5db0d9\/01-completed\.md/);
		assert.match(payload, /Session: \/tmp\/sessions\/2026-09-01T07-14-26-761Z_9b5db0d9\.jsonl/);
		assert.match(payload, /Resume: pi --session \S+\.jsonl/);
	});

	it("TS-03 keeps a 200k-character answer out of any bounded presentation", async () => {
		const frame = await loadFrame();
		const answer = "x".repeat(200_000);

		const payload = frame({
			status: "settled",
			agentName: "reviewer",
			childSessionId: "37721bc6",
			answer,
		});

		assert.ok(payload.length >= 200_000, `payload was bounded to ${payload.length} chars`);
		assert.equal(payload.split(answer).length - 1, 1);
	});

	it("TS-03 exposes the fixed delivery status vocabulary", async () => {
		const seam = requireSeam(await loadSeam(SEAM), SEAM);
		const statuses = requireExport<readonly string[]>(
			seam,
			"DELIVERY_STATUSES",
			SEAM,
		);

		assert.deepEqual([...statuses].sort(), [
			"cancelled",
			"closed",
			"completed",
			"crashed",
			"empty",
			"error",
			"help-request",
			"recovery-failed",
			"settled",
		]);
	});
});
