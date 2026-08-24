# Reject unsafe cross-platform ZIP entry names

## Failed behavior

A legal POSIX Workspace filename can contain backslashes, including names that look drive-qualified or rooted on Windows. The hosted Linux runtime preserves those backslashes in the ZIP entry instead of producing one unambiguous normalized relative path. A downloader's extractor can interpret the same entry as a drive, root, or directory path, and two distinct hosted paths can collapse onto the same extracted target.

## Affected work

[Share Workspace files through retained preview links](01-share-workspace-files-through-previews.md), implemented by `33430e546a6bc4f9aa002c42dcefefd16538bb37`, in Workspace-path validation and `normalizedEntryName` within `tools/kestrelOne/workspaceFileShare.ts`.

## Repair requirements

Every ZIP entry must be a safe, normalized Workspace-relative name when interpreted by common POSIX and Windows archive tools. Reject any selected source whose portable entry name would be rooted, drive-qualified, traversal-capable, ambiguous, unsafe, or duplicate another selected entry. Preserve exact source selection, forward-slash hierarchy for safe nested paths, Unicode filenames that remain safe, and the no-unselected-files guarantee.

## Done when

- Backslash-bearing, rooted-looking, drive-qualified, traversal, and cross-platform-colliding entry names fail before process start or publication.
- Safe nested Workspace paths retain their expected forward-slash ZIP entry names.
- Focused archive checks cover permitted POSIX filenames that are unsafe when extracted on another supported user platform.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
