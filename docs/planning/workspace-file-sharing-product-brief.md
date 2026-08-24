# Workspace File Sharing Product Brief

## Product Narrative

Kestrel One agents can create files in a Workspace, but users do not have a dependable one-step way to download those files. An agent can assemble the flow itself by starting a server and publishing a preview. The observed Kestrel One thread proved that this works for an updated workbook and that the link can be closed with existing preview controls.

The current experience still depends on the model choosing a safe server, serving only the intended file, constructing the exact download URL, and cleaning up correctly. ZIP behavior and the conversation presentation also vary by run.

Kestrel One must turn this proven workflow into one model-visible `workspace.files.share` tool. The tool creates one immutable temporary payload, starts a Kestrel-owned download process, publishes it through the existing preview lifecycle, and returns a Download card. Users get a predictable transfer. Kestrel keeps one public-link contract and one lifecycle.

## Outcomes and Delivery Boundary

This initiative must produce these outcomes:

- An agent can share one selected Workspace file through one download link.
- An agent can package one or more selected Workspace files into one ZIP and share one download link.
- The shared bytes cannot change after publication, even if a source file changes.
- The download remains available after the agent turn finishes while the preview lease is active.
- The public process can read only the staged payload. It cannot list or expose the Workspace.
- The conversation shows a Download card with the filename, size, expiry, and anonymous-link warning.
- The existing preview lifecycle owns publication, expiry, renewal, revocation, and process retention.
- A share can be closed with `workspace.preview.close`; no separate share lifecycle is introduced.
- Failures identify the correct packaging, path, process, publication, or cleanup stage.

The delivery boundary covers Workspace path selection, one-file copying, ZIP creation, temporary staging, the single-purpose download process, preview publication, conversation presentation, cleanup, and verification in web and mobile clients.

This initiative does not:

- Add managed object-storage uploads for agent-created Workspace files.
- Add `file_share_leases`, `f-...` hostnames, or a new Kestrel Edge target.
- Create separate file-share list, renew, or close tools.
- Keep a link available after its Workspace or preview is stopped.
- Remove the compute cost of retaining an active preview.
- Create a durable Project file library or long-term delivery link.
- Verify that the agent originally authored a selected file.
- Add file-extension, content-type, or filename heuristics.
- Serve Workspace directories or accept directory inputs.

## Defining Scenarios

### The agent shares one file

The user asks for a file the agent created. The agent calls `workspace.files.share` with `mode: "file"` and one Workspace-relative path.

The tool resolves the path inside the Workspace, opens the file read-only, confirms that it is a regular file, and copies it to a generated temporary staging directory. The tool starts the Kestrel download process and publishes its selected port through the existing preview lifecycle.

The tool returns the exact file URL, preview ID, size, and expiry. The conversation renders a Download card. The user downloads the staged bytes.

### The agent shares a ZIP

The user asks for several outputs in one download. The agent calls `workspace.files.share` with `mode: "zip"`, one to 20 Workspace-relative file paths, and an optional archive name.

The tool validates the complete selection before publication. It streams one ZIP into temporary staging and preserves normalized Workspace-relative entry names. It starts the same single-purpose download process and publishes one preview URL.

The conversation renders one Download card for the ZIP. The user receives one archive containing only the selected files.

### A source changes after publication

The agent or another process changes or deletes a source file after the share becomes active. The server continues to serve the staged copy. The download does not change during the preview lifetime.

### The user asks the agent to stop sharing

The user asks the agent to stop the server or remove the link. The agent uses the returned preview ID with `workspace.preview.close`.

The preview lifecycle revokes the public route and releases process retention. The download process stops and removes its staging directory. The link no longer works.

### A share expires

The user does not close the share. The preview expires under the existing lease rules. Kestrel releases the retained process, and the process removes the staged payload.

If the process ended abnormally and left temporary bytes, a later share run removes expired Kestrel file-share staging directories.

### Selection or packaging fails

One selected path is missing, outside the Workspace, linked, duplicated, not a regular file, or conflicts with another ZIP entry. The complete share fails before any server or preview is published.

If packaging exceeds the file-count or byte limit, the tool stops, removes partial staging, and returns a stable limit failure. The user or agent can choose fewer files or a smaller payload.

### The download process or preview fails

If the download process does not report a listening port, the tool stops the process, removes staging, and returns a stable server failure.

If preview publication fails, the existing publication helper closes any provisional preview, releases process retention, stops the process, and records cleanup evidence. The tool does not return a URL from a partial state.

## Business and Process Requirements

