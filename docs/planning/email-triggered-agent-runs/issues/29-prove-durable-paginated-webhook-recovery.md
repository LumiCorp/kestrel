# Prove durable paginated webhook recovery

## Failed behavior

The restart recovery proof serializes webhook create intent only after the ambiguous POST fails, so it does not establish durable-before-create ordering. Recovery also reads one webhook page and rejects `has_more: true`, leaving an accepted webhook untracked when provider inventory is paginated.

## Affected work

This repairs [Recover an ambiguous Resend webhook create without creating another webhook](15-recover-ambiguous-resend-webhook-creates.md) in change `f44949ffb..5b96e7171`, specifically the adapter's list traversal and restart-style test.

## Repair requirements

Persist or serialize the exact create intent before POST, execute create from a separately rehydrated value, and reconcile after simulated restart from another rehydration and fresh provider instance. Traverse Resend webhook pages with the documented `limit=100` and `after=<last id>` cursor contract until `has_more` is false, then decide exact zero, one, or multiple matches. Empty continuing pages, repeated/non-advancing cursors, malformed pages, and contradictory retrieved evidence fail closed. Recovery remains GET-only and never issues a second POST.

## Done when

- The restart test proves intent durability before the ambiguous create and recovery independence from the failed process's memory.
- A matching webhook on a later page is recovered with exact signing-secret evidence and no second POST.
- Matches split across pages, cursor loops, malformed pages, zero matches, and retrieved mismatches fail closed with redacted evidence.
- No production call site registers or activates a webhook in this repair.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
