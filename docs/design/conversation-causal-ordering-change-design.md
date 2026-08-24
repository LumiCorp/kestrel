# Conversation Causal Ordering Change Design

## Executive Summary

Kestrel should replace role-based message phases with a stable causal order in the shared `@kestrel-agents/conversation` projector. The projector will continue to establish turn ownership from durable identities. After ownership is known, it will use the host's transcript array as the deterministic source order, constrained by two facts: a turn input precedes the rest of its turn, and each interaction request precedes its linked response.

This is the smallest seam that fits all three clients. Web already supplies the incident's messages in the correct durable order. Desktop and TUI also supply ordered transcripts, even when they do not retain historical interaction pairs. No database migration, timestamp field, event replay dependency, or renderer-specific repair is needed. Desktop must stop performing its own user-first/non-user message regrouping so that it does not override the shared result.

## Requested Outcome

When one durable turn pauses for input more than once, every Kestrel client must present the exchange in the order it happened:

1. The user starts the turn.
2. The assistant requests input.
3. The user responds to that request.
4. The assistant requests input again.
5. The user responds again.
6. The assistant continues.

The design must preserve deterministic replay, explicit identity-based turn ownership, every message in malformed input, and a meaningful DOM/read order. It must not infer ownership from role, text, timestamps, UUIDs, or adjacency.

## Relevant Current Behavior

