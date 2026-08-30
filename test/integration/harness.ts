/**
 * Integration test harness for Pi Herdr Agents.
 *
 * Provides utilities to:
 * - Detect whether herdr is available
 * - Create isolated test environments with test agent definitions
 * - Start real pi sessions in herdr panes
 * - Poll for file creation and screen output
 * - Clean up surfaces and temp files after tests
 */
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readlinkSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { TEST_MODEL as FIXTURE_MODEL, TEST_PROVIDER_URL } from "./fake-provider.ts";
import {
  isTerminalAvailable,
  createSubagentPane,
  createSubagentWorktree,
  runInPane,
  runScriptInPane,
  readPane,
  readPaneAsync,
  closePane,
  interruptPane,
  shellQuote,
  waitForPaneAbsence,
} from "../../pi-extension/subagents/terminal.ts";

type MuxBackend = "herdr";

// Re-export mux primitives for tests
export {
  createSubagentPane,
  createSubagentWorktree,
  runInPane,
  runScriptInPane,
  readPane,
  readPaneAsync,
  closePane,
  interruptPane,
  shellQuote,
};
export type { MuxBackend };

// ── Paths ──

const HARNESS_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HARNESS_DIR, "../..");
const TEST_AGENTS_SRC = join(HARNESS_DIR, "agents");

/**
 * Absolute path to the extension source in the working tree.
 *
 * Integration tests must exercise the code on the current branch — NOT the
 * version installed as a pi-package under `~/.pi/agent/git/...` or the project
 * mirror under `.pi/git/...`, which stays pinned to the last released tag.
 *
 * We force-load this file via `pi -ne -e <path>` in startPi() below so local
 * edits are always the code under test, regardless of what pi-packages are
 * installed on the host.
 */
const EXTENSION_SOURCE = join(PROJECT_ROOT, "pi-extension", "subagents", "index.ts");

// ── Configuration ──

/** The required suite uses a local provider; live-provider coverage is opt-in. */
export const USE_TEST_PROVIDER = process.env.PI_TEST_LIVE !== "1";

/** Model used for integration tests. */
export const TEST_MODEL = USE_TEST_PROVIDER
  ? FIXTURE_MODEL
  : process.env.PI_TEST_MODEL ?? "openai-codex/gpt-5.6-luna";

/** Per-test timeout in ms. Override with PI_TEST_TIMEOUT env var. */
export const PI_TIMEOUT = Number(process.env.PI_TEST_TIMEOUT ?? "120000");

// ── Backend detection ──

/** Detect whether the required herdr backend is available. */
export function getAvailableBackends(): MuxBackend[] {
  return isTerminalAvailable() ? ["herdr"] : [];
}

export function setBackend(_backend: MuxBackend): undefined {
  return undefined;
}

export function restoreBackend(_prev: string | undefined): void {}

export function focusSurface(_backend: MuxBackend, surface: string): void {
  // Focus the tab containing the pane — herdr has no direct "focus pane X"
  // CLI, but focusing the tab brings it to the foreground.
  const info = execFileSync("herdr", ["pane", "get", surface], { encoding: "utf8" });
  const tabId = JSON.parse(info)?.result?.pane?.tab_id;
  if (tabId) execFileSync("herdr", ["tab", "focus", tabId], { encoding: "utf8" });
}

export function getFocusedSurface(_backend: MuxBackend): string | null {
  try {
    const info = execFileSync("herdr", ["pane", "current"], { encoding: "utf8" });
    return JSON.parse(info)?.result?.pane?.pane_id ?? null;
  } catch {
    return null;
  }
}

export function getSurfacePane(_backend: MuxBackend, surface: string): string | null {
  return surface;
}

export async function waitForFocusedSurface(
  backend: MuxBackend,
  surface: string,
  timeout: number = PI_TIMEOUT,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (getFocusedSurface(backend) === surface) return;
    await sleep(200);
  }

  throw new Error(
    `Timeout (${timeout}ms) waiting for focused ${backend} surface ${surface}; ` +
      `current focus is ${getFocusedSurface(backend) ?? "unknown"}`,
  );
}

