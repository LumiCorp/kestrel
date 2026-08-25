# Conversation Causal Ordering Product Brief

## Product Narrative

Kestrel users read one conversation across Web, Desktop, and TUI. A durable turn can pause for user input several times before the assistant finishes. Today, the shared conversation projector groups all assistant requests before all user responses. The transcript can therefore show a reply before the question it answered.

Kestrel must preserve the meaning of the exchange. Every client must show the turn input, each assistant request, its user response, and the assistant continuation in causal order. The shared projector must own this behavior so clients do not create competing versions of the transcript.

Durable identities will continue to decide which turn owns a message. After ownership is known, the projector will use the host transcript order as its deterministic preference. It will move a message only when an explicit turn or interaction identity proves that another message must come first.

## Outcomes and Delivery Boundary

This initiative must produce these outcomes:

- Web, Desktop, and TUI show repeated request-response cycles in the same causal order.
- A valid host transcript remains unchanged after projection.
- The same snapshot always produces the same projected order.
- A turn input appears before the rest of its turn.
- Each linked interaction request appears before its response.
- A contradictory ordering contract retains every message and produces a projection issue.
- The rendered DOM and reading order match the visible message order.
- Shared documentation distinguishes identity-based ownership from transcript presentation order.

The delivery boundary includes the shared conversation projector and contract, shared conformance scenarios, client adapter verification, and Desktop timeline composition.

This initiative does not:

- Change message, turn, interaction, or turn-event persistence.
- Add a timestamp, message sequence, metadata field, database migration, or dual-write path.
- Use UUID order, message role, text, or adjacency to infer turn ownership or chronology.
- Reconstruct interaction links that a host does not provide.
- Change queue, composer, approval, or runtime activity semantics.
- Redesign client renderers or the Desktop timeline.
- Change the placement of standalone or legacy messages that do not belong to a durable turn.

## Defining Scenarios

### A user answers more than one assistant request

A user starts a durable turn. The assistant asks for clarification, the user answers, and the assistant asks again. Web loads the durable messages in host transcript order and supplies the linked interaction pairs.

The shared projector binds every message to the turn from explicit identities. It preserves the host order because the turn input and both request-response pairs already satisfy their causal constraints. Web renders the projected array directly. The user reads the exchange in the order it happened.

Desktop and TUI produce the same message sequence from their ordered transcripts. They do not need complete historical interaction pairs to preserve an already-valid exchange.

### A linked response arrives before its request in the source array

A host snapshot contains both sides of a resolved interaction, but the response appears earlier than its linked assistant request. The projector uses the explicit `assistantMessageId` to `responseMessageId` relationship as a hard ordering constraint.

The projector moves the request ahead of its response. Other messages keep source preference whenever their causal prerequisites are satisfied. The client receives one deterministic transcript without a timestamp or UUID tie-break.

### The ordering contract is contradictory

Malformed interaction links create a cycle, so no message order can satisfy every explicit relationship. The projector returns all messages in host source order and emits `MESSAGE_ORDER_CONFLICT` for the affected turn. The issue lists the cycle participants in host order.

Web keeps its existing projection alert. TUI records the issue through its existing projection diagnostic. Support can inspect the structured issue without losing the transcript. This initiative does not add a new Desktop operator alert.

### Desktop combines messages with runtime activity

Desktop receives the shared projected message order and runtime activity for the same turn. Desktop may place activity between message anchors through its existing sequence and timestamp rules. It must preserve the relative order of every projected message in each run and unsegmented turn group.

The user can follow both the conversation and runtime activity without Desktop grouping all user messages before all assistant messages.

### The snapshot lacks an interaction link

A Desktop or TUI snapshot contains an ordered transcript but no historical interaction pair for an earlier wait. The projector does not infer a link from roles, text, time, or proximity. It preserves host source preference after identity-based turn binding. The client shows the durable transcript without invented chronology.

## Business and Process Requirements

- Every supported client must present the same logical message order for the same durable turn.
- A repeated wait-and-resume exchange must alternate each assistant request with its user response when the durable evidence supports that sequence.
- A valid host transcript must not change merely because message roles or UUIDs differ.
- A client must not apply a role-based reorder after shared projection.
- The visible message order and programmatic reading order must match.
- Kestrel must preserve every message when ordering evidence is incomplete or contradictory.
- Kestrel must report contradictory explicit ordering evidence as a projection contract issue.
- Missing interaction links must not trigger guessed pairings or user-facing data loss.
- Existing ownership conflicts and missing durable-turn records must keep their current issue behavior.
- The release is acceptable only when shared conformance proves the repeated-interaction sequence across the package, Web, Desktop, and TUI.
- Support must use the existing projection alert and diagnostic paths for ordering conflicts. Users must not be asked to repair or reorder messages.

## Technology Requirements

### Shared ownership and ordering contract

