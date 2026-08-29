# Serialize session mutations and terminal correlation

## Failed behavior

Issue 27 globally orders sessions-file saves, but ordinary same-session mutations may still read and publish stale state before entering the coordinator. Delegated start/terminal events can race, task updates can erase queue authority, direct terminal responses and response-loss recovery still bypass the exact terminal validator, result-less checkpoint failures can install false authority, and delegated starts use wildcard message matching while ignoring pending pre-route submissions.

## Affected flow

This repairs [Serialize session-file authority](27-serialize-session-file-authority.md) as implemented by commit `1d95ebf99`.

The owning repair is a global mutation transaction: read current shared state, apply one session mutation, save the resulting whole-file snapshot, and publish inside one ordered turn. Exact terminal validation must be one shared helper across response, event, and recovery paths.

## Repair requirements

- Move same-session ordinary mutations that can overlap queue authority, including delegated/task lifecycle updates and describe/session projection, inside the global coordinator. Do not read/spread/publish a session before owning the mutation turn.
- A queued start and terminal arriving before the first save releases must serialize from the latest committed session rather than rejecting or dropping the terminal on stale reference identity.
- Task/background updates racing a queue commit must merge from the latest committed child session and cannot overwrite accepted run, predecessor, graph, wait, terminal, history cursor, or exact environment evidence.
- Direct queued completed/failed/cancelled responses must obtain an authoritative view and pass the same unique terminal-turn correlation used by event settlement. Missing, RUNNING-only, wrong message/thread/session/status, or duplicate sequence stays fail-closed with no promotion/output.
- Applied-response-lost recovery must use the shared exact terminal-turn validator, not run/status-only lookup. The message route and terminal turn must both correlate exactly.
- Every result-less queued `run.failed`, including `CONTEXT_CHECKPOINT_PENDING`, is pre-accept. It cannot tombstone or install accepted authority before checkpoint retry; retry retains captured ownership with fresh protocol identity.
- Delegated queued `run.started` requires exact source message identity and accepts exact evidence from pending pre-route submissions or reservations. Missing/wrong message is rejected; delayed route remains idempotent.
- Legacy accepted-predecessor absence plus conflicting active predecessor remains fail-closed unless a complete correlated sequence includes both accepted and successor turns.

## Done when

- Delegated queued start and terminal delivered concurrently before a deferred first save both persist in order; terminal is not dropped and output appears once after exact commit.
- Same-child `task.updated` and history/projection mutations interleaved with successful, before-write-failed, and applied-then-thrown queue commits preserve the correct latest child authority on disk and restart.
- Direct queued terminal and response-loss matrices reject every incomplete/mismatched/duplicate view and accept exact replay once.
- Result-less queued checkpoint failure preserves prior accepted authority and retries without first terminalizing the reserved run.
- Delegated pre-route pending start with exact message is accepted; missing/wrong source message is rejected; delayed routed response does not regress it.
- Legacy undefined accepted-predecessor conflict cannot be synthesized from an active candidate.
- Existing App, controller, SessionStore, graph, delegated/background, persistence-failure, response-loss, checkpoint, restart, terminal-output, environment, and lifecycle focused files remain green.

## Depends on

None.
