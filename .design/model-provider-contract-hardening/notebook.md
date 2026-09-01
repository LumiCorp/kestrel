# Model Provider Contract Hardening Design Notebook

## Current Position

Kestrel should resolve one effective model contract for each exact provider, model, endpoint, and routing policy. The contract should be the intersection of adapter support, provider evidence, model evidence, and qualification evidence. Request admission should use that contract before a provider call. Response validation should prove that the returned value met the requested contract before runtime code can treat it as success.

The latest investigation found three separate truths that the current code merges: protocol support, model support, and successful output enforcement. OpenRouter GLM 5.2 exposes the consequence. Its route can return JSON but does not promise strict JSON Schema enforcement, while Kestrel marks every pinned route as structured-output capable.

## Requested Change

Design permanent fixes for the OpenRouter, OpenAI, and Anthropic adapter findings and for models that cannot satisfy Kestrel's structured-output or tool contracts.

Changed scenarios:

- A strict-schema request must run only on an exact route that can enforce that schema.
- A model that offers JSON mode but not strict schema mode must remain usable for compatible work and must be rejected for strict-schema work.
- Provider routing must not silently select an upstream endpoint with weaker capabilities than the admitted request.
- A provider response must not report structured-output success unless the returned value passes the requested schema.
- Reasoning continuation, tool calls, streaming, and errors must preserve one cross-adapter contract without hiding provider-specific limits.

## Starting Sources

- The adapter review and GLM diagnosis in this thread
- `models/ProviderRegistry.ts`
- `src/kestrel/contracts/model-registration.ts`
- `src/kestrel/contracts/model-io.ts`
- `src/kestrel/contracts/profile.ts`
- `src/profile/kestrelOnePolicy.ts`
- `models/openrouter/*`, `models/openai/*`, and `models/anthropic/*`
- Hosted gateway model admission under `apps/web/lib/ai/`
- Runtime structured-output consumers under `src/runtime/`, `src/engine/`, and `src/evaluation/`
- `docs/design/openrouter-model-economics-repair-change-design.md`
- Current OpenRouter, OpenAI, and Anthropic provider documentation

## Relevant Current Behavior

1. `ProviderRegistry` advertises protocol-wide capabilities for OpenRouter, OpenAI, and Anthropic.
2. `ModelRegistrationV1` can carry model capabilities, but the shipped registry gives each registration the provider declaration.
3. Hosted OpenRouter approval resolves and persists exact identity and economics data, but runtime eligibility checks only economics readiness.
4. Profile composition marks every pinned model route as tool-capable and structured-output capable.
5. A model request carries one generic `responseFormat`, `responseSchema`, and provider-specific options.
6. Each mapper independently translates that request. Endpoint-specific wire contracts have drifted.
7. OpenRouter parses JSON text but does not validate it against `responseSchema`. OpenAI and Anthropic also have success-reporting gaps.
8. Runtime consumers perform uneven local checks. Some fail closed; others accept a parsed object that does not prove schema conformance.

## Affected Surface

- Exact model approval and provider metadata capture
- Versioned model registration and capability revisions
- Environment binding and runtime route eligibility
- Request requirement derivation and admission
- OpenRouter upstream provider routing
- Provider-specific request and response mapping
- Shared response-schema validation and error taxonomy
- Reasoning continuation and streaming state
- Structured-output telemetry and durable evidence
- Model qualification and conformance tests
- Hosted and local model status surfaces

## External Research

Current findings:

- OpenRouter publishes model-level `supported_parameters` and an authenticated endpoint list. It recommends `require_parameters: true` when the request depends on a parameter. Its default is `false`, and unsupported parameters can otherwise be ignored while routing continues.
- OpenRouter currently describes GLM 5.2 as supporting JSON `response_format` without JSON Schema enforcement. The model can qualify for validated JSON work without qualifying for strict-schema work.
- OpenRouter's Responses API uses OpenResponses `text.format` and direct output items. Its Chat API uses `response_format`. The current mapper crosses those wire contracts.
- OpenAI Chat Completions and Responses also use different structured-output wire shapes. The Models API exposes basic identity rather than a machine-readable capability object, so adapter-owned model evidence and qualification must fill that gap.
- Anthropic now provides native JSON output through `output_config.format`, strict tools through `strict: true`, and machine-readable per-model capability data. Its Models API distinguishes structured output and the supported thinking types. The current adapter's synthetic output tool and unconditional adaptive thinking are therefore legacy behavior, not a durable provider contract.
- OpenAI and Anthropic both expose incomplete or exceptional response states that can produce nonconforming output despite a schema request. Provider enforcement never removes Kestrel's obligation to validate the returned value.

Code implication: Kestrel needs explicit assurance modes and route evidence. A provider name or Boolean capability cannot represent these differences.

## Candidate Seams and Options

### Provider-adapter-only repair

Correct each mapper and add response validation inside each adapter. This fixes wire drift but leaves model admission and route selection unable to distinguish strict support from best-effort JSON.

### Model allowlist and model-name exceptions

Mark known models as supported or unsupported in static configuration. This is simple but becomes stale, hides upstream endpoint differences, and creates forbidden name-based policy heuristics.

### Effective model contract at registration and dispatch

Keep adapter declarations as the protocol envelope. Add exact model capability evidence and qualification evidence to model registration. Resolve a request requirement at dispatch, admit it against one effective contract, then validate the response against the same contract.

This is the chosen seam. It uses existing versioned registrations, fingerprints, environment bindings, and provider evidence rather than introducing a parallel model catalog.

## Proposed Delta

The proposed design has five connected responsibilities:

