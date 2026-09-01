# Revoke egress after uncertain Browser close

## Failed behavior

The App relay removes the prepared close receipt before `/commit`. If the worker commits `browser.close` but the response is lost or non-successful, the unknown-outcome path retains the Session's shared Gateway credential until hard expiry because no receipt remains to retry cleanup.

## Affected flow

`apps/environment-router/src/app-relay.ts` owns terminal close-commit classification and `HostedBrowserEgressRegistry` cleanup. Closing Gateway authority is safe and mandatory for every terminal or uncertain Browser close path; it must not depend on redispatching the effect.

## Repair requirements

- Close the exact Session egress binding after a successful Browser close commit.
- Also close it when close acknowledgement was accepted but commit response is lost, invalid, times out, or returns a terminal unknown outcome.
- Preserve `BROWSER_ACTION_OUTCOME_UNKNOWN`; never redispatch an uncertain close.
- Do not close another Session or generation after identity drift or receipt replacement.
- Make cleanup idempotent across duplicate delivery, relay retry, and Gateway restart.

## Done when

- A deterministic worker-side close followed by lost commit response leaves no authenticating Gateway credential or open connection.
- Known close success and every terminal/unknown close-commit failure converge on the same exact egress cleanup.
- Pre-acknowledgement failure retains normal not-started semantics without touching unrelated authority.
- Focused relay, receipt, unknown-outcome, credential-isolation, and cleanup tests pass.

## Depends on

None.
