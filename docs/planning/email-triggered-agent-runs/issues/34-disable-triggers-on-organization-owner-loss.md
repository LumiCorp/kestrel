# Disable Triggers on Organization owner loss

## Failed behavior

Project-specific member removal disables an Execution Owner's enabled Triggers, but Organization membership deletion goes through Better Auth and cascades `project_members` without invoking that service. An enabled Trigger can therefore keep its old revision and enabled state after its owner loses Organization access. Direct user deletion can also fail when `execution_owner_user_id` is set null because the enabled-owner database check rejects the result.

## Affected work

This repairs [Let Project editors manage private Email Triggers](02-manage-private-project-email-triggers.md) in change `73c5375f3..049c82bef`, specifically the generic Organization-member and user-deletion lifecycle that bypasses `removeProjectMember`.

## Repair requirements

Add an additive migration-backed owner-loss invalidation at the owning `member` deletion boundary, following the existing schedule lifecycle precedent. Before the Organization membership cascade completes, atomically disable each enabled, non-deleted Trigger owned by that user in that Organization, set the stable `execution_owner_access_lost` reason, increment revision exactly once, and record redacted Project audit evidence. Preserve already-disabled reasons and revisions. Ensure subsequent user deletion can set historical creator/owner references null without violating the enabled-owner invariant. Do not auto-reassign or re-enable Triggers.

## Done when

- Deleting an Organization member through the generic membership boundary disables every affected enabled Trigger before Project membership cascades.
- The transition records the stable reason, one revision increment, and address-free audit evidence.
- Already-disabled and deleted Triggers retain their reason and revision.
- Deleting the former user succeeds and preserves the soft-deleted or disabled Trigger row for historical references.
- Migration, generic member-deletion, direct user-deletion, and concurrency regressions pass.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
