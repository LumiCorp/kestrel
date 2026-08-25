# Model-Selected Sandbox Capability Change Design

## Executive Summary

Make each sandbox capability adapter define a public model contract, then compose those contracts into the profile-specific `code.execute` tool definition. Keep one canonical code tool and keep capability selection optional.

This repairs the first component that produced the wrong live behavior. Luna received a valid `code.execute` schema but no explanation of what the capability field meant or how it related to the loopback broker call. It therefore made an ordinary code call even though the user explicitly requested Tavily. Downstream execution was not the cause: the controlled journey passed when its deterministic model supplied the capability selection.

The change also aligns the model surface with the generic V2 adapter runtime introduced by the adapter registry. New model calls use a V2 selection branch generated from the exact registered adapter. Legacy Tavily V1 selections remain readable.

## Requested Outcome

When a resolved profile offers `tavily.search.read` and a user asks a live model to use it, the model-visible contract must explain all of the following:

- the capability must be selected in the outer `code.execute` input
- selection grants short-lived authority but does not itself contact Tavily
- the sandbox code invokes the selected operation through the fixed loopback broker
- the capability input and broker input must agree
- the model cannot choose a credential, upstream URL, lease, destination override, or authority

Ordinary capability-free execution and selected-but-unused execution must remain valid. The qualification must still fail when the live model omits a requested capability. It must not silently retry or add authority after the model call.

## Relevant Current Behavior

