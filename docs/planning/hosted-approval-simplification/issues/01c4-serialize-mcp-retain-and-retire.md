# Serialize MCP retain, release, and retire

## Failed behavior

A retain can race the final release while transport close is in flight,
leaving a live owner pointing at a closed client whose reference count was
deleted. A failed `retire()` also leaves the manager in `closing` state, so
a later retire call returns without retrying the failed close.

## Affected work

[Make production MCP cleanup retryable](01c3-make-mcp-cleanup-retryable.md),
commit `addc425e1`, especially `src/mcp/McpClientManager.ts` and its tests.

## Repair requirements

Serialize retain with the same per-client lifecycle transition as final
release/close, or reject retain once retirement owns the client. Failed retire
must remain retryable. No caller may receive or retain a handle whose transport
has closed, and successful cleanup must remain exactly once.

## Done when

- A retain racing blocked final close cannot create a live closed handle.
- Failed retire retries and closes the transport on the next call.
- Concurrent lifecycle tests use controlled production-manager interleavings.

## Depends on

None.
