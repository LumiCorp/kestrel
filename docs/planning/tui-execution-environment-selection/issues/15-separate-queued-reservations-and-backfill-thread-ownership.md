# Separate queued reservations and backfill thread ownership

## Failed behavior

Issue 14 gives fresh submissions durable run and thread ownership, but queued turns still share the singular pending lifecycle slot with replies and later queued messages. A reply can clear or overwrite a queued reservation, and a promoted queued run that reaches terminal before `run.started` is not owned. Existing accepted sessions created before `acceptedRunThreadId` also cannot accept legitimate terminals after restart.

## Affected flow

This repairs [Persist submission and thread ownership](14-persist-submission-and-thread-ownership.md) as implemented by commit `f5b1c833d`.

The owning repair surface is a persisted exact queued-reservation collection, terminal ownership from that collection, and accepted-thread backfill from durable describe evidence.

## Repair requirements

- Move a confirmed queued route's run/message/thread tuple out of the singular pending submission fields into a persisted exact queued-reservation collection.
- Support more than one queued reservation without overwriting an earlier reservation. A reply/resume must use and clear only its request-owned fields and cannot alter queued reservations.
- On exact queued promotion, remove only the matching reservation and atomically install accepted run/message/thread ownership.
- Treat a terminal event matching one queued reservation's run and thread as authoritative even if it arrives before or without `run.started`. Apply the terminal once, remove that reservation, and reject any delayed start for it.
- Preserve queued reservations through restart and response loss. Do not infer them from labels, timestamps, or ordering.
- When durable describe shows an active or terminal run matching an existing `acceptedRunId` but `acceptedRunThreadId` is absent, backfill the exact described thread atomically for foreground and delegated sessions.
- Never backfill accepted thread from mutable focus or a view whose run does not match the persisted accepted run.
- Keep ordinary UI free of raw reservation and ownership IDs.

## Done when

- A queued turn survives an intervening wait/reply and is accepted on exact promotion.
- Two queued turns retain independent reservations and each exact promotion consumes only its own entry.
- Completed, failed, or cancelled queued promotion delivered before `run.started` becomes terminal exactly once; a delayed start cannot regress it.
- A pre-change foreground or delegated accepted run gains exact accepted-thread ownership from matching durable describe evidence and then accepts its legitimate terminal.
- Mismatched describe run/thread evidence cannot backfill ownership.
- SessionStore round-trips multiple queued reservations, and focused full-file tests pass.
- Complete-flow validation proves issue 14 without weakening exact environment identity or lifecycle monotonicity.

## Depends on

None.
