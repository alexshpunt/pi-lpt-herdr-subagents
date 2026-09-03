# ADR-0009: Durable recursive subagent ownership

## Status

Accepted for ALE-48. This ADR extends the lifecycle contract without changing
worktree retention or resume reattachment behavior.

## Decision

Every launch writes an immutable, atomically published lineage event before a
Herdr pane or workspace exists. Descendants inherit an explicit root and
immediate-parent node identity. Stable event and effect IDs make concurrent
writes and retries idempotent without a resident coordinator.

Publishable settled and terminal results wait until recursive descendants drain.
A persistent owner keeps held settled results in their original order. An
autonomous owner's intermediate clean or empty response is not publishable while
a descendant still owes a result. The descendant result wakes that owner; only
a new eligible `agent_settled` boundary may publish the owner's answer and arm
shutdown. A node drains only after its terminal outcome is recorded once in its
exact parent sink and every descendant has drained. Interrupt and stall are not
terminal outcomes.

Public `SubagentTree` owners keep their callback-driven drain behavior because
the tree runtime processes child results internally rather than through a new Pi
turn.
A session sink is bound to the recorded parent session ID and file. Recording
its durable inbox entry completes delivery even while that session is closed;
the entry materializes once when that exact session is restored. Delivery does
not time out, skip the immediate parent, or move to an active replacement.

Each active inbox materialization takes a durable lineage gate and an exclusive
claim keyed by its delivery ID. The gate is shared by independent Pi processes and
compares still-pending entries for the same exact parent sink by activity sequence;
a later settled, error, or terminal entry cannot pass an earlier one. Competing
processes do not send while another claim is live. After a crash, recovery first
checks the exact session for the stable delivery ID; existing evidence is
acknowledged without another send, while a claim is reclaimed only when its
process incarnation is dead or its PID's Linux `/proc/<pid>/stat` start time has
changed. Portable environments that cannot verify an incarnation fail closed.
The durable acknowledgement is written before the claim is released.

Workflow nodes use a workflow-run inbox, so intermediate results stay internal.
After a coordinator restart, recovery does not replay the script: it waits for
recorded nodes to drain, then publishes exactly one interrupted envelope to the
preparing session.

Cancellation is terminal only after pane absence and process exit are proven
and its result reaches the parent sink. Cleanup is separate from delivery.
Missing panes or tabs are an idempotent cleanup success. A finished ordinary
subagent closes its dedicated Herdr tab so no empty tab header remains; retained
worktree cleanup is unchanged. Other failures remain visible and retryable
without blocking drain or replaying a result. Pre-lineage evidence
stays unknown and is never inferred or acted on.

## Consequences

Full process restart can restore active, interrupted, stalled, delivery-pending,
and cleanup-pending records created by this contract. Session files, lineage
evidence, resume input, and retained worktrees remain available. Resuming a
worktree child still opens an ordinary pane and does not reattach managed
worktree ownership.

## Rejected alternatives

Process-local state, one shared mutable JSON file, and a resident coordinator do
not meet independent restart recovery. Inferring a parent from pane names or
session paths can misroute results. Appending directly to an inactive session or
waiting to count delivery until resume either risks concurrent transcript writes
or blocks ancestors indefinitely. Sending workflow node results to the parent
would break the one-final-envelope boundary. Coupling cleanup to delivery would
duplicate or lose results when Herdr is unavailable.
