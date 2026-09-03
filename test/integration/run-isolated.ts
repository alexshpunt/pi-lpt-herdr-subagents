/**
 * Run integration tests against a test-owned, headless Herdr server.
 *
 * The wrapper is the only supported integration entry point. It gives every
 * Herdr CLI call a private socket, config, state directory, and worktree root,
 * then tears the server down after the child test process exits.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const tempParent = join(projectRoot, ".agents", "tmp");
mkdirSync(tempParent, { recursive: true });

interface HerdrResponse {
  result?: {
    root_pane?: { pane_id?: unknown; tab_id?: unknown };
    workspace?: { workspace_id?: unknown };
    workspaces?: Array<{ workspace_id?: unknown }>;
  };
}

interface ProcessIdentity {
  pid: number;
  pgid: number;
  startTime: string;
}

const configuredGrace = Number(process.env.PI_INTEGRATION_TERMINATE_GRACE_MS ?? "1000");
const TERMINATE_GRACE_MS = Number.isFinite(configuredGrace) ? Math.max(1, configuredGrace) : 1000;
const TERMINATE_POLL_MS = 25;
const failedProcesses = new WeakSet<ChildProcess>();

function trackProcess(process: ChildProcess): void {
  // A spawn error is a confirmed failure of this exact child, not permission
  // to inspect or signal a replacement PID.
  process.once("error", () => failedProcesses.add(process));
}

async function waitForProcessOutcome(process: ChildProcess, timeoutMs: number): Promise<void> {
  if (failedProcesses.has(process) || process.exitCode !== null || process.signalCode !== null) return;
  await new Promise<void>((resolveWait) => {
    const timer = setTimeout(resolveWait, timeoutMs);
    const finish = (): void => {
      clearTimeout(timer);
      resolveWait();
    };
    process.once("error", finish);
    process.once("exit", finish);
  });
}

function runHerdr(args: string[], environment: NodeJS.ProcessEnv): HerdrResponse {
  const result = spawnSync("herdr", args, {
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `herdr ${args.join(" ")} failed (${result.status ?? "signal"}): ` +
        `${result.stderr.trim() || result.stdout.trim() || "(empty)"}`,
    );
  }
  try {
    return JSON.parse(result.stdout) as HerdrResponse;
  } catch {
    throw new Error(`Invalid herdr ${args.join(" ")} response: ${result.stdout.trim()}`);
  }
}

async function waitForSocket(
  socket: string,
  server: ChildProcess,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (failedProcesses.has(server)) {
      throw new Error("isolated Herdr server failed to spawn");
    }
    if (server.exitCode !== null) {
      throw new Error(`isolated Herdr server exited before becoming ready (${server.exitCode})`);
    }
    if (existsSync(socket)) {
      const status = spawnSync("herdr", ["status", "server"], {
        env: environment,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (status.status === 0) return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Timed out waiting for isolated Herdr socket ${socket}`);
}

/** Read the Linux process identity used to guard process-group signals. */
function readProcessIdentity(pid: number): ProcessIdentity | undefined {
  try {
    const stat = requireProcStat(pid);
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return undefined;
    const fields = stat.slice(closeParen + 2).trim().split(/\s+/);
    const pgid = Number(fields[2]);
    const startTime = fields[19];
    if (!Number.isInteger(pgid) || !startTime) return undefined;
    return { pid, pgid, startTime };
  } catch {
    return undefined;
  }
}

function requireProcStat(pid: number): string {
  return readFileSync(`/proc/${pid}/stat`, "utf8");
}

function captureProcessIdentity(process: ChildProcess, label: string): ProcessIdentity {
  if (!process.pid) throw new Error(`isolated ${label} process did not provide a PID`);
  const deadline = Date.now() + 500;
  let identity: ProcessIdentity | undefined;
  while (Date.now() < deadline) {
    identity = readProcessIdentity(process.pid);
    if (identity?.pgid === process.pid) return identity;
    if (process.exitCode !== null) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, TERMINATE_POLL_MS);
  }
  throw new Error(`could not capture isolated ${label} process-group identity (pid=${process.pid})`);
}

