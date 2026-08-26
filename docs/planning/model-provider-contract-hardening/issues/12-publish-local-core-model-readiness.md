# Publish exact Local Core and Desktop model readiness

## Useful outcome

Local Core and Desktop routes enter the same evidence and admission system as hosted routes. Finding a model in a local catalog proves reachability only; Kestrel advertises and selects it for a role only when its exact registration and qualification support that role.

## What changes

Replace Local Core and Desktop's `{ provider, model, health }` model advertisement with the shared Model Registration V2 projection, qualification revision and status, evidence age, and eligible roles.

Extend Desktop provider verification and Local Core provider readiness to acquire exact endpoint, model, adapter, credential, and local discovery evidence, then run the shared capability qualifications through the real codec and verifier. Local OpenAI-compatible routes must identify their actual provider configuration and endpoint codec rather than inheriting OpenAI capability truth.

Carry the exact route binding through Local Core profile resolution, Desktop presence, hosted Desktop-environment ingestion, command grants, and runtime dispatch. Apply the same role-ready predicate and effective-contract admission used for hosted execution.

Keep reachable legacy and unqualified local models visible. Allow plain text and any separately proved local-validation capability; block strict schema, required tools, continuation, and streaming roles until exact current proof exists. A stale Desktop presence or changed local model, endpoint, credential, adapter, or runtime configuration must block affected future roles without rewriting historical evidence.

Expose refresh and actionable failure state in the existing Desktop and Local Core status surfaces. Do not silently switch to a hosted route or a different local model.

## Requirements and delivery context

The canonical requirements are in the [Product Brief](../../model-provider-contract-hardening-product-brief.md).

The owning seams include `apps/desktop/src/modelProviderVerification.ts`, `src/localCore/providerReadiness.ts`, `src/localCore/profileProvider.ts`, `src/localCore/desktopEnvironmentConnector.ts`, the Desktop presence contract in `apps/web/lib/environments/desktop.ts`, Local Core runtime configuration, and their parser, API, connector, and UI tests.

Do not infer capabilities from catalog membership, provider name, model name, or OpenAI compatibility. Other local providers may remain restricted after this issue if they lack exact evidence and qualification.

## Done when

- Local Core publishes a strict V2 registration and capability-specific qualification for each advertised exact route.
- Desktop presence and hosted ingestion preserve registration, qualification, evidence age, and eligible roles without trusting client-authored capability claims outside the signed Local Core contract.
- Local selectors and runtime dispatch apply the same role requirements and pre-spend admission as hosted execution.
- Reachable legacy, stale, and partially capable models remain visible but cannot enter unproved strict-schema, required-tool, continuation, or streaming roles.
- A changed local model, endpoint, credential, adapter, or runtime configuration makes affected future proof stale while historical evidence remains readable.
- No local failure silently switches provider, endpoint, or model.
- Focused Desktop verification, Local Core parser/API, presence round-trip, stale-refresh, selector, runtime, and UI tests pass.
- `pnpm validate:process`, `pnpm validate:chromium`, and `pnpm validate` pass.

## Depends on

- [Qualify exact model capabilities through real codecs](06-qualify-exact-model-capabilities.md)
- [Admit effective model contracts before provider spend](09-admit-effective-model-contracts.md)
- [Persist exact admission and response proof](10-persist-model-call-proof.md)
