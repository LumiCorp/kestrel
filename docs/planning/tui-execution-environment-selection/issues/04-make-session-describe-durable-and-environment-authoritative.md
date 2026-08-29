# Make session describe durable and environment-authoritative

## Failed behavior

A started session can be resumed without verified runtime environment identity when `session.describe` is unavailable. After a runner restart, a legacy session with durable assembly evidence cannot be described because the runner searches only in-memory runtimes. When another runtime is cached, describing a fresh session can create its main thread through that unrelated runtime and compose the wrong environment before the first turn.

The combined result is that an existing Safe sandbox session such as `default-tmp-3` may become unrecoverable after restart, a fresh Developer workspace session may be poisoned or rejected by a cached Safe runtime, and a switched session may continue without the required persisted-versus-runtime comparison.

## Affected flow

This repairs [Bind every TUI session to one exact execution environment](01-bind-tui-sessions-to-exact-environments.md) as implemented by commit `d9660c286`.

`SessionController.switchSession` currently continues after non-identity describe failures. `TuiRunController` can then trust persisted environment and assembly metadata on an ordinary turn without another describe.

`RunnerHost.describeSession` currently searches only cached runtime instances. After restart that set is empty even when durable thread and assembly records exist. When a runtime is cached, `KestrelChatRuntime.describeSession` calls main-thread creation before proving that the session belongs to that runtime; `ThreadRuntime` can therefore create and compose the missing session through the cached runtime's profile.

The participating repair surfaces are the runner's session-description routing, durable thread and assembly lookup, runtime describe behavior, TUI switch/resume failure handling, and restart/mixed-runtime tests.

## Repair requirements

- Make `session.describe` a read-only projection. Describing a session must not create a thread, compose an assembly, migrate a runtime tree, or otherwise mutate environment authority.
- Resolve a started session from durable session/thread/assembly evidence even when no matching runtime is cached in the restarted runner process.
- Select any runtime used for projection from the session's exact durable identity; never try an unrelated cached runtime in insertion order.
- Project the exact durable `environmentPresetId` needed to recover legacy TUI sessions.
- Before switching or resuming a started session, require a successful exact runtime description and compare it with persisted identity. Transport failure, missing identity, unsupported identity, or conflict must fail closed with user-visible diagnostics.
- Allow an unstarted session with exact persisted pre-start identity to remain describable without constructing runtime state.
- Preserve existing runtime assembly immutability, model-delegated assembly inheritance, deterministic replay, and current Safe sandbox identity for `default-tmp-3`.
- Do not infer identity from labels, workspace paths, tool lists, bundle-name patterns, or cached runtime order.

## Done when

- A started session cannot be activated or resumed when its exact runtime identity cannot be described.
- A runner restart can describe and backfill a legacy session from durable environment and assembly evidence.
- Describing a fresh `cli_dev_local` session while a `cli_safe_local` runtime is cached does not create runtime state and does not change or conflict with the fresh session's identity.
- Mixed cached runtimes resolve only the runtime that owns the exact durable session.
- The describe path has a proof that no thread or assembly is created as a side effect.
- Focused regression checks cover transport failure, restart recovery, cached-runtime isolation, missing identity, and conflict.
- Complete-flow validation proves the original issue 01 outcome and constraints still hold.

## Depends on

None.
