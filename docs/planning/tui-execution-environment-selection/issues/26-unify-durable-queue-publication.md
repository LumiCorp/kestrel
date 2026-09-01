# Unify durable queue publication

## Failed behavior

Issue 25 added required saves to event synchronizers, but queued command responses and describe recovery still mutate and publish through non-required saves. The required-save helper itself exposes a staged shared object while persistence is pending. Terminal correlation can still be bypassed for a direct successor, replay dedup can suppress missing output, full-sequence repair can cross queue epochs, and a missing predecessor can be treated as direct-successor proof.

## Affected flow

This repairs [Commit queue authority before publication](25-commit-queue-authority-before-publication.md) as implemented by commit `5d1adac4e`.

The owning repair is one per-session durable mutation transaction used by queued routed/direct responses, start/terminal events, response-loss recovery, and live/startup describe reconciliation.

## Repair requirements

- Build queue-authority mutations in a private session/file snapshot. Do not assign staged authority to shared `sessionsFile`, UI state, caches, history, or output while the required save is pending.
- Serialize every same-session queue-authority mutation through one transaction. After a successful required save, publish the committed snapshot without clobbering later unrelated/session changes. On true failure or applied-but-response-lost failure, return uncommitted and publish nothing; later exact reconciliation may observe either durable old or new state.
- Route queued `conversation.message.routed`, direct completed/failed/cancelled/waiting responses, event settlement, response-loss recovery, and describe/startup reconciliation through that transaction. Remove ordinary swallowed-save paths for accepted predecessor, graph, terminal recovery, and output.
- Require a uniquely correlated terminal turn for every queued terminal promotion, including an immediately reachable first successor. Active/RUNNING-only views and event identity alone may tombstone evidence but cannot authorize terminal lifecycle/output.
- Delivery dedup may suppress repeated transport handling, but never authority reconciliation. After durable terminal commit, exact replay must recover missing terminal history/output if the terminal event id is absent; existing history/event-id evidence must keep further replays silent.
- Reconstruct sequence only within one exact queue epoch. Candidates may be chained when their persisted ancestry reaches the same exact epoch root and complete correlated turn sequence orders them. Never chain across a non-queue accepted predecessor or distinct root.
- Legacy partial-route evidence with a missing predecessor is fail-closed. Bind only when exact predecessor/ancestry or complete runtime sequence proves direct succession; absence of a record is not proof.

## Done when

- Deferred failing required save interleaved with same-session describe/session update cannot leak staged accepted authority to UI, disk publication, history, or output.
- Queued routed/direct command responses and live/startup describe recovery publish accepted predecessor, graph, and terminal output only after required durable commit; injected before-write and applied-then-thrown cases remain fail-closed and restart-reconcilable.
- A first queued successor terminal with unavailable or RUNNING-only authority cannot promote; exact correlated replay can promote and emit once.
- Crash/restart after graph commit but before output allows exact replay to restore missing terminal history/output once.
- Q1/Q2/Q3 from one queue epoch reconcile incrementally, while historical Q1->R0 and later Q2->R1 remain distinct and unchanged.
- Legacy Q3->missing-Q2 or undefined-root partial-route evidence cannot be rebound to accepted Q1 or dispatched.
- Existing App, controller, queue-graph, SessionStore, persistence-failure, restart, terminal-output, checkpoint, environment, and lifecycle focused files remain green.

## Depends on

None.
