# Create private Triggers before inbound activation

## Failed behavior

The Work-level create form omits `enabled`, while the Trigger store defaults an omitted value to enabled and requires `inboundEnabled=true` plus an active provider webhook. Issue 01 deliberately leaves receiving staged and disabled until Issue 08, so the normal UI cannot create the Trigger configuration needed by the intervening delivery slices. The PostgreSQL test only proves the hidden direct-store `enabled:false` path.

## Affected work

This repairs [Let Project editors manage private Email Triggers](02-manage-private-project-email-triggers.md) in change `73c5375f3..049c82bef`, specifically create-time enablement selection in the Trigger store, API, UI, and PostgreSQL contract.

## Repair requirements

Keep full active receiving health as the server-owned prerequisite for enabling a Trigger. When the authenticated create flow does not explicitly request an enabled state, atomically create the Trigger enabled if current receiving health permits it and disabled otherwise. Preserve explicit `enabled:true` rejection when receiving is not ready, explicit `enabled:false`, Project and Execution Owner authority, model availability, and the minimal create form without adding a public mode or owner selector. Do not weaken Issue 08's ownership of provider webhook activation.

## Done when

- The actual UI create request succeeds against the healthy staged connection produced before Issue 08 and returns a disabled private Trigger.
- The same omitted-enabled request creates an enabled Trigger when receiving is fully active and healthy.
- Explicit enablement still rejects staged, disabled, or unhealthy receiving.
- Tests prove both pre-activation and active paths without a client-supplied readiness boolean.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
