# Make TUI lifecycle reconciliation monotonic and exact

## Failed behavior

Issue 06 adds exact foreground acceptance evidence and restart reconciliation, but several remaining paths still treat non-authoritative evidence as final or allow older evidence to overwrite newer lifecycle state.

A coded transport failure can be mistaken for an authoritative pre-acceptance rejection. Delayed exact foreground acceptance is remembered in memory without updating the persisted session. Background callbacks discard run identity, so delayed starts, stale terminal events, and stale describe responses can regress or complete the wrong lifecycle. Describe reconciliation also persists assembly identity and lifecycle state in separate writes, creating a durable `started:true` plus `PENDING` crash window. Finally, otherwise correlated responses are not cross-checked against the requested session and thread.

## Affected flow

This repairs [Reconcile TUI lifecycle from exact runtime evidence](06-reconcile-tui-lifecycle-from-exact-runtime-evidence.md) as implemented by commit `b5e5f5ddc`.

Foreground submission recovery classifies any thrown error with a string `code` as rejection, even though socket and remote transports intentionally attach codes such as `ECONNRESET`, `EPIPE`, or `RUNNER_TRANSPORT_ERROR`. A delayed exact `run.started` updates transient run tracking but does not make the session durably started or clear provisional recovery UI.

Background launch and event callbacks identify only the child session, not the accepted run. Description reconciliation saves identity before lifecycle and unconditionally maps assembly-only evidence to `RECOVERING`, even when newer live evidence has already established `RUNNING` or a terminal state. Routed and terminal responses validate command correlation but do not consistently validate their embedded session and thread identities against the submitted request.

The owning repair surface is TUI acceptance classification, exact run ownership, atomic monotonic session reconciliation, and response identity validation.

## Repair requirements

- Classify only explicit runtime rejection evidence as pre-acceptance failure. Treat transport codes, connection failures, response loss, timeout, close, and temporarily unavailable describe as recoverable uncertainty.
- When delayed exact `run.started` matches the submitted foreground message, durably mark that session started, preserve the exact run/message identity needed for later terminal ownership, clear provisional failure/recovery fields, update the visible running state, and persist once idempotently.
- Carry expected child session and accepted run identity through every background progress and terminal callback. Ignore stale starts, progress, and terminal events that do not own the current lifecycle.
- Make lifecycle transitions monotonic: terminal states cannot regress to running or recovering, running cannot regress to assembly-only recovering, and duplicate exact evidence is idempotent.
- Apply environment, assembly, thread, started, delegation status, last-run status, and failure-field reconciliation as one durable session transition so no save can expose `started:true` with `PENDING`.
- Cross-check routed foreground responses against the submitted session, requested thread, returned thread, view thread, and message identity before any session mutation.
- Cross-check background terminal output against the expected child session and accepted run before any session mutation.
- Preserve exact environment and assembly identity, terminal recovery, deterministic replay, and user-visible truthful recovery state.

## Done when

- Coded transport response loss followed by unavailable describe remains recoverable, including after restart, and later exact acceptance produces no contradictory failure history.
- Delayed exact foreground acceptance after the response-loss catch produces one durable started/running state and clears `RUN_ACCEPTANCE_UNCONFIRMED` without duplicate started history.
- A delayed duplicate `run.started` cannot regress a completed child, and a stale terminal for run A cannot complete or fail active run B.
- A stale assembly-only describe cannot regress newer live or terminal evidence, and a crash-visible persisted state can never be `started:true` with delegation `PENDING`.
- A correctly correlated response with mismatched session, thread, view, or output identity fails closed without mutating either session.
- Focused regressions cover coded transport failures, delayed foreground acceptance, stale start/terminal/describe ordering, atomic persistence, and cross-session response mismatch.
- Complete-flow validation proves issue 06 without weakening environment immutability or lifecycle recovery.

## Depends on

None.
