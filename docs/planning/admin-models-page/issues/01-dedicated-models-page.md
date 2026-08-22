# Give organization admins a dedicated Models page

## Useful outcome

An organization admin can open Models directly under Configure and govern one provider's model catalog without entering Connections. Connections becomes a focused provider lifecycle and credential surface.

This slice delivers the information architecture and responsibility split used by every defining scenario in the [Admin Models Page Product Brief](../../admin-models-page-product-brief.md).

## What changes

- Add Models immediately after Connections in the Configure navigation. The link must work in the desktop navigation and mobile organization-section selector.
- Add `/organization/models` as an organization-admin page. Use the same authorization behavior as `/organization/connections`.
- Register the route in the route ownership manifest with owner `models`, access `admin`, and unauthorized behavior `admin-denied`.
- Update the organization home so Connections and Models have separate links and descriptions.
- Separate the current combined `GatewayAdminClient` responsibilities. Share the gateway bundle contract, collection loading, provider labels, and model helpers where both pages need them. Do not implement the split by branching one large client on the pathname.
- Keep provider creation, connection health, supported workload information, credential replacement, and provider deletion on Connections.
- Keep the warning that provider deletion also removes the provider's imported models.
- Move provider selection, model synchronization, supported modality and catalog counts, model creation, search and filters, alias and protocol editing, approval, defaults, RunPod validation, saving, and model deletion to Models.
- Select the first available provider by default. When the admin changes providers, replace the visible counts, filters, drafts, validation state, and catalog with the selected provider's state.
- Show a Models empty state when no provider exists. Explain that a provider is required and link to Connections.
- Preserve the current loading, busy, success, error, and destructive-confirmation behavior on the page that owns each action.

## Requirements and delivery context

The current entry point is `apps/web/app/(workspace)/organization/connections/page.tsx`, which mounts `GatewayAdminClient` from `apps/web/components/settings/ai-providers-client.tsx`. That client loads gateway bundles from `/api/organization/ai/gateways` and currently owns provider and model actions together.

Organization navigation is owned by `apps/web/components/organization/organization-navigation.tsx`. The organization home links are in `apps/web/components/organization/organization-management-home.tsx`. Canonical page ownership is recorded in `apps/web/app/route-ownership.manifest.ts`.

Preserve these contracts:

- Both pages must use the existing gateway collection response.
- Model synchronization and mutations must continue to use the existing gateway-scoped endpoints.
- Model IDs, gateway IDs, aliases, modalities, protocols, approval flags, default flags, descriptions, metadata, and RunPod validation evidence must keep their current meaning.
- Model mutations must remain scoped to the selected gateway and model.
- Changing providers must not carry unsaved model drafts or validation state into another provider.
- Provider deletion checks, model approval rules, default rules, runtime selection, and economics admission must not weaken.
- Desktop, CLI, terminal user interface, hosted runtime, and chat consumers must continue to observe the same persisted model state.
- Do not add database schema, API versions, provider-selection URL state, or runtime migration behavior.

Update focused contract coverage for navigation order and uniqueness, mobile navigation, route ownership, organization-admin access, separate page responsibilities, provider switching, and the no-provider empty state. Preserve the existing cardless settings surface conventions.

## Done when

- An organization admin can reach `/organization/models` from desktop and mobile Configure navigation and sees Models as the active page.
- A person without organization-admin permission receives the established `admin-denied` behavior.
- Models defaults to the first configured provider, can switch among configured providers, and shows only the selected provider's catalog state.
- Every existing model synchronization and governance action works from Models with its current success, failure, validation, confirmation, persistence, and refresh behavior.
- Models links to Connections when no provider exists.
- Connections supports provider creation, status inspection, credential replacement, and provider deletion, but contains no model catalog or model governance controls.
- Connections still warns that deleting a provider removes its imported models.
- The organization home and both navigation forms describe Connections and Models as separate responsibilities.
- Focused tests prove the route, authorization, navigation, responsibility, provider-switching, empty, and preserved-contract behavior.
