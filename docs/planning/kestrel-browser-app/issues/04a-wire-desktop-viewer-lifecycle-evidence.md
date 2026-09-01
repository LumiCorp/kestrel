# Wire Desktop viewer lifecycle evidence

## Failed behavior

Issue 04 defines metadata-only viewer lifecycle events, and `DesktopBrowserService` calls an optional `viewerEvents` sink. The packaged Local Core composition does not provide that sink, so the shipped Desktop app silently drops request, acceptance, lease, disconnect, return, rejection, expiry, authorization-loss, and cleanup evidence.

## Affected flow

The existing Local Core observability/event composition owns durable metadata-only evidence. `DesktopBrowserService` owns event construction. The repair must connect those surfaces without introducing viewer input, page content, URLs, frames, or authentication values into durable records.

## Repair requirements

- Supply a production viewer-event sink when constructing the packaged Desktop Browser service.
- Reuse the existing metadata-only event or audit surface that owns comparable Desktop lifecycle evidence.
- Keep every payload limited to the declared viewer event name, time, Session generation, Thread, Project, and bounded reason metadata.
- Preserve the current rule that evidence failure cannot change Browser behavior.
- Do not persist frames, pointer or keyboard input, authentication values, page content, URLs, engine endpoints, or proxy data.

## Done when

- Packaged composition tests prove every required lifecycle transition reaches the production sink.
- Unique password and MFA sentinels are absent from emitted events and their durable representation.
- Sink failure remains non-fatal and cannot leak rejected payloads through errors or logs.
- Focused Desktop Browser service, Local Core composition, process, and secret-redaction tests pass.

## Depends on

None.
