/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+J)
 * - Provides a `subagent_done` tool for interactive agents to self-terminate
 */
import {
  stripFrontmatter,
  type ExtensionAPI,
  type BeforeAgentStartEvent,
  type BeforeAgentStartEventResult,
} from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { Type } from "@sinclair/typebox";
import { readFileSync, writeFileSync } from "node:fs";
import { createSubagentActivityRecorder } from "./activity.ts";
import {
  classifySettledOutcome,
  type AssistantStopReason,
  type NewestAssistantEntry,
  type SettledOutcomeKind,
} from "./settled-contract.ts";
import {
  hasUndrainedDescendants,
  lineageFromEnvironment,
  reduceLineage,
} from "./lineage.ts";
export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}


/** Wait until this session's owned descendants have terminal delivery. */
async function waitForDescendantDrain(): Promise<void> {
  const lineage = lineageFromEnvironment();
  if (!lineage) return;
  while (hasUndrainedDescendants(reduceLineage(lineage.rootDir), lineage.parentNodeId)) {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}
function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type?: string; text?: string } =>
        part != null && typeof part === "object",
    )
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("");
}

/** Convert the latest assistant message into the frozen settled contract. */
export function newestAssistantEntry(
  messages: any[] | undefined,
): NewestAssistantEntry | null {
  if (!messages || messages.length === 0) return null;
  const latest = messages[messages.length - 1];
  if (latest?.role === "user") return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    const text =
      typeof msg.text === "string" ? msg.text : textFromContent(msg.content);
    const contentLength = text.length;
    return {
      id: typeof msg.id === "string" && msg.id ? msg.id : `assistant-${i}`,
      text: text || null,
      contentLength,
      stopReason:
        typeof msg.stopReason === "string"
          ? (msg.stopReason as AssistantStopReason)
          : undefined,
      errorMessage:
        typeof msg.errorMessage === "string" ? msg.errorMessage : undefined,
      empty: contentLength === 0,
    };
  }
  return null;
}

/** Decide whether a settled response is allowed to close an auto-exit child. */
export function classifyAutoExitOutcome(
  messages: any[] | undefined,
  interruptRequested = false,
): SettledOutcomeKind | null {
  const assistant = newestAssistantEntry(messages);
  if (!assistant) return null;
  return classifySettledOutcome({ assistant, interruptRequested });
}

/**
 * Compatibility predicate retained for callers that only have an agent_end
 * snapshot. The decision is now intentionally made at agent_settled.
 */
export function shouldAutoExitOnAgentEnd(
  _userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  const outcome = classifyAutoExitOutcome(messages);
  return outcome === "clean" || outcome === "empty";
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error";
}

/**
 * If the last assistant message in the turn ended with `stopReason: "error"`
 * (typically auto-retry exhausted on an overload / rate limit / server error),
 * return its error info so the parent orchestrator can surface a clear
 * failure instead of silently treating the run as completed.
 *
 * Returns `null` when the latest assistant turn completed normally or was
 * aborted by the user (handled separately by shouldAutoExitOnAgentEnd).
 */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason !== "error") return null;
    const raw =
      typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage:
        raw ||
        "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

export function buildCompletionSidecar(
  messages: any[] | undefined,
):
  | { type: "done" }
  | { type: "error"; errorMessage: string; stopReason: "error" } {
  const errorInfo = findLatestAssistantError(messages);
  return errorInfo ? { type: "error", ...errorInfo } : { type: "done" };
}

