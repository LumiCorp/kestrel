# Make committed lease results crash-safe and effect-replayable

## Failed behavior

A provider result can be persisted before the enclosing tool effect result. A crash in that window leaves the lease recovery path with a replay disposition that it discards. Later execution can contact the provider again. Result evidence, child settlement, and the consumed transition are also separate writes, creating additional partial-commit windows.

## Affected work

GitHub issue #414, commit `b974371d8`, `SandboxCapabilityLeaseCoordinator.commitResult`, and sandbox lease recovery in `KestrelChatRuntime`.

## Repair requirements

The exact result, usage, child settlement, and replayable lease state must become durable as one recoverable action. Recovery must restore that result through the existing exact tool/effect replay seam without credential resolution, provider access, broker work, or Docker.

## Done when

- Interruption at every result-commit boundary recovers the exact recorded result.
- Restart performs zero credential, provider, broker, and Docker calls.
- Missing committed evidence fails closed without live fallback.
- Secret-free persistence and exact binding checks remain intact.

## Depends on

None.

