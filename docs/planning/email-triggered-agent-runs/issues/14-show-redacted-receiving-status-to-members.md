# Show redacted receiving status to non-Admin Organization members

## Failed behavior

A non-Admin Desktop user sees only a role explanation because the renderer suppresses the read and the hosted GET requires Admin authority. The canonical Product Brief and change design require read-only status without edit authority.

## Affected work

This repairs [Configure Organization Resend receiving in One and Desktop](01-prepare-organization-resend-receiving.md) in change `514b6a8a1..9fff57b6d`, including the Desktop receiving GET authorization boundary and non-Admin state in `apps/desktop/renderer/src/SettingsWorkspace.tsx`.

## Repair requirements

An authenticated Organization member may read only the established redacted receiving projection for that Organization. Domain inspection, credentials, provider identities, route locators, and every mutation remain Admin-only. Desktop must show that status with an explicit read-only role message and must clear it when Organization selection or authentication changes.

## Done when

- An ordinary member can view redacted status for their selected Organization and cannot inspect domains or mutate configuration.
- A member of another Organization and an unauthenticated caller cannot read the projection.
- Multi-Organization selection cannot repaint stale status from a previously selected tenant.
- Focused API and Desktop presentation tests cover the read-only state.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
