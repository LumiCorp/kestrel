# Persist accepted queue order authority

## Failed behavior

Issue 23 made runtime ordering explicit, but the accepted queued run's predecessor is not durably retained as accepted-session authority. Several paths therefore fall back to process-local terminal memory or partial sibling inference. Across restart, delayed terminals can overwrite newer accepted runs, sequential terminals can be suppressed, valid deeper chains can be flattened, existing tombstones are excluded from ordered reconciliation, single terminal candidates bypass message correlation, and undefined-root forks can still extend.

## Affected flow

This repairs [Order legacy forks from complete runtime evidence](23-order-legacy-forks-from-runtime-evidence.md) as implemented by commit `53aaa1a57`.

The owning repair is an optional durable accepted-queue predecessor identity plus one exact runtime ordering reconciler shared by live terminal settlement and startup describe. This is backward-compatible persisted evidence, not a label or policy field.

## Repair requirements

- Persist the exact predecessor of an accepted queued run alongside accepted run/message/thread identity. Populate, round-trip, compare, and clear it atomically on queued start/terminal promotion; preserve backward compatibility for legacy sessions without it.
- Do not use `acceptedTerminalBySession`, event arrival order, collection order, or a lone sibling as lifecycle authority. Process-local caches may optimize delivery only when they cannot change durable acceptance.
- Resolve ambiguous direct queued terminals through an authoritative conversation view with exact session/thread/run/source-message/status and unique turn sequence correlation. If authority is unavailable or ambiguous, tombstone/preserve evidence fail-closed without emitting output or promoting the wrong run; later exact reconciliation must complete it.
- Include existing terminal tombstones as correlation candidates during ordered restart reconciliation. A crash state with tombstoned Q1 and active/tombstoned Q2 must be ordered and advanced from exact turn sequence, or remain durably blocked when evidence is incomplete.
- Require exact source-message correlation for every terminal candidate, including a single candidate. Run/status-only matching cannot claim a reservation.
- Bind only an actual unresolved direct sibling: its predecessor must equal the accepted queued run's persisted predecessor and complete runtime evidence must order it after the accepted run. Never select or rebind deeper descendants such as Q3->Q2 during duplicate Q1 start or partial-route reconciliation.
- Detect unordered sibling forks whose predecessor is undefined. Missing accepted identity never makes an undefined-root terminal/active fork safe to extend.
- Recompute output/history ownership from the final durable reconciled session so completed/failed/cancelled output is emitted exactly once for the actual current terminal.

## Done when

- Sequential direct Q1 then Q2 completed/failed/cancelled events through one controller promote and emit Q2 exactly once when authoritative ordering proves Q1 before Q2.
- After restart from accepted terminal Q2 plus unresolved Q1 sibling, delayed Q1 cannot overwrite Q2; exact later describe can resolve the terminal-only fork.
- Duplicate exact Q1 start and partial-route restart reconciliation preserve a valid Q1->Q2->Q3 chain unchanged.
- Restart with existing Q1 tombstone plus active or tombstoned Q2 and exact correlated turn sequence advances through Q2; ambiguous evidence blocks Q3.
- A single terminal candidate with absent or wrong `sourceMessageId` remains unclaimed and fail-closed.
- Undefined-root terminal/active siblings with no accepted identity block Q3 before preparation and dispatch.
- Accepted predecessor evidence round-trips through SessionStore and all existing graph, controller, app-command, session-store, restart, terminal-output, checkpoint, environment, and lifecycle focused files remain green.

## Depends on

None.
