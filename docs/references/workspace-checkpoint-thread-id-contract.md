---
id: workspace-checkpoint-thread-id-contract
domain: docs
status: active
owner: kestrel-runtime
last_verified_at: 2026-06-11
depends_on:
  - ../index.md
  - ../../src/workspaceCheckpoints/contracts.ts
  - ../../src/workspaceCheckpoints/service.ts
  - ../../src/orchestration/ThreadRuntime.ts
  - ../../cli/runtime/KestrelChatRuntime.ts
  - ../../apps/web/app/_components/ChatPageClient.tsx
---

# Workspace Checkpoint Thread ID Contract

## Decision

`workspace.checkpoint.capture` and `workspace.checkpoint.restore` must carry the canonical runtime thread ID when a thread ID is supplied.

They must not carry the web app's local tab/thread handle.

In the web client, the canonical runtime thread ID is resolved from `session.state` and then reused for checkpoint capture, checkpoint restore, `operator.thread`, and `operator.inbox`.

## Why This Matters

This field is not cosmetic.

- Workspace checkpoint records persist `threadId` in [src/workspaceCheckpoints/contracts.ts](https://github.com/LumiCorp/kestrel/blob/main/src/workspaceCheckpoints/contracts.ts#L20).
- Restore records also persist `threadId` in [src/workspaceCheckpoints/contracts.ts](https://github.com/LumiCorp/kestrel/blob/main/src/workspaceCheckpoints/contracts.ts#L84).
- The checkpoint service writes that value into durable checkpoint state and replay metadata in [src/workspaceCheckpoints/service.ts](https://github.com/LumiCorp/kestrel/blob/main/src/workspaceCheckpoints/service.ts#L164) and [src/workspaceCheckpoints/service.ts](https://github.com/LumiCorp/kestrel/blob/main/src/workspaceCheckpoints/service.ts#L264).
- Automatic cleanup groups checkpoints by `threadId` when `protectLatestPerThread` is enabled in [src/workspaceCheckpoints/service.ts](https://github.com/LumiCorp/kestrel/blob/main/src/workspaceCheckpoints/service.ts#L563).

If the web client sends a UI-local id here, per-thread retention and replay lineage become detached from orchestration truth.

## The Three IDs

### 1. Web UI thread ID

This is a client-local tab/thread handle.

- It is created in the web app with `crypto.randomUUID()` in [apps/web/app/_components/ChatPageClient.tsx](https://github.com/LumiCorp/kestrel/blob/main/apps/web/app/_components/ChatPageClient.tsx#L3286).
- It indexes local thread summaries, transcript state, desktop tabs, and local event caches.

This ID is valid for client-local state only.

### 2. Session ID

This is the runtime session identifier.

- It is created separately in [apps/web/lib/client/threads.ts](https://github.com/LumiCorp/kestrel/blob/main/apps/web/lib/client/threads.ts#L99).
- It is the stable lookup key for session-scoped calls such as `session.state`, `project.snapshot.*`, and `workspace.checkpoint.list`.

This ID is not the same thing as a runtime thread ID.

### 3. Runtime thread ID

This is the canonical orchestration thread identifier.

- Canonical main threads are created as `thread-main:<sessionId>` in [src/orchestration/ThreadRuntime.ts](https://github.com/LumiCorp/kestrel/blob/main/src/orchestration/ThreadRuntime.ts#L195).
- `session.state` ensures the main thread exists before returning session state in [cli/runtime/KestrelChatRuntime.ts](https://github.com/LumiCorp/kestrel/blob/main/cli/runtime/KestrelChatRuntime.ts#L467).
- The runtime then returns that canonical thread in `session.threadId` / `focusedThreadId` in [cli/runtime/KestrelChatRuntime.ts](https://github.com/LumiCorp/kestrel/blob/main/cli/runtime/KestrelChatRuntime.ts#L589).

This is the only `threadId` namespace that runtime/orchestration code can safely interpret.

## Evidence That Checkpoint `threadId` Means Runtime Thread

### Checkpoint persistence

`WorkspaceCheckpointService.capture()` persists `input.threadId` directly onto the checkpoint record in [src/workspaceCheckpoints/service.ts](https://github.com/LumiCorp/kestrel/blob/main/src/workspaceCheckpoints/service.ts#L164).

`WorkspaceCheckpointService.restore()` persists `input.threadId` onto the restore record and also passes it into the recovery-anchor checkpoint capture in [src/workspaceCheckpoints/service.ts](https://github.com/LumiCorp/kestrel/blob/main/src/workspaceCheckpoints/service.ts#L264) and [src/workspaceCheckpoints/service.ts](https://github.com/LumiCorp/kestrel/blob/main/src/workspaceCheckpoints/service.ts#L296).

### Cleanup semantics

Checkpoint cleanup protects the latest checkpoint per `threadId` in [src/workspaceCheckpoints/service.ts](https://github.com/LumiCorp/kestrel/blob/main/src/workspaceCheckpoints/service.ts#L563).

That only makes sense if the scope key is an orchestration thread identifier, not a client-only tab UUID.

### Replay/store semantics

Replay lookup treats `threadId` as an orchestration-store key in [tests/helpers/InMemorySessionStore.ts](https://github.com/LumiCorp/kestrel/blob/main/tests/helpers/InMemorySessionStore.ts#L705), where it resolves a session by calling `orchestrationStore.getThread(input.threadId)`.

That path cannot resolve a web-local tab id.

## Web Contract

The web client should use these rules:

1. Resolve the canonical runtime thread ID from `session.state`.
2. Cache it in thread state as `runtimeThreadId`.
3. Use that value for thread-scoped runtime and operator commands.
4. Fail closed if a valid session cannot be rebound to a canonical runtime thread.

The current web implementation follows this for operator views in [apps/web/app/_components/ChatPageClient.tsx](https://github.com/LumiCorp/kestrel/blob/main/apps/web/app/_components/ChatPageClient.tsx#L1022), and now also for checkpoint capture and restore in [apps/web/app/_components/ChatPageClient.tsx](https://github.com/LumiCorp/kestrel/blob/main/apps/web/app/_components/ChatPageClient.tsx#L3143) and [apps/web/app/_components/ChatPageClient.tsx](https://github.com/LumiCorp/kestrel/blob/main/apps/web/app/_components/ChatPageClient.tsx#L3202).

## Practical Rule

When a web control payload has a `threadId` field intended for runtime, orchestration, replay, or checkpoint lineage, that field must be a canonical runtime thread ID.

The web UI's local thread id must never cross that boundary.
