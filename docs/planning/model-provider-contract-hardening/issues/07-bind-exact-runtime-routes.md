# Bind runtime routes to exact model evidence

## Useful outcome

Every V2 runtime route carries one immutable registration and qualification identity from selection through credential lease and provider dispatch. A broker cannot silently replace the model, endpoint, or contract that the runtime selected.

## What changes

Add an exact model-route binding to shared profiles, hosted runtime composition, credential lease contracts, and the gateway broker. Carry provider and model identity, registration revision and fingerprint, qualification revision, endpoint codec, routing-policy fingerprint, required role, and credential revision.

Replace optimistic `toolCallingEnabled` and `structuredOutputEnabled` overlay construction with the exact binding. Provider or model selection alone must not synthesize capabilities. Keep an explicit legacy binding for historical and plain-text callers during migration.

The broker must compare the lease route with the bound route before creating or invoking a provider. It may inject the same model into a transport request, but it must reject a missing, stale, tampered, or mismatched model, registration, qualification, endpoint, routing policy, or credential revision.

Extend `environment_model_grants` with additive exact-registration evidence fields. New V2 grants must snapshot the binding at activation. Existing grants and historical rows remain readable; they must not be rewritten to claim evidence that was never captured. A qualification refresh may block a future grant but cannot change an active in-flight binding.

## Requirements and delivery context

The canonical requirements are in the [Product Brief](../../model-provider-contract-hardening-product-brief.md).

Current route construction is spread across `src/kestrel/contracts/profile.ts`, `src/profile/kestrelOnePolicy.ts`, `apps/web/lib/agent/kestrel-runtime-model.ts`, `apps/web/lib/ai/gateway-credential-lease-contract.ts`, and `cli/runtime/gateway-credential-broker.ts`. Hosted grant ownership is in `apps/web/drizzle/schema.ts`, `apps/web/lib/environments/execution-route.ts`, `apps/web/lib/turns/store.ts`, and Desktop forwarding in `apps/web/lib/environments/desktop.ts`.

Use an additive migration and compatibility reader. Do not resolve current model metadata during historical replay and do not introduce silent fallback when the bound route is unavailable.

## Done when

- A V2 profile and credential lease preserve the same exact route binding through provider invocation.
- The broker rejects missing, tampered, stale, or mismatched route and credential evidence before provider creation or dispatch.
- A new V2 hosted grant stores registration revision and fingerprint, qualification revision, routing-policy fingerprint, role, and credential revision immutably.
- A later registration or qualification refresh affects future grants but not an already active execution binding.
- Legacy profiles and grants remain readable and are explicitly marked unqualified rather than receiving optimistic capabilities.
- Focused profile, lease, broker, migration, PostgreSQL, and in-flight stability tests pass.
- `pnpm validate:postgres` and `pnpm validate` pass.

## Depends on

- [Establish exact model and request contracts](01-establish-exact-model-contracts.md)
