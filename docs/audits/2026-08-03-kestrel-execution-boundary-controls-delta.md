# Kestrel Execution-Boundary Controls Delta

## Review status

This is a focused implementation delta for the three-PR execution-boundary
adversarial-integrity wave completed from the `8279244e` planning base. It
reviews only controls 040 and 057–064 against the immutable boundary policy,
the Docker escape and exhaustion proofs, and the cross-boundary conformance,
interruption, replay, and mutation suites delivered by the wave.

This document is not a new 200-control inspection. The planned movement from
`142.5` to `146.5 / 200` remains a planning ceiling until a separate full
reinspection verifies every control at one commit. Controls 178 and 180 remain
accepted egress critical zeros and are unchanged by this work.

## Delta conclusion

Execution-boundary handling is now code-owned rather than caller-selected. One
canonical adapter set covers submitted content, provider requests, model
streams and actions, assembly changes, tool requests, tool streams and results,
and assistant output. Model-visible, streamed, persisted, and user-visible
content redacts registered sensitive representations. Executable assembly and
tool inputs quarantine them. Untrusted prompt or tool content remains data and
cannot promote itself into runtime control authority.

Every model, tool, and external-output crossing persists a secret-free typed
decision before dispatch or settlement. Interruption proofs block provider
dispatch, tool scheduling, tool-result projection, and assistant settlement
until that persistence completes. Replay evidence accepts exactly one current
decision bound to the run, session, call, policy, boundary, and digest of the
persisted transformed projection; missing, duplicated, stale, malformed, or
mismatched evidence fails closed.

The Docker proof matrix now covers privilege and namespace escape, mounts,
devices, symlink traversal, PID and concurrent-fork exhaustion, workspace and
`/tmp` byte and inode exhaustion, host-secret theft, and cleanup across success,
rejection, exhaustion, timeout, and cancellation. Hermetic command-contract
tests independently bind the non-root, read-only, capability-free,
`no-new-privileges`, network, PID, memory, and `nosuid,nodev` tmpfs controls.

## Implementation-backed control movement

| Control | Prior | Supported delta | Implementation and proof evidence |
|---:|---:|---:|---|
| 040 — Sandbox escape and exhaustion tests | 0.5 | 1 | Docker process proofs exercise the complete planned attack matrix and verify cleanup and host-canary non-disclosure; hermetic tests bind the create-command hardening contract. [`docker-sandbox.process.test.ts`](../../tests/process/docker-sandbox.process.test.ts), [`docker-sandbox-executor.test.ts`](../../tests/unit/docker-sandbox-executor.test.ts), [`DockerSandboxExecutor.ts`](../../src/code/DockerSandboxExecutor.ts) |
| 057 — Complete interception points | 0.5 | 1 | One exact adapter set matches every declared policy boundary, and the conformance harness fails if either set moves independently. [`ExecutionBoundaryPolicy.ts`](../../src/security/ExecutionBoundaryPolicy.ts), [`execution-boundary-conformance.test.ts`](../../tests/unit/execution-boundary-conformance.test.ts) |
| 058 ◆ — Default-deny high-risk actions | 1 | 1 | No score movement claimed. Tool and assembly inputs containing registered sensitive material quarantine before approval or execution, preserving the existing default-deny action policy. [`RuntimeIO.ts`](../../src/engine/RuntimeIO.ts), [`AssemblyPolicyEvaluator.ts`](../../src/orchestration/AssemblyPolicyEvaluator.ts) |
| 059 — Versioned policy | 0.5 | 1 | The immutable policy records owner, change identifier, revision chain, canonical digest, enforcement mode, and exact boundary declarations; its revision moves resolved-profile and assembly fingerprints. [`execution-boundary-policy.ts`](../../src/kestrel/contracts/execution-boundary-policy.ts), [`ExecutionBoundaryPolicy.ts`](../../src/security/ExecutionBoundaryPolicy.ts) |
| 060 — Bidirectional redaction | 0.5 | 1 | Registered credentials and typed sensitive values are removed from provider-bound requests and model/tool/error/final output, including closed deterministic encodings and cross-chunk streams. [`ExecutionBoundaryPolicy.ts`](../../src/security/ExecutionBoundaryPolicy.ts), [`RuntimeIO.ts`](../../src/engine/RuntimeIO.ts), [`assistantResponseContract.ts`](../../src/runtime/assistantResponseContract.ts) |
| 061 — Typed policy decisions | 0.5 | 1 | Strict contracts define all seven outcomes, provenance, identity, policy revision, input/output digests, sensitive references, and exact transforms; unknown fields and transforms fail closed. [`execution-boundary-policy.ts`](../../src/kestrel/contracts/execution-boundary-policy.ts) |
| 062 ◆ — No bypass path | 0.5 | 1 | User, model, assembly, tool, finalization, child, retry, recovery, batch, wait, replay, and Docker adapters traverse the same contract, with persistence-before-crossing assertions at effectful boundaries. [`execution-boundary-conformance.test.ts`](../../tests/unit/execution-boundary-conformance.test.ts), [`runtime-io-cancellation.test.ts`](../../tests/unit/runtime-io-cancellation.test.ts), [`orchestration-thread-runtime.test.ts`](../../tests/unit/orchestration-thread-runtime.test.ts) |
| 063 — Fail-closed behavior | 1 | 1 | No score movement claimed. Missing boundary declarations, stale assembly revisions, unavailable persistence, quarantined inputs, and invalid replay evidence reject without crossing. [`execution-boundary-policy.test.ts`](../../tests/unit/execution-boundary-policy.test.ts), [`runtime-assembly.test.ts`](../../tests/unit/runtime-assembly.test.ts) |
| 064 — Adversarial policy tests | 0 | 1 | A versioned typed corpus covers direct and nested injection, raw and encoded secrets, nested argument smuggling, indirection, and forged approval, tenant, assembly, provider, policy, and profile state across every applicable adapter. [`execution-boundary-adversarial-corpus.ts`](../../tests/proof/execution-boundary-adversarial-corpus.ts), [`execution-boundary-conformance.test.ts`](../../tests/unit/execution-boundary-conformance.test.ts) |

