# Named Sub-Agents Design Notebook

## Current Position

Kestrel already has the core execution path for a named private collaborator:
`dialog.open` creates a child thread, `dialog.send` resumes it, and the reply is
queued back into the parent thread as a durable dialog follow-up. The likely
smallest change is to promote this existing dialog contract into a first-class
named-agent contract without creating a second execution engine.

The design now treats A2A support as a requirement. Kestrel should use an A2A
compatible adapter at the agent boundary, while retaining Kestrel Threads,
Runs, policy, and evidence as the internal authority. The first direction should
be Kestrel as an A2A client calling approved remote agents; serving Kestrel
agents to external A2A clients is a later direction unless product intent says
both are required immediately.

The product direction is settled: a collaborator is a reusable private
sub-thread within one parent Thread. `open` creates it, `send` starts or
continues work, `read` inspects it without starting work, `list` recovers the
roster, and `close` is the terminal cancel-and-archive event. Close never
deletes history and never permits reopen or name reuse in that parent Thread.

The user-facing direction is also settled: private collaborator messages must
not flood the primary conversation. Desktop and Kestrel One show one compact
Collaborators control for the Thread and an on-demand inspector grouped by
collaborator. Kestrel's normal reply, not raw collaborator traffic, explains
findings in the main conversation.

## Requested Change

Enable the primary Kestrel thread to:

1. initiate a named sub-agent;
2. send later messages to that named sub-agent;
3. receive replies asynchronously in the primary thread; and
4. retain the exchange as part of the primary thread's durable history.

The parent must also be able to read a collaborator later, including while the
parent is doing other work, without sending a message or relying only on an
automatically generated follow-up.

Important scenarios include a collaborator that answers once, a collaborator
that is messaged again after the parent has continued, two collaborators active
at once, a parent or runtime restart, a failed collaborator turn, and an
attempted nested collaborator.

## Starting Sources

- `src/orchestration/DelegationSupervisor.ts`
- `src/orchestration/ThreadRuntime.ts`
- `tools/runtime/dialogOpen.ts`
- `tools/runtime/dialogSend.ts`
- `tools/runtime/dialogClose.ts`
- `src/kestrel/contracts/orchestration.ts`
- `src/orchestration/contracts.ts`
- `src/orchestration/PostgresOrchestrationStore.ts`
- `apps/web/lib/turns/dialog-messages.ts`
- `apps/web/lib/turns/store.ts`
- `apps/web/lib/db/migrations/0040_persistent_collaborator_dialogs.sql`
- `ARCHITECTURE.md`
- `DESIGN.md`

## Relevant Current Behavior

The model-visible surface is exactly `dialog.open`, `dialog.send`, and
`dialog.close`. `dialog.open` validates the name, rejects a duplicate open name
within the parent thread, and creates a child thread through
`DelegationSupervisor.open` (`src/orchestration/DelegationSupervisor.ts:125-149`).

The child is a normal Kestrel thread linked by `parentThreadId` and
`childThreadId`. The dialog metadata and messages are currently stored inside
the delegation record's `policy.dialog` envelope
(`src/orchestration/DelegationSupervisor.ts:717-765`), while PostgreSQL stores
the delegation in `orchestration_delegations.policy_json`
(`src/orchestration/PostgresOrchestrationStore.ts:169-213`).

Each collaborator reply invokes `onDialogReply`, which queues a detached
follow-up on the parent with `source: "dialog"`, the dialog ID, name, and source
message ID (`src/orchestration/ThreadRuntime.ts:223-236`). The follow-up is
executed as a new parent turn with an explicit service actor and dialog
instructions (`src/orchestration/ThreadRuntime.ts:2078-2115`). This means the
parent does not receive a hidden mutation of its current model call; it receives
a durable, causally linked continuation.

Kestrel One materializes dialog messages into `thread_dialogs` and
`thread_messages`; the migration scopes dialogs to the parent thread and
enforces unique open names within that thread
(`apps/web/lib/db/migrations/0040_persistent_collaborator_dialogs.sql:1-23`).
The Web persistence path stores each message with its dialog ID, message ID,
name, and sender (`apps/web/lib/turns/dialog-messages.ts:18-66`).

