# Model Provider Contract Hardening Product Brief

## Product Narrative

Kestrel must know what an exact model route can do before it sends work to that route. It must also prove that the returned response met the caller's contract before it reports success.

Today, Kestrel often treats a provider-wide feature as a capability of every model on that provider. Hosted profile composition marks pinned models as tool- and structured-output capable without exact evidence. Runtime selection carries identity and economics, but not a complete capability contract. Provider adapters then map one generic request into different Chat, Responses, and Messages APIs. Some mappings use the wrong wire shape, and some response paths treat parseable JSON as proof of schema conformance.

This causes late and misleading failures. A small or routed model can be selected for strict output or required tool work that it cannot reliably perform. OpenRouter can route around unsupported parameters. A malformed provider response can reach a downstream agent as an empty tool input or a missing required action. The downstream component reports the symptom even though model admission or the adapter first made the behavior wrong.

This initiative introduces two stable product terms:

- An **exact model registration** is Kestrel's versioned, fingerprinted record of one provider, model, API endpoint, routing policy, and its evidence-backed capabilities.
- An **effective model contract** is the immutable set of capabilities that admits one model call. It combines the exact registration, current qualification, endpoint codec, routing policy, and call requirements.

Organization administrators will approve and refresh exact model routes. Kestrel will acquire capability evidence and run bounded qualifications. Runtime callers will state provider-neutral requirements. Kestrel will reject incompatible work before provider spend. Endpoint-specific adapters will preserve provider contracts. A shared verifier will validate structured output and tool arguments before runtime consumers receive them.

The result is broader, more honest model support. Smaller models can serve roles they have qualified for without being treated as substitutes for strict-schema or reliable agent-tool models.

## Outcomes and Delivery Boundary

This initiative must create these outcomes:

- Every new model call is admitted against one exact effective model contract.
- Model eligibility reflects exact capability evidence and qualification, not provider identity or model size.
- OpenAI Chat, OpenAI Responses, OpenRouter Chat, OpenRouter Responses, and Anthropic Messages use correct endpoint-specific codecs.
- JSON syntax, locally schema-validated JSON, provider-strict JSON Schema, native tools, strict tool inputs, reasoning continuation, and streaming remain distinct capabilities.
- OpenRouter sends only required capability parameters and prevents routing to endpoints that ignore them.
- Structured output and tool arguments pass shared local validation before Kestrel reports success.
- Operators can see whether a model capability is declared, qualified, stale, failed, or unsupported, and which runtime roles may use it.
- Durable call and run evidence identifies the exact registration, qualification, route, schema, tools, and provider response state used for the decision.
- Existing committed results remain replayable. Legacy routes remain visible but cannot inherit unsupported capabilities.

The delivery includes the shared contract and the OpenAI, Anthropic, and OpenRouter adapter corrections. Other provider and local-model routes must enter the same contract. They may remain plain-text or otherwise restricted until they have exact evidence and qualification.

The delivery does not include:

- model-quality benchmarking or replacement of existing evaluation calibration
- administrator-authored capability profiles
- model-name allowlists or size-based capability rules
- silent model, provider, endpoint, or assurance fallback
- response healing or schema-correction retries
- a provider SDK migration unless an adapter team chooses one inside its codec
- changes to economics, credentials, tool authorization, or prepared-call replay beyond carrying the new contract evidence

## Defining Scenarios

| Actor and trigger | Business process and product behavior | Operating handoff and result |
| --- | --- | --- |
| An organization administrator approves or refreshes a model | Kestrel resolves the exact provider model, acquires provider capability evidence, creates a versioned registration, and runs the qualifications needed for assigned roles | The model appears as declared, qualified, stale, failed, or unsupported by capability. The administrator does not enter capability claims |
| A runtime caller requests structured output or tools | The caller states provider-neutral requirements. Kestrel resolves the effective model contract after finalizing context and tools, but before provider dispatch | A compatible call proceeds with an immutable contract fingerprint. An incompatible call fails before spend and names the unmet capability and evidence state |
| OpenRouter receives a contract-carrying call | Kestrel sends only required parameters, sets `require_parameters: true`, and restricts routing to the qualified endpoint set or policy | OpenRouter may use availability fallback only inside the same effective contract. No endpoint may ignore a required parameter |
| A provider returns structured output or tool calls | The endpoint codec preserves the provider terminal state and native call objects. The shared verifier parses and validates the exact schema and tool inputs | Valid output reaches the runtime with proof. Malformed JSON, schema mismatch, unknown tools, malformed arguments, missing required calls, refusals, and incomplete output become typed failures |
| A stream fails or ends early | Kestrel requires the endpoint's documented terminal event and tracks whether visible output has started | Kestrel may retry only before visible output and only under the same contract. After visible output, it reports the provider-specific interruption without starting a hidden replacement generation |
| A registration, credential, adapter, or qualification changes | Kestrel marks affected future eligibility stale and requires refreshed evidence. An in-flight call remains bound to its admitted snapshot | New calls cannot use stale capabilities. Historical evidence and committed results remain readable under their original revisions |
| A legacy or small model route exists without full qualification | Kestrel keeps the route visible and limits it to capabilities with current proof | The route can serve qualified roles, including locally validated JSON roles when supported. It cannot silently enter strict-schema, required-tool, continuation, or streaming roles |

