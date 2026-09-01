# Assert store binding at command dispatch

## Failed behavior

Developer-shell compatibility is checked by one health request and command execution is sent by a later independent request. If the socket owner changes between those requests, a client bound to store A can submit its command to a replacement service bound to store B. Command requests carry no expected protocol or binding identity, so the new service cannot reject the stale client.

## Affected flow

This blocks [Bind the developer shell to Local Core storage authority](01-bind-developer-shell-storage-authority.md) and [Make incompatible developer-shell replacement exclusive](03-make-incompatible-service-replacement-exclusive.md), implemented through `fa4d681ce..337b5897a`.

The trigger is replacement after `ensureService` accepts compatible health but before `performRequest` sends the command. Filesystem bootstrap serialization cannot make these two HTTP exchanges atomic and does not protect a request already released from the startup authority.

## Repair requirements

- Carry the caller's expected current protocol, store driver, and opaque binding revision on every command/process mutation or read request whose result depends on store authority.
- Validate that expectation inside the service before invoking the supervisor; reject a mismatch without starting, mutating, or reading a process under the wrong store.
- Keep database URLs and credentials out of the request, failure, log, and health surfaces.
- Preserve compatibility for health checks while rejecting stale current clients safely and model-visibly.
- Use an explicit contract field or request header owned by the private developer-shell protocol; do not infer identity from paths, URLs, or other heuristics.

## Done when

- A deterministic socket-owner swap between health acceptance and command POST is rejected before command execution.
- Matching requests continue to run, read, write, retain, release, promote, and stop processes normally.
- Mismatch output contains only safe identity metadata and says the command did not run where applicable.
- Focused contract and lifecycle tests cover the swap and matching paths.
- Issues 01 through 05 remain satisfied.

## Depends on

None.