The current UI does the wrong thing for a busy Thread. Desktop appends each
runtime dialog message as a `RendererTranscriptLine`, and `MessageEntry`
renders it as an ordinary timeline message. Kestrel One persists the same
record as an assistant message and `PreviewMessage` renders every
`data-kestrel-dialog-message` part inline. The persisted data is right; the
flat, per-message presentation is not.

The current implementation is therefore durable for history and resumable by
dialog ID, but it has no model-visible read operation. `dialog.open` and
`dialog.send` return a small snapshot; the model cannot explicitly retrieve
messages, unread state, artifacts, or the latest child outcome later. A name is
also primarily a display label. The current status combines lifecycle and
activity, and restart reconciliation for an in-flight in-memory dialog run is
not yet defined.

The parent prompt also gives no plain guidance for deciding when another
collaborator would help. The current tool descriptions mostly state mechanics,
the input fields have no descriptions, and the reply instruction says to
continue “when useful.” The open description adds an unenforced bird-name rule.
The parent must currently guess the intended product behavior.

## Affected Surface

- Parent system instructions, exact tool descriptions, field help, collaborator
  reply instructions, and tool-choice examples.
- A non-mutating read/check-back operation and cursor semantics.
- `DelegationSupervisor` lifecycle, naming, capacity, and child-turn dispatch.
- `ThreadRuntime` parent follow-up and restart/recovery behavior.
- Delegation and dialog contracts and their persistence envelope.
- Orchestration store queries if name lookup or durable leases are added.
- Web dialog/message materialization and shared conversation presentation.
- Desktop and operator projections that already expose dialog messages.
- Desktop `ConversationTimeline` and Kestrel One `PreviewMessage`, which must
  group dialog messages by collaborator instead of treating them as ordinary
  chat bubbles.
- Profile policy: concurrency, depth, nested-collaborator prohibition, and
  tool/capability inheritance.
- Security and tenancy: a child must remain bound to its parent thread,
  organization, user, workspace, and effective runtime policy.

## External Research

