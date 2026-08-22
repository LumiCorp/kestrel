# OpenRouter Model Economics Repair Product Brief

## Product Narrative

Kestrel One administrators can add and approve hosted language models through provider settings. Today, a manually added OpenRouter model can appear approved and selectable even when Kestrel has not acquired the capacity facts required for hosted execution. The administrator has no field for those facts and no visible indication that the model is unusable. Kestrel One rejects the model only when a user starts a run.

Kestrel must make model approval truthful. When an administrator approves an exact OpenRouter route, the server must resolve that route with OpenRouter, confirm its identity, derive its economics profile, and persist the evidence and approval together. A hosted model must appear in runtime selectors only when its stored economics profile exactly matches its provider and model route.

The provider settings UI must show the context and output limits Kestrel admitted. It must also show whether those limits came from provider data or a disclosed Kestrel default. Administrators must not need to create or edit economics profiles by hand.

## Outcomes and Delivery Boundary

This initiative must produce these outcomes:

- An exact OpenRouter model becomes approved and runtime eligible through one server-owned admission operation.
- Invalid, unresolved, or incomplete OpenRouter routes fail before approval is persisted.
- Kestrel One selectors and default resolution exclude hosted models without a valid exact economics profile.
- Administrators can see each hosted model’s admission state, provider limits, and evidence source.
- Existing approved models receive provider-backed profiles through a resumable repair process or become visibly unavailable.
- Providers that do not publish capacity can use a disclosed conservative profile after exact model identification or validation.

The delivery boundary is limited to hosted language model approval, economics admission, runtime eligibility, default resolution, administrator visibility, and repair of existing rows.

This initiative does not:

- Add manual economics-profile editing.
- Relax exact provider and model matching.
- Treat OpenRouter routers, aliases, or dynamic routing variants as exact hosted models.
- Change model approval rules for image, speech, video, or embedding models.
- Add economics provenance fields to the strict shared version-1 runtime profile.
- Redesign gateway credentials, general model discovery, or Kestrel’s economics policy.

## Defining Scenarios

### Administrator adds an exact OpenRouter model

An organization administrator enters an exact `author/slug` route and chooses approval. Kestrel loads the organization-owned gateway and calls OpenRouter’s model-detail endpoint with the configured credential. Kestrel requires the returned `data.id` to match the requested route.

Kestrel derives the profile from the returned provider capacity. It writes the provider payload, exact profile, approval, and default state in one database transaction. The UI reports `ready` and shows the admitted context limit, output limit, evidence source, and canonical slug when present. The model then appears in Kestrel One selectors.

### OpenRouter resolves a different route

An administrator enters an alias, router, or dynamic variant. OpenRouter returns a different `data.id`, or the route does not resolve. Kestrel does not persist approval or create a fallback profile. The UI names the resolved route when available and asks the administrator to approve that exact route.

### OpenRouter reports equal context and output limits

OpenRouter returns a valid model whose maximum completion equals its provider context, as it currently does for `z-ai/glm-5.2:free`. Kestrel accepts the provider profile because output may equal, but not exceed, context. Kestrel’s separate context policy continues to reserve space for output, safety, tools, and provider overhead.

### A provider does not publish capacity

Kestrel positively identifies or validates an exact Anthropic, OpenAI, Lumi, Ollama, or RunPod model. The provider adapter cannot supply complete capacity facts, and no valid existing exact profile exists. Kestrel assigns the conservative 32,768-token context and 8,192-token output profile. The stored metadata and UI identify the source as `kestrel_default`.

A failed lookup, invalid credential, malformed response, or identity mismatch does not qualify for fallback.

### A legacy approved model lacks a valid profile

The administrator continues to see the model in provider settings with `needs_profile`. Kestrel One selectors, explicit availability checks, and default resolution treat the model as unavailable.

The repair process resolves the exact route and updates the row only when its identity and concurrency guards still match. A successful repair restores eligibility. An unsuccessful repair leaves the model unapproved and non-default with an actionable status.

### An Environment references an ineligible default

Kestrel retains the stored Environment default reference for audit and recovery. Runtime resolution ignores the ineligible row and uses the existing deterministic eligible default when one exists. The administrator sees that substitution and is prompted to choose a replacement.

