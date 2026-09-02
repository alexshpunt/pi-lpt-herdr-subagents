/** Deliberately wrong 24-hour-bound mutant used to prove TS-07 rejects a hidden bound. */
export async function waitForDeliveryDrain(options: DrainOptions): Promise<void> {
	const now = options.now ?? Date.now;
	const delay = options.delay ?? (async () => {});
	const startedAt = now();
	if (!options.isDrained()) options.onWaitOpen?.({ waitedSince: startedAt });
	while (!options.isDrained()) {
		await delay(50);
		if (now() - startedAt >= 24 * 60 * 60 * 1000) return;
	}
	options.onWaitRelease?.({ waitedSince: startedAt, waitedMs: now() - startedAt });
}

interface DrainOptions {
	isDrained: () => boolean;
	delay?: (ms: number) => Promise<void>;
	now?: () => number;
	onWaitOpen?: (info: { waitedSince: number }) => void;
	onWaitRelease?: (info: { waitedSince: number; waitedMs: number }) => void;
}
