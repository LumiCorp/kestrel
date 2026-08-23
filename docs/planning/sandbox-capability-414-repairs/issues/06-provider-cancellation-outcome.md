# Preserve cancellation outcome during provider invocation

## Failed behavior

Cancellation during a provider call is first recorded as generic provider failure and revocation. Later teardown cannot replace the terminal outcome, so durable operator evidence reports failure rather than cancellation.

## Affected work

GitHub issue #414, commit `b974371d8`, Docker provider-pump error classification, and coordinator lifecycle settlement.

## Repair requirements

Classify cancellation and timeout before generic provider failure. A late provider result must not overwrite the terminal outcome or reach the workload.

## Done when

- Cancellation during the first provider operation records cancelled and then cleaned.
- Timeout records the approved explicit timeout outcome and then cleaned.
- Late provider completion is ignored.

## Depends on

None.

