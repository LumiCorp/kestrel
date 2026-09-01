# Make the thread interaction the approval decision owner

## Useful outcome

Users and operators see one truthful approval lifecycle from the human decision
through provider consumption and external effect outcome. A provider ledger,
queue row, or continuation startup can no longer independently claim that an
approval succeeded.

## What changes

Make `thread_interactions` the canonical hosted human-decision record for new
approval versions. It must own pending, declined, approved, expired, failed,
and terminal effect projection. Runtime interaction state owns the suspended
prepared invocation. Queue and execution rows remain transport and execution
records.

Reduce `app_operation_approvals` to the provider capability duties that must
remain durable: encrypted provider payload, connection and resource binding,
expiry, redaction, availability, atomic one-time consumption, and linkage to
the canonical interaction. Stop writing independent pending, approved, and
denied human-decision transitions for new-version interactions.

Keep encrypted provider payload in `app_operation_approvals`. Redact it in
place through the persisted expiry transition. Do not add a separate encrypted
payload table or move provider payload into `thread_interactions`.

Keep mixed-version behavior explicit. Old app-operation rows may retain their
old lifecycle while old interactions remain processable. New rows must derive
human decision from the canonical interaction and must not create a competing
decision owner.

Make expiry a persisted transition that blocks provider execution and redacts
sensitive payload. Keep consume-before-provider atomicity and idempotency.
Project denial, execution failure, committed effect, and unknown effect into
the user-facing interaction without inferring them from queue or run status.

Keep `recordDurableRuntimeStarted` as telemetry, but remove its authority to
resolve an interaction or clear failure and effect evidence for the new
version. Preserve machine-readable outcome and retryability evidence for
support and operations.

## Requirements and delivery context

The canonical requirements are in the [Hosted Approval Simplification Product Brief](../../hosted-approval-simplification-product-brief.md).

Build on the exact execution and outcome path from
[issue 02](02-resume-prepared-invocation.md). Current ownership is split across
`thread_interactions` and `app_operation_approvals` in
`apps/web/drizzle/schema.ts`, `resolveDurableRuntimeInteraction` and
`recordDurableRuntimeStarted` in `apps/web/lib/turns/store.ts`, worker handling
in `apps/web/lib/turns/process-runtime.ts`, and provider consumption in
`apps/web/lib/apps/app-operation-approvals.ts` and the runtime app routes.

Use `apps/web/lib/turns/interaction-projection.ts` and
`apps/web/lib/turns/outcome-invariant.ts` as the user-facing and integrity
boundaries. Preserve provider payload confidentiality, exact external binding,
one-time consumption, and old-version compatibility. Do not collapse provider
payload storage into the human-decision row.

This issue owns the final transaction boundary before remembered approval is
activated. Issue 03 may add its atomic remembered write only after this
canonical decision path is complete.

## Done when

- One new-version `thread_interactions` decision controls approval state across
  Web, worker, runtime, and provider consumption.
- New app-operation rows retain payload, resource, expiry, redaction, and
  consumption state without owning pending, approved, or denied decisions.
- Decision recording and any linked provider availability update are atomic and
  idempotent.
- Expiry blocks execution and redacts sensitive provider payload through a
  persisted transition.
- Continuation startup cannot resolve the interaction or erase failure and
  effect evidence.
- User and operator projections distinguish declined, expired, failed before
  effect, committed, and unknown effect states.
- Old-version rows remain readable and processable only through their explicit
  compatibility path.
- Focused PostgreSQL transaction, provider consumption, expiry/redaction,
  projection, idempotency, and outcome-invariant tests pass.
- `pnpm validate`, `pnpm validate:postgres`, and `pnpm validate:process` pass.

## Depends on

- [Resume the exact prepared invocation after approval](02-resume-prepared-invocation.md)
