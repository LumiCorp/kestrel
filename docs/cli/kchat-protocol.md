---
id: cli-kchat-protocol
domain: cli
status: active
owner: kestrel-cli
last_verified_at: 2026-06-30
depends_on:
  - kchat.md
  - ../index.md
  - ../../cli/protocol/contracts.ts
---

# CLI Runner Protocol

The CLI and related thin-client surfaces communicate with a runner process or runner service using JSON envelopes. This document covers the command and event protocol, not the store-level `run_events` stream.

## Transport Model

- Local CLI transport uses newline-delimited JSON over stdio.
- Runner-service and web adapters use the same logical command and event shapes over HTTP and streaming wrappers.
- Streaming commands are `run.start` and `job.run`; other commands expect a single terminal response event.

## Envelope Shapes

### Command

```json
{
  "id": "uuid",
  "type": "run.start",
  "payload": {},
  "metadata": {
    "tenantId": "optional",
    "profileId": "optional",
    "actor": {
      "actorId": "user-123",
      "actorType": "end_user"
    }
  }
}
```

### Event

```json
{
  "id": "uuid",
  "type": "run.started",
  "ts": "2026-03-24T00:00:00.000Z",
  "commandId": "uuid",
  "sessionId": "optional",
  "threadId": "optional",
  "runId": "optional",
  "payload": {}
}
```

## Command Types

### Profiles and runtime

- `profile.list`
- `profile.get`
- `run.start`
- `job.run`
- `run.cancel`
- `session.describe`
- `session.state`
- `runner.ping`

### Operator and project state

- `operator.inbox`
- `operator.thread`
- `operator.control`
- `task.graph.get`
- `task.graph.update`
- `project.snapshot.get`
- `project.snapshot.update`
- `project.action`
- `project.review.get`
- `project.review.action`

### Workspace checkpoints

- `workspace.checkpoint.capture`
- `workspace.checkpoint.list`
- `workspace.checkpoint.inspect`
- `workspace.checkpoint.diff`
- `workspace.checkpoint.restore`
- `workspace.checkpoint.cleanup`

### MCP

- `mcp.status`
- `mcp.refresh`

## Event Types

### Profiles, sessions, and runtime

- `profile.listed`
- `profile.loaded`
- `run.started`
- `job.started`
- `job.progress`
- `job.completed`
- `job.failed`
- `run.cancelled`
- `run.log`
- `run.progress`
- `run.reasoning`
- `run.completed`
- `run.failed`
- `runner.error`
- `runner.pong`
- `session.described`
- `session.state`

### Operator, project, and checkpoints

- `operator.inbox`
- `operator.thread`
- `operator.controlled`
- `task.updated`
- `task.graph`
- `workspace.checkpoint`
- `project.snapshot`
- `project.review`

### MCP

- `mcp.status`
- `mcp.refreshed`

## Payload Notes

- `run.start` carries a `turn` payload and optional `profile` or `profileId`.
- `job.run` carries strict `job_input_v1` input and returns strict `job_output_v1` output contracts.
- `run.started` includes execution posture details such as interaction mode, act submode, client capabilities, and execution policy when available.
- `job.completed` always includes `sessionId`, `threadId`, `runId`, and replay pointers.
- `run.completed` returns the terminal `RunTurnResult`.
- `run.failed` and `runner.error` both use normalized `code` and `message` fields; `runner.error` is for validation or dispatch failures before a normal run completes.
- Any runner or control payload field named `threadId` refers to a canonical runtime thread ID, not a client-local UI thread handle.
- `operator.control` is the typed control surface for approve, reject, reply, steer, retry, child-thread, and fan-in actions.
- `workspace.checkpoint` multiplexes capture, list, inspect, diff, restore, and cleanup results behind a single event type with an `operation` discriminator.

## Validation and Failure Semantics

- Command payloads are validated by the runner boundary before execution.
- Invalid payloads surface as `runner.error` with machine-readable error fields.
- Terminal response expectations differ by command: streaming commands emit `run.*` or `job.*` sequences, while non-streaming commands return a single terminal event such as `runner.pong`, `session.described`, `task.graph`, `workspace.checkpoint`, or `mcp.refreshed`.

## Relationship To Store-Level Events

This protocol is the client-facing command and event surface. It is not the same thing as the persisted `run_events` stream in storage.

- Runner protocol events are transport envelopes optimized for clients.
- Store-level `run_events` are the persisted runtime and replay history.
- Some concepts overlap, but event names and payloads are not interchangeable contracts.

## Source of Truth

- Protocol types: [cli/protocol/contracts.ts](../../cli/protocol/contracts.ts)
- Validation logic: [cli/runner/CommandRouter.ts](../../cli/runner/CommandRouter.ts)
- Runner host emission: [cli/runner/RunnerHost.ts](../../cli/runner/RunnerHost.ts)
