# Platform OAuth Registrations Design Notebook

## Current Position

OAuth application registration is Platform-owned configuration. A Platform Admin stores and rotates the hosted client identifiers and secrets, configures the allowed capability packs, and sees readiness under **Platform**. Kestrel must not require provider-specific environment variables.

Hosted personal Google Workspace and Microsoft 365 connections must move off Better Auth provider configuration. Better Auth constructs those providers when the process starts, while Platform configuration must be read and changed at runtime. A dedicated OAuth broker is therefore the leading seam.

The primary change is to complete personal Gmail, Google Calendar, and Teams integrations in Kestrel One. Kestrel One uses Better Auth for Kestrel identity and sessions. Platform-owned provider registrations replace only the present static Google/Microsoft provider configuration; they do not replace Better Auth.

Desktop-to-Kestrel One connection is a separate follow-on change. It must not reshape, delay, or silently substitute for the Kestrel One integration work. The current Desktop account protocol is relevant evidence for that next change, but no Desktop code, provider-token migration, or Desktop action API is part of this Kestrel One integration design.

## Requested Change

A Platform Admin configures the Google Workspace and Microsoft 365 application registrations in Kestrel's Platform area. The configuration covers provider-specific client details and the capability packs Kestrel may request. Personal users then connect their own Gmail, Google Calendar, or Teams account within that Platform-approved ceiling.

Scenarios:

1. A Platform Admin saves the hosted Google registration and enables Gmail and Calendar packs.
2. A Platform Admin saves the hosted Microsoft registration and enables the Teams pack. Outlook remains deferred and unavailable.
3. A user connects a personal account. Kestrel requests only packs selected by the user and permitted by the Platform registration.
4. A Platform Admin rotates a registration or removes a pack. Kestrel stops using affected personal connections until the user reconnects. It does not silently gain new scopes.
5. After Kestrel One integrations are complete, Desktop connects and authenticates to Kestrel One as its own follow-on change.

## Starting Sources

- `apps/web/app/(workspace)/platform/layout.tsx`
- `apps/web/components/platform/platform-navigation.tsx`
- `apps/web/app/api/platform/email/route.ts`
- `apps/web/lib/email/config.ts`
- `apps/web/lib/auth.ts`
- `apps/web/app/api/apps/google/route.ts`
- `apps/web/app/api/apps/microsoft-365/route.ts`
- `apps/web/lib/integrations/google-calendar-oauth.ts`
- `apps/web/lib/integrations/microsoft-365-oauth.ts`
- `apps/web/app/api/runtime/{gmail,google-calendar,microsoft-365}/action/route.ts`
- `apps/desktop/src/main.ts`
- `apps/desktop/src/appConnectionConfig.ts`
- `src/localCore/kestrelOneAccount.ts`
- `apps/web/lib/desktop-account.ts`
- `src/localCore/{googleWorkspaceOAuthSessions,microsoft365OAuthSessions}.ts`
- `src/apps/{googleWorkspace,microsoft365}.ts`
- Google and Microsoft OAuth documentation recorded below.

## Relevant Current Behavior

- Platform routes already require Platform Admin access and have a dedicated Configure navigation group. Platform email stores an encrypted credential, exposes only redacted status, and records admin audit events.
- Hosted Google and Microsoft registrations are read from `GOOGLE_*` and `MICROSOFT_*` environment variables when `apps/web/lib/auth.ts` is loaded. Better Auth then owns account linking, token refresh, and the `accounts` record.
- The Google and Microsoft connection routes call Better Auth to start linking, read access tokens, and then create a personal `app_connections` record. Runtime Gmail, Calendar, Teams, and Gmail approval preparation also call Better Auth for access tokens.
- Desktop currently has separate local provider OAuth and a Kestrel One account path. Those paths are outside the Kestrel One integration change. They inform the follow-on Desktop-to-Kestrel One connection design but are not being redesigned here.
- Shared operation descriptors already define the narrow capability scopes. Google supports `calendar` and `gmail`; active Microsoft delivery supports `teams`. Outlook and SharePoint are deferred.

## Affected Surface

- Platform admin navigation, page, API, and audit activity.
- Platform-owned encrypted registration data and migration/reconciliation evidence.
- Hosted OAuth authorization sessions, callbacks, token refresh, and personal authorization storage.
- Hosted Google, Gmail, and Microsoft/Teams connection routes and runtime access-token consumers.
- No Desktop code or Desktop-to-Kestrel One account contract changes in this change. The later Desktop connection work must prove its real account flow before it relies on Kestrel One services.
- Existing personal app connection status, project attachment, capabilities, approvals, and audit behavior.

## External Research

- Google classifies `gmail.readonly` as restricted and `gmail.send` as sensitive. Source: https://support.google.com/cloud/answer/13807380?hl=en. Design effect: the Platform screen must show exact capability-derived scopes and a verification/readiness warning; it must not accept arbitrary scopes.

## Candidate Seams and Options

### A. Keep Better Auth and load Platform configuration at startup

This preserves current accounts and token handling, but a saved registration cannot take effect predictably without a process restart. It also leaves provider-specific environment configuration as the authority. Reject.

### B. Create Platform configuration but mirror it into provider-specific environment variables

This creates a settings screen without changing actual authority and makes secret rotation a deployment operation. Reject.

### C. Add a dedicated Platform OAuth broker and credential store

The broker reads Platform registration data for each connect, callback, and refresh. It owns authorization state and encrypted personal tokens. Existing personal App connections remain the policy and user-facing connection record. This fits runtime configuration and removes Google/Microsoft from Better Auth. Chosen.


## Proposed Delta

Add a single Platform Integrations page that holds two provider cards: Google Workspace and Microsoft 365. Each card has explicit capability-pack toggles, derived read-only scopes and callback URLs, redacted readiness, save/rotate/disable actions, and audit history.

