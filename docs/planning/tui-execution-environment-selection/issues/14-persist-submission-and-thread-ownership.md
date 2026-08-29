# Persist submission and thread ownership

## Failed behavior

Issue 13 repairs static retained-run and wrong-thread cases, but the ownership proof is still process-local and tied to mutable UI focus.

After restart, the in-memory run-to-message ledger is empty, so an older run can claim a new exact pending message. While a run is active, focusing another thread changes the field used to validate terminal events, causing a legitimate terminal from the accepted thread to be rejected and a malformed terminal from the newly focused thread to be accepted.

## Affected flow

This repairs [Finish exact reply and terminal ownership](13-finish-exact-reply-and-terminal-ownership.md) as implemented by commit `b00d69009`.

Fresh foreground submissions persist message and thread identity but do not reserve a run ID, even though the runtime turn contract accepts a caller-owned run ID. Accepted run thread ownership is reconstructed from `focusedThreadId`, which is navigation state rather than immutable lifecycle evidence.

The owning repair surface is caller-owned foreground run reservation plus persisted accepted-run thread identity.

## Repair requirements

- Reserve and persist one exact foreground run ID before dispatch, pass it through `turn.runId`, and require every routed, started, direct terminal, recovered, and queued-promotion path to agree with that reservation before lifecycle mutation.
- Keep pending run, request, message, and thread identities in their separate domains. Clear them only on exact acceptance or authoritative rejection.
- Persist `acceptedRunThreadId` with every accepted run and replace it only when a new exact run is accepted. Do not derive accepted-run ownership from mutable `focusedThreadId`.
- Validate live completed, failed, and cancelled events against `acceptedRunThreadId` before history, projection, lifecycle, or refresh mutation.
- Preserve focus navigation while a run is active without changing terminal ownership.
- Rehydrate both pending run reservation and accepted thread ownership across restart, without exposing raw IDs in ordinary TUI output.
- Preserve reply/resume recovery, queued promotion, pre-accept failure handling, monotonic terminal behavior, environment/assembly identity, and deterministic replay.

## Done when

- After restart, an older run A cannot claim new message B after intervening run C because B has its own durable reserved run identity.
- A legitimate terminal from accepted thread A still completes the run after focus moves to thread B, while a terminal for the same run labeled thread B is rejected.
- New, queued, reply/resume, direct terminal, and response-loss flows preserve exact run/message/request/thread domains.
- Session persistence round-trips accepted-run thread identity and raw ownership IDs remain absent from normal output.
- Focused regressions cover restart A/C/B, focus drift, missing/mismatched reserved run identity, queued promotion, and pre-accept failure.
- Full affected unit files pass and complete-flow validation proves issue 13.

## Depends on

None.
