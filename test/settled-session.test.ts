import assert from "node:assert/strict";
import {
	appendFileSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	captureSessionBaseline,
	findNewestAppendedAssistant,
	readEntriesAfterBaseline,
	type MessageEntry,
} from "../pi-extension/subagents/session.ts";

function message(
	id: string,
	role: "user" | "assistant",
	content: Array<{ type: string; text?: string }>,
	overrides: Record<string, unknown> = {},
): MessageEntry {
	return {
		type: "message",
		id,
		message: { role, content, ...overrides },
	};
}

function sessionFile(entries: unknown[]): { root: string; file: string } {
	const root = mkdtempSync(join(tmpdir(), "settled-session-test-"));
	const file = join(root, "child.jsonl");
	writeFileSync(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return { root, file };
}

describe("settled session cursor", () => {
	it("marks seeded fork history as baseline and reads only later entries", () => {
		const value = sessionFile([
			{ type: "session", id: "session-1" },
			message("old-user", "user", [{ type: "text", text: "old" }]),
			message("old-assistant", "assistant", [
				{ type: "text", text: "inherited answer" },
			]),
		]);
		try {
			const baseline = captureSessionBaseline(value.file);
			assert.equal(baseline.entryCount, 3);
			assert.equal(baseline.leafId, "old-assistant");
			assert.deepEqual(baseline.assistantEntryIds, ["old-assistant"]);
			appendFileSync(
				value.file,
				`${JSON.stringify(message("new-user", "user", [{ type: "text", text: "new" }]))}\n${JSON.stringify(message("new-assistant", "assistant", [{ type: "text", text: "new answer" }], { stopReason: "stop" }))}\n`,
			);
			const appended = readEntriesAfterBaseline(value.file, baseline);
			assert.equal(appended.partialTrailingLine, false);
			assert.equal(findNewestAppendedAssistant(appended.entries)?.id, "new-assistant");
		} finally {
			rmSync(value.root, { recursive: true, force: true });
		}
	});

	it("returns a newest normal response and ignores thinking blocks", () => {
		const result = findNewestAppendedAssistant([
			message("assistant-1", "assistant", [
				{ type: "thinking", text: "private reasoning" },
				{ type: "text", text: "first line" },
				{ type: "text", text: "second line" },
			], { stopReason: "stop" }),
		]);
		assert.deepEqual(result, {
			id: "assistant-1",
			text: "first line\nsecond line",
			contentLength: 22,
			stopReason: "stop",
			empty: false,
		});
	});

	it("preserves a clean empty response instead of falling back to stale text", () => {
		const result = findNewestAppendedAssistant([
			message("old-assistant", "assistant", [{ type: "text", text: "stale" }]),
			message("new-assistant", "assistant", [], { stopReason: "stop" }),
		]);
		assert.deepEqual(result, {
			id: "new-assistant",
			text: null,
			contentLength: 0,
			stopReason: "stop",
			empty: true,
		});
	});

	it("returns provider errors with or without an error message", () => {
		assert.deepEqual(
			findNewestAppendedAssistant([
				message("error-with-detail", "assistant", [], {
					stopReason: "error",
					errorMessage: "rate limited",
				}),
			]),
			{
				id: "error-with-detail",
				text: null,
				contentLength: 0,
				stopReason: "error",
				errorMessage: "rate limited",
				empty: true,
			},
		);
		assert.deepEqual(
			findNewestAppendedAssistant([
				message("error-without-detail", "assistant", [], { stopReason: "error" }),
			]),
			{
				id: "error-without-detail",
				text: null,
				contentLength: 0,
				stopReason: "error",
				empty: true,
			},
		);
	});

	it("preserves aborted state and does not reuse previous output", () => {
		const result = findNewestAppendedAssistant([
			message("previous", "assistant", [{ type: "text", text: "previous" }]),
			message("aborted", "assistant", [], {
				stopReason: "aborted",
				errorMessage: "interrupted",
			}),
		]);
		assert.equal(result?.id, "aborted");
		assert.equal(result?.text, null);
		assert.equal(result?.stopReason, "aborted");
		assert.equal(result?.errorMessage, "interrupted");
		assert.equal(result?.empty, true);
	});

	it("reports and retries a partial trailing JSONL record", () => {
		const value = sessionFile([{ type: "session", id: "session-1" }]);
		try {
			const baseline = captureSessionBaseline(value.file);
			const complete = JSON.stringify(
				message("assistant-1", "assistant", [{ type: "text", text: "done" }], {
					stopReason: "stop",
				}),
			);
			appendFileSync(value.file, `${complete.slice(0, -4)}`);
			const partial = readEntriesAfterBaseline(value.file, baseline);
			assert.equal(partial.entries.length, 0);
			assert.equal(partial.partialTrailingLine, true);
			appendFileSync(value.file, `${complete.slice(-4)}\n`);
			const completed = readEntriesAfterBaseline(value.file, baseline);
			assert.equal(completed.partialTrailingLine, false);
			assert.equal(findNewestAppendedAssistant(completed.entries)?.id, "assistant-1");
		} finally {
			rmSync(value.root, { recursive: true, force: true });
		}
	});
});
