# Harden the hosted personal authorization broker

## Useful outcome

The hosted broker can only authorize and resolve the exact Kestrel One operation that Organization and Project policy permit. Its callback/return URLs are fixed Platform URLs, and concurrent token refresh cannot degrade a healthy authorization.

## What changes

Repair the issue 02 broker before any Gmail or Teams caller migrates. Derive all callback and settings return URLs from the configured Kestrel One public base URL; never use an incoming request origin. Enforce the Organization-approved pack subset at authorization start.

Replace caller-provided pack, scope, and model-admission assertions at token resolution with a canonical Google Workspace or Microsoft Teams operation/capability identity. Derive required pack and scopes from shared operation descriptors; check the exact effective Project capability and invoke the owning model-admission boundary. Reject an operation that is not selected/effective before token return.

Serialize refresh for each authorization (or implement equivalent revisioned compare-and-set) so a stale concurrent refresh failure re-reads the successful token state rather than degrading it. Add behavioral persistence tests—not source-string tests—for fixed origin, policy rejection, single use, operation binding, admission, and concurrent refresh behavior.

## Requirements and delivery context

- Keep Better Auth as Kestrel One identity/session authority. Do not read its provider tokens.
- Do not add provider-specific caller migrations, Desktop work, Outlook, or live provider configuration.
- The resolver may never accept authorization claims from its caller that it can derive from canonical operation and policy state.
- Preserve encrypted/redacted PKCE and provider tokens and existing Platform registration revision behavior.

## Done when

- Start/callback use the configured public Kestrel One URL only.
- Organization, Project capability, selected pack, canonical required scopes, and model admission are all enforced before token return.
- Concurrent refresh cannot spuriously require reconnect after another refresh succeeds.
- Persistence-backed tests cover the above behavior and secret redaction.

## Depends on

- [02 — Add Kestrel One hosted personal authorization broker](02-add-hosted-personal-authorization-broker.md)