The supported delta is **+4 points** across these nine controls. A full
reinspection is still required before reporting `146.5 / 200` as Kestrel's
verified overall score or recalculating its complete critical-control result.

## Conformance, interruption, and replay evidence

The versioned corpus traverses all nine declared adapters and the Docker
execution contract. Prompt injection, indirection, and forged control-shaped
fields remain untrusted data; the implementation does not search for keywords,
score intent, rank candidates, or classify arbitrary content. Registered raw,
Base64, Base64URL, hexadecimal, percent-encoded, and JSON-escaped values are
redacted or quarantined according to the owning boundary.

Interruption tests prove the following ordering:

1. Provider requests persist their transformed decision before gateway dispatch.
2. Streamed model and tool content retain cross-chunk redaction state.
3. Tool requests persist before an effect is scheduled.
4. Tool results persist before audit, model-context, or downstream projection.
5. Assistant responses and durable waits persist before transcript settlement.
6. Restart evidence reuses the digest-bound safe projection or rejects missing, duplicate, stale, malformed, and mismatched evidence.
7. Delivered terminal turns and recorded results replay without executing the turn or consumed effect again.

## Mutation evidence

The historical 35 mutations are retained. This wave adds 15 exact live
mutations:

- Missing-policy fail-open.
- User-input, provider-request, model-action, tool-request, tool-result, and final-output interception removal.
- Assembly revision-check bypass.
- Encoded-representation derivation removal.
- Quarantine weakened to redaction.
- Decision-persistence await removal.
- Docker capability-drop, `no-new-privileges`, read-only-root, and tmpfs `nosuid,nodev` removal.

The focused execution-boundary mutation run killed **15/15**. The hermetic,
Docker-independent audit gate retains all historical proofs and requires
**50/50 killed**. Real sandbox behavior remains owned by `validate:process`.

## Scope boundaries

- Sensitive-value discovery is limited to registered credentials and explicitly typed sensitive values. Arbitrary unmarked PII discovery remains out of scope.
- Prompt-injection fixtures prove structural authority separation, not semantic keyword detection.
- Redaction and quarantine do not create authority, trigger recovery fallback, or reuse an approval grant.
- No policy exceptions, heuristic patterns, scores, rankings, thresholds, or classifiers were introduced.
- No SQL migration or settings UI was required.
- Egress posture, descriptor-relative filesystem TOCTOU, evaluator control flow, memory architecture, hierarchical budgets, and recovery-policy behavior remain unchanged.

## Verification record

Observed on the final branch:

- Focused policy, registry, streaming, orchestration, RuntimeIO, finalization, replay, conformance, and Docker-command suites: passed.
- Execution-boundary mutation proofs: **15/15 killed**.
- Root TypeScript check: passed.
- `CI=true pnpm validate`: passed in 127.2 seconds.
- `pnpm run validate:postgres`: passed in 53.4 seconds.
- `pnpm run validate:process`: the PR-owned Docker process matrix passed
  **16/16**. The aggregate gate then reached and failed the unchanged
  `origin/main` hosted-MCP descriptor fixture at
  `tests/unit/hosted-mcp-runtime.test.ts:124` (`false !== true`,
  `MCP_TOOL_DESCRIPTOR_INVALID`); this wave does not modify that fixture or
  its owning runtime surface.
- `pnpm run validate:audit`: passed in 109.3 seconds with **50/50 killed**.
- Desktop runtime resource preparation and tracked-resource parity check:
  passed with no generated diff.
