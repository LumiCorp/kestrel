# Conversation Causal Ordering Design Notebook

## Current Position

Move message ordering into the shared conversation projector and replace its global role-phase sort with one causal transcript order.

The projector should keep a turn's input first. It should use the host-supplied transcript order as the deterministic preference while enforcing each explicit interaction request before its linked response. A repeated wait-and-resume cycle must render as alternating assistant and user messages.

The live Thread established that persistence is not corrupt. The server snapshot contains the correct chronology, while the shared projector changes it before rendering.

The shared projector is the existing repair owner. Web and TUI render its conversation order directly. Desktop must also stop regrouping projected messages by role in its run timeline, because that downstream pass can recreate the same defect after the shared repair.

## Requested Change

When one durable turn pauses for user input more than once, every Kestrel client must show messages in the order the exchange happened.

Observed scenario:

1. The user asks what happened.
2. The assistant asks a clarifying question.
3. The user answers.
4. The assistant asks a second clarifying question.
5. The user answers again.
6. The assistant continues.

The current Web transcript groups the three assistant messages ahead of both user replies. The desired transcript alternates each request with its response.

## Starting Sources

- Live Thread `198e0f4a-f1c1-4cb5-afdb-08b35fbdbc87` at `http://127.0.0.1:43103`.
- `packages/conversation/src/projector.ts`.
- `packages/conversation/src/contracts.ts`.
- `packages/conversation/src/conformance.ts`.
- `apps/web/lib/turns/conversation-snapshot.server.ts`.
- `apps/web/components/chatbot/messages.tsx`.
- `apps/web/drizzle/schema.ts`.
- Shared projection tests in the package, Web, Desktop, and CLI.
- Git history for commits `99b3423e6` and `b9b42a763`.

## Relevant Current Behavior

The Web snapshot reads `thread_messages` in `created_at, id` order. It also returns interaction records with the message IDs for each assistant request and user response.

The shared projector binds messages to a durable turn by explicit IDs. This ownership step is correct.

The projector then assigns every interaction-request assistant message to phase 1 and every interaction response or user message to phase 2. It sorts all phase 1 messages before all phase 2 messages. It uses the message UUID as the tie-breaker.

The Web renderer maps the projected array directly. A full page reload produces the same wrong DOM order, so streaming, React state races, and CSS do not own the bug.

The repeated-interaction case is missing from shared conformance. The existing historical interaction test covers one request and one response only.

## Affected Surface

- Shared ownership and ordering: `packages/conversation/src/projector.ts`.
- Shared message and interaction contracts: `packages/conversation/src/contracts.ts`.
- Cross-client behavior: Web, Desktop, and TUI use the shared projector. Desktop also performs a second role-based reorder in `runStream.ts` and must preserve shared message order inside each run segment.
- Web snapshot authority: ordered messages, interaction links, and turn-event sequences.
- Conformance: one shared scenario is consumed by package, Web, Desktop, and CLI tests.
- Replay semantics: the repair must be deterministic for the same authoritative snapshot. Different source orders are meaningful inputs unless explicit causal edges require a repair.
- Persistence: no data migration is currently justified. Existing rows contain the observed chronology and causal links.

## External Research

- Lamport's happened-before relation makes a request-before-response relationship a causal constraint. A user-visible total order must extend those constraints, but the total extension is not unique. Kestrel therefore needs a declared deterministic preference for otherwise eligible messages; the host transcript order supplies it.
- PostgreSQL does not guarantee row order without `ORDER BY`, and later expressions break ties left by earlier expressions. Web's `ORDER BY created_at, id` is therefore a deterministic total retrieval order because message ID is unique. The incident does not justify adding a new persisted ordinal.
- ECMAScript requires stable sorting only for a consistent comparator. A comparator that says “request before its response, otherwise equal” is not a safe topological-sort engine because its equality relationship can be inconsistent. The projector needs an explicit graph ordering operation.
- WCAG's Meaningful Sequence guidance treats programmatic reading order as part of meaning. Fixing only visual placement would not repair the DOM order exposed to assistive technology.

## Candidate Seams and Options

### Keep the global phase sort and add more phases

This attaches at `messagePhase`. It cannot represent an unbounded number of request-response cycles. More role phases would remain structurally wrong. Reject unless new evidence shows each turn can contain only one interaction.

### Sort by message timestamp

This attaches in the shared projector or Web adapter. Web has deterministic `created_at, id` order, but the shared message contract does not carry a required timestamp. A Web-only timestamp sort would leave Desktop and TUI behavior inconsistent. Keep only as a fallback option if no shared ordering authority exists.

### Preserve durable source order and enforce explicit causal edges

This attaches in the shared projector after identity binding. Keep the turn input first. Use the input snapshot order as the preference among causally eligible messages. For every interaction, enforce `assistantMessageId` before `responseMessageId`. Use a stable topological order so already-valid transcripts remain unchanged and repairs move only what explicit constraints require.

