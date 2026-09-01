# Commit One receiving presentation atomically

## Failed behavior

One applies domain choices, clears the write-only form, and can report save success before the follow-up connection reconciliation has been parsed and validated. A malformed successful reconciliation can therefore leave partial new state or contradictory success and error messages.

## Affected work

This repairs [Reject malformed successful receiving responses in One](23-validate-one-receiving-responses.md) in change `5528e275b..2e3e8ce68`, specifically operation ordering in `apps/web/components/settings/receiving-client-controller.ts`.

## Repair requirements

Each winning load, inspection, and save must validate every successful response needed for the operation before committing any related presentation changes. If reconciliation is malformed, preserve the prior connection, domain choices, API-key and domain form values, and success/info messages while showing only the safe operation failure. Stale-operation and unmount guards must continue to prevent late writes.

## Done when

- A domain inspection test uses distinct old and returned choices and proves malformed reconciliation preserves the old choices.
- A save test proves malformed reconciliation preserves the write-only form and emits no success.
- Winning operations still commit their final reconciled presentation exactly once and retain the existing busy-state guarantees.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
