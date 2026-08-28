# Platform OAuth Registrations Change Design

## Executive Summary

Move Google Workspace and Microsoft 365 OAuth application registrations into the Platform control plane. A Platform Admin configures the registered client, chooses supported capability packs, and can rotate or disable a registration. Kestrel then lets an individual connect their own Gmail, Google Calendar, Outlook Mail and Calendar, or Teams account within those limits.

Use a dedicated hosted OAuth broker for web connections. It reads runtime Platform configuration, creates short-lived PKCE authorization sessions, stores a user's provider tokens encrypted, and refreshes them for the existing Gmail, Calendar, Outlook, and Teams runtime callers. This replaces the current static Google and Microsoft provider configuration sourced when Better Auth initializes. Better Auth remains Kestrel One's identity and session authority.

Kestrel One is the integration system of record for this change. Platform registrations, user connections, token refresh, policy evaluation, approval, and audit stay in Kestrel One. Kestrel One continues to use Better Auth for Kestrel identity and sessions. Desktop-to-Kestrel One connection follows only after this Kestrel One integration work. SharePoint remains deferred.

## Requested Outcome

A Platform Admin needs one place under **Platform** to configure the OAuth applications registered with Google and Microsoft. The page must show the exact redirect URI and capability-derived scopes to register in each provider console. It must store the hosted client secret securely and expose only redacted status.

Organizations and Projects must only narrow the Platform limits. An individual must consent to their own provider account. Kestrel must never confuse the application registration, Organization policy, Project grant, Kestrel user, provider account, and provider token.

## The Four Configuration Layers

| Layer | Owner | Stores or decides | Must not contain |
| --- | --- | --- | --- |
| Platform registration | Platform Admin | Provider, Kestrel One client ID and secret, tenant settings, enabled packs, revision, derived callback URL | A user's password or provider tokens |
| Organization App policy | Organization | Whether the App is offered and the subset of Platform packs it permits | Client secrets or a broader provider scope |
| Project grant | Project policy | Which eligible connection and capabilities are usable in that Project | OAuth client details or a provider grant |
| Personal authorization | Individual | Provider account identity, consented scopes, encrypted token set, registration revision | An Organization's admin credentials |

The Kestrel user ID identifies the person inside Kestrel. It is neither the Google or Microsoft account ID nor an OAuth client ID. The person signs in to Kestrel with their Kestrel password, passkey, or session. Kestrel never sends that credential to Google or Microsoft. The external provider identifies the person's account during the consent callback and issues the grant and tokens.

The existing `app_connections` record stays Organization-scoped. It is the current visibility and Project-use boundary for a personal connection. The user still owns the provider authorization, but connecting in a second Organization requires an explicit second connection. That prevents accidental cross-Organization token sharing. A future user-level account vault can be designed separately if reuse becomes a product requirement.

## Relevant Current Behavior

Platform already provides a protected configuration area and an encrypted, redacted configuration pattern for email. The Platform layout requires an admin and the email API saves configuration, returns public status, and records an admin event ([layout](../../apps/web/app/(workspace)/platform/layout.tsx), [email route](../../apps/web/app/api/platform/email/route.ts), [email configuration](../../apps/web/lib/email/config.ts)).

Google and Microsoft provider registrations are read from Platform settings at connection and token-resolution time. The hosted broker creates the personal `app_connections` record and its encrypted authorization, while Better Auth supplies only the Kestrel One user session. Gmail, Google Calendar, Outlook, Teams, and Gmail approval preparation retrieve provider tokens from the broker ([auth](../../apps/web/lib/auth.ts), [Google route](../../apps/web/app/api/apps/google/route.ts), [Microsoft route](../../apps/web/app/api/apps/microsoft-365/route.ts)).

The existing `app_credentials` table is tied to an Organization and an environment. A personal connection has no environment credential by design. It must not be reused for platform registration secrets or user OAuth token sets ([schema](../../apps/web/drizzle/schema.ts)).

Desktop currently has separate local provider OAuth and a partial Kestrel One account protocol. They are not part of this change. They are input to the follow-on Desktop-to-Kestrel One connection work and must not change the Kestrel One integration boundaries ([Desktop account route](../../apps/web/app/desktop/auth/authorize/route.ts), [credential service](../../apps/web/lib/desktop-account.ts), [Desktop Local Core client](../../src/localCore/kestrelOneAccount.ts)).

## External Findings That Shaped the Design

