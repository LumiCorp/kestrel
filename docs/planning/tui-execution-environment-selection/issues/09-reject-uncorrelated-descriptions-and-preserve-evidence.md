# Reject uncorrelated descriptions and preserve evidence

## Failed behavior

Issue 08 rejects the first wrong-session `session.described` response before listener delivery, but a late duplicate or unsolicited description with no live pending request is still published to TUI listeners and can mutate conversation/session state. The same repair preserves stable environment failure codes but maps them into a TUI error that drops structured thread, bundle, session, and raw-identity details.

This leaves a correlation bypass after rejection and removes the exact evidence operators need to diagnose a durable identity conflict.

## Affected flow

This repairs [Preserve environment consistency through protocol correlation](08-preserve-environment-consistency-through-protocol-correlation.md) as implemented by commit `5b328da22`.

`ProtocolClient` applies the session-ID guard only when a pending request exists, then publishes events before its later no-pending return. `TuiRunController` consumes any published `session.described` operator view. `readTuiEnvironmentIdentityFailure` constructs a new error with code and message only, discarding the `details` retained by CommandRouter and ProtocolClient.

The owning repair surfaces are ProtocolClient command-response publication policy and structured TUI environment errors/diagnostics.

## Repair requirements

- Never publish a `session.described` command response to listeners unless it matches one live pending `session.describe` request for the same command and session.
- Drop late duplicates and unsolicited `session.described` events without store, UI, conversation-view, focused-thread, wait, transcript, or pending-request mutation.
- Preserve structured environment failure details through TUI error mapping, including exact session, thread, bundle, and raw identity evidence when supplied.
- Include preserved details in ordinary-turn diagnostics and keep them available to session-switch callers.
- Preserve unrelated runner event streaming and valid correlated describe delivery.

## Done when

- A wrong-session response followed by a late correct or duplicate response causes zero listener-visible mutation after rejection.
- An unsolicited description with or without a command ID is not published to TUI consumers.
- Conflict and unsupported failures retain their structured details through both TUI paths and ordinary-turn diagnostics.
- Focused regressions cover late duplicate, unsolicited response, valid correlated response, and structured detail preservation.
- Complete-flow validation proves issue 08 without regressing unrelated streaming.

## Depends on

None.
