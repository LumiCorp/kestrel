# Serialize startup evidence and own settlement failure

## Failed behavior

A child can exit while its initial RUNNING write is still pending. The exit handler can then classify and persist a successful terminal record before the initial write rejects. If both the initial and terminal writes reject, the listener-launched terminal handler also rejects without an owner, producing an unhandled rejection that can terminate the developer-shell service.

## Repair requirements

- Make terminal classification wait for the initial-record outcome.
- Publish the initial-record failure reason before releasing terminal handling.
- Route terminal-handler failures through the process settlement promise and observe that promise from listener setup.
- Preserve the original initial-write failure while attaching terminal-settlement failure evidence.
- Observe cooperative shutdown completion so a failed cleanup remains a safe refusal rather than an unhandled daemon failure.

## Done when

- A fast zero-exit child whose initial RUNNING write later fails persists FAILED evidence for the initial-record failure rather than COMPLETED evidence.
- Initial and terminal persistence failures leave the child stopped, surface both failures through the owned start result, and emit no unhandled rejection.
- A failed supervisor close remains retry-visible to the service without removing its endpoint or storage authority.

## Depends on

None.
