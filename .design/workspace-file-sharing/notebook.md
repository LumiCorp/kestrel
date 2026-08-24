# Workspace File Sharing Design Notebook

## Current Position

Add one model-visible `workspace.files.share` tool that packages selected Workspace files and publishes a Kestrel-owned single-payload server through the existing preview lifecycle.

The observed Kestrel One thread changed the design. The agent already started a server, published it through `workspace.preview.publish`, returned a working `p-.../test.xlsx` link, and closed the preview on request. This proves the current delivery seam is sufficient.

The managed-object-storage design was over-engineered for the stated requirement. It solved an unrequested problem: keeping downloads alive after Workspace shutdown without retaining compute.

## Evidence

- User request: share agent-created files individually or as a ZIP through preview links.
- Live thread: https://kestrelagents.dev/threads/9739676a-2f3a-4304-8352-16234164daa5
- `tools/kestrelOne/workspacePreviews.ts`: publication, process retention, list, renew, inspect, and close.
- `apps/web/lib/apps/preview-lifecycle.ts`: 60-minute default, four-hour maximum, active lease creation, and port verification.
- `apps/web/lib/environments/store.ts`: active previews block Workspace idle stop.
- `tools/contracts.ts` and `tools/filesystem/shared.ts`: Workspace-root policy and safe path resolution.
- `src/devshell/contracts.ts`: managed process start and retention.
- `packages/conversation/src/contracts.ts`: reusable artifact presentation.
- `apps/web/components/chatbot/message.tsx`: current generic artifact rendering.

## Observed Scenario

1. The agent created and validated `test.xlsx`.
2. The user asked for a preview link to download the update.
3. The agent started a server on port 8000.
4. The agent published and inspected the preview.
5. The user downloaded the workbook from a `p-.../test.xlsx` URL.
6. The agent listed and closed the preview when the user asked it to stop.

## Settled Design

- Add only `workspace.files.share`.
- Require explicit `file` or `zip` mode.
- Accept one file in `file` mode and one to 20 regular files in `zip` mode.
- Resolve all paths inside the Workspace and reject links, directories, special files, duplicates, and escapes.
- Stage one immutable copy under an allowed runtime temp root.
- Cap the staged payload at 500 MiB.
- Start a Kestrel-owned loopback server that exposes only the staged payload.
- Support GET, HEAD, ranges, forced attachment download, and no directory listing.
- Reuse the existing retained preview publication helper and `p-...` URL.
- Return the existing preview ID and use preview list, renew, and close for lifecycle management.
- Render the result as a Download card.
- Map to the existing preview publication capability and policy.

## Explicit Non-Goals

- No managed object-storage upload path.
- No `file_share_leases` table.
- No `f-...` Edge hostname or download target.
- No separate list, renew, or close share tools.
- No link survival after Workspace shutdown.
- No durable Project file library.
- No extension or filename heuristics.

## Cost and Reliability Boundary

The active download link follows preview semantics. The retained process keeps the Workspace available and can therefore consume compute until expiry or close. The default lifetime is 60 minutes and the maximum is four hours.

This is an accepted product boundary for temporary transfer. It must be stated in the tool result and Download card. A future durable-sharing product can move bytes to managed storage if actual use requires compute-independent delivery.

## Readiness

No design question blocks a Product Brief. The current architecture already proves the public link, process retention, expiry, renewal, and revocation path. Delivery needs a bounded packaging and server implementation plus result presentation.

## Accepted persistence decision

The exact bearer URL inherits the existing Preview App persistence contract. It may remain in the authenticated conversation, generic tool-result envelope, and Download-card presentation because those records carry replay and rendering state. File-share-specific operational logs and audit summaries use stable preview metadata without copying the URL. Splitting conversation presentation from generic tool-result audit persistence is a separate cross-cutting security change, not a prerequisite for this tool.

## Best Next Move

Publish the canonical Product Brief. Do not create implementation issues in the same step.
