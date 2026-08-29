# Serialize session-file authority

## Failed behavior

Issue 26 privately commits queued session mutations, but the durable store is one whole sessions file. A later ordinary save for another session can therefore write a stale snapshot over a successful queue commit. Delegated queued lifecycles still bypass the queue transaction and exact terminal authority, direct and response-loss terminal paths do not consistently require correlated turns, result-less pre-accept failures can promote, and describe fallback can fabricate a predecessor across explicit queue epochs.

## Affected flow

This repairs [Unify durable queue publication](26-unify-durable-queue-publication.md) as implemented by commit `f191b58a8`.

The owning repair is a global sessions-file commit coordinator layered with the existing same-session queue transaction. Snapshot capture, durable save, and shared publication must be ordered against every App sessions-file save.

## Repair requirements

- Serialize every App sessions-file save and queue commit through one global coordinator. Capture the snapshot only when the global turn is owned, from the latest shared state plus the intended mutation. A later session-B save cannot contain stale session-A authority or overwrite a committed A snapshot.
- Preserve same-session queue serialization inside the global coordinator. Merge unrelated in-memory session changes without clobbering them after save, and never publish a private snapshot before durable success.
- Route delegated/background queued start and completed/failed/cancelled lifecycles through the same queue transaction and exact terminal-turn authority as foreground sessions. Inactive presentation stays inactive, but durability and ownership rules are identical.
- Require a unique exact terminal turn for direct queued completed/failed/cancelled responses and applied-response-lost recovery. Correlate session, thread, run, source message, terminal status, and sequence; query authoritative thread state when the response view is absent. Active/RUNNING-only, mismatched, or duplicate correlation remains fail-closed.
- A result-less queued `run.failed` response is not runtime acceptance. Pre-accept rejection with the reserved run id must remove/rewire pending evidence without replacing the current accepted run or emitting terminal output.
- Describe/startup fallback cannot borrow an active candidate's predecessor for an accepted run. If durable accepted predecessor authority explicitly conflicts with active evidence, preserve the conflict and fail closed. Legacy absence may be repaired only from complete exact ordering evidence.
- Preserve terminal replay recovery, queue epochs, event-id output dedup, exact environment identity, and backward-compatible session reading.

## Done when

- A deferred successful queue commit for A interleaved with an ordinary save/update for B persists and publishes a final file containing both A and B; restart loses neither.
- Before-write and applied-then-thrown variants across A/B publish no false A authority and remain reconcilable.
- Delegated queued start and terminal matrices require durable commit and exact terminal turns; unavailable/RUNNING-only authority and save failure publish no accepted state/output.
- Direct queued terminal responses and response-loss recovery reject missing, wrong-message, wrong-thread/session, duplicate-sequence, and RUNNING-only views; exact replay succeeds once.
- Result-less exact queued pre-accept failure preserves the prior accepted run and rewires/removes the rejected reservation.
- Explicit accepted-predecessor versus active-predecessor conflict remains unbound during describe/restart and blocks successor promotion.
- Existing App, controller, SessionStore, graph, background/delegated, persistence-failure, restart, terminal-output, checkpoint, environment, and lifecycle focused files remain green.

## Depends on

None.