- `@kestrel-agents/conversation` must remain the authority for durable turn ownership and message presentation order.
- `ConversationSnapshot.messages` must be documented as the host's authoritative durable transcript order.
- Array position must affect presentation only after the projector establishes turn ownership from explicit identities.
- The projector must continue to bind ownership from `inputMessageId`, interaction message IDs, and message turn metadata.
- The projector must remove the global request, response, user, and assistant phase ranking.
- Message UUIDs must remain identifiers only. They must not act as chronology.

### Stable causal projection

- The turn input must precede every other message owned by the turn.
- An interaction request must precede its linked response when both messages exist and belong to the same turn.
- The projector must produce a stable topological order for those constraints.
- When several messages are causally eligible, the message with the lowest host source ordinal must be emitted first.
- An already-valid source order must remain unchanged.
- Null, missing, or cross-turn interaction links must not create inferred edges.
- The projection must remain pure and deterministic for the same snapshot.

### Conflict contract

- A causal cycle must produce one deterministic `MESSAGE_ORDER_CONFLICT` issue for the affected turn.
- The issue must include `turnId` and the participating `messageIds` in host source order.
- A cycle must return every owned message in host source order.
- A cycle must not hide the turn, drop messages, group by role, or fall back to UUID order.
- Web and TUI must route the new issue through their existing projection-issue behavior.

### Client responsibilities

- Web must continue to pass its `created_at, id` message order and historical interaction links to the shared projector.
- Web must continue to render the projected message array without an independent sort.
- TUI must continue to treat the shared projector as the authority for conversation-lane ordering.
- Desktop must preserve the relative order of projected transcript messages inside each run and unsegmented turn group.
- Desktop runtime activity may be woven between message anchors but must not reorder those anchors.
- Client adapters must not require new stored fields or new historical interaction data.

### Data, compatibility, and operation

- Existing message, turn, interaction, and turn-event schemas must remain unchanged.
- The snapshot wire shape must remain compatible. Its documented ordering semantics may become stricter.
- The `ConversationProjectionIssue` union may expand with `MESSAGE_ORDER_CONFLICT`.
- Existing history must use the new projection without backfill or migration.
- Clients that have not taken the shared change may retain the old display behavior. Kestrel must not add a compatibility branch or dual-write path for them.
- The change must not alter authentication, authorization, message access, or thread membership behavior.

### Verification

- Shared conformance must include one turn with two resolved request-response cycles and a final assistant continuation.
- The conformance IDs must make lexical UUID order disagree with transcript order.
- Package tests must cover valid source order, a repaired inversion, missing links, and cyclic constraints.
- Web tests must prove the projected DOM order matches the causal sequence and that a conflict keeps the existing alert behavior.
- Desktop tests must prove that run activity does not change relative message order.
- TUI tests must prove that conversation-lane projection preserves the shared sequence and logs a projection conflict.
- Existing single-interaction, legacy, standalone-message, ownership-conflict, and turn-sequence tests must continue to pass.
- `pnpm validate` must pass before the change is ready to publish.

## People and Operating Requirements

- Kestrel users must receive the correct transcript without taking a recovery action.
- Conversation package maintainers own the ordering contract, causal projection, conflict shape, and shared conformance scenario.
- Web maintainers own the durable snapshot order, interaction linkage, DOM order, and existing projection alert.
- Desktop maintainers own the activity-message composition that preserves shared message anchors.
- TUI maintainers own conversation-lane integration and the existing projection diagnostic log.
- Support staff must be able to identify `MESSAGE_ORDER_CONFLICT` from existing Web or TUI diagnostics and escalate malformed durable identities to runtime maintainers.
- Operators do not need a migration, repair job, backfill, feature flag, or new deployment procedure.
- No user role, administrator permission, support permission, or ongoing manual ordering responsibility changes.

## Success and Readiness

Success is observable when:

- The reported task shows `what happened?`, each assistant clarification, each user response, and the final assistant message in causal order after a full reload.
- The package, Web, Desktop, and TUI return the same required sequence for the repeated-interaction conformance scenario.
- Valid transcripts remain unchanged, including snapshots without historical interaction links.
- Explicitly inverted interaction pairs are repaired without timestamp, role, or UUID chronology.
- Cyclic constraints retain all messages and emit the expected structured issue.
- Desktop activity does not change the relative order of projected messages.
- Web DOM order matches visible order.
- No persistence schema or snapshot data migration is introduced.
- Focused projection and client tests pass.
- `pnpm validate` passes.

**Readiness: Ready for issue creation.**

The product behavior, shared repair seam, ordering mechanism, conflict behavior, data boundary, and client ownership are settled. No issue author needs to invent product behavior, a structural mechanism, or an owner.

One non-blocking implementation detail remains: Desktop may choose the exact placement of runtime activity between fixed message anchors. That choice is limited to activity composition and cannot change message order.

## Source Artifacts

- [Conversation Causal Ordering Change Design](../design/conversation-causal-ordering-change-design.md)
- [Conversation Causal Ordering Design Notebook](../../.design/conversation-causal-ordering/notebook.md)
