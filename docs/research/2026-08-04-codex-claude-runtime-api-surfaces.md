# Which Codex and Claude API Surfaces Should Hydra Integrate?

## Answer

Hydra should use different first-party integration surfaces for the two
Runtimes:

- **Codex:** spawn a pinned `codex app-server` and speak its bidirectional v2
  JSON-RPC protocol over stdio. App-server is the Codex surface intended for
  rich clients and directly exposes thread lifecycle, turns, streamed items,
  approvals, user input, cancellation, authentication, and schema generation.
- **Claude:** use the pinned TypeScript `@anthropic-ai/claude-agent-sdk` and its
  `query()` async stream in streaming-input mode. The SDK exposes Claude's
  agent loop, sessions, tools, permissions, hooks, partial messages,
  cancellation, usage, subagents, and an external `SessionStore` contract.

`codex exec`, `@openai/codex-sdk`, and `claude -p` remain useful diagnostic,
automation, and fallback surfaces, but they are not the primary first-class
Hydra adapters. The Codex TypeScript SDK currently wraps noninteractive
`codex exec`, while app-server exposes the richer bidirectional control plane.
Anthropic explicitly recommends Agent SDK streaming input for persistent,
interactive applications.

This research reflects first-party documentation and locally installed CLI
surfaces inspected on 2026-08-04. Confidence is high in the recommended primary
surfaces and their documented contracts. Recovery of an in-flight Codex
approval after the app-server process itself dies is not documented and must
remain an explicit capability limitation until tested.

## Findings

### Observed

#### Local and repository state

- The inspected machine has `codex-cli 0.142.5` and Claude Code `2.1.85`.
- The installed Codex CLI can generate version-matched TypeScript or JSON
  Schema bundles for app-server. Generated 0.142.5 schemas include explicit
  request/response contracts for thread start/resume/fork, turn
  start/steer/interrupt, command and file approvals, permission requests, and
  user input.
- Kestrel currently depends on neither `@openai/codex-sdk` nor
  `@anthropic-ai/claude-agent-sdk`. Anthropic model-provider support already in
  Kestrel is separate from Claude Agent SDK support.
- The installed Claude CLI already exposes the subprocess fallback needed for
  diagnostics: `--print`, `--input-format stream-json`, `--output-format
  stream-json`, partial messages, explicit session IDs, resume, fork, JSON
  Schema output, permission modes, MCP, agents, and cancellation through the
  process lifecycle.

