# Fence receiving throughout Organization deletion

## Useful outcome

The moment Organization deletion is durably requested, email ingress, receiving configuration, and webhook staging become unavailable and stay unavailable until the Organization is deleted or the deletion lifecycle is explicitly restored by its owning workflow.

## Failed behavior

The deletion request marks only the Organization lifecycle as `deleting`. Signed ingress authorizes only from the Receiving Connection, configuration saves do not reject deleting Organizations, and maintenance discovery can select a disabled connection. A receipt can therefore commit after deletion starts, or maintenance/Desktop can create a new provider webhook after decommissioning concluded that no provider cleanup was required.

## Affected work

This repairs [Decommission Resend receiving before Organization deletion](44-decommission-resend-before-organization-deletion.md) in `38c2712e9..d95a29238`, across the deletion request transaction, ingress receipt transaction, configuration/staging authority, and maintenance discovery.

## Repair requirements

- In the same transaction that first marks an Organization `deleting`, durably disable receiving ingress and advance the staging generation so in-flight staging results are superseded.
- Make ingress authority and receipt creation both reject a non-active Organization. A request verified before the fence must not persist a receipt after the fence commits.
- Make every receiving mutation and provider-staging authority reject a deleting Organization before provider mutation. One and Desktop must share the same server-owned lifecycle guard.
- Exclude deleting Organizations from configured-webhook discovery. Decommissioning a no-resource connection must not make it eligible for later registration.
- Preserve the existing deletion retry authority and staged provider evidence. Do not delete credentials, locator, intent, attempt, ID, or encrypted secret before provider absence is verified.
- Add PostgreSQL races for queued deletion versus signed ingress, in-flight receipt persistence, Desktop/One save, maintenance discovery, and staging.

## Done when

- Deletion request and the receiving fence commit atomically.
- No receipt can be inserted once deletion starts, including a request that verified immediately before the fence.
- One, Desktop, and maintenance cannot configure or create a webhook for a deleting Organization.
- Known, ambiguous, absent, and no-resource deletion fixtures still converge without an orphan.
- `pnpm validate` and `pnpm validate:postgres` pass.

## Depends on

None.
