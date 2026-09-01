# Enforce session lifecycle monotonicity

## Failed behavior

Issue 29 preserves queued evidence across acceptance, but the resolver can hide cross-source message/status conflicts when a caller supplies one message. Background result/failure patches are still built before turn ownership, delayed WAITING responses can regress terminal tombstones, task updates can change terminal lifecycle, and overlapping terminal recovery pages can move the durable cursor backward.

## Affected flow

This repairs [Preserve queued evidence after acceptance](29-preserve-queued-evidence-after-acceptance.md) as implemented by commit `a0eccf688`.

The owning repair is monotonic session lifecycle settlement inside the ordered mutation turn, with fail-closed durable identity resolution and compare-and-set cursor advancement.

## Repair requirements

- Validate all durable queued evidence for one session/thread/run before filtering by caller message. Conflicting message, predecessor, or terminal status across pending, reservation, accepted, and tombstone sources is a consistency error; a caller cannot choose one side.
- When exact evidence is terminal, delayed WAITING/RUNNING routed or direct responses cannot change `lastRunStatus`, wait state, accepted authority, graph, UI, history, or output.
- Build background result/failure/waiting mutations from the current session only after acquiring the session/global turn. A stale response captured before a newer queued start/terminal cannot overwrite the newer accepted run or graph.
- Treat COMPLETED, FAILED, and CANCELLED delegated/task lifecycle as terminal and immutable for the same task/run. Reject later WAITING/RUNNING/RECOVERING and equal-revision conflicting terminal statuses. Apply a genuinely newer exact task/run only when its identity and source revision establish a new lifecycle.
- Advance `terminalMessageCursor` with compare-and-set semantics. A fetched page applies only if the current cursor still equals the cursor used for that fetch; stale concurrent pages cannot move it backward or reset it.
- Preserve exact terminal replay/output dedup, accepted predecessor, environment identity, and restart consistency.

## Done when

- Accepted-vs-reservation/tombstone conflicts in message, predecessor, or terminal status fail closed regardless of caller-supplied message.
- Terminal event/response first, then delayed WAITING/RUNNING response leaves terminal state and output unchanged.
- Stale background A response read before queued B start/terminal but committed afterward cannot replace B; success, failure, and waiting variants remain monotonic.
- Delayed/equal task WAITING or conflicting terminal updates cannot regress terminal child state; restart stays terminal.
- Two overlapping terminal recovery pages commit at most the page whose expected cursor is current; durable cursor never moves backward and terminal output remains deduplicated.
- Existing App, controller, SessionStore, graph, delegated/background, response-loss, persistence-failure, history/cursor, checkpoint, restart, terminal-output, environment, and lifecycle focused files remain green.

## Depends on

None.
