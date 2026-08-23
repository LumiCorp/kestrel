# Close the concurrent availability probe race

## Failed behavior

Two callers can probe the same `unknown` blob concurrently and receive different storage results. The caller that observes the object exists can return success even after the other caller conditionally records the blob as `missing`, leaving the caller with a stale success against durable state.

## Affected work

This blocks [Make blob availability durable across every byte consumer](01-enforce-durable-blob-availability.md) and follows repair wave commit `6ee822348`. The owning path is `apps/web/lib/files/availability.ts:ensureFileBlobAvailable`, where the conditional update result is ignored.

## Repair requirements

Availability resolution must return or reject according to the committed durable state. Concurrent callers must not proceed successfully when another caller has won the transition to `missing`. Preserve lazy checks, exact-not-found classification, unchanged transient-error state, and shared-blob semantics.

## Done when

- Concurrent differing probes cannot return success after the durable row is `missing`.
- The implementation either serializes/re-reads the row or otherwise proves the committed state before returning.
- A concurrent regression test covers one `available` and one `missing` probe and verifies the losing caller observes the committed state.
- Existing unknown, available, missing, transient, and deleted behavior remains covered.

## Depends on

None.
