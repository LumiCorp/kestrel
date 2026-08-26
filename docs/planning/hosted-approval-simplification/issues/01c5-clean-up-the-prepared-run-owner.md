# Clean up the prepared run owner after continuation

## Failed behavior

Continuation cleanup releases snapshots by session but collapses prepared-call
terminal state under the continuation run ID. When the waiting prepared run and
continuation run differ, the original per-call state remains and an ineffective
continuation tombstone is added, growing both maps on a long-lived worker.

## Affected work

[Close replay and snapshot-creation races](01c2-close-replay-and-snapshot-races.md),
commit `addc425e1`, especially `tools/runtime/UnifiedToolRegistry.ts` and
`tests/unit/tool-invocation-integrity.test.ts`.

## Repair requirements

Cleanup must identify and collapse the actual prepared-call owner, not infer it
from the continuation run ID. Preserve replay protection while bounding state
when waiting and continuation run identities differ.

## Done when

- Repeated differing waiting/continuation runs do not accumulate per-call maps
  or ineffective tombstones.
- The original prepared call remains non-replayable after cleanup.
- Same-run cleanup and restart behavior remain correct.

## Depends on

None.
