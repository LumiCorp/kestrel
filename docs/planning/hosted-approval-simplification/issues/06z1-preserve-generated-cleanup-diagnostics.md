# Preserve internally generated cleanup truncation diagnostics

## Failed behavior

When a getter or array index throws, normalization creates an internal
`unreadable` marker and then immediately handles it as raw user data. The audit
therefore reports no traversal truncation even though evidence was unreadable.

## Affected work

[Prevent forged cleanup evidence normalization markers](06x-prevent-forged-cleanup-evidence-markers.md),
commit `5d9eebaa3`, especially recursive normalization of caught access failures.

## Repair requirements

Carry internally generated unreadable/truncation state through the bounded
projection without making the marker forgeable by raw payloads. Keep the
normalizer total for throwing getters, indices, proxies, and enumeration.

## Done when

- Throwing getters and indices set truthful traversal-truncation diagnostics.
- Equivalent raw inputs remain secret-free, bounded, and store-parity stable.
- Raw marker-like objects still cannot assert internal diagnostics.

## Depends on

[Prevent forged cleanup evidence normalization markers](06x-prevent-forged-cleanup-evidence-markers.md).