function sameProcess(identity: ProcessIdentity): boolean | undefined {
  const current = readProcessIdentity(identity.pid);
  if (current) return current.startTime === identity.startTime && current.pgid === identity.pgid;
  // A missing /proc entry confirms that this leader exited. Other read or
  // parse failures remain unknown so signaling stays fail-closed.
  return existsSync(`/proc/${identity.pid}/stat`) ? undefined : false;
}

function processGroupAlive(identity: ProcessIdentity): boolean | undefined {
  try {
    process.kill(-identity.pgid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    return undefined;
  }
}

function processGone(process: ChildProcess, identity: ProcessIdentity): boolean | undefined {
  if (process.exitCode !== null || process.signalCode !== null) {
    const group = processGroupAlive(identity);
    // The leader may exit before descendants. A live group means the tracked
    // process is not gone yet; an unknown result stays fail-closed.
    return group === false ? true : group === true ? false : undefined;
  }
  const current = sameProcess(identity);
  if (current === undefined || current === true) return false;
  const group = processGroupAlive(identity);
  return group === false ? true : group === true ? false : undefined;
}

function signalProcessGroup(identity: ProcessIdentity, signal: NodeJS.Signals): boolean {
  // Never signal a reused PID or an unverified process group. A negative PID
  // targets the complete detached group, including shells and descendants.
  // Once the leader exits, a still-live group is the remaining identity proof;
  // it must be allowed to receive escalation for resisting descendants.
  const leader = sameProcess(identity);
  const group = processGroupAlive(identity);
  if (
    (leader !== true && !(leader === false && group === true)) ||
    identity.pgid <= 1 ||
    identity.pgid === process.pid ||
    group !== true
  ) {
    return false;
  }
  try {
    process.kill(-identity.pgid, signal);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ESRCH";
  }
}

async function waitForProcessGone(
  process: ChildProcess,
  identity: ProcessIdentity,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const gone = processGone(process, identity);
    if (gone === true) return true;
    if (gone === undefined) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, TERMINATE_POLL_MS));
  }
  return processGone(process, identity) === true;
}

async function terminateTrackedProcess(
  process: ChildProcess | undefined,
  identity: ProcessIdentity | undefined,
  label: string,
): Promise<boolean> {
  if (!process || !process.pid) return true;
  if (failedProcesses.has(process)) return true;
  if (!identity) {
    await waitForProcessOutcome(process, TERMINATE_GRACE_MS);
    return failedProcesses.has(process) || process.exitCode !== null || process.signalCode !== null;
  }
  if (await waitForProcessGone(process, identity, 0)) return true;

  if (!signalProcessGroup(identity, "SIGTERM")) {
    return (await waitForProcessGone(process, identity, 0)) === true;
  }
  if (await waitForProcessGone(process, identity, TERMINATE_GRACE_MS)) return true;

  // The same identity check is required before escalation. If the original
  // group disappeared and its ID was reused, fail closed instead of killing it.
  if (!signalProcessGroup(identity, "SIGKILL")) {
    console.error(`could not escalate isolated ${label}: process identity changed`);
    return (await waitForProcessGone(process, identity, 0)) === true;
  }
  if (await waitForProcessGone(process, identity, TERMINATE_GRACE_MS)) return true;
  console.error(`could not confirm isolated ${label} process-group termination`);
  return false;
}

function childArgs(): string[] {
  if (process.argv.length > 2) return process.argv.slice(2);
  const integrationDir = join(projectRoot, "test", "integration");
  return readdirSync(integrationDir)
    .filter((file) => file.endsWith(".test.ts"))
    .sort()
    .map((file) => join(integrationDir, file));
}

