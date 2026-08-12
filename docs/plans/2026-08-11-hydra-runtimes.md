---
id: hydra-runtimes
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-08-12
depends_on:
  - ../../ARCHITECTURE.md
  - ../research/2026-08-04-codex-claude-runtime-api-surfaces.md
  - ../research/2026-08-04-runner-runtime-ownership.md
---

# Hydra Runtimes

Hydra makes the code-executing participant behind a Kestrel Thread explicit.
Kestrel, Codex, and Claude Code are built-in Runtimes. Kestrel remains the
default and existing Threads retain their current behavior.

## Contract

A Runtime adapter owns native session creation, execution, continuation,
cancellation, capability discovery, and disposal. Kestrel continues to own the
product Thread, durable event journal, UI projection, workspace grant, and
operator interaction ledger.

Each Thread has exactly one immutable `runtimeId` and one `runtimeBindingId`.
The binding points at an organization-scoped runtime participant. Changing a
Runtime therefore creates or duplicates a Thread; it never mutates the identity
of an existing conversation.

The portable adapter contract is `RuntimeAdapterV1`. Runtime-specific SDK or
protocol payloads stay inside the adapter. The shared boundary carries only:

- the negotiated descriptor and capability digest;
- the Thread binding and participant identity;
- normalized Turn input and terminal results;
- explicit interaction-delivery acknowledgements.

## Built-in adapters

| Runtime | Native boundary | Session | Interaction delivery | Cancellation |
| --- | --- | --- | --- | --- |
| Kestrel | existing `KestrelChatRuntime` | Kestrel session | existing continuation path | existing cancellation |
| Codex | pinned `@openai/codex` app-server JSON-RPC | native Codex Thread | `serverRequest/resolved` | `turn/interrupt` |
| Claude Code | pinned Claude Agent SDK `query()` | isolated SDK session | resolved `canUseTool` callback | abort plus query close |

Chat and Plan run read-only. Build grants workspace write through the native
Runtime sandbox. Apps and arbitrary MCP servers are disabled for foreign
Runtimes in this first contract version.

## Interaction invariant

An operator answer first moves a durable runtime interaction from `pending` to
`processing`. It becomes `resolved` only after the native Runtime confirms that
the live request received the response. Replayed answers are idempotent. A lost
live request fails visibly with `RUNTIME_LIVE_WAIT_LOST`; retry belongs on a new
Thread rather than silently reconstructing native state.

## Product surfaces

Desktop and Kestrel One expose Runtime selection before the first Turn and show
the selected Runtime in the Thread header. Existing and malformed persisted
state defaults to Kestrel. Mobile branches inherit their parent Runtime.

Desktop resolves provider keys through Local Core's existing credential store.
Codex may also use its managed local login. Hosted Runtime credentials must be
delivered through the existing Kestrel One Environment credential boundary;
raw organization secrets must not be persisted in Thread, binding, event, or
adapter state.

## Correctness and release gate

Hydra is controlled by one server-owned `KESTREL_HYDRA_RUNTIMES_ENABLED`
gate. When it is off, Kestrel is the only admitted Runtime. When it is on,
Codex and Claude Code are included together, while their read-only descriptors
independently decide whether each option is usable in the selected Environment.
Browser readiness is presentation state only; Kestrel One and Desktop probe
again at the authoritative admission boundary before creating a binding or
starting the first Turn.

Foreign Runtime child processes receive an explicit, provider-specific
environment assembled from the selected local profile or tenant-scoped gateway
lease. The host process environment is never inherited wholesale. Native
session identifiers remain in the Environment-owned Runtime store, and the
durable binding records only its lifecycle marker: `uninitialized`, `ready`,
`degraded`, or `released`.

Permanent deletion and recovery cleanup first write a non-secret Runtime
release outbox record. Hosted Environments receive `runtime.release` through
their Runner route. Desktop Environments claim the same durable record through
the signed Desktop connector after reconnecting; this cleanup queue is
independent of live Thread executions and does not consume Desktop run
capacity. Only an exactly correlated durable `runtime.released` event settles
the outbox. Expired claims are safely reissued because release is idempotent by
binding identity.

The gate remains off until one clean revision passes `pnpm hydra:smoke`. Its
local authenticated matrix covers both Runtimes, two ordinary Turns, a live
question or approval, text and image attachments, cancellation, native restart
and resume, configuration-generation credential refresh, and missing-session
classification. A smaller authenticated Kestrel One candidate canary then
proves exact-revision admission, deployed routing, native continuation, and
immutable binding. The sanitized `.artifacts/hydra/<sha>/evidence.json` digest
is mandatory in unified release evidence. There are no automatic model retries
or single-provider waivers.

Recovery-fork policies remain deterministic product gates: native-session loss
offers a new Kestrel Thread; live-wait loss offers a new Thread using the same
Runtime. Stable deployments keep the gate off until the exact candidate's
combined evidence passes; disabling the single gate remains the rollback.

The supervised smoke requires `KESTREL_HYDRA_SMOKE_APPROVED=1`, explicit
`KESTREL_HYDRA_CODEX_MODEL` and `KESTREL_HYDRA_CLAUDE_MODEL` selections, and
either provider credentials or explicitly approved native login roots through
`KESTREL_HYDRA_CODEX_HOME` and `KESTREL_HYDRA_CLAUDE_CONFIG_DIR`. The candidate
phase additionally requires `KESTREL_HYDRA_CANDIDATE_URL`, the authenticated
Playwright `KESTREL_HYDRA_CANDIDATE_STORAGE_STATE`, and
`KESTREL_HYDRA_CANDIDATE_PROJECT_ID`. These inputs are consumed only at runtime
and are prohibited from the evidence artifact.
