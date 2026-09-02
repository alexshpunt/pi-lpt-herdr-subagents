/** Deliberately wrong finite-timeout mutant used to prove TS-07 rejects every numeric bound. */
export async function waitForDeliveryDrain(options: DrainOptions): Promise<void> {
	const now = options.now ?? Date.now;
	const delay = options.delay ?? (async () => {});
	const startedAt = now();
	const configured = Number(process.env.LPT57_FINITE_DRAIN_BOUND_MS ?? Number.MAX_VALUE);
	const finiteBoundMs = Number.isFinite(configured) ? configured : Number.MAX_VALUE;
	if (!options.isDrained()) options.onWaitOpen?.({ waitedSince: startedAt });
	while (!options.isDrained()) {
		await delay(50);
		if (now() - startedAt >= finiteBoundMs) return;
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
