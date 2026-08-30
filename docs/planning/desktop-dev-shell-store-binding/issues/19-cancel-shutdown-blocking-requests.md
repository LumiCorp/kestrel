# Cancel shutdown-blocking requests before replacement times out

## Failed behavior

Shutdown waits for every admitted request, but an executing command can outlive the replacement protocol's fixed deadline and an abandoned body can remain open until Node's much longer default request timeout. Either request recreates `DEV_SHELL_SERVICE_UNAVAILABLE` even though cooperative shutdown was accepted.

## Repair requirements

- Abort incomplete request bodies when authenticated shutdown begins.
- Interrupt command and process waits through the existing developer-shell command-options surface.
- Terminate an interrupted one-shot command through the supervisor so transcript, source-write guard, and store settlement complete before request drain.
- Preserve drain-before-store-close and endpoint-removal-after-cleanup ordering.

## Done when

- An authenticated headers-only body cannot block incompatible-service replacement.
- A command with a duration beyond the replacement deadline is interrupted and replacement succeeds.
- Interrupted command evidence settles before the old service endpoint disappears.

## Depends on

None.
