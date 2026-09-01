# Make hosted broker policy current and refresh failure durable

## Failed behavior

The hosted broker can retain authority that an Organization or provider has revoked.

If an Organization narrows `personalOAuthPacks` after a user has started authorization, the callback can still complete the old session. Existing connections can also continue resolving a now-disallowed pack because the resolver checks only historical selected packs. A malformed stored pack policy is treated as absent, which widens access instead of failing closed.

During refresh, a provider can return a narrower scope set than the authorization record. The broker returns the new access token after checking stale stored scopes. A refresh failure attempts to degrade the connection inside a transaction that then throws, rolling the degraded state back and causing repeated refresh attempts instead of a durable reconnect requirement.

## Affected work

- [02 — Add Kestrel One hosted personal authorization broker](02-add-hosted-personal-authorization-broker.md)
- [09 — Harden the hosted personal authorization broker](09-harden-hosted-personal-authorization-broker.md)
- Commit `70bf50db2`, `apps/web/lib/integrations/hosted-personal-oauth.ts`

## Repair requirements

- Treat the current Organization pack policy as a restrictive ceiling at authorization completion and token resolution, not only at start. Reject invalid stored policy instead of treating it as omitted.
- When a refresh response supplies scopes, persist the actual resulting scopes and refuse or degrade an operation whose canonical scopes are no longer granted before returning its token.
- Persist a failed-refresh reconnect state before reporting failure, including when the token request fails inside serialized refresh work.
- Preserve encrypted/redacted token storage, fixed callback URLs, canonical descriptor authority, Project capability checks, Gmail execution admission, and the serialized refresh guarantee.
- Do not add provider caller migrations, Desktop work, Outlook, live provider configuration, or Better Auth provider-token access.

## Done when

- An Organization narrowing or malformed pack policy prevents both completion of a pending disallowed authorization and later use of an existing disallowed connection.
- A scope-reducing refresh never returns a token for an operation that no longer has its canonical scopes; its persisted connection state requires reconnect when appropriate.
- A failed refresh leaves persisted degraded/reconnect state that a later resolver call observes.
- Persistence-backed regression tests cover each trigger and token data remains redacted.
- The affected issues' original outcomes and constraints still hold.

## Depends on

- [09 — Harden the hosted personal authorization broker](09-harden-hosted-personal-authorization-broker.md)
