# Make OpenRouter codecs and routing contract-safe

## Useful outcome

An OpenRouter call sends only the parameters its exact contract requires, and routing cannot select an endpoint that ignores those requirements. Chat and Responses use their own wire formats, including for smaller and routed models such as GLM.

## What changes

Separate OpenRouter Chat and OpenRouter Responses request, response, and stream codecs.

Remove the implicit `parallel_tool_calls: true` default. Emit parallelism, structured-output, tool-choice, reasoning, and continuation fields only when the provider-neutral request requires or explicitly permits them. Contract-carrying requests must set `provider.require_parameters: true` and carry only the qualified endpoint or provider policy supplied by the exact registration.

Map Chat structured output through `response_format`. Map OpenRouter Responses through OpenResponses `text.format`, direct function-call output items, and function-argument stream events. Reasoning continuation must round-trip through the selected endpoint or be reported unsupported for qualification.

Decode terminal states without prose slicing, fence removal, JSON healing, or `{}` substitution for malformed tool arguments. Preserve provider diagnostics and request identity for shared verification.

Extend the existing exact OpenRouter model-detail resolver with a typed capability-evidence translator. Combine model supported parameters, endpoint evidence, and routing policy while preserving the existing exact identity and economics behavior. Do not replace the routable model ID with an alias or canonical slug.

## Requirements and delivery context

The canonical requirements are in the [Product Brief](../../model-provider-contract-hardening-product-brief.md).

The owning adapter seams are `models/openrouter/OpenRouterMapper.ts`, `OpenRouterInvoker.ts`, `OpenRouterSchemaCompiler.ts`, and `OpenRouterErrors.ts`. Exact hosted identity and economics acquisition already exist in `apps/web/lib/ai/openrouter-model-resolution.ts` and `apps/web/lib/ai/gateways.ts`; extend that evidence path rather than recreating it.

No endpoint ranking, model-name rules, parameter fallback, or broad provider declaration is allowed. Availability fallback may occur only inside the qualified endpoint set and must preserve the same effective contract.

## Done when

- Chat and Responses request fixtures use the correct distinct structured-output shapes.
- A plain-text request sends no unsolicited structured-output, tool, parallelism, reasoning, or continuation parameters.
- A contract-carrying request sets `require_parameters: true` and cannot route outside its qualified endpoint set or policy.
- Responses direct function calls and function-argument stream events normalize correctly.
- Prose or fenced JSON, malformed tool arguments, missing terminal events, and unsupported continuation fail without repair or fallback.
- Exact OpenRouter evidence retains model details, supported parameters, endpoint set, routing policy, and source hashes without changing existing economics admission.
- Hermetic matrices cover fully capable, partially capable, and no-eligible-endpoint routes, including a GLM fixture.
- Focused mapper, invoker, error, routing, and evidence tests pass.
- `pnpm validate` passes.

## Depends on

- [Establish exact model and request contracts](01-establish-exact-model-contracts.md)
