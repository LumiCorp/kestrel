# Guard delayed lifecycle signals with child liveness

## Failed behavior

Several lifecycle paths await persistence or startup evidence and then signal the stored numeric process group without rechecking the exact ChildProcess. A fast child can exit during that delay, after which PID reuse could redirect startup abort, failed-start cleanup, stop, retained cleanup, or idle cleanup signals to an unrelated process group. Exit handling also delays descendant cleanup until after persistence work.

## Repair requirements

- Check exact ChildProcess liveness immediately before every signal reached after an await or retained failed settlement.
- Perform descendant process-group cleanup immediately when the original child exit event arrives, before awaiting initial-record or terminal persistence.
- Do not send a second delayed signal from the exit handler.
- Preserve signal escalation for children that remain live.

## Done when

- A fast child can exit behind blocked initial persistence, receive a late shutdown abort and failed-write release, and settle without any delayed numeric signal.
- A dead retained failed-settlement child can traverse stop, idle cleanup, and repeated close without another numeric signal.
- Descendant and ordinary live-process shutdown tests remain green.

## Depends on

None.
