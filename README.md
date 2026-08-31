# Pi LPT Herdr Subagents

![Pi LPT Herdr Subagents: parallel Pi agents running asynchronously in dedicated Herdr panes and managed worktrees.](https://raw.githubusercontent.com/alexshpunt/pi-lpt-herdr-subagents/main/docs/assets/pi-herdr-agents-gallery.png)

LPT-owned asynchronous subagents and approved review workflows for [Pi](https://github.com/earendil-works/pi), running exclusively in [Herdr](https://herdr.dev).

Delegate investigation, implementation, and review without blocking the parent session. Each child runs as a real Pi process in its own Herdr surface; results return automatically when the child finishes.


This is the LPT fork of [`pi-herdr-agents`](https://github.com/giuseppecrj/pi-herdr-agents). The `upstream` Git remote tracks that project. LPT currently uses this fork as a reliable foundation for Herdr lifecycle, result delivery, and control work. Compatibility with upstream is intentionally not guaranteed.

## Features

- **Non-blocking delegation** — `subagent` acknowledges launch immediately while the parent keeps working.
- **Parallel execution** — run independent scouts, workers, and reviewers at the same time.
- **Live supervision** — track process and turn state in Pi's subagent widget; interrupt one child turn without destroying its session.
- **Managed worktrees** — isolate writing agents in retained Herdr workspaces with explicit Git ownership and recovery details.
- **Conversation handoff** — continue the active Pi conversation in a new worktree with `/worktree` while preserving the parent session.
- **Approved review workflows** — prepare and run bounded, read-only multi-agent reviews with fresh evidence and one synthesized result.
- **Reusable roles** — use bundled agents, project or global definitions, and installable role packs.
- **Descendant-safe delivery** — launches record durable lineage before resource creation; settled and terminal results wait for recursive descendants and deliver once to the exact parent.
- **Verified cancellation** — `subagent_cancel` is separate from non-terminal `subagent_interrupt` and only reports cancellation after pane and process termination are proven.

## Requirements

- [Pi](https://github.com/earendil-works/pi) with package support
- [Herdr](https://herdr.dev) and its CLI
- `HERDR_ENV=1` — start Pi from inside Herdr

Other terminal multiplexers are not supported. Worktrees isolate Git checkouts, not processes or permissions; child agents and installed Pi packages run with your user account's access.

## Install

Install from npm:

```bash
pi install npm:pi-lpt-herdr-subagents
```

Install project-locally or try it for one run:

```bash
pi install -l npm:pi-lpt-herdr-subagents
pi -e npm:pi-lpt-herdr-subagents
```

Then start Pi inside Herdr:

```bash
herdr
pi
```

Restart or `/reload` Pi after installation. Review package source before installing any Pi package.

## Quick start

Ask Pi to delegate naturally:

```text
Use two scouts in parallel to map the authentication flow, then summarize their findings.
```

Or launch a named role directly:

```text
/subagent scout Analyze the authentication module and report relevant files and risks
```

For an isolated writing task:

```text
/worktree auth-fix Implement the approved authentication fix and run the focused tests
```

Pi can also call the tool directly:

```typescript
subagent({ name: "Auth scout", agent: "scout", task: "Map the authentication flow" });
subagent({ name: "DB scout", agent: "scout", task: "Map the session schema" });
// Both return immediately; each result comes back independently.
```

Use ordinary panes for read-only agents. Give each independent writing agent a unique managed worktree; see [Worktree subagents](docs/worktree-subagents.md).

### Public subagent tree API

Installed Pi extensions can use the side-effect-free package root without loading the model-facing subagent tools:

```ts
import { createSubagentTree } from "@alexshp/pi-lpt-herdr-subagents";

const tree = createSubagentTree({ pi, ctx, metadata: { requestId: "search-1" } });
const child = await tree.launchChild({
  parentId: tree.callerId,
  name: "search-router",
  task: "Find the requested records and return a concise answer.",
  agent: "scout",
  tools: ["read"],
});
const answer = await child.result;
const final = await tree.result;
```

The package root exports `createSubagentTree`, `attachSubagentTree`, the handle and result types, `ForkLineage`, and the three tree error classes. Importing it does not register `subagent` or any other package tool.

A child process claims its one-time context with `attachSubagentTree({ pi, ctx })`. A caller reattaches with its caller ID, tree ID, and ownership token on every fresh `session_start`. `/reload`, `/new`, and `/resume` use the fresh context directly. `/fork` also passes `forkLineage: { previousSessionFile }`; the package checks the new session header's `parentSession` before replacing the stored binding.

The attached handle reconstructs pending direct children. Callback bindings are versioned, and a successful final callback is delivered once. The tree result settles only after every reserved descendant settles. Cancellation is fail-closed and retains recovery evidence when Herdr cannot confirm process and pane termination.

## How it works

![Pi LPT Herdr Subagents lifecycle: spawn a child, run it in Herdr, supervise live state, and deliver one bounded result to the parent.](https://raw.githubusercontent.com/alexshpunt/pi-lpt-herdr-subagents/main/docs/assets/async-subagent-lifecycle.png)

A `subagent` call creates a dedicated Herdr pane or worktree, launches a child Pi session, and returns `started`. The parent watcher combines Herdr process state with child activity details and projects the result into a live widget:

```text
╭─ Subagents ──────────────────── 1 active · 1 open ─╮
│ 00:23  Scout: Auth (scout)        active · read 7m │
│ 00:45  Reviewer (reviewer)              waiting 2m │
╰────────────────────────────────────────────────────╯
```

When the child completes, the parent receives one bounded `subagent_result` message and starts a new turn with that result in context. Callers never need to poll, tail session files, or wait in a shell loop.

## Troubleshooting completion delivery

If a child finishes but the parent returns an empty or unrelated response, first verify that the result reached the parent session:

```bash
jq -c 'select(.type == "custom_message" and .customType == "subagent_result")' "$PI_SESSION_FILE" | tail -1
```

If the entry exists, spawning and result extraction worked; investigate parent wake-up and model-facing delivery rather than the child process. Completion wake-ups must contain the bounded result directly—do not send a separate message that merely tells the parent to look at an adjacent custom message.

Git package refs are pinned. To move an installed development copy back to the current `main`, install that ref explicitly and reload the active Pi session:

```bash
pi install git:github.com/alexshpunt/pi-lpt-herdr-subagents@main
# Then run /reload inside Pi.
```

Smoke-test delivery with an autonomous subagent instructed to return one exact marker. Success means the marker itself—not only a generic wake-up notice—automatically appears in the parent turn.

Subagent tabs, panes, and worktree workspaces are created without stealing keyboard focus. Launch commands target child panes by explicit ID, so focus and command delivery are independent. Note: the `interactive` option controls parent status notifications, not terminal focus.

## What's Included

### Extensions

**Subagents** — 6 main-session tools + 6 commands, plus 2 child-only tools:

| Tool                 | Description                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `subagent`           | Spawn a sub-agent in a dedicated herdr pane (async — returns immediately)             |
| `subagent_interrupt` | Interrupt a running Pi-backed subagent's current turn                                       |
| `subagent_cancel`    | Cancel one child only after pane absence and process exit are verified; uncertain termination stays pending |
| `subagents_list`     | List available agent definitions                                                            |
| `subagent_resume`    | Resume a previous Pi-backed sub-agent session in a new ordinary pane (async)                          |
| `herdr_workflow`     | Prepare, start, or cancel one exact approved project-local review workflow                   |

| Pi child-only tool | Description |
| ---------------- | ------------------------------------------------------------------------- |
| `caller_ping` | Record a help request; notify the parent and exit after recursively owned descendants drain |
| `subagent_done` | Record interactive completion intent; return results and exit after recursively owned descendants drain |

| Command                    | Description                          |
| -------------------------- | ------------------------------------ |
| `/plan`                    | Start a full planning workflow       |
| `/iterate`                 | Fork into a subagent for quick fixes |
| `/btw <question>`          | Open an ephemeral side-question session in a background tab |
| `/btw-close`               | Close the current BTW session        |
| `/worktree <name> [task]`  | Continue this session in a new managed worktree (`/worktree list` lists them) |
| `/subagent <agent> <task>` | Spawn a named agent directly (`/subagent list` lists available agents) |

### Taxonomy and discovery

This package uses five distinct concepts:

- An **agent role** is a directly runnable responsibility such as scouting,
  implementation, or review.
- A **workflow** is a user-facing recipe that composes roles, ordering,
  artifacts, and runtime policy.
- A **skill** is a Pi-native procedure loaded into the current agent. Skills are
  dependencies of roles or workflows, not subagent definitions.
- A **runtime** is the authenticated Pi provider/model and thinking policy used
  for one invocation.

See [ADR-0002](docs/adr/0002-agent-workflow-skill-runtime-taxonomy.md) for the
accepted decision, rationale, migration boundaries, and evidence.

The current workflow inventory is:

| Workflow | Entry point | Composition, artifacts, and runtime |
| -------- | ----------- | ----------------------------------- |
| Planning | `/plan` | Scout → interactive planner → workers → reviewer; writes `.pi/plans/...` artifacts; runs on Pi. |
| Iteration | `/iterate` | Opens one interactive full-context Pi fork and returns its completion summary. |
| Side question | `/btw`, `/btw-close` | Opens one replaceable interactive Pi side session; its answer stays outside the parent transcript. |
| Worktree handoff | `/worktree <name> [task]`, `/worktree list` | Forks the active conversation into a long-lived interactive Pi process in a new worktree created from committed `HEAD`; retains the parent session. |
| Approved review runner | `herdr_workflow` (low-level control tool) | Validates and runs exact approved project-local JavaScript with bounded read-only Pi reviewers. The bundled `orchestrate` skill authors this first-flow topology. |
| Adversarial review | `adversarial-reviewer` | Transitional workflow implementation that selects eligible authenticated Pi runtimes for generic reviewer passes, verifies findings, and uses a fresh reviewer synthesis pass. It does not write artifacts in the reviewed checkout. |

### Bundled visible definitions

| Definition | Classification | Default runtime | Responsibility |
| ---------- | -------------- | --------------- | -------------- |
| **planner** | Coordinator agent role | Config, then parent | Clarifies requirements, explores approaches, and writes plans with ordered tasks. |
| **scout** | Leaf agent role | Config, then parent | Maps relevant code, conventions, and verification paths. |
| **worker** | Leaf agent role | Config, then parent | Implements bounded tasks and verifies the result. |
| **reviewer** | Leaf agent role | Config, then parent | Reviews changes for correctness, security, and maintainability. |
| **visual-tester** | Leaf agent role | Config, then parent | Performs visual QA through the `chrome-cdp` skill. |
| **poteto** | Coordinator agent role | Config, then parent | Autonomously investigates, edits minimally, delegates independent work, and verifies. |
| **adversarial-reviewer** | Transitional workflow implementation | Three distinct eligible authenticated Pi model IDs, preferring provider diversity | Runs evidence-backed Optimizer and Skeptic passes through generic `reviewer` children, then a fresh reviewer synthesis pass. |

All subagents execute through Pi. Claude models remain available through normal
Pi provider/model routing. Legacy role definitions that contain `cli` fail before
Herdr creates a pane or worktree; remove `cli` and `cli-model`, then select an
authenticated Pi `provider/model-id`.

Optional prerequisites fail closed and are not bundled:

- `visual-tester` needs an external `chrome-cdp` skill that provides `scripts/cdp.mjs`.
- `adversarial-reviewer` needs three distinct exact authenticated Pi model IDs that meet project review constraints; it prefers IDs from different providers when available.
- `/plan` uses the bundled scout and planner roles and records ordered tasks in
  `plan.md`; it does not require a researcher role, todo tool, or `write-todos` skill.

This package does not install optional prerequisites.

Bundled agents use model defaults from `config.json` when configured; otherwise
they inherit the parent model. Thinking defaults still come from agent
frontmatter or the parent level. The orchestrating agent can override either
field for a specific task using an exact authenticated model ID and a supported
Pi thinking level. Prefer changing thinking before changing models.

Discovery loads definitions in **package → global → project** order, so effective
priority remains **project** (`.pi/agents/`) > **global**
(`$PI_CODING_AGENT_DIR/agents/`, defaulting to `~/.pi/agent/agents/`) >
**package**. Package definitions include bundled roles and roles contributed by
installed Pi role packs. Both `subagents_list` and `/subagent list` show each
visible definition's source; contributed roles include their package identity,
for example `(package:@acme/security-roles)`. A hidden higher-priority definition
still suppresses a visible lower-priority definition.

Custom roles and installable role packs are the package's main extension points.
See [Custom Agents](#custom-agents) for the complete create, package, verify, and
launch workflow.

---

## Async Subagent Flow

```
1. Agent calls subagent()          → returns immediately ("started")
2. Sub-agent runs in herdr pane    → widget shows live status
3. User keeps chatting             → main session fully interactive
4. Sub-agent finishes              → result steered back as a normal completion/failure
5. Main agent processes result     → continues with new context
```

Multiple subagents run concurrently. Each settled or terminal result waits until every recursively owned descendant has drained, then returns once to the exact parent. Held settled results keep their original order. A failed inbox publication remains pending without timeout or rerouting. Pending results remain bound to their recorded parent session ID and session file, and materialize when that exact session is restored. Quitting Pi stops the current watchers but keeps durable ownership for startup recovery. The live widget above the input tracks every agent still in flight:

```
╭─ Subagents ──────────────────── 1 active · 2 open ─╮
│ 01:23  Scout: Auth (scout)             active · read 7m │
│ 00:45  Reviewer (reviewer)                   stalled 4m │
│ 00:12  Scout: DB (scout)                      starting… │
╰─────────────────────────────────────────────────────────╯
```

Completion messages render with a colored background and are expandable with `Ctrl+O`. Results larger than 16,000 characters are abbreviated in the parent context while preserving their beginning, conclusion, and session path; the complete result remains in the child session. The extension includes that bounded result and a continuation instruction directly in the single custom `subagent_result` message that triggers or steers Pi, avoiding empty turns caused by a separate context-free wake-up. The renderer uses the unadorned bounded result from structured details. Completed rows are removed from the widget as soon as their result is delivered or suppressed. If ordinary-pane cleanup fails, the delivered child remains visible as `cleanup pending` until pane absence is confirmed.

### Settled turns and child lifecycle

A persistent child can return one parent result at every settled turn without closing its session. The five outcomes are:

- clean: record the settled result and, for an `auto-exit` child, terminal intent at that boundary; delivery and closure wait until recursively owned descendants drain;
- empty: record the explicit empty result and, for an `auto-exit` child, terminal intent at that boundary; delivery and closure wait until recursively owned descendants drain;
- provider/agent error: deliver the error and keep the child open;
- intentional interrupt: stay silent and keep the child open;
- unexpected abort: deliver an abort notice and keep the child open.

A non-auto-exit child records completion intent with `subagent_done`; `caller_ping` records help intent. An auto-exit child records terminal intent at a clean or empty settled boundary. Done, help, and auto-exit delivery and closure wait until recursively owned descendants drain; until then, the child stays owned. Any user input permanently disables auto-exit for that session. Provider errors and aborts remain open. Interrupt and stall are non-terminal and continue to block ancestor drain. Confirmed manual pane closure is terminal: the surviving ancestor adopts and destroys every open descendant, publishes the branch from the leaves upward, and returns one failure to the exact parent. An unavailable Herdr inspection remains pending rather than guessing that a pane is gone. Settled delivery and terminal delivery use separate identity gates, so a clean auto-exit race cannot send the same result twice. Error terminal results are never suppressed as duplicates of an earlier settled turn. A failed parent enqueue remains retryable.

Pending results remain bound to their recorded parent session ID and session file, and materialize when that exact session is restored. Legacy runs without lineage are never inferred or acted on.


### In-progress status updates

The widget projects each sub-agent from a **process + turn lifecycle**:

- **Herdr pane inspection** is the coarse authority for whether the child process is present and whether Herdr reports it as idle, working, blocked, or done.
- **Child activity snapshots** enrich the label with Pi-only detail (tool name, streaming, etc.) when available.
- Session JSONL is still used for transcript, resume, lineage, and result extraction — not for liveness.

Projected labels include:

- `starting` — launched; pane/activity confirmation is still settling
- `active` — processing work (agent turn, provider request, streaming, or tool execution)
- `blocked` — Herdr reports the child as blocked
- `waiting` — turn finished; the process is intentionally open for more input or another stage
- `interrupted` — the current turn was cancelled (Escape / `subagent_interrupt`); the process stays open and is **not** treated as active processing
- `stalled` — pane inspection is unhealthy long enough that the parent can no longer trust the run
- `running` — fallback when only coarse process presence is known (e.g. non-Pi backends)
- `finalizing` — completion was observed and delivery is in progress; the process elapsed timer freezes here

The widget header counts **active** vs **open**:

- **active** — `active`, `starting`, `running`, or `blocked`
- **open** — everything else still tracked (`waiting`, `interrupted`, `stalled`, `finalizing`, …)

When `activeCount === 0` (every tracked row is open), the border uses an amber accent. Process elapsed time (`MM:SS` on the left) freezes when the process reaches finalizing/completed/failed. Interrupt does **not** freeze that process clock; the interrupted state shows its own duration on the right while the process remains open.

A fixed internal watchdog marks a run as `stalled` when pane inspection is unavailable long enough; valid long-running `active` or `waiting` states do not become `stalled` just because time passes. Confirmed pane absence waits briefly for a racing completion sidecar, then destroys that owned branch and reports a terminal failure instead of leaving a stalled row. When a run enters `stalled` or recovers from it, the parent agent receives a steer message so it can react. All other status transitions stay in the widget only.

**Interactive subagents stay silent.** Long-running user-driven subagents (e.g. `planner`, or any `/iterate` fork) do not wake the parent session on `stalled`/`recovered` transitions — the user is working directly in the subagent's pane, and a steer message there would just burn an orchestrator turn on a no-op "still waiting" ping. The widget still updates normally, and activity snapshots are still recorded/classified regardless of the `interactive` setting. By default, agents with `auto-exit: true` are treated as autonomous and get stall pings; agents without it are treated as interactive and stay quiet. Override per-agent with `interactive: true|false` in frontmatter, or per-spawn with `interactive: true|false` on the tool call.

#### Configuration

The extension reads `config.json` from the installed package root—the directory
containing this README and `package.json`, not `pi-extension/subagents/` or
Herdr's `config.toml`. That file is package-local: npm or git package updates may
overwrite it. Common global package roots are:

- npm: `~/.pi/agent/npm/node_modules/pi-lpt-herdr-subagents/`
- git: `~/.pi/agent/git/<host>/<owner>/pi-lpt-herdr-subagents/`

Project-local installs use the corresponding `.pi/npm/` or `.pi/git/` root.
From the actual package root, copy the example when you want local overrides:

```bash
cp config.json.example config.json
```

```json
{
  "status": {
    "enabled": true
  },
  "models": {
    "agents": {}
  }
}
```

If `config.json` is absent, status settings fall back to `config.json.example`.
Model routing does not read the example: no model overrides apply until a real
`config.json` exists.

The copyable example is model-neutral, so it works without requiring credentials
for a specific provider. To configure models, replace the empty section with
exact IDs from your authenticated model catalog:

```json
{
  "models": {
    "default": "your-provider/your-default-model",
    "agents": {
      "scout": "your-provider/your-fast-model",
      "reviewer": "your-provider/your-review-model"
    }
  }
}
```

`models.default` sets the model for subagents that do not specify a model.
`models.agents` sets per-agent defaults, keyed by the agent name passed to
`subagent({ agent: ... })`. Explicit `model` tool arguments take precedence,
followed by agent frontmatter, per-agent config, the global default, and finally
the parent model. Model values must be exact authenticated `provider/model-id`
references. A value can contain an ordered comma-separated candidate list, for
example `provider/preferred, provider/fallback`. The extension validates every
candidate before launch. A provider/agent error that reaches the child's settled
boundary is returned immediately and does not advance to a later candidate.
Launch failures before a child reaches that boundary may still use the ordered
launch fallback behavior. Completion metadata and the status widget report the
model actually used. Workflow metadata accepts one exact model only, to keep
approved workflow runtimes deterministic.

`config.json` is gitignored in the source tree so local overrides are not
committed from a checkout. On an installed package root, treat it as disposable
local state that package updates may replace. Run `/reload` after changing it;
status and model configuration are loaded when the extension starts.

---

## Spawning Subagents

```typescript
// Named agent with defaults from agent definition or config.json
subagent({ name: "Scout", agent: "scout", task: "Analyze the codebase..." });

// Force a full-context fork for this spawn
subagent({ name: "Iterate", fork: true, task: "Fix the bug where..." });

// Agent defaults can choose a different session-mode via frontmatter
subagent({ name: "Planner", agent: "planner", task: "Work through the design with me" });

// Custom working directory
subagent({ name: "Designer", agent: "game-designer", cwd: "agents/game-designer", task: "..." });

// Isolated ticket branch in a Herdr-managed Git worktree
subagent({
  name: "Ticket 123",
  agent: "worker",
  worktree: { branch: "ticket/123", base: "main" },
  task: "Implement ticket 123, test it, and commit the result",
});
```

### Parameters

| Parameter              | Type    | Default        | Description                                                                                       |
| ---------------------- | ------- | -------------- | ------------------------------------------------------------------------------------------------- |
| `name`                 | string  | required       | Short stable child label; coordinated groups use `<task>-<role>[-n]` (widget and pane title)      |
| `task`                 | string  | required       | Task prompt for the sub-agent                                                                     |
| `agent`                | string  | —              | Load defaults from agent definition                                                               |
| `fork`                 | boolean | `false`        | Force the full-context fork mode for this spawn, overriding any agent `session-mode` frontmatter  |
| `interactive`          | boolean | derived        | Mark this spawn as interactive (don't wake the parent on stall/recovery). Defaults to the agent's `interactive` frontmatter, otherwise the inverse of `auto-exit`. |
| `model`                | string  | configured or parent | Exact authenticated `provider/model-id`, or an ordered comma-separated candidate list; candidate lists are unavailable for worktree spawns. A settled provider error is returned immediately rather than advancing candidates. Resolution is tool argument → agent frontmatter → per-agent config → global config → parent |
| `thinking`             | string  | parent level   | Pi thinking level (`off` through `max`); omit to inherit the parent                                |
| `systemPrompt`         | string  | —              | Role/system-prompt text for a bare spawn; named agents keep their definition body                  |
| `skills`               | string  | —              | Comma-separated skill names                                                                       |
| `tools`                | string  | —              | Comma-separated tool names                                                                        |
| `cwd`                  | string  | —              | Working directory, or source repository when `worktree` is set (see [Role Folders](#role-folders)) |
| `worktree`             | object  | —              | Isolated Herdr-managed Git worktree; requires `branch`, with optional `base` (committed `HEAD` by default) |


`skills` are loaded during ordinary child creation, before the assigned task runs. Pi resolves each requested name using its normal skill catalog, then the child receives all readable skill bodies once in one hidden initialization message alongside the task. The message is stored in the child session, so `subagent_resume` keeps the skill context without loading the skills again. This does not create `/skill:*` turns, extra child work, or extra parent results.

For a named role, the role's `skills:` list is used by default. A direct `skills` value replaces that list; an explicit empty string (`skills: ""`) disables role skills. Blank and duplicate names are ignored. If a requested skill is missing or unreadable, the child shows one warning for that skill and continues; the warning is not sent to the model, the child report, or the parent result. Legacy singular `skill:` role frontmatter remains supported.

This behavior applies to ordinary `subagent` children. Approved review-workflow children keep their separate read-only runtime with skills and extensions disabled (`--no-skills --no-extensions`).

### Naming coordinated children

Before launching a new group, choose a short task slug and label each new child
`<task>-<role>[-n]`, such as `login-api` or `login-test2`. Roles are `plan`,
`research`, `ui`, `api`, `build`, `test`, `review`, `browser`, `security`,
`perf`, and `merge`. Leave existing labels unchanged. After the final launch,
print `name | agent kind | role | model | worktree` and use each name in
prompts, handoffs, and results.

### Isolated worktree runs

Use one worktree per independent writing task; keep read-only agents in ordinary panes. `cwd` selects the source Git repository, `branch` must be unique, and `base` is resolved to an exact commit before creation. If `base` is omitted, the source checkout's committed `HEAD` is used. Parent-checkout changes that have not been committed are not copied.

A launch with `worktree` and an effective bundled `scout`, `reviewer`, or `adversarial-reviewer` returns a non-blocking warning. Scouts and reviewers normally need an ordinary pane; the adversarial reviewer is a coordinator that uses an ordinary pane for its child reviewers. To inspect or review an existing worker result, start an ordinary child in that retained worktree path. Project or global role overrides do not receive these bundled-role warnings.

The child starts at the returned worktree root. Tell writing agents to test and commit when you want a commit-based handoff, and tell them not to push, merge, switch branches, or remove the worktree. The parent owns review and integration.

Successful, failed, and help-requesting runs retain their workspace. Completion includes the worktree path, Herdr workspace, branch, base/head SHAs, commits ahead, changed and untracked files, and clean/dirty/conflicted state. Here, `clean` means no uncommitted files; the branch may still contain commits. If Git inspection fails, state is reported as unknown rather than guessed.

An ownership manifest and durable lineage record are written before Herdr creates resources. After a full process restart, the extension restores recorded ownership, pending exact-parent delivery, and independent ordinary-pane cleanup. The retained worktree remains review evidence; `subagent_resume` still opens an ordinary pane and does not reattach the managed worktree lifecycle.

The extension does **not** push, create a PR, merge, cherry-pick, or remove the worktree or branch automatically. For task selection, lifecycle states, review commands, failure recovery, and safe cleanup, read [Worktree subagents](docs/worktree-subagents.md). The [research report](docs/research/worktree-subagent-orchestration.md) records the rationale and deferred roadmap.

---

## Interrupting a running subagent

Use `subagent_interrupt` to cancel the active turn of a running Pi-backed subagent:

```typescript
subagent_interrupt({ id: "abcd1234" });
// or
subagent_interrupt({ name: "Scout" });
```

This sends Escape to the child pane, cancelling the in-progress model turn. The subagent session stays alive — the pane, session file, and background polling all remain intact. After the interrupt, the widget immediately labels the child as `interrupted` (counted as **open**, not active processing). Stale pre-interrupt activity snapshots are ignored so a lagging Herdr/`active` reading cannot overwrite the interrupt. The process elapsed timer keeps running because the pane is still open; only the interrupted-state duration freezes relative to the interrupt request. If the child starts work later, newer observations return it to `active`; completion, failure, and `caller_ping` still flow through normally.

This is a turn-level interrupt, not a method for forcibly terminating a subagent session.

### Cancelling a subagent session

Use `subagent_cancel` with an exact child ID or an unambiguous name when the session itself must end. Cancellation intent and process identity are recorded before any pane action. The result is not reported as cancelled until pane absence and process exit are proven; uncertain or changed identity stays pending for retry. Repeated calls reuse the same durable cancellation, and a natural completion race has only one terminal winner. Worktree and session evidence remain available.

---

## Workflow control (`herdr_workflow`)

The parent-only `herdr_workflow` tool prepares, starts, and cancels one exact project-local review workflow. Children never receive this tool.

```typescript
herdr_workflow({ action: "prepare", path: ".pi/plans/run-1/workflow.js" });
herdr_workflow({ action: "start", runId: "run-1" }); // after APPROVE <hash prefix>
herdr_workflow({ action: "cancel", runId: "run-1" });
```

### Prepare and start contract

- The script must be `<project>/.pi/plans/<run>/workflow.js` in a trusted Git repository with no existing adjacent `run.jsonl`.
- Its first comment contains strict version-1 JSON metadata that binds the exact committed base, source provenance, distinct review-node IDs and their roles, authenticated `provider/model` references, thinking levels, and per-run caps that cannot exceed the fixed limits.
- Fixed workflow caps: 256 KiB source, 8 agents, concurrency 4, 30-minute deadline, 100,000-character prompts, 100 logs × 4,000 characters, and 64 KiB serialized task result. Metadata may only lower caps.
- Preparation validates and compiles without evaluating JavaScript, creating a journal or checkout, or launching a child. It returns the exact approval packet and keeps one pending candidate in process memory.
- Start requires the latest real user message in the same parent session to be exactly `APPROVE <8 lowercase hex characters>`. It revalidates the complete candidate, consumes approval once, creates the append-only journal, and runs in the background.
- Review children are fresh Pi sessions with derived read-only tools in one detached checkout pinned to the approved base. Parent uncommitted files are absent, intermediate child results stay inside the workflow, and operational failures remain explicit non-retryable evidence for parent-guided recovery.
- Approved workflow JavaScript runs in a restricted `vm` inside a Worker thread. Neither mechanism is a security boundary; run only project code that the user has inspected and approved.
- Same-process `/reload` keeps workflow ownership and the Worker alive. After a full process restart, recovery records `interrupted_pending`, waits for recorded child nodes to drain into the workflow inbox, then publishes exactly one interrupted envelope. It does not replay the script, restart children, expose intermediate results, or remove retained evidence.

### Cancel contract

- Cancel claims a process-global terminal gate. Completion, failure, interruption, and cancellation cannot each produce a terminal outcome.
- Queued `agent()` calls resolve as cancelled; no later reviewer or synthesizer starts.
- New panes are queried through Herdr process-info until their interactive shell is ready before launch. Active panes are queried again before close so foreground process identities can be waited on.
- After synchronous pane close, cancel waits for pane absence and captured process exit before disposing the reader checkout.
- If process identity cannot be captured for an active pane, the pane remains present after close, or any captured process still lives after the bounded wait, the checkout is retained and the run ends `failed` with `cancel_termination_failed`. Successful cancellation is not reported in that case.
- A successful cancel writes one `cancelled` terminal journal event and one result-free delivery. Repeated cancel is idempotent and returns the authoritative terminal outcome (including a prior fail-closed result).

There is no list, status, resume, or history action in v1. Workflow ownership and the Worker survive `/reload` in the same Pi process, and the latest parent API receives one final delivery. A full process restart does not replay the workflow: child results stay in the run inbox, recovery waits for the recorded nodes to drain, then sends one interrupted envelope to the exact preparing session. Sessions, journals, and reader checkouts remain in place, and further work requires a new approved run.

### Bundled `orchestrate` skill

The package bundles the native `/skill:orchestrate` procedure. It accepts local paths, URLs, tickets, or combinations that the parent can already access. The parent performs read-only preflight discovery and materializes exact remote or tracker evidence before writing one unique `.pi/plans/<run>/workflow.js` at a committed base. The skill authors distinct fresh read-only review nodes in bounded parallel and one fresh synthesis node; nodes can share a review role, and a retry keeps the same node and runtime only for an explicit `retryable: true` failure. It does not use public `subagent()` for workflow nodes and does not author writers, commits, external effects, nested workflows, replay, or a fixed task schema.

The parent calls `herdr_workflow prepare`, presents its packet unchanged, and waits for the exact `APPROVE <8-character lowercase hash prefix>` reply before calling `start`. After start, one final delivery is sent without polling. Cancellation is fail-closed and retains evidence when process exit cannot be confirmed. Same-process `/reload` preserves ownership. After a full restart, recovery records `interrupted_pending` while descendants drain into the workflow inbox, then sends one interrupted envelope without script replay, child restart, automatic evidence cleanup, or history. Workflow JavaScript runs in a Worker-hosted `vm` for event-loop availability only; neither the Worker nor `vm` is a security boundary, and worktrees do not provide process or security isolation.

---

## caller_ping — Child-to-Parent Help Request

The `caller_ping` tool lets a Pi-backed subagent request help from its parent agent. When called, the child records help intent. If descendants are still running, delivery and exit wait until they drain; afterward the exact parent receives the help message and the child exits. The parent can then resume the child session with a response using `subagent_resume`.

**`caller_ping` parameters:**

- `message` (required): What you need help with

**`subagent_resume` parameters (Pi-backed sessions):**

- `sessionPath` (required): Path to the child session `.jsonl` file
- `name` (optional): Display name for the resumed pane (defaults to `Resume`)
- `message` (optional): Follow-up prompt to send after resuming
- `autoExit` (optional): Whether the resumed session should record auto-exit intent after its next clean or empty response, then deliver and close after recursively owned descendants drain. Defaults to `true` for autonomous follow-up work; set `false` for an interactive handoff.

**Interaction flow:**

1. Child calls `caller_ping({ message: "Not sure which schema to use" })`
2. If descendants remain, the child keeps ownership and waits for them to drain; then its session exits (like `subagent_done`)
3. Parent receives a steer notification: *"Sub-agent Worker needs help: Not sure which schema to use"*
4. Parent resumes the child session via `subagent_resume` with the response
5. Child picks up where it left off with the parent's guidance

**Example:**

```typescript
// Inside a worker subagent
await caller_ping({
  message: "Found two conflicting migration files — should I use v1 or v2?"
});
// Session exits after descendants drain. Parent receives the ping, then resumes this session
// with guidance like "Use v2, v1 is deprecated"
```

> **Note:** `caller_ping` is only available inside Pi-backed subagent contexts. Calling it from a standalone Pi session returns an error. For a worktree child, the help handoff retains the workspace, but `subagent_resume` does not reattach worktree tracking; continue the work in the retained workspace.

---

## The `/plan` Workflow

The `/plan` command orchestrates a full planning-to-implementation pipeline.

```
/plan Add a dark mode toggle to the settings page
```

```
Phase 1: Investigation    → Quick codebase scan
Phase 2: Planning         → Interactive planner subagent (user collaborates)
Phase 3: Review Plan      → Confirm ordered tasks, adjust if needed
Phase 4: Execute          → Sequential workers, or isolated parallel workers for independent tasks
Phase 5: Integrate        → Parent reviews and integrates worktree branches one at a time
Phase 6: Review           → Reviewer subagent checks the integrated changes
```

The parent workspace and tab names stay unchanged. Subagents are created in newly named tabs or panes for each phase.

---

## The `/iterate` Workflow

For quick, focused work without polluting the main session's context.

```
/iterate Fix the off-by-one error in the pagination logic
```

This always forks the current session into a subagent with full conversation context. It does not inherit an agent default `session-mode`. Make the fix, verify it, and exit to return. The main session gets a summary of what was done.

---

## The `/btw` Workflow

Use `/btw` for a quick side question without adding a turn to the main session:

```text
/btw What did we decide about session cleanup?
```

The extension snapshots the current active conversation branch, opens a non-focused Herdr tab, and starts an interactive Pi session with the same model and thinking level. The answer stays in that tab and is never delivered as a subagent result. A second `/btw` replaces the previous one; `/btw-close` closes it explicitly.

BTW shares the current working directory. It treats inherited work as reference context and modifies the workspace only when the side question explicitly requests it. Cleanup is best effort; if closing fails, the tab remains available for manual recovery.

---

## The `/worktree` Workflow

`/worktree <worktree> [task]` creates a Herdr-managed worktree from the current committed branch and launches a new interactive Pi session there with the active conversation branch. The original session remains available. Use `/worktree list` to list worktrees for the current repository. This is a new-process handoff, not an in-place move of the existing shell or Pi process.

---

## Custom Agents

Custom agent roles are the package's primary extension mechanism. Create one
when a child needs a reusable, bounded responsibility such as scouting,
implementation, or review. If the new concept instead describes a multi-stage
user outcome, make it a workflow, command, or Pi skill that composes roles; do
not disguise a workflow as an agent definition.

### 1. Choose the scope

| Scope | Location | Use when |
| ----- | -------- | -------- |
| Project | `.pi/agents/<name>.md` | The role belongs to one repository |
| Global | `$PI_CODING_AGENT_DIR/agents/<name>.md` | The role should be available everywhere; the default root is `~/.pi/agent` |
| Role pack | An installed Pi package's registered `roles/` directory | The role should be independently installable and shareable |
| Bundled | This package's `agents/<name>.md` | Contributing a fallback role maintained with `pi-lpt-herdr-subagents` |

The filename stem is the launch key. `name` frontmatter is optional because it
defaults to the filename stem. If supplied, keep it identical so overrides remain
predictable; role packs reject mismatches.

### 2. Create the definition

```markdown
---
description: Reviews a bounded change for concrete security vulnerabilities
thinking: high
tools: read, bash
system-prompt: append
session-mode: standalone
spawning: false
auto-exit: true
---

# Security Reviewer

Review only the requested change. Trace trust boundaries and affected callers.
Report concrete findings with file and line references, exploit conditions,
severity, and the smallest safe correction. Do not modify files.
```

Omit `model` to use `models.agents.<name>`, then `models.default`, then the
parent model. Put `model` in frontmatter only when the role itself needs a
specific exact authenticated `provider/model-id`.

`tools` is passed to Pi's `--tools` allowlist and may name any registered
built-in, extension, or custom tool. Listing a tool does not install its
extension. Likewise, `skills` names must already be discoverable by Pi; this
package does not install role prerequisites.

### 3. Verify and launch

```text
/subagent list
/subagent security-reviewer Review the authentication changes against main
```

Or call the tool directly:

```typescript
subagent({
  name: "Security review",
  agent: "security-reviewer",
  task: "Review the authentication changes against main.",
});
```

Agent files are read when definitions are listed or launched, so creating or
editing one normally does not require `/reload`. Installing, removing, updating,
or changing the extension code of a role pack uses Pi's normal `/reload` flow.

### Publish a role pack

A role pack is an ordinary Pi package with Markdown definitions and a tiny
extension that registers their directory through Pi's public inter-extension
event bus:

```text
security-roles/
├── package.json
├── extension.ts
└── roles/
    └── security-reviewer.md
```

```json
{
  "name": "@acme/security-roles",
  "version": "1.0.0",
  "keywords": ["pi-package"],
  "type": "module",
  "pi": {
    "extensions": ["./extension.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  }
}
```

```typescript
import { fileURLToPath } from "node:url";

const roles = fileURLToPath(new URL("./roles", import.meta.url));

export default (pi: any) => {
  const unsubscribe = pi.events.on(
    "pi-herdr-subagents:roles:discover:v1",  // stable protocol identifier
    (request: { apiVersion: number; register(path: string): void }) => {
      if (request.apiVersion === 1) request.register(roles);
    },
  );
  pi.on("session_shutdown", unsubscribe);
};
```

Install both packages through Pi; the role pack remains inert if
`pi-lpt-herdr-subagents` is absent:

```bash
pi install npm:pi-lpt-herdr-subagents
pi install npm:@acme/security-roles
```

Registration is synchronous and accepts one absolute Markdown file or a
directory whose direct `.md` children are roles. The bridge must unsubscribe on
`session_shutdown` as shown so removed or updated packages do not survive a
reload. A copyable package lives in [`examples/role-pack/`](examples/role-pack/).
The host reads and validates
the files, derives package name/version from the nearest `package.json`, and
reports invalid paths, missing descriptions, filename/name mismatches, and
package-layer collisions in the listing surfaces.

Role packs cannot replace bundled roles, and duplicate role names from multiple
role packs are disabled rather than resolved by extension load order. Use a
global or project definition for an intentional override.

See [ADR-0003](docs/adr/0003-installable-role-packs.md) for the registration seam,
collision rules, and rejected alternatives.

### Authoring checklist

- The role has one bounded responsibility and a clear report or handoff contract.
- The filename stem is the role name; if `name` is present, it matches the stem.
- `description` states the role's input/output responsibility.
- `tools` and `skills` contain only installed, necessary capabilities.
- Leaf roles set `spawning: false`.
- Autonomous roles set `auto-exit: true`; interactive roles leave it off.
- Generic roles omit `model` unless a particular runtime is functionally required.
- `/subagent list` shows the expected source and a smoke launch succeeds.

The current parser is permissive: unsupported or unknown frontmatter may be
ignored rather than rejected. Compare definitions against the reference below
and verify them with `/subagent list` plus a smoke launch.

### Frontmatter Reference

| Field         | Type    | Description                                                                                                                                                                                                                                                                 |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | string  | Optional explicit agent name used in `agent: "my-agent"`; defaults to the filename stem and must match it in role packs                                                                                                                                                                                            |
| `description` | string  | Shown in `subagents_list` output                                                                                                                                                                                                                                            |
| `model`       | string  | Optional exact authenticated Pi model default or ordered comma-separated candidate list; a settled provider error is returned immediately; omit to use per-agent config, global config, then the parent                                                                                                                       |
| `thinking`    | string  | Optional Pi thinking default (`off` through `max`); omit to inherit the parent                                                                                                                                   |
| `system-prompt` | string | `append` passes the agent body through Pi's appended system prompt; `replace` replaces Pi's default system prompt. Without this field, the body is included in the task wrapper                                                                                                                                                                                                                                 |
| `tools`       | string  | Comma-separated Pi `--tools` allowlist; may contain any registered built-in, extension, or custom tool name                                                                                                                                                                 |
| `skills`      | string  | Comma-separated installed skill names to auto-load. Use this plural form for new definitions; legacy project/global definitions using singular `skill` remain compatible. |
| `session-mode` | string | Default child-session mode: `standalone`, `lineage-only`, or `fork` |
| `spawning`    | boolean | Set `false` to deny all subagent-spawning tools                                                                                                                                                                                                                             |
| `deny-tools`  | string  | Comma-separated `pi-lpt-herdr-subagents` tool names to suppress; this is not a universal cross-extension deny list                                                                                                                                                                  |
| `auto-exit`   | boolean | Record terminal intent at a clean or empty settled outcome — no `subagent_done` call needed — then deliver and shut down after recursively owned descendants drain. Provider errors and aborted turns keep the session open so it can be resumed. If the user sends any input, auto-exit is permanently disabled and the user takes over the session. Recommended for autonomous agents (scout, worker); not for interactive ones (planner). Also determines the default value of `interactive` (see below). |
| `interactive` | boolean | Override whether stall/recovery transitions wake the parent session. Defaults to the inverse of `auto-exit`: autonomous agents (`auto-exit: true`) are non-interactive and get stall pings; agents without `auto-exit` are interactive and stay quiet. Explicit values take precedence. |
| `cwd`         | string  | Default working directory. Absolute paths are unambiguous; relative agent-frontmatter paths resolve from Pi's agent config directory (`PI_CODING_AGENT_DIR` or `~/.pi/agent`), not the project root                                                                                                                                                                                                            |
| `disable-model-invocation` | boolean | Hide a role from discovery surfaces like `subagents_list`. The definition remains directly invocable by exact name via `subagent({ agent: "name", ... })`. |

---

Discovery still resolves precedence before visibility filtering. If a project-local hidden agent has the same name as a visible global or bundled agent, the hidden project agent wins and the lower-precedence agent does not appear in `subagents_list`.

### `session-mode`

Choose how a subagent session starts:

- `standalone` — default fresh session with no lineage link to the caller
- `lineage-only` — fresh blank child session with `parentSession` linkage, but no copied turns from the caller
- `fork` — linked child session seeded with the caller's prior conversation context

`lineage-only` is useful when you want session discovery and fork lineage UX to show the relationship later, but you do **not** want the child to inherit the parent's turns.

`fork: true` on the tool call always forces the `fork` mode for that specific spawn. `/iterate` uses this explicit override on purpose.

```yaml
---
name: planner
session-mode: lineage-only
---
```

### `auto-exit`

When set to `true`, a clean or empty settled outcome records terminal intent — no explicit `subagent_done` call is needed. The result is delivered and the session shuts down only after recursively owned descendants drain. Provider errors and aborted turns keep the session open so they can be resumed.

**Behavior:**

- A clean final message or empty final response records terminal intent at the settled boundary; delivery and closure wait until recursively owned descendants drain
- If the user sends **any input** before the agent finishes, auto-exit is permanently disabled for that session — the user takes over interactively
- The modeHint injected into the agent's task is adjusted accordingly: autonomous agents see "Complete your task autonomously." rather than instructions to call `subagent_done`

**When to use:**

- ✅ Autonomous agents (scout, worker, reviewer) that run to completion
- ❌ Interactive agents (planner, iterate) where the user drives the session

```yaml
---
name: scout
auto-exit: true
---
```

### `interactive`

Controls whether status transitions (`stalled`, `recovered`) wake the parent session with a steer message.

**Default:** the inverse of `auto-exit`. Autonomous agents (`auto-exit: true`) are non-interactive and ping the parent on stall/recovery; named agents without `auto-exit` are interactive and stay quiet. Bare spawns have no agent definition and default to autonomous auto-exit behavior. `/iterate` is interactive because it explicitly passes `interactive: true`.

**Why it exists:** Interactive agents can run for minutes or hours while the user thinks, types, and reads in the subagent's pane. Child snapshots still update the widget, but stalled/recovered supervision messages rarely need to wake the parent for user-driven sessions. Skipping the steer keeps the parent quiet until the child actually finishes.

**When to override:**

- Set `interactive: false` on an agent that doesn't auto-exit but you still want stall pings for
- Set `interactive: true` on an autonomous agent you'd rather check on yourself

```yaml
---
name: planner
# interactive defaults to true because auto-exit is not set
---
```

Or per spawn:

```typescript
subagent({ name: "Scout", agent: "scout", interactive: true, task: "..." });
```

---

## Tool Access Control

Without a restrictive `tools` allowlist or spawning policy, a sub-agent can spawn further sub-agents. Control this with frontmatter:

### `spawning: false`

Denies all subagent lifecycle tools (`subagent`, `subagent_interrupt`, `subagents_list`, `subagent_resume`):

```yaml
---
name: worker
spawning: false
---
```


### `allow-self-spawn: true`

Exact-role self-spawn is denied by default. Set this only on an orchestrator that must hand a distinct task to a fresh instance of its own role:

```yaml
---
name: project-manager
allow-self-spawn: true
---
```

The child still uses ordinary subagent lifecycle rules. The role prompt must define a bounded handoff and prevent same-task recursion. Other roles remain blocked when the field is absent or false.

### `deny-tools`

Fine-grained control over tools registered by `pi-lpt-herdr-subagents`:

```yaml
---
name: focused-agent
deny-tools: subagent
---
```

### Recommended Configuration

| Agent      | `spawning`  | Rationale                                    |
| ---------- | ----------- | -------------------------------------------- |
| planner    | *(default)* | Legitimately spawns scouts for investigation |
| worker     | `false`     | Should implement tasks, not delegate         |
| reviewer   | `false`     | Should review, not spawn                     |
| scout      | `false`     | Should gather context, not spawn             |

---

## Role Folders

The `cwd` parameter lets sub-agents start in a specific directory with its own configuration:

```
project/
├── agents/
│   ├── game-designer/
│   │   └── CLAUDE.md          ← "You are a game designer..."
│   ├── sre/
│   │   ├── CLAUDE.md          ← "You are an SRE specialist..."
│   │   └── .pi/skills/        ← SRE-specific skills
│   └── narrative/
│       └── CLAUDE.md          ← "You are a narrative designer..."
```

```typescript
subagent({ name: "Game Designer", cwd: "agents/game-designer", task: "Design the combat system" });
subagent({ name: "SRE", cwd: "agents/sre", task: "Review deployment pipeline" });
```

Set a default `cwd` in agent frontmatter. Use an absolute path for a project directory; relative frontmatter paths are resolved from Pi's agent config directory:

```yaml
---
name: game-designer
cwd: /absolute/path/to/project/agents/game-designer
spawning: false
---
```

---

## Tools Widget

Every sub-agent session displays a compact tools widget showing available and denied tools. Toggle with `Ctrl+J`:

```
[scout] — 12 tools · 4 denied  (Ctrl+J)              ← collapsed
[scout] — 12 available  (Ctrl+J to collapse)          ← expanded
  read, bash, edit, write, ...
  denied: subagent, subagents_list, ...
```

---

## Development

Run local checks:

```bash
npm ci
npm test
npm run lint
npm pack --dry-run
```

Run the required end-to-end suite from inside Herdr:

```bash
npm run test:integration
```

The deterministic suite launches real Pi sessions, Herdr panes, and worktrees without provider credentials. Each command bootstraps a separate test-owned headless Herdr server with a private socket, config, state directory, and worktree directory. It clears inherited Herdr identity and fails closed if that private endpoint cannot start, so it cannot fall back to the persistent user server. Normal exit and `SIGINT`, `SIGTERM`, or `SIGHUP` use one idempotent shutdown that verifies child and server process groups have exited, escalates after bounded grace, and removes only the run's owned paths. Concurrent runs use separate endpoints and need no shared Herdr test slot. Pass a test file after `--` for a focused run:
```bash
npm run test:integration -- test/integration/mux-surface.test.ts
```

The optional live-provider smoke test is not a merge gate:

```bash
PI_TEST_MODEL="openai-codex/gpt-5.6-luna" PI_TEST_TIMEOUT=180000 \
  npm run test:integration:live
```

See [RELEASING.md](RELEASING.md) for versioning, trusted publication, and release verification.

---

## Acknowledgements

This package builds on earlier open-source work by [HazAT/pi-interactive-subagents](https://github.com/HazAT/pi-interactive-subagents) and [0xRichardH/pi-herdr-subagents](https://github.com/0xRichardH/pi-herdr-subagents). The sub-agent status supervision and turn-only interruption features were inspired by [RepoPrompt](https://repoprompt.com/)'s sub-agent snapshot polling and run cancellation features.

---

## License

MIT. Copyright notice retained from the upstream lineage (`HazAT`).