- The agent must use `workspace.files.share` when the user asks to download Workspace output through a preview link.
- The tool must require explicit `file` or `zip` mode. It must not infer packaging from path count.
- `file` mode must require exactly one selected file.
- `zip` mode must accept one to 20 selected files.
- The final staged payload must not exceed 500 MiB.
- The default link lifetime must be 60 minutes. The existing four-hour preview maximum must apply.
- The successful result must identify the exact download name, measured size, file count, expiry, and preview ID.
- The successful result and Download card must warn that anyone with the link can download the payload until the preview closes or expires.
- A share must use the same effective App policy as preview publication. It must not introduce a second approval policy for the same public action.
- When preview publication requires approval, the approval must show the selected paths, mode, output name, and requested lifetime.
- The user must be able to ask the agent to list, renew, or close the share through existing preview tools.
- Closing or expiry must make the public link unavailable and release its retained process.
- One invalid input must reject the complete share. The tool must not publish a partial ZIP or a subset of selected files.
- The source Workspace files must remain unchanged by sharing.
- Kestrel must not claim that a preview-backed link survives Workspace shutdown or avoids retained-compute cost.
- Support must be able to distinguish path, limit, archive, server, preview, and cleanup failures.

## Technology Requirements

### Tool and App ownership

- Runtime must add one Build-mode tool named `workspace.files.share`.
- The tool must map to the existing `built_in.previews.publish` capability.
- The tool must not add an App capability or a second policy record.
- The existing Preview App policy, execution ticket, App transport, audit boundary, and approval mode must remain authoritative.
- The tool must return the existing preview lease ID as `previewId`.
- `workspace.preview.list`, `workspace.preview.renew`, and `workspace.preview.close` must remain the lifecycle tools.
- Existing application-preview tool names and contracts must remain compatible.

### Input and path safety

- The input must contain `mode`, `paths`, and optional `downloadName` and `ttlMinutes` fields.
- Every path must be Workspace-relative.
- The handler must resolve each path against `context.fileSystem.workspaceRoot` through the shared filesystem boundary.
- The final canonical source must remain inside the Workspace root, even when other temporary or read-only roots are allowed to filesystem tools.
- The handler must reject absolute paths, traversal, symbolic links, directories, sockets, devices, missing files, duplicates, and duplicate ZIP entry names.
- The handler must open each source read-only and validate the open descriptor as a regular file before streaming bytes.
- The handler must not use extensions, names, or guessed media types to decide whether a file can be shared.

### Immutable payload and ZIP behavior

- The handler must create one generated staging directory under an allowed runtime temporary root.
- The staging directory name must contain no user-controlled text.
- `file` mode must copy one source into one staged payload.
- `zip` mode must stream one ZIP and preserve each normalized Workspace-relative path as its entry name.
- The ZIP writer must reject unsafe or duplicate entry names.
- The handler must measure output bytes while writing and stop before exceeding 500 MiB.
- The staged payload must be complete before the public process starts.
- Later changes to source files must not alter the staged payload.
- Packaging failure or cancellation must remove partial staging before returning when cleanup succeeds.

### Download process

- Kestrel must provide and own the download server implementation. The model must not generate or choose the server command.
- The handler must start the server through the existing dev-shell process service.
- The server must bind to loopback on an available non-reserved port and report that port to the handler.
- The server must expose only the staged payload at the encoded download filename.
- The server must not expose a directory root, directory listing, arbitrary path mapping, or Workspace path.
- The server must allow `GET` and `HEAD` and support standard byte ranges.
- The server must reject mutation methods and every unrecognized route.
- Responses must include safe `Content-Disposition: attachment`, `Content-Length`, `Accept-Ranges`, and `X-Content-Type-Options: nosniff` headers.
- The response filename must be advisory only. It must not determine the staging or source path.
- The process must remove its staging directory when it stops normally.

### Preview publication and lifecycle

- The retained-publication workflow in `workspace.preview.publish` must become a shared internal helper rather than being copied.
- Both preview publication and file sharing must use the same provisional retention, port publication, retention promotion, cancellation, close, and cleanup behavior.
- The file-share preview must use the current `p-...` hostname and `workspace_preview_leases` data.
- The preview name must identify the download, for example `Download: analysis-package.zip`.
- A URL must be returned only after the server is listening and the preview lifecycle reports an active lease.
- The exact base preview URL returned by Kestrel One must remain unchanged. The handler may append only the encoded route that the Kestrel download process registered.
- Active shares must follow the existing rule that an active preview blocks Workspace idle shutdown.
- Existing expiry, renewal, maximum lifetime, close, gateway refresh, and process-retention behavior must remain authoritative.
- Abnormal server exit must make the link fail as an unavailable preview. The tool must not claim durable byte availability.

### Conversation presentation

