# Resume the exact Browser call after approval

## Failed behavior

Commit `4e33f46b9` skips exact preparation before a Desktop Browser approval and prepares again after approval. Browser policy can change between approval validation and that preparation, so revision B may execute under revision A's approval. If a pending grant re-resolves to `allow` or `deny`, Desktop remains forced through the pending approval path and can fail while constructing an empty-capability binding instead of automatically continuing or blocking.

## Affected flow

`agents/reference-react/src/steps/acter.ts`, `policyGates.ts`, and `toolBatchHandler.ts` own Desktop/hosted single and batch waits. `tools/runtime/UnifiedToolRegistry.ts` owns trusted inspection and exact preparation.

## Repair requirements

- Prepare and durably bind the exact Browser call and combined runtime/Browser policy revision before committing a Desktop or hosted approval wait.
- Resume only that exact prepared call. Never prepare a different revision under an earlier approval.
- When pending authority re-resolves to `allow`, continue without a new approval; when it resolves to `deny`, block without approval; only `approval_required` may remain pending.
- Apply identical behavior to Desktop and hosted single and per-item batch paths.
- Preserve non-Browser approval and batch behavior.

## Done when

- A policy change between wait, approval, resume, and dispatch cannot authorize a newly prepared Browser call.
- Pending grant transitions `approval_required -> allow` and `approval_required -> deny` produce automatic execution and stable blocking respectively on Desktop and hosted paths.
- Single and batch items resume the exact prepared call and do not borrow another item's approval.
- Focused Acter, approval, batch, prepared-call integrity, and replay suites pass.

## Depends on

None.
