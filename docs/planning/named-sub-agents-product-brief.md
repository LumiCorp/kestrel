# Local Named Collaborators Product Brief

## Product Narrative

Kestrel can already open a private child Thread, send work to it, and bring a
later reply into the parent Thread. The current behavior is useful but
incomplete. The parent cannot deliberately read saved progress, recover a
forgotten dialog ID, or rely on close as a permanent end to the collaborator.
The model also receives little plain guidance about when collaboration helps.

This release turns the existing local dialog path into a complete named
collaborator lifecycle. The parent can open a collaborator, send later
instructions, read saved status and messages, list its collaborators, and close
one permanently. Replies continue to arrive asynchronously while the parent
does other work.

Each collaborator has one immutable name, one durable ID, and one private local
child Thread inside one parent Thread. Kestrel keeps the existing
`DelegationSupervisor`, child-Thread execution, dialog record, and
`FollowUpQueue` seams. The release hardens those seams instead of introducing a
new agent platform.

## Outcomes and Delivery Boundary

This release must create these outcomes:

- The parent model has exactly five collaborator tools: `dialog.open`,
  `dialog.send`, `dialog.read`, `dialog.list`, and `dialog.close`.
- Plain-language instructions explain when each tool helps, when no dialog tool
  should be used, and why the parent should not repeatedly poll.
- Open creates one local named collaborator and private child Thread, starts the
  first work, and returns without waiting for the reply. Repeating open with
  the same name returns that saved collaborator with `created: false`; it does
  not resend the opening message or fail the parent turn.
- Send supports sequential work with the same open collaborator and rejects a
  new message while that collaborator is still working.
- Read and list return saved local state without sending a message, waking a
  child, starting work, or creating a parent turn.
- Every collaborator reply is saved before Kestrel makes it eligible for one
  serialized parent follow-up.
- Close is terminal for the collaborator and its name in that parent Thread.
  History remains readable, but reopen, later sends, and name reuse are
  impossible.
- A local restart cannot revive closed work or silently replay an interrupted
  child turn.
- Existing conversation surfaces show the collaborator's name, messages,
  status, failures, and readable closed history.

The release does not include:

- outbound or inbound Agent-to-Agent Protocol support;
- Agent Cards, remote collaborator approval, remote credentials, transport
  negotiation, polling, cancellation, or ambiguous remote delivery;
- a general collaborator-provider abstraction;
- structured remote parts or a new collaborator artifact system;
- a six-table collaborator ledger or a generalized delivery outbox;
- a new collaborator dashboard or complete redesign of Web, Desktop, TUI,
  replay, or operator views;
- collaborator rename, name reuse, cross-parent collaborators, nested
  collaborators, streaming, push, subscriptions, or a blocking wait tool.

A2A remains a separate follow-on initiative. It must build on the proven local
five-tool lifecycle instead of being a prerequisite for it.

## Defining Scenarios

### Parallel local investigation

The user asks Kestrel to investigate two unrelated failures. The parent opens
two local collaborators with different names and clear first messages, then
continues useful work. Each collaborator replies later through its own durable,
identified parent follow-up.

### Review while the parent continues

The parent wants a second opinion on a draft or code change. It opens one
collaborator and keeps working. When the review arrives, Kestrel saves the reply
before queuing the parent follow-up. The parent can send another instruction
after the collaborator becomes idle.

### Existing collaborator needs more information

An open collaborator asks a question. The parent sends the answer to the same
`dialogId`; it does not open a replacement. If the collaborator is still
working, send fails with `DIALOG_BUSY` and tells the parent to wait or read the
saved status.

### Check saved progress without starting work

The parent wants earlier evidence or current status but has no new instruction.
It uses `dialog.read`. Read returns a bounded window of saved messages in time
order. It does not send a placeholder message or wake the child.

### Recover after context compaction

The parent no longer has a collaborator ID in model context. It uses
`dialog.list`, finds the collaborator by name and status, and uses the returned
ID. List reads only saved Kestrel state.

### Close a finished or unwanted collaborator

The user asks Kestrel to stop a collaborator, or the parent is certain it will
not be needed again. Close saves terminal state before requesting in-process
cancellation. The private history remains readable. Later send, reopen, and
name reuse all fail.

### Reply races with close

If the reply saves first, it remains eligible for one parent follow-up even if
close happens immediately afterward. If close saves first, a late child
completion cannot add a collaborator reply or parent follow-up.

### Runtime restarts during work

