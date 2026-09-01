# Clear revoked Desktop receiving status

## Failed behavior

After Desktop has loaded a member-visible receiving projection, a later 401 or 403 refresh records an error but retains and continues rendering the cached Organization status. Revoked authentication or membership can therefore leave stale tenant data visible indefinitely.

## Affected work

This repairs [Show redacted receiving status to non-Admin Organization members](14-show-redacted-receiving-status-to-members.md) in change `f44949ffb..5b96e7171`, including Desktop refresh failure handling and the Local Core hosted-account error boundary.

## Repair requirements

An authorization rejection for a receiving read must clear the cached receiving projection immediately and refresh or invalidate the corresponding account authority without signing the user out of unrelated Organizations. Ordinary transient provider failures may retain last-known status only if it remains visibly identified as stale; they must not be confused with authorization loss. Late responses and selection changes remain epoch guarded.

## Done when

- A Desktop interaction regression starts with visible receiving status, then returns 401 and 403 refresh failures and proves the old status is removed.
- Membership loss refreshes or invalidates the selected Organization authority without widening access or signing out unrelated valid memberships.
- A late pre-revocation response cannot restore the cleared projection.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
