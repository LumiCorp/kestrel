# Persist Desktop viewer authority loss across restart

## Failed behavior

The Desktop viewer coordinator retains current and pending authority only in process memory. If Desktop exits while Local Core remains alive and exact cleanup cannot complete, restart loses the old identity. A replacement renderer can then be rejected by the retained Local Core principal or can accidentally reuse a process-local principal identifier and inherit the stale connection.

## Affected flow

Desktop main-process viewer coordination owns the exact renderer principal and Local Core loss request. It needs one small private journal for that single identity; this is not a general runtime recovery protocol.

## Repair requirements

- Durably record the exact sender principal, Thread, Project, Session, generation, and connection before treating a viewer connection as current.
- Durably retain the exact loss reason before cleanup is attempted.
- On Desktop startup, load any retained current identity as pending restart loss and retry it before accepting a viewer connection.
- Clear the journal only after Local Core confirms exact loss, exact explicit disconnect/close, or proves that exact Session and generation terminal.
- Reject malformed, partial, symlinked, over-permissive, or identity-drifted journal state without connecting a replacement viewer.
- Keep human control fail-closed; restart cleanup must never return control to the agent or bind the old connection to the new renderer.

## Done when

- A process-restart regression with surviving Local Core proves the old exact connection is revoked before a replacement connects.
- Lost cleanup during quit survives restart and retries idempotently.
- Reused sender/bootstrap identifiers cannot inherit the retained connection.
- Corrupt and drifted journal tests fail closed without changing another Session.
- Focused Desktop coordinator, persistence, restart, Local Core viewer, and cleanup tests pass.

## Depends on

None.