If a local child turn disappears during restart, Kestrel marks the work
interrupted and keeps the collaborator open for an explicit later instruction.
It does not replay uncertain work. Closed collaborators never resume. A saved
reply that was not yet queued for the parent is recovered once.

### No collaborator should be used

If the parent can answer a simple question directly, it does so. If nobody can
continue until the user answers, the parent asks the user. It does not open a
collaborator merely to repeat its own work or wait for the same answer.

## Business and Process Requirements

### Collaboration workflow

1. The parent decides whether another teammate can usefully research, inspect,
   review, compare, or work alongside it.
2. The parent opens a collaborator with a short name and a clear first message.
3. The runtime saves the local collaborator, name, first message, and work state
   before returning. Work continues asynchronously.
4. The parent keeps working. Kestrel brings committed replies back through the
   existing serialized follow-up path.
5. The parent sends another message only when the same open collaborator needs
   an answer, correction, clarification, or later assignment.
6. The parent reads for saved status and history and lists to recover the roster
   or a dialog ID.
7. The parent closes only when the collaborator is permanently finished or the
   user asks it to stop.

### Lifecycle and naming rules

- A collaborator is `open` or `closed`. Close is the only terminal transition.
- A completed or failed child turn does not close an open collaborator.
- One collaborator belongs to one parent Thread and one private child Thread.
- Every operation resolves `dialogId` under the active parent Thread.
- The name is trimmed, contains 1 through 40 characters, and is compared
  without case.
- `Kestrel` is reserved for the primary participant.
- The name is immutable and reserved until the parent Thread is deleted,
  including after close.
- One collaborator can have only one active child turn. Send fails while work
  is active.
- Close is idempotent, immediately prevents new work, and preserves history.
- A child collaborator cannot open another collaborator.

### Exact instructions given to the parent

The parent system prompt must include this text only when its effective tool
list contains all five dialog tools and the turn is not a collaborator child:

```text
You can ask named collaborators to help with the current task. Each collaborator has a private conversation with you.

Open a collaborator when another teammate could help by researching a question, inspecting a different part of the work, reviewing your work, comparing choices, or working alongside you while you continue.

Do not open a collaborator only to repeat work you can finish now. Do not open one when nobody can continue until the user answers a question.

Give each collaborator a short, memorable name and a clear first message. Include the context they need. A collaborator's name cannot be changed or reused in this task.

After you open or message a collaborator, keep working. Kestrel will bring their reply back to you. Do not repeatedly check for a reply.

Use dialog.send when an existing collaborator needs another instruction, an answer, a correction, or more work. Use dialog.read when you want to see their status, messages, or results without asking them to do more. Use dialog.list when you need to see who is available or recover a dialog ID.

Close a collaborator only when you are sure you will not need them again. Closing stops their work and cannot be undone. You can still read the conversation after closing it.

Collaborators cannot open other collaborators. Do not ask a collaborator to do anything outside the user's current permissions.
```

The model makes this decision. Kestrel must not add keyword routing, scores, or
a hidden classifier. Implementing agents must not replace the approved wording
with terms such as “bounded work,” “fan-in,” “delegation unit,” or “execution
context.”

### Exact tool purposes

| Tool | Model-visible description |
| --- | --- |
| `dialog.open` | Start a private conversation with a new named collaborator and send the first message. Use this when another collaborator can research, review, investigate, compare choices, or work on a different part of the task while you continue. Their reply will come back to you later. The name cannot be changed or reused in this task, even after you close the collaborator. |
| `dialog.send` | Send another message to a collaborator you already opened. Use this to answer their question, correct or narrow their work, ask for more detail, or give them another assignment. Their reply will come back to you later. You cannot send a message while they are busy or after you close them. |
| `dialog.read` | Check a collaborator's saved status, messages, and results without sending a message or starting more work. Use this when you need to review the private conversation or check what has arrived since an earlier read. |
| `dialog.list` | See the named collaborators in this task and what each one is doing. Use this when you need a dialog ID, have forgotten who is working, or need to find a collaborator after earlier messages are no longer in your context. This does not send a message or start work. |
| `dialog.close` | Stop an open collaborator and end this private conversation for the current task. You can still read its messages and results. You cannot send another message, reopen the collaborator, or reuse its name. This cannot be undone. |

Input help must state:

