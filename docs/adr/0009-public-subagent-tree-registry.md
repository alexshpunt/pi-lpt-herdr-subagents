# ADR 0009: Public subagent tree registry

- Status: Accepted
- Date: 2026-08-30

## Decision

The package-root public subagent tree API uses a lazy process-local registry and one single-writer branch journal per Pi process. Tree artifacts live below the original caller session's artifact directory. Published node, terminal, and callback records use temporary files and same-filesystem rename; exclusive claims prevent competing owners.

Nested Pi children receive only a package-owned context-file path outside model task text. They attach with validated caller, tree, token, and parent identities. The existing `launchPiSubagent()` remains the only Pi/Herdr launch owner.

`/reload`, `/new`, and `/resume` rebind fresh context in the same process. `/fork` is accepted only when the fresh session's `parentSession` header matches the previously bound session and `previousSessionFile`; stale callbacks are rejected by binding generation. Terminal completion is one compare-and-set record, and cancellation is authoritative only after pane absence and captured process exit are confirmed.

## Consequences

The API is intentionally for installed Pi extensions inside Herdr and does not promise arbitrary Node use or full process restart recovery. A process crash can leave retained evidence for inspection, but the filesystem protocol is not a restartable workflow engine. Clean and explicit-empty roots may complete while descendant error or abort panes remain open and are reported in bounded lifecycle rows.
