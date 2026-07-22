---
id: kestrel-token-efficiency-audit-2026-07-22
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-07-22
---

# Kestrel token-efficiency architecture audit

## Audit status

This is the evidence ledger and scorecard for the 94-check Kestrel harness audit. It evaluates whether model tokens produce independently accepted outcomes, not merely completed runs or shorter prompts.

The static, historical, and provisional deterministic reviews are complete. The live 16-attempt pilot is intentionally gated because the checkout is not yet a reproducible baseline: `a16f819ea4c2def236e46d1acb94a719aa1ae357` is checked out on `asher/kestrel-one-dictation-thread-ui`, with pre-existing changes in the CLI runtime, unified tool registry, related tests, and workspace-runtime Dockerfile. Those changes are preserved and excluded from clean-baseline claims until committed or parked.

Current verdict: **not measurable for optimization claims**. Several P0 checks score `0`, especially complete token-class accounting, context-section attribution, token-aware compaction, cost per accepted success, and a unified evaluation result.

## Scoring contract

- `0`: absent, contradicted, or not observable.
- `1`: implemented or documented but unmeasured.
- `2`: measured on representative traces or deterministic probes.
- `3`: comparative evidence proves an improvement to the quality/cost/latency frontier.

Each row has a confidence level (`H`, `M`, `L`), owning surface, and disposition (`keep`, `improve`, `remove`, `experiment`). Domain weighted score is `domain weight × mean row score ÷ 3`. Any P0 score of `0` makes the audit not measurable regardless of total score; any P0 below `2` makes optimization claims not decision-ready.

## Baseline and evidence register

