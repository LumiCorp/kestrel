# Add Platform-owned Google and Microsoft registration management

## Useful outcome

A Platform Admin can configure the Google Workspace and Microsoft 365 OAuth applications that Kestrel One uses for personal integrations. The administrator can see exactly which callback URI and capability-derived scopes to register with each provider, save a hosted client ID and secret, enable only supported packs, rotate credentials, and disable the registration.

This is the Platform foundation for the Personal Productivity Integrations Product Brief. It makes Platform settings, not provider-specific environment variables, the source of registration authority.

## What changes

Add a Platform Integrations surface beside the existing Platform email configuration. It manages one global hosted registration for each in-scope provider: Google Workspace and Microsoft 365.

The surface must store client identity, encrypted hosted secret, enabled packs, provider tenant or issuer setting when needed, enabled state, revision, timestamps, and redacted readiness. It must derive callback URIs and exact provider scopes from the shared Google Workspace and Microsoft 365 operation descriptors. It must offer Gmail and Calendar for Google, and Teams for Microsoft. It must not expose Outlook, SharePoint, or arbitrary scope entry.

Only a Platform Admin may read redacted status or save registration changes. Every save, enable, disable, and rotation must create redacted admin audit evidence. Saving a registration must not disclose its secret through the API, browser state, logs, or activity views.

## Requirements and delivery context

- Preserve Better Auth as Kestrel One's user identity and session authority. This issue changes provider-registration ownership only.
- Follow the existing Platform email configuration seam for Platform access, encrypted stored configuration, public redaction, validation, safe errors, and administrative audit.
- Do not use `app_credentials`; that table is Environment-scoped and cannot hold global Platform registration secrets.
- Treat capability descriptors in `src/apps/googleWorkspace.ts` and `src/apps/microsoft365.ts` as the source of pack names and scopes. The UI may select a pack, never free-form scopes.
- A registration revision must change whenever the client identity, secret, tenant or issuer setting, enabled state, or enabled pack set changes.
- A disabled registration may be stored and inspected by a Platform Admin but cannot later start or refresh a personal authorization.
- Desktop provider configuration and Desktop-to-Kestrel One connection are out of scope.

## Done when

- A Platform Admin can configure Google Gmail and Calendar, and Microsoft Teams, with provider-ready callback URIs and scope lists derived from the shared contracts.
- A non-admin cannot read or change registration state.
- Secrets are encrypted at rest and every public response, audit event, and UI model is redacted.
- Saving, rotating, narrowing, enabling, and disabling a registration creates a new revision and a redacted administrative event.
- Tests cover validation, authorization, secret redaction, revision changes, pack-to-scope derivation, and the Outlook/SharePoint exclusion.
- Existing Kestrel One sign-in behavior remains unchanged.
