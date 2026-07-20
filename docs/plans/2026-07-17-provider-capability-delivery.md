---
id: provider-capability-delivery
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-07-17
depends_on:
  - ../../tools/README.md
---

# Provider Capability Delivery

## Outcome

Every provider is one governed capability across the Suite and Kestrel One:
canonical runtime contract, explicit credentials, Environment and Project
policy, App discovery, approvals, health, audit evidence, docs, tests, and
packaged Desktop resources ship together.

## Shared Delivery Contract

- `tools/` owns canonical names, model-visible schemas, and normalized handlers.
- Apps own installation, connection, Environment grants, Project narrowing, and
  approval policy.
- Runtime profiles consume effective capabilities only; they never create a
  second provider registry, implicit alias, ambient credential path, or hidden
  fallback.
- Health reports non-secret readiness and every attempted provider/failure.
- Write capabilities require payload-bound, single-use approval.

## Ordered Slices

1. **Weather:** complete Open-Meteo primary and Visual Crossing fallback
   through the shared contract. Preserve attribution, use the bounded 18-second
   provider budget, make missing fallback explicit, and prove local Keychain and
   hosted broker paths without exposing keys.
2. **Tavily:** migrate model-visible tools to canonical `tavily.*` names with
   replay-compatible handling, normalized envelopes, exact credential resolution,
   and no Exa fallback.
3. **Exa:** add explicit `exa.search`, `exa.contents`, `exa.similar`, and
   `exa.answer` contracts, credentials, policies, runtime path, and readiness;
   unavailable Exa is a normalized Exa failure, never Tavily routing.
4. **Microsoft Teams:** deliver distinct personal delegated OAuth and managed
   shared Project identities, scoped resource access, and payload-bound approval
   before Microsoft Graph writes.

## Slice Exit Criteria

A slice is complete only when its canonical tool contract, adapter, local and
hosted credential flow, App surface, Environment/Project controls, approvals,
health, audit evidence, documentation, tests, and Desktop packaging are all
present and release-verified.

## Validation

- Focused provider and App-policy tests per slice.
- `pnpm run governance:check`, `pnpm run test`, and `pnpm run test-proofs:check`.
