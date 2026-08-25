# Settle file-share cancellation before returning success

## Failed behavior

File sharing does not consistently settle cancellation at its owning boundary. Cancellation during payload staging can be relabeled as `WORKSPACE_FILE_SHARE_ARCHIVE_FAILED`; a direct aborted invocation reproduces that code instead of the cancellation failure. A later race is also possible after preview publication and retention promotion: cancellation can arrive while final stage metadata is being written, after the shared helper's last signal check, and the handler then returns success with the public preview still active.

## Affected work

[Share Workspace files through retained preview links](01-share-workspace-files-through-previews.md), implemented by `33430e546a6bc4f9aa002c42dcefefd16538bb37`, across cancellation checks, payload staging, final metadata persistence, and compensation in `tools/kestrelOne/workspaceFileShare.ts`, plus the existing external-side-effect settlement boundary in `src/io/ToolInvocationSupport.ts`.

## Repair requirements

Cancellation observed before the file-share handler returns its successful result must return the owning cancellation failure, remove partial staging, and leave no unintended active preview or retained download process. Cancellation that races after publication but before that return must compensate the preview and process. Preserve the generic rule that cancellation arriving after the successful external-effect result has returned does not erase its committed evidence, and preserve cleanup evidence without replacing the primary failure.

## Done when

- Cancellation during file and ZIP staging returns the owning cancellation failure and removes partial staging.
- Cancellation after preview publication but before the handler returns compensates the preview and process; cancellation after the successful result returns preserves the committed result.
- Focused checks deterministically exercise pre-staging, mid-staging, post-publication, and post-commit cancellation timing.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
