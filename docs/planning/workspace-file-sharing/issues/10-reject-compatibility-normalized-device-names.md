# Reject compatibility-normalized Windows device names

## Failed behavior

Legal POSIX filenames such as `COM¹.txt` and `LPT²` pass ZIP entry validation even though Unicode compatibility normalization maps them to reserved Windows device names. The validator checks the reserved-name rule before NFKC, derives a normalized collision key afterward, and never applies the safety rule to that portable form.

## Affected work

[Reject unsafe cross-platform ZIP entry names](06-reject-unsafe-cross-platform-zip-entry-names.md), implemented by `c7f2c1973`, in `inspectPortableZipEntryName` within `tools/kestrelOne/workspaceFileSharePathSafety.ts`.

## Repair requirements

Apply the complete portable Windows segment safety contract to the same compatibility-normalized form used for collision comparison. Reject names whose normalized form is reserved, unsafe, trailing-dot-or-space, traversal-capable, or separator-bearing while preserving safe Unicode spelling in accepted ZIP entries and preserving file-mode behavior.

## Done when

- Compatibility forms including `COM¹.txt`, `COM²`, `COM³.log`, `LPT¹.txt`, `LPT²`, and `LPT³` fail before process start or publication.
- Safe Unicode ZIP names remain accepted with their original spelling.
- Focused helper and tool-level regressions cover the compatibility-normalized device-name boundary.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
