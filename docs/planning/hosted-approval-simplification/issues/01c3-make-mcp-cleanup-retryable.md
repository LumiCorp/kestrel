# Make production MCP cleanup retryable

## Failed behavior

The registry preserves failed ownership for retry, but the production MCP
manager decrements handle references and marks clients closed before their
cleanup succeeds. A retry can therefore become a no-op while the underlying
transport remains open, after which registry ownership is discarded.

## Affected work

[Complete prepared execution ownership and shutdown safety](01c1-complete-prepared-resource-ownership.md),
commit `d693036b6`, especially `src/mcp/McpClientManager.ts`,
`tools/runtime/UnifiedToolRegistry.ts`, and their lifecycle tests.

## Repair requirements

Reference release and provider close state must commit only after the owned
cleanup succeeds, or otherwise retain enough exact state to retry safely.
Retries must not double-release successful ownership or hide an open transport.
Tests must exercise the production manager semantics rather than a fake whose
failure occurs before its state transition.

## Done when

- A failed retired-client release succeeds on a later retry and closes once.
- A failed provider close succeeds on a later retry and closes once.
- Registry ownership remains until production MCP cleanup actually succeeds.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
