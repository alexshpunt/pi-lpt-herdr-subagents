/** Deliberately wrong route that reports transient callbacks but omits durable log writes. */
export async function waitForDescendantDrain(options: RouteOptions): Promise<void> {
	options.onWaitOpen?.();
	options.projectWidget?.("waiting-on-descendants");
	options.onWaitRelease?.();
}

interface RouteOptions {
	onWaitOpen?: () => void;
	onWaitRelease?: () => void;
	projectWidget?: (projection: unknown) => void;
	log?: (event: string, fields?: Record<string, unknown>) => void;
}
