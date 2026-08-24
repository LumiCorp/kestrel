# Bound expired-stage registry iteration

## Failed behavior

An expired, genuinely Kestrel-owned staging directory can make the next `workspace.files.share` call loop forever when it contains any unexpected extra entry. Cleanup iterates the live ownership registry, quarantines and restores the non-empty stage, then deletes and re-adds the same registry key. JavaScript's live `Map` iterator visits the reinserted key again without reaching the end.

## Affected work

[Delete only Kestrel-owned expired file-share staging](05-delete-only-kestrel-owned-expired-staging.md), implemented by `c7f2c1973`, in `cleanExpiredStaging` and `reclaimExpiredOwnedStage` within `tools/kestrelOne/workspaceFileShare.ts`.

## Repair requirements

One cleanup pass must inspect each stage that was registered when the pass began at most once. Unexpected contents must remain untouched, must not widen deletion scope, and must not prevent a new share from proceeding. Preserve exact ownership checks, atomic quarantine, non-recursive deletion, cleanup evidence, and later retry eligibility.

## Done when

- A genuine expired owned stage containing an unexpected extra entry is inspected once, restored without deleting its contents, and does not hang the next share.
- Focused coverage fails deterministically if a restored registry entry is revisited during the same cleanup pass.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
