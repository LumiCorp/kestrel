# Retry Desktop viewer authority loss

## Failed behavior

When a Desktop renderer loses authority, main process state forgets the viewer principal before Local Core confirms disconnection. A transient Local Core outage can therefore leave the old connection registered while a replacement renderer receives `principal_conflict` until Session expiry.

## Affected flow

`apps/desktop/src/main.ts` owns renderer-principal lifecycle and the Local Core client owns the exact disconnect request. The repair must retain one exact pending revocation and retry it; it must not broaden viewer authority or silently return control to the agent.

## Repair requirements

- Retain the exact Session, generation, Thread, Project, connection, renderer principal, and loss reason until Local Core confirms authority loss or the Session is proven terminal.
- Serialize replacement viewer connection behind pending authority loss for the same Session instead of accepting stale concurrent principals.
- Retry after Local Core reconnect and during the existing main-window/session cleanup paths.
- Reject identity or generation drift rather than applying a pending revocation to a new Session.
- Keep the Browser Session in `human_control` unless the authorized viewer explicitly returns it.

## Done when

- A failed disconnect followed by Local Core recovery removes the old connection and permits the authorized replacement renderer.
- Restart, renderer crash, account/Thread/App authority loss, Session close, and generation change cannot strand or transfer viewer authority.
- Retry is idempotent and never disconnects a different current viewer.
- Focused main-process, Local Core viewer, reconnect, and cleanup tests pass.

## Depends on

None.
