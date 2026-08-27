# Trust freshly restored Organization authority

## Failed behavior

After a receiving 401 or 403, Desktop refreshes the account projection but unconditionally removes the rejected Organization from that fresh response. If membership is restored before the account request completes, Desktop discards the new authoritative membership and leaves the Organization unavailable until an unrelated refresh or restart.

## Affected work

This repairs [Clear revoked Desktop receiving status](28-clear-revoked-desktop-receiving-status.md) in change `14b12c2fe..2fb084dda`, specifically account refresh reconciliation in `apps/desktop/renderer/src/SettingsWorkspace.tsx`.

## Repair requirements

Clear rejected receiving data immediately and invalidate older in-flight account responses, then trust the next explicitly newer account response as authoritative without filtering its Organizations. A still-revoked membership remains absent; a concurrently restored membership becomes selectable and may retry receiving. Hosted 401 still reaches signed out, 403 remains Organization-scoped, and late pre-rejection responses cannot restore access.

## Done when

- A 403 regression proves the Organization stays absent when the fresh account response omits it.
- A concurrent-restoration regression proves a fresh account response containing the Organization restores it and allows a new receiving read.
- A pre-rejection account or receiving response cannot restore authority.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
