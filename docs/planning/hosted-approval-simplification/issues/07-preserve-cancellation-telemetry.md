# Preserve completed model telemetry when a run is canceled

## Useful outcome

Users, support, and operators can see the model work and cost that occurred
before a hosted run was canceled. Cancellation stops further work without
rewriting completed model requests, token usage, validation failures, or cost
as zero.

This slice repairs the defining cancellation scenario independently of tool
approval and provider execution.

## What changes

Reproduce the observed zero-telemetry cancellation without making a provider
tool call. Trace the accumulated run telemetry through the agent terminal
event, runtime result, turn worker, durable message and usage ledger, and Web
projection. Repair the first component that replaces or drops recorded model
activity when cancellation wins the terminal race.

Preserve model request count, input and output tokens, cached and reasoning
tokens when available, cost, validation rejection, duration, and terminal
cancellation reason. Cancellation must still stop new model and tool work at
the safe boundary. It must not convert the run to success or infer an external
effect outcome.

Keep telemetry idempotent across worker retry and terminal replay. Do not
double-charge usage, create a second terminal record, or expose prompts, tool
payloads, credentials, or provider secrets. Existing durable usage metering
and retry behavior must remain authoritative.

Project enough structured evidence for support to distinguish cancellation
before model work from cancellation after model work. A canceled run with no
model request may report zero usage. A canceled run after recorded model work
must report the nonzero accumulated values.

## Requirements and delivery context

The canonical requirements are in the [Hosted Approval Simplification Product Brief](../../hosted-approval-simplification-product-brief.md).

Start with the run and cancellation seams in
`agents/reference-react/src/steps/deliberator.ts`,
`src/orchestration/ThreadRuntime.ts`, and the runtime terminal event contracts.
The hosted projection and persistence path includes
`apps/web/lib/agent/kestrel-external-runtime-core.ts`,
`apps/web/lib/turns/process-runtime.ts`, `apps/web/lib/turns/store.ts`, and
`packages/protocol/src/execution.ts`.

`buildSyntheticOutput` currently creates zero model telemetry for a synthetic
result, while external-runtime usage extraction reads tokens only from a
completed terminal event. Treat these as evidence to test, not assumed root
causes. Name the first component that makes the result wrong before changing a
downstream projection.

Preserve current cancellation authority, durable message metering,
idempotency, safe-boundary interruption, and effect-state semantics. Do not
solve this with estimated token counts, inferred cost, status-based heuristics,
or provider-specific fallbacks.

## Done when

- A deterministic no-provider test reproduces cancellation after at least one
  model request and identifies the first component that drops telemetry.
- The canceled terminal path preserves the recorded model request count,
  available token fields, cost, duration, validation rejection, and terminal
  reason through runtime, worker, durable storage, and Web projection.
- Cancellation before any model request still reports zero usage without
  fabricating activity.
- Worker retry, replay, and duplicate terminal handling preserve one terminal
  result and meter usage exactly once.
- Cancellation stops later model and tool work and does not change external
  effect state.
- Structured evidence distinguishes pre-model cancellation from post-model
  cancellation without logging prompts, payloads, credentials, or secrets.
- Focused runtime, worker, persistence, usage-metering, cancellation-race, and
  projection tests pass.
- `pnpm validate` and `pnpm validate:process` pass.
