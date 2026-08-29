# Finish exact reply and terminal ownership

## Failed behavior

Issue 12 closes the general ordering gaps, but four exact reply and terminal ownership cases remain.

A newly accepted reply on a delegated waiting child can remain durably `WAITING`. A terminal from any older accepted foreground run except the immediately persisted one can still claim a new submission. Exact reply recovery ignores a run that already reached terminal before the fallback view arrived, and an accepted operator-control view that is already terminal can be overwritten as running. Live terminal events also bind by session and run without checking the accepted thread.

## Affected flow

This repairs [Close remaining TUI lifecycle ordering gaps](12-close-remaining-tui-lifecycle-ordering-gaps.md) as implemented by commit `4a0cb963a`.

The owning repair surface is reply acceptance transition, per-submission run/message ownership, terminal route recovery, and live terminal thread validation.

## Repair requirements

- When an exact blocked reply is accepted for a delegated `WAITING` child, transition that child's delegation and wait fields to the new run's truthful lifecycle. Permit `WAITING` to become `RUNNING` only for a newly accepted exact run, while rejecting duplicate starts for the same waiting run.
- Validate every direct foreground terminal against the current pending submission's exact message identity. No retained run from an older message may claim the new submission, regardless of whether it is the immediately persisted prior run.
- Recover an accepted reply from an exact request route when its run is already terminal. Use the matching terminal turn/outcome and durable recovery surfaces; do not require an active run.
- If an accepted `operator.controlled` response carries a view that is already terminal, preserve and recover that terminal state instead of overwriting it as running.
- Validate live terminal event thread identity against the accepted/focused thread for both foreground and background sessions before ownership, history, projection, or refresh mutation.
- Preserve exact session/run/request/message domains, monotonicity, environment and assembly identity, idempotence, and raw-ID non-display.

## Done when

- A delegated waiting child with a newly accepted exact reply becomes durably running, while a duplicate start for the same waiting run does not regress it.
- A terminal for run A cannot claim new message B after intervening accepted run C or any other retained run history.
- Lost accepted replies recover truthfully when their exact route run is already completed or failed.
- An accepted operator-control response with an already-terminal view remains terminal even if the subsequent terminal stream is lost.
- Wrong-thread live completed, failed, or cancelled events cannot mutate an accepted foreground or background run.
- Focused regressions cover these cases and full affected unit files pass.
- Complete-flow validation proves issue 12 without weakening exact environment identity or lifecycle recovery.

## Depends on

None.
