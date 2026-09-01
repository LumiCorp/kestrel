# Persist exact hosted model registrations

## Useful outcome

Approving or refreshing an OpenAI, OpenRouter, or Anthropic model creates one server-owned exact registration with provider evidence and current qualification. The administrator supplies intent, not capability claims.

## What changes

Add a hosted model-registration operation in the gateway domain. Resolve provider evidence outside the transaction, validate exact identity, create Model Registration V2, run the qualifications required by intended roles, and persist the provider payload, economics evidence, registration, qualification projection, approval, and default state atomically after rechecking gateway and credential revisions.

For OpenRouter, extend the existing exact model-detail and economics path with supported parameters, endpoint evidence, and routing policy. Preserve exact route matching, canonical-slug provenance, provider limits, and current economics behavior. For Anthropic, use the Models API translator. For OpenAI, use the reviewed adapter manifest plus live qualification.

Store the typed registration and evidence in `ai_gateway_models.metadata` beside current provider and economics metadata. Do not create an administrator-editable capability profile or a second source of truth. Keep raw retained evidence bounded and secret-safe.

A provider/model identity, base URL, endpoint policy, credential revision, adapter revision, registration revision, or probe revision change must make affected proof stale. Existing approved rows remain visible as `legacy_unqualified` until refreshed; they do not inherit provider-wide capabilities.

Provider network access must remain outside the database transaction. Authentication failure, not found, exact-ID mismatch, malformed evidence, unsupported role requirements, provider outage, timeout, or a revision race must return an actionable classified state and must not commit conflicting registration or default state.

## Requirements and delivery context

The canonical requirements are in the [Product Brief](../../model-provider-contract-hardening-product-brief.md).

The existing hosted seams are `apps/web/lib/ai/gateways.ts`, `apps/web/lib/ai/openrouter-model-resolution.ts`, gateway lifecycle errors, `ai_gateway_models` in `apps/web/drizzle/schema.ts`, and their API and PostgreSQL tests. Preserve the already implemented exact OpenRouter identity and economics admission rather than duplicating it.

Approval, reachability, identity, declaration, qualification, and role eligibility remain distinct states. This issue persists their evidence; the administrator projection and selector contraction are a later slice.

## Done when

- Approving exact OpenAI, OpenRouter, and Anthropic fixtures stores a fingerprinted V2 registration, source evidence, qualification projection, existing economics evidence, approval, and default intent without accepting browser-authored capability claims.
- OpenRouter registration preserves exact ID, canonical slug, supported parameters, endpoint evidence, routing policy, and economics provenance.
- OpenAI declaration comes from a revisioned manifest and remains unqualified until probes pass; Anthropic evidence rejects identity mismatch.
- Provider, endpoint, credential, adapter, registration, or probe changes produce a visible stale state for future qualification.
- Legacy approved rows remain visible as `legacy_unqualified` and can be refreshed without deleting approval or default intent.
- Classified provider and revision-race failures leave no conflicting registration or default write.
- Focused provider acquisition, transaction, migration compatibility, qualification integration, and PostgreSQL tests pass.
- `pnpm validate:postgres` and `pnpm validate` pass.

## Depends on

- [Correct OpenAI Chat and Responses codecs](03-correct-openai-codecs.md)
- [Make OpenRouter codecs and routing contract-safe](04-correct-openrouter-codecs-and-routing.md)
- [Use native Anthropic Messages contracts](05-correct-anthropic-codec.md)
- [Qualify exact model capabilities through real codecs](06-qualify-exact-model-capabilities.md)
