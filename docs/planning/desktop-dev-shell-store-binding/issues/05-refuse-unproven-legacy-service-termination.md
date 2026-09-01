# Refuse unproven legacy service termination

## Failed behavior

Replacement of a legacy protocol-v4 developer-shell service trusts any live PID in a `ready` bootstrap sidecar. Because v4 health has no service PID, a stale sidecar can identify an unrelated process. The client signals that unrelated PID, removes the live service socket, and proceeds to replacement while the actual legacy daemon remains alive.

## Affected flow

This blocks [Make incompatible developer-shell replacement exclusive](03-make-incompatible-service-replacement-exclusive.md), implemented through `fa4d681ce..337b5897a`.

The trigger is incompatible v4 health plus a syntactically valid stale `ready` sidecar whose PID is live but does not own the health endpoint. The current compatibility branch treats the previous protocol version as sufficient proof even though it carries no PID identity.

## Repair requirements

- Never signal a PID for incompatible-service replacement unless current health proves that exact PID owns the endpoint.
- Treat legacy health without service PID identity as insufficient for automatic termination, regardless of a live sidecar PID.
- Fail safely with the existing incompatible-identity guidance and leave both the socket and unrelated process untouched.
- Preserve controlled replacement for current-protocol health when health PID, status PID, socket path, and socket identity agree.

## Done when

- Legacy health plus a stale live sidecar PID does not signal that PID, unlink the socket, or spawn a replacement.
- Current-protocol proven identity still stops and replaces safely.
- Focused regression coverage includes the legacy stale-sidecar scenario.
- Issues 01 through 04 remain satisfied.

## Depends on

None.