// ── Test environment ──

export interface TestEnv {
  /** Temp directory serving as the test project root */
  dir: string;
  /** Active mux backend for this test run */
  backend: MuxBackend;
  /** Dedicated workspace owned by this test environment. */
  workspaceId: string;
  /** Parent workspace restored after cleanup. */
  previousWorkspaceId: string | undefined;
  /** Agent configuration restored after cleanup. */
  previousAgentDir: string | undefined;
  /** Surfaces created directly by the harness. */
  surfaces: string[];
  /** Temp files to clean up */
  tempFiles: string[];
}

function writeTestProviderConfig(agentDir: string): void {
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ defaultProjectTrust: "always" }, null, 2),
    "utf8",
  );
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "pi-integration": {
        baseUrl: TEST_PROVIDER_URL,
        api: "openai-completions",
        apiKey: "test",
        compat: {
          supportsDeveloperRole: false,
          supportsReasoningEffort: false,
          supportsUsageInStreaming: false,
        },
        models: ["test", "fallback-primary", "fallback-secondary", "fallback-fail"].map((id) => ({
          id,
          name: "Deterministic integration test model", 
          reasoning: true,
          input: ["text"],
          contextWindow: 128_000,
          maxTokens: 4_096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        })), 
      },
    },
  }, null, 2), "utf8");
}

function createTestWorkspace(cwd: string): string {

  const output = execFileSync(
    "herdr",
    ["workspace", "create", "--cwd", cwd, "--label", `pi-integ-${Date.now()}`, "--no-focus"],
    { encoding: "utf8" },
  );
  const parsed = JSON.parse(output) as { result?: { workspace?: { workspace_id?: unknown } } };
  const workspaceId = parsed.result?.workspace?.workspace_id;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw new Error(`Unexpected herdr workspace create output: ${output.trim() || "(empty)"}`);
  }
  return workspaceId;
}



/**
 * Create an isolated test environment with test agent definitions.
 * The temp dir has `.pi/agents/` containing copies of all test agents.
 */
