---
id: provider-reasoning-and-agent-progress
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-07-15
depends_on:
  - ../../packages/protocol/src/execution.ts
  - ../../src/runtime/ProviderReasoningVault.ts
  - ../../src/engine/StepRunner.ts
  - ../../agents/reference-react/src/steps/deliberator.ts
  - ../../src/mode/contracts.ts
---

# Provider Reasoning and Agent Progress

Kestrel exposes two semantic streams. `run.model.reasoning.*` is
provider-returned content shown while inference is active. `run.agent_progress`
is concise agent-authored narration emitted only after a nonterminal decision
has validated and committed. `run.progress`, logs, model timings, Environment
activation, and tool lifecycle remain diagnostics and must not be relabeled as
agent speech.

## Structured decision actions

Every `agent.loop` model request requires at least one tool call. A direct
answer uses `kestrel_finalize`, a clarification uses `kestrel_ask_user`, and
work uses an authorized evidence or action tool. A response with prose but no
tool call fails immediately as `MODEL_REQUIRED_TOOL_CALL_MISSING`; Kestrel does
not infer an action from that prose, retry it through a hidden repair request,
or persist the prose as a retry payload.

OpenAI and OpenRouter receive required tool choice with parallel tool calls
enabled when every surfaced action can be executed as a batch. Parallel calls
are disabled when any surfaced action requires individual approval, or when
the run policy requires approval per call. Anthropic maps required choice to
`any`, carries the same parallel-call decision through
`disable_parallel_tool_use`, and omits extended thinking for that request
because forced tool use takes precedence. Requests that are not agent
decisions, including compaction and classification, continue to use their own
explicit no-tool contracts.

Tool mode availability is capability metadata and a hard ceiling. Read-only
tools default to Chat, Plan, and Build; planning writes default to Plan; code,
shell, filesystem mutation, and unclassified external side effects default to
Build. A trusted app action may explicitly opt into Chat, subject to the
profile allowlist, resource grant, approval mode, and capability policy. The
same eligibility check runs when building the model surface and again before
execution.

## Provider formats

- OpenAI Responses reasoning is labeled **Provider reasoning summary**. Kestrel
  never describes it as raw reasoning.
- Anthropic thinking is labeled **Provider-visible thinking**. Thinking and
  signature blocks are continued in provider order, but signatures are never
  rendered.
- OpenRouter reasoning details preserve their provider order and are labeled
  by their declared visible format.
- A provider that returns no visible content emits a neutral unavailable state.
  Kestrel does not parse `<think>` tags or fabricate a summary.

Each visible attempt has its own attempt number. If output begins and the
attempt is interrupted, Kestrel marks that attempt failed and does not perform
an invisible automatic retry that could merge attempts.

## Continuation and retention

Provider continuation state is opaque runtime state. It is encrypted with a
continuation-specific derived key, used only for an exact tool continuation,
and purged after the active turn. It is never decrypted for display or written
to UI events, logs, traces, prompt dumps, transcripts, or retained-visible
records.

Provider-visible text is live-only by default. A profile or Kestrel One
Environment may opt into `provider_visible` retention for 1–30 days, with seven
days as the default. Retained text uses a separate derived encryption key, is
tenant- and session-scoped, and is available only through audited organization
administrator run inspection. Disabling retention deletes scoped retained
content before the next runtime command; shortening the window can only clamp
existing expiration. Expiry and manual deletion also remove content.

Hosted runtimes require `KESTREL_REASONING_MASTER_KEY`, which must decode from
base64 or hex to exactly 32 bytes. Startup fails closed without it. Local mode
may create a `0600` key at `KESTREL_REASONING_KEY_FILE` or the default local
Kestrel path.

## Reconnect, replay, and persistence

Live provider events are held only in the current runner process. Same-process
reconnect overlays them without duplicating event IDs. A restarted runner
replays only redacted metadata with `contentState: "not_retained"`. Durable
agent progress and final answers reload normally. Historical internal
`reasoning.update` journal records remain decodable for compatibility but are
not re-emitted as public provider reasoning.

## Operational metrics

Kestrel traces expose:

- `kestrel.reasoning.sidecar_model_calls` — expected to remain zero;
- `kestrel.latency.time_to_first_reasoning_ms`;
- `kestrel.latency.model_completion_to_dispatch_ms`; and
- `kestrel.latency.finalize_to_first_byte_ms`.

These are operational telemetry, not conversational progress.
