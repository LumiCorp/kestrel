# Recover queued receipts after terminal pg-boss jobs

## Useful outcome

A queued Delivery Receipt always receives another recoverable hydration attempt after its prior pg-boss job becomes terminal, while one broken receipt can never stop unrelated worker maintenance.

## Failed behavior

Issue 03 uses the receipt ID as the pg-boss job primary ID. pg-boss retains completed and failed IDs, while maintenance treats only `active`, `created`, and `retry` as live. If a job exhausts while the receipt is still `queued`, maintenance attempts to insert the same retained ID, receives no job, throws, and repeats forever. Because receipt recovery runs first in shared worker maintenance, that exception also skips schedule, turn, and push reconciliation.

## Affected work

This repairs [Accept signed Resend deliveries durably](03-accept-signed-resend-deliveries.md) in change `1dca25008..65a832172`, specifically the receipt queue dispatch and shared maintenance sequencing in `apps/web/lib/turns/queue.ts`.

## Repair requirements

- Keep the Delivery Receipt row as durable dispatch intent and the receipt ID as the singleton grouping key, but do not make a retained terminal pg-boss primary ID permanently block a new attempt.
- Preserve one nonterminal receipt job at a time under concurrent ingress and maintenance. A new attempt after a terminal job may have a new queue identity, but it must remain bound to the same receipt and must not create another receipt, Thread, or turn.
- Re-read the durable receipt state before retrying. Never requeue `hydrating`, `admitted`, `materialized`, `rejected`, or `failed` receipts.
- Isolate receipt-recovery failures so schedule dispatch, durable-turn reconciliation, and mobile-push maintenance still run. Preserve the original receipt error as redacted operational evidence.
- Do not delete job evidence merely to make an insert succeed unless the existing pg-boss lifecycle contract explicitly owns that deletion and its audit consequence.

## Done when

- A failed or completed queue job paired with a still-queued receipt produces exactly one new nonterminal attempt.
- Repeated and concurrent maintenance converge on one live job, including after worker restart and an uncertain send result.
- A terminal Delivery Receipt produces no new job even if an old queue job is terminal.
- A simulated receipt queue or database failure does not prevent schedule, turn, and push maintenance from executing.
- Focused PostgreSQL terminal-job, concurrency, restart, maintenance-isolation, and durable-state tests pass.
- `pnpm validate` and `pnpm validate:postgres` pass.

## Depends on

None.