## Business and Process Requirements

### Model approval and readiness

- Kestrel must separate administrative approval, provider reachability, exact identity, capability declaration, qualification, and role eligibility.
- The server must acquire capability evidence. An administrator must not enter or override a capability claim.
- Approval must create or update one exact registration for the requested provider route. Aliases and canonical slugs may be retained as provenance but must not replace the routable identity.
- A model may be ready for one role and ineligible for another. Product surfaces must show this distinction.
- Capability refresh must preserve the prior registration for audit and create a new revision and fingerprint when contract evidence changes.
- A failed or stale capability must block only the roles that require it. Kestrel must not disable unrelated proven capabilities without cause.

### Runtime admission and failure behavior

- Every caller must state the output, tool, reasoning, continuation, streaming, and modality behavior it requires.
- Kestrel must reject a known incompatibility before acquiring a provider lease or spending provider tokens.
- Kestrel must not infer capability from provider identity, model name, model size, prior success rate, or a parser recovery.
- Kestrel must not weaken provider-strict output into locally validated JSON, enable a different endpoint, or substitute another model unless the caller requested that exact behavior through a separate contract.
- Availability fallback may occur only when every candidate preserves the admitted contract.
- A provider response must not count as successful structured output until local validation passes.
- A required tool contract must end with a valid provider-native tool call. HTTP success or accepted request parameters do not prove fulfillment.

### Operator experience and controls

- Model management must show exact provider and model identity, registration revision, evidence state, last qualification result, and eligible roles.
- An unavailable role must include an actionable reason, such as unsupported strict schema, stale qualification, no eligible OpenRouter endpoint, or failed required-tool proof.
- Operators must be able to request evidence refresh and qualification without editing provider payloads or database metadata.
- Operators must be able to distinguish a provider declaration from a successful live qualification.
- Support and incident review must use the effective contract and response evidence before attributing a failure to an agent or downstream runtime component.

### Measures

- Kestrel must record the number of calls admitted, rejected before spend, rejected by response verification, and interrupted after visible output.
- Kestrel must report qualification outcomes by exact route, endpoint contract, capability, and revision.
- Kestrel must make silent downgrade count observable and keep it at zero.
- Kestrel must make structured-output success with a schema-invalid value observable and keep it at zero.
- Kestrel must track late `MODEL_REQUIRED_TOOL_CALL_MISSING` failures separately from pre-spend capability rejection so the product can confirm that admission is moving failures to the correct boundary.

## Technology Requirements

### Exact registration and evidence

- The versioned model-registration contract must have a V2 form. V2 must retain exact identity, provider configuration, revision, and fingerprint.
- V2 must represent JSON syntax, local schema validation, provider-strict schema output, native tools, required tool choice, strict tool inputs, parallel tools, reasoning modes, continuation kinds, streaming terminal behavior, modalities, limits, and cache behavior separately.
- Each capability must have one evidence state: `unsupported`, `declared`, `qualified`, `failed`, or `stale`.
- Evidence must identify its source, observed revision, observation time, credential revision when relevant, adapter revision, qualification revision, and a hash of the secret-free retained payload.
- `ProviderRegistry` must describe only the behaviors Kestrel's adapter and endpoint codecs can encode and decode. It must not declare exact-model truth.
- Hosted model metadata must retain a typed V2 registration beside provider evidence and the existing economics profile.
- Local Core must publish the same registration shape for local and Desktop routes.

### Capability acquisition and qualification

