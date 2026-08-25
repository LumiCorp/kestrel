# Delete only Kestrel-owned expired file-share staging

## Failed behavior

Any Workspace process that can write to an allowed temporary root can create a directory whose name begins with `kestrel-file-share-` and add a small expired `metadata.json`. The next file-share attempt trusts only that forgeable prefix and metadata, then recursively deletes the directory and any unrelated contents. This violates the settled requirement to remove only generated Kestrel file-share staging.

## Affected work

[Share Workspace files through retained preview links](01-share-workspace-files-through-previews.md), implemented by `33430e546a6bc4f9aa002c42dcefefd16538bb37`, in `cleanExpiredStaging` and `readExpiredStage` within `tools/kestrelOne/workspaceFileShare.ts`.

## Repair requirements

Expired cleanup must establish Kestrel ownership of the exact staging target before recursive removal. A model, Workspace command, or unrelated process must not be able to make arbitrary temporary-root contents eligible for deletion by copying a public name and JSON shape. Preserve bounded cleanup of genuine expired file-share staging, symlink-safe behavior, and cleanup evidence without broadening deletion scope.

## Done when

- A forged matching directory and metadata file remain untouched by a later share attempt.
- A genuine Kestrel-owned stage whose preview lifetime ended after abnormal process exit is removed.
- Focused checks cover forged metadata, link or replacement races, and the genuine expired-stage path.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
