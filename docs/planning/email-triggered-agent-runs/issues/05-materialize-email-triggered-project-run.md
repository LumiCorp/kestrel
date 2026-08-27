# Materialize an admitted email as a durable Project run

## Useful outcome

One admitted email creates exactly one private Project Thread and one durable, noninteractive Build turn. The run receives the Project's current trusted context and a deterministic untrusted email message, then follows the ordinary hosted or Desktop execution path.

## What changes

- Lock the admitted receipt and reserve its materialization result against the Receiving Connection and Resend email identity.
- Recheck the enabled Trigger and exact revision, Execution Owner Organization and Project access, non-archived Project, current Project context revision, Project Environment, and current model availability.
- Disable the Trigger with **Execution owner lost access** when its creator no longer has authority. Reject the receipt and start no model work.
- Create one private Project Thread with `workspaceMode: "primary"`, the Trigger creator as creator, and the existing `web` origin.
- Create the first user message from one versioned deterministic envelope. Include Trigger name and instruction, the explicit untrusted-input warning, received time, claimed From, To, Cc, Reply-To, subject, normalized body, and ordered opaque attachment descriptors.
- Keep Project context in the existing trusted system-context revision. Email-controlled values must never select Organization, Project, actor, model, Environment, Apps, policy, or system instructions.
- Call `createDurableThreadTurnInTransaction` with the reserved message and turn identities, current context revision, selected Environment and model, Build mode, `noninteractive: true`, and a stable receipt idempotency key.
- Link the receipt, Thread, message, and turn and mark the receipt materialized in the same locked transaction.
- Use the ordinary durable turn queue, recovery, evidence, Project-primary concurrency, App access, approval, spending, and interaction behavior. Do not add an email-specific policy or pre-authorize tools.
- Preserve the existing Environment route. Hosted Projects run hosted, and disconnected Desktop-backed Projects enter the existing durable wait without requiring Desktop ingress.
- Present email provenance through the receipt relation on the normal Thread and Trigger surfaces. Do not add `email` to shared origin or source enums, and do not copy turn execution status back into the receipt.
- Disabling inbound receiving or the Trigger stops new materialization but does not cancel materialized work or delete its evidence.

## Requirements and delivery context

Follow the locked materialization pattern in `apps/web/lib/schedules/runtime.ts`, but keep receipts out of schedule tables. The shared execution boundary is `createDurableThreadTurnInTransaction` in `apps/web/lib/turns/store.ts`, followed by the existing turn queue and `apps/web/lib/environments/execution-route.ts`.

The actor is always the Trigger creator. The external sender is provenance and untrusted input, never a Kestrel user, approver, or service principal. The existing approval and connected-App profile must remain unchanged except for the receipt-scoped attachment tool delivered by the next issue.

An unmet approval or interaction requirement in this noninteractive run must use the existing inspectable blocked outcome. Do not invent an automatic approval rule.

The canonical requirements are in the [Email-Triggered Agent Runs Product Brief](../../email-triggered-agent-runs-product-brief.md).

## Done when

- One admitted receipt creates one private primary-workspace Thread, one normalized user message, and one noninteractive Build turn authored by the Trigger creator.
- Concurrent materializers and replay by Resend email identity converge on the same Thread and turn.
- The turn uses the current Project context revision, current eligible model, and configured Project Environment rather than stale email or Trigger-controlled authority.
- Disabled or revised Trigger state, owner access loss, Project archive, context mismatch, and model unavailability start no model work and leave a stable receipt outcome.
- The email envelope clearly marks all external fields as untrusted and exposes only opaque Delivery Attachment IDs.
- Existing connected business Apps, approval policy, spending controls, recovery, evidence, and primary-workspace concurrency remain authoritative.
- A hosted Environment executes through the ordinary path. A disconnected Desktop-backed Environment waits durably and continues after reconnection without resending the email.
- Thread and Trigger presentation show receipt provenance without changing shared source enums or duplicating execution state.
- Focused materialization, idempotency, authority, envelope, policy, hosted routing, Desktop wait, and PostgreSQL concurrency tests pass.
- `pnpm validate`, `pnpm validate:postgres`, and `pnpm validate:process` pass.

## Depends on

- [Hydrate and admit one received email](04-hydrate-and-admit-received-email.md)