An explicit request for the ineligible model fails. Kestrel must not silently substitute another model for an explicit selection. If the exact referenced row becomes eligible again, the retained reference can become active again.

## Business and Process Requirements

- Organization administrators must be able to approve an exact OpenRouter model without entering economics data.
- Kestrel must report approval success only after the model is runtime eligible.
- A failed provider resolution or profile derivation must leave no newly approved or default model state.
- The administrator catalog must show all rows, including unapproved and legacy ineligible rows.
- Each hosted language row must show `ready`, `unapproved`, or `needs_profile`.
- A ready row must show its admitted context limit, output limit, and evidence source.
- OpenRouter identity mismatch errors must name the returned route when one is available.
- Administrators must not be able to set an ineligible hosted model as an organization or Environment default.
- Deterministic substitution for a stale default must be visible to administrators.
- Explicit selection of an ineligible model must fail rather than substitute another model.
- The repair process must support dry-run review before mutation.
- Repair results must distinguish repaired rows, unchanged valid rows, identity mismatches, routers, provider failures, missing capacity, equal-capacity admissions, fallback profiles, and concurrent changes.
- Repair must not delete stale Environment default references.
- Support guidance must direct administrators to provider resolution or exact-route correction. It must not ask them to create economics profiles manually.

## Technology Requirements

### Approval and provider integration

- The gateway domain must own hosted model approval. Browser requests must express administrator intent, not submit OpenRouter metadata as trusted evidence.
- OpenRouter approval must call `GET /api/v1/model/:author/:slug` through the configured gateway base URL and credential.
- Kestrel must parse one exact author and slug, preserve suffixes such as `:free`, and encode URL segments safely.
- Kestrel must require a valid response envelope and exact equality between the requested `rawModelId` and returned `data.id`.
- Kestrel must retain `canonical_slug` as provenance. It must not substitute `canonical_slug` for the routable ID.
- Kestrel must prefer `top_provider.context_length` over model-wide `context_length` when the provider value exists.
- Kestrel must use `top_provider.max_completion_tokens` as the reported output limit.
- Authentication failure, not found, malformed response, identity mismatch, and missing required OpenRouter capacity must fail before persistence.
- Retryable provider failures must remain distinguishable from permanent identity or contract failures.

### Atomic persistence and concurrency

- Provider network access must complete before the database transaction starts.
- One transaction must persist the provider payload, exact economics profile, approval state, and default state.
- The transaction must confirm that the gateway credential revision still matches the revision used during provider resolution.
- A concurrent model or credential change must prevent stale resolved evidence from being applied.
- The existing gateway model metadata field must own provider evidence, the runtime profile, and administrator-facing provenance.
- This initiative must not require a database schema change.

### Economics profile contract

- The shared version-1 economics profile must allow `maxOutputTokens` to equal `contextWindowTokens`.
- The shared profile must reject output capacity greater than context capacity.
- Profile provider and model fields must exactly match the stored runtime route.
- Valid existing exact profiles must survive metadata edits and incomplete catalog refreshes.
- Provenance must remain adjacent metadata rather than an unknown field inside the strict runtime profile.

### Conservative fallback

- Fallback eligibility must be an explicit provider-adapter capability.
- The initial fallback-eligible adapters are Anthropic, OpenAI, Lumi, Ollama, and RunPod.
- Each eligible adapter must positively identify or validate the exact model before fallback.
- Valid provider capacity must take precedence over fallback.
- A valid existing exact profile must take precedence over fallback.
- The fallback profile must use a 32,768-token context, 8,192-token output, conservative UTF-8 estimation, no assumed caching, and `kestrel_default` provenance.
- OpenRouter must not use fallback because its model-detail API publishes capacity.
- Replicate remains outside the hosted-language economics path.

### Runtime eligibility and defaults

- Kestrel must define one shared hosted-language eligibility predicate.
- Eligibility must require approval, a supported hosted provider, an enabled gateway, and a readable exact profile.
- Kestrel-specific model lists, `/api/models/approved`, preferred resolution, organization defaults, Environment defaults, and transactional availability checks must use that predicate.
- Non-language modalities must retain their current approval behavior.
- Runtime model composition must reject a missing exact profile locally.
- Shared hosted admission must keep its existing exact-profile validation as defense in depth.
- A stale stored default must not make an ineligible model selectable.
- Deterministic fallback from a stale default must use the existing eligible-default resolution rules.

