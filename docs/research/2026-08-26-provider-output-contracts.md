# Provider output and continuation contracts

**Question.** What exact current contracts distinguish JSON mode, strict JSON-schema output, tool-contract output, reasoning continuation, streaming retry safety, and per-model/per-endpoint capability routing for OpenRouter, OpenAI Responses/Chat, and Anthropic Messages?

**Research date:** 2026-08-26. Only current first-party documentation and live first-party capability endpoints are used.

## Answer

These are six different contracts, not interchangeable labels:

| Contract | OpenRouter | OpenAI Responses / Chat Completions | Anthropic Messages |
|---|---|---|---|
| JSON mode | Chat-compatible `response_format: {type: "json_object"}`. It requests JSON, but routed providers may ignore unsupported parameters unless routing excludes them. | Responses: `text.format.type = "json_object"`; Chat: `response_format.type = "json_object"`. Guarantees valid JSON, not a schema. The prompt must explicitly instruct JSON. | No current JSON-only API mode. Prompting for JSON is not a contract; assistant-prefill is unsupported on Claude 4.6+ and Mythos Preview. |
| Strict JSON schema | Chat-compatible `response_format.type = "json_schema"`, with `json_schema.strict = true`. Endpoint enforcement varies: some providers guarantee conformance, some translate it or treat it as a strong hint. | Responses: `text.format = {type: "json_schema", name, strict: true, schema}`; Chat: `response_format = {type: "json_schema", json_schema: {...}}`. Supported schema subset is grammar-constrained, subject to refusal/incomplete escape states. | `output_config.format = {type: "json_schema", schema}`. There is no separate `strict` flag; this surface is the grammar-constrained output contract, subject to refusal/max-token escape states and schema limits. |
| Tool contract | Chat-compatible `tools`, `tool_choice`, and optionally `parallel_tool_calls`; output is `message.tool_calls`, followed by `role: "tool"` messages keyed by `tool_call_id`. Parameter acceptance is not proof that a required call occurred. | Chat uses nested function definitions and `tool_calls`; Responses uses flat function definitions and `function_call` / `function_call_output` items. `strict: true` constrains function arguments, not the final answer. | `tools[].input_schema` plus `strict: true`; output is a `tool_use` block and input continuation is a `tool_result` block. Strictness constrains tool name/input, separately from `output_config.format`. |
| Reasoning continuation | Chat-compatible continuation replays returned `reasoning_details` complete, consecutive, unmodified, and in order. OpenRouter also exposes an OpenResponses-compatible surface with `previous_response_id`, but the Chat reasoning contract is `reasoning_details`. | Responses can chain with `previous_response_id`, or statelessly replay all output items, including encrypted reasoning. Chat can request reasoning effort but has no reasoning-item continuation contract. | Messages is stateless: replay the conversation. Thinking and redacted-thinking blocks, including opaque signatures, must remain complete and unmodified around tool use. |
| Streaming retry safety | Provider fallback is transparent only before the first token. After output begins, HTTP 200 is committed and errors arrive in-band; retrying is a new generation. | Ordinary Chat and non-background Responses streams have no documented resume cursor. Background Responses can reconnect to the same response by ID and `starting_after` sequence number. | Stream errors can arrive after HTTP 200. Recovery is a new request using partial text as context; partial thinking or `tool_use` blocks cannot be recovered. It is continuation, not exact resume. |
| Capability routing | Model `supported_parameters` is an aggregate/union; `/models/{model}/endpoints` is the endpoint-level source. `provider.require_parameters: true` filters endpoints that do not advertise every supplied parameter. | `/v1/models` does not expose feature capabilities. Routing must use the exact model page/catalog for the chosen endpoint plus request validation. Responses and Chat are distinct endpoint contracts. | `/v1/models` exposes a per-model `capabilities` object, but not every Messages/tool/stream distinction. Direct Anthropic has model/platform capability, not OpenRouter-style provider-endpoint routing. |

## Exact contracts and limitations

### 1. JSON mode is not strict schema output

