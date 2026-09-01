# Prove structured output and tool calls before success

## Useful outcome

Every provider response passes the same local proof before Kestrel reports valid structured output or executable tool intent. Malformed JSON, invalid schema output, unknown tools, bad arguments, missing required calls, refusals, and incomplete streams become explicit model failures instead of misleading downstream symptoms.

## What changes

Add one shared response verifier after endpoint decoding and before a successful `ModelResponseV2` crosses the model gateway boundary.

For structured output, parse the complete provider-designated payload exactly once and validate it against the requested schema with strict Ajv. Do not slice prose, remove code fences, heal JSON, weaken schemas, or retry with a changed prompt or schema. Cache compiled validators by canonical schema hash.

For tools, require a known exposed tool name, unique call identity, valid JSON arguments, and conformance to that tool's input schema. Enforce required tool choice and parallel-call requirements from the request contract. A malformed argument payload must never become `{}`.

Normalize provider refusal, incomplete generation, truncation, interrupted stream, malformed terminal event, structured-output failure, and tool-contract failure into a common `MODEL_*` taxonomy with secret-free evidence. Preserve provider request IDs and terminal diagnostics when available.

Integrate verification with the existing retry boundary. A failed proof can never be returned as success. Any retry must use the same immutable effective contract and obey the existing rule that no hidden retry occurs after visible output starts.

## Requirements and delivery context

The canonical requirements are in the [Product Brief](../../model-provider-contract-hardening-product-brief.md).

`models/VersionedModelBoundary.ts` currently proves only envelope shape, while `src/io/ModelGateway.ts` returns adapter output directly. Strict Ajv compilation already exists in `src/kestrel/contracts/tool-contract.ts`; extend or reuse it rather than adding another schema engine. Downstream checks in the agent loop, continuation coordinator, user-reply classifier, and evaluators remain useful semantic checks after this shared proof.

Provider codecs will supply normalized terminal states. Keep provider wire parsing in provider modules and shared correlation and validation here.

## Done when

- Valid structured output and tool calls from each normalized provider fixture pass with a schema hash, tool-surface hash, terminal state, and validation outcome.
- Invalid schema output, prose or fenced JSON, malformed tool arguments, unknown tools, duplicate call IDs, missing required calls, refusals, truncation, incomplete output, interrupted streams, and premature EOF fail with stable `MODEL_*` codes.
- Equivalent failures from OpenAI, OpenRouter, and Anthropic produce the same shared failure class while retaining provider diagnostics.
- A verification failure is never converted to successful output or empty tool input.
- Retry tests prove the contract is unchanged and no retry occurs after visible output starts.
- Focused verifier and gateway tests pass.
- `pnpm validate` passes.

## Depends on

- [Establish exact model and request contracts](01-establish-exact-model-contracts.md)