### Administrator contract

- The admin API must return a stable derived admission view. The browser must not infer readiness by parsing arbitrary provider metadata.
- The view must include status, admitted context, admitted output, source, canonical slug when present, and actionable failure information.
- The provider settings UI must disable default controls for ineligible rows.
- The UI must distinguish provider limits from Kestrel’s per-run context allocation.

### Repair, reliability, and observability

- The existing economics backfill must resolve approved OpenRouter rows through the model-detail endpoint.
- Repair must be resumable and safe to repeat.
- Repair writes must compare row update time or another row version and gateway credential revision before applying evidence.
- Rows that cannot be repaired must become unapproved and non-default while remaining visible to administrators.
- Runtime eligibility protection must deploy before or with repair so legacy rows cannot reach Kestrel One during transition.
- Logs and repair output must identify provider, model, result category, evidence source, and retryability without exposing credentials.
- Existing runtime admission errors must remain machine-readable as defense-in-depth evidence.

### Verification and compatibility

- Regression coverage must prove manual addition for `qwen/qwen3.8-27b` creates a provider-backed exact profile.
- Regression coverage must prove equal capacity for `z-ai/glm-5.2:free` is valid.
- Tests must cover 404, authentication failure, malformed response, ID mismatch, routers, static variants, dynamic variants, and transient provider errors.
- Transaction tests must prove that failed resolution creates no approved/default state and that successful resolution writes all admission state together.
- Selection tests must prove that an approved legacy row without an exact profile cannot appear in Kestrel One or win default resolution.
- Default tests must prove that explicit ineligible selection fails and stale-default substitution is deterministic and visible.
- Fallback tests must cover every eligible adapter, precedence of provider facts and existing profiles, provenance, and OpenRouter exclusion.
- The portable `pnpm validate` gate must pass before the change is ready to publish.

## People and Operating Requirements

- Organization administrators own model route selection, approval intent, and replacement of stale defaults.
- Kestrel owns provider evidence acquisition, profile derivation, eligibility enforcement, and truthful status display.
- Administrators must not be responsible for calculating or entering context and output limits.
- Runtime users must see only eligible hosted models in normal selectors.
- Runtime users who explicitly request an ineligible model must receive an actionable failure that identifies the model state.
- Operators own dry-run review and application of the repair process.
- Operators must review identity mismatches, routers, provider failures, fallback use, and concurrent-change skips separately.
- Support staff must be able to distinguish provider lookup failure, identity mismatch, missing capacity, stale approval, and runtime defense-in-depth rejection from the admin-visible status and structured errors.
- No new ongoing manual profile-maintenance role is introduced.

## Success and Readiness

Success is observable when:

- Adding a valid exact OpenRouter route returns `ready`, shows provider limits, and makes the model immediately usable in Kestrel One.
- Adding an invalid or non-exact OpenRouter route leaves no approved or default row.
- `qwen/qwen3.8-27b` receives its provider-backed profile through manual addition.
- `z-ai/glm-5.2:free` is admitted with equal context and output capacity.
- No hosted model without a readable exact profile appears in runtime selectors or wins default resolution.
- Every fallback profile identifies `kestrel_default`, and no OpenRouter row receives that source.
- Existing invalid rows are repaired or shown as unavailable without losing their audit history.
- Administrators can see when Kestrel substituted an eligible default for a stale stored default.
- The focused provider, transaction, eligibility, UI, backfill, and shared economics tests pass.
- `pnpm validate` passes.

**Readiness: Ready for issue creation.**

The product behavior, architecture seam, data ownership, transition behavior, fallback policy, and operating responsibilities are settled. No issue author needs to invent a product rule, structural mechanism, or owner.

## Source Artifacts

- [OpenRouter Model Economics Repair Change Design](../design/openrouter-model-economics-repair-change-design.md)
- [OpenRouter Model Economics Repair Design Notebook](../../.design/openrouter-model-economics-repair/notebook.md)
- [Hosted Model Economics Profile Rollout](../references/model-economics-profile-rollout.md)
