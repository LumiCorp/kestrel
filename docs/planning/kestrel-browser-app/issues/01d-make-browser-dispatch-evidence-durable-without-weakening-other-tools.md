# Make Browser dispatch evidence durable without weakening other tools

## Failed behavior

Repair commit `2e0ee9771` changes the generic tool gateway so an external-effect handler that throws without calling the new acknowledgement hook is recorded as `not_started` and retryable. Existing non-Browser external-effect handlers do not call that hook, so an email or another mutation that reached its provider and then failed while reading the response can now be delivered twice.

The Browser acknowledgement itself is process-local. The effect runner durably claims an effect before the Browser port acknowledges dispatch. A crash after the claim but before dispatch is therefore recovered as an unknown effect even though dispatch never started. Cancellation after acknowledged dispatch also escapes Browser failure normalization and can persist a generic failure instead of the pinned Browser unknown-outcome result.

## Affected flow

This defect blocks [Preserve Browser dispatch and exact results](01b-preserve-browser-dispatch-and-exact-results.md) in repair commit `2e0ee9771`.

`src/io/ToolInvocationSupport.ts` owns handler failure shaping, while `src/effects/EffectRunner.ts` owns durable claim and exact-result recovery. `tools/browser/modules.ts` and `BrowserServicePort` supply Browser dispatch and completed-result evidence. Existing non-Browser external-effect handlers rely on the previous conservative rule that an exception from a dispatched-looking mutation is terminal and unknown.

The repair boundary includes explicit opt-in to the Browser dispatch protocol, durable dispatch-state persistence, Browser cancellation shaping, recovery, and compatibility tests for existing external-effect tools.

## Repair requirements

- Preserve the existing conservative unknown-outcome behavior for every external-effect tool that has not explicitly adopted a stronger dispatch protocol.
- Make Browser dispatch acknowledgement durable and atomically ordered with the existing effect claim/result state so restart can distinguish claimed-but-not-dispatched from dispatched-without-result.
- A Browser failure before durable acknowledgement must be `not_started`. A loss, timeout, or cancellation after durable acknowledgement and before an exact result must be the pinned `BROWSER_ACTION_OUTCOME_UNKNOWN` result.
- A committed exact Browser result must remain authoritative over later cancellation or handler-return loss and replay without redispatch.
- Do not introduce a Browser-specific action ledger or weaken retry safety for Email, Calendar, filesystem, MCP, or other tools.

## Done when

- A non-Browser external-effect handler that throws after a potentially dispatched mutation remains terminal and non-retryable unless that tool explicitly implements the stronger protocol.
- Tests crash before Browser acknowledgement, crash after acknowledgement, cancellation after acknowledgement, committed-result loss, and duplicate delivery across store recreation.
- Restart after a durable claim but before Browser dispatch returns `not_started`; restart after durable acknowledgement without a result returns pinned Browser unknown outcome.
- Close and one additional destructive Browser operation prove exact-result persistence before cleanup.
- Focused exact-effect, cancellation, restart, compatibility, and replay suites pass.

## Depends on

None.
