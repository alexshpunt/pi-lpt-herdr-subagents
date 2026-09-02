import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Deliberately wrong logger that drops only two known answer aliases. */
export function createDeliveryLog(options: {
	logPath: string;
	now?: () => number;
	onFailure?: (error: unknown) => void;
}): { record(event: string, fields?: Record<string, unknown>): void } {
	return {
		record(event, fields = {}) {
			const { answer: _answer, resultContent: _resultContent, ...copied } = fields;
			try {
				requireAppend(options.logPath, {
					version: 1,
					time: new Date((options.now ?? Date.now)()).toISOString(),
					event,
					...copied,
				});
			} catch (error) {
				try { options.onFailure?.(error); } catch {}
			}
		},
	};
}

function requireAppend(path: string, record: Record<string, unknown>): void {
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${JSON.stringify(record)}\n`, "utf8");
}
