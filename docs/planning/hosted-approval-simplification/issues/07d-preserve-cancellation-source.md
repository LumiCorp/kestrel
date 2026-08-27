# Preserve the cancellation source

## Failed behavior

Runner shutdown marks active executions for cancellation, but the resulting
terminal evidence always reports `user_requested`. Support and operators
cannot distinguish a user stop from lifecycle shutdown.

## Affected work

[Preserve completed model telemetry when a run is canceled](07-preserve-cancellation-telemetry.md),
change `9945c848c..eca1b7369`, and active-run cancellation state in
`cli/runner/RunnerHost.ts`.

## Repair requirements

Carry the actual cancellation source into the terminal result without changing
the existing cancellation authority or shutdown behavior. Keep the value
bounded and explicit.

## Done when

- User cancellation reports a user-requested reason.
- Runner shutdown cancellation reports its lifecycle source.
- Focused tests cover both paths without changing terminal ownership.

## Depends on

None.
