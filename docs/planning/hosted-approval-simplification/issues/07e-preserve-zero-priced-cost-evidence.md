# Preserve zero-dollar priced cost evidence

## Failed behavior

A successfully priced zero-dollar model call is accepted by the accumulator
but omitted from terminal telemetry. The result is indistinguishable from an
unpriced call even though exact cost evidence was available.

## Affected work

[Preserve completed model telemetry when a run is canceled](07-preserve-cancellation-telemetry.md),
change `9945c848c..eca1b7369`, and cost accumulation in
`src/engine/Guardrails.ts`.

## Repair requirements

Preserve whether priced-cost evidence exists independently of its numeric sum.
Do not infer zero cost for unpriced calls or weaken existing economics
admission behavior.

## Done when

- A priced zero-dollar call emits `pricedCostUsd: 0`.
- An unpriced call does not fabricate priced-cost evidence.
- Mixed and repeated calls retain truthful available evidence in focused tests.

## Depends on

None.
