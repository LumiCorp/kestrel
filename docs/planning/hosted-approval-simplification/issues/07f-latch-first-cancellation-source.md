# Latch the first cancellation source

## Failed behavior

Cancellation source is last-writer-wins while an aborted runtime is still
settling. Runner shutdown can overwrite an earlier user-requested cancellation,
or a previously started user cancellation command can overwrite shutdown, even
though the later abort has no effect.

## Affected work

[Preserve the cancellation source](07d-preserve-cancellation-source.md), change
`1aac8fd2a..96e3c4b77`, and active-run cancellation state in
`cli/runner/RunnerHost.ts`.

## Repair requirements

Latch the reason with the first effective transition to cancellation. Later
cancellation requests may observe the active run but must not rewrite the
initiating source or change terminal ownership.

## Done when

- User cancellation followed by overlapping shutdown remains `user_requested`.
- Shutdown followed by an already-running user cancellation command remains
  `runner_shutdown`.
- Focused runner tests cover the overlap without changing cancellation authority.

## Depends on

None.
