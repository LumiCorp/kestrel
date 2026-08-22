# Repair OpenRouter admission errors and race guards

## Useful outcome

Administrators receive accurate, actionable results when OpenRouter model admission fails or changes during resolution. A provider request cannot hang indefinitely or commit evidence from an old gateway endpoint, and the admin surface shows the complete admitted provenance.

This repair restores the blocking guarantees found during independent review of issue 01.

## What changes

Preserve provider-resolution classification through the admin API. The response must distinguish at least:

- Non-retryable authentication or authorization failure.
- Non-retryable missing route or exact-ID mismatch.
- Non-retryable malformed provider response or missing required capacity.
- Retryable provider outage, timeout, or transient upstream failure.
- Retryable credential or gateway-configuration race.

Do not expose credentials or raw provider secrets. Keep machine-readable codes stable and include retryability where the admin client and support path can consume it. Map 401 and 403 responses to an actionable non-retryable status rather than a generic 503.

Bound the OpenRouter model-detail request with a timeout. A timeout or abort must become a retryable provider-resolution failure and must leave no model approval or default state.

Extend the stale-evidence guard to gateway endpoint configuration. If the gateway base URL changes while model details are resolving, the old endpoint’s evidence must not be committed against the new gateway configuration. Reuse the existing gateway revision contract or compare the resolved endpoint in the transaction.

Complete the administrator admission display. Show the canonical OpenRouter slug when present. State explicitly that context and output values are provider limits, not Kestrel’s per-run context allocation. Preserve source and actionable failure status.

Add integration-level regression coverage for the provider request, URL and authorization, response classification, timeout, exact-ID mismatch, atomic no-write behavior, credential or endpoint races, API projection, and UI admission rendering. Keep pure profile tests as focused unit coverage, but do not treat them as proof of the end-to-end approval path.

## Requirements and delivery context

The canonical requirements are in the [Product Brief](../../openrouter-model-economics-repair-product-brief.md), and the parent implementation is [issue 01](01-approve-exact-openrouter-models.md).

The affected seams are `apps/web/lib/ai/gateways.ts`, `apps/web/lib/ai/gateway-lifecycle-error.ts`, `apps/web/lib/ai/gateway-admin-error.ts`, the organization gateway model route, `apps/web/components/settings/ai-providers-client.tsx`, and their focused tests.

The parent issue already resolves provider details before the database transaction and checks credential revision. Preserve that design. This issue strengthens the error and concurrency contracts; it must not relax exact route matching or add OpenRouter fallback.

The provider settings UI already receives an `economicsAdmission` projection. Extend that stable projection instead of making the browser parse raw metadata.

## Done when

- OpenRouter 401/403, 404, exact-ID mismatch, malformed response, missing capacity, timeout, 5xx outage, and credential or endpoint race each produce the correct stable code, status, and retryability classification.
- OpenRouter model-detail requests have a bounded timeout.
- A base URL change during resolution prevents stale provider evidence from being committed.
- Failed, timed-out, or raced resolution creates no approved or default model state.
- The admin UI shows canonical slug when present and explicitly labels displayed limits as provider limits, separate from Kestrel per-run allocation.
- Integration tests cover request URL/auth, response classification, timeout, no-write failure, credential and endpoint races, API projection, and UI rendering.
- The parent issue’s focused checks and `pnpm validate` pass when dependencies are available.

## Depends on

- [Approve exact OpenRouter models with provider-backed economics](01-approve-exact-openrouter-models.md)
