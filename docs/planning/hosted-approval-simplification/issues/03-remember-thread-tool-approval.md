# Remember Ask First approval for the thread

## Useful outcome

When an eligible Ask First tool needs approval, the user can decline it,
approve this invocation once, or remember the tool for the rest of the thread.
Remembering stops repeated eligible prompts without changing broad policy or
weakening validation of future calls.

## What changes

Replace the optional boolean decision for new-version runtime approvals with
`decline`, `approve_once`, or `remember_approval`. Render exactly Decline,
Approve Once, and Remember Approval in Web and Mobile whenever current policy
produces an eligible Ask First decision.

Activate the dormant `RememberedToolApprovalV1` persistence and typed evidence
from issue 01. Preserve one record for the same organization, thread, actor,
and complete stable tool identity. The thread owns record lifetime through
cascading deletion. Do not add status, revocation, Forget, listing, or
user-management fields.

When the user chooses Remember Approval, the existing durable interaction
transaction must atomically record the current exact approval and the remembered
record. The current invocation still uses its exact prepared-call binding.
The remembered row must not store that payload or any renewable credential.

Inside that transaction, lock and reload the server-owned interaction and
prepared invocation. Before writing either decision, require that the
interaction is still pending and unexpired, the authenticated actor still
matches, the prepared invocation and stable tool identity are unchanged, the
thread still belongs to the current organization, project, and Environment,
the user still has access, and current policy still produces eligible Ask
First. Derive every remembered identity field from server-owned state, never
from the submitted card payload.

If any check fails, record the correct expired, blocked, stale, or unauthorized
result and create no remembered row. Replaying the same accepted decision must
return the original result without creating another row. A conflicting replay
must fail without changing the original decision.

Load matching records for the authenticated user and thread. Carry a typed,
versioned projection into runtime. The shared resolver must evaluate current
Environment and Project policy, stricter restrictions, actor access, and the
newly prepared call's `StableToolApprovalIdentityV1` before it changes eligible
Ask First to automatic-for-thread.

Automatic remains automatic. Blocked, disabled capability, subject
restriction, tool-minimum approval, explicit runtime strictness, and missing
actor access remain stricter than remembered evidence. A new thread, different
user, different tool, descriptor revision, or approval-authority revision must
not match.

Remove the approval card's `Always Approve` action, `alwaysApprovalAction`,
`environmentAppsHref`, and the Environment Apps approval-return and
auto-approve flow. Keep Environment Apps as the independent place for
deliberate broad policy changes.

## Requirements and delivery context

The canonical requirements are in the [Hosted Approval Simplification Product Brief](../../hosted-approval-simplification-product-brief.md).

Build on the exact execution path from [issue 02](02-resume-prepared-invocation.md).
Current policy resolution begins in `src/mode/contracts.ts` and
`tools/runtime/UnifiedToolRegistry.ts`. Hosted policy evidence already crosses
`tools/contracts.ts`, protocol execution profiles, and the hosted runtime.

The atomic response seam is `resolveDurableRuntimeInteraction` in
`apps/web/lib/turns/store.ts`. Persistence lives in
`apps/web/drizzle/schema.ts` and versioned SQL migrations. Web request and card
surfaces include `apps/web/lib/chat/thread-turn-request-contract.ts`, the Thread
API route, `apps/web/lib/turns/client-contract.ts`,
`apps/web/components/chatbot/interaction-panel.tsx`, and
`apps/web/lib/apps/runtime-approval-policy.ts`. Mobile v1 and v2 interaction
routes must remain behaviorally equivalent.

Use the canonical decision ownership completed by
[issue 04](04-canonicalize-approval-lifecycle.md). Implement the remembered
behavior behind the new prepared-approval protocol version. Production
activation belongs to issue 05 after the dormant migration and compatible Web,
shared runtime, and turn-worker readers are deployed and the full hosted proof
passes.

Remember Approval lasts for the life of the thread. Do not invent a Forget
control, revocation endpoint, approval list, policy mutation, payload grant, or
cross-user sharing rule.

## Done when

- In test and preview, Web and Mobile show exactly Decline, Approve Once, and
  Remember Approval for an eligible Ask First request and submit one strict
  versioned decision. Production remains inactive until issue 05's proof and
  rollout gate passes.
- Approve Once asks again for the next eligible invocation.
- Remember Approval atomically approves the exact current invocation and stores
  one thread-lifetime user-thread-tool record.
- An expired, already-decided, blocked, stale-identity, policy-changed,
  access-lost, cross-project, or cross-Environment submission creates no
  remembered row and cannot execute.
- Repeated identical submissions are idempotent, while conflicting submissions
  cannot replace the original decision.
- Later matching calls are newly prepared, validated, credentialed, executed,
  outcome-tracked, and audited without another eligible prompt.
- A new thread, different user, different tool, changed descriptor revision, or
  changed approval-authority revision asks again.
- A thread from another project or Environment cannot consume or create the
  remembered evidence, even when organization, actor, and tool names match.
- Automatic, Blocked, disabled, subject-restricted, tool-minimum, runtime-strict,
  and lost-access cases follow the shared policy matrix and never become broader
  because a remembered row exists.
- Thread deletion cascades to remembered rows, and no remembered-approval
  management UI or endpoint exists.
- The approval card no longer exposes `Always Approve` or returns through
  Environment Apps; deliberate Environment policy editing still works.
- Focused contract, policy-matrix, PostgreSQL transaction, isolation, cascade,
  expiry-race, policy-change, idempotency, Web, Mobile, and hosted-flow tests
  pass.
- `pnpm validate`, `pnpm validate:postgres`, and `pnpm validate:process` pass.

## Depends on

- [Make the thread interaction the approval decision owner](04-canonicalize-approval-lifecycle.md)
