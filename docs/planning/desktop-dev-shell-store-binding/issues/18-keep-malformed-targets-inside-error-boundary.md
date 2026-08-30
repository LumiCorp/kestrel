# Keep malformed request targets inside the service error boundary

## Failed behavior

Shutdown admission classifies the request target synchronously in the HTTP server callback. A target that Node accepts but `URL` rejects can throw outside the asynchronous request error boundary and terminate the developer-shell daemon while supervised processes remain active.

## Repair requirements

- Classify shutdown requests without allowing malformed request targets to throw from the server callback.
- Keep malformed targets on the normal request path so the existing error boundary returns an error and releases request-drain accounting.
- Preserve authenticated, idempotent shutdown admission while cleanup is already draining.

## Done when

- A raw malformed request target receives an error without terminating the service.
- An existing supervised process remains manageable after the malformed request.
- The service remains healthy after the malformed request and process cleanup.

## Depends on

None.
