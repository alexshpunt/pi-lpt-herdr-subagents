# Settled lifecycle contract

This document defines how child turns become one parent result. The TypeScript source for settled outcome shapes is `pi-extension/subagents/settled-contract.ts`.

## Settled turns stay local

A settled assistant entry is still classified for child control:

- `clean`: non-empty assistant text with no final provider error.
- `empty`: a settled assistant entry with no usable text.
- `error`: `stopReason: "error"`.
- `intentional-abort`: `stopReason: "aborted"` after the parent recorded an interrupt request.
- `unexpected-abort`: `stopReason: "aborted"` without an interrupt request.

These boundaries do not publish parent results. A persistent child can settle many times while it remains open. Its earlier answers, empty turns, errors, and aborts stay in its own session.

For an autonomous child, a clean or empty boundary can record terminal intent only after it has processed the last descendant result. Earlier boundaries stay local. Provider errors and aborts keep the child open.

Manual and automatic context compaction are active child work. `session_before_compact` protects the child from stale recovery until `session_compact` or `session_compact_failed` ends that state. Compaction never publishes or repeats a parent result.

## One terminal result

A child publishes only when it reaches a terminal lifecycle outcome, such as auto-exit, `subagent_done`, cancellation, confirmed pane loss, or recovery failure.

The terminal path:

1. reads the latest child result;
2. waits for every recursive descendant to drain;
3. writes one immutable result file and one durable inbox entry;
4. materializes that inbox in the exact parent session once;
5. records delivery before cleanup; and
6. removes the child from active supervision as soon as cleanup allows.

The stable terminal delivery ID is the child ID prefixed with `terminal:`. Delivery uses an exclusive durable claim. A successful send is acknowledged once. A failed send remains retryable. Compaction, reload, restored watchers, and later parent tool calls cannot materialize an acknowledged delivery again.

Old pending `settled` inbox entries are acknowledged without being sent. This prevents an upgrade or restored session from exposing an intermediate response after the terminal-only rule is active.

Cleanup is separate from delivery. An ordinary child pane closes after delivery. A worktree child keeps its review workspace. If cleanup fails, the delivered child can remain visible as `cleanup pending`, but its result is not sent again.

## Descendants and exact-parent binding

A child drains only after its terminal outcome reaches its exact immediate-parent inbox and all descendants drain recursively. Failed inbox publication has no timeout and is never rerouted. A pending session inbox stays bound to its recorded parent session ID and file until that exact session returns.

Lineage identity belongs to the launched Pi process. Shell commands and test runners may inherit environment variables, but they cannot register fixture calls as real descendants.

A public `SubagentTree` owner is different. Its callbacks process child results inside the tree runtime. The tree result still waits for all reserved descendants, but ordinary model-facing `subagent_result` delivery follows the one-terminal-result rule above.
