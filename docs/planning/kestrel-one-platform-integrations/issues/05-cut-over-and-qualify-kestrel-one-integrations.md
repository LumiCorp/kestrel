# Cut over static provider configuration and qualify Kestrel One integrations

## Useful outcome

Kestrel One runs Gmail, Google Calendar, Outlook Mail and Calendar, and Teams only through Platform-owned registrations and the hosted authorization broker. Platform Admins can operate the registrations, and release owners have redacted live proof of the in-scope behavior.

This slice removes the temporary dual authority so a Platform setting is not merely a UI mirror of environment configuration.

## What changes

After Google, Outlook, and Teams consumers use the broker, remove Google and Microsoft provider configuration as a Better Auth initialization authority and remove the provider-specific environment fallback. Keep Better Auth itself for Kestrel One user identity and sessions.

Kestrel One has no real user connections to migrate or preserve. Do not import Better Auth provider tokens or add legacy reconnect compatibility. A deployment may keep its current database or be reinitialized as convenient; neither choice changes the broker contract. Disabled, rotated, narrowed, revoked, and missing-scope registrations must still block hosted provider use. Adding a capability remains a new user-consent boundary.

Perform and retain redacted live qualification using registered Google and Microsoft applications. Verify connection, consent, refresh, read, approved write, disconnect or revocation, and normalized failure behavior for Gmail, Google Calendar, Outlook Mail and Calendar, and Teams. Record deployment revision, Platform registration revision, provider account class, and time without any communication content.

The exact live procedure and evidence boundary are in [the operator runbook](../../../operations/kestrel-one-personal-integrations-live-qualification-runbook.md). This issue is blocked on deployment of the Kestrel One Platform Integrations revision, then the human-owned provider registrations, Platform Admin session, and consent actions described there.

## Requirements and delivery context

- This is the contract phase after the Google, Outlook, and Teams migrations. Do not remove a static provider path while an in-scope Kestrel One caller still depends on it.
- No existing provider token, connection, or historical authorization needs migration. Keeping the current database is supported; it simply starts without a legacy-provider compatibility layer.
- Preserve Better Auth Kestrel login, user session, and unrelated provider behavior.
- A release claim must cover only Kestrel One. Desktop-to-Kestrel One connection and Desktop provider OAuth remain follow-on work.
- SharePoint remains outside this release and absent from qualification and release claims.
- Use exact redacted evidence. Mocked tests, a single provider read, or one host's success cannot substitute for the defined live qualification.

## Done when

- Kestrel One has no in-scope Google or Microsoft connection, refresh, runtime, or approval caller that relies on provider-specific environment configuration or Better Auth provider initialization.
- No legacy provider token or connection migration path exists. Any new personal authorization is broker-owned whether the deployment keeps its current database or reinitializes it.
- Platform disable, rotation, and scope reduction stop affected hosted token use until reconnection; adding a pack requests new consent.
- Redacted live evidence covers Gmail, Google Calendar, Outlook Mail and Calendar, and Teams connection, refresh, read, approved write, disconnect or revocation, and a representative normalized failure path.
- Full portable validation passes, and any unrelated baseline failures are recorded separately rather than attributed to this delivery.
- Release notes and operator guidance describe the Platform registration workflow, supported capability boundary, and the exclusion of SharePoint and Desktop work.

## Depends on

- [03 — Move Google Workspace connections and actions to the Kestrel One broker](03-move-google-workspace-to-hosted-broker.md)
- [04 — Move Teams connections and actions to the Kestrel One broker](04-move-teams-to-hosted-broker.md)
- [12 — Move Outlook Mail and Calendar to the Kestrel One broker](12-move-outlook-to-hosted-broker.md)
