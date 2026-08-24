---
id: kestrel-agent-harness-200-point-inspection-2026-07-30
domain: reliability
status: historical
owner: kestrel-runtime
last_verified_at: 2026-07-30
---

# Kestrel Agent Harness 200-Point Inspection

## Executive conclusion

**Raw score: 132.5 / 200**

**Critical-control result: Fail**

**Readiness band: 130–159.5 — Functional harness with material production risks**

Kestrel is substantially more than an agent loop. It has a durable execution engine, versioned state, idempotent effects, recorded-result replay, structured-output enforcement, model/provider adapters, managed delegation, workspace checkpoints, observation shaping, and a broad hermetic contract suite. Nine domains pass the checklist's domain threshold.

It does not pass this production architecture inspection because five critical controls score zero:

- **033 — No host execution by default:** model-visible development-shell execution can run on the host in ordinary profiles.
- **040 — Escape testing:** there is no comprehensive adversarial sandbox-escape suite covering the checklist's required attack classes.
- **178 — Default-deny egress:** network denial exists for Docker code execution, but is not the system-wide default for host tools, MCP processes, browsers, package managers, or hosted workspace processes.
- **180 — Egress bypass resistance:** redirects, rebinding, alternate resolvers, proxies, IPv6, encoded IPs, and subprocess bypasses are not governed and tested as one boundary.
- **194 — Explicit escalation ladder:** recovery mechanisms exist, but there is no configured, audited order from retry through alternate configuration/model/tool and deterministic workflow to human review or typed failure.

The raw score is held near the bottom of the functional-harness band by concrete partial controls: hosted workspace path authorization is lexical rather than symlink-aware; tool validation can sanitize unsupported fields instead of rejecting them; approvals and policies do not share one complete typed contract; budget accounting is not hierarchical across every requested scope; hosted semantic knowledge is not a unified runtime memory interface; and eval-driven control flow remains external.

## Audit record

| Field | Value |
|---|---|
| Harness / system | Kestrel |
| Repository / deployment | `LumiCorp/kestrel`; local repository inspection |
| Version / commit | `0.7.0`; `5be3a117b58eb6f9da57464ccc2ef3cba7fad3a1` |
| Environment | macOS arm64 worktree; Node `22.23.1`; pnpm `9.12.2`; `CI=true` |
| Audit scope | Runtime, contracts, tools, persistence, hosted control plane, workspace runtime, public packages, tests, and operational documentation |
| Auditor | OpenAI Codex |
| Audit date | 2026-07-30 |
| Evidence repository | This repository at the commit above |
| Known exclusions | No live hosted-deployment inspection; no external provider calls; no cloud IAM/network-policy inspection; no destructive sandbox penetration. Exclusions are scored as zero or partial, never N/A. |

## Method

Each of the supplied 200 controls was scored independently under the supplied rules:

- **1** means implementation plus relevant verification evidence.
- **0.5** means incomplete, optional, integration-dependent, or insufficiently tested.
- **0** means absent, contradicted, bypassable, or not inspectable.
- Documentation alone never earns more than 0.5.
- A domain passes only at 6/8 or higher and with no zero-valued critical control.

Repository search located candidate evidence. The implementation, its owning boundary, and relevant tests were then inspected. Broad neighboring capabilities did not substitute for a missing control. Current validation results are recorded separately and do not upgrade a control without control-specific evidence.

## Domain scorecard

| # | Domain | Score | Finding | Primary evidence |
|---:|---|---:|---|---|
| 1 | Loop Orchestration Engine | 7 / 8 | Pass | E01, E02 |
| 2 | Context Window Compaction & Sliding | 7 / 8 | Pass | E03 |
| 3 | Dynamic Tool Schema Registry | 5 / 8 | Fail | E04 |
| 4 | Durable State & Session Checkpointing | 6.5 / 8 | Pass | E05 |
| 5 | Sandboxed Runtime Isolation | 3.5 / 8 | Fail; critical zeros | E06 |
| 6 | Two-Tier Memory Storage Interface | 5.5 / 8 | Fail | E07 |
| 7 | Human-in-the-Loop Interception | 5.5 / 8 | Fail | E08 |
| 8 | Inline Policy Guardrails & Filters | 4.5 / 8 | Fail | E09 |
| 9 | Token & Compute Rate Limiting | 5 / 8 | Fail | E10 |
| 10 | Automatic Exception Recovery & Retry Routing | 6 / 8 | Pass | E11 |
| 11 | Multi-Agent Orchestration & Handoff Protocols | 6 / 8 | Pass | E12 |
| 12 | Full-Stack Telemetry & Distributed Tracing | 5.5 / 8 | Fail | E13 |
| 13 | Dynamic Provider & Model Abstraction | 5.5 / 8 | Fail | E14 |
| 14 | Structured Output Validation & Re-Prompting | 7 / 8 | Pass | E15 |
| 15 | Ephemeral Credential Brokerage | 6 / 8 | Pass | E16 |
| 16 | Event-Driven Asynchronous Ingestion | 4.5 / 8 | Fail | E17 |
| 17 | Workspace File System Virtualization | 5.5 / 8 | Fail | E18 |
| 18 | Observation Standardizer | 6 / 8 | Pass | E19 |
| 19 | Deterministic Session Replay Engine | 5.5 / 8 | Fail | E20 |
| 20 | Evals-in-the-Loop Integration | 2 / 8 | Fail | E21 |
| 21 | Context Degradation & De-Noising Filters | 6 / 8 | Pass | E22 |
| 22 | Dynamic Tool Discovery | 5 / 8 | Fail | E23 |
| 23 | Fine-Grained Network Egress Control | 2 / 8 | Fail; critical zeros | E24 |
| 24 | Concurrency & Parallel Sub-Task Forking | 5.5 / 8 | Fail | E12, E25 |
| 25 | Graceful Degradation & Fallback Strategy Execution | 5 / 8 | Fail; critical zero | E11, E26 |
|  | **Total** | **132.5 / 200** | **Critical: Fail** | |

## Evidence register

