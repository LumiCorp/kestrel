# Keep repeated request-response cycles in causal transcript order

## Useful outcome

Kestrel users can read a durable turn in the order the exchange happened. Web and TUI show each assistant request before its user response, even when one turn pauses several times.

This slice replaces the shared role-based phase order with the causal transcript contract. It also gives every client one conformance scenario and one structured failure for contradictory ordering evidence.

## What changes

Keep the current identity-based turn binding in `@kestrel-agents/conversation`. After a message belongs to a turn, treat its position in `ConversationSnapshot.messages` as the host's durable presentation preference.

Replace `messagePhase` ordering with a stable causal projection. The turn input must precede all other messages in its turn. Each interaction's assistant request must precede its linked response when both messages exist and belong to that turn. When several messages are eligible, emit the earliest message in host source order.

If explicit edges form a cycle, return every owned message in host source order. Add one `MESSAGE_ORDER_CONFLICT` projection issue for the turn. Include the cycle's message IDs in host order. Do not fall back to roles or UUIDs.

Add a shared conformance scenario with two resolved waits and a final assistant continuation. Choose IDs whose lexical order disagrees with the required transcript. Carry that scenario through the package, Web, Desktop adapter, and TUI adapter conformance suites.

Keep Web's existing projection alert and TUI's existing projection diagnostic behavior for the new issue. Prove that Web renders the shared message sequence in DOM order after a durable snapshot projection. Update the conversation package documentation to separate identity-based ownership from causally constrained source order.

## Requirements and delivery context

The current repair owner is `packages/conversation/src/projector.ts`. It already binds messages through the turn input ID, interaction message IDs, and `kestrelTurnId`. Keep those ownership rules and the existing missing-turn, ownership-conflict, and turn-sequence issues.

`packages/conversation/src/contracts.ts` carries the ordered message array but does not document its presentation authority. Strengthen that contract without changing the snapshot shape. Web already supplies messages in `created_at, id` order and complete historical interaction pairs. TUI and Desktop already supply ordered transcripts, even when historical interaction pairs are absent.

Null, missing, or cross-turn interaction links must not create guessed edges. Array position must not establish ownership. Text, timestamps, roles, adjacency, and UUIDs must not become new ownership or chronology heuristics.

Do not add persisted sequence data, message metadata, schema migrations, backfills, event replay dependencies, compatibility branches, or dual writes. Do not change authentication, authorization, queue behavior, composer behavior, standalone-message placement, or legacy ownership behavior.

Web renders the projected array in `apps/web/components/chatbot/messages.tsx`. TUI logs projector issues through `TuiRunController`. Preserve those existing host responsibilities. Desktop's later activity-message composition is handled by the dependent issue.

The canonical requirements are in the [Conversation Causal Ordering Product Brief](../../conversation-causal-ordering-product-brief.md).

## Done when

- A repeated six-message exchange projects as input, request 1, response 1, request 2, response 2, and continuation across the package, Web, Desktop adapter, and TUI adapter conformance suites.
- An already-valid source transcript remains unchanged, including ordered Desktop and TUI transcripts without historical interaction links.
- A reversed linked pair is repaired from explicit identities without timestamp, role, adjacency, or UUID chronology.
- Null, missing, and cross-turn links do not create inferred ordering edges.
- A causal cycle preserves every message in host order and emits one deterministic `MESSAGE_ORDER_CONFLICT` with the affected turn and cycle IDs.
- Web displays the repeated exchange in visible and DOM order and retains its existing projection alert for the new conflict.
- After a full reload, the reported Web task shows `what happened?`, each clarification and response, and the final assistant message in causal order.
- TUI retains the shared conversation-lane order and records the new conflict through its existing diagnostic path.
- Package documentation states that identities establish ownership and host source order guides presentation after ownership is known.
- Existing projection, reconciliation, standalone-message, legacy, ownership-conflict, turn-sequence, Web, and TUI tests pass.
- `pnpm validate` passes.