The local Codex app-server schema was generated with the official
`generate-json-schema` command. OpenAI states that generated schemas are
specific to the CLI version that generated them, which gives Hydra a concrete
version-compatibility gate
([OpenAI app-server README](https://github.com/openai/codex/tree/main/codex-rs/app-server#message-schema)).

#### Surface selection

| Runtime | Primary Hydra surface | Secondary surface | Why primary wins |
|---|---|---|---|
| Codex | `codex app-server` v2 JSON-RPC over stdio | `@openai/codex-sdk` / `codex exec --json` | App-server is explicitly intended for rich interfaces and exposes bidirectional approvals, user input, auth, session inspection, and streamed lifecycle events. |
| Claude | `@anthropic-ai/claude-agent-sdk` TypeScript `query()` with streaming input | `claude -p --input-format stream-json --output-format stream-json` | The SDK exposes callbacks, hooks, session storage, typed messages, partial output, cancellation, and in-process control around the Claude Code agent loop. |

OpenAI describes app-server as the interface used to power rich clients and
defines a JSON-RPC lifecycle of initialize, thread start/resume, turn start,
streamed items, and terminal turn completion
([source](https://github.com/openai/codex/tree/main/codex-rs/app-server#lifecycle-overview)).
The TypeScript Codex SDK instead wraps the Codex CLI and exchanges
noninteractive JSONL events; its implementation launches `codex exec`
([SDK README](https://github.com/openai/codex/tree/main/sdk/typescript#codex-sdk),
[implementation](https://github.com/openai/codex/blob/main/sdk/typescript/src/exec.ts)).

Anthropic describes the Agent SDK as the Claude Code agent loop exposed as a
Python or TypeScript library and recommends it when the application should not
implement the tool loop itself
([overview](https://code.claude.com/docs/en/agent-sdk/overview)). Its streaming
input mode is the recommended persistent interactive mode and supports
interruptions, permission requests, queued messages, and multi-turn context
([streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)).

#### Lifecycle mapping

| Hydra operation | Codex app-server | Claude Agent SDK | Adapter consequence |
|---|---|---|---|
| Describe Runtime | CLI version + generated schema + `model/list`, provider capabilities, auth state | Pinned SDK/embedded CLI version + supported models/agents/commands + configured auth | Descriptor must be produced by adapter discovery, not a static runtime ID. |
| Prepare new session | `thread/start` immediately returns a native thread ID | Supply a caller-generated UUID through `options.sessionId`, but the session is materialized by the first `query()` | `createSession` must allow a prepared/lazy session state. |
| Attach/resume | `thread/resume(threadId)` | `query({ options: { resume: sessionId } })` | Both support native resume, but their storage placement differs. |
| Fork | `thread/fork`, optionally at a turn boundary | `forkSession()` or `resume + forkSession` | Native on both; filesystem changes are not automatically isolated. |
| Start turn | `turn/start(threadId, input, overrides)` | One `query()` invocation or a streamed user message | A Kestrel run maps to a Codex turn but to a Claude query invocation without a comparable native turn ID. |
| Steer active work | `turn/steer` with expected turn identity | streaming input / queued messages | Native on both, with different correlation strength. |
| Cancel active work | `turn/interrupt(threadId, turnId)` followed by terminal `turn/completed: interrupted` | `Query.interrupt()` in streaming mode or its `AbortController` | The adapter must wait for terminal confirmation where the native surface provides it. |
| Close adapter | close transport/process; optionally unsubscribe/unload thread | close iterator/process; session remains persisted unless deleted | Adapter disposal and native-session deletion must remain separate operations. |

Codex explicitly separates threads, turns, and items. `thread/start` and
`thread/resume` establish the native conversation; `turn/start` immediately
returns a turn and then streams events; `turn/interrupt` completes that turn as
interrupted
([API overview](https://github.com/openai/codex/tree/main/codex-rs/app-server#api-overview)).

Claude sessions are persisted conversation transcripts. The TypeScript SDK's
earlier `createSession()` V2 surface was removed in version 0.3.142; current
integration uses `query()` plus `sessionId`, `resume`, `continue`, or
`forkSession`
([sessions](https://code.claude.com/docs/en/agent-sdk/sessions)). Consequently,
Hydra cannot require every Runtime to create a materialized native session
before the first turn.

#### Event mapping

| Normalized Hydra event | Codex source | Claude source | Fidelity notes |
|---|---|---|---|
| `session.ready` | `thread/started` / `thread/resume` response | `system:init` message or first query initialization | Native, but Claude may be lazy until first query. |
| `run.started` | `turn/started` with native turn ID | Kestrel-generated query invocation ID; SDK has session/message IDs | Codex has stronger native run correlation. |
| `message.delta` | `item/agentMessage/delta` | partial `StreamEvent` content deltas when `includePartialMessages` is enabled | Native on both. |
| `message.completed` | completed `agentMessage` item | complete `AssistantMessage` / successful `ResultMessage` | Native. |
| `tool.started` | `item/started` with typed `commandExecution`, `fileChange`, MCP, dynamic, or collaboration item | assistant `tool_use` block and optional hook/tool progress messages | Claude normalization may combine message blocks and hooks. |
| `tool.progress` | command output, MCP progress, and item-specific deltas | partial message events, task progress, hook events, and tool results | Capability must report event granularity. |
| `tool.completed` | authoritative `item/completed` | tool-result/assistant messages and hooks | Native information, translated lifecycle for Claude. |
| `workspace.diff.updated` | `turn/diff/updated` | no equivalent common aggregate; inspect through Kestrel Execution Environment | Codex-native versus Kestrel-derived. |
| `plan.updated` | `turn/plan/updated` and plan items | Todo/task tools or assistant output | Codex native; Claude translated unless a stronger SDK event is selected. |
| `reasoning.delta` | reasoning summary/raw deltas when available | partial thinking content when supported/configured | Both are model/config dependent; Claude documents incompatibilities between some thinking and partial streaming settings. |
| `usage.updated` | thread token-usage notifications and terminal turn usage | assistant-message usage plus result cumulative usage/cost estimate | Token usage is native; Claude's USD figure is an estimate and must not be treated as billing truth. |
| `subagent.*` | collaboration items and child thread IDs | Agent tool/task messages, `parent_tool_use_id`, and subagent transcripts | Native on both but differently shaped. |
| `run.completed` | `turn/completed` status | `ResultMessage` subtype and terminal reason | Native. |

Codex documents the per-turn lifecycle as `turn/started`, item start/deltas/item
completion, then `turn/completed`, with `item/completed` authoritative for each
item
([events](https://github.com/openai/codex/tree/main/codex-rs/app-server#events)).
Claude yields complete assistant messages by default and can additionally emit
partial content events
([streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output)).

#### Approvals and user input

This is the largest behavioral difference between the adapters.

**Codex** sends a server-initiated JSON-RPC request on the active app-server
connection. Command, file-change, permission, MCP elicitation, and user-input
requests carry native request IDs plus thread/turn/item correlation. Kestrel
must answer the JSON-RPC request and then observe `serverRequest/resolved` and
the authoritative item completion
([approval protocol](https://github.com/openai/codex/tree/main/codex-rs/app-server#approvals)).

**Claude** normally invokes the SDK's `canUseTool` callback and keeps the query
paused until the callback returns an allow/deny response. `AskUserQuestion`
uses that same callback and carries structured questions and options
([user input](https://code.claude.com/docs/en/agent-sdk/user-input)). For waits
that should survive process exit, a TypeScript `PreToolUse` hook can return
`permissionDecision: "defer"`: Claude exits with `stop_reason:
"tool_deferred"`, preserves the tool call in the session transcript, and emits
`deferred_tool_use`. Hydra later resumes the session and returns allow or deny
when the same hook fires again
([defer protocol](https://code.claude.com/docs/en/hooks#defer-a-tool-call-for-later)).

| Property | Codex | Claude |
|---|---|---|
| Native correlation | request ID + thread ID + turn ID + item ID | tool-use ID + session ID; query invocation is Kestrel-correlated |
| Live wait | Pending JSON-RPC server request | Pending `canUseTool` callback |
| Durable wait after worker exit | Not documented | Native defer/resume protocol in TypeScript |
| Durable-wait limitation | Unknown; do not claim support | Defer currently requires noninteractive mode and one tool call in the turn |
| Approve with modification | Exec-policy/network amendments or permission subsets for supported request kinds | `updatedInput` and permission updates |
| Clarifying questions | `item/tool/requestUserInput`, plus MCP elicitation | `AskUserQuestion` through `canUseTool` |

This means `respondToInteraction()` cannot be implemented as a generic
"resume the run" call:

- The Codex adapter responds on an existing JSON-RPC request/connection.
- The Claude adapter either resolves an in-memory callback or launches a new
  resumed query that resolves a deferred tool call.

The normalized interaction record therefore needs to snapshot the native
response strategy and opaque correlation data at creation time.

#### Session durability and placement

Codex persists threads under Codex home and resumes them by thread ID. The
app-server protocol exposes thread read/list/resume, but the inspected public
surface does not document a pluggable cross-host session-store interface.
Hydra should treat a Codex binding as placement-affine to its Desktop host or
Kestrel One execution environment unless a separately verified storage strategy
is introduced.

Claude writes JSONL transcripts under its config directory. Its `SessionStore`
interface mirrors transcript entries to application-owned storage using
`append` and `load`, with helpers for listing, deletion, subagent transcripts,
and resume materialization. The local write remains authoritative during the
query; mirror errors are surfaced as stream messages and do not stop execution
([session storage](https://code.claude.com/docs/en/agent-sdk/session-storage)).

Therefore the Runtime binding needs both:

```ts
interface RuntimePlacementReference {
  environmentId: string;
  workspaceId: string;
  runtimeHomeKey: string;
}

interface NativeSessionReference {
  nativeSessionId: string;
  materialization: "prepared" | "materialized";
  portability: "placement_affine" | "externally_mirrored";
}
```

The exact names are illustrative. The semantic distinction is required.

#### Authentication and product naming

Codex app-server exposes an account API for checking authentication, starting
API-key or ChatGPT-managed login, receiving login completion, logging out, and
observing rate limits. OpenAI currently recommends app-server-managed ChatGPT
authentication for that surface
([auth endpoints](https://github.com/openai/codex/tree/main/codex-rs/app-server#auth-endpoints)).
This gives Kestrel Desktop a native login flow. Hosted Kestrel One credentials
still need an explicit credential and tenancy policy.

Anthropic states that third-party Agent SDK integrations may not offer
`claude.ai` login or subscription rate limits unless Anthropic has approved
them, and directs integrations to API-key authentication instead
([Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview#get-started)).
Hydra must not equate "Claude Code is installed and logged in" with authorized
product embedding.

Anthropic's published integration branding guidance also says product menus
may use **Claude Agent** or **Claude**, but not **Claude Code** or **Claude Code
Agent**
([branding guidance](https://code.claude.com/docs/en/agent-sdk/overview#branding-guidelines)).
Internally we can describe the implementation as the Claude Code/Agent SDK
Runtime, but the shipped participant label should be reviewed against that
guidance.

### Inferred

#### Revised common adapter contract

The API research suggests a small correction to the provisional adapter:
session preparation and interaction response need to admit more than one native
strategy.

```ts
interface RuntimeAdapter {
  describe(): Promise<RuntimeDescriptorV1>;

  prepareSession(
    input: PrepareRuntimeSessionInput,
  ): Promise<RuntimeSessionReference>;

  attachSession(
    input: AttachRuntimeSessionInput,
  ): Promise<RuntimeSessionState>;

  startTurn(
    input: StartRuntimeTurnInput,
  ): Promise<RuntimeRunReference>;

  respondToInteraction(
    input: RuntimeInteractionResponse,
  ): Promise<RuntimeInteractionDisposition>;

  steerRun?(input: SteerRuntimeRunInput): Promise<void>;
  cancelRun(input: CancelRuntimeRunInput): Promise<void>;
  reconcile(input: ReconcileRuntimeSessionInput): Promise<RuntimeSessionState>;
  closeSession(input: CloseRuntimeSessionInput): Promise<void>;
  dispose(): Promise<void>;
}
```

`steerRun` is a real native capability on both surfaces and should be considered
explicitly rather than smuggled through `startTurn`. It can remain capability
gated.

`RuntimeInteractionRecord` needs opaque native correlation owned by the
adapter, plus normalized presentation fields owned by Kestrel:

```ts
interface RuntimeInteractionRecordV1 {
  interactionId: string;
  bindingId: string;
  runId: string;
  participantId: string;

  kind: "approval" | "user_input" | "elicitation";
  presentation: NormalizedInteractionPresentation;

  responseStrategy:
    | "live_connection"
    | "live_callback"
    | "resume_deferred_session";

  nativeCorrelation: EncryptedOpaqueRuntimeData;
}
```

The opaque data must not leak into UI contracts or product decision logic.

#### Capability descriptors need recovery semantics

The earlier boolean/fidelity shape is insufficient. At minimum, interaction
capabilities must distinguish live and durable behavior:

```ts
interface RuntimeInteractionCapability {
  supported: boolean;
  fidelity: "native" | "translated" | "emulated";
  liveWait: boolean;
  durableWait: "native" | "connection_bound" | "unsupported";
  constraints: RuntimeCapabilityConstraint[];
}
```

At binding creation, capability negotiation should include the pinned adapter
version, native CLI/SDK version, authentication readiness, environment, and
session-storage mode. The locally installed Claude 2.1.85 is older than some
features in the current documentation, reinforcing that Hydra should ship and
pin the Agent SDK's bundled native binary rather than silently using an
arbitrary `claude` on `PATH`. Codex should likewise use a pinned
`@openai/codex` package/binary and validate its generated app-server schema.

#### Environment ownership remains separate

Both native surfaces expose filesystem, command, sandbox, and tool controls.
That does not move those product APIs back onto `RuntimeAdapter`.

- The Kestrel Execution Environment remains authoritative for workspace
  placement, isolation, Git, checkpoints, and validation.
- The adapter configures each Runtime's native sandbox and permissions to match
  the granted environment as defense in depth.
- Codex app-server filesystem and standalone command RPCs are native client
  features, not common Runtime methods.
- Claude file checkpointing is a native optional capability and is currently
  incompatible with its external `SessionStore`; Kestrel workspace checkpoints
  remain the cross-Runtime product feature.

## Contradictions and Unknowns

- Codex documents how a client responds to a live approval request, but not how
  a replacement app-server client recovers a request after the app-server
  process dies. Until a contract test proves otherwise, advertise durable
  interaction recovery as unsupported or connection-bound.
- Claude's defer protocol only works for noninteractive mode and currently only
  when the turn contains one tool call. Parallel pending tool calls need an
  explicit product policy or must remain a negotiated limitation.
- Claude `SessionStore` is a mirror around mandatory local writes, not a remote
  transactional source of truth during execution. Kestrel must monitor
  `mirror_error` and must not report a session as portable until required
  entries are confirmed durable.
- Codex app-server evolves rapidly and contains experimental fields. Hydra
  should initially opt out of experimental APIs unless a required capability
  has no stable equivalent.
- Product naming and subscription-auth use for the Claude integration may need
  commercial review before release, even though local development is
  technically straightforward.
- Neither vendor's native filesystem session is the Kestrel conversation
  record. Product transcript replay and native session resume must remain
  related but distinct recovery paths.

## Implications

1. Build `CodexRuntimeAdapter` on a long-lived, pinned app-server process and a
   generated-schema client, not on `codex exec`.
2. Build `ClaudeRuntimeAdapter` on the pinned TypeScript Agent SDK with
   streaming input, partial messages, hooks, and a Kestrel-backed
   `SessionStore` for Kestrel One.
3. Make native session materialization lazy-capable in the common contract.
4. Persist an interaction's native response strategy and opaque correlation;
   do not infer it later from Runtime ID or event text.
5. Add recovery semantics to capability negotiation, especially for approval
   and user-input waits.
6. Keep Kestrel's execution environment authoritative even when a native
   Runtime offers overlapping filesystem or checkpoint features.
7. Pin and test exact native versions. For Codex, generate and diff the app-
   server schema in compatibility tests. For Claude, run the adapter suite
   against the SDK-bundled CLI version and detect version-dependent features.
8. Treat authentication readiness as a binding prerequisite, not a generic
   provider-model setting.

## Sources

- [OpenAI Codex app-server](https://github.com/openai/codex/tree/main/codex-rs/app-server)
- [OpenAI Codex TypeScript SDK](https://github.com/openai/codex/tree/main/sdk/typescript)
- [OpenAI Codex SDK exec implementation](https://github.com/openai/codex/blob/main/sdk/typescript/src/exec.ts)
- [Anthropic Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [Anthropic TypeScript Agent SDK reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- [Anthropic Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- [Anthropic Agent SDK session storage](https://code.claude.com/docs/en/agent-sdk/session-storage)
- [Anthropic streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Anthropic streaming output](https://code.claude.com/docs/en/agent-sdk/streaming-output)
- [Anthropic approvals and user input](https://code.claude.com/docs/en/agent-sdk/user-input)
- [Anthropic permission evaluation](https://code.claude.com/docs/en/agent-sdk/permissions)
- [Anthropic deferred tool calls](https://code.claude.com/docs/en/hooks#defer-a-tool-call-for-later)
- [Previous local ownership classification](./2026-08-04-runner-runtime-ownership.md)
