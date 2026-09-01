# Qualify exact model capabilities through real codecs

## Useful outcome

Kestrel can prove which capabilities one exact model route currently supports. A model may qualify for plain text or locally validated JSON while remaining ineligible for strict schema, required tools, continuation, or streaming roles.

## What changes

Add a shared capability-qualification service that consumes Model Registration V2 and runs bounded, capability-specific probes through the real provider factory, endpoint codec, and shared response verifier.

Keep separate probes for JSON syntax, local schema validation, provider-strict schema output, native tools, required tool choice, strict tool inputs, parallel tools, each reasoning mode, each continuation kind, and streaming terminal behavior. One passing probe must not imply another capability.

Every result must bind the exact provider, model, API endpoint, endpoint codec, routing policy, adapter revision, registration revision and fingerprint, credential revision, probe revision, retained request and response hashes, terminal state, and validation outcome. Evidence must exclude credentials, opaque reasoning state, and unrestricted provider payloads.

Produce stable `qualified`, `stale`, `failed`, and `unsupported` outcomes per capability. Make refresh idempotent and concurrency-safe. A model, endpoint, route, credential, adapter, registration, or probe revision change must make affected proof stale for future calls without mutating in-flight bindings or historical results.

Support configurable freshness durations and an injectable clock. Provide a hermetic fake-provider suite and an explicit live qualification entry point. Live qualification supplements hermetic conformance; it does not replace it or run on every model call.

## Requirements and delivery context

The canonical requirements are in the [Product Brief](../../model-provider-contract-hardening-product-brief.md).

`models/ProviderRegistry.ts` currently has only a provider-wide declaration and a shallow conformance fixture. There is no current model-capability qualification lifecycle. Do not conflate this work with the sandbox-capability qualification runner in `cli/runner/qualification-service.ts` or RunPod deployment qualification.

Place the shared lifecycle beside the model contracts and adapters so hosted and Local Core callers use the same result shape. Provider-specific probes must call the provider codecs delivered by the prerequisite issues.

No model-name, parameter-count, model-size, endpoint-ranking, or inferred capability heuristic is allowed. Freshness durations are configuration, not capability evidence.

## Done when

- Hermetic probes produce independent outcomes for every capability named in the Product Brief.
- A partially capable OpenRouter/GLM fixture qualifies only the supported subset and reports why strict or required-tool roles are unavailable.
- Results bind every required revision and hash; any material binding change makes only the affected future proof stale.
- Concurrent or failed refresh cannot make stale or failed evidence current, erase the last result, or create conflicting revisions.
- The same service can return role-ready input for hosted and Local Core callers without provider-wide defaults.
- Live qualification is opt-in, bounded, secret-safe, and produces the same evidence contract as hermetic qualification.
- Focused qualification, freshness, concurrency, and redaction tests pass.
- `pnpm validate:process` and `pnpm validate` pass.

## Depends on

- [Prove structured output and tool calls before success](02-prove-model-responses.md)
- [Correct OpenAI Chat and Responses codecs](03-correct-openai-codecs.md)
- [Make OpenRouter codecs and routing contract-safe](04-correct-openrouter-codecs-and-routing.md)
- [Use native Anthropic Messages contracts](05-correct-anthropic-codec.md)