- OpenRouter acquisition must use exact model details, model supported parameters, endpoint evidence, and the selected routing policy.
- Anthropic acquisition must use its per-model capabilities and the applicable Messages restrictions.
- OpenAI acquisition must use an adapter-owned, reviewed model manifest plus live qualification because the Models API does not provide a complete feature matrix.
- Qualification must be exact-route and capability specific. JSON qualification must not qualify tools. Tool qualification must not qualify reasoning or streaming.
- Each qualification must exercise Kestrel's real endpoint codec and shared verifier with a bounded, secret-free probe.
- Qualification must bind provider, model, endpoint or allowed endpoint set, routing policy, adapter revision, registration revision, credential revision, and probe revision.
- Qualification must remain separate from model-quality evaluation and runtime-evaluation calibration.

### Provider-neutral request and admission

- The versioned model request must express output kind and assurance, tool choice, strict arguments, parallelism, reasoning, continuation, streaming, and modality requirements without duplicating those semantics under each provider.
- Provider options must contain only real transport choices, such as an API endpoint or OpenRouter routing preference.
- The gateway boundary must derive one immutable effective model contract from the request, exact registration, current qualification, endpoint codec, and routing policy.
- Admission must occur after Kestrel finalizes the context and tool surface and before provider credential spend.
- The admitted contract must bind provider, model, registration revision and fingerprint, credential revision, API endpoint, routing policy, schema hash, tool-surface hash, and qualification revision.
- A changed source revision must make future calls stale. It must not rewrite an in-flight contract.

### OpenRouter routing

- OpenRouter must receive only parameters required or explicitly permitted by the caller's contract.
- The adapter must not default `parallel_tool_calls` to true when tools are present.
- Contract-carrying requests must set `provider.require_parameters: true`.
- Kestrel must compute the eligible endpoint intersection for every supplied capability parameter.
- Parameter support must not count as proof that the endpoint reliably fulfills required tools or strict schema. Qualification and terminal response proof remain required.
- OpenRouter fallback must stay within the qualified endpoint set and preserve the same effective contract.

### Endpoint-specific codecs

- OpenAI Chat and OpenAI Responses must have separate request, response, continuation, streaming, and terminal-state codecs.
- OpenAI Responses must use flat `text.format`, direct function-call items, ordered output-item replay, supported sampling controls, and explicit refusal or incomplete state.
- OpenRouter Chat and OpenRouter Responses must have separate codecs. Responses must use OpenResponses `text.format`, direct function-call items, and function-argument stream events.
- OpenRouter Responses reasoning continuation must either round-trip correctly and qualify or fail admission. Extraction without replay must not count as support.
- Anthropic Messages must use native `output_config.format` and strict tools only when the exact model supports them.
- Anthropic thinking configuration must match the exact model's supported thinking types.
- The synthetic Anthropic output-tool path may remain only as a separately named and qualified compatibility mode. It must not report native strict schema support.
- Each streaming codec must require its documented terminal event. Premature end-of-file must be an incomplete transport failure.

### Shared response proof

- A shared verifier must run after adapter normalization and before `ModelResponseV1` reaches runtime consumers.
- The verifier must parse one final JSON value and validate it against the exact caller schema with the repository's strict Ajv infrastructure.
- Prose slicing, fenced-block extraction, and response healing must not produce success for a contract-carrying response.
- The verifier must resolve each tool name against the exact request and validate arguments against that tool's schema.
- Malformed tool arguments must be a typed model-contract failure. They must never become `{}`.
- The verifier must reject unknown tools, duplicate call IDs, missing required tool calls, schema mismatch, refusal, cancellation, incomplete generation, max-token truncation, mismatched continuation, and missing stream terminal evidence.
- Domain-specific consumers may apply stricter semantic rules after shared schema proof.
- Equivalent failures must use one `MODEL_*` error taxonomy across providers while retaining safe provider-native diagnostics.

### Reliability, security, and performance

- Automatic retry must remain prohibited after visible output and for nonretryable schema or contract failures.
- A retry must use the same effective model contract. It must not cross to weaker evidence or another unapproved route.
- Reasoning continuation must remain opaque, ordered, provider-bound, model-bound, and excluded from ordinary logs.
- Capability and qualification evidence must be secret-free. Credentials and raw opaque continuation values must not enter model metadata or operator diagnostics.
- Kestrel must canonicalize and hash schemas and tool definitions. It must cache compiled Ajv validators by schema hash.
- Provider discovery and live qualification must run during approval, refresh, or stale-evidence reconciliation. Runtime admission must not make a discovery network call for every model call.
- Stable schema and tool ordering must support provider grammar caches and Kestrel prompt-cache stability.

### Durable evidence, migration, and compatibility

