# Make queue transactions session-scoped and multi-run

## Failed behavior

Issue 17 orders file writes, but the complete queue transaction can still cross session boundaries or lose truth across concurrent failures and multiple offline terminals. Pre-dispatch awaits continue through mutable active-session state, an inactive projection can change the persisted active session, a failed barrier can be resurrected by a later captured snapshot, and restart reconciliation can represent only one of several exact terminal queued runs. Direct failure and response-loss terminal paths also drop accepted lifecycle evidence, delegated queue owners are skipped at startup, and scripted inactive completion leaks into the visible transcript.

## Affected flow

This repairs [Serialize and reconcile queued ownership](17-serialize-and-reconcile-queued-ownership.md) as implemented by commit `3d137d45d`.

The owning repair surface is a session-scoped pre-dispatch transaction, non-activating session persistence, exact multi-run terminal ownership, and complete queue-owner startup reconciliation.

## Repair requirements

- Capture the submitting session and its resolved workspace/environment authority before any pre-dispatch await can observe a later active session. Apply every identity, workspace, pending-wait, queueing, response, and recovery mutation to that submitting session.
- A focus switch during Local Core preparation, profile resolution, environment resolution, persistence, dispatch, or response handling must not mutate or source workspace authority from the newly active session.
- Persisting or projecting an inactive session must preserve both visible active session state and durable `activeSessionName`.
- Serialize the full per-session pending-queue journal transaction, not only low-level file writes. If one barrier fails, its rollback must be durably settled before a later submission can dispatch or persist a snapshot that resurrects the rejected record.
- A direct queued completed, failed, cancelled, or waiting response with exact pending run/message/thread evidence must install accepted ownership and its lifecycle state before removing the pending record, whether or not the submitting session remains active.
- Response-loss recovery for an exact route already running, waiting, completed, failed, or cancelled must persist accepted ownership plus `pendingWaitFor` and terminal state as applicable before removing recovery evidence.
- Reconcile every exact queued terminal candidate after restart. Multiple terminal queued runs must each receive durable consumed/tombstoned ownership so no delayed `run.started` can regress any of them. Do not discard exact candidates merely because more than one exists.
- Exact queued recovery must not override a different already accepted newer run or weaken the existing legacy accepted-thread backfill rule.
- Scan every inactive session with pending or confirmed queue evidence at startup, including delegated RUNNING and WAITING sessions. Preserve foreground and delegated lifecycle semantics while using the same exact run/message/thread evidence.
- Guard every visible output, including scripted completion transcript lines, so an inactive owner cannot mutate the active session's transcript, run logs, status, workspace, or selection.
- Do not infer ownership or recency from ordering, focus, labels, or timestamps.

## Done when

- Focus switches at each pre-dispatch await leave session A's environment, workspace, queue record, and result on A and leave B unchanged.
- The first of concurrent barrier writes can fail without a later successful snapshot resurrecting it; only submissions with acknowledged durable records reach Local Core.
- Direct failed/cancelled/waiting queue responses and response-loss recovery persist exact accepted ownership and lifecycle state for active and inactive owners.
- Two or three exact queued terminals recovered together are all durably consumed or tombstoned, and delayed starts for each are rejected after another restart.
- Inactive foreground and delegated RUNNING/WAITING queue owners are reconciled at startup without changing durable or visible active selection.
- Scripted and interactive inactive terminals do not change the active transcript, run logs, status, workspace, or session selection.
- Existing queue, reply, environment, legacy backfill, background, restart, and lifecycle proofs remain green under focused full-file tests.

## Depends on

None.
