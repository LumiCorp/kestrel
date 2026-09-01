# Make local collaborator close terminal

## Useful outcome

A local named collaborator keeps one durable identity and private child Thread
for the life of its parent Thread. It can accept sequential work while open.
Once closed, it can never run again or give its name to another collaborator,
even when a late child completion races with close.

## What changes

Harden the existing persistent dialog path in `DelegationSupervisor`. Keep the
current delegation record and private child Thread as the owners. Add only the
state and atomic store operations required for:

- an immutable display name and case-insensitive lifetime name reservation;
- open or closed lifecycle and terminal `closedAt`;
- idle, working, waiting, or interrupted activity;
- one active child turn per collaborator;
- a monotonic revision that orders child completion against close;
- stable saved message IDs, sender, status, and time;
- the creation-time profile and capability ceiling.

Open must trim the name, require 1 through 40 characters, reject `Kestrel`,
reserve the normalized name, create one child Thread, save the first message,
and mark the work active before dispatch. It must reject every matching name in
the parent Thread, including names from closed or historical dialogs.

Send must resolve the dialog under the active parent Thread. It must reuse the
same child Thread, reject closed collaborators, and reject a new message while
the current child turn is active. Completed and failed child turns leave an
open collaborator available for later work.

Close must save terminal state and advance the revision before requesting
in-process cancellation. Repeating close is safe. If a child reply saves first,
the reply remains committed. If close saves first, late completion cannot append
a collaborator reply or make it eligible for parent delivery.

On restart, mark vanished active local work interrupted. Keep the collaborator
open for an explicit later instruction, but never replay uncertain work. Never
resume a closed collaborator.

Preserve existing dialog IDs, child Thread IDs, names, and message history.
Reserve each distinct historical normalized name against future use while
keeping duplicate historical records readable by ID.

## Requirements and delivery context

The canonical requirements are in the [Local Named Collaborators Product Brief](../../named-sub-agents-product-brief.md).

The current behavior is owned by `src/orchestration/DelegationSupervisor.ts`,
`DelegationRecord.policy.dialog`, `src/kestrel/contracts/store.ts`, and the
PostgreSQL and in-memory orchestration stores. The current successful child path
writes from a stale record, and name checks ignore closed dialogs. Repair those
owners directly.

Use the smallest durable data change that makes reservation and revision checks
atomic. Do not add a provider abstraction, generalized task model, generalized
artifact stream, generalized delivery outbox, six-table dialog ledger, or
expand-migrate-contract program. Keep one-shot delegation behavior unchanged.

Children cannot open collaborators. Later policy may narrow the persisted
capability ceiling but cannot widen it.

## Done when

- Open creates one local child Thread and one durable open collaborator with a
  lifetime-reserved name before child work starts.
- Sequential sends reuse that child Thread, while concurrent send fails with
  `DIALOG_BUSY` and send after close fails with `DIALOG_CLOSED`.
- Closing is idempotent, preserves all prior messages, prevents reopen and name
  reuse, and keeps `active` false.
- Deterministic tests prove both reply-first and close-first race orders. A
  close-first late completion cannot add a message or pending parent delivery.
- Restart marks vanished active work interrupted without replay and never
  resumes closed work.
- Existing IDs and history remain readable, including historical duplicate
  names, while every historical name is unavailable to new open calls.
- Existing non-dialog delegation behavior remains green.
- Focused lifecycle, concurrency, restart, migration, and PostgreSQL tests pass.
- `pnpm validate`, `pnpm validate:process`, and `pnpm validate:postgres` pass.
