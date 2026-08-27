# Let Project editors manage private Email Triggers

## Useful outcome

A Project editor can create a private Email Trigger, copy its generated address, and control its lifecycle from a Work-level Triggers surface. Authorized Project members can inspect the Trigger and see who its runs execute as.

## What changes

- Add the Project-scoped Email Trigger schema and additive production migration. Store the name, private address material, instruction, model, creator and Execution Owner, optional claimed-From filter, explicit access mode, enabled state, revision, and lifecycle evidence.
- Add **Triggers** as a primary Work destination beside Schedules. Group visible Triggers by Project and use server-computed action permissions.
- Provide a short create and edit form with Project, name, “What should the agent do with each email?”, model, and optional exact claimed-From filter.
- Default the instruction to “Handle this email according to the Project instructions.” Resolve default and selectable models through the same Project Environment availability rules used by Schedules.
- Show the creator as **Runs as**. Persist that creator as the immutable Execution Owner for the MVP; do not add an owner selector or service principal.
- Generate a lowercase local part with at least 128 bits of randomness on the Organization's receiving subdomain. Disclose the complete address only to authorized Project members.
- Let members inspect and copy the address. Require editor or owner access to create, edit, rotate, disable, or delete the Trigger.
- Label the optional sender condition as exact claimed-From filtering. Do not describe it as verified identity or authentication.
- Expose only `private` access mode. Do not render a public switch or accept a public API value.
- Increment the Trigger revision when the instruction, model, filter, address, or owner-affecting lifecycle state changes. Rotation must invalidate the prior address atomically for new admission.
- Require current inbound health, a non-archived Project, current Execution Owner access, and an available model before enablement. A test email is optional, not an extra enablement gate.
- Extend the owning Project membership-removal and Project archive mutations to disable affected Triggers with stable reasons. Do not silently re-enable them when access later returns.
- Reject enablement when the current Project Environment or selected model is unavailable. Preserve the configured model so later materialization can fail with a stable reason if availability changes; do not add proactive model or Environment disablement that the Product Brief does not require.
- Redact the complete Trigger address from ordinary logs, analytics, audit summaries, and errors. Preserve historical receipts and Threads after rotation, disablement, or deletion.

## Requirements and delivery context

Use the Schedules product shape without reusing schedule persistence. The closest seams are the Work navigation, `/schedules` page, `apps/web/components/schedules/schedules-client.tsx`, Project schedule API routes, `apps/web/lib/schedules/store.ts`, and model-availability checks.

Project role enforcement belongs in the existing Project access service. The Trigger service must perform locked Project, membership, archive, model, and revision checks rather than trusting client-supplied booleans. The UI must consume the permissions and readiness returned by the server.

Project membership removal and archive already pause creator-owned schedules in `apps/web/lib/projects/store.ts`. Add Trigger invalidation to the same owning transactions so admission cannot race a stale owner or archived Project.

The canonical requirements are in the [Email-Triggered Agent Runs Product Brief](../../email-triggered-agent-runs-product-brief.md).

## Done when

- An editor can create a private Trigger for an eligible Project, and the grouped Work surface shows its instruction, model, status, private address, and **Runs as** owner.
- An authorized member can inspect and copy the address but cannot mutate the Trigger without editor access.
- Unauthorized and cross-Organization users cannot discover the Trigger or address through pages, APIs, logs, analytics, or errors.
- The default model and every explicit model are validated against the current Project Environment at create and update time.
- Rotation changes the address and revision atomically and rejects the old address for new admission.
- Claimed-From filtering is stored and presented only as filtering.
- Project archive or owner access loss disables the Trigger with a stable reason and preserves historical work. An unavailable Environment or model prevents enablement without inventing a new automatic disablement policy.
- No UI or API accepts public access mode or a configurable execution owner.
- Migration-backed store, concurrency, API, authorization, route ownership, navigation, and UI contract tests pass.
- `pnpm validate` and `pnpm validate:postgres` pass.

## Depends on

- [Configure Organization Resend receiving in One and Desktop](01-prepare-organization-resend-receiving.md)
