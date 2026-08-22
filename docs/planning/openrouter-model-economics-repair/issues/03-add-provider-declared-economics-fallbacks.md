# Assign disclosed defaults only through eligible provider adapters

## Useful outcome

Administrators can approve exact hosted language models from providers that do not publish complete capacity facts. Kestrel assigns a conservative, visible economics profile only after the provider adapter identifies or validates the exact model.

This slice prevents incomplete provider catalogs from blocking valid models without turning lookup and identity failures into silent defaults.

## What changes

Extend the server-owned admission operation with an explicit provider-adapter capability for conservative fallback. The initial eligible adapters are Anthropic, OpenAI, Lumi, Ollama, and RunPod. OpenRouter must remain ineligible for fallback because its model-detail API publishes capacity. Replicate remains outside the hosted-language path.

For each eligible adapter, Kestrel must positively identify or validate the exact model before it can assign fallback. Reuse the provider’s existing catalog, protocol, or model validation boundary. A failed lookup, invalid credential, malformed response, identity mismatch, or failed RunPod validation must not qualify.

Apply this precedence:

1. Preserve a valid existing exact profile.
2. Derive a profile from complete provider capacity.
3. Use the Kestrel conservative default only when the adapter declares that its provider contract lacks complete capacity.

The fallback profile must use:

- 32,768-token context.
- 8,192-token output.
- Conservative UTF-8 estimation.
- No assumed caching.
- `kestrel_default` administrator provenance stored beside the strict runtime profile.

Profiles derived from provider facts must use provider provenance. The administrator admission projection and provider settings UI must show the source and admitted limits for both paths.

Sync and metadata edits must preserve a valid existing exact profile when a later provider response is incomplete. They must not silently replace a stronger provider-backed profile with the conservative default.

## Requirements and delivery context

The canonical requirements are in the [Product Brief](../../openrouter-model-economics-repair-product-brief.md).

Current provider discovery is centralized in `apps/web/lib/ai/gateways.ts`. Anthropic and Ollama have provider-specific list calls. OpenAI, Lumi, and RunPod use the OpenAI-compatible catalog path. RunPod also has an existing tool-round-trip validation contract that must remain a prerequisite for approval.

Current profile creation in `apps/web/lib/ai/model-economics-profile.ts` returns no profile when capacity is incomplete. Replace that provider-agnostic failure with explicit adapter input from the admission boundary. Do not infer fallback eligibility from missing JSON keys alone.

Keep exact provider and model matching. Keep the strict shared runtime profile version unchanged. Keep fallback provenance in adjacent gateway metadata.

Do not add manual profile fields or a fixture-only bypass. Do not use `requireEconomicsProfile: false` as the normal approval path.

## Done when

- Exact identified or validated Anthropic, OpenAI, Lumi, Ollama, and RunPod models can become `ready` with the conservative profile when their provider contract lacks complete capacity.
- Complete provider capacity and a valid existing exact profile each take precedence over fallback.
- Every fallback row displays 32,768 context, 8,192 output, and `kestrel_default` provenance.
- OpenRouter lookup or capacity failures never receive fallback.
- RunPod cannot receive fallback until its existing model validation succeeds.
- Authentication, identity, malformed response, and provider validation failures persist no approved/default state.
- Focused tests cover every eligible adapter, precedence, profile preservation, provenance, OpenRouter exclusion, and RunPod validation.
- `pnpm validate` passes.

## Depends on

- [Approve exact OpenRouter models with provider-backed economics](01-approve-exact-openrouter-models.md)