OpenAI explicitly distinguishes JSON mode from Structured Outputs. JSON mode guarantees syntactically valid JSON, but not adherence to any schema. In Responses the request is `text.format.type = "json_object"`; in Chat Completions it is `response_format.type = "json_object"`. The prompt must contain an explicit JSON instruction; otherwise the model can emit whitespace until the token limit, and callers must still handle incomplete output. [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

OpenRouter exposes the Chat-compatible `response_format: {type: "json_object"}` request, but the provider-routing contract matters: when `require_parameters` is false, an endpoint that does not support a supplied parameter may receive the request and ignore it. OpenRouter preferentially routes `response_format` to supporting endpoints, but may still route without support when no eligible provider exists. Its response-healing plugin is non-streaming and cannot repair truncation, further showing that cross-provider JSON parseability is not the same as native strict output. [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection) [OpenRouter response healing](https://openrouter.ai/docs/guides/features/plugins/response-healing)

Anthropic documents no `json_object` mode. Its current guaranteed-output surface is `output_config.format` with JSON schema. Historical assistant prefilling is not an equivalent contract and is rejected on Claude 4.6+ and Mythos Preview. [Anthropic Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

**Code-design implication:** a provider request must preserve whether the caller asked for parseable JSON only or schema conformance. Treating both as “structured output” would overstate the guarantee and generate the wrong endpoint field.

### 2. Strict JSON-schema output is a final-output grammar contract

OpenAI's strict schema shapes differ by endpoint:

- Responses: `text.format = {type: "json_schema", name, strict: true, schema}`.
- Chat Completions: `response_format = {type: "json_schema", json_schema: {name, strict: true, schema}}`.

The supported JSON Schema subset requires, among other restrictions, required object properties and `additionalProperties: false`; optional values are commonly represented by a union with `null`, and a root `anyOf` is not supported. Refusals and incomplete/max-token responses are explicit non-schema terminal states. A newly seen schema may incur compilation latency. [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)

OpenRouter uses the Chat-compatible `response_format` shape. Its official limitation is stronger than “check model support”: strict enforcement varies by routed provider. Some endpoints guarantee schema-conforming output, while others translate the request or treat it as a strong hint. OpenRouter says to inspect supported parameters and use `provider.require_parameters: true`, but that only proves advertised parameter support; it does not erase the documented variation in enforcement. During streaming, partial JSON is not expected to satisfy the schema; only completed output can. [OpenRouter Structured Outputs](https://openrouter.ai/docs/guides/features/structured-outputs)

Anthropic uses `output_config.format = {type: "json_schema", schema}` with no separate `strict` flag. This is the current generally available field and no beta header is required; the older `output_format` field and beta header remain only for a transition period. The returned content is still a text block containing JSON. A refusal (`stop_reason: "refusal"`) or max-token stop may bypass the schema. Structured outputs are incompatible with citations and message prefilling; schema complexity and supported-keyword limits apply. [Anthropic Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

**Code-design implication:** the endpoint skin owns the wire shape. In particular, an OpenResponses request cannot reuse Chat's top-level `response_format`; OpenAI Responses uses `text.format`. Anthropic's native `output_config.format` is not equivalent to forcing a synthetic tool call because the stop reason, thinking compatibility, streaming blocks, and continuation payloads differ.

### 3. Tool-contract output is a named-call and argument contract

OpenAI's strict function calling guarantees function arguments against the supported schema subset when `strict: true`; it does not constrain the model's final prose response. Chat definitions are nested under `tools[].function`, and the assistant returns `tool_calls`; callers answer with `role: "tool"` and `tool_call_id`. Responses uses flat function definitions and returns `function_call` output items; callers append `function_call_output` input items using `call_id`. `tool_choice: "required"` means one or more calls, while forcing a specific function selects exactly that function; `parallel_tool_calls: false` limits a turn to zero or one call. Responses may normalize an omitted strict setting, while Chat's default remains non-strict, so callers should send the intended setting explicitly. [OpenAI Function Calling](https://developers.openai.com/api/docs/guides/function-calling)

OpenRouter's Chat-compatible loop likewise requires `tools` on every request, reads `message.tool_calls`, and sends tool results keyed by `tool_call_id`. Its current docs say support for stricter `tool_choice` values varies by model. It does not document a generic, provider-independent strict tool-schema guarantee comparable to OpenAI's native `strict: true`; Anthropic strict tool use through OpenRouter requires the explicit Anthropic beta header, otherwise OpenRouter strips `strict`. [OpenRouter tool calling](https://openrouter.ai/docs/guides/features/tool-calling) [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)

Anthropic tool definitions use `input_schema`; `strict: true` guarantees schema-valid tool names and inputs. The response is a `tool_use` content block with an ID; the next user message contains a `tool_result` block referencing `tool_use_id`. `tool_choice` supports `auto`, `any`, a named `tool`, and `none`; disabling parallel use is nested inside `tool_choice.disable_parallel_tool_use`. Forced tool use has model/thinking limitations, including incompatibility with manual extended thinking. [Anthropic strict tool use](https://platform.claude.com/docs/en/agents-and-tools/tool-use/strict-tool-use) [Anthropic tool use](https://platform.claude.com/docs/claude/docs/tool-use)

**Code-design implication:** “the endpoint accepted `tools`” and “the model fulfilled a required tool contract” are separate facts. Completion must inspect the terminal provider-native call object, ID, stop reason, and validated arguments. It cannot infer success from HTTP 200, advertised support, or a requested `tool_choice` alone.

### 4. Reasoning continuation is provider-owned opaque state

OpenRouter Chat-compatible responses place reasoning continuation data in `reasoning_details` (`message` when non-streaming, `delta` while streaming). Across tool calls, all consecutive details must be replayed complete, unmodified, and in order. Some models expose only a raw reasoning string; some OpenAI reasoning models do not return reasoning tokens at all. [OpenRouter reasoning tokens](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)

OpenAI's continuation contract exists in Responses, not Chat Completions. Stateful use supplies `previous_response_id`; instructions are not automatically carried forward and must be resent as needed. Stateless/store-false use replays all response output items since the last user message, including function calls and reasoning items; Zero Data Retention continuation can include `reasoning.encrypted_content`. [OpenAI reasoning](https://developers.openai.com/api/docs/guides/reasoning) [OpenAI conversation state](https://developers.openai.com/api/docs/guides/conversation-state) [OpenAI latest-model guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.2)

Anthropic Messages is stateless. Around a tool-use continuation, thinking and redacted-thinking blocks—including opaque signatures—must be returned complete and unmodified; filtering, editing, or reordering can produce a 400. Thinking state is model-specific, so model switching requires following Anthropic's documented thinking-block handling rather than treating it as portable text. Manual `thinking.type: "enabled"` is deprecated on 4.6 and rejected on 4.7+ in favor of adaptive thinking on supported models. [Anthropic extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking) [Anthropic thinking models](https://platform.claude.com/docs/en/about-claude/models/extended-thinking-models)

**Code-design implication:** reasoning artifacts are opaque contract-carrying values. They must remain tied to the provider skin, model, turn, ordering, and original bytes/objects; summarizing them or remapping them into one normalized text field breaks continuation.

### 5. Streaming retry safety starts at the first externally visible delta

OpenRouter can transparently fall back to another provider only before any token is delivered. After the first token, the HTTP 200 is committed; provider failures are emitted as in-band SSE errors and the stream terminates. Reissuing the request after partial text or tool-call deltas starts a new generation and may duplicate or diverge. [OpenRouter errors and debugging](https://openrouter.ai/docs/api/reference/errors-and-debugging)

OpenAI documents ordinary Responses and Chat streaming as SSE event streams, but no resume cursor for an ordinary interrupted stream. Background Responses is the documented exact-response reconnection mechanism: create with `background: true, stream: true`, retain the response ID and event `sequence_number`, then reconnect with `starting_after`. The background response continues after the client disconnects. [OpenAI streaming Responses](https://developers.openai.com/api/docs/guides/streaming-responses) [OpenAI background mode](https://developers.openai.com/api/docs/guides/background)

Anthropic can send an `error` event after the stream began under HTTP 200. Its recovery guidance starts a new request using the partial response as context: assistant prefill for Claude 4.5 and earlier, or a user continuation message for Claude 4.6+. Only the most recent text block can be recovered; partial thinking and `tool_use` blocks cannot. This is semantic continuation, not exact stream resumption. [Anthropic streaming](https://platform.claude.com/docs/en/build-with-claude/streaming) [Anthropic errors](https://platform.claude.com/docs/en/api/errors)

**Code-design implication:** transport retry may be automatic only before output becomes externally observable. After that boundary, the state is ambiguous—especially for tool calls and side effects—and provider-specific resume/continuation must be used or surfaced explicitly rather than hidden as a transparent retry.

### 6. Capability routing is model-, endpoint-, and request-shape-specific

OpenRouter's model-level `supported_parameters` is aggregate metadata, not proof that every provider endpoint supports the parameter set. The endpoint list is the routing source of truth. With `provider.require_parameters: false` (the default), endpoints may receive and ignore unsupported parameters. With `true`, OpenRouter only routes to endpoints advertising every supplied parameter. [OpenRouter models](https://openrouter.ai/docs/guides/overview/models) [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection) [OpenRouter endpoint API](https://openrouter.ai/docs/api/api-reference/endpoints/list-endpoints)

OpenAI's Models API returns identifiers and ownership metadata, not a machine-readable feature matrix. Current endpoint and feature support is documented per model in the model catalog/pages. Thus a model that exists in `/v1/models` is not thereby proven to support Responses, Chat, structured outputs, tools, or a particular reasoning mode. [OpenAI Models API](https://developers.openai.com/api/reference/typescript/resources/models/methods/retrieve) [OpenAI model comparison](https://developers.openai.com/api/docs/models/compare)

Anthropic's Models API now returns a per-model `capabilities` object (or `null`) alongside token limits. That object is useful but does not encode every tool-choice, streaming-recovery, platform, or thinking-continuation restriction documented by Messages and model-specific guides. Direct Anthropic has no multi-provider endpoint router analogous to OpenRouter. [Anthropic Models API](https://platform.claude.com/docs/en/api/models/list)

**Code-design implication:** capability evidence must be scoped to the exact provider, API skin, model ID, and—in OpenRouter's case—eligible endpoint set after all supplied parameters are considered. Model-level unions and model existence are insufficient admission evidence.

## OpenRouter GLM 5.2 and `require_parameters`

The live official OpenRouter records for `z-ai/glm-5.2`, fetched on 2026-08-26, show:

- Canonical slug `z-ai/glm-5.2-20260616`, 1,048,576-token context, default reasoning enabled at `high`, and advertised reasoning efforts `high` and `xhigh`.
- The model-level aggregate advertises `response_format`, `structured_outputs`, `tools`, `tool_choice`, and `parallel_tool_calls`.
- Across **38 endpoint records**, all 38 advertise `tools` and reasoning; 37 advertise `response_format`; 33 advertise `structured_outputs`; 36 advertise `tool_choice`; only 1 advertises `parallel_tool_calls`.
- The sole `parallel_tool_calls` endpoint is Inceptron, and that endpoint does **not** advertise `tool_choice`. Therefore the current eligible endpoint intersection for a request supplying `tools`, `tool_choice`, and `parallel_tool_calls` with `provider.require_parameters: true` is **zero**.
- Without `require_parameters: true`, OpenRouter may route the request to an endpoint that ignores an unsupported parameter. Even with it, matching is at the parameter-name level: the fact that all endpoints advertise `tools` and 36 advertise `tool_choice` does not certify support for every `tool_choice` value or reliable fulfillment of `tool_choice: "required"`.

Live sources: [GLM 5.2 model record](https://openrouter.ai/api/v1/model/z-ai/glm-5.2) and [GLM 5.2 endpoint records](https://openrouter.ai/api/v1/models/z-ai/glm-5.2/endpoints).

**Kestrel-specific implication:** emitting `parallel_tool_calls` merely because tools are present changes OpenRouter endpoint eligibility. For GLM 5.2 today, adding that field alongside `tool_choice` makes strict parameter routing impossible, while omitting `require_parameters` allows silent parameter loss. The request contract therefore has to include only behaviorally required parameters and evaluate their endpoint-level intersection before execution. This does not establish that GLM 5.2 is reliable for required tool fulfillment; only terminal call evidence can establish that for a run.

## Current Kestrel seam consequences

These source contracts expose three concrete distinctions in the current mapper code; they are observations, not an implementation plan:

- `models/openrouter/OpenRouterMapper.ts` currently emits `parallel_tool_calls` with a default of `true` whenever tools exist, on both Chat and Responses request paths. That optional default is capability-significant under `require_parameters`, and for today's GLM 5.2 records it conflicts with every endpoint that also advertises `tool_choice`.
- The same OpenRouter Responses path currently places structured output in top-level `response_format`, while the current OpenResponses request contract uses `text.format`. The Chat and Responses skins therefore cannot share the serialized output-control field even when their internal intent is identical. [OpenRouter Responses API](https://openrouter.ai/docs/api/api-reference/responses/create-responses)
- `models/anthropic/AnthropicMapper.ts` currently represents structured final output as a forced synthetic tool when no caller tools are present. Anthropic's current native final-output contract is `output_config.format`; a forced tool has different tool-choice, stop-reason, thinking, continuation, and streaming semantics and cannot truthfully stand in for the native schema-output capability.

## Remaining documented gaps

- OpenRouter documents provider-varying strict-schema enforcement but does not expose a machine-readable field distinguishing “native guarantee” from “translated/strong hint” per endpoint.
- OpenRouter endpoint metadata reports parameter support, not empirical reliability of required tool invocation or schema conformance.
- OpenAI's Models API does not provide a complete capability matrix; model documentation remains part of admission evidence.
- Anthropic's per-model `capabilities` object does not replace Messages contract restrictions or platform-specific availability notes.

These gaps limit what can be proven before a call. They do not collapse the six contracts above into one capability flag.
