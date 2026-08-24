# Model-Selected Sandbox Capability Design Notebook

## Current Position

Keep one canonical `code.execute` operation. Extend each registered sandbox capability adapter with a secret-free model contract, then let `codeExecuteDefinitionForProfile` build the model-visible capability schema and instructions from the resolved profile and the closed adapter registry.

The `capability` field remains optional. Its presence means the model selected authority. The sandbox may then invoke that authority or leave it unused. Its absence means ordinary capability-free execution. The latest investigation ruled out a new tool alias and a required top-level discriminator because both add contract churn without removing the model's semantic choice.

## Requested Change

When a resolved profile offers `tavily.search.read` and the user explicitly asks the model to use it, a capable live model should construct a capability-bound `code.execute` call instead of silently producing an ordinary code run.

The change must preserve these scenarios:

- ordinary `code.execute` with no capability authority
- capability selected and invoked once
- capability selected but intentionally unused
- exact replay of an already committed result
- no credential, provider URL, lease, or authority material in model input

## Starting Sources

- Live hosted-runner qualification on 2026-08-23 with `openai/gpt-5.6-luna`
- `tools/code/execute.ts`
- `tools/runtime/normalizeToolInput.ts`
- `tools/runtime/UnifiedToolRegistry.ts`
- `src/code/SandboxCapabilityAdapterRegistry.ts`
- `src/code/CodeExecutionService.ts`
- `src/code/adapters/TavilySearchReadAdapter.ts`
- `models/openrouter/OpenRouterMapper.ts`
- `models/openai/OpenAiMapper.ts`
- `tests/unit/code-execute-tool.test.ts`
- `tests/integration/web-command.test.ts`
- `docs/decisions/0003-confined-docker-capability-transport.md`
- `docs/decisions/0004-tavily-sandbox-read-capability.md`

## Relevant Current Behavior

1. `UnifiedToolRegistry` replaces the static `code.execute` definition with `codeExecuteDefinitionForProfile`.
2. That function removes `capability` when the profile offers none. When capabilities exist, it changes only the `capabilityId` enum.
3. The tool and nested fields have no capability-use descriptions. The model sees no explanation that the outer capability selection authorizes the loopback broker request in the code body.
4. `parseCodeExecutionRequest` still parses only the legacy Tavily V1 selection. The service later normalizes that selection to V2 and resolves it through the generic adapter registry.
5. The controlled qualification supplies `capability` explicitly and passes. The live Luna run called `code.execute` but omitted `capability`, so no lease or `capabilityReplayEvidence` existed.

The first wrong component is the model-visible tool contract. The normalizer, handler, adapter, lease coordinator, Docker broker, and replay path preserve and execute a capability when the model supplies one.

## Affected Surface

- Adapter contract: add model-facing metadata and an exact selection-input schema.
- Tavily adapter: own the query and `maxResults` descriptions and bounds.
- Code tool definition: compose profile-authorized adapter branches and broker-use instructions.
- Code request parser: accept and normalize V1 or V2 selections.
- Unified registry: pass the same adapter registry used by execution into model-contract generation.
- Provider mappers: retain nested schemas and descriptions; add regression evidence for OpenRouter and OpenAI mappings.
- Tool contract fingerprints: the changed definition creates a new descriptor revision for new prepared calls.
- Qualification: keep the live journey single-attempt and informational. A missing selection remains a failed qualification, not a retry or fallback.

The durable lease schema, broker protocol, credential resolution, Docker confinement, and effect-result store do not change.

## External Research

### How should tool use be explained?

OpenRouter recommends clear, comprehensive tool and parameter descriptions. It says descriptions should explain when and how to use a tool. OpenAI likewise recommends putting tool-specific guidance in tool descriptions, including required inputs, side effects, retry safety, and common errors.

Code implication: the capability guidance belongs in the profile-specific tool definition, not in the qualification prompt alone or a generic system prompt.

Sources:

- https://openrouter.ai/docs/guides/features/tool-calling
- https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.5

### Can strict schemas force semantic capability selection?

No. `tool_choice` can require a tool call or a named tool, while schema validation constrains the arguments of a call. Neither mechanism can decide whether an optional capability matches the user's intent inside a shared code tool.

Code implication: the runtime must preserve model agency and measure adherence. It must not treat syntactic validity as proof that the requested capability was selected.

Sources:

- https://developers.openai.com/api/reference/cli/resources/chat/subresources/completions
- https://openrouter.ai/docs/guides/features/tool-calling

## Candidate Seams and Options

### Option A: Improve the static Tavily field descriptions

Attach descriptions directly in `tools/code/execute.ts`.

This is small but keeps generic adapter authoring split across the adapter, code tool, and parser. A second adapter would require another hard-coded tool edit.

### Option B: Add an adapter-owned model contract and compose it into `code.execute`

Each registered adapter supplies its public selection schema and short purpose text. The code tool adds the invariant broker instructions and composes only profile-authorized adapters.

This matches the existing closed registry. It keeps secrets and authority out of model input. It also closes the current mismatch where execution is generic V2 but model authoring and parsing remain Tavily V1.

Chosen.

### Option C: Add `code.execute_with_capability`

A separate tool would make capability intent prominent and could require the selection.

It would create another tool identity, approval surface, activation descriptor, audit name, policy binding, and replay contract for the same runtime action. Adapter growth could also create tool proliferation. The current evidence does not justify that cost.

### Option D: Require an `executionKind` discriminator on every code call

This would make ordinary versus capability-bound intent explicit in every call.