The exact Thread `198e0f4a-f1c1-4cb5-afdb-08b35fbdbc87` is correct at rest. Its durable messages and server snapshot are chronological. The Web snapshot explicitly retrieves messages by `created_at`, then unique message ID ([snapshot query](../../apps/web/lib/turns/conversation-snapshot.server.ts#L98)). It also reconstructs each interaction's assistant request ID and response message ID ([interaction projection](../../apps/web/lib/turns/conversation-snapshot.server.ts#L193)).

The first wrong component is the shared projector. It correctly binds messages to turns using the turn input ID, interaction message IDs, and `kestrelTurnId`. It then globally ranks every owned message as turn input, all interaction requests, all interaction responses and user messages, then all remaining messages. UUID comparison breaks ties inside each group ([current projector](../../packages/conversation/src/projector.ts#L90), [phase function](../../packages/conversation/src/projector.ts#L167)). With two wait-and-resume cycles, that model necessarily yields:

```text
turn input → request 1 → request 2 → response 1 → response 2 → final assistant
```

The Web adapter is thin and the renderer maps the projected messages without another sort ([Web adapter](../../apps/web/lib/turns/conversation-projector.ts#L55), [Web renderer](../../apps/web/components/chatbot/messages.tsx#L205)). Full reload reproduces the wrong DOM order, so persistence, streaming state, CSS, and React rendering do not own the defect.

Desktop and TUI both map their existing transcript order into `ConversationSnapshot.messages` ([Desktop adapter](../../apps/desktop/renderer/src/conversationAdapter.ts#L39), [TUI adapter](../../cli/app/TuiConversationAdapter.ts#L79)). Their current inbox-derived interaction collections do not contain historical request/response message IDs. That makes an interaction-chain-only repair incomplete outside Web. TUI preserves the shared conversation lane order, but Desktop later emits all user messages, then activity, then all non-user messages inside each run segment ([Desktop timeline](../../apps/desktop/renderer/src/runStream.ts#L146)). That second grouping can reintroduce the same class of defect.

The shared package documentation currently says it owns “identity-based ordering” and correctly says array position is not used to infer ownership ([package guide](../../apps/docs/content/packages/conversation.mdx#L11)). The design separates two concepts that statement currently blends: identities establish ownership; source position is the presentation preference after ownership is established.

The existing conformance suite covers a pending interaction but not two resolved request-response cycles ([shared scenario](../../packages/conversation/src/conformance.ts#L69)). A direct package test covers only one historical pair ([package test](../../packages/conversation/tests/conversation.test.ts#L158)). This is why the phase model passed across Web, Desktop, and TUI.

## Affected Surface

| Surface | Current responsibility | Required change |
| --- | --- | --- |
| Shared projector | Binds identities, then globally groups roles | Bind identities, then apply stable causal order |
| Snapshot contract | Carries an ordered message array without documenting its presentation authority | State that hosts provide durable transcript order; array position never establishes ownership |
| Web | Supplies ordered messages and complete historical interaction pairs | No adapter, persistence, or renderer behavior change |
| TUI | Supplies ordered transcript; preserves shared conversation-lane order | Conform to the new shared result; no independent reorder |
| Desktop | Supplies ordered transcript, then groups projected messages by role | Preserve projected message order while weaving in run activity |
| Projection issues | Reports missing/conflicting ownership and turn sequence | Also report contradictory causal ordering constraints |
| Conformance | Exercises one interaction at a time | Exercise repeated waits with UUIDs that cannot masquerade as chronology |

Users of every client are affected because message order changes the apparent meaning of a conversation. The durable stores and wire shapes are not affected. Replay determinism remains a shared quality requirement: the same authoritative snapshot must always produce the same projection.

## External Findings That Shaped the Design

Lamport defines send-before-receive and transitivity as a causal partial order. A clock or presentation total order must extend that relation, but many total extensions can be valid ([*Time, Clocks, and the Ordering of Events in a Distributed System*, pp. 2–3](https://lamport.azurewebsites.net/pubs/time-clocks.pdf)). Applied here, an interaction request before its linked response is a hard edge; the order of otherwise eligible messages is a Kestrel policy. The host transcript is the least surprising policy because it leaves valid durable history unchanged.

PostgreSQL states that row order is unspecified without `ORDER BY` and that later sort expressions break ties left by earlier expressions ([PostgreSQL sorting rows](https://www.postgresql.org/docs/current/queries-order.html)). Web's `ORDER BY created_at, id` is therefore a deterministic total retrieval order for unique IDs. The observed Thread provides no evidence that a new per-turn ordinal would be more semantically correct.

ECMAScript's stable sort guarantee applies when the comparator is consistent; behavior may be implementation-defined when it is not ([ECMAScript `SortIndexedProperties`](https://tc39.es/ecma262/multipage/indexed-collections.html#sec-sortindexedproperties)). A comparator that returns “request before its response, otherwise equal” does not safely express an arbitrary causal graph. The projector should perform an explicit stable topological ordering instead of encoding causal edges in `Array.sort`.

WCAG's Meaningful Sequence guidance says that when order affects meaning, the correct reading sequence must be programmatically determinable ([W3C WCAG 2.2, Understanding Meaningful Sequence](https://www.w3.org/WAI/WCAG22/Understanding/meaningful-sequence.html)). The repair therefore belongs in the projected DOM/data order, not in CSS or a visual-only layout.

## Options and Candidate Seams

### Extend the current role phases

Adding more buckets at `messagePhase` is small but structurally incapable of representing an unbounded number of request-response cycles. Roles describe message authors, not causal sequence. This option is rejected.

### Sort by timestamps

Web has timestamps and a deterministic database order, but timestamps are not required by `ConversationMessageLike`. A shared timestamp sort would require a contract expansion; a Web-only sort would make clients disagree. Timestamps also would not express the known request-response relationship more directly than existing IDs. This option is rejected.

### Reconstruct the transcript from interaction history

Complete pairs could produce `input → request 1 → response 1 → request 2 → response 2`, and Web currently has that history. Desktop and TUI expose only pending inbox interactions, so both Local Core contracts and stored history would have to expand. Messages unrelated to interactions would still need another authority. This option is disproportionate.

### Add a durable per-turn message sequence

An explicit ordinal would be a strong replay contract, but it requires schema/protocol evolution and a compatibility rule for older history. Hosted `thread_turn_events.sequence` is not a substitute: those events expire after seven days, are not in the shared snapshot, and replay chunks do not preserve all interaction markers. Reopen this option only if a host cannot supply stable transcript order or production evidence shows current durable order is semantically wrong.

### Preserve source order under explicit causal constraints

This is the selected seam. It attaches after the projector's existing identity binding. It works with complete Web interaction pairs and gracefully degrades to unchanged source order when Desktop or TUI has no historical pair. It uses existing facts, preserves old history, and repairs only contradictions proven by explicit IDs.

## Proposed Delta

### Contract and ownership

`ConversationSnapshot.messages` becomes an explicitly ordered input: each host supplies messages in its authoritative durable transcript order. That order is not evidence of turn ownership. The projector continues to derive ownership only from `inputMessageId`, interaction message IDs, and message turn metadata.

The package language should describe this as **identity-based ownership with causally constrained source order**, rather than letting “identity-based ordering” imply that UUIDs determine chronology.

### Per-turn ordering

For messages already bound to one durable turn, the projector constructs these hard edges:

- The turn's input message precedes every other message in that turn.
- An interaction's `assistantMessageId` precedes its `responseMessageId` when both messages are present and owned by that turn.

It then emits a stable topological order. When several nodes have no unmet prerequisites, the node with the lowest ordinal in the host message array wins. This makes source order the deterministic preference, not an additional causal claim. An already-valid transcript is unchanged; a causally inverted pair is repaired without role or UUID ranking.

Interaction links that are null, missing from the snapshot, or cross turn boundaries do not invite guesses. Existing ownership issues continue to describe invalid identity binding, and messages without a usable causal edge retain source preference.

### Contradictory constraints

If the explicit edges form a cycle, no total order can satisfy the contract. The projection returns every message in host source order and adds one deterministic issue for the affected turn:

```ts
{
  code: "MESSAGE_ORDER_CONFLICT";
  message: string;
  turnId: string;
  messageIds: string[]; // cycle participants in host source order
}
```

This fallback favors evidence preservation. The projector must not drop messages, hide the turn, group by role, or use UUID ordering to conceal the contradiction.

### Client behavior

Web and TUI continue to render the shared projected order.

Desktop's timeline projection must preserve the relative order of projected transcript messages inside every run and unsegmented turn group. Run activity may be woven between those message anchors using its existing activity sequence/timestamp rules, but it cannot reorder the anchors. This keeps activity presentation a host concern without giving it authority over conversation chronology.

### Conformance boundary

The shared conformance corpus gains one durable turn with two resolved waits and a final assistant continuation. Its IDs are deliberately arranged so lexical UUID order disagrees with transcript order. The required projected order is:

```text
input, request 1, response 1, request 2, response 2, continuation
```

The package, Web, Desktop, and TUI must all assert that same sequence. Desktop additionally asserts that run activity does not disturb the relative message order. The projector separately covers already-valid input, repaired inversion, missing links, and cyclic constraints.

### Data and coexistence

There is no data migration or mixed data state. Existing messages, turns, and interaction rows already contain the needed evidence. The snapshot wire shape remains compatible; only its documented ordering semantics and the optional projection issue union expand. Clients using the old projector may display the old order until they take the shared package change, but no compatibility branch or dual-write path is needed.

## Decisions

- **Repair owner: shared conversation projector. Confidence: high.** It is the first component that changes correct input into wrong output and already owns cross-client projection.
- **Ordering model: stable source preference under explicit causal edges. Confidence: high.** It represents repeated waits, preserves valid input, and uses existing identities.
- **Ownership remains identity-only. Confidence: high.** Source position influences presentation only after ownership is settled.
- **Conflict behavior: emit `MESSAGE_ORDER_CONFLICT` and preserve all source messages. Confidence: medium-high.** This is deterministic and evidence-preserving; reopen if callers need projection to fail closed instead.
- **Desktop is part of the same change boundary. Confidence: high.** Its second role grouping otherwise defeats the shared contract.
- **No new timestamp, ordinal, event dependency, or database field. Confidence: high.** Current cross-client inputs are sufficient, while hosted turn events are transient.

## Research and Prototype Findings

A disposable stable topological-order model exercised four discriminating cases without touching production code:

- A valid six-message transcript remained byte-for-byte ordered.
- A misplaced turn input moved ahead of later messages.
- Reversed request-response inputs became alternating causal pairs.
- Contradictory interaction links produced an explicit cycle.

The prototype increased confidence that the shared contract is sufficient and demonstrated why a comparator-based patch is unsafe. The live Thread and source traces established that persistence recovery, renderer state repair, and a new sequence field would address downstream or hypothetical problems rather than the first wrong behavior.

## Remaining Design Questions

No material design question blocks this change. The per-turn sequence option should be reopened only if a host cannot guarantee stable transcript input or observed production history proves `created_at, id` deterministic but semantically incorrect. The exact mechanics of weaving Desktop run activity between fixed message anchors are an implementation verification detail, not a competing ordering authority.
