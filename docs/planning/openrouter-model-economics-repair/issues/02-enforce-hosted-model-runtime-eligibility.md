# Keep ineligible hosted models out of runtime selection

## Useful outcome

Kestrel One users see and run only hosted language models with a readable exact economics profile. Administrators can still inspect legacy approved rows that need repair, and they can see when Kestrel ignores a stale default.

This slice makes runtime selection truthful even when legacy or manually altered data violates the new approval invariant.

## What changes

Define one shared hosted-language eligibility predicate. A model is eligible only when it is approved, uses a supported hosted provider, belongs to an enabled gateway, and has a readable economics profile whose provider and model exactly match the stored route.

Use the predicate in:

- Kestrel-specific approved model lists and `/api/models/approved`.
- Preferred model and deterministic default resolution.
- Organization default validation.
- Environment default validation.
- Transactional model availability checks.
- Hosted runtime model composition.

Do not change approval behavior for image, speech, video, or embedding models.

Runtime composition must reject an ineligible hosted row locally instead of constructing a selection with optional economics. Keep the shared hosted admission check as defense in depth and preserve its machine-readable error code.

The administrator catalog must continue to include every row. Use the admission projection established by the prerequisite issue to show `ready`, `unapproved`, or `needs_profile`. Disable organization and Environment default controls for ineligible models.

When a stored Environment default is ineligible, retain the reference for audit and recovery. Default resolution may use the existing deterministic eligible default. The administrator must see that substitution and receive a prompt to choose a replacement. An explicit request for the ineligible model must fail and must not silently substitute another model. If the exact row becomes eligible again, the retained reference can become active again.

## Requirements and delivery context

The canonical requirements are in the [Product Brief](../../openrouter-model-economics-repair-product-brief.md).

`listApprovedModels` in `apps/web/lib/ai/gateways.ts` currently trusts the boolean approval flag. `getApprovedKestrelRuntimeLanguageModels`, preferred resolution, and execution resolution inherit that behavior. The approved-model API publishes the same list to selectors.

`apps/web/lib/ai/runtime-model-selection.ts` checks approval, modality, gateway state, and provider support but does not inspect profile eligibility. Organization and Environment default writes have similar approval-only checks.

`apps/web/lib/agent/kestrel-runtime-model.ts` currently permits profile construction to return `undefined`. Replace that permissive hosted behavior while preserving Desktop-local model behavior.

Keep one eligibility definition across these boundaries. Do not add separate keyword, route-shape, or provider-ranking heuristics. Preserve the existing deterministic eligible-default order.

The admin catalog and stored default reference remain distinct from runtime selector output. Do not delete audit state to make a query appear clean.

## Done when

- An approved legacy hosted row without a readable exact profile remains visible as `needs_profile` in provider settings but does not appear in Kestrel One selectors.
- The row cannot win organization, Environment, preferred, or transactional runtime resolution.
- An explicit request for the row fails with an actionable, machine-readable model-state error and does not substitute another model.
- A stale Environment default reference remains stored, uses the existing deterministic eligible default when available, and displays the substitution to administrators.
- Restoring a valid exact profile makes the retained default reference eligible again without recreating it.
- Desktop-local models and non-language gateway modalities retain their current behavior.
- Focused query, API, default, transaction, runtime composition, and administrator UI tests pass.
- `pnpm validate` passes.

## Depends on

- [Approve exact OpenRouter models with provider-backed economics](01-approve-exact-openrouter-models.md)
