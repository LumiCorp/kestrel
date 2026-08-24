# Show the exact file-share operation in approval

## Failed behavior

When Preview App policy requires approval, `workspace.files.share` can omit the effective download name and 60-minute default lifetime because both inputs are optional. A provided name with surrounding whitespace is shown differently from the trimmed name that is published. Selected filenames containing commas are flattened into an ambiguous comma-separated string, so different selections can produce the same approval text. The user therefore cannot always see the exact public operation before authorizing it.

## Affected work

[Share Workspace files through retained preview links](01-share-workspace-files-through-previews.md), implemented by `33430e546a6bc4f9aa002c42dcefefd16538bb37`, through the `workspace.files.share` presenter in `src/runtime/toolApprovalPresentation.ts` and the later input resolution in `tools/kestrelOne/workspaceFileShare.ts`.

## Repair requirements

Ask-mode approval must unambiguously show every selected path, the explicit mode, the exact output name that will be published, and the requested or effective lifetime, including deterministic defaults. The approved values and the values used by the handler must remain identical. Preserve optional tool inputs, the existing Preview App policy authority, bearer-link warning, and approval privacy conventions.

## Done when

- Omitted optional fields show the exact derived output name and effective 60-minute lifetime before publication.
- Whitespace-bearing names and comma-bearing filenames cannot make the approved operation differ from or become ambiguous with the executed operation.
- Focused approval checks cover file and ZIP defaults, normalized supplied values, and path-array boundaries.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
