# Move Outlook Mail and Calendar to the Kestrel One broker

## Useful outcome

Kestrel One users can connect a personal work or school Microsoft account for Outlook Mail and Calendar through the Platform-owned Microsoft registration. Outlook runtime reads and approved sends resolve user tokens through the same hosted authorization broker as Teams.

## What changes

Add the Outlook capability pack to the released Microsoft registration descriptors. It has only the existing, least-privilege delegated scopes: `Mail.Read`, `Mail.Send`, and `Calendars.Read`. Platform Admin configuration derives those scopes; it does not accept arbitrary Microsoft Graph scopes.

Extend the hosted broker's canonical Microsoft operation mapping, connection creation, actual-grant checks, and token resolution to Outlook Mail and Calendar. The Microsoft connection UI lets a user select Outlook, Teams, or both; an unselected pack requests no pack scopes. Move Outlook runtime access from the Better Auth account-token path to the broker. Preserve the existing operation contracts and approval semantics for sends.

This is a clean cutover on a newly initialized database. Do not add token import, migration, reconnect compatibility, or historical-data preservation code. SharePoint and Desktop remain outside this issue.

## Done when

- Platform Admins can configure Microsoft registrations for Outlook, Teams, or both, with derived exact scopes and redacted configuration state.
- A Kestrel One user can create a personal Outlook broker authorization; the persisted authorization records the selected pack and actual granted scopes without exposing token material.
- Outlook mail and calendar runtime operations resolve a broker-owned token and reject missing selected-pack or granted-scope access through the existing normalized boundary.
- Outlook sends retain their existing approval and audit contract.
- The Microsoft connection UI presents Outlook and Teams independently, and continues to reject SharePoint as out of scope.
- Focused Microsoft broker, registration, runtime, and type-check validation pass.

## Depends on

- [01 — Add Platform-owned Google and Microsoft registration management](01-add-platform-oauth-registration-management.md)
- [02 — Add Kestrel One hosted personal authorization broker](02-add-hosted-personal-authorization-broker.md)