| ID | Evidence |
|---|---|
| E01 | [`src/engine/ExecutionEngine.ts`](../../src/engine/ExecutionEngine.ts), [`src/engine/TransitionValidator.ts`](../../src/engine/TransitionValidator.ts), [`src/kestrel/contracts/execution.ts`](../../src/kestrel/contracts/execution.ts), [`src/kestrel/contracts/events.ts`](../../src/kestrel/contracts/events.ts), [`tests/unit/execution-engine-start-run.test.ts`](../../tests/unit/execution-engine-start-run.test.ts) |
| E02 | [`src/engine/LoopGuardCoordinator.ts`](../../src/engine/LoopGuardCoordinator.ts), [`src/engine/RunLifecycleController.ts`](../../src/engine/RunLifecycleController.ts), [`tests/unit/execution-loop-guard.test.ts`](../../tests/unit/execution-loop-guard.test.ts), [`tests/unit/retrieval-loop-guard.test.ts`](../../tests/unit/retrieval-loop-guard.test.ts) |
| E03 | [`src/economics/HarnessEconomicsController.ts`](../../src/economics/HarnessEconomicsController.ts), [`src/orchestration/ContextPolicyManager.ts`](../../src/orchestration/ContextPolicyManager.ts), [`src/runtime/modelTranscript.ts`](../../src/runtime/modelTranscript.ts), [`tests/unit/model-transcript.test.ts`](../../tests/unit/model-transcript.test.ts), [`tests/unit/kestrel-agent-context-builder.test.ts`](../../tests/unit/kestrel-agent-context-builder.test.ts) |
| E04 | [`tools/runtime/UnifiedToolRegistry.ts`](../../tools/runtime/UnifiedToolRegistry.ts), [`tools/runtime/builtInToolInputContracts.ts`](../../tools/runtime/builtInToolInputContracts.ts), [`src/mcp/McpClientManager.ts`](../../src/mcp/McpClientManager.ts), [`tests/unit/unified-tool-registry.test.ts`](../../tests/unit/unified-tool-registry.test.ts) |
| E05 | [`src/engine/StepCommitPipeline.ts`](../../src/engine/StepCommitPipeline.ts), [`src/store/SessionStore.ts`](../../src/store/SessionStore.ts), [`src/store/PostgresSessionStore.ts`](../../src/store/PostgresSessionStore.ts), [`src/effects/EffectRunner.ts`](../../src/effects/EffectRunner.ts), [`tests/unit/effect-runner.test.ts`](../../tests/unit/effect-runner.test.ts), [`tests/unit/execution-engine-progress-persistence.test.ts`](../../tests/unit/execution-engine-progress-persistence.test.ts) |
| E06 | [`src/code/CodeExecutionService.ts`](../../src/code/CodeExecutionService.ts), [`src/code/DockerSandboxExecutor.ts`](../../src/code/DockerSandboxExecutor.ts), [`tools/devshell/execCommand.ts`](../../tools/devshell/execCommand.ts), [`tests/unit/code-execute-tool.test.ts`](../../tests/unit/code-execute-tool.test.ts), [`tests/unit/code-policy-engine.test.ts`](../../tests/unit/code-policy-engine.test.ts) |
| E07 | [`src/runtime/ProviderReasoningVault.ts`](../../src/runtime/ProviderReasoningVault.ts), [`src/runtime/RuntimeWorkspaceScratchpad.ts`](../../src/runtime/RuntimeWorkspaceScratchpad.ts), [`apps/web/lib/knowledge/documents/access.ts`](../../apps/web/lib/knowledge/documents/access.ts), [`apps/web/lib/knowledge/documents/retrieval.ts`](../../apps/web/lib/knowledge/documents/retrieval.ts), [`apps/web/lib/knowledge/documents/runtime.ts`](../../apps/web/lib/knowledge/documents/runtime.ts), [`apps/web/lib/knowledge/documents/retrieval.test.ts`](../../apps/web/lib/knowledge/documents/retrieval.test.ts) |
| E08 | [`src/orchestration/InteractionManager.ts`](../../src/orchestration/InteractionManager.ts), [`src/orchestration/ThreadRuntime.ts`](../../src/orchestration/ThreadRuntime.ts), [`src/orchestration/contracts.ts`](../../src/orchestration/contracts.ts), [`apps/web/lib/apps/app-operation-approvals.ts`](../../apps/web/lib/apps/app-operation-approvals.ts), [`tests/unit/orchestration-thread-runtime.test.ts`](../../tests/unit/orchestration-thread-runtime.test.ts) |
| E09 | [`agents/reference-react/src/policy/DecisionPolicy.ts`](../../agents/reference-react/src/policy/DecisionPolicy.ts), [`src/orchestration/AssemblyPolicyEvaluator.ts`](../../src/orchestration/AssemblyPolicyEvaluator.ts), [`src/diagnostics/redaction.ts`](../../src/diagnostics/redaction.ts), [`apps/web/lib/agent/kestrel-capabilities.ts`](../../apps/web/lib/agent/kestrel-capabilities.ts) |
| E10 | [`src/economics/contracts.ts`](../../src/economics/contracts.ts), [`src/economics/HarnessEconomicsController.ts`](../../src/economics/HarnessEconomicsController.ts), [`src/engine/ToolJobQueue.ts`](../../src/engine/ToolJobQueue.ts), [`tests/unit/harness-economics-controller.test.ts`](../../tests/unit/harness-economics-controller.test.ts) |
| E11 | [`src/io/ModelGateway.ts`](../../src/io/ModelGateway.ts), [`src/runtime/RuntimeFailure.ts`](../../src/runtime/RuntimeFailure.ts), [`src/engine/Guardrails.ts`](../../src/engine/Guardrails.ts), [`tests/unit/model-gateway-retry.test.ts`](../../tests/unit/model-gateway-retry.test.ts) |
| E12 | [`src/orchestration/DelegationSupervisor.ts`](../../src/orchestration/DelegationSupervisor.ts), [`src/orchestration/Supervision.ts`](../../src/orchestration/Supervision.ts), [`src/workspace/ManagedTaskWorktreeService.ts`](../../src/workspace/ManagedTaskWorktreeService.ts), [`tests/unit/runtime-delegation.test.ts`](../../tests/unit/runtime-delegation.test.ts) |
| E13 | [`packages/observability/src/index.ts`](../../packages/observability/src/index.ts), [`packages/observability/src/tracer.ts`](../../packages/observability/src/tracer.ts), [`src/events/RuntimeEventProjections.ts`](../../src/events/RuntimeEventProjections.ts), [`src/diagnostics/supportBundle.ts`](../../src/diagnostics/supportBundle.ts), [`packages/observability/tests/tracer.test.ts`](../../packages/observability/tests/tracer.test.ts) |
| E14 | [`src/kestrel/contracts/model-io.ts`](../../src/kestrel/contracts/model-io.ts), [`src/io/ModelGateway.ts`](../../src/io/ModelGateway.ts), [`src/profile/modelCatalog.ts`](../../src/profile/modelCatalog.ts), [`src/profile/runtimeProfile.ts`](../../src/profile/runtimeProfile.ts), [`apps/web/lib/ai/gateways.ts`](../../apps/web/lib/ai/gateways.ts) |
| E15 | [`agents/reference-react/src/policy/DecisionPolicy.ts`](../../agents/reference-react/src/policy/DecisionPolicy.ts), [`agents/reference-react/src/steps/deliberator.ts`](../../agents/reference-react/src/steps/deliberator.ts), [`src/runtime/assistantResponseContract.ts`](../../src/runtime/assistantResponseContract.ts), [`tests/unit/agent-loop-step.test.ts`](../../tests/unit/agent-loop-step.test.ts) |
| E16 | [`apps/web/lib/ai/gateway-credential-lease-contract.ts`](../../apps/web/lib/ai/gateway-credential-lease-contract.ts), [`apps/web/lib/ai/gateway-credential-lease.ts`](../../apps/web/lib/ai/gateway-credential-lease.ts), [`apps/web/app/api/kestrel/gateway-credentials/lease/route.ts`](../../apps/web/app/api/kestrel/gateway-credentials/lease/route.ts), [`tests/unit/gateway-credential-broker.test.ts`](../../tests/unit/gateway-credential-broker.test.ts) |
| E17 | [`apps/web/lib/turns/contracts.ts`](../../apps/web/lib/turns/contracts.ts), [`apps/web/lib/turns/store.ts`](../../apps/web/lib/turns/store.ts), [`apps/web/lib/turns/queue.ts`](../../apps/web/lib/turns/queue.ts), [`apps/web/scripts/turn-worker.ts`](../../apps/web/scripts/turn-worker.ts), [`tests/unit/kcron-service.test.ts`](../../tests/unit/kcron-service.test.ts) |
| E18 | [`apps/workspace-runtime/src/security.ts`](../../apps/workspace-runtime/src/security.ts), [`tools/filesystem/shared.ts`](../../tools/filesystem/shared.ts), [`src/workspaceCheckpoints/service.ts`](../../src/workspaceCheckpoints/service.ts), [`src/workspace/ManagedTaskWorktreeService.ts`](../../src/workspace/ManagedTaskWorktreeService.ts) |
| E19 | [`tools/toolResult.ts`](../../tools/toolResult.ts), [`agents/reference-react/src/steps/acter/resultShaping.ts`](../../agents/reference-react/src/steps/acter/resultShaping.ts), [`src/normalize/OutputNormalizer.ts`](../../src/normalize/OutputNormalizer.ts), [`tests/unit/tool-result.test.ts`](../../tests/unit/tool-result.test.ts) |
| E20 | [`src/replay/RunReplayService.ts`](../../src/replay/RunReplayService.ts), [`src/replay/RuntimeReplayBundle.ts`](../../src/replay/RuntimeReplayBundle.ts), [`tests/unit/run-replay-service.test.ts`](../../tests/unit/run-replay-service.test.ts), [`tests/unit/governance-replay-baseline.test.ts`](../../tests/unit/governance-replay-baseline.test.ts) |
| E21 | [`evals/`](../../evals), [`scripts/validate-ruhroh-evals.ts`](../../scripts/validate-ruhroh-evals.ts), [`tests/unit/ruhroh-evals.test.ts`](../../tests/unit/ruhroh-evals.test.ts), [`RELIABILITY.md`](../../RELIABILITY.md) |
| E22 | [`src/runtime/readOnlyResultDuplicates.ts`](../../src/runtime/readOnlyResultDuplicates.ts), [`src/runtime/modelTranscript.ts`](../../src/runtime/modelTranscript.ts), [`src/runtime/evidenceQuality.ts`](../../src/runtime/evidenceQuality.ts), [`tests/unit/read-only-result-duplicates.test.ts`](../../tests/unit/read-only-result-duplicates.test.ts) |
| E23 | [`src/runtime/agent-context/assembleContext.ts`](../../src/runtime/agent-context/assembleContext.ts), [`src/orchestration/RuntimeComposer.ts`](../../src/orchestration/RuntimeComposer.ts), [`src/mcp/McpClientManager.ts`](../../src/mcp/McpClientManager.ts), [`tests/unit/runtime-assembly.test.ts`](../../tests/unit/runtime-assembly.test.ts) |
| E24 | [`src/code/DockerSandboxExecutor.ts`](../../src/code/DockerSandboxExecutor.ts), [`tools/devshell/execCommand.ts`](../../tools/devshell/execCommand.ts), [`src/mcp/McpClientManager.ts`](../../src/mcp/McpClientManager.ts), [`packages/mcp-security/src/index.ts`](../../packages/mcp-security/src/index.ts), [`apps/web/lib/mcp/contracts.test.ts`](../../apps/web/lib/mcp/contracts.test.ts), [`SECURITY.md`](../../SECURITY.md) |
| E25 | [`src/engine/ToolJobQueue.ts`](../../src/engine/ToolJobQueue.ts), [`src/orchestration/DelegationSupervisor.ts`](../../src/orchestration/DelegationSupervisor.ts), [`tests/unit/tool-job-queue.test.ts`](../../tests/unit/tool-job-queue.test.ts) |
| E26 | [`src/orchestration/AssemblyCompatibility.ts`](../../src/orchestration/AssemblyCompatibility.ts), [`src/engine/RunLifecycleController.ts`](../../src/engine/RunLifecycleController.ts), [`src/io/ModelGateway.ts`](../../src/io/ModelGateway.ts), [`tests/unit/runtime-assembly.test.ts`](../../tests/unit/runtime-assembly.test.ts) |
| V01 | Current `CI=true pnpm validate` result recorded in [Validation](#validation) |

## Detailed control ledger

### 1. Loop Orchestration Engine — 7 / 8 — Pass

| ID | Control | Score | Evidence-based finding |
|---:|---|---:|---|
| 001 | Explicit state machine | 1 | Typed runtime state and transition results are owned by the execution engine and validator. E01 |
| 002 | Single transition owner | 1 | Engine and commit pipeline own advancement; UI/provider/tool layers submit inputs or effects. E01, E05 |
| 003 | Validated dispatch | 1 | Tool calls pass authorization and schema validation before handler dispatch. E04 |
| 004 | Complete event lifecycle | 1 | Stable contracts cover model, tool, observation, wait, retry, and terminal events. E01 |
| 005 ◆ | Typed termination | 0.5 | Success, failure, cancellation, waits, budgets, and loop failures are typed, but budget/no-progress/human-stop are not all distinct terminal-reason variants. E01, E02 |
| 006 | Steering and cancellation | 1 | Steering, wait/resume, and cancellation enter through explicit runtime control surfaces and safe points. E01, E08 |
| 007 ◆ | Runaway-loop protection | 1 | Step/model-call/visit/no-progress guards terminate deterministically and are tested. E02 |
| 008 | Loop conformance tests | 0.5 | Malformed, missing, and multi-step actions are covered; the exact full matrix including concurrently returned tool calls is not. E01, E15 |

### 2. Context Window Compaction & Sliding — 7 / 8 — Pass

| ID | Control | Score | Evidence-based finding |
|---:|---|---:|---|
| 009 | Model-aware thresholds | 1 | Effective context window subtracts output, safety, tool, and overhead reserves. E03 |
| 010 | Protected invariants | 1 | System, active task, correction, active wait, and protected transcript sections survive compaction. E03 |
| 011 | Structured summary | 1 | Context-policy artifacts persist structured progress, decisions, failures, artifacts, and next work. E03 |
| 012 | Recent-context budget | 1 | Model-aware token budgets retain a bounded recent transcript tail. E03 |
| 013 | Raw evidence retained | 1 | Pruned results remain durable through artifact/raw-output references. E03, E19 |
| 014 | Repeatable compaction | 1 | Repeated-cycle tests cover non-resurrection, non-duplication, ordering, and tool-pair validity. E03 |
| 015 | Compaction economics | 0.5 | Token proposal/effective/retained counts are recorded; per-compaction latency and cost are incomplete. E03 |
| 016 | Long-run regression tests | 0.5 | Repeated compaction cycles are tested, but representative end-to-end task completion after multiple cycles is not a broad regression suite. E03 |

### 3. Dynamic Tool Schema Registry — 5 / 8 — Fail

| ID | Control | Score | Evidence-based finding |
|---:|---|---:|---|
| 017 | Stable tool identity | 0.5 | Names, providers, capabilities, and lifecycle exist; uniform version/provenance fields do not. E04 |
| 018 | Strict schema generation | 0.5 | Registered JSON schemas retain constraints, but AJV is non-strict and compatibility shaping can widen behavior. E04 |
| 019 | Protocol lifecycle | 1 | MCP lifecycle covers initialization, capability status, refresh, failure, and shutdown. E04 |
| 020 ◆ | Pre-execution validation | 0.5 | Missing/enums/malformed values fail before execution, but some unsupported fields are stripped rather than rejected. E04 |
| 021 | Typed result contract | 0.5 | Normalized success/error/cancellation data exists, but partial/retryable variants are not uniform across every tool family. E19 |
| 022 | Runtime filtering | 1 | Agent profile, phase, allowlist, capability, and authorization filters constrain model-visible tools. E04, E23 |
| 023 | Collision safety | 0.5 | Duplicate and incompatible registrations diagnose/fail, but hot-reload failure behavior is not comprehensively verified. E04 |
| 024 | Registry conformance suite | 0.5 | Built-in and MCP contracts are tested, but plugin/generated tools do not all run one shared conformance matrix. E04 |

### 4. Durable State & Session Checkpointing — 6.5 / 8 — Pass

| ID | Control | Score | Evidence-based finding |
|---:|---|---:|---|
| 025 | Transition checkpoints | 1 | Step commits durably write state/events/effects before externally visible progress. E05 |
| 026 | Atomic versioning | 1 | Session writes use expected versions and transactional stores. E05 |
| 027 ◆ | Side-effect idempotency | 1 | Durable effects carry deterministic run/step/effect idempotency keys and unique receipts. E05 |
| 028 | Pluggable durable backend | 1 | In-memory, PGlite, and Postgres stores share orchestration semantics. E05 |
| 029 ◆ | Crash recovery | 0.5 | Pending effects and durable runs recover, but fault injection does not cover every listed crash phase. E05 |
| 030 | Schema migration | 1 | Versioned database and persisted-contract migration/incompatibility behavior is explicit and tested. E05 |
| 031 | Fork provenance | 0.5 | Resume/retry/replay/delegation lineage exists; one complete live-fork checkpoint contract does not. E12, E20 |
| 032 | Storage governance | 0.5 | Retention, deletion, tenant scope, and hosted encryption/backup exist across surfaces, not as one verified state-governance contract. E05 |

### 5. Sandboxed Runtime Isolation — 3.5 / 8 — Fail

| ID | Control | Score | Evidence-based finding |
|---:|---|---:|---|
| 033 ◆ | No host execution by default | 0 | Docker-backed `code.execute` is gated, but ordinary agent profiles can expose host development-shell execution. E06 |
| 034 | Documented isolation boundary | 0.5 | Trust boundaries are documented, but the process/filesystem/user/kernel/network/credential/host-service matrix is incomplete. E06 |
| 035 ◆ | Resource quotas | 0.5 | Docker enforces memory, CPU shares, wall time, and output limits; process-count and full disk quotas are absent. E06 |
| 036 | Mount policy | 0.5 | Workspace mounts and traversal checks exist; modes and symlink/device handling are not complete across backends. E06, E18 |
| 037 | Network capability hook | 0.5 | Docker accepts `none` or `bridge`; it does not accept fine-grained enforceable policy. E06, E24 |
| 038 | Scoped secret injection | 0.5 | Hosted child environments strip sensitive variables, but there is no universal sandbox secret channel contract. E16 |
| 039 | Snapshot and cleanup | 1 | Docker teardown plus workspace checkpoint/cleanup paths are deterministic and tested. E06, E18 |
| 040 ◆ | Escape testing | 0 | No suite covers privilege/namespace escape, fork bombs, disk fill, symlink attacks, and secret theft as required. E06 |

### 6. Two-Tier Memory Storage Interface — 5.5 / 8 — Fail

| ID | Control | Score | Evidence-based finding |
|---:|---|---:|---|
| 041 | Explicit memory tiers | 1 | Thread history, workspace scratchpad, hosted semantic knowledge, provider reasoning, and artifacts are distinct namespaces. E07 |
| 042 | Lifecycle ownership | 0.5 | Reasoning/artifact lifecycles are explicit, but not every requested memory tier has a complete owner/retention contract. E07 |
| 043 | Pluggable typed interface | 0.5 | Hosted knowledge has typed embedding/retrieval dependencies and lexical fallback, but no runtime-wide memory backend contract. E07 |
| 044 | Authorization before retrieval | 1 | Knowledge access resolves organization and project membership before document retrieval and search. E07 |
| 045 | Provenance metadata | 0.5 | Timestamps, source, scope, and some supersession exist, but confidence/creator/history are incomplete. E07 |
| 046 | Controlled writes | 1 | Knowledge writes pass validated ingestion and explicit promotion paths; model observations do not automatically become durable knowledge. E07 |
| 047 | Deletion and expiry | 0.5 | Document deletion removes storage and the document/chunk graph, and reasoning has expiry; TTL/legal-correction propagation is incomplete. E07 |
| 048 | Retrieval evaluation | 0.5 | Tests cover semantic relevance, provenance mismatch, grouping, and lexical fallback; contamination, cross-tenant leakage, and downstream impact are not measured together. E07 |

### 7. Human-in-the-Loop Interception — 5.5 / 8 — Fail

| ID | Control | Score | Evidence-based finding |
|---:|---|---:|---|
| 049 | Typed approval request | 0.5 | Requests identify action/prompt/requester and hosted payload hash/expiry; arguments/risk/effect are not uniformly typed. E08 |
| 050 ◆ | Persist-before-pause | 1 | Interaction request and resumable waiting state are durably recorded before the operator channel resolves them. E08 |
| 051 | Idempotent resume token | 1 | Request status, payload hashes, grants, and unique hosted operation IDs prevent duplicate protected execution. E08 |
| 052 | Complete decision set | 0.5 | Approve/deny/cancel/defer/supersede exist across surfaces; edit and timeout are not one uniform semantic set. E08 |
| 053 | Synchronous and asynchronous channels | 1 | CLI/Desktop/Web paths can resume durable waits across process lifetimes. E08 |
| 054 ◆ | Authenticated approver | 0.5 | Hosted approvals authenticate and record identity; local grants accept a caller-provided issuer string. E08 |
| 055 | Stale-decision protection | 0.5 | Hosted payload hashes/expiry protect arguments, but credential/policy/state invalidation is not uniform. E08 |
| 056 | Interruption recovery tests | 0.5 | Restart, duplicates, and cancellation are covered; concurrent approvers plus every timeout race are not. E08 |

### 8. Inline Policy Guardrails & Filters — 4.5 / 8 — Fail

| ID | Control | Score | Evidence-based finding |
|---:|---|---:|---|
| 057 | Complete interception points | 0.5 | Tool/action/finalization policies exist; user/context/result boundaries do not all run one policy engine. E09 |
| 058 ◆ | Default-deny high-risk actions | 1 | Capability grants and approval packs default protected environment actions to deny/approval. E09 |
| 059 | Versioned policy | 0.5 | Profiles and capability configs are versioned; owners/exemptions/rollout/change history are not unified. E09 |
| 060 | Bidirectional redaction | 0.5 | Diagnostic secret redaction is strong; provider-bound and externally emitted PII/secret filtering is incomplete. E09 |
| 061 | Typed policy decisions | 0.5 | Allow/deny/approval are typed; redact/modify/quarantine/escalate are not one shared result contract. E09 |
| 062 ◆ | No bypass path | 0.5 | Central model/tool paths enforce policy, but direct adapters, internal operations, and all subagent/retry paths lack a no-bypass proof. E09 |
| 063 | Fail-closed behavior | 1 | Protected actions deny on missing/malformed authorization and capability state. E09 |
| 064 | Adversarial policy tests | 0 | No comprehensive injection/smuggling/encoded-secret/indirection/confusion suite. E09 |

### 9. Token & Compute Rate Limiting — 5 / 8 — Fail

| ID | Control | Score | Evidence-based finding |
|---:|---|---:|---|
| 065 | Hierarchical budgets | 0.5 | Run/profile/child/tool scopes exist; tenant/model/sandbox/evaluator hierarchy is incomplete. E10, E12 |
| 066 | Accurate usage accounting | 0.5 | Input/output/cache/reasoning usage is normalized; embeddings/tools/sandboxes/evaluators are not consistently metered. E10, E14 |
| 067 ◆ | Hard ceilings | 0.5 | Steps, model calls/tokens, wall time, and concurrency are enforced; cost and tool-spend ceilings are incomplete. E10 |
| 068 | Pre-flight reservation | 1 | Context and model output reservations happen before calls; expensive tool coverage is narrower. E10 |
| 069 ◆ | Child-budget inheritance | 0.5 | Child turns/runtime/depth are bounded, but aggregate parent token/cost reservation is absent. E12 |
| 070 | Soft thresholds | 1 | Economics pressure and continuation/wait paths trigger before hard exhaustion. E10 |
| 071 | Cost attribution | 0.5 | Run/model/retry attribution exists; tenant/feature/tool/outcome coverage is incomplete. E10 |
| 072 | Budget edge-case tests | 0.5 | Cache, stream, retries, partial failures, and limits are covered; shared budgets and price changes are incomplete. E10 |

### 10. Automatic Exception Recovery & Retry Routing — 6 / 8 — Pass

| ID | Control | Score | Evidence-based finding |
|---:|---|---:|---|
| 073 | Failure taxonomy | 1 | Stable codes distinguish provider, transport, validation, tool, policy, budget, cancellation, and runtime failures. E11 |
| 074 | Layer-specific recovery | 0.5 | Transport retry and argument repair are separate; alternate tool/model/plan routes are not a complete policy. E11 |
| 075 | Bounded backoff | 1 | Retry caps, exponential backoff, jitter, and Retry-After handling are implemented and tested. E11 |
| 076 ◆ | Retry idempotency | 0.5 | Durable effects have receipts, but every retryable tool path is not proven side-effect safe. E05, E11 |
| 077 | Safe error observations | 1 | Model-visible errors are typed, bounded, redacted, and actionable. E11, E19 |
| 078 | Durable retry state | 0.5 | Queue/turn retries persist attempts, but model-gateway retry state does not survive arbitrary process death. E11, E17 |
| 079 | Escalation after exhaustion | 1 | Exhaustion yields typed failure, continuation/human wait, or defined local fallback. E11, E26 |
| 080 | Recovery tests | 0.5 | 429/5xx/timeouts/malformed output/tool failure are tested; the full partial-commit fault matrix is not. E11 |

### 11. Multi-Agent Orchestration & Handoff Protocols — 6 / 8 — Pass

| ID | Control | Score | Evidence-based finding |
|---:|---|---:|---|
| 081 | Typed handoff envelope | 0.5 | Objective/profile/model/result/budget/policy are typed; acceptance criteria and deadline are not uniformly first-class. E12 |
| 082 | Ownership model | 1 | Parent, child, supervisor, and operator responsibilities are explicit. E12 |
| 083 | Context minimization | 0.5 | Children receive a compact goal/profile, but minimum-context enforcement is not independently measured. E12 |
| 084 | Shared-state conflict control | 1 | Managed worktrees, leases, checkpoints, and fan-in conflict detection control concurrent writes. E12 |
| 085 | Inherited constraints | 1 | Depth, tools, capability packs, workspace, approval, and child limits cannot be widened by the child. E12 |
| 086 | Cancellation propagation | 0.5 | Parent signals cancel child dialogs and many tools, but not every sandbox/process boundary. E12, E25 |
| 087 | Join and completion semantics | 1 | Partial/failed/superseded fan-in states and operator checkpoints are explicit. E12 |
| 088 | Topology tests | 0.5 | Hierarchy/depth/supervision/fan-in are tested; peer cycles and orphan cases are incomplete. E12 |

### 12. Full-Stack Telemetry & Distributed Tracing — 5.5 / 8 — Fail

| ID | Control | Score | Evidence-based finding |
|---:|---|---:|---|
| 089 | End-to-end trace context | 0.5 | SDK runs correlate events under a trace, but not every internal sandbox/subagent/approval span. E13 |
| 090 | Required span attributes | 0.5 | IDs/status/latency exist; the complete model/usage/tool/retry/termination attribute set is not mandatory. E13 |
| 091 | Immutable audit ledger | 1 | Durable events/effects/approvals persist independently from exported traces. E05, E08, E13 |
| 092 ◆ | Safe telemetry defaults | 1 | Trace defaults record metadata rather than prompt/tool payload bodies; diagnostic redaction is tested. E13 |
| 093 | Structured failure data | 0.5 | Runtime failures include codes/retryability/user-safe text; causal responsible-layer chains are incomplete in spans. E11, E13 |
| 094 | Open export contract | 1 | Observability exports through OpenTelemetry. E13 |
| 095 | Replay correlation | 0.5 | Run/event IDs correlate replay, but checkpoint/workspace/fork IDs are not universal span fields. E13, E20 |
| 096 | Operational signals | 0.5 | Usage/latency/result signals exist; queue, denial, verified outcome, and sandbox alert coverage is incomplete. E13 |

### 13. Dynamic Provider & Model Abstraction — 5.5 / 8 — Fail

| ID | Control | Score | Evidence-based finding |
|---:|---|---:|---|
| 097 | Stable internal interface | 1 | One versioned model I/O contract sits above provider request formats. E14 |
| 098 | Capability negotiation | 0.5 | Tools/schema/stream/reasoning/context are modeled; multimodal/cache/residency capability negotiation is incomplete. E14 |
| 099 | Normalized semantics | 1 | Usage, stop reasons, tool calls, reasoning, errors, and streams map to internal types. E14 |
| 100 | Explicit routing policy | 0.5 | Profile compatibility and provider/model selection are explicit; quality/latency/cost/availability/residency routing is incomplete. E14 |
| 101 | Pinned fallback behavior | 0 | No deterministic, change-controlled fallback order across models/providers. E14, E26 |
| 102 | Provider-specific controls | 1 | Endpoints, auth, timeouts, headers, and provider options remain configurable. E14 |
| 103 | Provider conformance tests | 0.5 | Adapters are tested, but not all run the exact same complete conformance matrix. E14 |
| 104 | No silent downgrade | 1 | Assembly compatibility rejects or visibly records capability loss rather than silently dropping requirements. E26 |

### 14. Structured Output Validation & Re-Prompting — 7 / 8 — Pass

| ID | Control | Score | Evidence-based finding |
|---:|---|---:|---|
| 105 | Strict output schema | 1 | Intermediate actions and schema-constrained finals use explicit contracts. E15 |
| 106 ◆ | Validate before commit | 1 | Invalid model actions cannot commit state or dispatch tools. E01, E15 |
| 107 | Bounded repair | 1 | Validation repair uses stable attempt and economics limits. E15 |
| 108 | Preserved diagnostics | 1 | Invalid output, validation errors, repair context, and outcome remain in the trajectory. E15 |
| 109 | Compatibility policy | 0.5 | Unknown/missing fields are explicit in core contracts; version/migration behavior varies by provider schema path. E15 |
| 110 | Streaming safety | 1 | Partial structured streams are assembled and validated before commitment. E14, E15 |
| 111 | Safe terminal fallback | 1 | Exhausted repair produces a typed terminal failure. E15 |
| 112 | Adversarial schema tests | 0.5 | Truncation/extra/malformed/large outputs are covered; duplicate keys, invalid Unicode, and schema injection are incomplete. E15 |

### 15. Ephemeral Credential Brokerage — 6 / 8 — Pass

| ID | Control | Score | Evidence-based finding |
|---:|---|---:|---|
| 113 ◆ | Protected broker boundary | 1 | Credential issuance is server-side behind authenticated typed routes/clients. E16 |
| 114 | Short-lived issuance | 1 | Provider credentials are exchanged just in time with bounded leases. E16 |
| 115 | Least-privilege scope | 0.5 | Organization/environment/provider/model scope exists; tool/resource/action/run scoping is incomplete. E16 |
| 116 ◆ | No model exposure | 1 | Credentials remain server-side and are excluded from prompts, observations, and normal logs by contract and tests. E09, E16 |
| 117 | Lifecycle control | 0.5 | Expiry/cache refresh and rotation paths exist; revocation/cleanup audit is incomplete. E16 |
| 118 | Workload identity | 0.5 | Organization/environment/run context is retained, but agent/tool/policy/approver identity is not mandatory for every issuance. E16 |
| 119 | No broad fallback | 1 | Broker failure fails closed rather than selecting a broader long-lived credential. E16 |
| 120 | Credential isolation tests | 0.5 | Expiry/rotation/scope/log leakage are tested; replay/subagent/sandbox-escape coverage is incomplete. E16 |

### 16. Event-Driven Asynchronous Ingestion — 4.5 / 8 — Fail

| ID | Control | Score | Evidence-based finding |
|---:|---|---:|---|
| 121 | Normalized event envelope | 0.5 | Durable user turns and schedules are typed, but webhook/queue/system events do not share one ingress schema. E17 |
| 122 | Authenticated ingress | 0.5 | Internal routes and environment tickets authenticate scope; signature/replay-window/payload-limit handling is not uniform. E17, E18 |
| 123 ◆ | Durable-before-ack | 0.5 | Durable turn submission persists before queue processing, but the guarantee is not proven for every ingress family. E17 |
| 124 | Idempotency and ordering | 1 | Durable turn IDs, queue ordinals, uniqueness, and recovery produce deterministic duplicate/order behavior. E17 |
| 125 | Deterministic run correlation | 0.5 | Turn APIs explicitly create/resume/cancel, but a universal ingress correlation policy is absent. E17 |
| 126 | Retry and dead-letter | 0.5 | Bounded queue retries and recovery exist; a visible universal dead-letter/quarantine path does not. E17 |
| 127 | Schedule semantics | 0.5 | Due/not-due/stale/disabled/overlap outcomes exist; timezone/DST/catch-up semantics are incomplete. E17 |
| 128 | Backpressure and isolation | 0.5 | Queue depth/concurrency controls exist; tenant fairness and overload shedding are incomplete. E17, E25 |

### 17. Workspace File System Virtualization — 5.5 / 8 — Fail

| ID | Control | Score | Evidence-based finding |
|---:|---|---:|---|
| 129 | Per-run workspace root | 1 | Runtime/tool/thread surfaces carry explicit workspace identity and authoritative roots. E18 |
| 130 ◆ | Path and symlink safety | 0.5 | Core filesystem tools use realpath containment, but hosted `resolveWorkspacePath` only performs lexical containment and can follow an in-root symlink outside the root. Hard-link/device handling is also incomplete. E18 |
| 131 | Mount contract | 0.5 | Source/workspace/artifact/temp modes exist across backends, not as one complete lifecycle contract. E06, E18 |
| 132 | Snapshot and diff | 1 | Workspace checkpoints create, compare, restore, and export Git-backed state. E18 |
| 133 | Storage quotas | 0.5 | Artifact/checkpoint/single-output limits exist; file count, inode, and total workspace limits are incomplete. E18, E19 |
| 134 | Branch isolation | 1 | Managed worktree leases isolate parallel agents and fan-in detects conflict. E12, E18 |
| 135 | Cleanup and retention | 0.5 | Success/failure/orphan cleanup exists; all cancellation/timeout/retention combinations are not one tested policy. E18 |
| 136 | Mutation audit | 0.5 | Tool results and checkpoint diffs attribute writes; permission changes and every export are not uniformly ledgered. E18, E19 |

### 18. Observation Standardizer — 6 / 8 — Pass

| ID | Control | Score | Evidence-based finding |
|---:|---|---:|---|
| 137 | Typed observation envelope | 1 | Tool results distinguish status, source, model context, audit record, truncation, and raw reference. E19 |
| 138 | Raw/model-visible separation | 1 | Full raw output is artifact-backed while bounded projections enter context. E19 |
| 139 | Token-aware limits | 0.5 | Byte/character/token limits exist; line/record limits are not uniform. E03, E19 |
| 140 | Process result fidelity | 1 | stdout/stderr/exit/signal/timeout/partial status remain distinguishable. E06, E19 |
| 141 | Structured payload summarization | 0.5 | Structured values and identifiers survive, but generic shaping does not always preserve schemas/pagination. E19 |
| 142 | Redaction before context | 0.5 | Secret redaction hooks exist; uniform PII/restricted-field redaction before every observation is not proven. E09, E19 |
| 143 | Explicit truncation | 1 | Truncation is labeled with omitted counts/digests and stable artifact retrieval. E19 |
| 144 | Payload edge-case tests | 0.5 | Huge/malformed/stream/error payloads are covered; binary and adversarial terminal cases are incomplete. E19 |

### 19. Deterministic Session Replay Engine — 5.5 / 8 — Fail

| ID | Control | Score | Evidence-based finding |
|---:|---|---:|---|
| 145 | Immutable event sequence | 1 | Ordered persisted events and transitions reconstruct the trajectory. E20 |
| 146 | Complete invocation capture | 0.5 | Model/tool provenance, arguments, results, stops, and usage exist; full prompts/tool schema snapshots are not universal. E20 |
| 147 | Environment provenance | 0.5 | Profiles/models/workspaces are retained; code revision/dependency image/policy version/seeds are incomplete. E20 |
| 148 ◆ | Recorded-result replay | 1 | Replay reads recorded evidence and does not call model or tool dependencies. E20 |
| 149 ◆ | Side-effect safety | 1 | Replay is inspection-only and cannot execute effects. E20 |
| 150 | Explicit live fork | 0 | No first-class re-execution operation creates a causally linked divergent child run from replay. E20 |
| 151 | Divergence detection | 0.5 | Baselines and replay diagnostics detect some state/contract drift, not the complete requested dimension set. E20 |
| 152 | Replay conformance tests | 1 | Known trajectories reproduce state/outcome offline without provider access. E20 |

### 20. Evals-in-the-Loop Integration — 2 / 8 — Fail

| ID | Control | Score | Evidence-based finding |
|---:|---|---:|---|
| 153 | Typed evaluator contract | 0.5 | Pinned Ruhroh config/results provide an external typed eval surface, not a runtime evaluator contract. E21 |
| 154 | Intermediate and final hooks | 0.5 | Verification hooks exist at milestones/finalization, but arbitrary evaluators are not pluggable there. E15, E21 |
| 155 | Versioned evaluation assets | 0.5 | Eval package/version/hash/config are pinned; datasets/rubrics/judge assets are external. E21 |
| 156 | Control-flow integration | 0.5 | Verification can affect completion, but external evaluator results do not implement the requested route set. E15, E21 |
| 157 | Auditable judge context | 0 | No runtime judge trajectory contract. E21 |
| 158 | Evaluator budgets | 0 | No independent runtime evaluator cost/latency/retry/concurrency budget. E21 |
| 159 | Online/offline consistency | 0 | No same-contract live/replay evaluator path. E21 |
| 160 | Evaluator quality tests | 0 | Judge variance/leakage/gaming/threshold stability are not tested in Kestrel. E21 |

### 21. Context Degradation & De-Noising Filters — 6 / 8 — Pass

| ID | Control | Score | Evidence-based finding |
|---:|---|---:|---|
| 161 | Separate de-noising stage | 0.5 | Deterministic duplicate filtering is separate from compaction, but there is no general filter pipeline. E22 |
| 162 | Duplicate suppression | 1 | Repeated read-only results and related observations are detected/collapsed with tests. E22 |
| 163 | Dead-end handling | 0.5 | Failures/superseded work remain typed, but abandoned hypotheses are not uniformly marked in context. E01, E22 |
| 164 | Protected task state | 1 | Task, constraints, corrections, active waits, and unresolved work are protected during context reduction. E03 |
| 165 | Explicit relevance policy | 0.5 | Recency/task/provenance/information value influence assembly, but no one inspectable retention policy covers all factors. E03, E23 |
| 166 | Raw-result handles | 1 | Removed payloads retain artifact/raw-output handles. E19, E22 |
| 167 | Immutable audit separation | 1 | Model-visible filtering does not mutate durable events or raw artifacts. E05, E19 |
| 168 | De-noising regression evals | 0.5 | Token/compaction regressions exist; task quality, contradiction, retrieval, and latency are not jointly measured. E03, E22 |

### 22. Dynamic Tool Discovery — 5 / 8 — Fail

| ID | Control | Score | Evidence-based finding |
|---:|---|---:|---|
| 169 | Catalog indexing | 0.5 | Name/description/schema/permission/capability are indexed; uniform version/cost metadata is incomplete. E04, E23 |
| 170 | Intent-aware query | 0.5 | Task/phase/role/capability filters are used, but there is no semantic intent retrieval/ranking. E23 |
| 171 | Authorization-first filtering | 1 | Unauthorized tools are removed before model context assembly. E04, E23 |
| 172 | Bounded top-k injection | 0.5 | Phase/tool-schema token budgets bound injection; configurable relevance top-k is absent. E03, E23 |
| 173 | Selection provenance | 1 | Context manifests record selected/excluded surfaces and hashes. E03, E23 |
| 174 | Refresh and invalidation | 1 | MCP refresh, revocation, schema changes, and unhealthy-provider state invalidate the assembled surface. E04, E23 |
| 175 | Safe discovery fallback | 0.5 | Exact/deterministic category fallback exists; confidence is not measured. E23 |
| 176 | Discovery evaluation | 0 | No precision/recall/permission-leakage/context-token/downstream-success evaluation suite. E23 |

### 23. Fine-Grained Network Egress Control — 2 / 8 — Fail

| ID | Control | Score | Evidence-based finding |
|---:|---|---:|---|
| 177 ◆ | Below-tool enforcement | 0.5 | Docker `--network none` is below-tool, but host tools and other process families are outside it. E24 |
| 178 ◆ | Default-deny posture | 0 | Host tools, MCP processes, browsers, package managers, and hosted workspaces do not receive default-deny destination/protocol/port policy. E24 |
| 179 | Complete destination policy | 0.5 | Remote MCP requires HTTPS, public addressing, and explicit egress, but no unified DNS/IP/CIDR/protocol/port/SNI/environment policy covers all executors. E24 |
| 180 ◆ | Bypass resistance | 0 | No enforced/tested redirect, rebinding, resolver, proxy, IPv6, encoded-IP, and subprocess resistance. E24 |
| 181 | Scoped allowlists | 0.5 | Profiles can enable/disable networked capability packs, but not scoped destinations across all requested identities. E09, E24 |
| 182 | Decision audit | 0.5 | Tool calls are audited; attempted/allowed/denied connection destinations are not universally recorded. E13, E24 |
| 183 | Child-process coverage | 0 | Package managers, browsers, shells, containers, MCP servers, and spawned children do not inherit one egress policy. E24 |
| 184 | Exfiltration tests | 0 | No DNS-tunnel/metadata/loopback/private-network/redirect/proxy/upload exfiltration suite. E24 |

### 24. Concurrency & Parallel Sub-Task Forking — 5.5 / 8 — Fail

| ID | Control | Score | Evidence-based finding |
|---:|---|---:|---|
| 185 | Bounded scheduler | 1 | Global/run/tool queues and delegation concurrency/depth caps are enforced. E12, E25 |
| 186 | Task isolation | 0.5 | Fork context/workspace/policy/trace identity exists; credential and memory isolation are not complete contracts. E12 |
| 187 | Forked budgets | 0.5 | Each child has turn/runtime limits; the parent does not reserve aggregate token/cost capacity. E10, E12 |
| 188 ◆ | Cancellation and deadlines | 0.5 | Parent signals and tool queues propagate cancellation; every model/tool/sandbox/process boundary is not covered. E12, E25 |
| 189 | Deterministic join | 0.5 | Fan-in states are deterministic, but stable ordering/late-arrival completeness rules are incomplete. E12 |
| 190 | Conflict and merge policy | 1 | Managed worktrees detect conflict and require deterministic merge/review. E12 |
| 191 | Partial failure semantics | 1 | Partial/failed/superseded branches have explicit continuation/escalation semantics. E12 |
| 192 | Load and race tests | 0.5 | Saturation/fairness/cancellation/overflow are tested; deadlock/starvation/orphan load coverage is incomplete. E25 |

### 25. Graceful Degradation & Fallback Strategy Execution — 5 / 8 — Fail

| ID | Control | Score | Evidence-based finding |
|---:|---|---:|---|
| 193 | Fallback trigger taxonomy | 1 | Provider, validation, budget, tool, policy, timeout, and loop failures have distinct codes. E11 |
| 194 ◆ | Explicit escalation ladder | 0 | Independent retries/fallbacks exist, but no configured ordered ladder spans retry through alternate config/model/tool/static path/human or failure. E11, E26 |
| 195 | Capability-safe alternatives | 1 | Assembly compatibility rejects or explicitly records lost required capabilities. E26 |
| 196 | Deterministic non-agentic path | 0.5 | Static validators/recovery tools exist for some critical flows, not a declared coverage set. E26 |
| 197 | Budget-aware degradation | 0.5 | Retry/economics paths honor several budgets, but alternate routes do not evaluate all remaining resource dimensions. E10, E11 |
| 198 | Actionable human escalation | 1 | Continuation/operator records carry state, evidence, blocker, and required decision. E08, E11 |
| 199 | Audited degradation | 0.5 | Retries, failures, and compatibility choices are recorded; every candidate/quality change is not. E11, E13 |
| 200 | Chaos and recovery tests | 0.5 | Provider/tool/budget failures are tested; model regression, sandbox loss, tool removal, and evaluator rejection are not one chaos suite. E11 |

## Findings register

| Priority | Observed wrong behavior | First component that makes it wrong | Existing surface that owns the repair | Controls |
|---|---|---|---|---|
| P0 | Model-controlled host and MCP processes can make unrestricted outbound connections; Docker's network-off mode protects only one execution path. | Execution backends are launched without a required egress-policy object and below-tool enforcement. | `DockerCodeSandboxBackend`, development-shell/MCP process supervisors, agent capability/profile composition, and hosted workspace execution policy. | 177–184 |
| P0 | Model-generated development commands can execute on the host in normal agent profiles. | Tool-surface composition exposes the host development shell without requiring an isolated backend. | Agent profile/capability composition and the existing code-sandbox execution abstraction. | 033–040 |
| P1 | A path lexically inside the hosted workspace can resolve through a symlink to a path outside it. | `apps/workspace-runtime/src/security.ts::resolveWorkspacePath` authorizes `path.resolve` output without realpath/parent-chain containment. | The existing workspace request path resolver and filesystem-tool containment utilities. | 130 |
| P1 | Recovery behavior is locally sensible but cannot be inspected as one ordered, capability-safe escalation policy. | Model, tool, assembly, and operator recovery choose routes independently. | `ModelGateway`, `RunLifecycleController`, `AssemblyCompatibility`, and typed runtime policy contracts. | 074, 079, 101, 194–200 |
| P1 | Unsupported tool arguments can be normalized away instead of rejected, weakening the advertised strict pre-execution contract. | Registry compatibility sanitation runs before schema rejection for some tools. | `UnifiedToolRegistry` and built-in tool input contracts. | 018, 020, 023–024 |
| P1 | Sandbox confidence is based on configuration/unit behavior rather than an adversarial escape proof suite. | The sandbox test boundary does not enumerate the threat model's counterexamples. | Security threat model, proof registry, Docker backend tests, and process validation gate. | 034–040 |
| P1 | The audit-specific mutation gate cannot complete at the audited commit even though the portable gate passes. | `tests/proof/mutations.json` searches for an obsolete line shape in `src/localCore/api.ts`; the authority check was reformatted with end-of-line conjunctions, so the mutation runner finds zero exact targets. | Proof mutation registry and `scripts/validation/audit-mutations.mjs`. | Verification evidence for process authority and audit readiness |
| P2 | Human approvals have strong durable hosted behavior but diverge from local issuer and decision semantics. | Local and hosted approval records do not share one complete typed request/decision/authentication contract. | Interaction contracts, `InteractionManager`, and hosted operation approvals. | 049–056 |
| P2 | Budgets stop several runaway behaviors but do not form one tenant-to-child resource ledger. | Economics, delegation, queue, and sandbox limits account independently. | Economics contracts/controller, delegation budget contract, and tool/sandbox schedulers. | 065–072, 187 |
| P2 | Replay is safe and deterministic for inspection, but environment capture and explicit divergent re-execution are incomplete. | Replay bundle omits some revision/image/policy/schema inputs and has no first-class live-fork operation. | Replay bundle/service and runtime lineage contracts. | 146–151 |
| P2 | Hosted semantic knowledge exists, but memory lifecycle and retrieval are not one runtime-wide typed interface; eval-driven control flow remains outside Kestrel. | Thread memory, scratchpad, reasoning vault, knowledge documents, artifacts, and Ruhroh integrations are independently owned. | Product architecture decision, then shared runtime memory/evaluator contracts if unification is desired. | 041–048, 153–160 |

## Remediation order

1. **Close the workspace symlink escape in the existing resolver.** Reuse the filesystem tool's realpath/nearest-existing-parent containment approach and add symlink, hard-link, device, race, and external-directory tests. This is a narrow repair with clear ownership.
2. **Make isolation an explicit execution capability.** Require model-generated process execution to select an isolated backend or an audited host-execution grant. Keep the repair in profile/tool composition and the existing sandbox abstraction.
3. **Define one below-tool egress contract before adding allowlist logic.** The contract must cover destinations, resolution, redirects, subprocess inheritance, decision receipts, and failure behavior across shell, Docker, MCP, browser, package manager, and hosted workspace processes. Destination matching is policy behavior and requires explicit approval before implementation.
4. **Turn the sandbox threat model into mutation/escape proofs.** Add counterexamples for privilege and namespace escape, fork bombs, disk/inode fill, mount and symlink attacks, secret theft, metadata/loopback access, proxy/redirect/rebinding, and orphan cleanup.
5. **Unify strict tool-input behavior.** Decide whether compatibility sanitation is allowed. If strict rejection is the contract, validate the original payload before normalization and run one conformance suite over built-in, MCP, plugin, and generated tools.
6. **Specify the recovery ladder as a typed policy.** Route existing retries, compatibility alternatives, deterministic workflows, operator waits, and terminal failures through a versioned decision record with budgets and capability checks. This changes runtime policy and requires explicit approval.
7. **Unify approval and resource-ledger contracts.** Make approver authority, stale-decision invalidation, child reservations, spend attribution, and cancellation propagation consistent across local and hosted runtimes.
8. **Make an explicit product decision on memory unification and eval control flow.** If hosted knowledge and external Ruhroh evaluation remain deliberately separate, accept the checklist partials/zeros. If unified runtime services enter scope, start with typed contracts and recorded evidence rather than provider-specific storage or judge heuristics.

## Validation

`CI=true pnpm validate` was run from a clean tracked worktree at the audited commit after installing lockfile-pinned dependencies with `pnpm install --frozen-lockfile`.

The final outcome:

- **Status:** passed in 124.6 seconds
- **Command:** `CI=true pnpm validate`
- **Observed stages:** public-boundary preflight; shared and root builds; workspace typechecks; Desktop, runtime, package, and Web hermetic suites
- **Tracked source changes before audit report:** none

The audit-specific gate was also run:

- **Status:** failed after 13.7 seconds
- **Command:** `CI=true pnpm run validate:audit`
- **Mutation outcome before failure:** ten preceding critical mutations were killed by their owning tests.
- **Blocking failure:** `local-core-authority-lock-theft: expected one exact mutation target, found 0`
- **Cause:** the mutation specification expects `&&` at the beginning of the second line, while the current authority check places `&&` at the end of the preceding line. This is proof-registry drift, not a surviving mutation and not an environmental test failure.

## Score sensitivity

The score is deliberately conservative where an implementation exists without the exact required verification. It is also insensitive to simple documentation expansion:

- Fixing only prose does not clear any critical zero.
- Closing control 130 alone adds at most 0.5 and moves the raw score to 133, but the critical result remains Fail.
- A real system-wide egress boundary plus its bypass/exfiltration tests can add up to 6.5 points and clear three network critical gates.
- Default isolated execution plus adversarial escape proofs can add up to 4.5 points and clear two sandbox critical gates.
- A typed, tested escalation ladder can add at least 1 point and clear control 194.

The shortest path to a passing critical gate is therefore architectural enforcement and adversarial evidence, not score-oriented documentation.

## 2026-08-23 control 038 re-verification

This dated supplement updates only control 038 against Kestrel `0.8.5` at implementation commit `aabe26d27`. It does not rewrite the 2026-07-30 audit snapshot above.

- **Re-verified control:** 038, Scoped secret injection
- **Updated score:** 1 (previously 0.5)
- **Updated domain 5 score:** 4 / 8; Fail because critical controls 033 and 040 remain zero
- **Updated raw score:** 133 / 200; Critical: Fail
- **Finding:** Registered adapters receive credentials only inside the trusted host boundary. Durable authority binds the exact tenant, run, call, operation, resource, policy, approval, credential revision, and ceilings. Route-free Docker workloads receive only bounded normalized results. Local Core and hosted-runner qualification prove cleanup, cancellation, expiry, timeout, selected-unused authority, exact restart reads, and recursive secret absence with an isolated provider fixture.

Supplemental evidence:

| ID | Evidence class | Evidence |
|---|---|---|
| E27 | Shared adapter contract | [`src/code/SandboxCapabilityAdapterRegistry.ts`](../../src/code/SandboxCapabilityAdapterRegistry.ts), [`src/code/CodeExecutionService.ts`](../../src/code/CodeExecutionService.ts), [`tests/unit/sandbox-capability-adapter-conformance.test.ts`](../../tests/unit/sandbox-capability-adapter-conformance.test.ts), [`tests/unit/sandbox-capability-external-effect-approval.test.ts`](../../tests/unit/sandbox-capability-external-effect-approval.test.ts) |
| E28 | Docker process isolation | [`src/code/DockerSandboxExecutor.ts`](../../src/code/DockerSandboxExecutor.ts), [`tests/process/docker-sandbox.process.test.ts`](../../tests/process/docker-sandbox.process.test.ts) |
| E29 | Deployment qualification | [`src/localCore/executionRuntime.ts`](../../src/localCore/executionRuntime.ts), [`cli/runner/HostedRunnerStore.ts`](../../cli/runner/HostedRunnerStore.ts), [`tests/integration/web-command.test.ts`](../../tests/integration/web-command.test.ts), [`tests/fixtures/sandbox-capability-fetch-preload.mjs`](../../tests/fixtures/sandbox-capability-fetch-preload.mjs). Local Core and hosted-runner production entrypoints run locally with real Docker and an isolated provider fixture; this is not a live external-provider or hosted-cloud test. |
| E30 | Transaction parity | [`src/code/SandboxCapabilityLeaseCoordinator.ts`](../../src/code/SandboxCapabilityLeaseCoordinator.ts), [`src/store/InMemorySessionStore.ts`](../../src/store/InMemorySessionStore.ts), [`src/store/PostgresSessionStore.ts`](../../src/store/PostgresSessionStore.ts), [`tests/sandbox-capability-leases.postgres.test.ts`](../../tests/sandbox-capability-leases.postgres.test.ts) |
| E31 | Operator and exact replay | [`src/replay/RunReplayService.ts`](../../src/replay/RunReplayService.ts), [`cli/runner/RunnerHost.ts`](../../cli/runner/RunnerHost.ts), [`tests/unit/run-replay-service.test.ts`](../../tests/unit/run-replay-service.test.ts), [`tests/unit/exact-effect-result-read.test.ts`](../../tests/unit/exact-effect-result-read.test.ts), [`tests/integration/runner-protocol.test.ts`](../../tests/integration/runner-protocol.test.ts) |

Verification for this supplement:

- `pnpm run typecheck:self`: passed.
- Focused ownership, exact-result, adapter, replay, and deployment qualification suites: passed.
- Spawned Local Core and hosted-runner qualification: passed with real Docker and isolated provider transport.
- `pnpm validate:postgres`: the runtime PostgreSQL contracts, including sandbox capability lease parity, passed; the full lane remained red on two unrelated pre-existing Web model-fixture failures.
- `pnpm validate`: runtime capability fixtures pass after the re-verification fixture update; the Web hermetic lane remains environment-blocked by `listen EPERM` in `worker-health.test.ts` under this managed sandbox.

## 2026-07-31 disposition

This audit remains a historical snapshot; its score and evidence above are not
rewritten by the following product decisions.

- Control 178's default-deny egress zero is accepted risk. User-enabled OCI MCP
  servers retain full outbound networking by default because their destinations
  are commonly unpredictable. The user is trusted to select those servers.
- OCI containers protect the host and expose only explicitly configured
  credentials and read-only mounts. They are not an outbound-network security
  boundary. Destination allowlists and an egress broker are not planned.
- Filesystem descriptor-relative TOCTOU hardening is deferred until mutually
  untrusted writers sharing a workspace enter the supported threat model.
- Model-facing tool input must match its published schema exactly. Legacy
  aliases belong only in an explicit trusted compatibility adapter.
- The proof-registry experiment is retired. Critical mutation checks remain as
  live, read-only validation without a separate registry or checked-in evidence.
