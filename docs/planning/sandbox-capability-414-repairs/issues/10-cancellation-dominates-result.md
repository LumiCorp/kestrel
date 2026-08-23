# Let cancellation dominate pre-cleanup result persistence

## Failed behavior

Docker can compute a successful output, then observe cancellation before teardown. It classifies the lifecycle as cancelled but still passes the completed output to the durable result sink, allowing a DONE effect result to coexist with cancelled lease evidence and replay as success.

## Affected work

GitHub issue #414, commit `47bb28d42`, Docker teardown classification, `CodeExecutionService` pre-cleanup persistence, and cancellation replay evidence.

## Repair requirements

Cancellation must dominate any output not already durably committed. Once teardown is classified cancelled, the exact-result sink must neither persist nor deliver the computed output. Recheck cancellation at the durable callback boundary so an abort cannot race persistence into a contradictory DONE result.

## Done when

- Abort after output construction but before teardown produces no DONE effect result.
- The lease records cancelled then cleaned as its sole outcome.
- Neither unused nor provider-used capability paths can replay the late output.
- Deterministic tests cover the race and prove zero exact-result saves.

## Depends on

06 and 08.