const runDir = mkdtempSync(join(tempParent, "herdr-integration-"));
const configDir = join(runDir, "config", "herdr");
const homeDir = join(runDir, "home");
// Herdr renders worktree paths in an 80-column pane. Keep this owned root
// short so path assertions remain readable even from a deep checkout.
const worktreeDir = join("/tmp", `hw-${runDir.split("/").at(-1)?.slice(-8)}`);
const rootDir = join(runDir, "root");
// Unix domain sockets have a short platform path limit. Keep only the
// endpoint itself in /tmp; all mutable server state remains in runDir.
const socket = join("/tmp", `pi-herdr-${runDir.split("/").at(-1)}.sock`);
const configPath = join(configDir, "config.toml");
mkdirSync(configDir, { recursive: true });
mkdirSync(homeDir, { recursive: true });
mkdirSync(worktreeDir, { recursive: true });
mkdirSync(rootDir, { recursive: true });
writeFileSync(
  configPath,
  `[server]\nheadless_cols = 120\nheadless_rows = 40\n\n[worktrees]\ndirectory = ${JSON.stringify(worktreeDir)}\n`,
  "utf8",
);

const environment: NodeJS.ProcessEnv = { ...process.env };
for (const key of Object.keys(environment)) {
  if (key.startsWith("PI_SUBAGENT_")) delete environment[key];
}

// A test run started from inside a restricted child session must still create
// an ordinary top-level Pi parent. The deny list is child capability state,
// even though its legacy variable name does not carry the PI_SUBAGENT_ prefix.
delete environment.PI_DENY_TOOLS;
for (const key of [
  "HERDR_ACTIVE_WORKSPACE_ID",
  "HERDR_ACTIVE_TAB_ID",
  "HERDR_ACTIVE_PANE_ID",
  "HERDR_PANE_ID",
  "HERDR_TAB_ID",
  "HERDR_WORKSPACE_ID",
  "HERDR_SESSION",
]) {
  delete environment[key];
}
// These variables are deliberately set for every child process. A failed or
// missing endpoint must never fall back to the user's persistent Herdr server.
environment.HOME = homeDir;
environment.XDG_CONFIG_HOME = join(runDir, "config");
environment.HERDR_CONFIG_PATH = configPath;
environment.HERDR_SOCKET_PATH = socket;
environment.HERDR_ENV = "1";

environment.PI_INTEGRATION_HERDR_SOCKET = socket;
environment.PI_INTEGRATION_HERDR_RUN_DIR = runDir;
environment.PI_INTEGRATION_HERDR_WORKTREE_DIR = worktreeDir;

let server: ChildProcess | undefined;
let child: ChildProcess | undefined;
let serverIdentity: ProcessIdentity | undefined;
let childIdentity: ProcessIdentity | undefined;
let exitCode = 1;
let requestedExitCode: number | undefined;
let shutdownPromise: Promise<void> | undefined;
let logFd: number | undefined;
let cleanupComplete = false;
let cleanupError: unknown;

function signalExitCode(signal: NodeJS.Signals): number {
  return { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 }[signal];
}

function removeOwnedPaths(): void {
  if (cleanupComplete) return;
  // These paths are created by this invocation only. Never broaden this to a
  // prefix scan: another runner or a user's persistent server is foreign.
  rmSync(socket, { force: true });
  rmSync(worktreeDir, { recursive: true, force: true });
  rmSync(runDir, { recursive: true, force: true });
  cleanupComplete = true;
}

