# Reconcile TUI lifecycle from exact runtime evidence

## Failed behavior

Repair issue 05 moved the foreground and background start boundary away from profile resolution, but some paths still infer acceptance from a terminal response, any later terminal event in the session, or an immediate best-effort describe. Those signals are not necessarily evidence for the submitted message or run.

As a result, accepted background work can remain `PENDING` after a TUI restart, a temporarily unavailable describe can record a false launch failure before a delayed `run.started`, a duplicate terminal event from an older run can falsely confirm a new foreground submission, assembly-only recovery can produce `started:true` with `PENDING`, and a real pre-acceptance `run.failed` response can falsely make a new session immutable.

## Affected flow

This repairs [Bind TUI start state to authoritative runtime acceptance](05-bind-start-state-to-authoritative-runtime-acceptance.md) as implemented by commit `b77f43a9e`.

Background launch persists a pending child and relies on live `run.started` or terminal callbacks in the launching process. Startup does not reconcile persisted pending children from durable runtime state. The response-loss catch can persist failure when describe is temporarily unavailable and does not clear that failure if acceptance arrives later. Assembly-only description establishes that execution exists without establishing a truthful delegation status.

Foreground recovery uses a per-session terminal counter rather than matching the submitted message, command, or run. A delayed terminal event for an older run can therefore be mistaken for acceptance of the current submission. Both foreground and background code can also treat a synthetic `run.failed` response as accepted execution even when the runner failed before reserving a run or emitting `run.started`.

The owning repair surface is exact runtime acceptance and lifecycle reconciliation across runner events, durable description, startup recovery, and TUI session persistence.

## Repair requirements

- Reconcile every persisted pending background child from durable runtime state after TUI restart, not only the active session and not only live callbacks in the launching process.
- Match foreground acceptance and terminal recovery to exact delivery identity: submitted message route, command, or run. Do not use an unrelated per-session terminal event as proof.
- Distinguish a runner failure emitted before `run.started` from a terminal result for an accepted run. A genuine pre-acceptance `run.failed` must leave foreground and background sessions failed and unstarted with no started history.
- Do not persist a launch failure merely because the first response-loss describe is unavailable or has not observed the accepted runtime yet. Preserve a truthful recoverable state until exact durable evidence resolves it.
- When delayed exact acceptance follows an earlier provisional failure, reconcile status, `lastRunStatus`, error fields, and history without retaining contradictory failure evidence.
- When durable thread or assembly evidence proves that a background child started but runtime status is not yet available, use an explicit truthful recoverable state rather than `started:true` with `PENDING` or a guessed terminal status.
- Preserve idempotence under duplicate `run.started`, terminal, describe, and startup-reconciliation delivery.
- Preserve exact environment identity, assembly immutability, deterministic replay, and foreground/background result recovery.
- Do not infer acceptance from labels, timestamps, cached runtime order, session-level event counts, or response shape alone.

## Done when

- An accepted background run survives TUI termination before event persistence and is reconciled correctly on restart.
- A temporarily unavailable describe followed by delayed exact `run.started` produces one truthful running state with no stale failure fields or contradictory history.
- A delayed duplicate terminal event from an older run cannot confirm or complete a new submission.
- Assembly-only durable recovery cannot leave a started background child in `PENDING`.
- A real runner `run.failed` emitted before `run.started` leaves both foreground and background sessions unstarted and does not emit started history.
- Duplicate live and restart reconciliation events are idempotent.
- Focused regression checks cover restart, late acceptance, stale terminal delivery, assembly-only recovery, and pre-acceptance protocol failure.
- Complete-flow validation proves issues 01, 03, and 05 without weakening environment immutability.

## Depends on

- [Make session describe durable and environment-authoritative](04-make-session-describe-durable-and-environment-authoritative.md)
