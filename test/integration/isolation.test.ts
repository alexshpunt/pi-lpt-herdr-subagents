/** Regression coverage for the shipped isolated Herdr integration runner. */
import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cleanupTestEnv,
  createTestEnv,
  getAvailableBackends,
  setBackend,
  restoreBackend,
  type TestEnv,
} from "./harness.ts";

const backends = getAvailableBackends();

function waitForSocket(socket: string, server: ChildProcess): void {
  const deadline = Date.now() + 10_000;
  while (!existsSync(socket) && Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error("sentinel Herdr server exited");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  assert.equal(existsSync(socket), true, "sentinel Herdr server must become ready");
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert.equal(existsSync(path), true, `expected file ${path}`);
}

async function waitForFileContent(path: string, pattern: RegExp, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let content = "";
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      content = readFileSync(path, "utf8");
      if (pattern.test(content)) return content;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert.fail(`expected ${path} to match ${pattern}; content=${content}`);
}

function readProcessGroup(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return undefined;
    const pgid = Number(stat.slice(closeParen + 2).trim().split(/\s+/)[2]);
    return Number.isInteger(pgid) ? pgid : undefined;
  } catch {
    return undefined;
  }
}

function processGroupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function waitForPidGone(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
  assert.fail(`pid ${pid} remained alive`);
}
for (const backend of backends) {
  describe(`integration runner isolation [${backend}]`, () => {
    it("escalates an unresponsive child and server before removing owned paths", async () => {
      const testDir = mkdtempSync(join(process.cwd(), ".agents", "tmp", "runner-shutdown-"));
      const metadataPath = join(testDir, "metadata.json");
      const pidPath = join(testDir, "pids");
      const signalPath = join(testDir, "signals");
      const wrapper = join(process.cwd(), "test", "integration", "run-isolated.ts");
      const fixture = join(process.cwd(), "test", "integration", "runner-fixture.ts");
      const startedAt = Date.now();
      const runner = spawn(process.execPath, ["--experimental-strip-types", wrapper], {
        env: {
          ...process.env,
          PI_INTEGRATION_RUNNER_TEST_FIXTURE: fixture,
          PI_INTEGRATION_RUNNER_TEST_METADATA: metadataPath,
          PI_INTEGRATION_RUNNER_TEST_PIDS: pidPath,
          PI_INTEGRATION_RUNNER_TEST_SIGNALS: signalPath,
          PI_INTEGRATION_RUNNER_TEST_READY: join(testDir, "ready"),
          PI_INTEGRATION_TERMINATE_GRACE_MS: "150",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      runner.stderr?.setEncoding("utf8");
      runner.stderr?.on("data", (chunk: string) => { stderr += chunk; });
      try {
        await waitForFile(`${testDir}/metadata.json`);
        const pidContent = await waitForFileContent(
          `${testDir}/pids`,
          /(?=.*(?:^|\n)child:\d+\n)(?=.*(?:^|\n)child-descendant:\d+\n)(?=.*(?:^|\n)server:\d+\n)(?=.*(?:^|\n)server-descendant:\d+\n)/s,
        );
        await waitForFile(`${testDir}/ready.child`);
        await waitForFile(`${testDir}/ready.server`);
        const pids = pidContent.trim().split("\n").map((line) => {
          const [role, pid] = line.split(":");
          return [role, Number(pid)] as const;
        });
        assert.deepEqual(
          pids.map(([role]) => role).sort(),
          ["child", "child-descendant", "server", "server-descendant"],
          "runner must start each leader with one same-group descendant",
        );
        const childPid = pids.find(([role]) => role === "child")?.[1];
        const childDescendantPid = pids.find(([role]) => role === "child-descendant")?.[1];
        const serverPid = pids.find(([role]) => role === "server")?.[1];
        const serverDescendantPid = pids.find(([role]) => role === "server-descendant")?.[1];
        assert.ok(childPid && childDescendantPid && serverPid && serverDescendantPid, "fixture must report all PIDs");
        const childGroup = readProcessGroup(childPid);
        const childDescendantGroup = readProcessGroup(childDescendantPid);
        const serverGroup = readProcessGroup(serverPid);
        const serverDescendantGroup = readProcessGroup(serverDescendantPid);
        assert.ok(childGroup && childDescendantGroup && serverGroup && serverDescendantGroup);
        assert.equal(childGroup, childDescendantGroup);
        assert.equal(serverGroup, serverDescendantGroup);
        runner.kill("SIGTERM");
        runner.kill("SIGTERM");
        const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
          const timer = setTimeout(() => reject(new Error(`runner did not exit; stderr=${stderr}`)), 4_000);
          runner.once("exit", (code, signal) => {
            clearTimeout(timer);
            resolveExit({ code, signal });
          });
        });
        assert.equal(exit.code, 143, `runner must preserve SIGTERM status; stderr=${stderr}`);
        assert.ok(Date.now() - startedAt < 4_000, "SIGKILL escalation must remain bounded");
        // Leaders exit on SIGTERM, but their descendants ignore it. The
        // wrapper must escalate the still-live groups before removing paths.
        await waitForPidGone(childPid);
        await waitForPidGone(childDescendantPid);
        await waitForPidGone(serverPid);
        await waitForPidGone(serverDescendantPid);
        assert.equal(processGroupExists(childGroup), false, "child process group must be gone");
        assert.equal(processGroupExists(serverGroup), false, "server process group must be gone");
        const signals = readFileSync(signalPath, "utf8");
        assert.match(signals, /child:SIGTERM/);
        assert.match(signals, /child-descendant:SIGTERM/);
        assert.match(signals, /server:SIGTERM/);
        assert.match(signals, /server-descendant:SIGTERM/);
        const paths = JSON.parse(readFileSync(metadataPath, "utf8")) as {
          runDir: string;
          socket: string;
          worktreeDir: string;
          configPath: string;
        };
        for (const path of [paths.runDir, paths.socket, paths.worktreeDir, paths.configPath]) {
          assert.equal(existsSync(path), false, `owned path must be removed: ${path}`);
        }
      } finally {
        if (runner.exitCode === null) runner.kill("SIGKILL");
        if (existsSync(pidPath)) {
          for (const line of readFileSync(pidPath, "utf8").trim().split("\n")) {
            const pid = Number(line.split(":")[1]);
            if (Number.isInteger(pid) && pid > 1) {
              try { process.kill(-pid, "SIGKILL"); } catch {}
            }
          }
        }
        rmSync(testDir, { recursive: true, force: true });
      }
    });
    it("keeps a persistent sentinel workspace separate and unchanged", async () => {
      const persistentDir = mkdtempSync(
        join(process.env.PI_INTEGRATION_HERDR_RUN_DIR ?? "/tmp", "pi-user-herdr-"),
      );
      const socket = join("/tmp", `pi-user-herdr-${persistentDir.split("/").at(-1)}.sock`);
      const configDir = join(persistentDir, "config", "herdr");
      const sentinelRoot = join(persistentDir, "sentinel");
      mkdirSync(configDir, { recursive: true });
      mkdirSync(sentinelRoot, { recursive: true });
      writeFileSync(
        join(configDir, "config.toml"),
        "[server]\nheadless_cols = 120\nheadless_rows = 40\n",
        "utf8",
      );
      const serverEnv = {
        ...process.env,
        HOME: join(persistentDir, "home"),
        XDG_CONFIG_HOME: join(persistentDir, "config"),
        HERDR_CONFIG_PATH: join(configDir, "config.toml"),
        HERDR_SOCKET_PATH: socket,
        HERDR_ENV: "1",
      };
      const server = spawn("herdr", ["server"], {
        env: serverEnv,
        stdio: "ignore",
      });
      let env: TestEnv | undefined;
      try {
        waitForSocket(socket, server);
        const created = JSON.parse(
          execFileSync(
            "herdr",
            ["workspace", "create", "--cwd", sentinelRoot, "--label", "sentinel", "--no-focus"],
            { env: serverEnv, encoding: "utf8" },
          ),
        );
        const sentinelId = created.result.workspace.workspace_id as string;
        const before = execFileSync(
          "herdr",
          ["workspace", "get", sentinelId],
          { env: serverEnv, encoding: "utf8" },
        );

        assert.equal(
          Object.keys(process.env).some((key) => key.startsWith("PI_SUBAGENT_")),
          false,
          "runner must clear inherited subagent identity",
        );
        assert.notEqual(
          process.env.PI_INTEGRATION_HERDR_SOCKET,
          socket,
          "the test runner must use a distinct Herdr endpoint",
        );
        const previousBackend = setBackend(backend);
        try {
          env = createTestEnv(backend);
          assert.equal(
            JSON.stringify(
              execFileSync("herdr", ["workspace", "get", env.workspaceId], { encoding: "utf8" }),
            ).includes(sentinelId),
            false,
          );
          await cleanupTestEnv(env);
          env = undefined;
        } finally {
          restoreBackend(previousBackend);
        }

        const after = execFileSync(
          "herdr",
          ["workspace", "get", sentinelId],
          { env: serverEnv, encoding: "utf8" },
        );
        assert.equal(after, before, "the persistent sentinel workspace must be unchanged");
        execFileSync("herdr", ["workspace", "close", sentinelId], { env: serverEnv });
      } finally {
        if (env) await cleanupTestEnv(env);
        try {
          execFileSync("herdr", ["server", "stop"], { env: serverEnv, stdio: "ignore" });
        } catch {}
        server.kill("SIGTERM");
        rmSync(socket, { force: true });
        rmSync(persistentDir, { recursive: true, force: true });
      }
    });
  });
}
