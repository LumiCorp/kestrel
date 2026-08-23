# Snapshot exact results before asynchronous persistence

## Failed behavior

The pre-return persistence seam retains the gateway-owned `AgentToolResult` object and detects conflicts by reference identity. Deferred mutation can change output or replay evidence while Postgres awaits transaction work, causing memory/Postgres divergence or binding a different result than the one first validated.

## Affected work

GitHub issue #414, commit `50f822d5f`, `EffectRunner`, execute-tool handling, and exact capability effect persistence.

## Repair requirements

Canonicalize and snapshot the completed result before the first asynchronous persistence boundary. Validate replay evidence from that immutable snapshot, persist that snapshot, and compare any later handler output canonically rather than by object identity. Mutation of caller-owned objects must neither alter durable replay nor silently change the delivered result.

## Done when

- Deferred output and evidence mutation cannot alter the persisted snapshot.
- Conflicting post-handler content is rejected canonically.
- In-memory and Postgres tests cover deferred mutation and produce identical behavior.
- Exact replay returns the immutable persisted result with no live work.

## Depends on

08.
