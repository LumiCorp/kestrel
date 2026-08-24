# Bound retained downloads across supervisor restart

## Failed behavior

If the dev-shell supervisor terminates abruptly while a file share is active, its detached download process can survive. On restart the supervisor marks the persisted process `LOST` and removes its retention leases without recovering or stopping the live OS process. Because the download server has already unlinked the payload and has no independent expiry, it can retain the payload descriptor and loopback server after the preview lease ends; later directory cleanup cannot reclaim those bytes.

## Affected work

[Share Workspace files through retained preview links](01-share-workspace-files-through-previews.md), implemented by `33430e546a6bc4f9aa002c42dcefefd16538bb37`, through the generated server in `tools/kestrelOne/workspaceFileShareServerSource.ts` and retained-process restart behavior in `src/devshell/DevShellSupervisor.ts`.

## Repair requirements

A retained file-share process and its immutable payload must remain bounded by authoritative preview lifecycle state even when the supervisor restarts or loses its in-memory child handle. Expiry and close must stop or make the exact process safely recoverable, close the payload descriptor, and reclaim generated staging. Preserve renewal, the existing preview lease authority, active-download behavior, and isolation from unrelated managed processes.

## Done when

- An abrupt supervisor loss followed by restart cannot leave the retained file-share process or payload alive beyond the authoritative preview lifetime.
- Close and renewal still affect the exact retained download process after any supported recovery path.
- A focused process-level check exercises supervisor loss, restart, lease expiry, process termination, and byte reclamation.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
