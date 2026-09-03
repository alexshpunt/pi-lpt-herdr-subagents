/** Wait without a deadline until durable descendant state reports drained. */
export async function waitForDeliveryDrain(options: {
  isDrained: () => boolean;
  delay?: (ms: number) => Promise<void>;
  now?: () => number;
  onWaitOpen?: (info: { waitedSince: number }) => void;
  onWaitRelease?: (info: { waitedSince: number; waitedMs: number }) => void;
  signal?: AbortSignal;
}): Promise<void> {
  if (options.isDrained()) return;
  const now = options.now ?? Date.now;
  const delay = options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const waitedSince = now();
  options.onWaitOpen?.({ waitedSince });
  while (!options.isDrained()) {
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("Drain wait aborted");
    await delay(50);
  }
  options.onWaitRelease?.({ waitedSince, waitedMs: Math.max(0, now() - waitedSince) });
}
