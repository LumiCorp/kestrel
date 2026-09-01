# Establish exact model and request contracts

## Useful outcome

Kestrel has one strict, fingerprinted contract for an exact provider route and one provider-neutral way to state what a model call requires. Later slices can qualify, admit, translate, and audit the same facts without inferring capability from a provider name or model family.

This is the additive contract slice. Existing V1 records and calls remain readable, but they do not acquire optimistic structured-output, tool, reasoning, continuation, or streaming capabilities.

## What changes

Add versioned successors to `ModelRegistrationV1`, `ModelRequestV1`, and `ModelResponseV1` in the shared Kestrel contracts.

Model Registration V2 must identify one provider, model, API endpoint, endpoint codec, and routing policy. It must represent provider evidence, adapter and credential revisions, qualification references, freshness state, and each capability separately: JSON syntax, local schema validation, provider-strict schema output, native tools, required tool choice, strict tool inputs, parallel tools, reasoning modes, continuation kinds, streaming terminal behavior, modalities, limits, and cache behavior.

Model Request V2 must state call requirements provider-neutrally. Include the runtime role, structured-output assurance, schema validation requirement, tool-use requirement and choice, parallelism, reasoning and continuation, streaming, and any endpoint requirement. Keep `providerOptions` for genuine transport choices only. Duplicated legacy fields may be adapted during coexistence, but conflicting values must fail.

Model Response V2 must represent completed, refused, incomplete, truncated, interrupted, and malformed terminal states, plus validation proof. Define canonical request, registration, routing, schema, tool-surface, and effective-contract hashing inputs without secrets.

Add strict parsers, canonical serialization, fingerprints, and explicit V1-to-V2 compatibility adapters. A legacy registration becomes `legacy_unqualified` and is eligible for plain text only until exact evidence proves more. Preserve historical V1 parsing and replay.

Change `ProviderRegistry` so a provider registration describes the adapter factory and codec envelope, not capability truth for every model on that provider. Export the new contracts through the existing public contract surfaces.

## Requirements and delivery context

The canonical requirements are in the [Product Brief](../../model-provider-contract-hardening-product-brief.md).

The current shared types and strict parsing live in `src/kestrel/contracts/model-io.ts` and `src/kestrel/contracts/model-registration.ts`. `models/ProviderRegistry.ts` currently assigns provider-wide capability declarations. `models/VersionedModelBoundary.ts` currently normalizes envelope shape only. Provider-neutral callers include `agents/reference-react/src/steps/deliberator.ts`, `src/engine/ContinuationCoordinator.ts`, `src/runtime/userReplyIntent.ts`, and evaluation callers.

Reuse canonical JSON and hash utilities already used by model registration and tool contracts. Do not add model-name, size, keyword, endpoint-ranking, or fallback heuristics. Do not remove V1 readers in this slice.

## Done when

- V2 can distinguish every capability and binding listed in the Product Brief without relying on provider-specific request fields.
- Canonical equivalent registrations and requirements have identical fingerprints; a material route, evidence, codec, routing, credential, or requirement change changes the appropriate fingerprint.
- Parsers reject unknown fields, conflicting legacy and V2 semantics, malformed evidence, stale revisions, invalid endpoints, and secret-bearing provenance.
- V1 records and calls remain readable and adapt to `legacy_unqualified` plain-text behavior without inheriting provider-wide capability claims.
- Provider registration tests prove that adapter declarations cannot make an arbitrary exact model structured-output or tool capable.
- Focused contract and caller regression tests pass.
- `pnpm validate` passes.
