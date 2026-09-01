/**
 * Shared support for the LPT-57 delivery seam tests (TS-01 … TS-09, TS-26).
 *
 * The delivery modules this package will gain under `pi-extension/subagents/`
 * do not exist yet at `eacd653`. Every seam test therefore loads its module
 * dynamically: a missing module or export is reported as an explicit
 * "capability absent" failure instead of a module-resolution crash, so the
 * RED evidence names the scenario that is missing.
 *
 * The types below are the seam contract the tests freeze. They are declared
 * locally because the producing modules do not exist yet.
 */
import assert from "node:assert/strict";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
	mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Fixed delivery status vocabulary (LPT-57 intention R57-11). */
export type DeliveryStatus =
	| "completed"
	| "settled"
	| "help-request"
	| "closed"
	| "crashed"
	| "recovery-failed"
	| "cancelled"
	| "error"
	| "empty";

/** Delivery projection states produced from durable facts (R57-7). */
export type DeliveryState =
	| "none"
	| "delivery-pending"
	| "delivery-failed"
	| "delivered";

export interface DeliveryProjection {
	state: DeliveryState;
	error?: string;
	resultPath?: string;
}

/** Recorded by `delivery-log.ts`; never carries answer text (R57-6). */
export interface DeliveryLogRecord {
	version: number;
	time: string;
	event: string;
	[key: string]: unknown;
}

const tempDirs: string[] = [];

/** Create a run-owned temp directory removed by `cleanupTempDirs()`. */
export function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/** Remove every directory created by `tempDir()` in this process. */
export function cleanupTempDirs(): void {
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop() as string, { recursive: true, force: true });
	}
}

/** Load a module that may not exist yet. Returns null when it is absent. */
export async function loadSeam(
	specifier: string,
): Promise<Record<string, any> | null> {
	try {
		return (await import(specifier)) as Record<string, any>;
	} catch {
		return null;
	}
}

/** Assert the seam module exists and return it. */
export function requireSeam(
	seam: Record<string, any> | null,
	modulePath: string,
): Record<string, any> {
	assert.ok(
		seam,
		`capability absent: ${modulePath} does not exist yet — LPT-57 delivery extraction is not implemented`,
	);
	return seam;
}

/** Assert the seam module exports one named capability and return it. */
export function requireExport<T = any>(
	seam: Record<string, any>,
	exportName: string,
	modulePath: string,
): T {
	const value = seam?.[exportName];
	assert.ok(
		value !== undefined,
		`capability absent: ${modulePath} does not export ${exportName} yet`,
	);
	return value as T;
}

/** Load a seam module and require one named export from it. */
export async function requireSeamExport<T = any>(
	modulePath: string,
	exportName: string,
): Promise<T> {
	const seam = requireSeam(await loadSeam(modulePath), modulePath);
	return requireExport<T>(seam, exportName, modulePath);
}

/** Write a session-shaped Pi JSONL file with only its header line. */
export function writeSessionFile(
	path: string,
	options: { id?: string; cwd: string; timestamp?: string } = {
		cwd: process.cwd(),
	},
): string {
	const header = {
		type: "session",
		version: 3,
		id: options.id ?? "01a05831-0e18-75b8-b891-716c8c93eeb9",
		timestamp: options.timestamp ?? new Date(0).toISOString(),
		cwd: options.cwd,
	};
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(header)}\n`, "utf8");
	return path;
}

/** Count non-overlapping occurrences of `needle` in `haystack`. */
export function countOccurrences(haystack: string, needle: string): number {
	if (!needle) return 0;
	let count = 0;
	let index = haystack.indexOf(needle);
	while (index !== -1) {
		count += 1;
		index = haystack.indexOf(needle, index + needle.length);
	}
	return count;
}

/** Read a JSON-lines file, ignoring blank lines. */
export function readJsonLines(path: string): Array<Record<string, any>> {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, any>);
}
