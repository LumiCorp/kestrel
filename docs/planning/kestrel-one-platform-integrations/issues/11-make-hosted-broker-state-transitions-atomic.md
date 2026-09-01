# Keep hosted broker policy and reconnect outcomes coherent

## Failed behavior

The hosted broker needs to handle the ordinary policy and refresh outcomes consistently without adding a broad callback/refresh locking framework.

When an Organization changes its pack policy during a provider exchange, the broker should recheck that policy immediately before it persists the resulting connection. When a provider reports fewer scopes after refresh, the connection must require reconnect if any existing granted scope is lost. A connection already marked reconnect-required must report that outcome before a later operation evaluates its missing scope.

## Affected work

- [02 — Add Kestrel One hosted personal authorization broker](02-add-hosted-personal-authorization-broker.md)
- [09 — Harden the hosted personal authorization broker](09-harden-hosted-personal-authorization-broker.md)
- [10 — Make hosted broker policy current and refresh failure durable](10-make-hosted-broker-policy-current-and-refresh-failure-durable.md)
- Commit `934f80a65`, `apps/web/lib/integrations/hosted-personal-oauth.ts`

## Repair requirements

- Recheck the Organization App policy after the provider exchange and before callback persistence. Do not introduce a cross-path lock or new revision system for this release.
- Treat any returned scope loss from the authorization's existing granted-scope envelope as reconnect-required degradation.
- Once reconnect is required, return that outcome before scope denial. Retaining an older diagnostic failure code is not a separate requirement.
- Preserve encrypted/redacted token storage, fixed callbacks, canonical operation descriptors, exact Project capability checks, Gmail execution admission, and no Better Auth provider-token access.
- Do not add Desktop, Outlook, provider caller migration, or live provider configuration work.

## Done when

- An Organization policy narrowing during a provider callback prevents the resulting connection from being persisted.
- A returned scope reduction persists degraded/reconnect state for the connection, even if the triggering operation's own scopes remain present.
- A later resolver call reports reconnect-required before an operation-specific scope denial.
- Persistence-backed tests cover these behaviors and token values remain redacted.
- The affected issues' original outcomes and constraints still hold.

## Depends on

- [10 — Make hosted broker policy current and refresh failure durable](10-make-hosted-broker-policy-current-and-refresh-failure-durable.md)
