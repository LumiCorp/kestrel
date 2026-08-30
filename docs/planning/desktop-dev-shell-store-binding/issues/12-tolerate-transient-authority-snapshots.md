# Tolerate transient authority snapshots

## Failed behavior

Authority readers combine directory listing and entry reads while writers atomically rename entries. Under contention, a listed entry can disappear before it is read and the reader misclassifies that transient snapshot as stable malformed evidence. Concurrent commands then fail with `bootstrap_authority_invalid`.

## Repair requirements

- Distinguish a vanished listed entry from stable malformed evidence.
- Re-observe transient snapshots within the existing bounded acquisition loop.
- Continue to reject and preserve genuinely malformed evidence without age or ownership heuristics.

## Done when

- A repeated high-contention burst through one cold service completes without invalid-authority failures.
- Stable malformed evidence remains a safe refusal.

## Depends on

None.