- `open.name`: a short, memorable, immutable, unique name;
- `open.message`: the work or question, with needed context;
- `send.dialogId`: the ID returned by open, read, or list;
- `send.message`: the new facts or instructions;
- `read.dialogId`: the collaborator to read;
- `read.afterCursor`: return only messages after this opaque cursor;
- `read.limit`: the maximum messages to return;
- `list.status`: open, closed, or all, defaulting to all;
- `list.cursor`: continue a prior list page;
- `list.limit`: the maximum collaborators to return;
- `close.dialogId`: the collaborator to stop.

### Collaborator reply process

A reply enters the parent as structured collaborator input, not a human
message. The follow-up carries `dialogId`, `dialogName`, `sourceMessageId`,
collaborator status, and current activity. It includes this instruction:

```text
A named collaborator sent you a message. This is not a message from the user.

Use the collaborator's message in your work. Check the supplied collaborator status before choosing what to do next. If the collaborator is open, use dialog.send to reply or give them more work. Use dialog.read to see more of the private conversation. Use dialog.close only when you are sure you will not need this collaborator again.
```

Rendered text such as `Name: reply` is presentation, not provenance.

## Technology Requirements

### Existing seams remain the owners

- `DelegationSupervisor` owns local collaborator lifecycle and child-turn work.
- The existing private child Thread remains the collaborator's execution and
  conversation context.
- The existing orchestration delegation record remains the local collaborator
  record for this release.
- `ThreadRuntime` owns root prompt assembly and collaborator reply ingestion.
- `FollowUpQueue` remains the serialized parent follow-up queue.
- Web and Desktop keep using their existing dialog-message projections and
  conversation rendering paths.

Do not introduce a provider interface, remote-agent registry, generalized task
model, generalized artifact stream, or generalized delivery outbox in this
release.

### Minimum durable state

Extend the existing dialog record and store operations only as needed to keep:

- immutable name and normalized name reservation;
- open or closed lifecycle and `closedAt`;
- a monotonic revision used to fence close against completion;
- idle, working, waiting, or interrupted activity;
- saved messages with stable message IDs, sender, status, and time;
- the newest message cursor;
- whether a saved collaborator reply still needs a parent follow-up;
- creation-time profile and capability ceiling.

Use an atomic store operation for lifetime name reservation and close fencing.
Use the smallest data change that enforces those guarantees in both PostgreSQL
and the in-memory store. Do not normalize local state into multiple tables
unless implementation evidence shows the existing record cannot satisfy a
required atomic transition.

### Tool inputs and results

- Reject unknown fields on every tool.
- Require nonempty messages, IDs, and cursors when present.
- Read limit accepts 1 through 100 and defaults to 20.
- List status accepts `open`, `closed`, or `all` and defaults to `all`.
- List limit accepts 1 through 100 and defaults to 50.
- Treat cursors as opaque and scoped to the parent Thread and query.
- Read without a cursor returns the newest bounded messages in time order.
- `afterCursor` returns only later messages and repeats the cursor when nothing
  new exists. `beforeCursor` returns older messages, so readable history does
  not stop at the newest page. The two cursors cannot be used together.
- List orders by last update descending and then dialog ID descending.

Open returns a summary with `created`, `dialogId`, name, child Thread ID,
open or closed status, activity, compatibility `active`, newest cursor,
timestamps, and the latest actionable error when present. Send and close return
a summary with `dialogId`, name, child Thread ID,
open or closed status, activity, compatibility `active`, newest cursor,
timestamps, and the latest actionable error when present. Read adds saved text
messages, `nextCursor`, `previousCursor`, `hasEarlier`, and `hasMore`. List returns `dialogs`, an
optional `nextCursor`, and `hasMore`.

The local activity vocabulary is `idle`, `working`, `waiting`, or
`interrupted`. `active` is true only while activity is `working` and is always
false after close.

### Exact parent-facing errors

| Code | Message |
| --- | --- |
| `DIALOG_NAME_INVALID` | A collaborator name must contain 1 to 40 characters. Choose a short, memorable name. |
| `DIALOG_NAME_RESERVED` | 'Kestrel' is the name of the primary participant. Choose another collaborator name. |
| `DIALOG_NOT_FOUND` | This collaborator does not exist in the current task. Use dialog.list to find the available collaborators. |
| `DIALOG_BUSY` | '{name}' is still working. Wait for the reply or use dialog.read to check the saved status. |
| `DIALOG_CLOSED` | '{name}' is closed. You can read its history, but you cannot send another message or reopen it. |
| `DIALOG_NESTING_FORBIDDEN` | Only Kestrel in the main conversation can open collaborators. Continue without opening another collaborator. |
| `DIALOG_CURSOR_INVALID` | This cursor does not belong to this collaborator or list. Start a new read or list without the cursor. |

