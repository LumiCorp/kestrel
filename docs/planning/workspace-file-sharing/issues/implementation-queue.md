# Workspace File Sharing Implementation Queue

Each issue appears in one state. `Ready` is the current dependency-free frontier. Move issues between states as implementation and review change the graph.

## Ready

None.

## In progress

None.

## Blocked

None.

## Implemented

None.

## Done

- [Share Workspace files through retained preview links](01-share-workspace-files-through-previews.md)
- [Complete short file-payload writes before publication](03-complete-short-file-payload-writes.md)
- [Show the exact file-share operation in approval](04-show-the-exact-file-share-operation-in-approval.md)
- [Delete only Kestrel-owned expired file-share staging](05-delete-only-kestrel-owned-expired-staging.md)
- [Reject unsafe cross-platform ZIP entry names](06-reject-unsafe-cross-platform-zip-entry-names.md)
- [Settle file-share cancellation before returning success](07-settle-file-share-cancellation-before-success.md)
- [Bound retained downloads across supervisor restart](08-bound-retained-downloads-across-supervisor-restart.md)
- [Bound expired-stage registry iteration](09-bound-expired-stage-registry-iteration.md)
- [Reject compatibility-normalized Windows device names](10-reject-compatibility-normalized-device-names.md)

## Out of scope

- [Show shared Workspace downloads in Kestrel One Mobile](02-show-downloads-in-kestrel-one-mobile.md) — separate mobile-client implementation and physical-device validation are not part of this Kestrel One delivery