- The tool result normalizer must emit one `ConversationArtifactPresentation` with `kind: "file-share"`.
- The presentation must include the exact URL, download name, media type, preview ID, size, file count, and expiry.
- Web and mobile must render `file-share` as a Download card with a direct download action.
- Other artifact kinds must keep their current presentation.
- The card must repeat the anonymous bearer-link warning and preview expiry.
- The exact URL may remain in the authenticated conversation, generic tool-result envelope, and persisted Download-card presentation because those existing records carry replay and rendering state for Preview App results.

### Failure and cleanup contract

- The new boundary must preserve these stable failures:
  - `WORKSPACE_FILE_SHARE_PATH_INVALID`
  - `WORKSPACE_FILE_SHARE_LIMIT_EXCEEDED`
  - `WORKSPACE_FILE_SHARE_ARCHIVE_FAILED`
  - `WORKSPACE_FILE_SHARE_SERVER_FAILED`
  - `WORKSPACE_FILE_SHARE_CLEANUP_PENDING`
- Existing preview lifecycle failures must remain unchanged and visible when publication owns the failure.
- Cleanup failure must not replace the primary packaging, process, or publication failure.
- The handler must close any created preview, release retention, stop the download process, and remove staging when a later step fails.
- A later share run must remove generated Kestrel file-share staging directories whose preview lifetime has ended and whose process exited abnormally.
- The tool must not record source file contents in conversation, audit, or operational records.
- Additional file-share lifecycle logs and audit summaries must record stable IDs, counts, byte size, expiry, stage, and outcome without duplicating the bearer URL. This does not redact the URL from the existing authenticated tool-result and conversation-presentation records that already carry Preview App URLs.

### Compatibility and verification

- Existing preview rows, hostnames, routes, resolver contracts, and canaries must require no migration.
- The runtime tool mapping must deploy with the tool so `workspace.files.share` inherits the existing preview publication policy.
- Tests must cover one binary file, a multi-file ZIP, preserved ZIP names, source mutation after publication, and exact download bytes.
- Tests must prove that directory listing, traversal, linked files, unselected files, duplicate entries, mutation methods, and unknown routes are unavailable.
- HTTP tests must cover `GET`, `HEAD`, valid and invalid ranges, attachment headers, length, and filename encoding.
- Lifecycle tests must cover process start, publication, cancellation, list, renew, close, expiry, abnormal exit, and cleanup evidence.
- Presentation tests must cover Download cards in web and mobile without changing other artifacts.
- Existing preview process-retention tests and the environment preview canary must remain green.
- `pnpm validate` and the process boundary gate must pass before the change is ready to publish.

## People and Operating Requirements

- Thread users decide which Workspace outputs to request and when to close a temporary link.
- Users must not need to know about ports, servers, process sessions, Edge routing, or ZIP commands.
- The Kestrel agent owns selecting the exact paths that satisfy the user's request and calling the share tool.
- The share tool owns path enforcement, immutable packaging, safe serving, publication, result shaping, and cleanup.
- The Preview App remains the policy and lifecycle owner for public exposure.
- Existing Project or Environment administrators retain control through Preview App policy. No new administrator setting is introduced.
- Support staff must be able to tell whether the user should correct a path, reduce the selection, retry publication, or close a stale preview.
- Operators own Preview Edge availability, process-retention health, and temporary-storage pressure under existing operational practices.
- Operators must understand that an active file share can keep Workspace compute running until close or expiry.
- No new storage credential, storage repair role, data migration procedure, or file-retention policy is introduced.

## Success and Readiness

Success is observable when:

- The proven workbook scenario completes through one `workspace.files.share` call and one Download card.
- A user downloads one shared binary file with the expected filename and exact bytes.
- A user downloads one ZIP containing only the selected files with the expected entry paths.
- Editing a source file after publication does not change the active download.
- The download still works after the publishing turn finishes and before the preview closes or expires.
- No public route can list a directory or read another Workspace file.
- Preview list, renew, close, and expiry work for download previews without new lifecycle tools.
- Closing a share revokes the link, stops the process, and removes staging.
- Failures leave no active public URL and preserve the primary stable failure with cleanup evidence.
- Web and mobile render the result as a Download card.
- Existing application previews behave unchanged.
- Focused tool, path, ZIP, server, lifecycle, cleanup, and presentation tests pass.
- `pnpm validate` and the process boundary gate pass.

**Readiness: Ready for issue creation.**

The product behavior, preview-backed architecture, ownership boundary, safety rules, operating cost, failure behavior, and success evidence are settled. The 20-file and 500 MiB limits can be revisited from observed use without changing the core design.

## Source Artifacts

- [Workspace File Sharing Change Design](../design/workspace-file-sharing-change-design.md)
- [Workspace File Sharing Design Notebook](../../.design/workspace-file-sharing/notebook.md)
- [Observed successful Kestrel One Thread](https://kestrelagents.dev/threads/9739676a-2f3a-4304-8352-16234164daa5)
