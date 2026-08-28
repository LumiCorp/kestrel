# Add Kestrel One hosted personal authorization broker

## Useful outcome

A signed-in Kestrel One user can begin a personal Google or Microsoft authorization that uses the active Platform registration and returns a connection Kestrel One can safely refresh and use. Gmail, Calendar, and Teams will have one hosted authorization and token-access boundary instead of reading provider tokens from Better Auth account rows.

This issue supplies the shared authorization path required before provider-specific connection and runtime routes can move to Platform-owned registration configuration.

## What changes

Add a Kestrel One integration service that uses the existing Better Auth Kestrel session only to identify the acting user. For every provider authorization start, it checks the active Platform registration, Organization App policy, selected pack subset, and fixed return target. It creates a short-lived, single-use PKCE authorization session.

On callback, the service verifies the session, exchanges the provider code with the current Platform registration, verifies the provider account, records the actual granted scopes, and creates or updates the personal App connection. Add one encrypted personal authorization record per personal `app_connections` row. The record stores provider account identity, granted scopes, token payload, expiry, registration revision, and reconnect state.

Expose one internal hosted token resolver. It verifies Platform registration enabled state and revision, Organization and Project policy, user ownership, selected pack, actual granted scopes, and required model admission before returning or refreshing a provider token. It marks an authorization degraded and requires reconnect when the registration revision no longer matches.

## Requirements and delivery context

- Keep Better Auth for Kestrel One login and sessions. Do not create a second Kestrel user-authentication system.
- Use the Platform registration model delivered by issue 01. A provider connection cannot begin without an enabled registration and permitted pack.
- Keep `app_connections` as the Organization-scoped personal connection and Project-use boundary. Connecting in another Organization must require explicit consent; do not create cross-Organization provider-token sharing.
- Do not store Platform secrets or personal provider tokens in `app_credentials`.
- Authorization sessions must bind the Kestrel user, Organization, connection target, provider, selected packs, registration revision, PKCE verifier, expiry, single use, and fixed return target.
- Secrets, OAuth codes, PKCE verifiers, access tokens, and refresh tokens must not enter responses, browser state, approvals, audit, model inputs, or model outputs.
- The broker must provide normalized reconnect and provider-failure state without communication content.
- Desktop work is out of scope.

## Done when

- A signed-in Kestrel One user can start and complete a test Google or Microsoft personal authorization against an enabled Platform registration.
- The completed connection records provider identity, selected packs, actual granted scopes, registration revision, and redacted health state.
- The token resolver refuses disabled, stale-revision, wrong-user, wrong-Organization, wrong-Project, unselected-pack, and insufficient-scope requests before a provider call.
- Rotation or scope reduction degrades the affected personal authorization and requires reconnect; expanding Platform packs does not silently expand an existing grant.
- Tests prove PKCE/session single use and expiry, encryption/redaction, scope and policy enforcement, and token-refresh failure handling.
- Better Auth Kestrel login and non-integration account behavior remain unchanged.

## Depends on

- [01 — Add Platform-owned Google and Microsoft registration management](01-add-platform-oauth-registration-management.md)