| Ref | Evidence | What it proves |
|---|---|---|
| S01 | [`ModelUsage`](../../src/kestrel/contracts/model-io.ts#L207), [OpenAI mapper](../../models/openai/OpenAiMapper.ts#L299), [Anthropic mapper](../../models/anthropic/AnthropicMapper.ts#L372), [OpenRouter mapper](../../models/openrouter/OpenRouterMapper.ts#L611) | Core normalization retains input/output/total tokens but not cache reads/writes, reasoning tokens, provider cost, price version, or service tier. |
| S02 | [Guardrails](../../src/engine/Guardrails.ts#L24) | Tool, action-model, maintenance-model, and base token totals are separately counted and bounded. |
| S03 | [Context assembly](../../src/runtime/agent-context/assembleContext.ts#L227), [runtime rendering](../../src/runtime/agent-context/runtimeContext.ts#L91) | Named context sections and project/skill revisions are rendered, but section tokens, sizes, priorities, hashes, truncation, and admission reasons are not recorded. |
| S04 | [Compaction policy](../../src/runtime/agent-context/maintenancePrompts.ts#L29), [model transcript](../../src/runtime/modelTranscript.ts#L51) | Compaction uses 120,000 characters and 24 retained items; transcript retention uses a 120-item ceiling. Provider-valid tool call/result pairing and compaction records exist. |
| S05 | [Result shaping](../../agents/reference-react/src/steps/acter/resultShaping.ts#L35) | General and shell payloads, prompt previews, failure details, digests, and artifact references are bounded. |
| S06 | [Tool context](../../src/runtime/agent-context/toolContext.ts#L191), [read-only duplicate detection](../../src/runtime/readOnlyResultDuplicates.ts#L21), [unified registry](../../tools/runtime/UnifiedToolRegistry.ts#L648) | Internal shell lifecycle tools are hidden behind `exec_command`; aliases, schemas, validator reuse, duplicate results, and continuation instructions exist. Full workspace schemas are still materialized. |
| S07 | [Loop coordinator](../../src/engine/LoopGuardCoordinator.ts), [evidence quality](../../src/runtime/evidenceQuality.ts), [retry context](../../src/runtime/agent-context/retryContext.ts) | Structured loop, evidence, recovery, correction, and budget mechanisms exist; their token economics are not aggregated. |
| S08 | [Benchmark provider contract](../../scripts/benchmark-provider-config.ts#L7), [SWE suite](../../scripts/swe-passing.sh#L40), [Terminal-Bench suite](../../scripts/tb2-passing.sh#L40) | Live benchmark runs are pinned to OpenRouter, default `z-ai/glm-5.2`, `build/full_auto`, and explicit curated task lists. |
| S09 | [Hosted usage ingestion](../../apps/web/app/api/stats/usage/route.ts#L8), [usage dashboard API](../../apps/web/app/api/stats/route.ts#L120) | Hosted accounting stores organization, source, model, input/output tokens, duration, and free-form metadata, but not rich token classes or accepted-outcome economics. |
| S10 | [Observability tracer](../../packages/observability/src/tracer.ts#L183) | Application-facing traces correlate session/thread/run and several latency fields; they are not the runtime internal trace and do not provide the unified audit schema. |
| S11 | [`agent.spawn`](../../tools/runtime/agentSpawn.ts), [delegation supervisor](../../src/orchestration/DelegationSupervisor.ts#L42), [subagent result envelope](../../src/orchestration/subAgentResult.ts) | Runtime-native delegation has depth/concurrency policy, lineage, compact 240-character summaries, structured status/result/references, and supervision; it does not account for duplicated context or aggregate token multiplier. |
| H01 | [Resolved Django run](../../runs/swe-verified/kestrel-swe-django__django-14089/attempts/20260718T160703227Z/evaluator-report.json), [job output](../../runs/swe-verified/kestrel-swe-django__django-14089/attempts/20260718T160703227Z/job-output.json) | Runtime completed and the official evaluator resolved the task; exact session/thread/run IDs are retained. Successful job output does not carry comparable usage telemetry. |
| H02 | [Unresolved Pylint run](../../runs/swe-verified/kestrel-swe-pylint-dev__pylint-4604/attempts/20260708T105218704Z/evaluator-report.json), [job output](../../runs/swe-verified/kestrel-swe-pylint-dev__pylint-4604/attempts/20260708T105218704Z/job-output.json) | Runtime completion and evaluator acceptance are correctly separate; this completed run was unresolved. |
| H03 | [Seaborn budget failure](../../runs/swe-verified/kestrel-swe-mwaskom__seaborn-3069/attempts/20260707T185923432Z/job-output.json) | Failure preserves IDs, classification, 196 steps, 4 tool calls, 54 model calls, 3 maintenance calls, 1,098,922 input tokens, 10,943 output tokens, and 1,109,865 total tokens. |
| H04 | [Later Seaborn evaluator result](../../runs/swe-verified/kestrel-swe-mwaskom__seaborn-3069/attempts/20260708T101803732Z/evaluator-report.json) | A later completed submitted patch remained unresolved, preserving the difference between producing a patch and solving the task. |
| T01 | `pnpm run bench:smoke` on 2026-07-22: 5/5 passed | Offline benchmark contracts preserve adapter failure detection, oracle stripping, prediction validation, and canonical OpenRouter model selection. |
| T02 | `pnpm run observability:test` on 2026-07-22: 6/6 passed | Application trace correlation, terminal uniqueness, cancellation outcome, reasoning latency, and dispatch latency are under deterministic tests. |
| T03 | Targeted harness command on 2026-07-22: 309/309 passed | Context ordering/task selection, transcript/compaction invariants, result shaping, artifact rehydration, read duplication, loop guards, stale validation, session coordinates, benchmark orchestration, and tool-registry contracts passed together. |
| T04 | `pnpm run validate:hermetic` on 2026-07-22: runtime 2,066/2,066 and web 589/589 passed | The hermetic runtime and hosted-web suites pass on the provisional snapshot. |
| T05 | `pnpm run validate:process` on 2026-07-22: passed | TUI, Local Core, desktop, runner, packaged-consumer, SDK, managed-worktree, benchmark workspace, and process-boundary journeys pass on the provisional snapshot. |
| T06 | `pnpm run validate:audit` on 2026-07-22: mutation phase passed; contract registry failed | All ten critical mutations were killed. The registry then found twelve tests not using `contractTest` and eight contract groups without runtime timing evidence. |
| T07 | `pnpm run test-proofs:check` on 2026-07-22: failed | The direct registry check confirms twelve unregistered tests across dictation shortcuts, the workspace-command canary, and composer presentation. |
| T08 | `pnpm run bench:smoke -- --live-preflight` on 2026-07-22: 6/6 passed | Both benchmark command constructors and the live-preflight dry-run path are renderable under the current environment. |
| T09 | `pnpm run bench:swe -- preflight` on 2026-07-22: passed | The dedicated SWE-bench Python environment, official evaluator wrapper, Docker path, and OpenRouter credential are available. A noncanonical OpenAI key is present but explicitly ignored. |
| T10 | Canary dry-runs on 2026-07-22 | Terminal-Bench rendered the canonical Harbor `fix-git` command. SWE resolved Astropy base commit `d16bfe05a744909de4b27f5875fe0d4ed41ce607`, `z-ai/glm-5.2`, `build/full_auto`, guardrails, `/testbed`, patch export, and official evaluation command. No paid attempt was started. |

## Weighted scorecard

| Domain | Weight | Static score | Weighted score | P0 zeros | Status |
|---|---:|---:|---:|---:|---|
| A. Outcome and cost accounting | 15 | 9/36 | 3.75 | 2 | Blocking |
| B. Prompt and cache architecture | 10 | 3/24 | 1.25 | 1 | Blocking |
| C. Context assembly and allocation | 15 | 9/36 | 3.75 | 1 | Blocking |
| D. Tool surface and result economics | 15 | 12/36 | 5.00 | 1 | Blocking |
| E. Transcript, compaction, and memory | 15 | 7/36 | 2.92 | 4 | Blocking |
| F. Loop control and recovery | 10 | 13/30 | 4.33 | 0 | Runtime proof required |
| G. Model and reasoning allocation | 5 | 2/18 | 0.56 | 1 | Blocking |
| H. Verification and evaluation | 10 | 4/30 | 1.33 | 2 | Blocking |
| I. Hosted product and governance | 3 | 5/18 | 0.83 | 0 | Runtime proof required |
| J. Multi-agent and parallelism | 2 | 3/18 | 0.33 | 0 | Economics not measured |
| **Total** | **100** |  | **24.05** | **12** | **Not measurable** |

Scores below are the first static/historical pass. A score can rise only when the required deterministic or live evidence is attached.

## A. Outcome and cost accounting

| ID | Pri | Score | Conf | Evidence | Finding | Owner | Disposition |
|---|---|---:|:---:|---|---|---|---|
| A01 | P0 | 1 | H | S01 | Base token totals only; cache/reasoning classes are erased. | model gateway | improve |
| A02 | P0 | 1 | M | S01, S08 | Model/provider fields exist across seams, but no complete per-call provenance record was found. | runtime/observability | improve |
| A03 | P0 | 1 | H | S02, S09, H01, H03 | Run IDs and usage exist, but successful accepted runs lack equivalent usage in the terminal artifact. | runtime/hosted | improve |
| A04 | P0 | 2 | H | H01, H02, H04 | Official evaluator acceptance is independent of runtime completion. | evaluation | keep |
| A05 | P0 | 0 | H | S09 | No cost-per-accepted-success computation or distribution. | product/evaluation | improve |
| A06 | P0 | 0 | H | S03 | Section presence is recorded; section tokens are not. | context/observability | improve |
| A07 | P1 | 1 | M | S09, S10 | Total and selected phase latencies exist, not a complete decomposition. | observability | improve |
| A08 | P1 | 1 | H | S02, H03 | Action and maintenance calls are separate; retry, verifier, and compaction cost attribution is incomplete. | runtime/evaluation | improve |
| A09 | P1 | 1 | H | S05 | Shaping limits exist, but per-tool stored/model-visible bytes are not aggregated. | tools/observability | improve |
| A10 | P1 | 0 | H | S01, S09 | No versioned price catalog tied to immutable rich usage. | product | improve |
| A11 | P2 | 0 | M | S09 | Human intervention/rework is not part of the result model. | product/evaluation | experiment |
| A12 | P2 | 1 | L | S09 | Free-form metadata is extensible, but no governed compute/energy contract exists. | observability | experiment |

## B. Prompt and cache architecture

| ID | Pri | Score | Conf | Evidence | Finding | Owner | Disposition |
|---|---|---:|:---:|---|---|---|---|
| B01 | P0 | 1 | M | S03, S06 | Render order is explicit; byte-stable prefix snapshots are not measured. | context/model gateway | experiment |
| B02 | P0 | 0 | H | S01 | Cache controls and rich cache usage do not survive the normalized contract. | model gateway | improve |
| B03 | P1 | 1 | M | S03 | Project revision exists; no composite prompt/tool/skill prefix identity. | context | improve |
| B04 | P1 | 1 | M | S06 | Tool construction is deterministic in code paths, without serialized-prefix proof. | tools/model gateway | experiment |
| B05 | P1 | 0 | H | S01, S09 | No prefix read/write/miss/eviction accounting. | observability | improve |
| B06 | P1 | 0 | M | S08 | Workloads differ, but no explicit cache-policy matrix was found. | model gateway | experiment |
| B07 | P1 | 0 | M | S03 | No first-differing-prefix diagnostic or invalidation report. | context/observability | experiment |
| B08 | P2 | 0 | M | S09 | No explicit organization/provider cache-retention audit trail found. | hosted/security | improve |

## C. Context assembly and allocation

| ID | Pri | Score | Conf | Evidence | Finding | Owner | Disposition |
|---|---|---:|:---:|---|---|---|---|
| C01 | P0 | 0 | H | S04 | Admission/compaction is character- and item-based, not tokenizer-aware. | context | improve |
| C02 | P0 | 1 | H | S03 | Named sections exist without budgets, priority, tokens, truncation, or rationale. | context/observability | improve |
| C03 | P0 | 1 | M | S03 | Exact task-message duplicate avoidance exists; semantic duplication remains unmeasured. | context | experiment |
| C04 | P0 | 2 | H | S03, S06, T03 | Deterministic probes preserve workspace-relative cwd, exact active session evidence, current task identity, and continuation state. | runtime/context | keep |
| C05 | P1 | 1 | H | S03 | Full revisioned project content can render; no value-based admission policy. | context | experiment |
| C06 | P1 | 0 | H | S03 | Full skill instructions render when active; progressive-disclosure economics are not implemented or measured. | skills/context | improve |
| C07 | P1 | 1 | M | S03, S07 | Structured evidence and some omission logic exist; cross-section duplicates are not counted. | context | improve |
| C08 | P1 | 0 | M | S03 | No position-aware invariant placement evaluation. | context/evaluation | experiment |
| C09 | P1 | 1 | M | S04, S07 | Goals and recent/provider-valid tails receive protection; no general semantic admission classes. | context | improve |
| C10 | P1 | 2 | H | S05, T03 | Deterministic probes preserve compact digests/references and rehydrate raw artifacts, including a missing-artifact refusal path. | tools/context | keep |
| C11 | P2 | 0 | H | S03 | No no-model diagnostic manifest with counts, hashes, and provenance. | context/observability | improve |
| C12 | P2 | 0 | M | S03 | No measured phase-specific context allocation policy. | context | experiment |

## D. Tool surface and result economics

| ID | Pri | Score | Conf | Evidence | Finding | Owner | Disposition |
|---|---|---:|:---:|---|---|---|---|
| D01 | P0 | 0 | H | S06 | Complete tool-schema token cost is not measured by mode/profile. | tools/observability | improve |
| D02 | P0 | 1 | H | S05 | Strong storage/preview separation exists; quality-preservation ablation is missing. | tools | keep |
| D03 | P0 | 1 | M | S05 | Digests preserve structured facts and references; adversarial sufficiency proof is pending. | tools/evaluation | improve |
| D04 | P1 | 0 | H | S06 | Full selected workspace schemas are materialized; no on-demand discovery path found. | tools/context | experiment |
| D05 | P1 | 1 | H | S06 | Alias collision checks and unified `exec_command` reduce overlap. | tools | keep |
| D06 | P1 | 1 | L | S05, S06 | Several tools expose compact selectors, but returned-to-used payload efficiency is unmeasured. | tools | improve |
| D07 | P1 | 2 | H | S06, T03 | Equivalent read-only calls/results are deterministically classified and guarded across filesystem and retrieval paths. | runtime/tools | keep |
| D08 | P1 | 2 | H | S06, T03 | Deterministic probes preserve exact live session identity, unread-output continuation, workspace-relative cwd, and active process state. | runtime/tools | keep |
| D09 | P1 | 2 | H | S05, T03 | Recoverable failures retain stable codes and bounded structured evidence across tool and shell result probes. | tools/runtime | keep |
| D10 | P1 | 1 | M | S05, S07 | Deterministic validation and parsing are extensive; replacement opportunity inventory is absent. | runtime | keep |
| D11 | P2 | 0 | M | S06 | No general independent-call execution that avoids intermediate transcript injection. | tools/runtime | experiment |
| D12 | P2 | 1 | M | S05, S06 | Broad contract tests exist; no unified economic held-out tool evaluation. | tools/evaluation | improve |

## E. Transcript, compaction, and memory

| ID | Pri | Score | Conf | Evidence | Finding | Owner | Disposition |
|---|---|---:|:---:|---|---|---|---|
| E01 | P0 | 0 | H | S04 | Retention is capped by 120 items, not token load and semantic value. | transcript | improve |
| E02 | P0 | 0 | H | S04 | Compaction starts at 120,000 characters, not resolved window pressure. | transcript/context | improve |
| E03 | P0 | 1 | H | S04 | Compaction prompt requests durable state and provider-valid tail; recall is unmeasured. | transcript/evaluation | improve |
| E04 | P0 | 0 | H | S04 | Empty/invalid summary falls back to a generic sentence and continues. | transcript | improve |
| E05 | P0 | 0 | H | S04 | No semantic sufficiency validation before history replacement. | transcript | improve |
| E06 | P1 | 0 | M | S04 | No independent old-tool-result eviction policy was found. | transcript/context | experiment |
| E07 | P1 | 0 | H | S04 | No repeated-compaction drift suite. | evaluation | improve |
| E08 | P1 | 2 | H | S04, S05, T03 | Compaction records replaced/retained IDs and deterministic probes rehydrate compacted artifacts or refuse synthesis when missing. | transcript/artifacts | keep |
| E09 | P1 | 1 | M | S01 | Provider reasoning continuation exists; task-value ablation does not. | model gateway | experiment |
| E10 | P1 | 0 | L | S03 | Stable project context exists, but no audited durable-memory schema/provenance/expiry contract was found. | memory/product | improve |
| E11 | P1 | 2 | H | S03, S04, T03 | Fresh-turn, original-task, long-tail, post-compaction, and correction probes preserve unambiguous active task selection. | transcript/context | keep |
| E12 | P2 | 1 | H | S02, S04 | Maintenance calls have a separate budget class but use the action model. | runtime/model gateway | experiment |

## F. Loop control and recovery

| ID | Pri | Score | Conf | Evidence | Finding | Owner | Disposition |
|---|---|---:|:---:|---|---|---|---|
| F01 | P0 | 2 | H | S07, T03 | Deterministic loop probes require evidence/state progress, distinguish valid pending batches, and stop repeated retrieval, validation, or dispatch churn. | runtime | keep |
| F02 | P0 | 2 | H | S07, H01, H02, T03 | Partial/stale verification cannot prove completion, while official evaluator acceptance remains independently authoritative. | runtime/evaluation | keep |
| F03 | P0 | 1 | H | S07 | Structured corrections target failures; retry token footprints are absent. | runtime/context | keep |
| F04 | P0 | 1 | M | S07 | Phase recovery mechanisms exist; failed-verification replay behavior needs trace proof. | runtime | experiment |
| F05 | P1 | 1 | H | S02, S08 | Multiple budgets and benchmark profiles exist; task-class adaptation is limited/unmeasured. | runtime | improve |
| F06 | P1 | 1 | M | S07 | No-progress and residual-finalization handling exist; marginal-turn value is not quantified. | runtime | keep |
| F07 | P1 | 1 | M | S03, S07 | Compact recovery state exists; expiry/recurrence economics need proof. | runtime/context | keep |
| F08 | P1 | 2 | H | S07, S08, T08-T10 | SWE and Terminal-Bench preflight/dry-run probes resolve the canonical noninteractive entrypoints, model, mode, guardrails, task identity, and evaluator command without spending an attempt. | runtime | keep |
| F09 | P1 | 1 | M | S06 | Exact session continuation instructions exist; duplicate-start stress proof is pending. | runtime/tools | keep |
| F10 | P2 | 1 | M | S07 | Decision/failure codes exist across paths but are not unified for policy ablation. | observability/runtime | improve |

## G. Model and reasoning allocation

| ID | Pri | Score | Conf | Evidence | Finding | Owner | Disposition |
|---|---|---:|:---:|---|---|---|---|
| G01 | P0 | 0 | H | S01, S08, S09 | Selection is not evaluated by accepted cost. | evaluation/product | improve |
| G02 | P1 | 1 | H | S01 | Reasoning effort is supported, but no phase/difficulty adaptation evidence. | model gateway/runtime | experiment |
| G03 | P1 | 0 | H | S04 | Maintenance work is separate but no cheaper-model qualification matrix exists. | evaluation/model gateway | experiment |
| G04 | P1 | 0 | M | S01 | No evidence-preserving cheap-to-strong escalation study. | runtime/model gateway | experiment |
| G05 | P1 | 1 | H | S01 | Max output and structured response controls exist; right-sizing metrics do not. | model gateway | keep |
| G06 | P2 | 0 | M | S08 | Benchmark model selection is fixed; no audited router confusion/fallback economics. | model gateway | experiment |

## H. Verification and evaluation

| ID | Pri | Score | Conf | Evidence | Finding | Owner | Disposition |
|---|---|---:|:---:|---|---|---|---|
| H01 | P0 | 1 | H | S08 | Many deterministic and benchmark lanes exist; no single frozen token-efficiency suite manifest. | evaluation | improve |
| H02 | P0 | 0 | H | S08 | No paired optimization baseline protocol has been executed for this audit. | evaluation | improve |
| H03 | P0 | 1 | M | S08 | Canonical model lane supports harness-controlled studies; explicit paired study artifacts are absent. | evaluation | keep |
| H04 | P0 | 0 | H | H01, H03, S09 | Outcomes and some token totals exist in different artifacts, not one complete schema. | evaluation/observability | improve |
| H05 | P1 | 1 | H | S04, S06, S07, H03 | Real failure signatures have targeted mechanisms and artifacts; unified catalog is incomplete. | evaluation/runtime | keep |
| H06 | P1 | 0 | H | S03-S07 | No independent component ablation table. | evaluation | experiment |
| H07 | P1 | 1 | M | H01-H04 | Repeated saved attempts exist, but no confidence or tail analysis under a frozen baseline. | evaluation | improve |
| H08 | P1 | 0 | H | S08 | No quality-adjusted token regression gate. | evaluation/governance | improve |
| H09 | P1 | 0 | H | S07 | Evidence quality mechanisms exist, but no trace grader labels token waste. | evaluation | experiment |
| H10 | P2 | 0 | M | S10 | No privacy-safe production replay set and drift process was found. | product/evaluation | experiment |

## I. Hosted product and governance

| ID | Pri | Score | Conf | Evidence | Finding | Owner | Disposition |
|---|---|---:|:---:|---|---|---|---|
| I01 | P0 | 1 | H | S09 | Cross-source organization usage exists with only basic token classes and no first-class accepted outcome. | hosted/data | improve |
| I02 | P1 | 1 | M | S09 | Organization/environment model and reasoning controls exist; complete cost/cache/retention/concurrency precedence does not. | hosted/governance | improve |
| I03 | P1 | 1 | M | S03, S09 | Project revisions exist, but model-call trace/cache identity linkage is incomplete. | hosted/context | improve |
| I04 | P1 | 1 | H | S09 | Dashboards report token totals and duration, not accepted-outcome economics or token composition. | hosted/product | improve |
| I05 | P1 | 1 | H | H03 | Budget failures preserve strong local job artifacts; cross-surface proof is pending. | runtime/hosted | keep |
| I06 | P2 | 0 | H | S01, S09 | No versioned pricing/quota/provider-capability history tied to usage. | hosted/governance | improve |

## J. Multi-agent and parallelism

| ID | Pri | Score | Conf | Evidence | Finding | Owner | Disposition |
|---|---|---:|:---:|---|---|---|---|
| J01 | P1 | 1 | H | S11, T03 | Runtime-native delegation is explicitly enabled and bounded by depth/concurrency policy; value-based rejected-delegation telemetry is absent. | orchestration | improve |
| J02 | P1 | 0 | H | S01 | Parent/subagent duplicated context is not represented in usage. | orchestration/observability | improve |
| J03 | P1 | 0 | H | S11 | `agent.spawn` accepts only a task string, but the brief has no size bound or reference-first requirement. | orchestration/context | improve |
| J04 | P1 | 1 | H | S11 | Child results normalize status, result, references, and errors with a compact summary; return-token budgets are not measured. | orchestration | keep |
| J05 | P1 | 0 | H | S01 | No wall-clock-versus-token-multiplier reporting for parallel agents. | orchestration/evaluation | improve |
| J06 | P2 | 1 | M | S11 | Supervision/fan-in state and child result references exist; verification overhead and redo rate are unmeasured. | orchestration/evaluation | experiment |

## Priority synthesis

Kestrel already has several valuable efficiency controls: independent evaluator outcomes, bounded tool-result shaping with artifact references, deterministic duplicate/read and loop guards, explicit action-versus-maintenance budgets, provider-valid compaction tails, recovery state, and bounded delegation supervision. These are credible mechanisms, but most are proven as correctness properties rather than measured as token-efficiency improvements.

The highest-leverage opportunities, in dependency order, are:

1. **Create one immutable call/run/outcome ledger** (`A01-A05`, `H04`, `I01`). Preserve input, output, cache, reasoning, retry, maintenance, verifier, provider/model, price-version, latency, failure class, and independent acceptance fields. This is the prerequisite for every defensible cost-per-success claim.
2. **Make context assembly observable and token-aware** (`A06`, `C01-C03`, `C11`). Emit a no-model manifest for every section with identity, revision/hash, token count, priority, admission/truncation reason, and duplication indicators. Replace character/item ceilings with resolved-model token pressure and explicit reserves.
3. **Qualify compaction as a semantic transformation** (`E01-E07`). Add pre-replacement sufficiency checks, failure-closed behavior, repeated-compaction drift tests, and recall probes for active task, decisions, constraints, evidence, file state, and unresolved blockers.
4. **Measure and reduce the model-visible tool tax** (`D01-D06`, `A09`). Attribute schema tokens by mode/profile, log stored versus model-visible result bytes/tokens, and test demand-loaded or phase-scoped tool exposure. Preserve the current bounded result and artifact mechanisms while proving that reductions do not lower acceptance.
5. **Turn the benchmark lanes into a paired efficiency instrument** (`H01-H09`). Freeze the harness/model/configuration, join all attempt artifacts into the unified result schema, include tails and failure classes, and compare changes on accepted-outcome rate, tokens per accepted success, latency, and regression signatures.
6. **Optimize cache, model allocation, and delegation only after attribution exists** (`B01-B08`, `G01-G06`, `J01-J06`). These surfaces may produce large gains, but current evidence cannot distinguish savings from shifted cost, duplicated context, or lower task success.

This ordering intentionally puts measurement and attribution before prompt shortening or model routing. Without the first two capabilities, later optimizations can make individual calls look cheaper while increasing retries, compaction loss, delegation multiplier, or unresolved outcomes.

## Deterministic evidence gate

The following evidence must be attached before static scores can rise to `2`:

- `pnpm run validate:hermetic`
- `pnpm run validate:process`
- `pnpm run validate:audit`
- `pnpm run test-proofs:check`
- `pnpm run bench:smoke`
- `pnpm run observability:test`
- Targeted context, transcript, compaction, result-shaping, duplicate-read, loop-guard, provider-mapping, benchmark, and unified-tool-registry tests

Current deterministic results on the provisional dirty snapshot:

| Command | Result | Audit interpretation |
|---|---|---|
| `pnpm run bench:smoke` | 5/5 passed | Benchmark adapters and offline artifact contracts are healthy. |
| `pnpm run observability:test` | 6/6 passed | Application-facing correlation/outcome/latency traces are healthy. |
| Targeted `node --import tsx --test ...` harness suite | 309/309 passed | The selected context, transcript, tool, loop, freshness, recovery, benchmark, and registry mechanisms have deterministic proof. |
| `pnpm run validate:hermetic` | Runtime 2,066/2,066; web 589/589 passed | Broad hermetic behavior is healthy on the provisional snapshot. |
| `pnpm run validate:process` | Passed | Process, TUI, Local Core, SDK, runner, workspace, and benchmark-boundary journeys are healthy on the provisional snapshot. |
| `pnpm run validate:audit` | Failed after 10/10 mutations were killed | Contract-proof registry found 12 unregistered tests and 8 contract groups without runtime timing evidence. |
| `pnpm run test-proofs:check` | Failed | Twelve tests do not use the required `contractTest(contractId, title, ...)` registration path. |
| `pnpm run bench:smoke -- --live-preflight` | 6/6 passed | Benchmark construction and the dry-run live-preflight path are healthy. |
| `pnpm run bench:swe -- preflight` | Passed | SWE evaluator, Python, Docker, dataset, and OpenRouter prerequisites are available. |
| SWE and Terminal-Bench canary dry-runs | Passed | Canonical canary commands and their non-secret configuration are frozen below; no pilot attempt was consumed. |

These results do not satisfy the clean-baseline requirement because the working tree is dirty. They are retained as provisional evidence and must be rerun unchanged on the settled audit commit.

The audit failure is a governance/evidence finding rather than a token-efficiency score improvement. Until the registry and timing artifacts are complete, Kestrel cannot claim that its proof inventory is closed or compare token changes against a fully governed validation baseline.

## Live pilot manifest

The live pilot remains gated on a clean pinned commit and complete canary artifacts. It uses OpenRouter and the pinned canonical model/configuration without harness changes between runs.

| Wave | Task | Lane | Status |
|---|---|---|---|
| 1, 2 | `astropy__astropy-12907` | SWE-Verified | gated |
| 1, 2 | `django__django-14089` | SWE-Verified | gated |
| 1, 2 | `pylint-dev__pylint-4604` | SWE-Verified | gated |
| 1, 2 | `mwaskom__seaborn-3069` | SWE-Verified | gated |
| 1, 2 | `fix-git` | Terminal-Bench 2 | gated |
| 1, 2 | `prove-plus-comm` | Terminal-Bench 2 | gated |
| 1, 2 | `cobol-modernization` | Terminal-Bench 2 | gated |
| 1, 2 | `constraints-scheduling` | Terminal-Bench 2 | gated |

Wave 1 runs in listed order; Wave 2 runs in reverse. No third attempts are permitted. `astropy__astropy-12907` and `fix-git` are the canaries; the remaining paid runs stop if either lacks exact commit/model provenance, correlated IDs, base usage, official outcome, or complete artifacts.

### Candidate environment manifest

This environment is ready but not yet the official baseline because the worktree is dirty. These values must be captured again after the settled commit is selected; any difference is a baseline change, not an incidental detail.

| Field | Candidate value |
|---|---|
| Commit | `a16f819ea4c2def236e46d1acb94a719aa1ae357` |
| Branch | `asher/kestrel-one-dictation-thread-ui` (configured upstream is gone) |
| Host | `Darwin arm64` |
| Node / pnpm | `v22.15.0` / `9.12.2` |
| Python / Harbor | `3.11.6` / `0.13.2` |
| Docker client / server | `29.5.3` / `29.5.3` |
| Git | `2.52.0` |
| Provider / model | `openrouter` / `z-ai/glm-5.2` |
| Mode | `build` / `full_auto` |
| Guardrails | steps `2500`; tools `1000`; model calls `500`; step visits `750` |
| `pnpm-lock.yaml` SHA-256 | `16de94f744e36887d0a2d01ebc40c990271e37fbc09ba4950e45fdbbfe05fb50` |
| Provider-config SHA-256 | `b44471bd966f5da1a43905564201ee1df592a6260bb4578552be68c8acad7a6f` |
| SWE runner SHA-256 | `77ca877f3e7e7891391bdd7df99cbfee301aa73dca76c7e00ee90d2deffeb3f2` |
| Terminal-Bench runner SHA-256 | `3af18581101a2957cdb76cf2c2b531565a5ed936e334b86289b8bbcd0d1d2137` |

### Frozen attempt ledger

Every attempt runs sequentially. SWE uses the explicit run ID shown. Harbor generates its job directory; the audit records the unique new `jobs/<timestamp>/<task>__<trial>` path observed after each Terminal-Bench command. The model and benchmark configuration remain unchanged between attempts.

| # | Wave | Lane | Task | Run label / command | Status |
|---:|---:|---|---|---|---|
| 1 | 1 | SWE | `astropy__astropy-12907` | `pnpm run swe astropy__astropy-12907 --run-id audit-w1-astropy-12907` | gated canary |
| 2 | 1 | SWE | `django__django-14089` | `pnpm run swe django__django-14089 --run-id audit-w1-django-14089` | gated |
| 3 | 1 | SWE | `pylint-dev__pylint-4604` | `pnpm run swe pylint-dev__pylint-4604 --run-id audit-w1-pylint-4604` | gated |
| 4 | 1 | SWE | `mwaskom__seaborn-3069` | `pnpm run swe mwaskom__seaborn-3069 --run-id audit-w1-seaborn-3069` | gated |
| 5 | 1 | TB2 | `fix-git` | `pnpm run tb2 fix-git` | gated canary |
| 6 | 1 | TB2 | `prove-plus-comm` | `pnpm run tb2 prove-plus-comm` | gated |
| 7 | 1 | TB2 | `cobol-modernization` | `pnpm run tb2 cobol-modernization --artifact /app/program.py` | gated |
| 8 | 1 | TB2 | `constraints-scheduling` | `pnpm run tb2 constraints-scheduling` | gated |
| 9 | 2 | TB2 | `constraints-scheduling` | `pnpm run tb2 constraints-scheduling` | gated |
| 10 | 2 | TB2 | `cobol-modernization` | `pnpm run tb2 cobol-modernization --artifact /app/program.py` | gated |
| 11 | 2 | TB2 | `prove-plus-comm` | `pnpm run tb2 prove-plus-comm` | gated |
| 12 | 2 | TB2 | `fix-git` | `pnpm run tb2 fix-git` | gated |
| 13 | 2 | SWE | `mwaskom__seaborn-3069` | `pnpm run swe mwaskom__seaborn-3069 --run-id audit-w2-seaborn-3069` | gated |
| 14 | 2 | SWE | `pylint-dev__pylint-4604` | `pnpm run swe pylint-dev__pylint-4604 --run-id audit-w2-pylint-4604` | gated |
| 15 | 2 | SWE | `django__django-14089` | `pnpm run swe django__django-14089 --run-id audit-w2-django-14089` | gated |
| 16 | 2 | SWE | `astropy__astropy-12907` | `pnpm run swe astropy__astropy-12907 --run-id audit-w2-astropy-12907` | gated |

### Per-attempt acceptance contract

An attempt is never inferred from command exit alone. Each ledger row records exact baseline commit and configuration hashes; task and attempt identity; session/thread/run IDs; terminal status and classified failure; input/output/total tokens when present; action, maintenance, retry, compaction, and verification counts when present; elapsed time; patch or collected artifact identity; and the official evaluator/verifier outcome.

SWE completeness requires `job-input.json`, `job-output.json`, `workspace-baseline-report.json`, `workspace-patch-report.json`, `model.patch`, `predictions.jsonl`, evaluator output, and `evaluator-report.json`. Terminal-Bench completeness requires the Harbor trial `result.json`, verifier reward/test evidence, Kestrel adapter result, correlated IDs, agent/bridge logs, and requested task artifacts. Missing usage is recorded as `missing`, never zero. Infrastructure failures, runtime failures, completed-but-unresolved work, and accepted outcomes remain separate result classes.

## Completion checklist

- [x] Preserve all 94 check IDs and score every row in a first source/historical pass.
- [x] Keep runtime completion separate from official evaluator acceptance.
- [x] Identify P0 telemetry gaps rather than estimate missing usage.
- [ ] Re-run the source pass on a clean settled commit and record the exact baseline manifest.
- [x] Attach provisional benchmark-smoke, observability, and 309-test targeted probe results.
- [x] Run and attach the full deterministic validation leaves provisionally; record the contract-proof failures without suppressing them.
- [ ] Reproduce and disclose the twelve registration gaps and eight missing timing artifacts on the clean settled commit; remediation remains a separate follow-on project.
- [ ] Complete the 16-attempt live pilot or record an evidence-gate stop for every unrun attempt.
- [ ] Recompute weighted scores and validate all P0 rows in a second evidence pass.
- [ ] Finalize the highest-leverage findings without adding an implementation roadmap.
