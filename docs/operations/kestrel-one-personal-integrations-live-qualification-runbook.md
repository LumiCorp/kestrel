# Kestrel One Personal Integrations Live Qualification

## Outcome

Kestrel One uses Platform-owned OAuth registrations to connect a person's Gmail, Google Calendar, Outlook Mail and Calendar, and Teams account. This verifies the real provider redirect, consent, refresh, read, approved write, and revoke or disconnect paths. It does not change Desktop or enable SharePoint.

## Authority Boundary

- Agent may: inspect and change local Kestrel One code, run local validation, and review redacted evidence.
- Human must: create or edit Google and Microsoft app registrations, enter client secrets into Kestrel One, sign in as a Platform Admin and as a test user, and approve any test message or calendar change.
- Separately authorized external effects: none. Do not create provider registrations, send messages, or create calendar events until the operator chooses to do so.

## Current State

The Kestrel One broker and Platform Integrations UI are implemented. On August 28, 2026, the local production build emitted both `/platform/integrations` and `/api/platform/integrations`. A current unauthenticated request to `/platform/integrations` redirects to sign-in, which does not prove the page route is deployed because the authentication layer redirects unknown protected paths too. The Platform API currently returns Vercel's 404 response, so the deployed revision does not include the Platform Integrations API. The deployed Kestrel One revision must be updated before a Platform Admin can configure OAuth. The active local app has no signed-in Platform Admin session or real Google/Microsoft application registration.

## Prerequisites

- [ ] Kestrel One is deployed from the current validated revision or a later revision containing `/platform/integrations` and `/api/platform/integrations`.
- [ ] A Platform Admin can open and sign in to `https://kestrelagents.dev/platform/integrations`.
- [ ] A separate disposable Google account and Microsoft work or school account are available for the test.
- [ ] The operator can create a Google OAuth web client and a Microsoft Entra web app registration.
- [ ] The deployed Kestrel One origin is `https://kestrelagents.dev`.

## Sensitive Inputs

| Input name | Obtained from | Entered into | Persisted |
| --- | --- | --- | --- |
| Google client ID | Google OAuth client | Kestrel One Platform Integrations | Kestrel One encrypted registration store |
| Google client secret | Google OAuth client | Kestrel One Platform Integrations | Kestrel One encrypted registration store |
| Microsoft client ID | Microsoft Entra app registration | Kestrel One Platform Integrations | Kestrel One encrypted registration store |
| Microsoft client secret | Microsoft Entra app registration | Kestrel One Platform Integrations | Kestrel One encrypted registration store |
| Microsoft tenant ID, if tenant-specific | Microsoft Entra tenant | Kestrel One Platform Integrations | Kestrel One encrypted registration store |

## Stages

### 1. Deploy the Kestrel One Platform Integrations revision

- Preconditions: The local production build and `pnpm validate` pass for the candidate revision.
- Actor: Human release owner.
- Action: Deploy the current Kestrel One revision through the normal release path. Confirm that `https://kestrelagents.dev/platform/integrations` no longer returns Not Found and that `https://kestrelagents.dev/api/platform/integrations` is present but admin-gated.
- Confirmation gate: The release owner confirms immediately before the deployment or promotion.
- Expected result: The deployed site serves the Platform Integrations route and its admin API.
- Evidence: Deployment revision, deployment time, route status, and redacted unauthenticated or admin-gated response. Do not retain session cookies or credentials.
- Stop condition: Either route remains Not Found or the deployment fails its configured migration or build.
- Recovery or rollback: Restore the prior deployment through the normal release process and preserve the deployment error or route result.
- Resume checkpoint: Reopen both deployed routes and record the exact revision before entering OAuth configuration.

### 2. Register the two hosted OAuth clients

- Preconditions: The target deployment origin is confirmed as `https://kestrelagents.dev`.
- Actor: Human Platform Admin.
- Action: Create a Google OAuth web client with this redirect URI:
  `https://kestrelagents.dev/api/integrations/oauth/google-workspace/callback`.
  Create a Microsoft Entra web app registration with this redirect URI:
  `https://kestrelagents.dev/api/integrations/oauth/microsoft-365/callback`.
  Use the scopes displayed by Kestrel One after selecting packs: Google Gmail and Google Calendar; Microsoft Outlook and Teams.
