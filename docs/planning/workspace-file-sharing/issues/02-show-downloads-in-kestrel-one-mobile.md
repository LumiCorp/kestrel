# Show shared Workspace downloads in Kestrel One Mobile

## Scope disposition

This separate-client issue is out of scope for the Kestrel One Workspace File Sharing delivery. Kestrel One Mobile implementation and physical-device validation are not acceptance gates for this plan. Retain this file only as an unscheduled follow-up; do not place it on the active delivery frontier.

## Useful outcome

A Kestrel One Mobile user can recognize a shared Workspace file as a download, see its filename, size, and expiry, and open the temporary HTTPS link on iOS or Android.

This issue completes the mobile part of the file-sharing scenario after the hosted API exposes the settled file-share artifact fields. It changes only presentation and safe link handling. It does not add uploads, artifact editing, runner controls, or a second file lifecycle.

## What changes

- Update the mobile repository's checked-in OpenAPI contract from the hosted Kestrel One contract, then regenerate the client types with the repository's supported generation command.
- Extend the validated artifact message-part contract with the backward-compatible file-share fields supplied by Kestrel One: preview ID, measured size, file count, and expiry.
- Render an artifact whose `kind` is `file-share` as a Download card rather than the generic `Artifact · file-share` card.
- Show the exact filename, a readable byte size, the expiry, and the anonymous-link warning. Give the action an accessible Download label.
- Open only validated HTTP or HTTPS URLs through the existing safe-link boundary. A missing or unsafe URL must leave the card visible without an actionable link.
- Keep every non-file-share artifact, citation, source, interaction, progress, and tool-status presentation unchanged.
- Treat the hosted preview as authoritative. The mobile client must not calculate a new URL, renew a lease, persist the bearer URL outside the existing encrypted message cache, or claim the file remains available after expiry.

## Requirements and delivery context

This issue is implemented in the separate `kestrel-one-mobile` repository. Follow that repository's `AGENTS.md` product and release guardrails.

The hosted message-part contract is validated in `src/lib/api/contracts.ts`. Artifact presentation is owned by `src/components/message-part-detail.tsx`, which already rejects unsafe links through `safeWebUrl` and opens accepted links through React Native `Linking`. Extend these seams rather than adding a parallel download subsystem.

The checked-in API source is `openapi/mobile-v1.json`. Run `pnpm api:generate` and commit the resulting generated types whenever the hosted contract changes. Do not hand-edit generated client types without regenerating them.

Add focused coverage in `tests/thread-ui.test.tsx` for the file-share card, accessible Download action, metadata, warning, safe HTTPS link, unsafe-link rejection, and unchanged generic-artifact behavior. Preserve the mobile boundary tests and API negotiation behavior.

The mobile product boundary forbids uploads, artifact editing, runner controls, management data, and generic hosted-web behavior. The client must not log or place the bearer URL in analytics, push payloads, or crash reports. Existing encrypted offline storage and sign-out purge behavior remain unchanged.

Run `pnpm verify`. Validate the final Download action on physical iOS and Android devices because browser handoff and native link behavior are not accepted through Expo Go alone.

## Done when

- A mobile Thread containing a hosted `file-share` artifact shows a Download card with the exact filename, readable size, expiry, warning, and accessible action.
- Pressing the action opens the exact safe HTTPS preview link on physical iOS and Android devices.
- Missing, expired, or unsafe URLs do not create an actionable link or expose an internal error.
- Generic artifacts and every other structured message part retain their current rendering and accessibility behavior.
- The checked-in OpenAPI contract and generated client types match the hosted file-share fields.
- Focused UI and contract tests pass, `pnpm verify` passes, and physical-device results are recorded.

## Depends on

[Share Workspace files through retained preview links](01-share-workspace-files-through-previews.md) must reach Done so the authoritative hosted mobile contract contains the file-share fields.
