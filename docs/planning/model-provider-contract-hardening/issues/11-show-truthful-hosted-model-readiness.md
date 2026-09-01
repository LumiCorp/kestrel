# Show truthful hosted model readiness by role

## Useful outcome

Administrators can approve and refresh exact models, understand their evidence and qualification state, and assign only roles they can currently serve. Users do not see a model as generally ready when it has proved only a narrower capability set.

## What changes

Add one stable hosted admission projection that separates administrative approval, provider reachability, exact identity, declaration, qualification, freshness, and role eligibility.

The administrator model surface must show provider/model identity, registration revision and fingerprint, evidence source and age, last qualification result, capability-specific status, eligible and unavailable roles, actionable reason, and refresh action. Administrators may approve an exact model, assign intended roles, and request refresh; they may not author or override capability evidence.

Define runtime role requirements in one product-owned contract. Apply the same role-ready predicate to Kestrel model lists, `/api/models/approved`, organization and Environment defaults, preferred selection, transactional availability checks, hosted runtime composition, and grant activation.

Keep approved-but-unqualified, partially qualified, stale, failed, unsupported, and legacy rows visible to administrators. Exclude only the roles whose exact requirements are not current. An explicit ineligible role request must fail; it must not silently select a different model or weaker contract. Preserve stored default intent for recovery and show any existing deterministic eligible-default substitution.

Extend the existing provider-settings success and failure states. Approval success must not imply all-role readiness. A GLM or other smaller route may appear ready for plain text or locally validated JSON while strict-schema or required-tool roles show the exact missing proof.

## Requirements and delivery context

The canonical requirements are in the [Product Brief](../../model-provider-contract-hardening-product-brief.md).

The owning seams include the organization gateway model API, `apps/web/lib/ai/gateways.ts`, `apps/web/lib/ai/runtime-model-selection.ts`, `apps/web/lib/agent/kestrel-runtime-model.ts`, `/api/models/approved`, `apps/web/components/settings/ai-providers-client.tsx`, environment defaults, and run-grant activation.

Preserve the existing exact economics readiness projection and provider-limit display. Economics, administrative approval, and capability readiness are separate facts. Do not add a browser-authored capability profile or model ranking heuristic.

## Done when

- Administrators can approve, assign intended roles, refresh, and inspect exact registration and qualification evidence without editing capability claims.
- Approved-but-unqualified, stale, failed, unsupported, and legacy routes remain visible with actionable state.
- Every selector, default validator, runtime composition path, and new grant applies the same role-ready predicate.
- An ineligible explicit request fails without substitution; retained default intent becomes active again if the exact role qualification returns.
- A partially capable GLM fixture is available only for its qualified roles, and the UI names why stricter roles are unavailable.
- Existing OpenRouter economics readiness and non-language modalities retain their current behavior.
- Focused API, query, selector, default, grant, component, and browser tests pass.
- `pnpm validate:postgres`, `pnpm validate:chromium`, and `pnpm validate` pass.

## Depends on

- [Persist exact hosted model registrations](08-persist-exact-hosted-registrations.md)
- [Admit effective model contracts before provider spend](09-admit-effective-model-contracts.md)
- [Persist exact admission and response proof](10-persist-model-call-proof.md)
