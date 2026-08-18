# Which conversation surfaces should adopt the shared platform next?

## Answer

The next full UI conversion should be the CLI/TUI, followed by mobile after the hosted mobile conversation-service boundary is real. Discord should also be converted, but as a durable command/service consumer rather than as a renderer. Before those migrations, the shared package needs a short hardening slice: concrete command adapters and a multi-scenario cross-client conformance suite.

Confidence is high for the in-repository TUI and Discord findings. Mobile sequencing is medium confidence because the separate mobile checkout contains extensive uncommitted work and currently advertises only its v2 decoder.

## Findings

### Observed

- The merged kernel already owns canonical turn, queue, interaction, presentation, mode-switch, renderer-map, and command-adapter contracts. The presentation union includes text, progress, agent progress, reasoning, tools, citations, artifacts, links, interactions, status, dialogs, and mode switching (`packages/conversation/src/contracts.ts:1-240`).
- Desktop and Kestrel One both import the shared projector, reconciliation, composer, and live-presentation functions. Their adapter tests consume the same fixture, but the shared conformance module currently contains only one two-turn ordering case (`packages/conversation/src/conformance.ts:1-40`, `apps/desktop/tests/conversationAdapter.test.ts:5-44`, `apps/web/lib/turns/conversation-projector.test.ts:10-53`).
- `ConversationCommandAdapter` is defined but has no concrete implementation anywhere in the current repository (`packages/conversation/src/contracts.ts:230-240`).
- The TUI directly submits `conversation.message.submit`, assigns its own message ID, and branches on queued versus started responses (`cli/app/TuiRunController.ts:189-243`). It also independently mutates transcript history before dispatch (`cli/app/App.ts:2390-2430`), reduces progress/reasoning into TUI state (`cli/app/TuiRunController.ts:700-759`), and recovers terminal messages into the transcript (`cli/app/App.ts:3750-3830`).
- Discord invokes `generateExternalReply`, posts returned text, and persists a synthetic user/assistant message pair (`apps/web/lib/bots/runtime.ts:255-329`, `apps/web/lib/bots/shared.ts:115-180`). That path does not consume the durable turn/queue/interaction lifecycle used by the full clients.
- The separate mobile client still owns its own timestamp-based turn projector, optimistic delivery, transient-part filtering, composer-state derivation, and stream replay (`/Users/gregasher/Projects/kestrel-one-mobile/src/lib/thread-presentation.ts:16-211`, `/Users/gregasher/Projects/kestrel-one-mobile/src/lib/thread-state.ts:9-215`). Its negotiation request currently advertises only v2 and refuses v3 unless an exact installed v3 adapter/revision exists (`/Users/gregasher/Projects/kestrel-one-mobile/src/lib/api/conversation-client.ts:66-129`).
- The mobile checkout is not a clean baseline; it contains extensive tracked and untracked conversation work. Any migration must reconcile that work rather than overwrite it.

### Inferred

- TUI is the best next migration because it is a full conversation client, already consumes the same Local Core protocol, and duplicates exactly the semantics the kernel was created to own. It can adopt the kernel without a new network or database contract.
- Discord needs the durable command side of the platform, not the renderer map. Its output can remain Discord-native, but submission, identity, queueing, waits, interruption, and finalization should flow through the same hosted conversation authority.
- Mobile should not import the shared projector first and leave its transport unstable. The durable hosted v3 service/snapshot/changefeed contract must precede the mobile adapter so offline recovery, pagination, receipts, and interaction revisions remain authoritative.
- Desktop and One should retain their native React components. Shared ownership should stop at contracts, pure projection/accumulation, command semantics, and conformance fixtures.

## Contradictions and Unknowns

- The shared package declares `ConversationCommandAdapter`, but Desktop and One currently use host-specific submission code instead of concrete implementations. It is not yet proven that the interface is sufficient for attachments, queued selection snapshots, retries, and host-specific interaction payloads.
- The single shared conformance fixture does not cover queue promotion, optimistic submission, reconnect, retries, multiple attempts, interactions, mode-switch idempotency, reasoning interleaving, or terminal replacement.
- Mobile v3 artifacts in the separate checkout may represent a useful foundation, but they are uncommitted and the installed client intentionally remains v2-only. They cannot be treated as shipped authority.
- Discord’s desired behavior for waits, approvals, tool detail, and multi-part generative UI is not specified. A degradation contract is required before changing the bot path.

## Implications

Recommended sequence:

1. **Kernel hardening:** implement concrete Desktop and One command adapters; expand conformance fixtures to ordering, optimistic submission, queue promotion, reconnect, interactions, mode retry, reasoning/tool streaming, retries, and all terminal states.
2. **TUI conversion:** build a TUI snapshot/command adapter, replace transcript-position mutation and local stream reduction with the shared projector/accumulator, and keep Ink rendering and TUI commands host-specific.
3. **Hosted conversation service:** expose one bounded snapshot/history/command/receipt/changefeed authority suitable for non-Web clients and transports.
4. **Discord conversion:** route inbound messages through that authority and define explicit Discord degradation for progress, waits, approvals, artifacts, citations, and failures.
5. **Mobile conversion:** implement the negotiated v3 adapter, feed its snapshots/events into the shared pure kernel, retain native React Native rendering/offline cache, and validate on physical devices.
6. **Cross-surface acceptance:** run the same normalized fixtures through Desktop, One, TUI, Discord command flow, and mobile, proving identity, ordering, queueing, reconnect, and interaction parity.

Surfaces that should not be converted merely for symmetry: Docs, raw SDK clients, OpenAI-compatible HTTP, environment router, and runtime services. They are contract or transport surfaces, not conversation presentation owners.

## Sources

- `packages/conversation/src/contracts.ts`
- `packages/conversation/src/conformance.ts`
- `apps/desktop/renderer/src/conversationAdapter.ts`
- `apps/web/lib/turns/conversation-projector.ts`
- `cli/app/TuiRunController.ts`
- `cli/app/App.ts`
- `apps/web/lib/bots/runtime.ts`
- `apps/web/lib/bots/shared.ts`
- `/Users/gregasher/Projects/kestrel-one-mobile/src/lib/thread-presentation.ts`
- `/Users/gregasher/Projects/kestrel-one-mobile/src/lib/thread-state.ts`
- `/Users/gregasher/Projects/kestrel-one-mobile/src/lib/api/conversation-client.ts`