The A2A specification separates an agent's identity/capabilities from a task,
and separates messages from generated artifacts. That supports treating a
named sub-agent as an identity plus a child task/thread, rather than encoding
all semantics in a display name. See the released [A2A v1.0
specification](https://a2a-protocol.org/v1.0.0/specification/) and the official
[A2A JavaScript SDK](https://github.com/a2aproject/a2a-js/blob/main/README.md).

MCP's current interaction guidance emphasizes that server-initiated requests
must remain associated with an originating client request, while newer task
support exists for multi-round work. For Kestrel, the equivalent invariant is
that every child message and parent follow-up carries the parent thread,
delegation, and source-message identities. See [MCP elicitation](https://modelcontextprotocol.io/specification/draft/client/elicitation)
and the [MCP lifecycle specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle).

These protocols are reference points, not a decision to adopt MCP for the
internal child-thread contract. A2A is now an explicit interoperability target,
not only a conceptual comparison.

The useful A2A mapping is:

- Agent Card: a discoverable, authorized collaborator definition with identity,
  skills, capabilities, and authentication requirements.
- Task: one durable delegated unit of work and its lifecycle.
- Message and Part: one parent-to-collaborator or collaborator-to-parent turn,
  including text, structured data, or file references.
- Artifact: a concrete child output that the parent can retrieve and cite.
- Context ID: the stable conversation grouping for multiple messages or tasks.
- Kestrel event/changefeed: the local delivery mechanism for task and artifact
  updates, analogous to A2A streaming or push delivery.

The key design implication is that a Kestrel named collaborator is not itself
the same thing as a single A2A message. It is an identity plus a context and
one or more tasks. The current `DelegationRecord` combines some of these
responsibilities and may need a typed adapter or a later split.

Apple recommends a subtle, in-context foreground update instead of an
unnecessary notification, and says indefinite work should use a transient
activity indicator rather than an invented percent complete
([Notifications](https://developer.apple.com/design/human-interface-guidelines/notifications), [Progress indicators](https://developer.apple.com/design/human-interface-guidelines/progress-indicators?changes=_4_6)). WAI-ARIA's `status` role is polite live feedback that should not take focus
([WAI-ARIA status role](https://www.w3.org/TR/wai-aria/#status)). This supports
one quiet Thread-level status control and an on-demand inspector; it does not
support a toast or chat bubble for each collaborator event.

## Candidate Seams and Options

### Extend the existing dialog contract

Keep `DelegationSupervisor` and child threads as the owner. Add stable named
agent semantics, explicit parent follow-up identity, and recovery rules. This
fits the current execution model and keeps the change reversible.

### Introduce a separate named-agent service

Create an agent registry and route messages through it. This could support
cross-thread reusable agents, but would duplicate lifecycle, persistence,
authorization, and recovery responsibilities already owned by delegation.

### Make the child-thread boundary A2A-compatible

Keep local child execution in `DelegationSupervisor`, but add an adapter that
translates between Kestrel delegation/dialog records and A2A Tasks, Messages,
Parts, Artifacts, and status updates. For remote collaborators, the adapter
becomes an authenticated A2A client. For inbound interoperability, a later
server adapter exposes approved Kestrel agent definitions as A2A Agent Cards and
routes requests into the same supervisor.

This is selected. It adds a real protocol boundary without
making A2A the owner of Kestrel's parent Thread, workspace authority, or
evidence record.

### Add a read operation beside send

Add `dialog.read` as a non-mutating query for one collaborator. It returns the
collaborator identity, lifecycle state, execution state, messages after an
optional cursor, latest task status, and available artifacts. It does not wake
the child or create a parent turn. This is the smallest way to support an
explicit check-back interaction and maps naturally to A2A task/context reads.

Do not make ordinary `dialog.read` a long-held wait or polling loop. Asynchronous
replies already arrive through the durable parent follow-up path. A read call
should report no new messages when there is nothing to consume. A later
`dialog.wait` or subscription can be added only if a host needs blocking or
streaming behavior.

### Expose legacy delegation tools directly

Expose `agent.spawn` or `delegate.*` to the model. This is incompatible with
the managed Kestrel One contract, loses the clear private-dialog semantics, and
would reopen nested-agent and result-shaping problems. Do not select it.

### Present every collaborator message in the main conversation

This is the current Desktop and Kestrel One presentation. It is direct, but it
makes a multi-collaborator Thread noisy and confuses private collaborator work
with Kestrel's answer to the user. Do not select it.

### Add a separate collaborator workspace

A permanent sidebar section or a dedicated page could show every collaborator
and its history. It would add another navigation model for a feature that lives
inside one Thread. Do not select it for the first experience.

### Present a Thread-level collaborator summary and private inspector

Group durable dialog messages by collaborator. Show one compact active summary
in the Thread header and reveal the private transcript only when the user asks
to inspect it. Keep lifecycle actions in the normal user-to-Kestrel
conversation. This is selected. It retains durable visibility and makes the
feature discoverable without turning the parent conversation into a second
transcript. Desktop can use a resizable right-side panel; Kestrel One uses the
same panel when space allows and a sheet on small screens.

## Proposed Delta

Treat a named sub-agent as a **parent-thread-scoped collaborator identity**.
It owns one private child Thread and can receive multiple sequential messages.
The parent Thread remains the authoritative user-facing conversation.

The public model contract remains `dialog.open`, `dialog.send`,
`dialog.read`, `dialog.list`, and `dialog.close`. Product language may call
these named agents or collaborators, but a duplicate `agent.*` vocabulary is
not part of this change. Legacy `agent.spawn` and `delegate.*` surfaces remain
internal.

The presentation groups saved dialog messages by `dialogId`. The newest saved
message gives each collaborator row its visible state; the ordered group is the
private transcript in an inspector. The main conversation gets neither the
opening request nor the raw reply. It gets Kestrel's normal response after the
parent processes the structured collaborator follow-up. An inspector action can
help the user ask Kestrel about a named collaborator, but it must not bypass
the model with direct browser-side send, read, or close calls.

## Resolved Model-Facing Language

The parent must learn when and how to use collaborators from plain system
instructions, tool descriptions, field descriptions, and examples. Kestrel
must not use keyword routing, scores, or a hidden classifier to decide that a
message “looks delegatable.” The model makes the judgment; the runtime checks
ownership, permissions, nesting, name, busy, and close rules.

The owning prompt seam is root-turn assembly in `ThreadRuntime`. Add the
collaboration instructions only when the effective model tool list contains
all five dialog tools and the turn is not running inside a collaborator. Do not
add them to the shared deliberator prompt because profiles and child turns that
cannot open collaborators also use that prompt. The tool modules own their
descriptions and field help. The `source === "dialog"` follow-up branch in
`ThreadRuntime` owns the reply instruction.

The parent instructions must say, in ordinary language:

- Open a collaborator when another teammate could research, inspect, review,
  compare, or work on another part while the parent continues.
- Do not open one only to repeat work the parent can finish now.
- Do not open one when nobody can continue until the user answers.
- Send when an existing collaborator needs an answer, correction, follow-up,
  or another assignment.
- Read to check saved status, messages, results, or files without starting more
  work.
- List to recover collaborators and dialog IDs.
- Keep working after open or send. Replies come back automatically; do not poll
  in a loop.
- Close only when the collaborator will not be needed again. Close cannot be
  undone, but the conversation remains readable.

Every tool description must state what the tool does, when to use it, and the
important limit:

- `dialog.open`: starts a new private conversation, gives the first message,
  returns before the reply, and permanently reserves the name in the parent
  Thread.
- `dialog.send`: messages an existing collaborator, returns before the reply,
  and fails when the collaborator is busy or closed.
- `dialog.read`: checks saved state without sending, waking, or starting work.
- `dialog.list`: shows the parent Thread's collaborators without sending or
  starting work.
- `dialog.close`: stops the collaborator permanently while keeping its history
  readable; it forbids later sends, reopen, and name reuse.

When a reply starts a parent follow-up, the system instruction must plainly say
that the message came from a named collaborator and not from the user. It must
provide the structured dialog ID, name, source message ID, open or closed
status, and current work status. It must tell the parent to send only when the
collaborator is open, read for more history, and close only when finished.

The exact approved production copy, all input-field descriptions, concrete
tool-choice examples, and validation requirements are authoritative in
`docs/design/named-sub-agents-change-design.md` under “Parent and Tool
Instruction Contract.” Implementing agents must not replace that copy with
terms such as “bounded work,” “fan-in,” “delegation unit,” or “execution
context.”

Every child message should retain `parentThreadId`, `dialogId`/agent ID,
`childThreadId`, `parentRunId`, `sourceMessageId`, sender, and an immutable
sequence or causal identity. Parent ingestion should use the structured source
metadata already carried by `FollowUpQueue`, not infer provenance from the
rendered text `"Name: reply"`.

The child should inherit the parent's managed profile and workspace authority
by default. Any narrower tool or capability set must be explicit and persisted
at creation. The child cannot create another collaborator. A child reply is
persisted as a visible, labeled parent-thread message and also generates a
structured parent follow-up so Kestrel can decide what to do next.

`dialog.read` should accept the stable dialog ID and an optional opaque message
cursor, with a bounded limit. The response should distinguish `newMessages` from
the complete history and include a `nextCursor` when more history exists. The
parent can therefore check back without replaying the entire private thread.

`dialog.close` is terminal for that collaborator identity and name in the
parent Thread. It makes the collaborator inactive, preserves the child Thread
and all messages, and allows reads. Future messages fail with an explicit
terminal-state error. There is no reopen operation, and the immutable
case-insensitive name remains reserved until the parent Thread is deleted.

For A2A interoperability, the collaborator contract should expose an adapter
with these semantics:

- Kestrel's stable collaborator identity and context are never replaced by a
  remote task ID. The adapter stores the mapping explicitly.
- A2A `Message` roles and `Part` content map to typed Kestrel dialog messages,
  structured data, attachments, and artifacts. Rendered text is not the source
  of truth.
- A2A task status and artifact updates are persisted before parent follow-up
  delivery is acknowledged.
- A2A `contextId` maps to a parent-thread-scoped collaborator context, subject
  to Kestrel authorization. It must not become a cross-tenant or cross-thread
  lookup key.
- Remote Agent Cards are untrusted capability declarations until Kestrel policy,
  tenancy, authentication, and tool authority approve them.
- A2A idempotency, cancellation, streaming, polling, and push updates must
  preserve the same Kestrel delegation and source-message identities.

The model-visible Kestrel tools can remain `dialog.*` during the transition.
The A2A adapter belongs below those tools, so the primary model does not need
to construct raw A2A envelopes or select arbitrary remote endpoints.

## Domain Model

- **Parent Thread:** the primary user-facing conversation and authority for the
  collaboration relationship.
- **Named collaborator:** a parent-thread-scoped identity with one child Thread,
  private context, lifecycle state, and message history.
- **Child Thread:** the execution context in which the collaborator model runs.
- **Dialog message:** a message exchanged between Kestrel and one collaborator;
  it is not an ordinary human message even when projected into the parent.
- **Parent follow-up:** a new parent turn caused by a collaborator message.
- **Collaborator lifecycle:** whether the private sub-thread is open or
  archived.
- **Execution state:** whether the collaborator is idle, running, waiting, or
  failed. This is separate from lifecycle.
- **Name:** a human-facing label, not the durable identity. The durable identity
  is the collaborator/delegation ID.

Invariants:

- A collaborator belongs to exactly one parent Thread.
- A parent can address only collaborators belonging to that Thread.
- A collaborator has at most one active child turn at a time unless an explicit
  concurrency policy changes this.
- Reading a collaborator never sends a message, wakes its child Thread, or
  creates a parent turn.
- Archiving preserves all collaborator history and remains readable.
- Closing is terminal for the collaborator identity; no later send can revive
  it or attach new work to its child Thread.
- A collaborator reply is never silently dropped; it is durably recorded before
  parent follow-up processing is considered complete.
- Child and parent execution policy are not widened by the collaborator name.
- Nested collaborator creation remains prohibited for the current Kestrel One
  policy.

## Transition States

Existing v1 `dialog.*` records must coexist with the typed v2 contract during
promotion. Existing dialogs remain addressable by dialog ID. Historical name
reuse is preserved as data but every distinct historical name is reserved
against future reuse. No `agent.*` alias set is part of this transition.

## Decisions

- **Reuse the existing child-thread/delegation seam:** selected;
  confidence high. It already owns execution, persistence, cancellation, and
  parent fan-in.
- **Keep the durable identity separate from the display name:** selected;
  confidence high. Names are immutable and lifetime-unique inside one parent
  Thread but can collide across different parent Threads.
- **Keep collaborators parent-thread scoped for the first product version:**
  selected; confidence high. Cross-thread agents would require
  a new ownership, authorization, and context-sharing model.
- **Preserve the current no-nesting policy:** selected; confidence high. The
  current profile and tool handler enforce this boundary.
- **Add explicit `dialog.read`:** selected; confidence high. Asynchronous
  delivery is useful, but it does not replace an explicit check-back query.
- **Separate archive state from execution state:** selected;
  confidence high. The current `open`/`closed` plus `active` shape cannot fully
  describe an archived but readable collaborator or a failed child run.

## Recommended Design Decisions

- **Keep `dialog.*` as the model-visible vocabulary:** selected;
  confidence high. The tools are already deployed and understood by the managed
  Kestrel One profile. Add `dialog.read` and `dialog.list` rather than
  replacing the contract immediately with `agent.*` names. User-facing product
  language can still call these named agents or collaborators.
- **Make plain-language instructions part of the runtime contract:** selected;
  confidence high. The parent prompt, tool and field descriptions, reply
  instruction, examples, and no-tool cases are specified in the final report
  and protected by contract tests and tool-choice evaluations.
- **Make the collaborator reusable within one parent Thread:** recommended;
  confidence high. `open` creates once; later messages address the stable
  collaborator ID. The name is a display label and a recovery aid, not the
  primary key.
- **Make `read` a bounded cursor query:** recommended; confidence high. It
  returns unread or requested messages, execution state, task status, errors,
  artifacts, and a next cursor. It never starts work or a parent turn.
- **Add `list` for recovery after compaction or reconnect:** selected;
  confidence high. It lets the primary agent recover collaborator IDs,
  names, lifecycle states, and latest outcomes without guessing from history.
- **Define `close` as terminal cancel-and-archive:** settled by participant;
  confidence high. It stops active work, preserves all messages, tasks, and
  artifacts, and permanently rejects later sends for that collaborator identity.
- **Support outbound A2A first:** recommended; confidence high. Kestrel is the
  A2A client, and approved local or remote collaborators implement the same
  adapter contract. Inbound A2A serving can follow once the client path is
  proven.
- **Use a Kestrel context plus A2A tasks:** recommended; confidence medium.
  One named collaborator owns one parent-thread-scoped context. Each distinct
  delegated work exchange maps to an A2A Task, while messages and artifacts keep
  their own IDs. This preserves retry and task lifecycle semantics.
- **Keep parent follow-up event-driven but serialized:** recommended;
  confidence high. Persist the child message first; if the parent is idle,
  schedule a continuation. If it is busy, queue the update for the next safe
  parent continuation rather than starting competing runs.
- **Keep private collaborator traffic out of the main transcript:** settled by
  participant; confidence high. One compact Thread-level control and a private
  inspector expose durable status and history. Kestrel's ordinary reply is the
  user-facing explanation of collaborator findings.
- **Keep lifecycle controls with the primary model:** selected; confidence
  high. The inspector is a reader. It can help the user ask Kestrel about a
  collaborator, but it does not bypass `dialog.*` tools with browser-side send,
  read, or close actions.
- **Use an adapter lane, not a universal A2A Gateway:** recommended;
  confidence high. Local child Threads and remote A2A agents are different
  providers behind one collaborator boundary. The diagram should not imply
  that every local interaction crosses a network gateway.

## Resolved Change Frontier

- “Named” means one stable reusable collaborator in one parent Thread; the
  immutable name is reserved for that Thread's lifetime.
- The collaborator retains its creation-time role/profile/provider and
  capability ceiling; current policy is revalidated and may only narrow it.
- Every committed reply creates one durable parent follow-up, serialized by the
  existing queue.
- Vanished local work is marked interrupted rather than silently replayed;
  remote A2A work is reconciled by opaque task ID with `GetTask`.
- `dialog.list` provides the roster. Exact UI layout is now bounded: the Thread
  header owns a compact Collaborators control, and an inspector owns grouped
  private history. No raw collaborator messages appear as ordinary chat
  bubbles.
- Read without a cursor returns a bounded recent window; read with a cursor
  returns only later records.
- A2A is outbound v1 client support first. Inbound serving, gRPC, v0.3
  compatibility, streaming/push, richer outbound parts, renaming, name reuse,
  and cross-parent collaborators are future changes.
- One collaborator maps to one Kestrel context containing sequential A2A
  Tasks. Interrupted tasks that require input continue by task ID.
- Outbound is text-first; typed data and ingested durable artifact references
  are supported provider results.

## Decision Map

- Status: complete
- Path: none
- Destination: no material design question remains.
- Return condition: reopen design only for one of the explicitly deferred
  extension boundaries.

## Best Next Move

Use `docs/design/named-sub-agents-change-design.md` as the canonical design. It
contains the exact parent and tool instructions, concrete tool-choice examples,
settled lifecycle, provider-boundary diagrams, quiet Desktop and Kestrel One
presentation rules, persistence ownership, A2A mapping, close fence, recovery
behavior, and coexistence rules.