1. Admission records exact model and endpoint capability evidence with provenance, revision, and freshness.
2. A qualification service runs bounded contract probes and binds results to the exact registration and credential revision.
3. Dispatch derives exact requirements from the request and runtime stage, then checks them against the effective model contract before spend.
4. Adapters translate the admitted requirement through endpoint-specific codecs and preserve provider-native response state.
5. A shared verifier validates JSON, response schemas, and tool arguments before a `ModelResponse` can report success or reach runtime consumers.

The effective contract is runtime-derived, not a second persisted catalog. It is the intersection of:

- adapter/endpoint codec support
- exact model and upstream endpoint evidence
- current qualification evidence
- explicit routing policy
- the request's required assurance

`ModelRegistrationV1` is too coarse to express that distinction. Preserve it for compatibility, but introduce a versioned successor whose structured-output capability distinguishes JSON syntax, locally validated schema output, provider-strict schema output, and provider-strict tool input. The successor carries evidence references; it does not embed credentials or arbitrary provider payloads.

Hosted `ai_gateway_models.metadata` can retain the provider payload, normalized capability evidence, and qualification record without a new database table. Runtime model selection must project the registration revision and fingerprint alongside the current economics profile. Local Core must resolve the same registration shape from local provider discovery or persisted qualification evidence.

## Domain Model

- **Adapter capability:** A protocol and endpoint behavior that Kestrel's code knows how to encode and decode.
- **Model capability evidence:** Provider or qualification evidence about one exact model route.
- **Request requirement:** The features one model call requires, such as strict schema, native tools, reasoning continuation, or streaming.
- **Effective model contract:** The supported intersection of adapter capability, exact model evidence, routing policy, and current qualification.
- **Assurance mode:** The strength of an output guarantee. Initial modes are text, JSON syntax, locally schema-validated JSON, provider-strict JSON Schema plus local validation, and provider-strict tool input plus local validation.
- **Qualification:** A bounded probe that proves Kestrel's exact request and response path against a route. Qualification complements provider metadata; it does not replace identity or policy.
- **Conformance:** Hermetic proof that one adapter codec maps a Kestrel contract to and from the documented provider wire shape. Conformance does not prove a live model route.
- **Response proof:** Kestrel's local evidence that the final returned value and tool arguments satisfy the admitted contract. A provider claim is input to this proof, never the proof itself.

Invariants:

- JSON parse success is not schema success.
- Provider support is not exact model support.
- Model support is not upstream endpoint support.
- A capability downgrade must never be silent.
- Unsupported requests fail before provider spend when current evidence can prove incompatibility.
- Returned structured data must pass the requested schema before runtime use.
- Malformed tool arguments are contract failures, never an empty object.
- Refusal, incomplete generation, truncation, and missing required tool action are explicit outcomes, never structured-output success.
- Retry must never cross to a weaker effective contract or occur after visible output.
- Registration, routing policy, endpoint, credential revision, schema hash, and qualification revision must identify the contract used by durable evidence.

## Transition States

Legacy registrations and environment bindings currently carry coarse capabilities. They become `legacy_unqualified`: visible and usable for plain text only, but ineligible for tool-dependent, reasoning-continuation, or structured-output stages until exact evidence exists. Existing committed results remain replayable under their historical evidence. New calls never inherit `toolCallingEnabled: true` or `structuredOutputEnabled: true` from provider identity.

Qualification states are `declared`, `qualified`, `failed`, and `stale`. Provider metadata can establish `declared`. Contract-critical capabilities become selectable only when a current qualification exercises Kestrel's exact codec and verifier. A revision change makes future calls stale; an in-flight call remains bound to the snapshot it admitted.

## Decisions

- Use an effective model contract rather than provider-wide capability inheritance. Confidence: high.
- Keep protocol capability, model evidence, request requirements, and response proof as separate concepts. Confidence: high.
- Do not use model size, model-name matching, retry frequency, or output healing as proof of strict capability. Confidence: high.
- Keep versioned model registration as the persisted primary seam, with a V2 capability/evidence shape and a derived effective execution contract. Confidence: high.
- Put shared request admission and response verification around the provider gateway, not in runtime consumers and not independently in each mapper. Confidence: high.
- Keep endpoint-specific codecs inside each provider adapter. Do not share Chat, Responses, and Messages wire objects merely because field names overlap. Confidence: high.
- Require OpenRouter `require_parameters: true` for contract-carrying requests and bind qualification to an allowed endpoint set. Do not silently fall back to a weaker upstream. Confidence: high.
- Treat qualification as capability-specific and route-specific, not as a quality benchmark or blanket model approval. Confidence: high.
- Cache canonical schema compilation by schema hash and keep stable schema/tool ordering. This improves local validation latency and provider grammar-cache reuse without changing contract strength. Confidence: medium-high.

## Research and Prototypes

No prototype has been selected. The current uncertainty is ownership and contract shape, not algorithm behavior.

## Active Change Frontier

- Confirm whether OpenRouter's endpoint API publishes enough normalized per-endpoint parameter data to pin an endpoint set directly, or whether qualification plus `require_parameters` must be the first complete route proof.
- Decide the bounded freshness policy for provider declarations and qualifications. This is an operating-policy value, not part of the structural design.
- Decide whether locally validated best-effort JSON may use an explicitly requested correction attempt. It is excluded from the base design because it cannot strengthen a route into strict support.

## Decision Map

- Status: not needed
- Path: none
- Destination: one coherent effective model contract from admission through response evidence
- Return condition: not applicable

## Best Next Move

Write the durable report around the chosen registration, admission, codec, verifier, and evidence responsibilities. Keep correction retries and freshness durations outside the base contract until operating evidence justifies them.
