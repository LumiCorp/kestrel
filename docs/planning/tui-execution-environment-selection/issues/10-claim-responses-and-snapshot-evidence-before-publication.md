# Claim responses and snapshot evidence before publication

## Failed behavior

Issue 09 filters sequential duplicate and unsolicited descriptions, but a valid command response remains pending while listeners run. A reentrant transport delivery during that listener window can publish a second description or reject the already-consumed command. Command-scoped environment error details are likewise exposed to mutable listeners before the rejected error captures them, and TUI mapping retains the same object by reference.

The result violates one-response correlation and allows exact diagnostic evidence to change before it reaches the TUI.

## Affected flow

This repairs [Reject uncorrelated descriptions and preserve evidence](09-reject-uncorrelated-descriptions-and-preserve-evidence.md) as implemented by commit `57b941c38`.

`ProtocolClient.onLine` publishes listeners before deleting a pending expected response. It also constructs a rejected runner error from `event.payload.details` only after listener publication. `readTuiEnvironmentIdentityFailure` carries the details object without an immutable snapshot.

The owning repair surface is ProtocolClient response claiming/evidence snapshot order plus TUI structured-detail copying.

## Repair requirements

- Atomically claim a valid correlated `session.described` response before any listener runs, so reentrant duplicates or mismatches cannot publish or alter the claimed request.
- Snapshot command-scoped environment failure details before listener publication and reject with that stable snapshot.
- TUI environment error mapping must retain an isolated JSON-safe snapshot rather than an alias to listener-owned data.
- Preserve valid listener delivery, promise resolution/rejection, unrelated event streaming, and command cleanup semantics.

## Done when

- A listener that synchronously injects a duplicate or mismatched describe response observes exactly one valid description and cannot change the claimed command outcome.
- A listener that mutates command-error details cannot alter the rejected error, TUI error, or ordinary-turn diagnostics.
- Structured detail snapshots remain serializable and preserve exact session/thread/bundle/raw-identity evidence.
- Focused regressions cover reentrant duplicate/mismatch and listener mutation of nested details.
- Complete-flow validation proves issue 09 without regressing protocol delivery.

## Depends on

None.
