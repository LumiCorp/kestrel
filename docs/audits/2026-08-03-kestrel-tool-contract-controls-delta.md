# Kestrel Tool Contract Controls Delta

## Review status

This is a focused implementation delta for the three-PR tool-contract and
registry-integrity wave completed from the `6dfd96a5` planning base. It reviews
only controls 017–024 against the canonical descriptor contracts, atomic tool
invocation path, transactional generations, and proof suites delivered by the
wave.

This document is not a new 200-control inspection. The theoretical movement of
up to `+2.5` points remains planning language until a separate full
reinspection verifies every control at one commit. It does not recalculate the
overall Kestrel score or its critical-control result.

## Delta conclusion

Executable tools now enter the runtime through a strict immutable descriptor
that owns source and protocol identity, model description and input schema,
runtime output contract, capability and presentation semantics, handler ID,
and result-normalizer ID. Canonical descriptor references are carried into a
scope-bound activation, one model-request surface snapshot, the prepared call,
approval authority, execution outcome, tool updates, and V2 result evidence.

Model-origin input must pass the exact advertised schema before any trusted
transformation, and effective input is validated again after an exact adapter.
Execution dispatch uses the already pinned handler and generation rather than
resolving a current tool by name. Dynamic generations remain live through
streaming, queueing, approval waits, execution, and evidence settlement. A
failed refresh retains the active generation, while restart without the exact
dynamic handler fails closed.

Handlers return raw output only. Exact registered normalizers cannot replace
descriptor evidence, and committed external effects become terminal when
normalization or output validation fails. Recorded V1/V2 evidence is readable,
but replay never converts it into new executable authority.

## Implementation-backed control movement

| Control | Prior | Supported delta | Implementation and proof evidence |
|---:|---:|---:|---|
| 017 — Stable tool identity | 0.5 | 1 | `ToolDescriptorV1`, descriptor references, activation references, and canonical hashes bind every decision-relevant field while excluding lifecycle state and secrets. [`tool-contract.ts`](../../src/kestrel/contracts/tool-contract.ts), [`tool-contract-v1.test.ts`](../../tests/unit/tool-contract-v1.test.ts) |
| 018 — Strict schema generation | 0.5 | 1 | One bounded draft-07 profile uses AJV strict mode without coercion, removal, defaults, refs, remote resolution, unknown formats, or implicit open model-facing objects. [`tool-contract.ts`](../../src/kestrel/contracts/tool-contract.ts), [`tool-registry-chaos.test.ts`](../../tests/unit/tool-registry-chaos.test.ts) |
| 019 — Protocol lifecycle | 1 | 1 | No score movement claimed. MCP discovery compiles canonical descriptors and transactional refresh retains an active generation until candidate validation and atomic activation succeed. [`McpClientManager.ts`](../../src/mcp/McpClientManager.ts), [`mcp-client-manager.test.ts`](../../tests/unit/mcp-client-manager.test.ts) |
| 020 ◆ — Pre-execution validation | 1 | 1 | No score movement claimed. Model payloads reject invalid types and unsupported fields before transformation; trusted adapters have exact identities and effective payloads are validated again. [`ToolGateway.ts`](../../src/io/ToolGateway.ts), [`UnifiedToolRegistry.ts`](../../tools/runtime/UnifiedToolRegistry.ts), [`tool-invocation-integrity.test.ts`](../../tests/unit/tool-invocation-integrity.test.ts) |
| 021 — Typed result contract | 0.5 | 1 | `ToolExecutionOutcomeV1`, `AgentToolResultV2`, and `RunToolUpdateV2` carry exact activation evidence across success, partial, failure, and cancellation, including retryability and external-effect state. [`tool-invocation.ts`](../../src/kestrel/contracts/tool-invocation.ts), [`ToolInvocationSupport.ts`](../../src/io/ToolInvocationSupport.ts) |
| 022 — Runtime filtering | 1 | 1 | No score movement claimed. Model exposure remains allowlist, capability, profile, and authorization scoped, and returned names resolve only against the exact request snapshot. [`UnifiedToolRegistry.ts`](../../tools/runtime/UnifiedToolRegistry.ts), [`tool-invocation-integrity.test.ts`](../../tests/unit/tool-invocation-integrity.test.ts) |
| 023 — Collision safety | 0.5 | 1 | Registry compilation rejects duplicate and cross-source identities; candidate refresh collision or server loss retains the previous active generation and records a typed diagnostic. [`tool-registry.ts`](../../src/kestrel/contracts/tool-registry.ts), [`tool-registry-chaos.test.ts`](../../tests/unit/tool-registry-chaos.test.ts) |
| 024 — Registry conformance suite | 0.5 | 1 | One closed source-family harness covers built-ins, embedded modules, local MCP, hosted MCP, and App/provider overlay resolution. The manifest and fixture record must move together. [`tool-registry-conformance.test.ts`](../../tests/unit/tool-registry-conformance.test.ts), [`tool-registry.ts`](../../src/kestrel/contracts/tool-registry.ts) |

