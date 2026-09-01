# Keep TUI sessions unstarted until execution actually begins

## Failed behavior

A newly created TUI session can become `started:true` merely because launch or user history was appended, before a runtime thread or assembly exists. Its first turn then takes the started-session recovery path and fails with **Environment unknown**. Operator-launched background work also persists a child as `RUNNING` and started before Local Core profile resolution succeeds, so a resolution failure leaves a durable task that claims to be running even though execution never began.

## Affected flow

This repairs [Bind every TUI session to one exact execution environment](01-bind-tui-sessions-to-exact-environments.md) as implemented by commit `d9660c286`.

For foreground work, `SessionController.createSession` persists an unstarted session and appends launch history. `App.appendHistoryLine` currently turns those transcript writes, including system launch messages and the first user message, into `started:true`. `TuiRunController` then requires runtime identity even though no runtime exists.

For operator-launched background work, `App.handleTasksCommand` persists `delegation.status=RUNNING` and `started:true` before Local Core resolves and validates the inherited exact environment. Resolution failure occurs outside the submission failure handler and leaves the child in a false running state.

The participating repair surfaces are TUI session/history lifecycle accounting, first-turn state transition, operator background launch ordering and failure state, and focused command/controller coverage.

## Repair requirements

- Keep a new foreground session unstarted while launch and first-user history are recorded.
- Treat accepted runtime execution, a durable runtime thread, or a durable assembly as the start boundary; transcript presence alone is not execution.
- Preserve first-turn selection of the session's exact pre-start environment.
- Resolve and validate a background child's inherited environment before recording it as started and running.
- If background launch setup fails after a child record is created, leave durable truthful failure state rather than `RUNNING` without a runtime.
- Preserve transcript delivery metadata, history recovery, task visibility, environment immutability after actual start, and existing execution approval policy.
- Do not infer execution start from message role, text, task wording, or tool availability.

## Done when

- A newly created workspace-bound session can append launch history and complete its first turn under `cli_dev_local` without requiring a pre-existing runtime assembly.
- A newly created detached session can do the same under `cli_safe_local`.
- First-turn acceptance moves the session to started state without changing its environment.
- A failed background profile resolution never leaves a durable child reported as running.
- A successful background launch still inherits and persists the parent environment before execution.
- Focused regression checks cover the foreground first-turn path and both successful and failed background launch setup.
- Complete-flow validation proves the original issue 01 outcome and constraints still hold.

## Depends on

None.
