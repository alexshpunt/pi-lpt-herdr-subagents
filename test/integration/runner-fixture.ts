import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const role = process.argv[2];
const leader = role === "child" || role === "server";
const descendant = role === "child-descendant" || role === "server-descendant";
if (!leader && !descendant) throw new Error(`unknown fixture role: ${role}`);

const pidFile = process.env.PI_INTEGRATION_RUNNER_TEST_PIDS;
const signalFile = process.env.PI_INTEGRATION_RUNNER_TEST_SIGNALS;
if (pidFile) appendFileSync(pidFile, `${role}:${process.pid}\n`, "utf8");

function record(signal: string): void {
  if (signalFile) appendFileSync(signalFile, `${role}:${signal}\n`, "utf8");
}

// Descendants deliberately ignore graceful signals. Leaders exit on SIGTERM,
// so teardown must keep tracking the process group after its leader is gone.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(signal, () => {
    record(signal);
    if (leader) process.exit(0);
  });
}

if (leader) {
  // The default detached:false keeps this child in the leader's detached
  // process group. The wrapper must terminate both members before cleanup.
  spawn(process.execPath, ["--experimental-strip-types", process.argv[1], `${role}-descendant`], {
    stdio: "ignore",
  });
}

const readyFile = process.env.PI_INTEGRATION_RUNNER_TEST_READY;
if (readyFile) writeFileSync(`${readyFile}.${role}`, "ready\n", "utf8");
setInterval(() => {}, 1_000);
await new Promise<void>(() => {});