This is the selected option. It uses existing identities, does not infer ownership from text or role, and can represent repeated interactions. It also works when Desktop and TUI lack historical interaction pairs because their ordered transcript remains authoritative when no repair edge is available.

### Project directly from turn-event sequence

This would expose `thread_turn_events.sequence` or a derived message ordinal through the shared snapshot contract. It offers explicit replay order but expands the contract and requires every client store to provide equivalent sequence data. Hosted turn events also expire after seven days and replay chunks do not retain interaction markers, so they cannot order all existing history. Reject for this change; reconsider only if host transcript order proves unstable.

## Proposed Delta

1. Keep the existing explicit turn-ownership binding.
2. Remove global request and response phase buckets.
3. Document `ConversationSnapshot.messages` as the host's authoritative transcript order. Array position does not establish turn ownership; it orders messages only after identity binding.
4. For each turn, construct hard edges from the turn input to every other owned message and from each interaction request to its linked response when both messages exist in that turn.
5. Produce a stable topological order, choosing the lowest source ordinal whenever more than one message is causally eligible. Already-valid source order remains unchanged.
6. If the explicit edges form a cycle, add a `MESSAGE_ORDER_CONFLICT` projection issue for the turn and return every owned message in host source order. Do not drop content, rank roles, or use UUIDs as chronology.
7. Preserve shared message order in Desktop's run timeline instead of emitting every user message before every non-user message. Runtime activity keeps its existing explicit sequence/timestamp contract and does not become message chronology authority.
8. Add one repeated-interaction shared conformance scenario with deliberately anti-chronological UUIDs, plus a Desktop timeline assertion and a TUI projection assertion.
9. Keep persistence schemas, public message shapes, replay data, and renderer component APIs unchanged.

## Domain Model

- **Durable turn:** one user-started unit of work. It can pause and resume several times.
- **Interaction request:** an assistant message that asks for user input or approval during a durable turn.
- **Interaction response:** the user message explicitly linked to one interaction request.
- **Transcript order:** the user-visible causal order of messages inside a durable turn.
- **Turn ownership:** the durable turn to which a message belongs. Ownership and transcript order are separate responsibilities.
- Invariant: a turn input appears before every later message in that turn.
- Invariant: an interaction request appears before its linked response.
- Invariant: host source order is the preference among messages whose causal prerequisites have been satisfied.
- Invariant: message UUIDs identify messages but do not express chronology.

## Decisions

- The shared projector owns the repair. Confidence: high.
- The Web renderer and persistence query do not own the observed bug. Confidence: high.
- A role-phase model cannot represent repeated waits. Confidence: high.
- Treat the ordered `messages` array as presentation authority only after durable identity binding. This does not weaken the rule that ownership is never inferred from adjacency. Confidence: high.
- Use stable causal topological ordering, not `Array.sort` with a pairwise causal comparator. Confidence: high.
- On contradictory causal links, preserve all content in source order and emit `MESSAGE_ORDER_CONFLICT`. A visible deterministic fallback is safer than silent loss or invented chronology. Confidence: medium-high.
- Do not add timestamp, schema, sequence, or metadata fields. Current hosts already supply ordered transcripts; hosted turn events are transient and not shared across clients. Confidence: high.
- Desktop's role grouping is within the affected surface because it overrides the shared conversation order. Confidence: high.
- Keep the ordinary notebook frontier. A decision map was not needed because the ordering-authority question was compact and was resolved in this session.

## Research and Prototypes

The diagnosis used the live server-rendered snapshot and a disposable multi-interaction fixture. The real snapshot preserved chronology. The current projector returned `user -> assistant -> assistant -> assistant -> user -> user`.

A disposable stable-topological-order prototype tested four cases without changing application code:

- An already-valid six-message transcript remained unchanged.
- A turn input that arrived after an assistant message moved to the front.
- Reversed response/request pairs were repaired into alternating request-response order.
- Contradictory links were detected as a cycle rather than silently sorted.

The prototype is sufficient to establish that no timestamp or new sequence field is required for this change. It also established that a plain comparator is the wrong mechanism; the ordering operation must model explicit edges.

## Active Change Frontier

- No material design questions remain for this change.
- Reopen the sequence-field option only if a host cannot provide a stable transcript array or if production evidence shows `created_at, id` can be deterministic but semantically wrong.
- The implementation must confirm the exact Desktop activity/message merge behavior, but that is verification of the chosen contract rather than an unresolved design choice.

## Decision Map

- Status: not needed
- Path: none
- Destination: settle one shared transcript-order contract
- Return condition: write the final proposed delta and cross-client conformance rule

## Best Next Move

Use the final change design as the authority for a separately requested implementation plan or implementation session.
