# Drain in-flight requests before service cleanup

## Failed behavior

A command request can pass the initial shutdown check and then wait for its body. A concurrent authenticated shutdown can begin supervisor/store cleanup before that body arrives; the delayed request then dispatches through resources that are closing or already closed.

## Repair requirements

- Admit requests atomically against the service shutdown state.
- Reject new requests once shutdown begins.
- Recheck shutdown after reading a delayed body and before supervisor dispatch.
- Drain already-dispatched requests before closing supervisor and store resources.

## Done when

- A partially delivered authenticated command followed by shutdown cannot reach the supervisor after its body arrives.
- A request already executing completes before cleanup begins.
- Endpoint removal still occurs only after request drain, supervisor close, and store close.

## Depends on

None.