The existing presence or absence of `capability` already carries that distinction. A new required field would change all callers and persisted effective inputs, while a model could still choose `ordinary` against the user's request.

### Option E: Add a system-prompt rule or qualification retry

This is detached from the registered adapter contract and can drift from the active profile. A retry would hide the live-model integration failure that the qualification is meant to expose.

Rejected.

## Proposed Delta

### Adapter model contract

Add a required `modelContract` to `SandboxCapabilityAdapter`. It contains only public, secret-free data:

- a concise purpose statement
- an exact JSON Schema for the adapter-owned `input`
- short parameter descriptions and bounded examples

The registry validates that a model contract exists for every adapter. The model contract cannot provide a resource override, credential reference, destination, lease, approval, tenant, or broker address.

### Profile-specific tool definition

Change `codeExecuteDefinitionForProfile` to receive the closed adapter registry. For every authored capability, it must:

1. normalize the profile to V2
2. exact-match the registered adapter ID, operation, and fixed resource
3. parse the profile through that adapter
4. create one nested capability selection branch with required `version`, `capabilityId`, `operation`, and adapter input
5. include only public ceilings that help the model form a valid request

The `capability` property remains optional. Its description states:

> Include this object when the request asks you to use one of the offered sandbox capabilities. Supplying it selects short-lived authority even if the code later leaves it unused. Omit it only for ordinary capability-free execution.

The `code` description states the shared invocation contract for a selected capability: call the fixed loopback broker endpoint using the exact registered operation, destination derived by the trusted registry, and the same canonical input. The model never chooses the upstream HTTPS resource.

When one adapter is available, emit one exact object schema. When several are available, emit a nested `oneOf` under `capability`. Both provider mappers preserve nested unions. Do not use a top-level union because the shared OpenAI mapper removes top-level `oneOf`, `anyOf`, and `const` keywords.

### Request parsing

Replace the V1-only parser call with `normalizeSandboxCapabilitySelectionV2`. Continue to accept legacy Tavily V1 selections, but advertise V2 for new model calls. The handler passes the normalized selection unchanged to `CodeExecutionService`, which remains the authority owner.

### Evidence

Add contract tests that prove:

- no profile capabilities means no model-visible capability field
- every registered adapter produces one profile-authorized model branch
- descriptions explain selection, selected-unused behavior, and broker invocation
- schemas contain no credential, lease, authority, arbitrary resource, or destination override
- model-advertised selections pass the same adapter parser and ceilings used by execution
- V1 Tavily calls remain accepted while new snapshots advertise V2
- OpenRouter and OpenAI payloads retain the nested descriptions and branch schema
- a deterministic model call and the live Luna qualification both select the capability when explicitly requested

## Domain Model

- **Capability offer:** A profile-authorized adapter operation visible to the model.
- **Capability selection:** The `capability` object in a prepared `code.execute` call. Selection causes durable authority issuance.
- **Capability invocation:** The sandbox code's request to the fixed loopback broker. Invocation consumes the selected authority.
- **Ordinary execution:** A `code.execute` call with no capability selection.
- **Selected-unused execution:** A call with a capability selection but no broker invocation.

Invariants:

- Selection and invocation are different events.
- Capability absence must never be interpreted as implicit authority.
- Capability presence must never carry a credential, upstream URL, lease, or host authority.
- Only the resolved profile and closed registry determine which selection branches the model sees.
- The runtime parser and adapter remain authoritative even when the model schema is strict.

## Transition States

- Existing exact DONE results remain readable through `effect.result.get` because retrieval validates persisted prepared input and result rather than reminting authority.
- Legacy Tavily V1 selections remain accepted for old prepared calls and controlled callers.
- New model snapshots advertise V2 capability selections.
- The changed tool definition creates a new descriptor revision. Nonterminal prepared calls created under the previous definition must fail currentness rather than be rewritten.
- No database migration is required.

## Decisions

### Keep one canonical tool

- Choice: keep `code.execute` as the only runtime operation.
- Rationale: avoids duplicate policy, approval, audit, and replay identities.
- Confidence: high.
- Reopen if distinct capability operations need materially different approval or interaction semantics.

### Keep capability optional

- Choice: preserve presence or absence of `capability` as the selection boundary.
- Rationale: ordinary and selected-unused execution are required behaviors.
- Confidence: high.
- Reopen if product policy requires a turn-level trusted declaration that a capability must be used.

### Put model guidance in adapters and the code tool

- Choice: adapters own input meaning; the code tool owns the shared broker-use instructions.
- Rationale: follows existing responsibility boundaries and prevents adapter-specific duplication in global prompts.
- Confidence: high.
- Reopen if provider schemas cannot preserve nested adapter branches consistently.

## Research and Prototypes

Code inspection established that nested unions are already used in tool schemas. OpenRouter forwards the complete tool schema. The shared OpenAI mapper removes only top-level composition keywords, so a nested capability union is the portable shape.

No runtime prototype was needed. The controlled journey already proves downstream behavior when the model supplies the selection, and the live journey proves the missing model-contract behavior.

## Active Change Frontier

- Exact wording and maximum size for the generated adapter guidance should be settled during implementation against schema-size limits.
- The live qualification should record the model's prepared input when selection is omitted, without exposing secrets, so future failures state the exact missing contract field.

Neither question blocks the design.

## Decision Map

- Status: not needed
- Path: none
- Destination: a coherent model-visible capability selection contract
- Return condition: not applicable

## Best Next Move

Use this design to create an implementation brief or issue only if requested. The first implementation proof should construct the profile-specific Luna tool payload and assert its exact descriptions and V2 selection branch before changing runtime execution.