async function shutdown(): Promise<void> {
  let childStopped = false;
  let serverStopped = false;
  try {
    // Child first: it may still be using the private Herdr endpoint or cwd.
    childStopped = await terminateTrackedProcess(child, childIdentity, "test child");
    // Do not ask an unresponsive server over its socket. Signals are sent only
    // to the captured detached group and are followed by confirmed exit.
    serverStopped = await terminateTrackedProcess(server, serverIdentity, "Herdr server");
    if (!childStopped || !serverStopped) {
      cleanupError = new Error(
        `isolated teardown could not confirm termination (child=${childStopped}, server=${serverStopped})`,
      );
      console.error(cleanupError.message);
      return;
    }
    removeOwnedPaths();
  } catch (error) {
    cleanupError = error;
    console.error(error instanceof Error ? error.message : String(error));
  } finally {
    if (logFd !== undefined) {
      // The descriptor is local to this wrapper and is safe to close even when
      // a process identity could not be confirmed.
      try {
        closeSync(logFd);
      } catch {
        // Reporting the failed process confirmation above is the important part.
      }
      logFd = undefined;
    }
  }
}

function requestShutdown(signal?: NodeJS.Signals): void {
  if (signal && requestedExitCode === undefined) requestedExitCode = signalExitCode(signal);
  if (requestedExitCode !== undefined) exitCode = requestedExitCode;
  shutdownPromise ??= shutdown();
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.on(signal, () => requestShutdown(signal));
}

try {
  const fixture = process.env.PI_INTEGRATION_RUNNER_TEST_FIXTURE;
  if (fixture) {
    const metadata = process.env.PI_INTEGRATION_RUNNER_TEST_METADATA;
    if (metadata) {
      writeFileSync(
        metadata,
        JSON.stringify({ runDir, socket, worktreeDir, configPath }),
        "utf8",
      );
    }
    server = spawn(process.execPath, ["--experimental-strip-types", fixture, "server"], {
      detached: true,
      env: environment,
      stdio: "ignore",
    });
    trackProcess(server);
    serverIdentity = captureProcessIdentity(server, "Herdr server");
  } else {
    logFd = openSync(join(runDir, "herdr-server.log"), "w");
    server = spawn("herdr", ["server"], {
      detached: true,
      env: environment,
      stdio: ["ignore", logFd, logFd],
    });
    trackProcess(server);
    serverIdentity = captureProcessIdentity(server, "Herdr server");
    await waitForSocket(socket, server, environment);
    const initialWorkspaces = runHerdr(["workspace", "list"], environment).result?.workspaces ?? [];
    if (initialWorkspaces.length > 0) {
      throw new Error("isolated Herdr endpoint unexpectedly contained pre-existing workspaces");
    }
    const root = runHerdr(
      ["workspace", "create", "--cwd", rootDir, "--label", "pi-integration-root", "--no-focus"],
      environment,
    );
    const workspaceId = root.result?.workspace?.workspace_id;
    const paneId = root.result?.root_pane?.pane_id;
    const tabId = root.result?.root_pane?.tab_id;
    if (
      typeof workspaceId !== "string" ||
      typeof paneId !== "string" ||
      typeof tabId !== "string"
    ) {
      throw new Error("isolated Herdr root workspace response was incomplete");
    }
    environment.HERDR_WORKSPACE_ID = workspaceId;
    environment.HERDR_PANE_ID = paneId;
    environment.HERDR_TAB_ID = tabId;
  }
  if (!server) throw new Error("isolated Herdr server did not start");
  if (fixture) {
    child = spawn(process.execPath, ["--experimental-strip-types", fixture, "child"], {
      detached: true,
      env: environment,
      stdio: "ignore",
    });
    trackProcess(child);
  } else {
    child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--test", "--test-concurrency=1", ...childArgs()],
      { detached: true, env: environment, stdio: "inherit" },
    );
    trackProcess(child);
  }
  if (!child) throw new Error("isolated test child did not start");
  childIdentity = captureProcessIdentity(child, "test child");
  exitCode = await new Promise<number>((resolveExit) => {
    child!.once("exit", (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
  });
} catch (error) {
  exitCode = requestedExitCode ?? 1;
  console.error(error instanceof Error ? error.message : String(error));
} finally {
  requestShutdown();
}

await shutdownPromise;
if (cleanupError) exitCode = requestedExitCode ?? 1;
process.exitCode = requestedExitCode ?? exitCode;
