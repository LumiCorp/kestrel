# Preserve causal message order in the Desktop activity timeline

## Useful outcome

Desktop users can follow repeated assistant requests and user responses in the same order as Web and TUI. Runtime activity remains visible without moving transcript messages around it.

This slice removes Desktop's downstream role grouping after the shared projector has established causal message order. It completes the cross-client behavior for durable turns.

## What changes

Change `projectDesktopConversationTimeline` so each run and unsegmented turn group preserves the relative order of `item.messages` from the shared projection. Do not emit all user messages before activity and all non-user messages afterward.

Treat projected messages as fixed anchors. Desktop may weave run activity between those anchors through its existing activity sequence and timestamp rules. The activity merge must not change the anchors' relative order.

Extend Desktop timeline coverage with the shared repeated-interaction scenario. Include messages that share a run, messages without a run, and activity around both groups. Keep the current legacy fallback for threads without durable turn records.

## Requirements and delivery context

The shared causal order and `MESSAGE_ORDER_CONFLICT` contract come from [Keep repeated request-response cycles in causal transcript order](01-project-messages-in-causal-order.md). Complete that issue before changing Desktop's downstream composition.

The owning Desktop seam is `apps/desktop/renderer/src/runStream.ts`. It currently builds each segment as user messages, run activity, then non-user messages. `apps/desktop/renderer/src/conversationAdapter.ts` already maps the ordered transcript into the shared snapshot and calls the shared projector.

Preserve durable turn sequence, run segmentation, message routes, provisional and standalone placement, unowned activity ordering, scrolling behavior, and `ConversationTimeline` inputs. Keep runtime activity sequence and timestamp semantics. Activity must not become the authority for message chronology.

Do not require resolved interaction history, new message fields, persistence changes, a Desktop operator alert, renderer redesign, or a new operating procedure. Do not change legacy threads that have no durable turn records.

Desktop maintainers own this activity-message composition. Users and operators must not need a repair, migration, feature flag, or manual reorder.

The canonical requirements are in the [Conversation Causal Ordering Product Brief](../../conversation-causal-ordering-product-brief.md).

## Done when

- Desktop shows the shared six-message repeated-interaction scenario in causal order for messages in one run.
- Desktop preserves the same message order when some messages are unsegmented or lack historical interaction links.
- Run activity remains visible and keeps its existing activity order without changing the relative order of projected messages.
- The current user-first/non-user role grouping no longer appears in durable-turn segments.
- Legacy threads, standalone and provisional messages, run segmentation, turn order, unowned activity, and scrolling behavior retain their existing results.
- Desktop adapter and timeline tests cover repeated interactions, activity between message anchors, unsegmented messages, and the legacy fallback.
- The reported cross-client scenario passes the focused package, Web, Desktop, and TUI tests.
- `pnpm validate` passes.

## Depends on

- [Keep repeated request-response cycles in causal transcript order](01-project-messages-in-causal-order.md)
