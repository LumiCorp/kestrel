# Preserve cancellation telemetry through persistence retry

## Failed behavior

If the first terminal persistence attempt fails after cancellation telemetry
has been captured, the worker catch path replaces the telemetry-bearing
assistant message with a zero-usage failure presentation. The retry can then
terminalize the turn without durable usage evidence or authoritative metering.

## Affected work

[Preserve completed model telemetry when a run is canceled](07-preserve-cancellation-telemetry.md),
change `9945c848c..eca1b7369`, and terminal completion recovery in
`apps/web/lib/turns/process-runtime.ts`.

## Repair requirements

Preserve the already captured terminal messages and telemetry across a
transient completion failure. Retry, replay, and duplicate terminal handling
must still create one terminal result and meter each durable message once.

## Done when

- A one-shot terminal persistence failure retains the original cancellation
  telemetry after recovery.
- Focused worker, durable persistence, and usage-metering tests prove one
  terminal result and one charge across retry and replay.
- Pre-runtime failures continue to use the existing zero-usage presentation.

## Depends on

None.
