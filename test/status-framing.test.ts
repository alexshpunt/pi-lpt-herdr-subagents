/**
 * TS-04 — honest status framing.
 *
 * Seam under test: `pi-extension/subagents/delivery-payload.ts` (framing half).
 *
 * R57-11: the fixed status vocabulary is applied honestly to a payload. A
 * `closed` delivery that captured an answer is never framed as an error, never
 * carries exit code 1, and never claims the pane disappeared. Routing an
 * outcome *into* a status stays LPT-58; this child owns the framing only.
 *
 * Frozen contract for the Coder — see `test/delivery-payload.test.ts` for the
 * `frameDeliveryPayload` signature. Additional requirements frozen here:
 * - `closed` + captured answer → `closed` label, no exit-code framing, no
 *   "pane disappeared" text
 * - no payload may be framed with a status outside `DELIVERY_STATUSES`
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

const FIXED_STATUSES: readonly DeliveryStatus[] = [
	"completed",
	"settled",
	"help-request",
	"closed",
	"crashed",
	"recovery-failed",
	"cancelled",
	"error",
	"empty",
];

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

describe("TS-04 honest status framing", () => {
	it("TS-04 frames a closed delivery with a captured answer as closed", async () => {
		const frame = await loadFrame();

		const payload = frame({
			status: "closed",
			agentName: "reviewer",
			childSessionId: "9b5db0d9",
			childSessionFile: "/tmp/sessions/9b5db0d9.jsonl",
			answer: "Final answer captured before the pane closed.",
			resultPath: "/tmp/sessions/9b5db0d9/01-closed.md",
		});

		assert.match(payload, /closed/i, "a closed delivery is labelled closed");
		assert.doesNotMatch(payload, /pane disappeared/i);
		assert.doesNotMatch(payload, /exit ?code 1/i);
		assert.doesNotMatch(payload, /"?reason"?: ?"?error"?/i);
		assert.match(payload, /Final answer captured before the pane closed\./);
	});

	it("TS-04 frames every fixed status without a foreign failure label", async () => {
		const frame = await loadFrame();

		for (const status of FIXED_STATUSES) {
			const payload = frame({
				status,
				agentName: "reviewer",
				childSessionId: "9b5db0d9",
				childSessionFile: "/tmp/sessions/9b5db0d9.jsonl",
				answer: "captured answer",
			});

			assert.match(
				payload,
				new RegExp(status.replace("-", "[ -]"), "i"),
				`payload for status ${status} names that status`,
			);
			if (status !== "error" && status !== "crashed" && status !== "recovery-failed") {
				assert.doesNotMatch(
					payload,
					/exit ?code 1/i,
					`status ${status} must not be framed with exit code 1`,
				);
			}
		}
	});

	it("TS-04 keeps the result path and session reference on a closed payload", async () => {
		const frame = await loadFrame();

		const payload = frame({
			status: "closed",
			agentName: "reviewer",
			childSessionId: "9b5db0d9",
			childSessionFile: "/tmp/sessions/9b5db0d9.jsonl",
			answer: "captured answer",
			resultPath: "/tmp/sessions/9b5db0d9/01-closed.md",
		});

		assert.match(payload, /Result file: \/tmp\/sessions\/9b5db0d9\/01-closed\.md/);
		assert.match(payload, /Session: \/tmp\/sessions\/9b5db0d9\.jsonl/);
	});
});
