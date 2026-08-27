# Capture completed model usage before cancellation

## Failed behavior

When cancellation arrives after a provider response completes but before
`RuntimeIO` extracts its usage, the run reports one model call but drops the
response's tokens and cost. The provider work has already occurred, so the
canceled result understates completed activity.

## Affected work

[Preserve completed model telemetry when a run is canceled](07-preserve-cancellation-telemetry.md),
change `9945c848c..eca1b7369`, and the post-response cancellation boundary in
`src/engine/RuntimeIO.ts`.

## Repair requirements

Capture safe usage and economics evidence from a completed provider response
before honoring cancellation. Cancellation must still prevent response
consumption, later model work, and tool execution.

## Done when

- Cancellation immediately after a completed provider response preserves its
  available token and priced-cost fields.
- A deterministic no-provider regression test covers the race.
- Cancellation still stops response consumption and later work.

## Depends on

None.
