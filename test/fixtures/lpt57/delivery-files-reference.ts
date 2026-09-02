/** Independently reviewable result-file reference used only to validate TS-01 itself. */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface MaterializeInput {
	sessionsDir: string;
	childSessionId: string;
	deliveryId: string;
	status: string;
	agentName: string;
	answer?: string;
	now: number;
}

interface MaterializedResult {
	path: string;
	sequence: number;
	filename: string;
}

function deliveryIdFrom(contents: string): string | undefined {
	const header = contents.split(/\r?\n\r?\n/, 1)[0] ?? "";
	return /^delivery[\s_-]+id\s*[:=]\s*(.+)$/im.exec(header)?.[1]?.trim();
}

/** Materialize one immutable result using an exclusive final-path write and on-disk rescan. */
export function materializeResultFile(input: MaterializeInput): MaterializedResult {
	const dir = join(input.sessionsDir, input.childSessionId);
	mkdirSync(dir, { recursive: true });

	for (;;) {
		const files = readdirSync(dir).filter((file) => /^\d+-.*\.md$/.test(file));
		for (const file of files) {
			const path = join(dir, file);
			try {
				if (deliveryIdFrom(readFileSync(path, "utf8")) === input.deliveryId) {
					const sequence = Number.parseInt(file, 10);
					return { path, sequence, filename: file };
				}
			} catch {}
		}

		const sequence =
			Math.max(0, ...files.map((file) => Number.parseInt(file, 10)).filter(Number.isFinite)) + 1;
		const filename = `${String(sequence).padStart(2, "0")}-${input.status}.md`;
		const path = join(dir, filename);
		const answer = input.answer ?? "Nothing was captured.";
		const contents = [
			`status: ${input.status}`,
			`agent name: ${input.agentName}`,
			`child session id: ${input.childSessionId}`,
			`timestamp: ${new Date(input.now).toISOString()}`,
			`delivery sequence: ${sequence}`,
			`delivery id: ${input.deliveryId}`,
			"",
			answer,
		].join("\n");
		try {
			writeFileSync(path, contents, { flag: "wx" });
			return { path, sequence, filename };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
}