### Close and reply ordering

The store must give close and completion one durable order:

- If a reply saves while the collaborator is open and its revision still
  matches, it remains eligible for one parent follow-up. A later close does not
  retract it.
- If close saves first, late child completion cannot append a reply or queue a
  parent follow-up.

Save a reply before marking it for parent delivery. Use its stable message ID
to make enqueue idempotent and to derive the parent continuation's durable
turn identity. If Kestrel restarts after that parent continuation finishes but
before the reply is marked delivered, it must replay the stored terminal turn,
not call the model again. Recover a saved reply that still needs delivery after
restart through the existing dialog state and `FollowUpQueue`. Do not add a
general-purpose outbox for unrelated runtime work.

### Existing data and restart behavior

- Preserve existing dialog IDs, child Thread IDs, names, and message history.
- Reserve every distinct historical normalized name against future reuse.
- Preserve duplicate historical names as readable records by ID.
- Add missing local lifecycle fields lazily or through one additive migration.
- Do not build an expand-migrate-contract program for this local change.
- Mark an open dialog with vanished active work as interrupted after restart.
- Never replay uncertain work automatically and never resume closed work.

### Verification

Delivery must prove:

- exact five-tool profile and registry exposure;
- exact parent, tool, field, and reply instructions;
- no bird-name wording, hidden routing heuristic, reopen, or name reuse;
- strict inputs, scoped cursors, stable read and list ordering, and empty reads;
- one active child turn per collaborator and actionable busy errors;
- terminal close in both close/reply race orders;
- reply persistence, idempotent follow-up enqueue, serialization, and restart
  recovery through the existing queue;
- local interruption without blind replay;
- existing dialog history and legacy duplicate names remain readable;
- existing Web and Desktop conversation paths render open and closed local
  collaborator messages and failures.

Run focused contract, lifecycle, race, restart, follow-up, profile, registry,
and presentation tests. Run `pnpm validate` before delivery, plus
`validate:process`, `validate:postgres`, or `validate:chromium` when the issue
changes that boundary.

## People and Operating Requirements

### User

The user works only through the parent Thread. They can ask Kestrel to use or
stop collaborators and can read labeled open or closed history. They do not
manage child Thread IDs, retries, or recovery.

### Parent model

The parent decides when collaboration helps, gives sufficient context, keeps
working after open or send, uses the same collaborator for later work, reads
without sending placeholder messages, and closes only when finished.

### Maintainers and support

Maintainers treat the exact model-facing words and terminal-close behavior as
runtime contracts. Support can inspect the parent Thread, dialog ID, name,
child Thread, revision, status, messages, and pending follow-up state through
existing runtime and operator inspection surfaces. No new remote-provider or
security operating role is created by this release.

### Presentation owners

Web and Desktop owners extend the existing conversation presentation only as
needed to show name, open or closed status, activity, failures, and readable
closed history. They do not build a separate collaborator management product or
become lifecycle authority.

## Success and Readiness

The release succeeds when:

- The parent receives the approved instructions and exact five local dialog
  tools.
- A collaborator can be opened once, messaged across sequential local turns,
  read, recovered through list, and closed permanently in one parent Thread.
- Close prevents late uncommitted replies, later sends, reopen, and name reuse
  while preserving history.
- Every saved reply reaches the parent at most once, remains distinguishable
  from user input, and survives restart through the existing follow-up path.
- Read and list are bounded local queries that never start work.
- Existing dialogs remain readable without a large v2 migration program.
- Existing conversation and operator surfaces show enough local state to use
  and diagnose the lifecycle.
- Focused proofs and required validation gates pass.

**Readiness: Ready for issue creation.**

The local lifecycle, tool contract, persistence guarantees, ownership seams,
presentation boundary, and operating responsibilities are settled. A2A and the
broader collaborator platform are deferred and must not enter these issues.

## Source Artifacts

- [Named Collaborator and A2A Lifecycle Change Design](../design/named-sub-agents-change-design.md) — broader long-term design; its A2A and generalized persistence sections are not part of this release.
- [Named Sub-Agents Design Notebook](../../.design/named-sub-agents/notebook.md) — decision history; this Product Brief supersedes its original first-release boundary.
