# Preserve successful results when a selected capability is unused

## Failed behavior

`CodeExecutionService` attaches capability replay evidence at issuance. If sandbox code exits successfully without invoking the capability, teardown revokes and cleans the unused lease. `EffectRunner` then routes the successful result through the strict completed-provider persistence path, which rejects it and records the effect as failed.

## Affected work

GitHub issue #414, commit `19fb21964`, `CodeExecutionService`, `SandboxCapabilityLeaseCoordinator`, `EffectRunner`, and both lease stores.

## Repair requirements

A selected but unused capability must not invalidate a successful `code.execute` result. The exact final `AgentToolResult` must be persisted as DONE and replayed without credential resolution, provider access, broker work, or Docker. Capability-specific atomic persistence must distinguish completed provider evidence from an unused terminal lease without weakening exact binding or replay checks.

## Done when

- A selected but unused capability preserves the successful tool result.
- The effect is durably DONE and replays the exact result.
- Replay performs zero credential, provider, broker, and Docker calls.
- In-memory and Postgres contracts cover the behavior.

## Depends on

01.
