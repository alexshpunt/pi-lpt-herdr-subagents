# Public subagent tree API

`@alexshp/pi-lpt-herdr-subagents` exports a registration-free API for installed Pi extensions running in Herdr. Importing the package root does not register model-facing tools.

## Create and launch

```ts
import {
  createSubagentTree,
  type SubagentTreeResult,
} from "@alexshp/pi-lpt-herdr-subagents";

const tree = createSubagentTree({ pi, ctx, metadata: { requestId: "search-1" } });
const child = await tree.launchChild({
  parentId: tree.callerId,
  name: "search-router",
  task: "Find the requested records.",
  tools: ["read"],
});
const childResult = await child.result;
const result: SubagentTreeResult = await tree.result;
```

The package owns `callerId`, `treeId`, `ownerId`, node IDs, parent IDs, and the opaque `ownershipToken`. Consumer metadata is JSON-compatible and limited to 64 KiB of serialized UTF-8 bytes. Returned metadata, results, and the `children` map are read-only. Child result metadata carries those immutable identities plus the consumer value.

## Reattach and fork

A consumer calls `attachSubagentTree` from every fresh `session_start` with the current `pi` and `ctx`, caller credentials, and any callback. For `/reload`, `/new`, and `/resume`, this replaces the stale session references. For `/fork`, pass `forkLineage: { previousSessionFile }`. The API checks the previous binding and the new session header's `parentSession` before replacing the active context. A failed check leaves the old context untouched.

The attached handle rebuilds its read-only `children` map. Each child keeps the same awaitable result identity, including answers that settled while the consumer was unbound. Only the original caller branch may call `bindFinalCallback`; callback bindings are versioned, and a successful callback is delivered once. A callback failure remains pending for a later binding.

## Settlement and cancellation

`tree.result` resolves once the root has a clean or explicit-empty settled result and every queued or launched descendant has settled. A root provider error, launch failure, or unexpected abort fails the tree. Descendant errors remain in bounded lifecycle rows. Intentional Escape is not a final tree result. Node rows report actual pane evidence (`open`) and bounded session and error facts; full descendant outputs remain on child promises.

`cancel()` returns the one authoritative cancellation record. It stops new reservations, waits for in-flight launches to settle, closes known descendant panes, and confirms both pane absence and captured process exit. Missing identity or surviving resources produces `cancel_termination_failed` with retained evidence. Late child records cannot replace a terminal record.

## Public exports

The root exports `createSubagentTree`, `attachSubagentTree`, `SubagentTreeHandle`, `SubagentChildHandle`, launch/result/metadata types, `ForkLineage`, and the error classes `SubagentTreeError`, `SubagentTreeValidationError`, and `SubagentTreeOwnershipError`.
