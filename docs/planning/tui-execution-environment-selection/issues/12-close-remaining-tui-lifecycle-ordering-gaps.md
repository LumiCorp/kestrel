# Close remaining TUI lifecycle ordering gaps

## Failed behavior

Issue 11 makes fresh-turn and background lifecycle reconciliation exact, but six reachable ordering paths can still persist or display a false lifecycle.

Accepted blocked-run replies can be marked failed when their response is lost. Routed responses can disagree with their own active-run view. Startup can still save an active pending child as `started:true` plus `PENDING` before background reconciliation. An asynchronous describe projection can overwrite newer live acceptance. Conflicting same-run duplicates can change terminal or waiting state. Finally, a command-correlated terminal can reuse an older accepted run or wrong thread for a new foreground submission.

## Affected flow

This repairs [Make TUI lifecycle reconciliation monotonic and exact](11-make-tui-lifecycle-reconciliation-monotonic-and-exact.md) as implemented by commit `4dbaedcc5`.

Blocked-run reply submissions do not persist a correlation identity before `operator.control`, and their `run.started` event has no source message identity. Route validation checks message/session/thread fields but does not require agreement between the routed run and the active-run projection. Startup describes the active session generically before scanning pending background children. Background describe reconciliation captures state, awaits profile projection, then writes from the stale capture. Terminal ownership accepts any event for the same persisted run even after a terminal transition, and waiting can regress on a duplicate start. Foreground direct terminal responses validate envelope/output consistency but not the pending submission's prior accepted run or expected thread.

The owning repair surface is exact submission correlation for reply/resume and fresh turns, startup reconciliation ordering, compare-before-commit lifecycle transitions, and monotonic terminal ownership.

## Repair requirements

- Persist an exact correlation identity before blocked-run reply or resume dispatch, and use exact accepted operator-control or run evidence to reconcile response loss without restoring an obsolete wait or recording false failure.
- Require a routed response's run identity to agree with its authoritative active-run view. A started/running route must provide one exact run identity; mismatch or absence fails closed before mutation.
- Reconcile an active pending or recovering background child through the atomic background path before any generic startup describe save can expose `started:true` with `PENDING`.
- After every asynchronous describe projection, re-read the current session and compare lifecycle/run evidence before committing. Never write from a stale pre-await snapshot.
- Make same-run transitions monotonic. Terminal state is immutable under conflicting terminal duplicates, and `WAITING` cannot regress to `RUNNING` on duplicate start or progress without a new exact run.
- Bind direct foreground terminal responses to the pending submission and expected thread, not merely the session and a self-consistent envelope/output pair. A previous accepted run cannot complete a new message.
- Bind background direct responses to the expected child thread as well as session and reserved run.
- Preserve exact environment/assembly identity, queued-message behavior, terminal recovery, durable evidence, and raw-ID non-display.

## Done when

- An accepted blocked-run reply with a lost response becomes durably running from exact evidence and does not restore the consumed wait or record failure.
- Routed run/view mismatch and a running route without exact run identity fail closed without session mutation.
- Startup of an active pending background child never writes `started:true` plus `PENDING`, including under a crash-observing persistence hook.
- Exact live acceptance interleaved during asynchronous assembly-only describe projection wins and remains running with its accepted run identity.
- Conflicting same-run terminal duplicates cannot alter the first terminal outcome, and a duplicate start cannot regress `WAITING`.
- A prior accepted foreground run and a wrong-thread foreground or background terminal response cannot claim the new pending submission.
- Focused regressions cover all six ordering cases and the full affected unit files pass.
- Complete-flow validation proves issues 06 and 11 without weakening environment immutability or truthful recovery.

## Depends on

None.
