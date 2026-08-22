# Approve exact OpenRouter models with provider-backed economics

## Useful outcome

An organization administrator can add an exact OpenRouter model route and receive a truthful `ready` result without entering economics data. Kestrel resolves the route, admits the provider limits, stores the evidence and approval together, and displays the admitted limits in provider settings.

This slice fixes new approvals. It establishes the server-owned admission contract that runtime eligibility, other provider fallbacks, and legacy repair will reuse.

## What changes

Add a server-only hosted model approval operation in the gateway domain. The operation must accept administrator intent and acquire OpenRouter evidence itself. The admin browser must stop sending OpenRouter metadata as trusted evidence.

For an OpenRouter approval, Kestrel must:

- Load the organization-owned gateway, configured credential, base URL, and credential revision.
- Parse one exact `author/slug` route while preserving suffixes such as `:free`.
- Call `GET /api/v1/model/:author/:slug` with safely encoded path segments and the configured credential.
- Validate the response envelope and require returned `data.id` to equal the requested `rawModelId`.
- Retain `canonical_slug` as provenance without substituting it for the routable model ID.
- Prefer `top_provider.context_length` over model-wide `context_length` when the provider value exists.
- Use `top_provider.max_completion_tokens` as the provider output limit.
- Derive and validate the exact economics profile before persistence.
- Write the provider payload, profile, approval state, and default state in one database transaction.
- Confirm the gateway credential revision inside the transaction so stale evidence cannot be applied after credential replacement.

Keep provider network access outside the database transaction. Authentication failure, 404, malformed response, identity mismatch, missing required OpenRouter capacity, and concurrent credential change must leave no newly approved or default state. Retryable provider failures must remain distinguishable from permanent contract failures.

Update the shared economics profile contract to allow output capacity equal to context capacity. Capacity greater than context must remain invalid. Apply the same rule in the web profile reader and shared runtime parser.

Add a stable administrator admission projection with status, admitted context, admitted output, source, canonical slug, and actionable failure information. The provider settings UI must show provider limits and their source. It must report addition success only when the returned status is `ready`. It must explain that provider limits are not Kestrel’s per-run allocation.

When OpenRouter resolves an alias, router, or dynamic variant to a different ID, the error must name the resolved route when available. Kestrel must not create a fallback profile. A static suffix-bearing route is eligible only when OpenRouter returns the same full ID.

## Requirements and delivery context

The canonical requirements are in the [Product Brief](../../openrouter-model-economics-repair-product-brief.md).

The current manual add path is in `apps/web/components/settings/ai-providers-client.tsx`. It sends `metadata: null` for OpenRouter. The admin model route forwards that body to `saveGatewayModel` in `apps/web/lib/ai/gateways.ts`.

`saveGatewayModel` already derives a profile before opening a database transaction. Its transaction already stores metadata, approval, and default state. Preserve that atomic persistence behavior while separating provider resolution from the private persistence operation. Do not put unconditional provider network access inside the generic persistence primitive.

Use the existing gateway credential ownership and credential revision contracts. Do not expose credentials in errors, logs, API responses, or stored provenance.

The strict runtime profile remains version 1. Store administrator provenance beside the profile in gateway model metadata rather than adding an unknown runtime profile field. No database schema change is allowed for this initiative.

Preserve exact hosted admission in `src/profile/kestrelOnePolicy.ts`. This issue changes valid capacity equality, not provider/model identity rules or Kestrel’s context reserves.

## Done when

- Adding `qwen/qwen3.8-27b` through provider settings resolves OpenRouter, stores its full provider evidence and exact profile atomically, returns `ready`, shows its limits, and makes the new approved row available to existing consumers.
- Adding `z-ai/glm-5.2:free` accepts its equal provider context and output limits through both web and shared runtime validation.
- A provider 404, authentication failure, malformed response, missing capacity, ID mismatch, router, dynamic variant, transient failure, or credential revision race creates no approved or default state and returns an actionable classified error.
- `canonical_slug` is visible as provenance when present but never replaces `rawModelId`.
- The browser cannot supply OpenRouter metadata as provider evidence.
- Focused provider-resolution, transaction, API, UI, and shared economics regression tests pass.
- `pnpm validate` passes.