- Confirmation gate: The operator confirms immediately before creating each provider registration or client secret.
- Expected result: Each provider supplies a client ID and a client secret. The provider allows the listed redirect URI.
- Evidence: Provider name, redirect URI, account class, and registration time. Do not retain client IDs, secrets, authorization codes, access tokens, refresh tokens, or communication data.
- Stop condition: The provider rejects a redirect URI or a displayed scope.
- Recovery or rollback: Disable or delete the newly created test registration in that provider console. Do not change Kestrel One settings.
- Resume checkpoint: Reopen the provider registration and confirm its redirect URI matches this document exactly.

### 3. Configure Kestrel One Platform Integrations

- Preconditions: Stages 1 and 2 succeeded and the operator is signed in as a Platform Admin.
- Actor: Human Platform Admin.
- Action: Open `https://kestrelagents.dev/platform/integrations`. Save the Google client ID and secret with Gmail and Calendar enabled. Save the Microsoft client ID and secret with Outlook and Teams enabled; enter `Organizations` or an allowed tenant GUID only when the Microsoft registration requires a tenant. Enable both registrations.
- Confirmation gate: The operator confirms immediately before saving each secret into Kestrel One.
- Expected result: Both cards show `ready`, an enabled state, the expected callback URI, and the pack-derived scopes.
- Evidence: Redacted card status, registration revision, enabled packs, and time.
- Stop condition: A card reports configuration error or does not show the expected callback URI and packs.
- Recovery or rollback: Disable the Kestrel One registration. Correct the provider registration or secret, then save a new revision.
- Resume checkpoint: Reload the page and confirm the enabled packs and revision are still present.

### 4. Connect test accounts and exercise the supported paths

- Preconditions: Both Platform registrations are `ready`; the test user belongs to an organization approved for the requested packs.
- Actor: Human test user.
- Action: In Kestrel One Connections, connect Google with Gmail and Calendar, then Microsoft 365 with Outlook and Teams. Complete provider consent in the same signed-in Kestrel One browser session. Confirm a read for each capability. Confirm each approved write on the test account before it runs: send one test Gmail, send one test Outlook email, create one test Google Calendar event, and send one Teams test message.
- Confirmation gate: The operator confirms immediately before each message send or calendar creation.
- Expected result: The callback returns to Kestrel One Connections with `connected`; each read and confirmed write succeeds only for the selected pack.
- Evidence: Provider, pack, connection status, operation category (`read` or `approved write`), account class, Kestrel One registration revision, time, and result code. Do not retain message text, recipients, calendar details, or provider tokens.
- Stop condition: Consent does not return to Kestrel One, a selected capability is unavailable, or a read or approved write fails.
- Recovery or rollback: Stop the test. Preserve the redacted error code and registration revision. Remove the test message or calendar event manually if it was created. Do not rotate credentials until the failure is recorded.
- Resume checkpoint: Recheck the connection status and Platform registration revision before retrying one failed operation.

### 5. Verify refresh and loss of authority

- Preconditions: Stage 4 has a connected test account for each provider.
- Actor: Human Platform Admin and test user.
- Action: Force one normal token refresh using the provider's test-account or session controls, then confirm one read succeeds. Use Kestrel One Connections to disconnect the account and confirm a subsequent operation is denied. Finally, disable one Platform registration and confirm its connected provider can no longer be used; re-enable it only after recording the result.
- Confirmation gate: The operator confirms immediately before disconnecting an account or disabling a Platform registration.
- Expected result: Refresh preserves an authorized connection; disconnect and disable remove runtime authority and produce a normalized reconnect or unavailable response.
- Evidence: Redacted status before and after each change, failure code, registration revision, and time.
- Stop condition: A disconnected or disabled registration can still run a provider operation.
- Recovery or rollback: Leave the affected registration disabled, preserve redacted evidence, and return the issue to implementation. If the test simply needs to continue, re-enable the registration and reconnect the test account.
- Resume checkpoint: Reload Platform Integrations and Connections, then confirm the current registration revision and connection state.

## Completion Criteria

- [ ] Google and Microsoft registrations are `ready` in Kestrel One Platform Integrations.
- [ ] Gmail, Google Calendar, Outlook Mail and Calendar, and Teams each have redacted live connection, refresh, read, and approved-write evidence.
- [ ] A disconnect or revoked authorization and a disabled Platform registration deny use and request reconnection or correction.
- [ ] Evidence contains no credentials, provider tokens, message bodies, recipients, calendar content, or other communication content.
- [ ] SharePoint and Desktop remain outside the release claim.

## Owning Workflow Resume Condition

Return to issue 05 with the redacted evidence above and the currently deployed Kestrel One revision. Recheck both Platform registration revisions and connection states before marking the issue implemented or reviewing it.
