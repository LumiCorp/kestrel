# Prepare every Browser approval exactly

## Failed behavior

Commit `cfc59f05a` prepares input-dependent Browser calls before approval, but always-approved Browser upload and download calls do not request trusted inspection. Desktop single and batch waits can therefore omit the prepared call and prepare mutable descriptor, adapter, or policy state only after approval.

## Affected flow

`tools/browser/modules.ts` declares Browser preparation requirements. Acter single and batch paths create Desktop/hosted approval bindings. The existing exact prepared-call state and execution authorization are the owning surfaces.

## Repair requirements

- Prepare every Browser operation that can wait for approval before committing that wait, including upload and download.
- Persist and resume the exact prepared invocation and combined revision on Desktop and hosted single and per-item batch paths.
- Do not require input-dependent Browser policy resolution for operations whose approval is static; use the existing exact preparation surface.
- Preserve non-Browser approval behavior.

## Done when

- Desktop and hosted upload/download single and batch approvals contain one exact prepared invocation and resume it unchanged.
- Descriptor, adapter, policy, attachment, or target drift after approval cannot change the executed call.
- Focused Acter, preparation, upload/download, approval, and replay suites pass.

## Depends on

None.
