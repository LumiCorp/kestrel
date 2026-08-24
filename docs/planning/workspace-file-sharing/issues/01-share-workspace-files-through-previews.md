# Share Workspace files through retained preview links

## Useful outcome

A Kestrel One user can ask the agent to share one Workspace file or one ZIP of selected files. The agent calls one `workspace.files.share` tool and returns a Download card backed by the existing Kestrel Edge preview lifecycle.

The download remains available after the publishing turn while its preview lease is active. The user can list, renew, or close the link with the existing preview tools. This issue delivers the hosted runtime, web, and mobile API behavior defined by the [Workspace File Sharing Product Brief](../../workspace-file-sharing-product-brief.md).

## What changes

- Add the Build-mode `workspace.files.share` tool with explicit `file` and `zip` modes. `file` accepts exactly one Workspace-relative path. `zip` accepts one to 20 Workspace-relative paths. The optional fields are `downloadName` and `ttlMinutes`.
- Map the tool to the existing `built_in.previews.publish` capability and policy. Do not add an App capability, policy record, database table, storage credential, or Edge route.
- Resolve every input through the shared filesystem boundary and then enforce a Workspace-only rule. Reject absolute paths, traversal, links, directories, special files, missing files, duplicate sources, and duplicate ZIP entry names before publication.
- Create one immutable payload in a generated directory under an allowed runtime temporary root. Copy one file for `file` mode. Use a streaming ZIP writer for `zip` mode so the runtime does not buffer a payload that may reach 500 MiB. Preserve normalized Workspace-relative ZIP entry names.
- Enforce a 500 MiB final-payload limit while writing. Reject the complete request when any source or limit is invalid. Remove partial staging after failure or cancellation when cleanup succeeds.
- Provide a Kestrel-owned Node download server. Start it through the existing dev-shell process service; the model must not generate or choose the server command. Bind to loopback on an available non-reserved port and report readiness, the port, and the managed process ID to the tool handler.
- Expose only the staged payload at the encoded download filename. Support `GET`, `HEAD`, and byte ranges. Send safe attachment, length, range, and `nosniff` headers. Reject directory listing, traversal, mutation methods, unknown routes, and access to any unselected Workspace file.
- Extract the retained-publication workflow from `workspace.preview.publish` into one internal helper. Both preview publication and file sharing must use the same provisional retention, public publication, retention promotion, abort, close, and cleanup-evidence behavior.
- Publish the controlled server with the current `p-...` hostname and `workspace_preview_leases` lifecycle. Keep the 60-minute default and four-hour maximum. Return the existing preview ID, exact download URL, measured size, file count, media type, expiry, and bearer-link warning.
- Emit one `ConversationArtifactPresentation` with `kind: "file-share"`. Include `previewId`, `sizeBytes`, `fileCount`, and `expiresAt` in its metadata.
- Render `file-share` artifacts as Download cards in the Kestrel One web conversation. Show the filename, measured size, expiry, warning, and direct download action. Preserve every other artifact presentation.
- Extend the hosted mobile message projection and OpenAPI contracts so a mobile client receives the file-share kind, URL, media type, preview ID, size, file count, and expiry. Keep the added fields backward compatible for older clients.
- Remove staged bytes when the process stops normally. On a later share attempt, remove only generated Kestrel file-share staging directories whose recorded preview lifetime ended after an abnormal process exit.
- Preserve stable file-share failure codes for invalid paths, limits, ZIP creation, server startup, and pending cleanup. Preserve existing preview lifecycle failures when publication owns the failure. Cleanup evidence must not replace the primary failure.
- Preserve the existing authenticated Preview App persistence contract: the exact URL may appear in the generic tool-result envelope and Download-card presentation needed for replay and rendering. Do not record source contents. Any additional file-share lifecycle logs or audit summaries must use stable IDs, file count, byte size, expiry, stage, and outcome without duplicating the anonymous bearer URL.

## Requirements and delivery context

The current tool and process seam is `tools/kestrelOne/workspacePreviews.ts`. Its publish handler already retains the exact process session before calling the governed Preview App, promotes retention after publication, and closes the public lease when later work fails. Preserve this ordering instead of duplicating or weakening it.

Register the tool beside the existing preview tools in `tools/catalog.ts` and `tools/runtime/builtInToolInputContracts.ts`. Map `workspace.files.share` to `built_in.previews.publish` in `apps/web/lib/agent/kestrel-tool-profile.ts`. The tool must inherit the effective publish approval mode. When approval is required, the tool input must make the exact selected paths, mode, output name, and lifetime visible.

Use `context.fileSystem.workspaceRoot` and the established resolver in `tools/filesystem/shared.ts`. The shared filesystem policy also permits temporary and read-only roots, so the share handler must separately prove that each canonical source remains inside the Workspace root. Validate the opened descriptor as a regular file before streaming it.

Use the existing `DevShellServicePort.startProcess` and retention contracts in `src/devshell/contracts.ts`. Do not depend on a model-selected command, a system-installed `zip` binary, Python's generic HTTP server, or a server that maps URL paths to a directory.

The result-normalization boundary already supports artifact presentations through `SharedToolModule.normalizeResult` and `AgentToolPresentation`. Web rendering is owned by `apps/web/components/chatbot/message.tsx`. Hosted mobile projection is owned by `apps/web/lib/mobile/message-parts.ts`, with public schemas in `apps/web/openapi/mobile-v1.json` and `apps/web/openapi/mobile-v2.json`.

Preserve these product boundaries:

- The staged payload is immutable, but it is temporary. It is not an `artifact_document` or a durable Project file.
- The active preview may keep Workspace compute running. Do not claim that the link survives Workspace shutdown or avoids compute cost.
- Existing preview list, renew, inspect, close, expiry, gateway refresh, hostname, lease, and process-retention contracts remain authoritative.
- Existing application previews must keep their tool inputs, URLs, behavior, and failure semantics.
- Do not add extension, filename, or guessed-content heuristics.

Extend `tests/unit/workspace-preview-tools.test.ts` and `tests/integration/workspace-preview-process-lifecycle.test.ts` or add focused neighboring coverage. Prove real managed-process retention and cleanup, not only mocked publication. Add focused web and hosted-mobile projection tests for the Download presentation and backward-compatible API shape.

Run the relevant focused suites during development. Before handoff, run `pnpm validate` and `pnpm validate:process`. Preserve the existing environment preview canary contract.

## Done when

- A real binary Workspace file can be shared through one tool call, downloaded from the returned `p-...` URL with its requested filename, and verified byte-for-byte.
- One to 20 selected files can be downloaded as one ZIP whose entries contain only the selected normalized Workspace-relative paths.
- Editing or deleting a source after publication does not change the active download.
- No public request can list a directory, reach an unselected file, traverse a path, mutate state, or use an unsupported route.
- `GET`, `HEAD`, valid and invalid ranges, attachment headers, length, and filename encoding behave as required.
- The Download card appears in Kestrel One web, and the hosted mobile API exposes every field needed by the mobile card.
- The link remains usable after the agent turn while the lease is active. Existing list and renew behavior works, and closing or expiry revokes the link, stops the managed process, and removes staging.
- Invalid input, limit, archive, process, publication, cancellation, and cleanup paths return the owning stable failure and leave no unintended active preview.
- Existing application preview tests and canaries remain green.
- Focused coverage, `pnpm validate`, and `pnpm validate:process` pass.
