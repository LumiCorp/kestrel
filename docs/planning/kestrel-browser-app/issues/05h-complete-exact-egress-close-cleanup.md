# Complete exact Browser egress close cleanup

## Failed behavior

Accepted `browser.close` paths before `/commit` still use Session-wide Gateway cleanup, so a stale generation can revoke its replacement. The exact cleanup path also removes the registry handle before teardown and permits a throwing resource destructor to abort later cleanup, change the required relay response, and make the retained authority non-retryable.

## Affected flow

`apps/environment-router/src/app-relay.ts` owns terminal and uncertain Browser close classification. `HostedBrowserEgressRegistry` owns exact generation binding and total connection teardown. Every accepted close outcome must converge on one exact, nonthrowing cleanup invariant without redispatching the Browser effect.

## Repair requirements

- Use exact Session and generation cleanup for every accepted `browser.close` invoke, completion, and commit success or unknown-outcome path.
- Never apply a stale close receipt to a replacement generation.
- Attempt teardown of every tracked connection and resource even when one destructor throws.
- Keep credentials unusable once exact close begins and retain enough internal authority to finish or safely repeat teardown.
- Isolate the required relay response classification from cleanup failures: known success remains `200`; uncertain accepted close remains `409 BROWSER_ACTION_OUTCOME_UNKNOWN`.
- Never redispatch an accepted or uncertain close.

## Done when

- A relay-level replacement-generation regression proves stale invoke/completion cleanup cannot revoke the replacement.
- Injected resource-destruction failures prove every connection is attempted, the closed credential cannot authenticate, and repeat cleanup is safe.
- Successful and unknown close responses remain exactly `200` and `409` while cleanup faults cannot create a `502` or redispatch.
- Focused relay, Gateway registry, connection teardown, identity-drift, and unknown-outcome tests pass.

## Depends on

None.
