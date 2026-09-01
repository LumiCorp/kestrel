# Recover each saved collaborator reply once

## Useful outcome

Every saved local collaborator reply reaches the parent Thread once, in order,
even when the parent is busy or the runtime restarts. The parent receives the
reply as collaborator input and never mistakes it for a user message.

## What changes

Harden the existing `onDialogReply` and `FollowUpQueue` path instead of adding a
new generalized outbox.

Save the collaborator reply before making it eligible for parent delivery. Keep
enough delivery state in the existing dialog record to distinguish a saved
reply that still needs enqueue from one already represented in the parent
queue. Use the stable reply message ID as the follow-up identity so repeated
reconciliation is idempotent.

If the parent is idle, use the existing detached-turn path. If the parent is
busy or waiting, keep the follow-up in the existing durable queue until the next
safe parent continuation. Separate replies from two collaborators must remain
separate and causally identified.

Each follow-up must carry `dialogId`, immutable name, `sourceMessageId`, open or
closed status, and current activity. The runtime actor must identify a service
collaborator, not a human. Use the exact collaborator-reply instruction from the
Product Brief once the complete five-tool contract is active. Rendered text
such as `Name: reply` may remain for people but is not provenance.

Respect the terminal-close ordering from issue 01. A reply saved before close
remains deliverable and may arrive with closed status. A child completion that
lost the close race has no saved reply and cannot create a follow-up.

On startup or queue recovery, find saved replies still needing enqueue and add
each one once. A crash after enqueue but before delivery must not create a
second follow-up. Existing human follow-ups and queue pause behavior must remain
unchanged.

## Requirements and delivery context

The canonical requirements are in the [Local Named Collaborators Product Brief](../../named-sub-agents-product-brief.md).

Current enqueue wiring is in the `DelegationSupervisor` construction inside
`src/orchestration/ThreadRuntime.ts`. Queue state and idempotency are in
`src/orchestration/FollowUpQueue.ts`. The `source === "dialog"` branch owns
structured collaborator metadata, actor identity, and the reply instruction.

Use those seams. Do not add a general runtime outbox, provider observer,
delivery worker, remote retry state, or A2A delivery semantics.

## Done when

- A saved collaborator reply creates one parent follow-up, and repeated scans,
  queue resumes, or process restarts cannot duplicate it.
- A parent-busy reply waits and later runs in serialized order without
  competing with the active parent turn.
- The detached turn receives structured dialog, source-message, lifecycle, and
  activity identity and is never presented as human input.
- Two collaborators replying near the same time remain separate and ordered by
  their durable enqueue identities.
- A reply-first close race delivers once with current closed status; a
  close-first late completion never appears.
- Restart tests cover crashes before enqueue, after enqueue, and after parent
  delivery acknowledgement without loss or duplication.
- Existing human follow-ups, queue pause and resume, and ordinary detached turns
  remain green.
- Focused reply, queue, concurrency, restart, attribution, and replay tests
  pass.
- `pnpm validate` and `pnpm validate:process` pass.

## Depends on

- [Make local collaborator close terminal](01-make-local-close-terminal.md)
