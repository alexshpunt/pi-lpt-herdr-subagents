# Settled lifecycle contract

This document freezes the shared shapes for the settled lifecycle streams. It is
an implementation boundary, not a new public tool API.

The TypeScript source is
`pi-extension/subagents/settled-contract.ts`.

## Outcome policy

A settled assistant entry is classified as one of five outcomes:

- `clean`: non-empty assistant text with no final provider error.
- `empty`: a settled assistant entry with no usable text. This is delivered as
  an explicit empty result; an earlier response must not be reused.
- `error`: `stopReason: "error"`. Deliver the error once and keep the child
  session open for resume.
- `intentional-abort`: `stopReason: "aborted"` after the parent recorded an
  interrupt request. Do not deliver a parent result; keep the child open.
- `unexpected-abort`: `stopReason: "aborted"` without an interrupt request.
  Deliver an explicit aborted problem once and keep the child open.

A tool error is recoverable when a later clean assistant response is produced
in the same settled run. The final assistant entry remains authoritative. The
policy constant is `SETTLED_TOOL_ERROR_POLICY`.

`SETTLED_OUTCOME_POLICY` freezes the parent and child action for each outcome:

| Outcome | Parent | Child |
| --- | --- | --- |
| `clean` | deliver | auto-exit |
| `empty` | deliver explicit empty result | auto-exit |
| `error` | deliver explicit error | keep open |
| `intentional-abort` | suppress | keep open |
| `unexpected-abort` | deliver explicit aborted problem | keep open |

## Identity and ordering

`NewestAssistantEntry` preserves the assistant entry `id`, text, content
length, stop reason, provider error, and empty state. The entry `id` is the
response identity; do not use text or turn index as a deduplication key.

`SessionBaselineCursor` records the session file, pre-run entry count, leaf id,
and inherited assistant ids. Fork history is baseline state, not new child
output.

`SettledDeliveryIdentity` is the tuple `(childId, sessionFile,
assistantEntryId)`. `settledDeliveryKey()` serializes that tuple without
ambiguous path delimiters.

## Delivery gates and parent payload

Settled delivery and terminal completion are separate gates:

- `SettledDeliveryGate` tracks the latest activity sequence and delivered
  settled identities. It can deliver multiple turns for one child.
- `TerminalDeliveryGate` remains `pending`, `delivered`, or `suppressed` and
  represents the one terminal outcome. Settled delivery must never consume it.

`SettledParentPayload` carries the explicit parent fields: child id, session
file, assistant entry id, activity sequence, turn index, outcome, text, stop
reason, provider error, and empty state. Parent delivery bounds presentation
text while preserving these identity and outcome fields.
