# Make endpoint removal prove cleanup completion

## Failed behavior

The replacement client now treats disappearance of the proven socket identity as shutdown completion, but the daemon closes and removes that endpoint before closing supervised processes and its store handle. Replacement can therefore initialize the same store while the old daemon is still cleaning up.

## Repair requirements

- Mark the service shutting down before accepting more work.
- Reject health and command traffic while cleanup is in progress.
- Close supervised processes and the store before closing/removing the proven socket identity.
- Preserve idempotent authenticated shutdown and bounded replacement waiting.

## Done when

- Socket disappearance implies supervisor and store cleanup have completed.
- Requests arriving during cleanup fail safely and cannot dispatch work.
- Slow active-process cleanup blocks replacement until the endpoint is removed.

## Depends on

None.
