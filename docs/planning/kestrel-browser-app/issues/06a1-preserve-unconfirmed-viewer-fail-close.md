# Preserve unconfirmed viewer fail-close

## Failed behavior

When hosted viewer connect completion is uncertain and exact disconnect also
fails, `HostedBrowserViewerService` calls Browser Session termination but
swallows any termination failure. A failure before PostgreSQL marks the exact
Session terminal can therefore return only the original connect error while the
worker connection and nonterminal Session both remain live.

## Affected flow

The viewer service owns connect compensation. `HostedBrowserService` and
`HostedBrowserStore.markTerminal` own the existing durable fail-close boundary:
the exact Session transition and cleanup request are committed together before
machine cleanup. The viewer must distinguish a durably terminal Session from an
unconfirmed termination attempt.

## Repair requirements

- Do not swallow a failed `terminateViewerSession` call or emit
  `browser_viewer_authority_lost` until the exact Session generation is proven
  terminal.
- If termination reports failure after the PostgreSQL terminal transition,
  re-read the exact Session and accept only the matching terminal generation as
  durable fail-close proof. Existing reconciliation owns its recorded cleanup
  request.
- If neither exact disconnect nor terminal Session state can be proven, return
  `BROWSER_ACTION_OUTCOME_UNKNOWN` rather than the original connect failure.
  Preserve enough exact identity in the in-memory connection attempt for socket
  close or an immediate authorized reconnect to retry cleanup; do not mint or
  dispatch a second connection automatically.
- A different proposed connection that encounters the retained exact Local Core
  connection must fail-close the Browser Session rather than inherit or leave
  that authority silently reusable.
- Add regressions for termination failure before the durable transition,
  cleanup failure after the durable transition, and reconnect after an
  unconfirmed connect. Assert no false authority-lost evidence and no connection
  sharing.

## Done when

- Connect uncertainty returns as handled only after exact disconnect or a
  matching durable terminal Session is proven.
- An unconfirmed termination remains an explicit unknown outcome and a later
  connect cannot inherit retained authority.
- A durable terminal transition remains successful even if later machine
  cleanup fails, because existing reconciliation owns the recorded cleanup.
- Focused Web viewer, hosted lifecycle, PostgreSQL CAS, worker, and Local Core
  tests pass.

## Depends on

[Establish exact hosted viewer connections](06a-establish-exact-hosted-viewer-connections.md).
