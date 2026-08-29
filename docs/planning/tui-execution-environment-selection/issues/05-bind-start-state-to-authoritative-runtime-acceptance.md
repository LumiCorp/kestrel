# Bind TUI start state to authoritative runtime acceptance

## Failed behavior

A foreground first turn that reaches the runtime but loses its direct response can remain durably `started:false` even after recovery finds its thread or assembly. Background children still become `RUNNING` and started after profile resolution but before `run.start` is accepted, and Local Core preparation failures can leave a child indefinitely `PENDING`.

These windows let a real runtime remain classified as mutable pre-start state, or make task lists claim work started when no runtime exists.

## Affected flow

This repairs [Keep TUI sessions unstarted until execution actually begins](03-repair-tui-session-start-lifecycle.md) as implemented by commit `8949b5579`, and preserves the environment contract from [Bind every TUI session to one exact execution environment](01-bind-tui-sessions-to-exact-environments.md).

For foreground work, `TuiRunController` records start state from the direct command response. When that response is lost, recovery can find authoritative routing, a durable thread, or an assembly without setting `started:true`. `App.syncSessionFromDescribePayload` also persists assembly identity without establishing the corresponding lifecycle boundary.

For background work, `App.handleTasksCommand` persists `RUNNING` and `started:true` before calling `run.start`. A crash, save failure, or rejected submission can therefore leave false running state. `prepareLocalCoreClient` can also throw outside setup failure handling and strand the already-created child as `PENDING`.

The participating repair surfaces are foreground acceptance/recovery state, session-description hydration, background command acceptance and setup failure handling, and focused response-loss/rejection tests.

## Repair requirements

- Treat a direct accepted response, recovered authoritative route, durable runtime thread, or durable assembly as proof that a foreground session is started.
- Preserve `started:false` only when no authoritative runtime evidence exists.
- When session description recovers a durable thread or assembly, persist `started:true` together with its exact environment identity.
- Keep a background child `PENDING` and unstarted until `run.start` has authoritative acceptance evidence.
- Do not emit “started” history or persist `RUNNING` before that acceptance boundary.
- Route Local Core preparation, exact profile resolution, submission rejection, and other pre-acceptance failures through one truthful durable `FAILED` and unstarted transition.
- If a response is lost after background acceptance, reconcile from authoritative runtime state instead of blindly declaring the child failed or unstarted.
- Preserve exact inherited environment, approval policy, delivery identity, deterministic recovery, and environment immutability once runtime evidence exists.

## Done when

- A first foreground turn whose direct response is lost becomes started when recovery finds its durable route, thread, or assembly.
- A genuinely pre-acceptance foreground failure remains unstarted.
- A background child remains pending and unstarted before acceptance, then becomes running and started only after authoritative acceptance.
- Missing Local Core, connection preparation failure, profile conflict, and rejected pre-acceptance submission all persist a failed unstarted child with an exact error.
- A lost response after accepted background execution reconciles to the real runtime state without false failure or mutability.
- Focused regression checks cover every acceptance, rejection, response-loss, and recovery path above.
- Complete-flow validation proves repair issue 03 and original issue 01 outcomes still hold.

## Depends on

None.
