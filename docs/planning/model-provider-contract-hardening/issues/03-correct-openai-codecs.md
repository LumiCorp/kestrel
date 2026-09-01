# Correct OpenAI Chat and Responses codecs

## Useful outcome

OpenAI Chat Completions and Responses carry Kestrel's exact request semantics over their actual wire contracts and return truthful terminal evidence. Structured output, native tools, reasoning continuation, and streaming no longer depend on a shared approximate mapper.

## What changes

Separate OpenAI Chat and OpenAI Responses request, response, and stream codecs while preserving the shared adapter factory.

For Chat, map JSON mode and strict JSON Schema through the endpoint's `response_format`, and emit tool choice and parallel-tool parameters only when the effective request permits them.

For Responses, use `text.format` for structured output, native function-call input and output items, and the endpoint's reasoning fields. Replay opaque reasoning continuation in the correct output-item order instead of appending it after newly constructed messages.

Decode refusals, incomplete and truncated responses, tool calls, structured output, reasoning items, usage, provider request ID, and stream terminal events into Model Response V2. Do not extract JSON from surrounding prose. Do not turn malformed function arguments into `{}`. A stream that ends without the required terminal event must fail.

Add an adapter-owned, reviewed OpenAI capability manifest and translator for exact model registration. Treat it as declared evidence that still requires live qualification; the OpenAI Models API must not be presented as capability proof it does not publish.

## Requirements and delivery context

The canonical requirements are in the [Product Brief](../../model-provider-contract-hardening-product-brief.md).

The owning seams are `models/openai/OpenAiMapper.ts`, `OpenAiInvoker.ts`, `OpenAiErrors.ts`, and `createOpenAiModelGateway.ts`. Existing cross-provider coverage is in `tests/integration/shared-adapters.test.ts`; add focused mapper and invoker-stream fixtures where endpoint-specific proof is clearer.

Provider-specific code must translate a provider-neutral request; it must not decide runtime role eligibility. Unsupported combinations should remain visible to qualification and admission rather than being silently downgraded.

## Done when

- Exact request fixtures prove different Chat `response_format` and Responses `text.format` shapes.
- Native tools, tool choice, parallelism, reasoning requests, and opaque continuation map only when requested and preserve provider order.
- Valid terminal responses and streams normalize structured output, tools, reasoning, usage, request ID, refusal, incomplete, truncation, and interruption correctly.
- Malformed arguments, prose-wrapped JSON, missing terminal events, and premature EOF fail without repair.
- The OpenAI capability manifest is revisioned, fingerprinted, exact-model scoped, and cannot by itself make a model qualified.
- Focused Chat, Responses, stream, and manifest conformance tests pass.
- `pnpm validate` passes.

## Depends on

- [Establish exact model and request contracts](01-establish-exact-model-contracts.md)