Add a dedicated hosted OAuth broker. It creates single-use PKCE authorization sessions, exchanges callbacks against the current registration, stores personal access and refresh tokens encrypted under the personal connection identity, and supplies access tokens to all hosted Google, Gmail, and Teams callers through one service.

Platform configuration is the capability ceiling. Organization App policy can only narrow that ceiling. A Project grant attaches an allowed personal connection and capability to work in one Project. Personal connection choices can request only a subset. Changing the client identity, secret, tenant, or allowed packs invalidates the relevant hosted authorizations and requires reconnect. Disabling a registration blocks new connections and token use. Existing approvals, runtime capability policy, and per-action approval requirements remain unchanged.

Desktop behavior is unchanged by this design. The future Desktop-to-Kestrel One connection work will determine how Desktop consumes completed Kestrel One integrations.

## Domain Model

- **Platform OAuth registration:** global provider configuration owned by a Platform Admin. It includes the client identity, encrypted hosted secret, allowed packs, and revision.
- **Platform registration:** a confidential Kestrel One OAuth client. Its secret never leaves the server.
- **Platform capability ceiling:** the provider packs a Platform Admin permits Kestrel to request. It is derived from shared operation descriptors, not free-form scope strings.
- **Personal authorization:** a user's provider grant and encrypted token set, tied to one Platform OAuth registration revision and one personal App connection.
- **Personal App connection:** the existing policy, project-attachment, and user-visible record. It is not the OAuth application registration.
- **Organization App policy:** the Organization-level decision to offer an App and to allow some of the Platform-approved packs. It cannot add a provider scope or client.
- **Project grant:** the existing Project-level attachment and capability policy that allows a named personal connection to be used in one Project. It cannot create an OAuth grant.

### Ownership boundary clarified

The configuration has four separate levels. Platform configuration is global registration authority. Organization configuration decides whether an Organization offers an installed App and which Platform-approved capabilities it permits. Project configuration attaches an eligible connection to a Project and limits its use there. Personal configuration is a user's consented external account. A user ID identifies the Kestrel person; it is not an OAuth client identity, provider account ID, client secret, or access grant.

The personal authorization remains logically owned by the user, but this change retains the existing Organization-scoped `app_connections` row as its visibility and use boundary. A person connects again in another Organization rather than silently sharing a token across Organizations. The new token record is one-to-one with that personal connection. Organization administrators can manage policy and see redacted status; they never receive the user's provider token.

Invariants:

1. Only a Platform Admin can read redacted registration status or save registration data.
2. No response, audit event, browser state, or Desktop configuration contains a hosted client secret, access token, refresh token, authorization code, or PKCE verifier.
3. A personal authorization is usable only while its registration is enabled, its revision matches, and its granted scopes cover the requested capability.
4. Platform scope changes never silently expand an existing personal authorization.
5. Outlook remains unavailable in this change.
6. Kestrel sign-in credentials authenticate a person to Kestrel. They are never sent to Google or Microsoft. The external provider account ID and OAuth grant are returned by the provider after that person consents.
7. The Desktop-to-Kestrel One account flow is not evidence for this Kestrel One integration release. It must be proven separately against supported Kestrel One instances before later Desktop work can rely on it.

## Transition States

1. **Unconfigured:** no new hosted connection begins. Existing environment-variable registrations continue only during the explicit cutover window.
2. **Configured and disabled:** registration is stored and testable but cannot initiate or use personal authorizations.
3. **Configured and enabled:** new connections use the Platform broker. New personal authorizations carry the registration revision.
4. **Rotated or narrowed:** connected authorizations become `degraded` with a reconnect reason. Kestrel does not use them.
5. **Cutover complete:** Google and Microsoft provider configuration is removed from Better Auth and provider-specific environment fallback is deleted.

## Decisions

- Choose a Platform-owned OAuth broker over dynamic Better Auth configuration. Confidence: high. Better Auth initializes providers before runtime configuration can be read.
- Model scopes as capability packs with descriptors as the source of truth. Confidence: high. This prevents a Platform Admin from entering a scope that Kestrel cannot enforce or explain.
- Treat registration changes as a reconnect boundary. Confidence: high. This prevents tokens issued to one client/scope ceiling from being reused under another.
- Keep personal tokens per Organization connection for this change. Confidence: medium-high. It preserves the current Organization boundary and avoids silently introducing cross-Organization token sharing. Reopen if the product explicitly needs a user-level external-account vault.
- Add one `personal_oauth_authorizations` row per personal App connection. Confidence: high. It separates the encrypted user provider grant from both Platform registration secrets and environment-scoped `app_credentials`.
- Use one-time reconnect instead of Better Auth token import. Confidence: high. Import would copy a sensitive token boundary without reliable registration-revision provenance.
- Keep Better Auth as Kestrel One identity and session authority. Confidence: high. The change moves provider registration authority, not Kestrel user authentication.
- Defer Desktop-to-Kestrel One connection until Kestrel One integrations are complete. Confidence: high. The prerequisite order prevents an incomplete Desktop account path from distorting the Kestrel One integration design.

## Research and Prototypes

- No prototype is needed. The constraint is structural: Better Auth receives Google/Microsoft credentials in module initialization, while the requested Platform setting is runtime data.

## Active Change Frontier

No consequential unresolved question remains for the Kestrel One integration design. Desktop-to-Kestrel One authentication is deliberately outside this change and follows after Kestrel One integration completion.

## Decision Map

- Status: not needed
- Path: none
- Destination: none
- Return condition: none

## Best Next Move

Use this Kestrel One design as the basis for the next approved product or implementation artifact. Begin Desktop-to-Kestrel One connection work only after this integration work is complete.
