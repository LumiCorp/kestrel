# Preserve Browser dispatch and exact results

## Failed behavior

The Browser handler cannot distinguish a failure before engine dispatch from a timeout after the engine accepted an effect. Every exception from an effectful Browser handler becomes an unknown outcome. A resumed prepared call with no conforming Browser service therefore records `BROWSER_SERVICE_UNAVAILABLE` as an unknown external effect even though dispatch never started.

The service boundary also returns only after host work completes. For close, upload, download promotion, and other operations that can consume authority or destroy state, the host can finish the external effect and lose the process before Kestrel persists the exact result. The completed effect then has no replayable result.

## Affected flow

This defect blocks [Register the Browser App and stable tool contract](01-register-the-browser-app-and-tool-contract.md) in integration commit `114c49840`.

A durable prepared call is rehydrated by `tools/runtime/UnifiedToolRegistry.ts`. The Browser module calls `requireBrowserServicePort` and then `BrowserServicePort.execute`. `src/io/ToolInvocationSupport.ts` maps any exception from an external-effect handler to `unknown`, regardless of whether the service acknowledged dispatch. The current Browser port does not carry the gateway-owned completed-result persistence boundary from `SharedToolContext` into host execution.

The complete repair boundary includes the Browser service contract, Browser handler, prepared-call rehydration and readiness checks, exact-result persistence, dispatch acknowledgement, failure shaping, and replay tests.

## Repair requirements

- A failure before host dispatch acknowledgement must record `not_started`, not an unknown effect.
- Only loss or timeout after acknowledgement without a committed result may produce `BROWSER_ACTION_OUTCOME_UNKNOWN`.
- A completed Browser effect must persist its exact result before destructive cleanup or authority release can make that result unrecoverable.
- Duplicate delivery must return the existing exact result and must not dispatch the engine operation again.
- Restart without a conforming host service must fail closed without terminalizing a never-started effect as unknown.
- Preserve the existing prepared invocation, exact-effect, result, and replay systems. Do not create a Browser-specific action ledger.

## Done when

- Tests distinguish unavailable host, rejected pre-dispatch operation, acknowledged timeout, committed result, and duplicate delivery.
- A crash point after effect completion but before ordinary handler return retains a replayable exact result.
- A resumed call with lost host readiness does not invoke a handler or record an unknown effect.
- Close and another destructive Browser operation prove result-before-cleanup ordering.
- Focused exact-effect, restart, and replay suites pass.

## Depends on

None.
