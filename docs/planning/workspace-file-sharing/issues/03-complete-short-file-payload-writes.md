# Complete short file-payload writes before publication

## Failed behavior

A `file` share can publish bytes that differ from the selected source when the operating system completes a regular-file write with fewer bytes than requested. The handler advances its source and destination offsets by the full read length instead of the reported write length, so the immutable payload can contain a gap or omit bytes while `sizeBytes` still reports the expected source size.

## Affected work

[Share Workspace files through retained preview links](01-share-workspace-files-through-previews.md), implemented by `33430e546a6bc4f9aa002c42dcefefd16538bb37`, in `copySinglePayload` within `tools/kestrelOne/workspaceFileShare.ts`.

## Repair requirements

File-mode staging must account for the actual number of bytes written and must not publish until every byte read from the selected descriptor has been written in order. A short successful write must either be completed correctly or produce the owning stable staging failure. Preserve the 500 MiB final-payload limit, streaming memory bound, immutable snapshot, cancellation cleanup, and existing ZIP behavior.

## Done when

- A permitted short-write sequence produces a byte-for-byte identical file download and the correct measured size.
- A focused regression check forces one or more short successful writes rather than relying on ordinary local filesystem behavior.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