Google classifies `gmail.readonly` as restricted and `gmail.send` as sensitive. The Platform UI must therefore show exact, descriptor-derived scopes rather than accept arbitrary scope strings. [Google scope classifications](https://support.google.com/cloud/answer/13807380?hl=en).

Microsoft's OAuth model keeps the hosted Kestrel One client confidential. The registration secret remains only in Kestrel One. [Microsoft web application configuration](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-web-app-registration).

## Options and Candidate Seams

### Keep Better Auth provider configuration

This preserves current account rows, but providers are configured when the web process starts. A Platform Admin change would still require process-level configuration and a restart. It does not meet the requested source of authority.

### Store Platform configuration but mirror it to environment variables

This adds a settings screen without changing authority. Secret rotation remains a deployment operation. It does not meet the no-provider-environment-variable requirement.

### Retain Better Auth for Kestrel One identity and add runtime provider registration authority

Better Auth remains Kestrel One's identity and session authority. A Kestrel One integration service reads runtime Platform registration data on each provider connect, callback, and refresh, using the Better Auth Kestrel user/session as its caller identity. This moves provider registration authority out of static environment configuration without replacing Better Auth. This is the selected design.

## Proposed Delta

### Platform registration records

Add `platform_oauth_registrations`, keyed by provider:

- `provider`: `google_workspace` or `microsoft_365`.
- `client_id`.
- `encrypted_client_secret`.
- provider tenant or issuer setting when needed.
- enabled capability packs, selected only from the existing shared descriptors.
- `enabled`, `revision`, redacted verification status, and audit timestamps.

The Platform Integrations page shows Google Workspace and Microsoft 365 cards. The page derives its scopes and callback URLs from the selected packs. It never accepts a free-form scope string.

For the hosted registrations, the Platform page displays the fixed callbacks Kestrel must register:

- `https://kestrelagents.dev/api/integrations/oauth/google-workspace/callback`
- `https://kestrelagents.dev/api/integrations/oauth/microsoft-365/callback`

The actual domain is derived from the configured Kestrel public base URL. It is not supplied by a browser request.

### Hosted OAuth broker

Replace the Google and Microsoft Better Auth link flows with a focused broker. It owns these states:

1. The user starts a connection and selects a subset of Organization-permitted packs.
2. The broker checks the Platform registration is enabled and derives the exact provider scopes.
3. The broker stores a short-lived, single-use authorization session: user, Organization, connection target, registration ID and revision, chosen packs, PKCE verifier, and fixed return target.
4. The provider callback validates that session, exchanges the code with the current hosted registration, verifies the provider account, and creates or updates the personal connection.
5. The broker writes one encrypted personal authorization record for that connection. It contains the provider account ID, granted scopes, encrypted token payload, expiry, and registration revision.
6. Gmail, Calendar, Outlook, Teams, and approval preparation ask one broker service for an access token. The service checks registration state, revision, capability, and granted scopes before refreshing or returning a token.

`app_connections` remains the policy-facing and user-facing connection. Add a one-to-one `personal_oauth_authorizations` record for the encrypted provider grant. Bind encryption to that authorization or connection ID. Reuse the deployment-managed encryption root, but use distinct authenticated-data bindings for Platform registration secrets and user tokens. Do not store either in `app_credentials`.

### Policy and grant evaluation

Every provider action must pass the same ordered checks:

1. The Platform registration for the relevant surface is enabled and permits the pack.
2. The Organization App policy permits that pack.
3. The Project policy permits the personal connection and capability in that Project.
4. The personal authorization belongs to the acting Kestrel user, is connected at the current registration revision, and includes the needed scope.
5. Existing runtime policy and per-action approval checks permit the specific action.

Each later layer can restrict the earlier layer. No later layer can expand it.

## Desktop Follow-on Boundary

Desktop-to-Kestrel One connection follows this change. It must establish and prove its real account session against supported Kestrel One instances before it consumes any Kestrel One integration API. This design neither changes Desktop provider OAuth nor decides the later Desktop integration-client contract.

## Transition and Coexistence

1. **Unconfigured:** no new broker connection begins. Existing Better Auth paths remain only for the bounded cutover.
2. **Configured but disabled:** an admin can verify the redacted registration state, but Kestrel cannot start or use a connection.
3. **Configured and enabled:** new hosted connections use the broker. New personal authorization records carry the Platform registration revision.
4. **Rotation or scope reduction:** the broker marks affected hosted personal connections degraded with a reconnect reason and refuses provider access. Adding a pack never adds a scope to an existing user grant.
5. **Cutover complete:** remove Google and Microsoft provider configuration from Better Auth and the provider-specific environment fallback. Desktop remains unchanged.

This is a fresh-database cutover. There are no real user connections to preserve, and Kestrel does not import Better Auth provider tokens into the broker authorization store.

## Decisions

- Platform OAuth registration is a global, runtime-stored record. The Platform Admin is the only writer. Confidence: high.
- Better Auth remains Kestrel One identity and session authority. The Platform integration service changes provider registration ownership only. Confidence: high.
- Desktop-to-Kestrel One connection is a separate follow-on change. Confidence: high. It must not replace or block Kestrel One integration completion.
- Capability packs are selected from source-controlled descriptors. The Platform UI derives scopes and redirects; it does not take free-form provider scopes. Confidence: high.
- Existing personal connection records remain Organization-scoped. The individual owns the external authorization, but cross-Organization token sharing is not introduced. Confidence: medium-high.
- A hosted client change, secret rotation, or scope reduction requires reconnect. Kestrel does not silently reuse an older grant. Confidence: high.

## Resulting Boundaries

Kestrel One owns OAuth registration, consent, provider tokens, refresh, policy, approval, provider calls, and audit for this integration release. Desktop stays unchanged. The follow-on Desktop-to-Kestrel One connection design starts from a live-proven account session and may then determine how Desktop consumes Kestrel One integration capabilities.
