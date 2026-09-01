# Resolve legacy queue forks from exact authority

## Failed behavior

Issue 21 introduced queue-graph validation, but it assumes every collection's array order is durable submission order. Legacy reservation arrays were populated in routed-response order, so reverse responses can make eager fork normalization invent the opposite runtime chain. Mixed terminal/active forks, dangling predecessors, raw-record restart settlement, and checkpoint retries that reuse one message identity can also leave the graph invalid or permanently unpromotable.

## Affected flow

This repairs [Reconcile queue graphs and pre-route events](21-reconcile-queue-graphs-and-pre-route-events.md) as implemented by commit `0d822a534`.

The owning surface remains the shared queue graph plus exact runtime reconciliation. Persisted ordering may be used only for pending journal records whose order is the serialized submission order. Reservation response order and terminal collection order are not submission authority.

## Repair requirements

- Do not eagerly chain same-predecessor legacy reservations or terminal records by array order. Preserve the fork and prevent a new successor from being appended while its tail is ambiguous.
- Resolve a legacy fork incrementally from exact runtime authority. When exact Q1 start/terminal/current evidence advances accepted authority from R0 to Q1, durably rewire remaining active siblings that named R0 to Q1. Then exact Q2 may promote. Apply live and after restart, including reverse reservation response order.
- Repair mixed terminal/active legacy state when exact accepted Q1 and its tombstone establish that active Q2 is the remaining successor. Rewire Q2 to Q1 live and on restart; otherwise fail closed if more than one interpretation remains.
- Require every active predecessor chain to terminate at the session's exact accepted run or an exact persisted record that itself reaches accepted authority. Reject dangling roots before queueing or dispatch; do not extend an issue-20 dangling graph.
- During restart/indeterminate reconciliation, locate each record by exact run/message/thread identity in the current normalized graph immediately before settling it. Never apply a raw pre-normalization loop snapshot.
- Give each checkpoint retry a fresh protocol message/run identity while retaining the captured user turn, session, profile, workspace, environment, and recovery history. Original and retry records must remain independently valid across later queueing and restart.
- Preserve exact route/event idempotence, pending pre-route ownership, settlement serialization, independent tombstones, and deterministic durable evidence.

## Done when

- Persisted legacy reservation fork `[Q2->R0, Q1->R0]` followed by authoritative Q1 then Q2 promotion succeeds live and after restart without using array order as runtime order.
- Accepted/terminal Q1 plus active Q2 sibling state rewires Q2 to Q1 and promotes correctly live and after restart.
- Ambiguous unresolved forks block Q3 without dispatch; exact Q1 authority resolves the fork and then allows Q2 and Q3 in order.
- A dangling `Q2->missing Q1` graph fails closed before any Q3 submission or dispatch.
- Mixed-route indeterminate restart reconciliation cannot recreate a fork or rewire from stale raw evidence.
- Queued checkpoint recovery uses distinct message identities, completes without deadlock, and remains valid after a subsequent queue and controller reconstruction.
- Existing queue-graph, controller, app-command, session-store, restart, checkpoint, event-ordering, environment, and lifecycle focused tests remain green.

## Depends on

None.
