# Preserve environment consistency through protocol correlation

## Failed behavior

Repair issue 07 detects supported thread-versus-bundle environment conflicts, but the complete protocol path still weakens that evidence. A present unsupported bundle identity is treated as if it were absent. The stable runtime consistency code is flattened into generic runner and TUI unknown errors. A wrong-session describe response can be published to listeners and mutate TUI projection state before the awaiting command validates its session ID.

The result fails closed in some cases but not with the required exact identity semantics: corrupt or future evidence can be ignored, diagnostics lose the owning consistency failure, and a rejected response can have side effects before correlation.

## Affected flow

This repairs [Make durable describe strictly read-only and deterministic](07-make-durable-describe-strictly-read-only-and-deterministic.md) as implemented by commit `9b882f63c`.

`readAssemblyEnvironmentPresetId` currently maps both absent and present unsupported values to `undefined`. `CommandRouter` preserves only one economics failure code and maps environment consistency failures to `RUNNER_RUNTIME_ERROR`; TUI catch paths then map them to `TUI_ENVIRONMENT_UNKNOWN`. `ProtocolClient` publishes command responses to event listeners before resolving the pending command, so `TuiRunController` can install a wrong-session operator view before its local response check executes.

The owning repair surfaces are exact environment evidence parsing, runner error preservation, TUI error mapping, and protocol command-response correlation ordering or filtering.

## Repair requirements

- Distinguish absent legacy bundle identity from a present unsupported identity. Absent evidence may fall back to another exact source; present unsupported evidence must fail closed with a stable error.
- Preserve stable environment identity conflict and unsupported codes from durable projection through RunnerHost, CommandRouter, ProtocolClient, session switching, and ordinary-turn diagnostics.
- Correlate `session.described` to the requested session before any listener, store, UI, focused-thread, wait, or conversation projection consumes it.
- A wrong-session command response must be rejected with zero session or UI mutation, even when it contains an `operatorThreadView` for the active session.
- Preserve ordinary runner event streaming and command response delivery semantics for unrelated event types.
- Preserve read-only describe behavior, exact assembly ordering, environment immutability, and existing conflict handling.

## Done when

- Present unsupported bundle environment metadata cannot resume a started session and returns a stable unsupported-identity code.
- Supported thread/bundle disagreement keeps its stable consistency code across the complete runner protocol and both TUI consumers.
- A wrong-session describe response carrying a plausible operator view causes no listener-visible or persisted mutation before rejection.
- Focused end-to-end protocol regressions cover conflict, unsupported evidence, and wrong-session correlation.
- Complete-flow validation proves issues 04 and 07 without regressing other runner events.

## Depends on

None.