export function createTestEnv(backend: MuxBackend): TestEnv {
  const dir = mkdtempSync(join(tmpdir(), "pi-integ-"));
  const agentsDir = join(dir, ".pi", "agents");
  const agentDir = join(dir, ".pi", "agent");
  const previousWorkspaceId = process.env.HERDR_WORKSPACE_ID;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  if (!previousWorkspaceId) throw new Error("HERDR_WORKSPACE_ID is required for integration tests");
  const workspaceId = createTestWorkspace(dir);
  // Herdr creates subagent tabs in the workspace identified by this env var.
  // Point the harness at its dedicated workspace without changing the parent's pane.
  process.env.HERDR_WORKSPACE_ID = workspaceId;
  mkdirSync(agentsDir, { recursive: true });
  if (USE_TEST_PROVIDER) {
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeTestProviderConfig(agentDir);
    // The outer test process force-loads this checkout with `-e`, but nested Pi
    // processes start normally. Auto-discover the same checkout in the isolated
    // agent directory so nested launches exercise the real extension as well.
    writeFileSync(
      join(agentDir, "extensions", "subagents-under-test.ts"),
      `import extension from ${JSON.stringify(EXTENSION_SOURCE)};\n` +
      `import { mkdirSync, writeFileSync } from "node:fs";\n` +
      `import { join } from "node:path";\n` +
      `export default function(pi) {\n` +
      `  if (!(process.env.PI_DENY_TOOLS || '').split(',').includes('subagent')) extension(pi);\n` +
      `  pi.on('session_start', (_event, ctx) => {\n` +
      `    const paneId = process.env.HERDR_PANE_ID;\n` +
      `    const agentDir = process.env.PI_CODING_AGENT_DIR;\n` +
      `    if (!paneId || !agentDir) return;\n` +
      `    const sessionManager = ctx.sessionManager;\n` +
      `    let sessionFile = sessionManager.getSessionFile();\n` +
      `    if (!sessionFile && process.env.PI_INTEG_PERSIST_REPLACEMENTS_PANE === paneId) {\n` +
      `      sessionFile = join(agentDir, 'replacement-sessions', sessionManager.getSessionId() + '.jsonl');\n` +
      `      mkdirSync(join(agentDir, 'replacement-sessions'), { recursive: true });\n` +
      `      sessionManager.setSessionFile(sessionFile);\n` +
      `    }\n` +
      `    if (!sessionFile) return;\n` +
      `    const mapDir = join(agentDir, 'pane-session-map');\n` +
      `    mkdirSync(mapDir, { recursive: true });\n` +
      `    writeFileSync(join(mapDir, encodeURIComponent(paneId) + '.json'), JSON.stringify({ sessionId: sessionManager.getSessionId(), sessionFile }), 'utf8');\n` +
      `  });\n` +
      `}\n`,
      "utf8",
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;
  }

  // Copy test agent definitions into the project-local agents dir and pin
  // every child subagent to the same model selected for the outer Pi sessions.
  // Without this rewrite, fixture frontmatter can silently bypass PI_TEST_MODEL.
  if (existsSync(TEST_AGENTS_SRC)) {
    for (const file of readdirSync(TEST_AGENTS_SRC)) {
      if (file.endsWith(".md")) {
        const source = readFileSync(join(TEST_AGENTS_SRC, file), "utf8");
        const configured = /^model:\s*.*$/m.test(source)
          ? source.replace(/^model:\s*.*$/m, `model: ${TEST_MODEL}`)
          : source.replace(/^---\n/, `---\nmodel: ${TEST_MODEL}\n`);
        writeFileSync(join(agentsDir, file), configured, "utf8");
      }
    }
  }

  return {
    dir,
    backend,
    workspaceId,
    previousWorkspaceId,
    previousAgentDir,
    surfaces: [],
    tempFiles: [],
  };
}

/**
 * Clean up all resources created during the test.
 */
const CLEANUP_TIMEOUT = Number(process.env.PI_TEST_CLEANUP_TIMEOUT ?? "15000");

interface WorkspacePane {
  pane_id?: unknown;
}

function workspacePaneIds(workspaceId: string): string[] | null {
  try {
    const output = execFileSync("herdr", ["pane", "list", "--workspace", workspaceId], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const panes = JSON.parse(output)?.result?.panes;
    if (!Array.isArray(panes)) return null;
    return panes.flatMap((pane: WorkspacePane) =>
      typeof pane.pane_id === "string" ? [pane.pane_id] : [],
    );
  } catch {
    // Unknown is handled fail-closed by the final audit below, which refuses
    // to delete a possibly live cwd.
    return null;
  }
}

function workspaceExists(workspaceId: string): boolean {
  try {
    const output = execFileSync("herdr", ["workspace", "list"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const workspaces = JSON.parse(output)?.result?.workspaces;
    if (!Array.isArray(workspaces)) return true;
    return workspaces.some(
      (workspace: { workspace_id?: unknown }) => workspace.workspace_id === workspaceId,
    );
  } catch {
    return true;
  }
}

function processesUsingPath(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync("/proc");
  } catch {
    return ["/proc unavailable"];
  }
  const prefix = `${root}/`;
  return entries.flatMap((entry) => {
    if (!/^\d+$/.test(entry)) return [];
    try {
      const cwd = readlinkSync(`/proc/${entry}/cwd`);
      return cwd === root || cwd === `${root} (deleted)` || cwd.startsWith(prefix)
        ? [entry]
        : [];
    } catch {
      return [];
    }
  });
}

async function waitForProcessCwdRelease(root: string): Promise<void> {
  const deadline = Date.now() + CLEANUP_TIMEOUT;
  let processes = processesUsingPath(root);
  while (processes.length > 0 && Date.now() < deadline) {
    await sleep(100);
    processes = processesUsingPath(root);
  }
  if (processes.length > 0) {
    throw new Error(
      `Timed out waiting for integration processes to leave ${root}; ` +
        `remaining pids=${JSON.stringify(processes)}`,
    );
  }
}


async function waitForWorkspaceTeardown(workspaceId: string): Promise<void> {

  const deadline = Date.now() + CLEANUP_TIMEOUT;
  let lastPanes: string[] | null = [];
  while (Date.now() < deadline) {
    lastPanes = workspacePaneIds(workspaceId);
    if (!workspaceExists(workspaceId)) return;
    for (const pane of lastPanes ?? []) {
      try {
        closePane(pane);
      } catch {}
    }
    try {
      execFileSync("herdr", ["workspace", "close", workspaceId], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {}
    await sleep(100);
  }

  lastPanes = workspacePaneIds(workspaceId);
  if (lastPanes === null || lastPanes.length > 0 || workspaceExists(workspaceId)) {
    throw new Error(
      `Timed out cleaning integration workspace ${workspaceId}; ` +
        `remaining panes=${JSON.stringify(lastPanes)}`,
    );
  }
}

/**
 * Clean up all resources created during the test.
 *
 * Herdr closes panes asynchronously. Keep the test cwd until every pane in
 * the owned workspace is gone; otherwise a still-running shell retains a
 * deleted cwd and the workspace can survive the test's audit.
 */
/** Wait until a test-owned filesystem path is absent. */
export async function waitForPathAbsence(path: string): Promise<void> {
  const deadline = Date.now() + CLEANUP_TIMEOUT;
  while (existsSync(path) && Date.now() < deadline) await sleep(100);
  if (existsSync(path)) throw new Error(`Timed out waiting for test path removal: ${path}`);
}

export async function cleanupTestEnv(env: TestEnv): Promise<void> {

  let cleanupError: unknown;
  try {
    for (const surface of env.surfaces) {
      try {
        closePane(surface);
      } catch {}
      try {
        await waitForPaneAbsence(surface, { timeoutMs: CLEANUP_TIMEOUT, intervalMs: 50 });
      } catch {}
    }
    await waitForWorkspaceTeardown(env.workspaceId);
    await waitForProcessCwdRelease(env.dir);
  } catch (error) {
    cleanupError = error;
  } finally {
    if (env.previousWorkspaceId) {
      process.env.HERDR_WORKSPACE_ID = env.previousWorkspaceId;
    } else {
      delete process.env.HERDR_WORKSPACE_ID;
    }
    if (env.previousAgentDir) {
      process.env.PI_CODING_AGENT_DIR = env.previousAgentDir;
    } else {
      delete process.env.PI_CODING_AGENT_DIR;
    }
  }

  if (cleanupError) throw cleanupError;

  for (const file of env.tempFiles) {
    try {
      unlinkSync(file);
    } catch {}
  }
  rmSync(env.dir, { recursive: true, force: true });
}

/**
 * Create a surface and register it for automatic cleanup.
 */
export function createTrackedSurface(env: TestEnv, name: string): string {
  const surface = createSubagentPane(name);
  env.surfaces.push(surface);
  return surface;
}

/** Wait until a newly created pane accepts and displays a shell command. */
export async function waitForPaneReady(surface: string, timeout: number = PI_TIMEOUT): Promise<void> {
  const marker = `__PI_INTEG_READY_${uniqueId()}__`;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    try {
      runInPane(surface, `printf '${marker}\\n'`);
      if ((await readPaneAsync(surface, 50)).includes(marker)) return;
    } catch {}
    await sleep(200);
  }
  throw new Error(`Timeout (${timeout}ms) waiting for shell in pane ${surface}`);
}

/**
 * Remove a surface from tracking (after manual close).
 */
export function untrackSurface(env: TestEnv, surface: string): void {
  env.surfaces = env.surfaces.filter((s) => s !== surface);
}

// ── Pi session management ──

/**
 * Start a pi session in a herdr pane with the subagents extension loaded.
 * Returns immediately — the pi process runs asynchronously in the surface.
 *
 * The command ends with a sentinel so we can detect when pi exits:
 *   `pi ...; echo '__TEST_DONE_'$?'__'`
 */
export function startPi(
  surface: string,
  testDir: string,
  task: string,
  opts?: {
    model?: string;
    extraArgs?: string;
    environment?: Record<string, string>;
  },
): void {
  const model = opts?.model ?? TEST_MODEL;
  const extra = opts?.extraArgs ?? "";
  const agentDir = USE_TEST_PROVIDER ? join(testDir, ".pi", "agent") : "";
  const extensionSource = USE_TEST_PROVIDER
    ? join(agentDir, "extensions", "subagents-under-test.ts")
    : EXTENSION_SOURCE;

  // Force pi to load the working-tree extension (not an installed pi-package
  // snapshot). `-ne` disables extension auto-discovery, `-e <path>` loads the
  // current branch's source directly. Without this, the tests silently run
  // against whatever version is checked out under `~/.pi/agent/git/...`.
  const cmd = [
    `cd ${shellQuote(testDir)} &&`,
    agentDir ? `PI_CODING_AGENT_DIR=${shellQuote(agentDir)}` : "",
    ...Object.entries(opts?.environment ?? {}).map(
      ([key, value]) => `${key}=${shellQuote(value)}`,
    ),
    `pi`,
    `-ne`,
    `-e ${shellQuote(extensionSource)}`,
    `--model ${shellQuote(model)}`,
    extra,
    shellQuote(task),
  ]
    .filter(Boolean)
    .join(" ");

  runScriptInPane(surface, `${cmd}; echo '__TEST_DONE_'$?'__'`, {
    scriptPath: join(testDir, `test-launch-${Date.now()}.sh`),
  });
}

// ── Polling helpers ──

/**
 * Poll until a regex pattern appears in the surface's screen output.
 * Throws on timeout with the last screen contents for debugging.
 */
export async function waitForScreen(
  surface: string,
  pattern: RegExp,
  timeout: number = PI_TIMEOUT,
  lines: number = 200,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const screen = await readPaneAsync(surface, lines);
      if (pattern.test(screen)) return screen;
    } catch {}
    await sleep(2000);
  }

  let finalScreen = "";
  try {
    finalScreen = readPane(surface, lines);
  } catch {}
  throw new Error(
    `Timeout (${timeout}ms) waiting for pattern ${pattern}.\nLast screen:\n${finalScreen.slice(-1000)}`,
  );
}

/**
 * Poll until a file exists and optionally matches a content pattern.
 * Returns the file content on success.
 */
export async function waitForFile(
  path: string,
  timeout: number = PI_TIMEOUT,
  contentPattern?: RegExp,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (existsSync(path)) {
      const content = readFileSync(path, "utf8");
      if (!contentPattern || contentPattern.test(content)) return content;
    }
    await sleep(2000);
  }
  throw new Error(
    `Timeout (${timeout}ms) waiting for file: ${path}` +
      (contentPattern ? ` matching ${contentPattern}` : ""),
  );
}

/**
 * Wait for the pi process in a surface to exit (sentinel detection).
 * Returns the exit code.
 */
export async function waitForPiExit(
  surface: string,
  timeout: number = PI_TIMEOUT,
): Promise<number> {
  const screen = await waitForScreen(surface, /__TEST_DONE_(\d+)__/, timeout);
  const match = screen.match(/__TEST_DONE_(\d+)__/);
  return match ? parseInt(match[1], 10) : -1;
}

// ── Utilities ──

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function uniqueId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * Register a temp file for cleanup.
 */
export function trackTempFile(env: TestEnv, path: string): void {
  env.tempFiles.push(path);
}