The implementation supports the planned ceiling of **+2.5 points** across
these eight controls. A full reinspection is still required before incorporating
that movement into Kestrel's overall score.

## Interruption, restart, and replay evidence

The proof suites exercise the integrity boundaries in execution order:

1. The model request persists an ordered surface snapshot with exact activations.
2. The model-returned name resolves only against that snapshot.
3. Preparation persists validated effective input and the exact activation.
4. Refresh swaps generations atomically while the prepared action retains its pinned handler.
5. Approval authority changes with descriptor, scope, payload, policy, or adapter identity.
6. An interrupted dynamic call resumes the persisted action against its original generation.
7. Restart without that dynamic handler fails closed rather than substituting the current generation.
8. A recorded effect result is consumed without invoking the handler again.
9. Output normalization and terminal evidence retain the same activation.

The runtime therefore resumes the exact prepared action, retains a valid wait,
consumes a recorded result, or fails closed. It does not switch revisions by
name or repeat a consumed external effect.

## Chaos and conformance evidence

Deterministic cases cover malformed and oversized schemas, server loss during
refresh, cross-source collision, retired-handler loss, committed-effect output
rejection, and App/provider overlay divergence. The conformance manifest covers
all five supported source families. Generated tools and plugins remain outside
the supported registry rather than receiving a permissive compatibility path.

## Mutation evidence

The live planning base had 32 mutations, but later merged OCI,
execution-boundary, and Docker waves raised `main` to 50 before this PR. Those
newer proofs are retained. This wave adds ten exact live mutations:

- Input-schema validation bypass.
- Model-field stripping acceptance.
- Stale descriptor or scope acceptance.
- Cross-source collision fail-open.
- Name-based in-flight generation switching.
- Missing output contract or normalizer fail-open.
- Descriptor evidence omission.
- App/provider overlay divergence acceptance.
- Descriptor revision omitted from approval authority.
- Handler-supplied result or evidence acceptance.

The focused tool-contract mutation run killed **10/10**. The hermetic,
Docker-independent audit gate now requires **60/60 killed**; `42/42` is retained
only as the historical arithmetic in the original three-PR plan.

## Scope boundaries

- Current executable sources are built-ins, embedded or allowlisted tools, local MCP, hosted MCP, and App/provider policy overlays.
- No plugin or generated-tool framework, permissive schema fallback, or legacy execution bridge was added.
- Existing provider wire formats, recovery order, retry timing, policy semantics, and effect-idempotency ownership are unchanged.
- No heuristic ranking, fallback, keyword routing, threshold, or runtime classifier was introduced.
- V1 evidence remains readable but cannot authorize live execution; new evidence is V2 and activation-bound.
- No SQL migration or settings UI was required.

## Verification record

Observed on the PR3 branch:

- Focused contract, invocation, interruption, chaos, conformance, MCP,
  App-parity, and effect-replay suites: **53/53 passed**.
- Focused tool-contract mutation proofs: **10/10 killed**.
- Root and Web TypeScript checks: passed.
- Public-package boundary validation: passed.
- `CI=true pnpm validate`: passed in **154.3s**.
- `pnpm run validate:postgres`: passed in **52.7s**.
- `pnpm run validate:process`: passed in **362.0s**, including **16/16**
  Docker process tests and **23/23** uninstall tests; one disposable macOS
  keychain test was skipped under CI as designed.
- `pnpm run validate:audit`: passed in **127.8s** with **60/60 killed**.
- Desktop resource preparation was not separately required because no mirrored
  runtime source changed; the portable validation resource checks passed without
  producing a tracked diff.
