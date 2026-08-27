# Show local collaborator status and closed history

## Useful outcome

Users can tell which local collaborator produced a message, whether that
collaborator is still open, what it is doing, and whether its last work failed.
Closed history remains readable without looking available for more work.

## What changes

Extend the existing dialog-message and conversation presentation paths. Do not
build a collaborator dashboard or a new management surface.

Web and Desktop conversation state must preserve and render the immutable name,
dialog ID, sender, open or closed status, idle, working, waiting, or interrupted
activity, message status, and latest actionable failure. Existing operator and
TUI inspection data should expose the same fields where they already show child
Threads or dialog messages.

Keep messages from different collaborators visually and causally distinct.
Show collaborator input as collaborator input, not as a user message. Keep
closed messages in ordinary conversation history. Do not offer send, reopen,
rename, or name-reuse actions for a closed collaborator.

Show busy, interrupted, and failed states in plain language. The product must
not ask users to recover child Thread IDs, repair queue state, or replay
uncertain work. Operators may inspect dialog, child Thread, revision, message,
and pending follow-up IDs through existing runtime inspection, but the normal
user does not need them.

Preserve existing dialog IDs and v1 message rendering. Projection code remains
a presentation layer and cannot decide lifecycle, name availability, or close
ordering.

## Requirements and delivery context

The canonical requirements are in the [Local Named Collaborators Product Brief](../../named-sub-agents-product-brief.md).

Current Web persistence and rendering are in
`apps/web/lib/turns/dialog-messages.ts` and
`apps/web/components/chatbot/message.tsx`. Desktop parses and renders dialog
transcript state in `apps/desktop/renderer/src/state.ts` and `DesktopApp.tsx`.
Operator child summaries are assembled by `OperatorSessionProjection` and
`OperatorControlPlane`.

Reuse those paths. Do not add A2A provider state, Agent Cards, remote artifacts,
new task tables, a standalone collaborator page, or a full presentation
redesign.

## Done when

- Web and Desktop show a local collaborator from open through sequential work
  and terminal close, with all prior messages still readable.
- Open or closed lifecycle is distinct from working, waiting, interrupted, and
  idle activity. A closed collaborator never appears active.
- Busy, interrupted, and failed states have plain, actionable presentation.
- Replies from two collaborators remain distinguishable and cannot appear as
  human messages.
- Existing operator and TUI inspection exposes enough local identity, revision,
  and pending-follow-up state to diagnose close and delivery failures.
- Existing v1 dialog messages remain readable, and malformed added fields fail
  safely without breaking the conversation.
- Focused Web, Desktop, operator, TUI, accessibility, and browser tests pass.
- `pnpm validate` and `pnpm validate:chromium` pass.

## Depends on

- [Give the parent all five local dialog tools](02-give-parent-five-local-tools.md)
- [Recover each saved collaborator reply once](03-recover-saved-replies-once.md)