`code.execute` has one generic sentence describing Docker execution. Its `language`, `code`, and nested `capability` fields have no descriptions. The capability branch is optional, and the static schema is Tavily-specific ([`tools/code/execute.ts`](../../tools/code/execute.ts#L20)).

`codeExecuteDefinitionForProfile` is the correct dynamic seam, but it currently does only two things: remove `capability` when no capability is authored, or replace the `capabilityId` enum when one is authored ([`tools/code/execute.ts`](../../tools/code/execute.ts#L154)). `UnifiedToolRegistry` installs that result as both the canonical descriptor and model tool specification ([`tools/runtime/UnifiedToolRegistry.ts`](../../tools/runtime/UnifiedToolRegistry.ts#L234)).

The handler preserves a supplied capability and passes trusted prepared-call identity to `CodeExecutionService` ([`tools/code/execute.ts`](../../tools/code/execute.ts#L101)). The tool input normalizer also preserves the nested object unchanged ([`tools/runtime/normalizeToolInput.ts`](../../tools/runtime/normalizeToolInput.ts#L10)).

The execution boundary is already generic. It normalizes a selected capability to V2, exact-matches the profile and adapter registry, parses the adapter input, and only then resolves host authority and credentials ([`src/code/CodeExecutionService.ts`](../../src/code/CodeExecutionService.ts#L374)). The closed registry owns exact adapter ID, operation, resource, credential kind, and effect class, but it has no model-facing contract ([`src/code/SandboxCapabilityAdapterRegistry.ts`](../../src/code/SandboxCapabilityAdapterRegistry.ts#L19)).

One mismatch remains: `parseCodeExecutionRequest` accepts only the legacy Tavily V1 selection, even though execution normalizes generic V2 selections ([`tools/code/execute.ts`](../../tools/code/execute.ts#L167)).

The live qualification prompt explicitly asked Luna to include `tavily.search.read` and provided the exact broker call. Luna called `code.execute` and the run completed, but the call omitted `capability`, so no lease or `capabilityReplayEvidence` existed. The deterministic controlled model supplies the same field and passes ([`scripts/qualification/sandbox-capability-model-server.ts`](../../scripts/qualification/sandbox-capability-model-server.ts#L66)). The live journey's public assertions correctly treated the omission as a failure ([`tests/integration/web-command.test.ts`](../../tests/integration/web-command.test.ts#L594)).

## Affected Surface

The change affects five connected responsibilities:

| Surface | Current responsibility | Proposed responsibility |
| --- | --- | --- |
| Adapter | Parse profile and selection; invoke fixed provider | Also describe its public purpose and exact input schema to models |
| Adapter registry | Exact runtime lookup | Validate that every adapter has a safe model contract |
| Code tool definition | Static Tavily shape plus profile ID enum | Compose exact profile-authorized adapter branches and shared broker instructions |
| Code request parser | Parse Tavily V1 only | Normalize V1 or V2 selection before execution |
| Tool evidence | Prove field availability and downstream preservation | Prove model-visible meaning, provider mapping, parser agreement, and live adherence |

The durable lease state machine, credential registry, broker protocol, Docker isolation, provider invocation, exact-result persistence, and replay store stay unchanged.

## External Findings That Shaped the Design

OpenRouter's tool-calling guidance recommends clear tool names, comprehensive descriptions, structured parameters, and parameter examples. It states that the model uses the tool specification to decide which function to request and what arguments to supply. This supports putting capability meaning into the tool contract rather than relying on a qualification prompt alone. [OpenRouter tool-calling guide](https://openrouter.ai/docs/guides/features/tool-calling)

OpenAI recommends putting tool-specific guidance in tool descriptions, including when to use the tool, required inputs, side effects, retry safety, and common error modes. [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.5)

Both providers distinguish tool choice from argument validation. `tool_choice` can force a named tool call, while the function schema constrains the arguments. Neither can infer that an optional capability matches the user's intent inside a shared code tool. [OpenAI chat completions reference](https://developers.openai.com/api/reference/cli/resources/chat/subresources/completions), [OpenRouter tool-calling guide](https://openrouter.ai/docs/guides/features/tool-calling)

That distinction matters here. Kestrel can make the selection legible and validate it exactly. Kestrel cannot claim that strict JSON syntax guarantees correct semantic selection by a model. The live qualification remains the acceptance evidence for that layer.

## Options and Candidate Seams

### Static description repair

Adding Tavily descriptions directly to `tools/code/execute.ts` is the smallest patch. It would improve Luna's immediate input but preserve the architectural mismatch: execution adapters would remain generic while the model tool stayed hard-coded to Tavily.

This option is weaker because each new adapter would require changes in both the adapter and the code tool.

### Adapter-owned model contract composed by `code.execute`

Each adapter supplies a secret-free purpose and exact input schema. `codeExecuteDefinitionForProfile` uses the closed registry and resolved profile to build the optional capability branch.

This is the chosen seam. It puts adapter-specific meaning beside the adapter parser and keeps shared broker instructions in the code tool. It also makes V2 adapter selection reachable from a model without widening runtime authority.

### Separate capability code tool

A tool such as `code.execute_with_capability` could require a capability selection. It would also create a second tool identity for policy, approvals, activation snapshots, audit, and exact replay. Multiple adapters could multiply those tools.

The live failure does not justify that duplication. One canonical operation already supports all required states.

### Required execution discriminator

A required `executionKind: ordinary | capability` field would make the branch explicit. It would change every code caller and every new prepared input, while still allowing a model to choose `ordinary` against the user's instruction. The existing presence of `capability` is already the correct discriminator.

### Prompt-only instruction or retry

A global prompt rule cannot be derived exactly from the active adapter registry and profile. A retry would hide the integration behavior that the live qualification measures. Neither is an acceptable owner for the repair.

## Proposed Delta

### Add a public model contract to each adapter

Extend `SandboxCapabilityAdapter` with required, secret-free model metadata:

```ts
interface SandboxCapabilityAdapterModelContract {
  purpose: string;
  inputSchema: Record<string, unknown>;
}
```

The input schema describes only adapter input. For Tavily it describes `query` and `maxResults`, including their profile-bounded maximums and concise examples. It does not contain credentials, resource overrides, destinations, identities, approvals, leases, or broker configuration.

The adapter registry must reject an adapter without a model contract. The shared conformance harness must compare representative accepted and rejected inputs against both the advertised schema and the adapter parser. Runtime parsing remains authoritative.

### Generate the exact capability branch from the resolved profile

Change `codeExecuteDefinitionForProfile` to accept the same closed adapter registry used by execution. It must normalize each authored profile to V2 and exact-match the adapter ID, operation, resource, and effect class before it creates model-visible data.

For one offered adapter, generate one exact object. For several adapters, generate a nested `oneOf` under the optional `capability` property. Each branch requires:

- `version: 2`
- the exact `capabilityId`
- the exact `operation`
- adapter-owned `input`

The capability description must distinguish selection from invocation:

> Include this object when the request asks you to use one of the offered sandbox capabilities. Supplying it selects short-lived authority even if the code later leaves it unused. Omit it only for ordinary capability-free execution.

The code description must explain the shared invocation contract. When a capability is selected, the program posts the exact operation, registry-derived destination, and matching input to the fixed loopback broker endpoint. The description may show the exact public request shape. It must not expose or accept an upstream URL or credential.

Nested composition is deliberate. OpenRouter forwards the complete function schema ([`models/openrouter/OpenRouterMapper.ts`](../../models/openrouter/OpenRouterMapper.ts#L378)). The shared OpenAI mapper removes top-level composition keywords before sending function parameters ([`models/openai/OpenAiMapper.ts`](../../models/openai/OpenAiMapper.ts#L388)), but it preserves nested property schemas.

When the profile offers no registered adapter, continue to remove `capability` entirely. Missing or mismatched adapter registration must fail profile/tool-surface construction rather than silently hide or downgrade the capability.

### Normalize V1 and V2 at the code tool boundary

Replace the V1-only selection parser with `normalizeSandboxCapabilitySelectionV2`. New model snapshots advertise V2. Existing Tavily V1 prepared inputs and controlled callers remain accepted and normalize to the same canonical V2 selection used by `CodeExecutionService`.

No authority moves into the tool parser. The service still owns exact profile matching, currentness, credential resolution, lease issuance, adapter execution, and cleanup.

### Treat the model contract as versioned evidence

The richer tool definition changes the `code.execute` descriptor revision. New prepared calls bind the new schema and descriptions. Nonterminal calls prepared under the old descriptor must fail currentness rather than be rewritten.

Committed exact results remain directly retrievable through `effect.result.get`, which reads and validates the persisted prepared call and result without invoking the provider. No database migration is required.

### Qualification and diagnostic evidence

The acceptance surface must include:

- a unit test for the exact generated Tavily model contract
- a registry conformance test that covers every adapter
- mapper tests proving nested descriptions and schemas reach OpenRouter and OpenAI payloads
- a prepared-call test proving V2 selection survives normalization and binds the existing tool call ID
- the deterministic controlled journey
- one live Luna journey with no automatic retry or fallback

If the live model omits capability selection, the qualification evidence should record the redacted prepared `code.execute` input and report `requested capability was not selected`. This makes the failure diagnostic without granting authority after the fact.

## Transition and Coexistence

Three states coexist:

| State | Model contract | Runtime behavior |
| --- | --- | --- |
| Existing committed result | Persisted V1 or V2 prepared input | Exact result remains readable; no live work |
| Existing nonterminal prepared call | Old descriptor revision | Fails currentness; never rewritten or reminted |
| New call | V2 profile-specific model branch | Normalizes to V2 and uses current adapter/lease path |

Legacy V1 support can be removed only after no supported durable prepared input or controlled caller depends on it. This design does not set that removal date.

## Decisions

### One canonical `code.execute`

Keep the existing tool identity. Capability selection changes authority, not the fundamental operation. This avoids duplicate policy, approval, audit, and replay contracts.

Confidence is high. Reopen this decision only if future capability classes require different user interaction or approval semantics before the model can call code.

### Optional capability selection

Keep `capability` optional. Its presence selects authority; its absence means ordinary execution. This directly represents capability-free and selected-unused behavior.

Confidence is high. Reopen this decision only if a trusted turn-level contract must require capability use independently of model judgment.

### Adapter-owned input meaning, code-tool-owned transport guidance

The adapter owns its purpose and input schema. The code tool owns the fixed broker invocation instructions shared by all adapters. This keeps model guidance aligned with runtime parsing without letting an adapter redefine confinement.

Confidence is high.

### No heuristic repair

Do not infer capability intent from prompt keywords, code text, URLs, or query overlap. Do not add the capability after the model call. A missing selection remains an observable model-contract failure.

Confidence is high and follows Kestrel's existing exact-contract rules.

## Remaining Design Questions

Two implementation details remain open but do not block the design:

- Set a bounded size for generated adapter guidance so many adapters cannot exceed tool-schema limits.
- Decide the exact redacted diagnostic shape for a live model that omits a requested selection.

Neither decision changes the owning seam or the runtime authority model.
