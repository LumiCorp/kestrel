# Thread Remembered Tool Approval Blast Radius

## Readiness: Ready

The behavior, affected services, versioned stable tool identity, persisted
remembered-approval record, and Web-to-runtime evidence boundary are settled.

The analysis uses deployed-source revision
`b36756002321b7a7e942d9a08799e7b01fa387f3`. The artifact worktree is currently
at `eaf690d779765211e11ba844999b169f4922a6ed`, so implementation must begin from
the evidence revision or a verified descendant.

## Intended Change

Environment approval keeps its current meaning:

- Automatic runs without asking.
- Ask First asks unless the same user remembered approval for this tool in this
  thread.
- Blocked does not run.

An eligible Ask First card offers Decline, Approve Once, and Remember Approval.
Remember Approval authorizes the current exact prepared invocation and records
a user-thread-tool approval for later invocations. It does not edit Environment
or Project policy.

## Direct Impact

| Surface | Impact |
| --- | --- |
| Policy model | Add remembered approval after baseline Ask First resolution and before a per-call prompt. |
| Web decision contract | Replace the optional boolean with `decline`, `approve_once`, or `remember_approval`. |
| PostgreSQL | Add an actor-, thread-, tool-, and authority-bound remembered approval record. |
| Decision transaction | Record the current exact decision and remembered approval atomically. |
| Worker | Load active remembered approvals for the current actor and thread. |
| Runtime | Validate typed remembered evidence and mark later prepared calls automatic for approval purposes. |
| Approval card | Render the three requested choices when an eligible Ask First decision is required. |

## Indirect Impact

- Remove the approval-card Environment Apps detour. Environment Apps remains
  the independent place to edit broad policy.
- Update Mobile from a binary approval response to the same three-way decision.
- Invalidate remembered approval when tool contract or approval authority
  changes.
- Update the shared protocol and runtime packages. Hosted Web and turn-worker
  behavior changes; CLI, Desktop, and TUI can pass no remembered approvals.
- Integrate with the prepare-before-wait redesign. A remembered approval cannot
  authorize a reconstructed call.

## Protected Behavior

- A different user cannot consume another user's remembered approval.
- Another thread, project, or environment cannot consume it.
- A newly prepared future call still receives full input validation, credential
  checks, execution audit, and effect tracking.
- Remembered approval cannot override Blocked, a disabled tool, subject
  restriction, tool-minimum approval, or explicit runtime strictness.
- Exact payload approval remains attached to the current invocation only.

## State and Invalidation

The remembered record is keyed by organization, thread, authenticated user, and
stable tool identity. Stable tool identity includes tool ID, descriptor contract
revision, and approval-authority revision. It excludes run IDs and renewable
credentials.

The record lasts for the thread. It stops authorizing when the thread is
deleted, the user loses access, the tool or authority revision changes, or a
stricter policy blocks the tool. Environment Automatic makes the record
unnecessary but does not broaden it. There is no listing, Forget, or
user-managed revocation workflow.

## Evidence

- `src/mode/contracts.ts:13-75`: current policy has no thread remembered layer.
- `tools/runtime/UnifiedToolRegistry.ts:1022-1084`: descriptor-bound policy is
  resolved at the tool surface.
- `apps/web/components/chatbot/interaction-panel.tsx:17-85,450-499`: current UI
  and response are binary and use an Environment Apps detour.
- `apps/web/lib/turns/store.ts:1643-1900`: the durable response transaction is
  the atomic write seam.
- `apps/web/drizzle/schema.ts:4599-4681`: interactions have no remembered grant.
- `tools/contracts.ts:258-276` and `packages/protocol/src/execution.ts:334-360`:
  typed hosted policy evidence already crosses into runtime.
- `apps/web/app/api/mobile/v1/threads/[id]/interactions/[checkpointId]/route.ts`:
  Mobile is also binary.

## Unknowns

None block implementation. The compatibility observation period is the maximum
configured old-interaction lifetime plus one complete worker rollout cycle.

## Required Validation

- Policy matrix for Automatic, Ask First, Blocked, and all stricter overrides.
- Atomic PostgreSQL test for current decision plus remembered approval.
- Cross-user, cross-thread, cross-tool, and stale-revision rejection.
- Full hosted flow: ask, remember, and automatic later calls in the same thread.
- New-thread flow that asks again.
- Worker restart and credential rotation.
- Web and Mobile parity.
- Old-interaction compatibility and eventual old-path removal.

## Minimal Context Pack

Objective: add remembered approval as a user-thread-tool authorization beneath
Environment Ask First and above exact per-invocation approval.

Allowed: additive versioned contracts, persistence, runtime resolution, card
choices, thread-lifetime cleanup, tests, and deletion of the old Always Approve detour after
drain gates.

Prohibited: editing Environment policy from Remember Approval, keying grants by
payload or run credentials, sharing grants across users or threads, bypassing a
stricter policy, reconstructing approved calls, or retaining compatibility code
without removal gates.