export function parseDeniedTools(rawValue: string | undefined): string[] {
  return (rawValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

/** Build one hidden, session-persistent initialization message for requested skills. */
export function buildSkillInitialization(
  event: BeforeAgentStartEvent,
  requestedSkills: string,
  notify: (message: string, type?: "info" | "warning" | "error") => void,
): BeforeAgentStartEventResult | undefined {
  const names = [...new Set(
    requestedSkills
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  )];
  if (names.length === 0) return undefined;

  const catalog = event.systemPromptOptions.skills ?? [];
  const blocks: string[] = [];
  for (const name of names) {
    const skill = catalog.find((candidate) => candidate.name === name);
    if (!skill) {
      notify(`Unable to load requested skill "${name}": not found in Pi's resolved skill catalog.`, "warning");
      continue;
    }
    try {
      const body = stripFrontmatter(readFileSync(skill.filePath, "utf8")).trim();
      blocks.push(
        `<skill name="${skill.name}" location="${skill.filePath}">\n` +
          `References are relative to ${skill.baseDir}.\n\n${body}\n</skill>`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      notify(`Unable to load requested skill "${name}": ${reason}`, "warning");
    }
  }

  if (blocks.length === 0) return undefined;
  return {
    message: {
      customType: "subagent_skill_initialization",
      content: [{ type: "text", text: blocks.join("\n\n") }],
      display: false,
    },
  };
}

export default function (pi: ExtensionAPI) {
  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const deniedToolsValue = process.env.PI_DENY_TOOLS;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
    settledEventsFile: process.env.PI_SUBAGENT_SETTLED_EVENTS_FILE,
  });

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) =>
          theme.bg("toolSuccessBg", text),
        );

        const label = subagentAgent || subagentName;
        const agentTag = label
          ? theme.bold(theme.fg("accent", `[${label}]`))
          : "";

        if (expanded) {
          // Expanded: full tool list + denied
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+J to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "denied: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") +
                theme.fg("error", `${denied.length} denied`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+J to expand)");

          const content = new Text(
            `${agentTag}${countInfo}${deniedInfo}${hint}`,
            0,
            0,
          );
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let latestAgentEndMessages: any[] | undefined;
  let latestTurnIndex: number | undefined;
	let skillInitializationComplete = false;
  // Resumed sessions replay the previous turn during startup. Do not publish
  // that historical settlement as the new resume completion.
  let resumeTurnStarted = process.env.PI_SUBAGENT_RESUME !== "1";
  let resumeInputSeen = process.env.PI_SUBAGENT_RESUME !== "1";
  const resumeBaselineAssistantIds = new Set<string>(
    (() => {
      if (process.env.PI_SUBAGENT_RESUME !== "1") return [];
      try {
        const value: unknown = JSON.parse(process.env.PI_SUBAGENT_RESUME_BASELINE_ASSISTANTS ?? "[]");
        return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
      } catch { return []; }
    })(),
  );
  // Parent-side interrupt bookkeeping is intentionally separate. Until the
  // parent wires an explicit interrupt request, an abort remains open and is
  // classified as an unexpected abort for delivery purposes.
  let interruptRequested = false;
  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    recorder.sessionStart();
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = parseDeniedTools(deniedToolsValue);

    renderWidget(ctx, null);
  });

  pi.on("input", () => {
    resumeInputSeen = true;
    recorder.input();
  });

  pi.on("before_agent_start", (event, ctx) => {
    // Each run needs fresh agent_end evidence; never reuse a prior clean turn.
    latestAgentEndMessages = undefined;
    latestTurnIndex = undefined;
    resumeTurnStarted = true;
    recorder.beforeAgentStart();

    if (skillInitializationComplete) return;
    skillInitializationComplete = true;
    const requestedSkills = process.env.PI_SUBAGENT_SKILLS;
    if (requestedSkills === undefined) return;
    return buildSkillInitialization(event, requestedSkills, (message, type) =>
      ctx.ui.notify(message, type),
    );
  });

  pi.on("agent_start", () => {
    recorder.agentStart();
  });

  pi.on("agent_end", (event) => {
    latestAgentEndMessages = (event as any).messages as any[] | undefined;
    const eventTurnIndex = (event as any).turnIndex;
    if (typeof eventTurnIndex === "number") latestTurnIndex = eventTurnIndex;
    recorder.agentEndWaiting();
  });

  let exitRequested = false;
  const finishAfterDrain = async (
    ctx: { shutdown: () => void },
    payload: Record<string, unknown>,
  ): Promise<void> => {
    if (exitRequested) return;
    exitRequested = true;
    const lineage = lineageFromEnvironment();
    const shouldWaitForDescendants = lineage
      ? hasUndrainedDescendants(reduceLineage(lineage.rootDir), lineage.parentNodeId)
      : false;
    if (shouldWaitForDescendants) await waitForDescendantDrain();
    const sessionFile = process.env.PI_SUBAGENT_SESSION;
    if (sessionFile) {
      try {
        // Publish completion only after descendants drain so the parent can
        // observe this owner's settled turns before its terminal result.
        writeFileSync(`${sessionFile}.exit`, JSON.stringify(payload));
      } catch {
        // Best effort — the wrapper sentinel remains available after shutdown.
      }
    }
    ctx.shutdown();
  };

  pi.on("agent_settled", (_event, ctx) => {
    const outcome = classifyAutoExitOutcome(
      latestAgentEndMessages,
      interruptRequested,
    );
    const assistant = newestAssistantEntry(latestAgentEndMessages);
    if (!outcome || !assistant) return;
    if (resumeBaselineAssistantIds.has(assistant.id)) {
      // Pi replays the previous assistant turn while opening a resumed session.
      // Its settlement is not the follow-up requested by the parent.
      return;
    }
    if (!resumeTurnStarted || (process.env.PI_SUBAGENT_RESUME === "1" && !resumeInputSeen)) return;

    recorder.agentSettled({
      outcome,
      assistantId: assistant.id,
      stopReason: assistant.stopReason,
      errorMessage: assistant.errorMessage,
      empty: assistant.empty,
      turnIndex: latestTurnIndex,
      autoExit,
    });

    if (!autoExit || (outcome !== "clean" && outcome !== "empty")) return;
    void finishAfterDrain(ctx, { type: "done" });
  });

  pi.on("turn_start", (event) => {
    latestTurnIndex = (event as any).turnIndex;
    recorder.turnStart(latestTurnIndex);
  });

  pi.on("turn_end", (event) => {
    recorder.turnEnd((event as any).turnIndex);
  });

  pi.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  pi.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart(
      (event as any).toolCallId,
      (event as any).toolName,
    );
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate(
      (event as any).toolCallId,
      (event as any).toolName,
    );
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd(
      (event as any).toolCallId,
      (event as any).toolName,
    );
  });

  pi.on("session_shutdown", (event) => {
    recorder.sessionShutdown((event as any).reason);
  });

  // Toggle expand/collapse with Ctrl+J
  pi.registerShortcut("ctrl+j", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Record a help request for the parent agent. " +
      "The parent will be notified with your message, and delivery and session exit wait until recursively owned descendants drain. " +
      "Use when you're stuck, need clarification, or need the parent to take action.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "caller_ping is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      recorder.callerPing();
      const exitData = {
        type: "ping" as const,
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        message: params.message,
      };
      await finishAfterDrain(ctx, exitData);
      return {
        content: [
          {
            type: "text",
            text: "Ping sent. Session will exit and parent will be notified.",
          },
        ],
        details: {},
      };
    },
  });

  if (autoExit) return;

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Record interactive completion intent. " +
      "Return results and close this session after recursively owned descendants drain. " +
      "Your LAST assistant message before calling this becomes the summary returned to the caller.",
    parameters: Type.Object({ summary: Type.Optional(Type.String({ description: "Optional final summary" })) }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      recorder.subagentDone();
      const payload = {
        type: "done" as const,
        ...(typeof params.summary === "string" && params.summary.trim()
          ? { summary: params.summary }
          : {}),
      };
      const lineage = lineageFromEnvironment();
      const pendingDescendants = lineage
        ? hasUndrainedDescendants(reduceLineage(lineage.rootDir), lineage.parentNodeId)
        : false;
      if (!pendingDescendants) {
        const sessionFile = process.env.PI_SUBAGENT_SESSION;
        if (sessionFile) {
          try { writeFileSync(`${sessionFile}.exit`, JSON.stringify(payload)); } catch {}
        }
        ctx.shutdown();
      } else {
        await finishAfterDrain(ctx, payload);
      }
      return {
        content: [{ type: "text", text: "Shutting down subagent session." }],
        details: {},
      };
    },
  });
}
