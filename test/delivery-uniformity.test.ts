/**
 * TS-09 — uniform delivery contract and one-level propagation.
 *
 * Two halves:
 *
 * - Schema lock-in at the existing tool seam: the `subagent` tool schema must
 *   not gain a delivery, result-file, or watchdog switch at any depth. This
 *   half is green at `eacd653` and locks R57-12 before implementation could add
 *   a switch.
 * - Propagation seam: a payload addressed to one parent carries only that
 *   child's own answer text and its own result path, never a descendant's.
 *   That half is capability absent at `eacd653`.
 *
 * Frozen contract for the Coder — see `test/delivery-payload.test.ts` for the
 * `frameDeliveryPayload` signature. Propagation requirement: a payload is built
 * from exactly one child's own facts, so a grandchild path or answer text can
 * never appear in the grandparent payload.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as subagentsModule from "../pi-extension/subagents/index.ts";
import {
	loadSeam,
	requireExport,
	requireSeam,
	type DeliveryStatus,
} from "./delivery-seam-support.ts";

const SEAM = "../pi-extension/subagents/delivery-payload.ts";

const FORBIDDEN = /deliver|delivery|result-?file|resultFile|resultPath|watchdog|materiali[sz]/i;

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

/** Walk a TypeBox-shaped schema and collect every property name. */
function propertyNames(schema: any, seen = new Set<string>()): Set<string> {
	if (!schema || typeof schema !== "object") return seen;
	if (typeof schema.type === "string" || schema.properties) {
		for (const [name, child] of Object.entries(schema.properties ?? {})) {
			seen.add(name);
			propertyNames(child as any, seen);
		}
	}
	for (const variant of [schema.anyOf, schema.oneOf, schema.allOf] as any[]) {
		if (!Array.isArray(variant)) continue;
		for (const child of variant) propertyNames(child, seen);
	}
	if (schema.items) propertyNames(schema.items, seen);
	for (const [key, value] of Object.entries(schema)) {
		if (key === "properties") continue;
		if (value && typeof value === "object" && "properties" in (value as object)) {
			propertyNames(value as any, seen);
		}
	}
	return seen;
}

describe("TS-09 uniform delivery contract", () => {
	it("TS-09 exposes no delivery or watchdog switch on the subagent tool", () => {
		const registeredTools: Array<any> = [];
		const api = {
			events: { on() {} },
			on() {},
			registerTool(tool: any) {
				registeredTools.push(tool);
			},
			registerCommand() {},
			registerMessageRenderer() {},
			registerShortcut() {},
			sendUserMessage() {},
			sendMessage() {},
			getAllTools() {
				return [];
			},
		} as any;
		(subagentsModule as any).default(api);

		const subagentTool = registeredTools.find((tool) => tool.name === "subagent");
		assert.ok(subagentTool, "the subagent tool is registered");
		const names = [...propertyNames(subagentTool.parameters)].filter((name) =>
			FORBIDDEN.test(name),
		);
		assert.deepEqual(
			names,
			[],
			"delivery is uniform: no caller switch may change how a result is delivered",
		);
	});

	it("TS-09 keeps a payload to one child's own answer and result path", async () => {
		const frame = await loadFrame();
		const childAnswer = "Child's own complete answer.";
		const childResultPath = "/tmp/sessions/child/01-completed.md";
		const grandchildAnswer = "GRANDCHILD-SECRET-ANSWER";
		const grandchildResultPath = "/tmp/sessions/grandchild/07-completed.md";

		const payload = frame({
			status: "completed",
			agentName: "child-agent",
			childSessionId: "child",
			childSessionFile: "/tmp/sessions/child.jsonl",
			answer: childAnswer,
			resultPath: childResultPath,
		});

		assert.match(payload, /Child's own complete answer\./);
		assert.match(payload, /Result file: \/tmp\/sessions\/child\/01-completed\.md/);
		assert.doesNotMatch(payload, /GRANDCHILD-SECRET-ANSWER/);
		assert.doesNotMatch(payload, /grandchild/);
		// A nested two-level fixture must not leak the descendant's own file path.
		const nested = frame({
			status: "completed",
			agentName: "grandchild-agent",
			childSessionId: "grandchild",
			answer: grandchildAnswer,
			resultPath: grandchildResultPath,
		});
		assert.match(nested, /GRANDCHILD-SECRET-ANSWER/);
		assert.doesNotMatch(
			payload,
			new RegExp(grandchildResultPath.replace(/\//g, "\\/")),
		);
	});
});
