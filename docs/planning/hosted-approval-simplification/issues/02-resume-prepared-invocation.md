# Resume the exact prepared invocation after approval

## Useful outcome

A user can decline or approve one hosted tool invocation and trust that Kestrel
will either stop or execute the exact command shown for approval. Normal grant,
lease, run, or worker rotation no longer invalidates an otherwise valid
approval.

This is the execution-switch slice. New-version approvals stop reconstructing
the tool call after the wait. Old-version approvals remain on their explicit
compatibility path until they drain.

## What changes

Route new-version Decline and Approve Once decisions through the canonical Web
interaction transaction. Carry the authenticated deciding actor separately
from the requesting actor through Web, queue, worker, and runtime. Enforce the
current same-actor rule at the response boundary and again before execution.

On Approve Once, load the persisted `PreparedToolCallV1`. Do not resolve a new
tool surface or prepare another call. Reacquire the continuation run segment,
MCP and project-context grants, workspace lease, source-write grants, provider
execution ticket, and live handler capability. Validate each credential
against the prepared invocation's stable authority before execution.

Build the user-visible approval request from that same persisted prepared call.
The displayed request, submitted decision, external binding, and consuming
execution must carry one request ID, prepared invocation ID, stable tool
identity, normalized action, payload hash, actor, organization, project,
Environment, thread, and approval-authority revision. Do not project the card
from separate reconstructible metadata.

Static tools must execute through their stable descriptor and prepared
activation. Dynamic tools must deterministically rebind the stable descriptor
identity after worker or registry restart. If a provider cannot rebind, fail
closed and require a fresh invocation and approval. An in-memory pinned handler
must not become durable approval identity.

Drive the new interaction's terminal execution projection from
`ToolExecutionOutcomeV1`. Starting a continuation run must not mark approval
execution successful or erase failure and effect evidence. Retry is allowed
only when the effect is proven `not_started`; `started`, `committed`, and
`unknown` are not safe to repeat.

Keep the current card presentation compatible during this slice. Existing
boolean submissions may map to versioned Decline or Approve Once only through
the old compatibility parser. The three-choice remembered experience belongs
to the next issue.

## Requirements and delivery context

The canonical requirements are in the [Hosted Approval Simplification Product Brief](../../hosted-approval-simplification-product-brief.md).

The prepared contracts and durable state from [issue 01](01-persist-prepared-invocation.md)
are authoritative. Relevant execution seams include `src/engine/ExecutionEngine.ts`,
`src/effects/EffectRunner.ts`, `src/effects/handlers/executeToolCall.ts`,
`tools/runtime/UnifiedToolRegistry.ts`, `src/orchestration/InteractionManager.ts`,
`src/orchestration/ThreadRuntime.ts`, and `cli/runtime/KestrelChatRuntime.ts`.

The hosted decision and actor path runs through
`apps/web/app/api/threads/[id]/route.ts`, `apps/web/lib/turns/store.ts`,
`apps/web/lib/turns/process-runtime.ts`, and the Mobile interaction routes.
Preserve idempotency, exact normalization, consume-before-provider behavior,
generic `resumeBlockedRun`, generic `resumeRequestId`, and live-run handler
pinning.

Do not classify renewable fields with omission rules or add another
`blockedToolScope` variant. A downstream credential rejection is not permission
to move approval authority into that credential boundary.

## Done when

- Decline records the authenticated actor's denial and never executes the
  prepared call.
- Approve Once executes the persisted prepared call without resolving or
  preparing a replacement call.
- A browser-to-runtime proof compares the displayed request, persisted prepared
  call, submitted decision, external binding, and consuming execution and shows
  that every exact-action identity field matches.
- A different authenticated project member cannot approve or execute the
  requesting user's invocation.
- MCP grant, project-context grant, workspace lease, source-write grant, run,
  worker, and registry rotation preserve valid stable authority and execute the
  same approved action.
- Changed stable authority, expired approval, unavailable access, or
  unrebindable dynamic provider fails closed before an external effect.
- Interaction status follows `ToolExecutionOutcomeV1`; continuation startup is
  not reported as execution success, and unknown effects are not retried.
- Existing old-version interactions still finish or expire through their
  original path without silent conversion.
- Focused engine, registry, actor, credential-rotation, restart, expiry,
  outcome, and hosted integration tests pass.
- `pnpm validate`, `pnpm validate:process`, and applicable PostgreSQL tests
  pass.

## Depends on

- [Persist the exact tool invocation before approval](01-persist-prepared-invocation.md)