- Each model call must persist the effective contract fingerprint, registration and qualification revisions, route, schema hash, tool-surface hash, terminal state, validation outcome, and provider request ID when available.
- Hosted run grants must add model-registration revision and fingerprint to their durable evidence snapshot. This requires a database schema migration.
- Existing committed results must remain replayable without new provider work.
- Existing V1 registrations and legacy overlays must become `legacy_unqualified`. New calls may use them only for plain text until exact capabilities qualify.
- Legacy request fields must normalize through an explicit V1-to-V2 adapter. Conflicting legacy and provider-neutral values must fail rather than choose one silently.
- Existing approved model rows must remain visible during refresh. Runtime selectors must exclude any role whose exact requirements are not currently eligible.

### Verification

- Every shipped endpoint codec must have hermetic conformance coverage for request shape, valid response, schema-invalid JSON, malformed tool arguments, refusal, incomplete state, continuation order, stream terminal behavior, and premature stream end.
- Live qualification must cover every capability that a route advertises as qualified.
- Cross-provider tests must prove that the shared verifier gives equivalent failures the same runtime meaning.
- Runtime tests must prove that a structurally plausible but semantically invalid custom-gateway response cannot bypass the shared verifier.
- Migration tests must prove that legacy text calls remain available, restricted capabilities fail before spend, historical evidence remains readable, and new grants bind the registration fingerprint.

## People and Operating Requirements

### Organization administrators

- Administrators may approve an exact model, assign intended roles, request refresh, and inspect status.
- Administrators must not author, edit, or override capability evidence.
- The product must explain why a role is unavailable and what refresh or qualification action is available.

### Runtime and provider maintainers

- Kestrel runtime maintainers own the V2 registration, effective contract resolver, shared verifier, common error taxonomy, and durable evidence shape.
- Each provider adapter maintainer owns that provider's model evidence translator, endpoint codecs, conformance fixtures, and provider-native diagnostics.
- Adapter maintainers must update the adapter-owned model manifest or translator when provider contracts change. A provider-wide Boolean is not an acceptable shortcut.
- Local Core maintainers own exact local-model discovery, qualification execution, and publication of the shared registration shape.

### Operations and support

- Runtime operations own evidence-freshness policy, qualification scheduling, stale-evidence reconciliation, and alerts for qualification regressions.
- Runtime operations must set the initial evidence-freshness values before time-based expiry is enabled in production.
- Support must use the registration, admission decision, endpoint, terminal state, and verifier result when diagnosing a model failure.
- Support must not advise silent model substitution, manual capability metadata edits, or repeated spending retries as a normal repair.
- Incident escalation must go to the adapter owner for wire or provider-native failures, the runtime owner for admission or shared verification failures, and operations for stale or unavailable evidence.

### Product ownership

- Product owners decide which capabilities each runtime role requires.
- Product owners may add a best-effort JSON correction policy only through a later explicit decision supported by cost, latency, and valid-output evidence.
- Model quality and capability conformance remain separate product decisions. Passing one must not override failure of the other.

## Success and Readiness

**Status: Ready for issue creation.**

Success is observable when:

- every new provider call has an effective model contract fingerprint
- known incompatibilities fail before credential spend and name the unmet requirement
- no schema-invalid value records structured-output success
- no malformed tool argument becomes an empty object
- no OpenRouter contract-carrying request silently loses a required parameter
- GLM and other smaller models appear as eligible only for roles they have qualified for
- OpenAI, OpenRouter, and Anthropic conformance suites cover each shipped endpoint codec and terminal state
- live qualification records bind the exact route, adapter, registration, credential, and probe revisions
- retries stop at visible output and never cross to a weaker contract
- operators can distinguish declared, qualified, stale, failed, and unsupported capabilities
- existing committed results replay, legacy routes remain visible, and new incompatible legacy calls fail before spend
- historical run grants identify the model-registration revision and fingerprint that admitted the run

There are no delivery blockers in the settled design.

Two non-blocking unknowns remain:

- **Evidence freshness duration.** Operations must choose configurable initial durations from provider churn and qualification-failure data. This changes refresh frequency, not contract ownership or admission behavior.
- **Best-effort JSON correction.** It is excluded from this delivery. Product owners may reconsider it later if evidence shows that one explicit correction call improves valid output enough to justify its cost and latency. It cannot upgrade a route to strict support.

## Source Artifacts

- [Model Provider Contract Hardening Change Design](../design/model-provider-contract-hardening-change-design.md)
- [Provider Output and Continuation Contracts Research](../research/2026-08-26-provider-output-contracts.md)
- [Model Provider Contract Hardening Design Notebook](../../.design/model-provider-contract-hardening/notebook.md)
