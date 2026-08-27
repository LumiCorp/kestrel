# Use native Anthropic Messages contracts

## Useful outcome

Anthropic Messages uses native structured output, tools, reasoning, and stream semantics for the exact model. Unsupported combinations fail truthfully instead of being hidden behind a synthetic tool or unconditional thinking configuration.

## What changes

Correct the Anthropic Messages request, response, and stream codec.

Use native tool blocks and `output_config.format` for supported structured output. Keep any required compatibility transport explicitly named and separate; it must not report provider-strict schema support or prevent ordinary tools from coexisting.

Emit adaptive thinking, reasoning effort, signatures, and continuation only when requested by Model Request V2. Preserve opaque continuation and provider block order. Do not enable thinking from provider-wide defaults.

Decode native structured output, text, tool use, thinking, usage, refusal, truncation, interruption, `message_stop`, and provider request identity into Model Response V2. Malformed tool input deltas, invalid completed input, or a stream without its terminal event must fail and must never become `{}`.

Add an Anthropic Models API evidence translator that binds returned exact identity and provider metadata to the registration revision. Provider declaration still requires capability-specific qualification.

## Requirements and delivery context

The canonical requirements are in the [Product Brief](../../model-provider-contract-hardening-product-brief.md).

The owning seams are `models/anthropic/AnthropicMapper.ts`, `AnthropicInvoker.ts`, `AnthropicErrors.ts`, and `createAnthropicModelGateway.ts`. Hosted model discovery currently flows through `apps/web/lib/ai/gateways.ts` but does not establish capability proof.

The adapter translates an admitted request; it does not infer support from a model name. Do not add silent synthetic fallback when native structured output, tool strictness, or thinking is unavailable.

## Done when

- Request fixtures prove native `output_config.format`, ordinary tools, required tool choice, and requested thinking can coexist only in qualified combinations.
- Thinking and effort are absent when not requested.
- Valid responses and streams preserve structured output, tool calls, reasoning blocks and signatures, usage, request identity, and terminal state.
- Refusal, truncation, malformed input deltas, invalid completed tool input, missing `message_stop`, and premature EOF fail without repair.
- The Models API translator rejects identity mismatch and produces revisioned, fingerprinted declared evidence that is not itself qualification.
- Focused mapper, invoker, stream, error, and evidence tests pass.
- `pnpm validate` passes.

## Depends on

- [Establish exact model and request contracts](01-establish-exact-model-contracts.md)
