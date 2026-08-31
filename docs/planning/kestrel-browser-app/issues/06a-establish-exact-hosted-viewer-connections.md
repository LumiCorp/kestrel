# Establish exact hosted viewer connections

## Failed behavior

The hosted worker calls `DesktopBrowserService.connectViewer` with a Session ID
and generation but no connection ID. The reused Desktop contract treats that
partial expected identity as invalid, so a production hosted viewer cannot
establish its first connection. The current unit tests replace the worker engine
with a mock and do not exercise this composition.

If the worker creates a connection but the response is lost, the one-use ticket
has already been consumed and the Web tier does not know which authority to
release. A later ticket can therefore encounter a retained connection and close
the Browser Session.

## Affected flow

The viewer ticket, Web viewer service, Environment Router instruction, hosted
worker, and `DesktopBrowserService.connectViewer` jointly carry one exact viewer
connection identity. The Web control plane must choose that identity before the
first worker effect; the worker must not invent authority after dispatch.

## Repair requirements

- Add one unpredictable connection ID to the signed, one-use viewer ticket and
  bind it to organization, Environment, Project, Thread, actor, Browser Session,
  and generation.
- Carry that exact connection ID through Web, Environment Router, and worker
  validation on `connect`. Reject missing, partial, or identity-drifting connect
  requests before changing viewer state.
- Extend the Local Core viewer seam narrowly so a fully bound proposed
  connection ID creates the first connection when none exists and returns the
  same connection for an exact duplicate. A different connection or principal
  must never inherit the first connection.
- If connect completion is uncertain, use the already-known connection ID to
  release that exact connection. If exact release cannot be established,
  fail-close the Browser Session. Do not retry connect, mint a second authority,
  or guess which connection survived.
- Add a real composition regression using `AgentBrowserHostedWorkerEngine` and
  `DesktopBrowserService`; a mock worker-engine test is not sufficient.

## Done when

- A real hosted viewer establishes exactly one connection.
- Duplicate delivery of the same fully bound connect is idempotent.
- Wrong, partial, stale, and cross-ticket identities are rejected without
  sharing a connection.
- A lost connect response leaves either zero viewer authority or a closed
  Browser Session, never an undiscoverable live connection.
- Focused ticket, Web service, Router, hosted-worker, and Local Core viewer tests
  pass.

## Implementation evidence

- The signed ticket carries one exact proposed connection identity through Web,
  Router, worker, and Local Core validation.
- Concurrent delivery of that exact ticket shares one in-flight settlement;
  settled duplicates re-enter Local Core's exact idempotent connect seam. A
  different ticket, connection, or principal cannot inherit the connection.
- Disconnect, authority loss, termination, and ticket expiry invalidate the
  admission before a delayed connect can publish. Late settlement is cleaned by
  exact connection identity and rejects fail-closed.
- Expiry cleanup retains its retry owner across an unknown cleanup result. Its
  established retirement does not re-enter capacity accounting, so a
  replacement connection may occupy the bounded slot while cleanup of the old
  identity still converges.
- The real `AgentBrowserHostedWorkerEngine` and `DesktopBrowserService`
  composition regression proves one initial connection, a shared concurrent
  duplicate, a sequential exact duplicate, and rejection of a different
  proposed connection. The hosted-worker suite passes 38 tests, TypeScript and
  diff checks pass, and independent ordinary/adversarial review approved the
  result.

## Depends on

[Add hosted browser viewing and human takeover](06-add-hosted-browser-viewing-and-takeover.md).
