# Admit effective model contracts before provider spend

## Useful outcome

Kestrel rejects an unsupported structured-output, required-tool, reasoning, continuation, or streaming call before provider spend. A valid call reaches the provider with one immutable effective contract that all retries and response proof must preserve.

## What changes

Add an effective-contract resolver to runtime dependencies. Resolve `EffectiveModelContractV1` as the intersection of the final provider-neutral request requirements, exact route binding, current capability qualification, selected endpoint codec, and routing policy.

Invoke admission in `RuntimeIO.model()` after context, messages, tools, schema, reasoning continuation, execution-boundary shaping, and tool-surface snapshot are finalized, but before credential-bearing provider dispatch. Recheck the exact route at the credential broker as defense in depth.

Reject unsupported or stale requirements with actionable `MODEL_*` failures that name the unmet capability and current evidence state. Rejection must make zero provider calls, acquire no provider credential for dispatch, and perform no silent model, endpoint, routing, schema, tool, or assurance fallback.

Bind the effective-contract fingerprint, registration and qualification revisions, schema hash, tool-surface hash, endpoint codec, and route fingerprint to the call. A refresh during execution affects future calls only. Every retry must use the same binding and existing no-retry-after-visible-output behavior.

Run the shared verifier on the decoded response before returning success. Keep downstream semantic checks, but ensure failures such as `MODEL_REQUIRED_TOOL_CALL_MISSING` are attributed to admission or response proof when those boundaries first made the behavior wrong.

Legacy V1 routes may execute plain-text calls through the explicit compatibility contract. Structured output, required tools, continuation, and strict streaming roles must fail before spend until qualified.

## Requirements and delivery context

The canonical requirements are in the [Product Brief](../../model-provider-contract-hardening-product-brief.md).

`src/engine/RuntimeIO.ts` owns the fully shaped call. `src/kestrel/contracts/execution.ts` and `src/engine/ExecutionEngine.ts` own runtime dependency construction. `cli/runtime/gateway-credential-broker.ts` owns brokered dispatch. `models/VersionedModelBoundary.ts` remains the envelope boundary; it is not the capability admission owner.

Preserve economics admission and the retry invariant in `src/io/ModelGateway.ts`. Capability admission is an additional exact contract, not a replacement for economics or downstream quality evaluation.

## Done when

- Fake-gateway tests show zero provider dispatch for unsupported strict schema, required tools, parallel tools, reasoning, continuation, streaming, stale qualification, route mismatch, and legacy structured requests.
- A valid call carries one immutable effective-contract fingerprint through broker dispatch, retry attempts, endpoint decoding, and shared verification.
- A mid-call registration or qualification refresh does not alter the active binding; the next call sees the new state.
- No failure path silently changes model, endpoint, routing, schema, tool requirements, or assurance level.
- Existing retry tests still prove no hidden retry after visible output begins.
- Focused RuntimeIO, execution dependency, broker, verifier integration, and process-boundary tests pass.
- `pnpm validate:process` and `pnpm validate` pass.

## Depends on

- [Prove structured output and tool calls before success](02-prove-model-responses.md)
- [Qualify exact model capabilities through real codecs](06-qualify-exact-model-capabilities.md)
- [Bind runtime routes to exact model evidence](07-bind-exact-runtime-routes.md)
