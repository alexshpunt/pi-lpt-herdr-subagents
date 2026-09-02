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
 *   "pane disappeared" text, even when the caller supplies a stale `exitCode`
 * - an absent `answer` is framed honestly: no throw, no fabricated answer text
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

/** Every spelling a framer could use to report a stale exit code as a failure. */
const EXIT_CODE_FAILURE = /exit(?:ed)?(?: with)?\s*code\s*:?\s*1\b/i;

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
		const childSessionFile = "/tmp/sessions/9b5db0d9.jsonl";
		const resultPath = "/tmp/sessions/9b5db0d9/01-closed.md";
		const answer = "Final answer captured before the pane closed.";

		// A production-shaped closed payload carries the exit code of the pane
		// that closed after the answer was captured. That stale code is not a
		// delivery failure and must never be presented as one (R57-11).
		const payload = frame({
			status: "closed",
			agentName: "reviewer",
			childSessionId: "9b5db0d9",
			childSessionFile,
			answer,
			resultPath,
			exitCode: 1,
		});

		// The result path and the session reference both contain "closed", so
		// they are removed before the label is asserted: only a real status
		// label may satisfy this.
		const labelled = payload
			.split(resultPath)
			.join("")
			.split(childSessionFile)
			.join("")
			.split(answer)
			.join("");
		assert.match(
			labelled,
			/\bclosed\b/i,
			"a closed delivery is labelled closed outside its paths and answer",
		);
		assert.doesNotMatch(payload, /pane disappeared/i);
		assert.doesNotMatch(
			payload,
			EXIT_CODE_FAILURE,
			"a captured answer suppresses the stale exit code",
		);
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
					EXIT_CODE_FAILURE,
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

	it("TS-04 frames an answer-less outcome without fabricating an answer", async () => {
		const frame = await loadFrame();

		// Approved setup shape (b): the pane is gone and nothing was captured,
		// so `answer` is absent while the caller still reports the exit code.
		const payload = frame({
			status: "closed",
			agentName: "reviewer",
			childSessionId: "9b5db0d9",
			exitCode: 1,
		});

		assert.equal(
			typeof payload,
			"string",
			"an absent answer is framed, not dereferenced into a crash",
		);
		assert.match(payload, /\bclosed\b/i, "the fixed vocabulary is used honestly");
		assert.doesNotMatch(
			payload,
			/undefined|null|NaN|\[object Object\]/i,
			"no placeholder leaks into model-visible text",
		);
		assert.match(payload, /\S/, "the payload still says something readable");
	});
});
