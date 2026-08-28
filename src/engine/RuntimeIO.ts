import { randomUUID } from "node:crypto";

import type { RunEventType, RuntimeError } from "../kestrel/contracts/base.js";
import type { ProgressPhase, ProgressUpdateV1, RunToolPhase, RunToolUpdateV1 } from "../kestrel/contracts/events.js";
import type {
  AgentToolResultV2,
  RunToolUpdateV2,
  ToolExecutionOutcomeV1,
} from "../kestrel/contracts/tool-invocation.js";
import type { ToolActivationRefV1 } from "../kestrel/contracts/tool-contract.js";
import type { GuardrailConfig, RuntimeDependencies } from "../kestrel/contracts/execution.js";
import type { AgentToolResult, ModelGatewayStreamEvent, ModelRequest, ModelResponse, ModelUsage, ToolConsoleSink } from "../kestrel/contracts/model-io.js";
import { hashCanonical } from "../kestrel/contracts/tool-contract.js";
import { projectGmailMutationActivityInput } from "../apps/gmailMutation.js";
import { projectMicrosoft365TeamsReadAuditInput } from "../apps/microsoft365TeamsAudit.js";
import { projectMicrosoft365TeamsSendAuditInput } from "../apps/microsoft365TeamsSendAudit.js";
import { projectGoogleCalendarAuditInput } from "../apps/googleCalendarAudit.js";
import type { ProviderReasoningRetentionPolicy } from "../runtime/ProviderReasoningVault.js";
import {
  attributeModelCallPrice,
  buildModelRequestEconomicsManifest,
  buildToolResultEconomicsManifest,
  countTextTokens,
  createEconomicsLedgerEventMetadata,
  economicsRunEventType,
  normalizeEconomicsUsage,
  parseToolExposureSelectionV1,
  resolveModelTokenCounter,
} from "../economics/index.js";
import {
  parseContextSectionCandidatesV1,
  parseHarnessEconomicsControlV1,
  resolveModelEconomicsProfileV1,
} from "../economics/policy.js";
import type { ContextSectionCandidateV1, EconomicsModelCallRequestedV1, HarnessEconomicsControlV1, HarnessEconomicsPolicyV1, ModelEconomicsProfileV1 } from "../economics/contracts.js";

import type { Guardrails } from "./Guardrails.js";
import { type ToolJobQueue, ToolQueueOverflowError } from "./ToolJobQueue.js";
import {
  asPlainRecord,
  buildToolInputEventMetadata,
  hashUnknown,
  readModelBudgetClass,
  readModelRequestSchemaName,
  readNonEmptyString,
  readNumeric,
  readRequestedModelProvider,
} from "./ExecutionEngineSupport.js";
import { isDevShellLifecycleTool } from "../runtime/devshellLifecycle.js";
import {
  createToolConsoleBridge,
  emitDevShellConsoleStatus,
} from "./ExecutionEngineConsoleBridge.js";
import { RunCancelledError, createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import type { RuntimeEvaluationCoordinator } from "../evaluation/RuntimeEvaluationCoordinator.js";
import {
  ExecutionBoundaryPolicyRuntime,
  type LiveExecutionBoundaryStream,
} from "../security/ExecutionBoundaryPolicy.js";
import type { ExecutionBoundaryDecisionV1 } from "../kestrel/contracts/execution-boundary-policy.js";
import type { ModelCallProofV1 } from "../kestrel/contracts/orchestration.js";
import { deleteTextArtifact } from "../../tools/runtime/artifactStore.js";
import { replaceAgentToolResultOutput } from "../../tools/toolResult.js";
import {
  type EffectiveModelContractV1,
  type EffectiveModelContractResolverV1,
  type EffectiveModelPreSpendEvidenceV1,
} from "../kestrel/effective-model-contract.js";

interface RuntimeIOProgressContext {
  runId: string;
  sessionId: string;
  stepIndex: number;
  stepAgent: string;
  phase: ProgressPhase;
  signal?: AbortSignal | undefined;
  sequence: () => number;
}

interface RuntimeIOLogEntry {
  runId: string;
  sessionId: string;
  eventName: string;
  metadata?: Record<string, unknown> | undefined;
  stepIndex?: number | undefined;
}

interface RuntimeIOCallToolInput {
  preparedToolCall: import("../kestrel/contracts/tool-invocation.js").PreparedToolCallV1;
  sessionId: string;
  runId: string;
  stepIndex: number;
  stepAgent: string;
  runtimeMetadata: Record<string, unknown> | undefined;
  runtimePayload: Record<string, unknown> | undefined;
  sessionState: Record<string, unknown>;
  signal?: AbortSignal | undefined;
  console?: ToolConsoleSink | undefined;
}

interface RuntimeIOPersistPromptDumpInput {
  callId: string;
  progress: { runId: string; sessionId: string; stepIndex: number; stepAgent: string; phase: string };
  request: ModelRequest;
  providerRequest: ModelRequest;
  requestedModel: string | undefined;
  requestedProvider: string | undefined;
  modelRole: string | undefined;
  turnId: string | undefined;
  threadId: string | undefined;
  assemblyId: string | undefined;
  providerPayloadHash: string;
  componentHash: string;
  toolManifestHash: string | undefined;
  createdAt: string;
}

interface RuntimeIOPersistResponseDumpInput {
  promptDump: { jsonPath: string } | undefined;
  callId: string;
  progress: { runId: string; sessionId: string; stepIndex: number };
  status: "COMPLETED" | "FAILED";
  completedAt: string;
  latencyMs: number;
  response?: unknown;
  error?: RuntimeError | undefined;
}

interface RuntimeIOOptions {
  deps: Pick<
    RuntimeDependencies,
    "store" | "modelGateway" | "toolGateway" | "consoleReporter"
  > & Partial<Pick<RuntimeDependencies, "reasoningReporter" | "providerReasoningVault" | "effectiveModelContractResolver">>;
  guardrailConfig: GuardrailConfig;
  toolJobQueue: ToolJobQueue;
  toolQueueEnabled: boolean;
  guardrails: Guardrails;
  progress: RuntimeIOProgressContext;
  getSessionState: () => Record<string, unknown>;
  runtimeMetadata: Record<string, unknown> | undefined;
  runtimePayload: Record<string, unknown> | undefined;
  emitProgressFromSequence: (
    input: Omit<ProgressUpdateV1, "version" | "ts">,
  ) => Promise<void>;
  appendRunEvent: (
    runId: string,
    sessionId: string,
    type: RunEventType,
    level: "INFO" | "WARN" | "ERROR",
    metadata?: Record<string, unknown> | undefined,
    stepIndex?: number | undefined,
  ) => Promise<void>;
  logInfo: (entry: RuntimeIOLogEntry) => Promise<void>;
  logWarn: (entry: RuntimeIOLogEntry) => Promise<void>;
  withProgressHeartbeat: <T>(
    options: {
      runId: string;
      sessionId: string;
      stepIndex?: number | undefined;
      stepAgent?: string | undefined;
      phase: ProgressPhase;
      sequence: () => number;
      message: string;
    },
    work: () => Promise<T>,
  ) => Promise<T>;
  mapError: (error: unknown) => RuntimeError;
  buildModelTimeoutMetadata: (
    sessionState: Record<string, unknown>,
    progress: {
      runId: string;
      sessionId: string;
      stepIndex: number;
      stepAgent: string;
      phase: ProgressPhase;
    },
    request: ModelRequest,
    runtimeBudgetRemainingMs: number,
  ) => Record<string, unknown>;
  summarizePromptInput: (request: ModelRequest) => Record<string, unknown>;
  persistModelPromptDump: (
    input: RuntimeIOPersistPromptDumpInput,
  ) => Promise<{ jsonPath: string } | undefined>;
  persistModelResponseDump: (
    input: RuntimeIOPersistResponseDumpInput,
  ) => Promise<void>;
  extractModelUsage: (value: unknown) => ModelUsage | undefined;
  extractModelMetadata: (value: unknown) => Record<string, unknown> | undefined;
  callTool: (input: RuntimeIOCallToolInput) => Promise<AgentToolResultV2>;
  afterToolResult: (input: {
    runId: string;
    sessionId: string;
    toolName: string;
    toolInput: unknown;
    result: unknown;
    sessionState: Record<string, unknown>;
  }) => Promise<void>;
  isRetryableToolError: (error: unknown) => boolean;
  evaluationCoordinator?: RuntimeEvaluationCoordinator | undefined;
  executionBoundaryRuntime: ExecutionBoundaryPolicyRuntime;
}

export class RuntimeIO {
  private readonly options: RuntimeIOOptions;
  private previousStablePrefixHash: string | undefined;
  private readonly modelReasoningStreams = new Map<string, LiveExecutionBoundaryStream>();

  constructor(options: RuntimeIOOptions) {
    this.options = options;
  }

  async model<T>(request: ModelRequest): Promise<T> {
    const { guardrails, progress } = this.options;
    throwIfRuntimeIOAborted(progress.signal);
    const sessionState = this.options.getSessionState();
    const budget = guardrails.budgetSnapshot();
    const toolRunContext = {
      runId: progress.runId,
      sessionId: progress.sessionId,
      payload: this.options.runtimePayload ?? {},
      sessionState,
    };
    const startedAt = Date.now();
    const startSeq = progress.sequence();
    const requestMetadata = asPlainRecord(request.metadata) ?? {};
    const requestedModel = typeof request.model === "string" ? request.model : undefined;
    const requestedProvider = readRequestedModelProvider(request);
    const modelBudgetClass = readModelBudgetClass(request);
    const requestedPhase =
      typeof requestMetadata.phase === "string" && requestMetadata.phase.trim().length > 0
        ? requestMetadata.phase
        : progress.phase;
    const modelRole =
      typeof requestMetadata.modelRole === "string" && requestMetadata.modelRole.trim().length > 0
        ? requestMetadata.modelRole
        : undefined;
    const lifecycleMetadata = readModelLifecycleMetadata(requestMetadata);
    await this.options.emitProgressFromSequence({
      runId: progress.runId,
      sessionId: progress.sessionId,
      seq: startSeq,
      kind: "stage",
      phase: progress.phase,
      code: "MODEL_CALL_STARTED",
      message: `Calling decision model${request.model !== undefined ? ` (${request.model})` : ""}...`,
      stepIndex: progress.stepIndex,
      stepAgent: progress.stepAgent,
      persist: true,
    });
    const timeoutMetadata = this.options.buildModelTimeoutMetadata(
      sessionState,
      progress,
      request,
      budget.remainingMs,
    );
    const callId = randomUUID();
    let providerRequest: ModelRequest = {
      ...request,
      metadata: {
        ...(request.metadata ?? {}),
        runtimeBudgetRemainingMs: budget.remainingMs,
        ...timeoutMetadata,
      },
    };
    const runtimeAssembly = asPlainRecord(this.options.runtimeMetadata?.runtimeAssembly);
    const economicsControl = readHarnessEconomicsControl(runtimeAssembly);
    const economicsModelProfile = requestedProvider !== undefined && requestedModel !== undefined && economicsControl !== undefined
      ? resolveModelEconomicsProfileV1(economicsControl, requestedProvider, requestedModel)
      : undefined;
    const economicsPolicy = economicsControl?.policy;
    providerRequest = applyCachePolicy(providerRequest, economicsPolicy, economicsModelProfile);
    let economicsContextSections = requestMetadata.contextSections !== undefined
      ? parseContextSectionCandidatesV1(requestMetadata.contextSections)
      : undefined;
    const contextApplication = applyEconomicsContextPolicy({
      request: providerRequest,
      contextSections: economicsContextSections,
      contextPipeline: requestMetadata.contextPipeline,
      policy: economicsPolicy,
      modelProfile: economicsModelProfile,
      phase: requestedPhase,
      toolExposureSelection: requestMetadata.economicsToolExposureSelection,
    });
    providerRequest = contextApplication.request;
    economicsContextSections = contextApplication.contextSections;
    const turnId = readNonEmptyString(
      this.options.runtimeMetadata?.turnId ?? this.options.runtimeMetadata?.activeTurnId,
    );
    const threadId = readNonEmptyString(this.options.runtimeMetadata?.threadId);
    const reasoningRetention = readProviderReasoningRetention(requestMetadata.reasoningRetention);
    const reasoningRetentionScope = readNonEmptyString(requestMetadata.reasoningRetentionScope) ?? "default";
    const reasoningContext = {
      runId: progress.runId,
      sessionId: progress.sessionId,
      ...(turnId !== undefined ? { turnId } : {}),
      ...(requestedProvider !== undefined ? { provider: requestedProvider } : {}),
      ...(requestedModel !== undefined ? { model: requestedModel } : {}),
      retentionScope: reasoningRetentionScope,
      retention: reasoningRetention,
    };
    if (this.options.deps.providerReasoningVault !== undefined) {
      providerRequest = await this.options.deps.providerReasoningVault.prepareRequest(
        providerRequest,
        reasoningContext,
      );
    }
    const providerBoundary = await this.options.executionBoundaryRuntime.evaluateAndPersist<ModelRequest>({
      boundary: "model_request",
      identity: {
        runId: progress.runId,
        sessionId: progress.sessionId,
        callId,
        stepIndex: progress.stepIndex,
      },
      source: "runtime",
      trust: "data",
      sourceId: `model-request:${callId}`,
      value: providerRequest,
      persist: (decision) => this.persistBoundaryDecision(decision),
    });
    providerRequest = providerBoundary.value;
    const toolSurfaceSnapshot =
      Array.isArray(providerRequest.tools) && providerRequest.tools.length > 0
        ? await this.options.deps.toolGateway.createToolSurfaceSnapshot({
            runContext: toolRunContext,
            toolNames: providerRequest.tools.map(
              (tool) => tool.runtimeName ?? tool.name,
            ),
          })
        : undefined;
    const assemblyId =
      readNonEmptyString(runtimeAssembly?.effectiveAssemblyId) ??
      readNonEmptyString(runtimeAssembly?.bundleId);
    let providerPayloadHash = hashUnknown(providerRequest);
    const componentHash = hashUnknown({
      model: requestedModel,
      provider: requestedProvider,
      responseFormat: request.responseFormat,
      responseSchema: request.responseSchema,
      providerOptions: request.providerOptions,
      messageContentHashes: Array.isArray(request.messages)
        ? request.messages.map((message) => ({
            role: message.role,
            contentHash: hashUnknown(message.content),
          }))
        : [],
      inputHash: hashUnknown(request.input),
      toolManifestHash: Array.isArray(request.tools) ? hashUnknown(request.tools) : undefined,
      assemblyId,
      turnId,
      threadId,
    });
    const toolManifestHash = Array.isArray(request.tools) ? hashUnknown(request.tools) : undefined;
    const preSpendEvidence = await describeModelPreSpendEvidence(
      this.options.deps.effectiveModelContractResolver,
      providerRequest,
    );
    const requestEconomicsManifest = buildModelRequestEconomicsManifest({
      request: providerRequest,
      ...(economicsContextSections !== undefined
        ? { contextSections: economicsContextSections }
        : {}),
      ...(economicsPolicy !== undefined ? { policy: economicsPolicy } : {}),
      ...(economicsModelProfile !== undefined ? { modelProfile: economicsModelProfile } : {}),
      phase: requestedPhase,
      ...(requestMetadata.economicsToolExposureSelection !== undefined
        ? { toolExposureSelection: parseToolExposureSelectionV1(requestMetadata.economicsToolExposureSelection) }
        : {}),
    });
    const stablePrefix = buildStablePrefixRecord(providerRequest, economicsPolicy, economicsModelProfile, this.previousStablePrefixHash);
    this.previousStablePrefixHash = stablePrefix.stablePrefixHash;
    const modelRequestMetadata: Record<string, unknown> = {
      callId,
      stepAgent:
        typeof requestMetadata.stepAgent === "string" && requestMetadata.stepAgent.trim().length > 0
          ? requestMetadata.stepAgent
          : progress.stepAgent,
      phase: requestedPhase,
      enginePhase: progress.phase,
      requestedModel,
      model: requestedModel,
      ...(requestedProvider !== undefined ? { provider: requestedProvider } : {}),
      ...(modelRole !== undefined ? { modelRole } : {}),
      modelBudgetClass,
      ...lifecycleMetadata,
      responseFormat: request.responseFormat,
      schemaName: readModelRequestSchemaName(request),
      providerPayloadHash,
      componentHash,
      ...(toolManifestHash !== undefined ? { toolManifestHash } : {}),
      ...(assemblyId !== undefined ? { assemblyId } : {}),
      ...(turnId !== undefined ? { turnId } : {}),
      ...(threadId !== undefined ? { threadId } : {}),
      promptSummary: this.options.summarizePromptInput(providerRequest),
      ...(toolSurfaceSnapshot === undefined
        ? {}
        : { toolSurfaceSnapshot }),
    };
    const promptDump = await this.options.persistModelPromptDump({
      callId,
      progress,
      request: redactModelRequestForDiagnostics(providerRequest),
      providerRequest: redactModelRequestForDiagnostics(providerRequest),
      requestedModel,
      requestedProvider,
      modelRole,
      turnId,
      threadId,
      assemblyId,
      providerPayloadHash,
      componentHash,
      toolManifestHash,
      createdAt: new Date(startedAt).toISOString(),
    });
    if (promptDump !== undefined) {
      modelRequestMetadata.promptDump = promptDump;
    }
    await this.options.deps.store.appendModelCallProvenance?.({
      callId,
      runId: progress.runId,
      sessionId: progress.sessionId,
      ...(threadId !== undefined ? { threadId } : {}),
      ...(turnId !== undefined ? { turnId } : {}),
      stepIndex: progress.stepIndex,
      stepAgent: progress.stepAgent,
      phase: requestedPhase,
      ...(requestedModel !== undefined ? { model: requestedModel } : {}),
      ...(requestedProvider !== undefined ? { provider: requestedProvider } : {}),
      responseFormat: request.responseFormat ?? "text",
      ...(readModelRequestSchemaName(request) !== undefined
        ? { schemaName: readModelRequestSchemaName(request) }
        : {}),
      providerPayloadHash,
      componentHash,
      ...(toolManifestHash !== undefined ? { toolManifestHash } : {}),
      ...(assemblyId !== undefined ? { assemblyId } : {}),
      proof: createPendingModelCallProof(preSpendEvidence),
      metadata: {
        promptRetention: "hash_only",
        ...(modelRole !== undefined ? { modelRole } : {}),
        modelBudgetClass,
        ...lifecycleMetadata,
        messageCount: Array.isArray(request.messages) ? request.messages.length : 0,
        toolCount: Array.isArray(request.tools) ? request.tools.length : 0,
        ...(toolSurfaceSnapshot === undefined
          ? {}
          : { toolSurfaceSnapshot }),
        ...(promptDump !== undefined ? { promptDump } : {}),
      },
      createdAt: new Date(startedAt).toISOString(),
      status: "REQUESTED",
    });
    let effectiveAdmission:
      | { request: ModelRequest; contract: EffectiveModelContractV1 }
      | undefined;
    try {
      effectiveAdmission =
        this.options.deps.effectiveModelContractResolver === undefined
          ? undefined
          : await this.options.deps.effectiveModelContractResolver.admit({
              request: providerRequest,
            });
      if (effectiveAdmission !== undefined) {
        providerRequest = effectiveAdmission.request;
        providerPayloadHash = hashUnknown(providerRequest);
      }
      await this.options.deps.store.updateModelCallProvenance?.({
        callId,
        status: "REQUESTED",
        providerPayloadHash,
        proof: createAdmittedModelCallProof(effectiveAdmission?.contract, providerRequest),
      });
    } catch (error) {
      const mappedAdmissionError = this.options.mapError(error);
      const completedAt = new Date().toISOString();
      await this.options.deps.store.updateModelCallProvenance?.({
        callId,
        status: "FAILED",
        completedAt,
        latencyMs: Date.now() - startedAt,
        proof: createPreSpendRejectedModelCallProof(mappedAdmissionError, preSpendEvidence?.contract, preSpendEvidence?.request),
        metadata: {
          promptRetention: "hash_only",
          ...(modelRole !== undefined ? { modelRole } : {}),
          modelBudgetClass,
          ...lifecycleMetadata,
          error: mappedAdmissionError.code,
        },
      });
      throw error;
    }
    await this.options.appendRunEvent(
      progress.runId,
      progress.sessionId,
      "model.provenance",
      "INFO",
      {
        callId,
        providerPayloadHash,
        componentHash,
        promptRetention: "hash_only",
        ...(modelRole !== undefined ? { modelRole } : {}),
        modelBudgetClass,
        ...lifecycleMetadata,
        ...(promptDump !== undefined ? { promptDump } : {}),
        ...(turnId !== undefined ? { turnId } : {}),
        ...(threadId !== undefined ? { threadId } : {}),
        ...(assemblyId !== undefined ? { assemblyId } : {}),
        ...(toolSurfaceSnapshot === undefined
          ? {}
          : { toolSurfaceSnapshot }),
      },
      progress.stepIndex,
    );
    await this.appendEconomicsEvent({
      kind: "model_call.requested",
      callId,
      providerPayloadHash,
      componentHash,
      ...(toolManifestHash !== undefined ? { toolManifestHash } : {}),
      ...(requestedProvider !== undefined ? { provider: requestedProvider } : {}),
      ...(requestedModel !== undefined ? { model: requestedModel } : {}),
      modelBudgetClass,
      phase: requestedPhase,
      ...(assemblyId !== undefined ? { assemblyId } : {}),
      ...(readNonEmptyString(runtimeAssembly?.contextPolicyId) !== undefined
        ? { contextPolicyId: readNonEmptyString(runtimeAssembly?.contextPolicyId) }
        : {}),
      ...(economicsModelProfile !== undefined ? { modelProfileId: economicsModelProfile.profileId } : {}),
      ...(economicsControl !== undefined
        ? { economicsControlHash: hashUnknown(economicsControl), economicsControl }
        : {}),
      cache: stablePrefix,
      requestManifest: requestEconomicsManifest,
    });
    await this.options.appendRunEvent(
      progress.runId,
      progress.sessionId,
      "model.requested",
      "INFO",
      modelRequestMetadata,
      progress.stepIndex,
    );
    await this.options.logInfo({
      runId: progress.runId,
      sessionId: progress.sessionId,
      eventName: "model_requested",
      metadata: modelRequestMetadata,
      stepIndex: progress.stepIndex,
    });
    const heartbeatMessage = "Still working on model response...";
    try {
      throwIfRuntimeIOAborted(progress.signal);
      assertEconomicsRequestAdmission(economicsPolicy, requestEconomicsManifest);
      const recoveredResult = await this.options.withProgressHeartbeat(
        {
          runId: progress.runId,
          sessionId: progress.sessionId,
          stepIndex: progress.stepIndex,
          stepAgent: progress.stepAgent,
          phase: progress.phase,
          sequence: progress.sequence,
          message: heartbeatMessage,
        },
        () => this.callModelWithRecovery<T>({
          request: providerRequest,
          effectiveModelContract: effectiveAdmission?.contract,
          callId,
          requestedProvider,
          requestedModel,
        }),
      );
      // The provider request has completed at this boundary. Capture only its
      // safe usage and pricing evidence before cancellation can stop response
      // consumption and all later work.
      const modelUsage = this.options.extractModelUsage(recoveredResult);
      const economicsUsage = normalizeEconomicsUsage(modelUsage);
      guardrails.onModelUsage(modelUsage);
      const modelMetadata = this.options.extractModelMetadata(recoveredResult);
      const actualProvider = readNonEmptyString(modelMetadata?.provider) ?? requestedProvider;
      const actualModel = readNonEmptyString(modelMetadata?.model) ?? requestedModel;
      const actualEconomicsModelProfile = actualProvider !== undefined && actualModel !== undefined && economicsControl !== undefined
        ? resolveModelEconomicsProfileV1(economicsControl, actualProvider, actualModel)
        : economicsModelProfile;
      const pricing = attributeModelCallPrice({
        usage: economicsUsage,
        profile: actualEconomicsModelProfile,
        provider: actualProvider,
        model: actualModel,
      });
      guardrails.onModelCost(pricing.status === "priced" ? pricing.totalCostUsd : undefined);
      throwIfRuntimeIOAborted(progress.signal);
      const responseBoundary = await this.options.executionBoundaryRuntime.evaluateAndPersist<T>({
        boundary: "model_action",
        identity: {
          runId: progress.runId,
          sessionId: progress.sessionId,
          callId,
          stepIndex: progress.stepIndex,
        },
        source: "model",
        trust: "data",
        sourceId: `model-response:${callId}`,
        value: recoveredResult as T,
        persist: (decision) => this.persistBoundaryDecision(decision),
      });
      let result = responseBoundary.value;
      if (toolSurfaceSnapshot !== undefined && isModelResponse(result)) {
        const toolIntentCount = result.toolIntents.length;
        result = {
          ...result,
          toolIntents: result.toolIntents.map((intent) => ({
            ...intent,
            toolSurfaceSnapshot,
          })),
        } as T;
        if (toolIntentCount === 0) {
          await this.options.deps.toolGateway.releaseToolSurfaceSnapshot?.(
            toolSurfaceSnapshot.snapshotId,
          );
        }
      } else if (toolSurfaceSnapshot !== undefined) {
        await this.options.deps.toolGateway.releaseToolSurfaceSnapshot?.(
          toolSurfaceSnapshot.snapshotId,
        );
      }
      if (this.options.deps.providerReasoningVault !== undefined && isModelResponse(result)) {
        await this.options.deps.providerReasoningVault.captureResponse(result, reasoningContext);
      }
      const completedAt = new Date().toISOString();
      const latencyMs = Date.now() - startedAt;
      await this.options.persistModelResponseDump({
        promptDump,
        callId,
        progress,
        status: "COMPLETED",
        completedAt,
        latencyMs,
        response: redactModelResponseForDiagnostics(result),
      });
      await this.options.deps.store.updateModelCallProvenance?.({
        callId,
        status: "COMPLETED",
        completedAt,
        latencyMs,
        proof: createCompletedModelCallProof(effectiveAdmission?.contract, providerRequest, result),
        metadata: {
          promptRetention: "hash_only",
          ...(modelRole !== undefined ? { modelRole } : {}),
          modelBudgetClass,
          ...lifecycleMetadata,
          ...(promptDump !== undefined ? { promptDump } : {}),
          ...(modelUsage !== undefined ? { usage: modelUsage } : {}),
        },
      });
      await this.appendEconomicsEvent({
        kind: "model_call.completed",
        callId,
        ...(actualProvider !== undefined ? { provider: actualProvider } : {}),
        ...(actualModel !== undefined ? { model: actualModel } : {}),
        latencyMs,
        usage: economicsUsage,
        providerReportedInputDeltaTokens: economicsUsage.inputTokens - requestEconomicsManifest.requestCount.tokens,
        pricing,
      });
      await this.options.appendRunEvent(
        progress.runId,
        progress.sessionId,
        "model.completed",
        "INFO",
        {
          callId,
          stepAgent:
            typeof requestMetadata.stepAgent === "string" && requestMetadata.stepAgent.trim().length > 0
              ? requestMetadata.stepAgent
              : progress.stepAgent,
          phase: requestedPhase,
          enginePhase: progress.phase,
          requestedModel,
          ...(requestedProvider !== undefined ? { provider: requestedProvider } : {}),
          ...(modelRole !== undefined ? { modelRole } : {}),
          modelBudgetClass,
          ...lifecycleMetadata,
          ...(modelMetadata ?? {}),
          ...(modelUsage !== undefined ? { usage: modelUsage } : {}),
        },
        progress.stepIndex,
      );
      await this.options.emitProgressFromSequence({
        runId: progress.runId,
        sessionId: progress.sessionId,
        seq: progress.sequence(),
        kind: "stage",
        phase: progress.phase,
        code: "MODEL_CALL_DONE",
        message: `Model response received${request.model !== undefined ? ` from ${request.model}` : ""} in ${Date.now() - startedAt}ms.`,
        stepIndex: progress.stepIndex,
        stepAgent: progress.stepAgent,
        persist: true,
      });
      return result;
    } catch (error) {
      if (toolSurfaceSnapshot !== undefined) {
        await this.options.deps.toolGateway.releaseToolSurfaceSnapshot?.(
          toolSurfaceSnapshot.snapshotId,
        );
      }
      const mappedErrorBoundary = await this.options.executionBoundaryRuntime.evaluateAndPersist<RuntimeError>({
        boundary: "model_action",
        identity: {
          runId: progress.runId,
          sessionId: progress.sessionId,
          callId,
          stepIndex: progress.stepIndex,
        },
        source: "model",
        trust: "data",
        sourceId: `model-error:${callId}`,
        value: this.options.mapError(error),
        persist: (decision) => this.persistBoundaryDecision(decision),
      });
      const mappedError = mappedErrorBoundary.value;
      const completedAt = new Date().toISOString();
      const latencyMs = Date.now() - startedAt;
      await this.options.persistModelResponseDump({
        promptDump,
        callId,
        progress,
        status: "FAILED",
        completedAt,
        latencyMs,
        error: mappedError,
      });
      await this.options.deps.store.updateModelCallProvenance?.({
        callId,
        status: "FAILED",
        completedAt,
        latencyMs,
        proof: isPreSpendModelFailure(mappedError.code)
          ? createPreSpendRejectedModelCallProof(mappedError, effectiveAdmission?.contract, providerRequest)
          : createFailedModelCallProof(effectiveAdmission?.contract, providerRequest, mappedError),
        metadata: {
          promptRetention: "hash_only",
          ...(modelRole !== undefined ? { modelRole } : {}),
          modelBudgetClass,
          ...lifecycleMetadata,
          ...(promptDump !== undefined ? { promptDump } : {}),
          error: mappedError.code,
        },
      });
      await this.appendEconomicsEvent({
        kind: "model_call.failed",
        callId,
        latencyMs,
        failureCode: mappedError.code,
        failureClass: readNonEmptyString(asPlainRecord(mappedError.details)?.classification) ?? "unclassified",
      }, "WARN");
      await this.options.emitProgressFromSequence({
        runId: progress.runId,
        sessionId: progress.sessionId,
        seq: progress.sequence(),
        kind: "stage",
        phase: progress.phase,
        code: "MODEL_CALL_FAILED",
        message: "Model call failed.",
        stepIndex: progress.stepIndex,
        stepAgent: progress.stepAgent,
        persist: true,
      });
      throw mappedErrorBoundary.decision.outcome === "REDACT"
        ? createRuntimeFailure(
            mappedError.code,
            mappedError.message,
            mappedError.details,
          )
        : error;
    }
  }

  private async callModelWithRecovery<T>(input: {
    request: ModelRequest;
    effectiveModelContract?: import("../kestrel/effective-model-contract.js").EffectiveModelContractV1 | undefined;
    callId: string;
    requestedProvider: string | undefined;
    requestedModel: string | undefined;
  }): Promise<T> {
    try {
      return await this.options.deps.modelGateway.call<T>(input.request, {
        ...(input.effectiveModelContract !== undefined
          ? { effectiveModelContract: input.effectiveModelContract }
          : {}),
        ...(this.options.progress.signal !== undefined
          ? { signal: this.options.progress.signal }
          : {}),
        ...(readModelBudgetClass(input.request) === "maintenance"
          ? { retryCount: 0 }
          : {}),
        onEvent: async (event) => {
          await this.emitModelGatewayEvent(event, {
            callId: input.callId,
            provider: input.requestedProvider,
            model: input.requestedModel,
          });
        },
      });
    } finally {
      this.discardModelReasoningStreams(input.callId);
    }
  }

  private async appendEconomicsEvent(
    draft: Parameters<typeof createEconomicsLedgerEventMetadata>[0],
    level: "INFO" | "WARN" | "ERROR" = "INFO",
  ): Promise<void> {
    const metadata = createEconomicsLedgerEventMetadata(draft);
    await this.options.appendRunEvent(
      this.options.progress.runId,
      this.options.progress.sessionId,
      economicsRunEventType(metadata.kind),
      level,
      { ...metadata },
      this.options.progress.stepIndex,
    );
  }

  private async emitModelGatewayEvent(
    event: ModelGatewayStreamEvent,
    model: { callId: string; provider?: string | undefined; model?: string | undefined },
  ): Promise<void> {
    const progress = this.options.progress;
    if (event.type === "attempt.started") {
      await this.appendEconomicsEvent({
        kind: "model_attempt.started",
        callId: model.callId,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        ...(model.provider !== undefined ? { provider: model.provider } : {}),
        ...(model.model !== undefined ? { model: model.model } : {}),
      });
      await this.options.emitProgressFromSequence({
        runId: progress.runId,
        sessionId: progress.sessionId,
        seq: progress.sequence(),
        kind: "stage",
        phase: progress.phase,
        code: "MODEL_ATTEMPT_STARTED",
        message: `Provider attempt ${event.attempt}/${event.maxAttempts} started.`,
        stepIndex: progress.stepIndex,
        stepAgent: progress.stepAgent,
        persist: false,
      });
    } else if (event.type === "attempt.completed") {
      await this.appendEconomicsEvent({
        kind: "model_attempt.completed",
        callId: model.callId,
        attempt: event.attempt,
        latencyMs: event.latencyMs,
      });
    } else if (event.type === "attempt.failed") {
      await this.appendEconomicsEvent({
        kind: "model_attempt.failed",
        callId: model.callId,
        attempt: event.attempt,
        latencyMs: event.latencyMs,
        ...(event.failureCode !== undefined ? { failureCode: event.failureCode } : {}),
        failureClass: event.failureClass ?? "unclassified",
        retryable: event.retryable,
        willRetry: event.willRetry,
        visibleOutputStarted: event.visibleOutputStarted,
        ...(event.retryDelayMs !== undefined ? { retryDelayMs: event.retryDelayMs } : {}),
      }, "WARN");
      if (event.willRetry) {
        const retryDelay =
          event.retryDelayMs === undefined
            ? ""
            : ` in ${event.retryDelayMs} ms`;
        await this.options.emitProgressFromSequence({
          runId: progress.runId,
          sessionId: progress.sessionId,
          seq: progress.sequence(),
          kind: "stage",
          phase: progress.phase,
          code: "MODEL_ATTEMPT_RETRYING",
          message: `Provider attempt ${event.attempt}/${event.maxAttempts} failed; retrying${retryDelay}.`,
          stepIndex: progress.stepIndex,
          stepAgent: progress.stepAgent,
          persist: true,
        });
      }
    }
    await this.emitModelReasoningEvent(event, model.callId, model.provider, model.model);
  }

  private async emitModelReasoningEvent(
    event: ModelGatewayStreamEvent,
    callId: string,
    provider: string | undefined,
    model: string | undefined,
  ): Promise<void> {
    if (event.type !== "reasoning.started" && event.type !== "reasoning.delta" && event.type !== "reasoning.completed" && event.type !== "reasoning.failed" && event.type !== "reasoning.unavailable") {
      return;
    }
    const progress = this.options.progress;
    const streamKey = `${progress.runId}:${callId}:${event.attempt}:${event.format}`;
    if (event.type === "reasoning.started") {
      this.modelReasoningStreams.get(streamKey)?.discard();
      this.modelReasoningStreams.set(streamKey, this.openReasoningStream(streamKey, callId));
    }
    let safeDelta: string | undefined;
    if (event.type === "reasoning.delta") {
      const stream = this.modelReasoningStreams.get(streamKey) ??
        this.openReasoningStream(streamKey, callId);
      this.modelReasoningStreams.set(streamKey, stream);
      safeDelta = stream.push(event.delta);
      if (safeDelta.length === 0) return;
    }
    if (
      event.type === "reasoning.completed" ||
      event.type === "reasoning.failed" ||
      event.type === "reasoning.unavailable"
    ) {
      const stream = this.modelReasoningStreams.get(streamKey);
      const tail = stream?.close() ?? "";
      this.modelReasoningStreams.delete(streamKey);
      if (tail.length > 0) {
        await this.options.deps.reasoningReporter?.emit({
          version: "v1",
          runId: progress.runId,
          sessionId: progress.sessionId,
          ts: new Date().toISOString(),
          seq: progress.sequence(),
          event: "delta",
          attempt: event.attempt,
          format: event.format,
          delta: tail,
          contentState: "live",
          stepIndex: progress.stepIndex,
          stepAgent: progress.stepAgent,
          ...(provider !== undefined || model !== undefined
            ? { model: { ...(provider !== undefined ? { provider } : {}), ...(model !== undefined ? { model } : {}) } }
            : {}),
        });
      }
    }
    await this.options.deps.reasoningReporter?.emit({
      version: "v1",
      runId: progress.runId,
      sessionId: progress.sessionId,
      ts: new Date().toISOString(),
      seq: progress.sequence(),
      event: event.type === "reasoning.started"
        ? "started"
        : event.type === "reasoning.delta"
          ? "delta"
          : event.type === "reasoning.unavailable"
            ? "unavailable"
            : event.type === "reasoning.failed"
              ? "failed"
              : "completed",
      attempt: event.attempt,
      format: event.format,
      ...(event.type === "reasoning.delta" ? { delta: safeDelta ?? "" } : {}),
      contentState: "live",
      stepIndex: progress.stepIndex,
      stepAgent: progress.stepAgent,
      ...(provider !== undefined || model !== undefined ? { model: { ...(provider !== undefined ? { provider } : {}), ...(model !== undefined ? { model } : {}) } } : {}),
    });
  }

  private openReasoningStream(
    sourceId: string,
    callId: string,
  ): LiveExecutionBoundaryStream {
    const progress = this.options.progress;
    return this.options.executionBoundaryRuntime.openLiveStream({
      boundary: "model_stream",
      identity: {
        runId: progress.runId,
        sessionId: progress.sessionId,
        callId,
        stepIndex: progress.stepIndex,
      },
      source: "model",
      trust: "data",
      sourceId,
    });
  }

  private discardModelReasoningStreams(callId: string): void {
    const prefix = `${this.options.progress.runId}:${callId}:`;
    for (const [streamKey, stream] of this.modelReasoningStreams) {
      if (streamKey.startsWith(prefix) === false) continue;
      stream.discard();
      this.modelReasoningStreams.delete(streamKey);
    }
  }

  async tool(
    name: string,
    input: unknown,
    intent?: {
      modelToolCallId?: string | undefined;
      toolSurfaceSnapshot?: import("../kestrel/contracts/tool-contract.js").ToolSurfaceSnapshotV1 | undefined;
    },
  ): Promise<AgentToolResult> {
    const { guardrails, progress } = this.options;
    throwIfRuntimeIOAborted(progress.signal);
    const sessionState = this.options.getSessionState();
    guardrails.onToolCall(name);
    const startedAt = Date.now();
    const toolCallId = `tool:${progress.runId}:${randomUUID()}`;
    let recoverySourceInput = input;
    let queueDepthRun: number | undefined;
    let queueDepthGlobal: number | undefined;
    let queueWaitMs: number | undefined;
    let preparedToolCall: import("../kestrel/contracts/tool-invocation.js").PreparedToolCallV1 | undefined;
    let consoleBridge: ReturnType<typeof createToolConsoleBridge> | undefined;
    let toolConsoleStream: LiveExecutionBoundaryStream | undefined;
    const queueEventTasks: Promise<void>[] = [];
    try {
      const inputBoundary = await this.options.executionBoundaryRuntime.evaluateAndPersist({
        boundary: "tool_request",
        identity: {
          runId: progress.runId,
          sessionId: progress.sessionId,
          callId: toolCallId,
          stepIndex: progress.stepIndex,
        },
        source: "model",
        trust: "data",
        sourceId: `tool-request:${toolCallId}:${name}`,
        value: input,
        persist: (decision) => this.persistBoundaryDecision(decision),
      });
      if (inputBoundary.decision.outcome === "QUARANTINE") {
        throw createRuntimeFailure(
          "EXECUTION_BOUNDARY_QUARANTINED",
          `Tool '${name}' input contains registered sensitive material.`,
          {
            subsystem: "execution_boundary",
            boundary: "tool_request",
            decisionId: inputBoundary.decision.decisionId,
            recoverable: false,
          },
        );
      }
      const runContext = {
        runId: progress.runId,
        sessionId: progress.sessionId,
        payload: this.options.runtimePayload ?? {},
        sessionState,
      };
      const snapshot = intent?.toolSurfaceSnapshot ??
        await this.options.deps.toolGateway.createToolSurfaceSnapshot({
          runContext,
          toolNames: [name],
        });
      const activation = snapshot.tools.find(
        (candidate) => candidate.descriptor.toolId === name,
      );
      if (activation === undefined) {
        throw createRuntimeFailure(
          "TOOL_SNAPSHOT_LOOKUP_FAILED",
          `Tool '${name}' was not exposed in snapshot '${snapshot.snapshotId}'.`,
          { recoverable: false, toolName: name },
        );
      }
      const rawInput = asPlainRecord(inputBoundary.value);
      if (rawInput === undefined) {
        throw createRuntimeFailure(
          "TOOL_INPUT_SCHEMA_FAILED",
          `Tool '${name}' input must be an object.`,
          { recoverable: true, toolName: name },
        );
      }
      const origin = intent?.modelToolCallId !== undefined
        ? {
            kind: "model" as const,
            snapshotId: snapshot.snapshotId,
            modelToolCallId: intent.modelToolCallId,
          }
        : {
            kind: "trusted_runtime" as const,
            producerId: "runtime.step-io:v1",
            adapterId: "runtime.direct-tool:v1",
          };
      const prepared = await this.options.deps.toolGateway.prepareToolCall(
        {
          runId: progress.runId,
          sessionId: progress.sessionId,
          callId: toolCallId,
          activation,
          origin,
          rawInput,
          policy: {
            decision: "allow",
            policyRevision: inputBoundary.decision.policyRevision,
          },
        },
        {
          runContext,
          runtimeBudgetRemainingMs: guardrails.budgetSnapshot().remainingMs,
        },
      );
      preparedToolCall = prepared;
      const effectiveToolInput = prepared.effectiveInput;
      recoverySourceInput = effectiveToolInput;
      const activityToolInput = projectGmailMutationActivityInput(
        name,
        effectiveToolInput,
      ) ?? projectMicrosoft365TeamsReadAuditInput(
        name,
        effectiveToolInput,
      ) ?? projectMicrosoft365TeamsSendAuditInput(
        name,
        effectiveToolInput,
      ) ?? projectGoogleCalendarAuditInput(
        name,
        effectiveToolInput,
      ) ?? effectiveToolInput;
      const toolInputMetadata = {
        ...buildToolInputEventMetadata(activityToolInput),
        ...prepared.inputAdapters.reduce(
          (metadata, adapter) => ({ ...metadata, ...adapter.metadata }),
          {} as Record<string, unknown>,
        ),
        toolSurfaceSnapshotId: snapshot.snapshotId,
        toolContractRevision: activation.descriptor.contractRevision,
        registryGeneration: activation.registryGeneration,
      };
      await this.emitToolUpdate({
        phase: "started",
        toolCallId,
        toolName: name,
        input: activityToolInput,
        activation: prepared.activation,
      });
      await this.options.emitProgressFromSequence({
        runId: progress.runId,
        sessionId: progress.sessionId,
        seq: progress.sequence(),
        kind: "tool",
        phase: progress.phase,
        code: "TOOL_CALL_STARTED",
        message: `Calling tool '${name}'.`,
        stepIndex: progress.stepIndex,
        stepAgent: progress.stepAgent,
        tool: {
          name,
          status: "STARTED",
        },
        ...(queueDepthRun !== undefined ? { queueDepthRun } : {}),
        ...(queueDepthGlobal !== undefined ? { queueDepthGlobal } : {}),
        ...toolInputMetadata,
        persist: true,
      });
      await this.options.appendRunEvent(
        progress.runId,
        progress.sessionId,
        "tool.validated",
        "INFO",
        {
          tool: name,
          ...toolInputMetadata,
        },
        progress.stepIndex,
      );
      const activeConsoleBridge = createToolConsoleBridge({
        consoleReporter: this.options.deps.consoleReporter,
        runId: progress.runId,
        sessionId: progress.sessionId,
        stepIndex: progress.stepIndex,
        toolCallId,
        toolName: name,
        input: activityToolInput,
        sequence: progress.sequence,
        transformText: (text) => {
          toolConsoleStream ??= this.options.executionBoundaryRuntime.openLiveStream({
            boundary: "tool_stream",
            identity: {
              runId: progress.runId,
              sessionId: progress.sessionId,
              callId: toolCallId,
              stepIndex: progress.stepIndex,
            },
            source: "tool",
            trust: "data",
            sourceId: `tool-stream:${toolCallId}:${name}`,
          });
          return toolConsoleStream.push(text);
        },
        flushText: () => {
          const stream = toolConsoleStream;
          toolConsoleStream = undefined;
          return stream?.close() ?? "";
        },
      });
      consoleBridge = activeConsoleBridge;
      await activeConsoleBridge.emitStatus("started");
      const executeToolCall = () => {
        throwIfRuntimeIOAborted(progress.signal);
        return this.options.callTool({
          preparedToolCall: prepared,
          sessionId: progress.sessionId,
          runId: progress.runId,
          stepIndex: progress.stepIndex,
          stepAgent: progress.stepAgent,
          runtimeMetadata: this.options.runtimeMetadata,
          runtimePayload: this.options.runtimePayload,
          sessionState,
          signal: progress.signal,
          ...(activeConsoleBridge.sink !== undefined ? { console: activeConsoleBridge.sink } : {}),
        });
      };
      let result = this.options.toolQueueEnabled
          ? await this.options.withProgressHeartbeat(
            {
              runId: progress.runId,
              sessionId: progress.sessionId,
              stepIndex: progress.stepIndex,
              stepAgent: progress.stepAgent,
              phase: progress.phase,
              sequence: progress.sequence,
              message: `Still running tool '${name}'...`,
            },
            async () => {
              const queued = await this.options.toolJobQueue.enqueue<AgentToolResultV2>({
                runId: progress.runId,
                maxConcurrentPerRun: this.options.guardrailConfig.maxConcurrentToolJobsPerRun,
                maxConcurrentGlobal: this.options.guardrailConfig.maxConcurrentToolJobsGlobal,
                maxQueuedPerRun: this.options.guardrailConfig.maxQueuedToolJobsPerRun,
                maxQueuedGlobal: this.options.guardrailConfig.maxQueuedToolJobsGlobal,
                retryCount: isDevShellLifecycleTool(name) ? 0 : this.options.guardrailConfig.toolCallRetryCount,
                execute: executeToolCall,
                isRetryableError: (error) => this.options.isRetryableToolError(error),
                signal: progress.signal,
                onEnqueued: (meta) => {
                  queueDepthRun = meta.queueDepthRun;
                  queueDepthGlobal = meta.queueDepthGlobal;
                  queueEventTasks.push(
                    this.logToolQueueEvent({
                      runId: progress.runId,
                      sessionId: progress.sessionId,
                      stepIndex: progress.stepIndex,
                      eventName: "tool_queue_enqueued",
                      eventType: "tool.queue.enqueued",
                      level: "INFO",
                      metadata: {
                        tool: name,
                        ...toolInputMetadata,
                        queueDepthRun: meta.queueDepthRun,
                        queueDepthGlobal: meta.queueDepthGlobal,
                        aheadInRun: meta.aheadInRun,
                        aheadGlobal: meta.aheadGlobal,
                      },
                    }),
                  );
                },
                onDequeued: (meta) => {
                  queueDepthRun = meta.queueDepthRun;
                  queueDepthGlobal = meta.queueDepthGlobal;
                  queueWaitMs = meta.queueWaitMs;
                  queueEventTasks.push(
                    this.logToolQueueEvent({
                      runId: progress.runId,
                      sessionId: progress.sessionId,
                      stepIndex: progress.stepIndex,
                      eventName: "tool_queue_dequeued",
                      eventType: "tool.queue.dequeued",
                      level: "INFO",
                      metadata: {
                        tool: name,
                        ...toolInputMetadata,
                        queueDepthRun: meta.queueDepthRun,
                        queueDepthGlobal: meta.queueDepthGlobal,
                        queueWaitMs: meta.queueWaitMs,
                      },
                    }),
                  );
                },
                onRetry: (meta) => {
                  queueEventTasks.push(
                    this.logToolRetryEvent({
                      runId: progress.runId,
                      sessionId: progress.sessionId,
                      stepIndex: progress.stepIndex,
                      phase: progress.phase,
                      stepAgent: progress.stepAgent,
                      toolName: name,
                      attempt: meta.attempt,
                      maxAttempts: meta.maxAttempts,
                      error: meta.error,
                      sequence: progress.sequence,
                    }),
                  );
                },
              });
              queueDepthRun = queued.queueDepthRun;
              queueDepthGlobal = queued.queueDepthGlobal;
              queueWaitMs = queued.queueWaitMs;
              return queued.result;
            },
          )
          : await this.options.withProgressHeartbeat(
            {
              runId: progress.runId,
              sessionId: progress.sessionId,
              stepIndex: progress.stepIndex,
              stepAgent: progress.stepAgent,
              phase: progress.phase,
              sequence: progress.sequence,
              message: `Still running tool '${name}'...`,
            },
            executeToolCall,
          );
      const originalRawOutputRef = result.modelContext.rawOutputRef;
      const resultBoundary = await this.options.executionBoundaryRuntime.evaluateAndPersist<AgentToolResultV2>({
        boundary: "tool_result",
        identity: {
          runId: progress.runId,
          sessionId: progress.sessionId,
          callId: toolCallId,
          stepIndex: progress.stepIndex,
        },
        source: "tool",
        trust: "data",
        sourceId: `tool-result:${toolCallId}:${name}`,
        value: result,
        persist: (decision) => this.persistBoundaryDecision(decision),
      });
      if (resultBoundary.decision.outcome === "REDACT") {
        deleteTextArtifact(originalRawOutputRef);
        const redactedResult = resultBoundary.value;
        const rebuilt = replaceAgentToolResultOutput(
          redactedResult,
          redactedResult.auditRecord.output,
        );
        if (rebuilt.projections?.durableRawArtifactRef !== undefined) {
          const { durableRawArtifactRef: _removed, ...safeProjections } = rebuilt.projections;
          result = { ...rebuilt, projections: safeProjections } as AgentToolResultV2;
        } else {
          result = rebuilt as AgentToolResultV2;
        }
      }

      if (queueEventTasks.length > 0) {
        await Promise.all(queueEventTasks);
      }

      await this.options.afterToolResult({
        runId: progress.runId,
        sessionId: progress.sessionId,
        toolName: name,
        toolInput: effectiveToolInput,
        result,
        sessionState,
      });
      if (
        this.options.evaluationCoordinator?.matchesHook("after_tool", name) ===
        true
      ) {
        const evaluationState = asPlainRecord(
          asPlainRecord(asPlainRecord(sessionState.agent)?.exec)?.evaluation,
        );
        await this.options.evaluationCoordinator.evaluateHook({
          runId: progress.runId,
          sessionId: progress.sessionId,
          threadId:
            asString(asPlainRecord(this.options.runtimeMetadata)?.threadId) ??
            progress.sessionId,
          stepIndex: progress.stepIndex,
          hookKind: "after_tool",
          sourceId: name,
          objective: readRuntimeEvaluationObjective(
            this.options.runtimePayload,
            sessionState,
          ),
          evidence: [{
            evidenceId: `tool-${progress.stepIndex}-${hashCanonical(toolCallId).slice(7, 23)}`,
            kind: "tool",
            value: {
              toolId: name,
              toolCallId,
              status: result.status,
              output: result.auditRecord.output,
            },
          }],
          finalRevisionsUsed: Math.max(
            0,
            Math.trunc(asFiniteNumber(evaluationState?.finalRevisionsUsed) ?? 0),
          ),
          ...(progress.signal !== undefined ? { signal: progress.signal } : {}),
        });
      }
      await this.appendEconomicsEvent({
        kind: "tool_result.recorded",
        callId: toolCallId,
        toolCallId,
        toolName: name,
        status: result.status,
        latencyMs: Date.now() - startedAt,
        resultManifest: buildToolResultEconomicsManifest(result),
      });
      const resultRecord = asPlainRecord(result);
      const auditRecord = asPlainRecord(resultRecord?.auditRecord);
      const toolOutput = asPlainRecord(auditRecord?.output ?? result);
      if (result.status === "FAILED") {
        const durationMs = Date.now() - startedAt;
        const returnedError = readReturnedToolFailure(result);
        await this.options.emitProgressFromSequence({
          runId: progress.runId,
          sessionId: progress.sessionId,
          seq: progress.sequence(),
          kind: "tool",
          phase: progress.phase,
          code: "TOOL_CALL_FAILED",
          message: `Tool '${name}' failed.`,
          stepIndex: progress.stepIndex,
          stepAgent: progress.stepAgent,
          tool: {
            name,
            status: "FAILED",
            latencyMs: durationMs,
          },
          ...toolInputMetadata,
          ...(queueDepthRun !== undefined ? { queueDepthRun } : {}),
          ...(queueDepthGlobal !== undefined ? { queueDepthGlobal } : {}),
          ...(queueWaitMs !== undefined ? { queueWaitMs } : {}),
          persist: true,
        });
        await this.emitToolUpdate({
          phase: "failed",
          toolCallId,
          toolName: name,
          input: activityToolInput,
          output: result,
          error: returnedError,
          durationMs,
          activation: result.activation,
          outcome: result.outcome,
        });
        await consoleBridge.emitStatus("failed", result.auditRecord.output);
        return result;
      }
      const execCommandRunning = name === "exec_command" &&
        typeof toolOutput?.status === "string" &&
        toolOutput.status.trim().toLowerCase() === "running";
      const completionMessage = execCommandRunning
        ? `Tool '${name}' returned an active process session in ${Date.now() - startedAt}ms; the command is still running.`
        : `Tool '${name}' completed in ${Date.now() - startedAt}ms.`;

      await this.options.emitProgressFromSequence({
        runId: progress.runId,
        sessionId: progress.sessionId,
        seq: progress.sequence(),
        kind: "tool",
        phase: progress.phase,
        code: "TOOL_CALL_DONE",
        message: completionMessage,
        stepIndex: progress.stepIndex,
        stepAgent: progress.stepAgent,
        tool: {
          name,
          status: "DONE",
          latencyMs: Date.now() - startedAt,
        },
        ...toolInputMetadata,
        ...(queueDepthRun !== undefined ? { queueDepthRun } : {}),
        ...(queueDepthGlobal !== undefined ? { queueDepthGlobal } : {}),
        ...(queueWaitMs !== undefined ? { queueWaitMs } : {}),
        persist: true,
      });
      await this.emitToolUpdate({
        phase: "completed",
        toolCallId,
        toolName: name,
        input: activityToolInput,
        output: result,
        durationMs: Date.now() - startedAt,
        activation: result.activation,
        outcome: result.outcome,
      });
      await consoleBridge.emitStatus("completed", result);
      return result;
    } catch (error) {
      const failureBoundary = await this.options.executionBoundaryRuntime.evaluateAndPersist({
        boundary: "tool_result",
        identity: {
          runId: progress.runId,
          sessionId: progress.sessionId,
          callId: toolCallId,
          stepIndex: progress.stepIndex,
        },
        source: "runtime",
        trust: "data",
        sourceId: `tool-error:${toolCallId}:${name}`,
        value: {
          input: recoverySourceInput,
          error: this.options.mapError(error),
        },
        persist: (decision) => this.persistBoundaryDecision(decision),
      });
      const mappedError = failureBoundary.value.error;
      const safeFailureInput = failureBoundary.value.input;
      if (error instanceof ToolQueueOverflowError) {
        queueDepthRun = readNumeric(error.details, "queueDepthRun");
        queueDepthGlobal = readNumeric(error.details, "queueDepthGlobal");
        await this.logToolQueueEvent({
          runId: progress.runId,
          sessionId: progress.sessionId,
          stepIndex: progress.stepIndex,
          eventName: "tool_queue_overflow",
          eventType: "tool.queue.overflow",
          level: "WARN",
          metadata: {
            tool: name,
            ...(error.details ?? {}),
          },
        });
      }
      if (queueEventTasks.length > 0) {
        await Promise.all(queueEventTasks);
      }
      await this.options.emitProgressFromSequence({
        runId: progress.runId,
        sessionId: progress.sessionId,
        seq: progress.sequence(),
        kind: "tool",
        phase: progress.phase,
        code: "TOOL_CALL_FAILED",
        message: `Tool '${name}' failed.`,
        stepIndex: progress.stepIndex,
        stepAgent: progress.stepAgent,
        tool: {
          name,
          status: "FAILED",
          latencyMs: Date.now() - startedAt,
        },
        ...(queueDepthRun !== undefined ? { queueDepthRun } : {}),
        ...(queueDepthGlobal !== undefined ? { queueDepthGlobal } : {}),
        ...(queueWaitMs !== undefined ? { queueWaitMs } : {}),
        persist: true,
      });
      await this.emitToolUpdate({
        phase: "failed",
        toolCallId,
        toolName: name,
        input: safeFailureInput,
        error: mappedError,
        durationMs: Date.now() - startedAt,
        ...(preparedToolCall === undefined
          ? {}
          : {
              activation: preparedToolCall.activation,
              outcome: {
                version: "v1" as const,
                callId: preparedToolCall.callId,
                activation: preparedToolCall.activation,
                kind: "failure" as const,
                startedAt: new Date(startedAt).toISOString(),
                completedAt: new Date().toISOString(),
                effectState: "not_started" as const,
                normalizedFailureCode: mappedError.code,
                retryable: mappedError.details?.recoverable === true,
                error: {
                  message: mappedError.message,
                  ...(mappedError.details === undefined
                    ? {}
                    : { details: mappedError.details }),
                },
              },
            }),
      });
      if (consoleBridge !== undefined) {
        await consoleBridge.emitStatus("failed");
      } else {
        await emitDevShellConsoleStatus({
          consoleReporter: this.options.deps.consoleReporter,
          runId: progress.runId,
          sessionId: progress.sessionId,
          seq: progress.sequence(),
          toolName: name,
          input: safeFailureInput,
          status: "failed",
        });
      }
      const safeError = failureBoundary.decision.outcome === "REDACT"
        ? createRuntimeFailure(
            mappedError.code,
            mappedError.message,
            mappedError.details,
          )
        : error;
      throw safeError;
    } finally {
      toolConsoleStream?.discard();
      toolConsoleStream = undefined;
    }
  }

  async inspectTool(
    name: string,
    input: unknown,
    intent?: {
      modelToolCallId?: string | undefined;
      toolSurfaceSnapshot?: import("../kestrel/contracts/tool-contract.js").ToolSurfaceSnapshotV1 | undefined;
    },
  ): Promise<{ effectiveInput: Record<string, unknown> }> {
    const { progress } = this.options;
    throwIfRuntimeIOAborted(progress.signal);
    const sessionState = this.options.getSessionState();
    const runContext = {
      runId: progress.runId,
      sessionId: progress.sessionId,
      payload: this.options.runtimePayload ?? {},
      sessionState,
    };
    const ownsSnapshot = intent?.toolSurfaceSnapshot === undefined;
    const snapshot = intent?.toolSurfaceSnapshot ??
      await this.options.deps.toolGateway.createToolSurfaceSnapshot({
        runContext,
        toolNames: [name],
      });
    const activation = snapshot.tools.find(
      (candidate) => candidate.descriptor.toolId === name,
    );
    if (activation === undefined) {
      throw createRuntimeFailure(
        "TOOL_SNAPSHOT_LOOKUP_FAILED",
        `Tool '${name}' was not exposed in snapshot '${snapshot.snapshotId}'.`,
        { recoverable: false, toolName: name },
      );
    }
    const rawInput = asPlainRecord(input);
    if (rawInput === undefined) {
      throw createRuntimeFailure(
        "TOOL_INPUT_SCHEMA_FAILED",
        `Tool '${name}' input must be an object.`,
        { recoverable: true, toolName: name },
      );
    }
    const origin = intent?.modelToolCallId !== undefined
      ? {
          kind: "model" as const,
          snapshotId: snapshot.snapshotId,
          modelToolCallId: intent.modelToolCallId,
        }
      : {
          kind: "trusted_runtime" as const,
          producerId: "runtime.approval-inspection:v1",
          adapterId: "runtime.approval-inspection:v1",
        };
    const inspectToolCall = this.options.deps.toolGateway.inspectToolCall;
    if (inspectToolCall === undefined) {
      if (ownsSnapshot) {
        await this.options.deps.toolGateway.releaseToolSurfaceSnapshot?.(
          snapshot.snapshotId,
        );
      }
      throw createRuntimeFailure(
        "TOOL_INSPECTION_UNAVAILABLE",
        `Tool '${name}' cannot be inspected safely before approval.`,
        { recoverable: false, toolName: name },
      );
    }
    try {
      return await inspectToolCall.call(
        this.options.deps.toolGateway,
        { activation, origin, rawInput },
        {
          runContext,
          runtimeBudgetRemainingMs: this.options.guardrails.budgetSnapshot().remainingMs,
        },
      );
    } finally {
      if (ownsSnapshot) {
        await this.options.deps.toolGateway.releaseToolSurfaceSnapshot?.(
          snapshot.snapshotId,
        );
      }
    }
  }

  async prepareToolForApproval(
    name: string,
    input: unknown,
    approval: {
      policyRevision: string;
      authorityRevision: string;
      capabilities: readonly string[];
    },
    intent?: {
      modelToolCallId?: string | undefined;
      toolSurfaceSnapshot?: import("../kestrel/contracts/tool-contract.js").ToolSurfaceSnapshotV1 | undefined;
    },
  ): Promise<import("../kestrel/contracts/tool-invocation.js").PreparedToolCallV1> {
    const { progress } = this.options;
    throwIfRuntimeIOAborted(progress.signal);
    const sessionState = this.options.getSessionState();
    const runContext = {
      runId: progress.runId,
      sessionId: progress.sessionId,
      payload: this.options.runtimePayload ?? {},
      sessionState,
    };
    const snapshot = intent?.toolSurfaceSnapshot ??
      await this.options.deps.toolGateway.createToolSurfaceSnapshot({
        runContext,
        toolNames: [name],
      });
    const activation = snapshot.tools.find(
      (candidate) => candidate.descriptor.toolId === name,
    );
    if (activation === undefined) {
      throw createRuntimeFailure(
        "TOOL_SNAPSHOT_LOOKUP_FAILED",
        `Tool '${name}' was not exposed in snapshot '${snapshot.snapshotId}'.`,
        { recoverable: false, toolName: name },
      );
    }
    const rawInput = asPlainRecord(input);
    if (rawInput === undefined) {
      throw createRuntimeFailure(
        "TOOL_INPUT_SCHEMA_FAILED",
        `Tool '${name}' input must be an object.`,
        { recoverable: true, toolName: name },
      );
    }
    const callId = `approval:${progress.runId}:${randomUUID()}`;
    return await this.options.deps.toolGateway.prepareToolCall(
      {
        runId: progress.runId,
        sessionId: progress.sessionId,
        callId,
        activation,
        origin:
          intent?.modelToolCallId === undefined
            ? {
                kind: "trusted_runtime",
                producerId: "runtime.hosted-approval:v2",
                adapterId: "runtime.hosted-approval:v2",
              }
            : {
                kind: "model",
                snapshotId: snapshot.snapshotId,
                modelToolCallId: intent.modelToolCallId,
              },
        rawInput,
        policy: {
          decision: "approval_required",
          policyRevision: approval.policyRevision,
        },
        approval: {
          approvalId: callId,
          authorityRevision: approval.authorityRevision,
        },
        approvalCapabilities: approval.capabilities,
      },
      {
        runContext,
        runtimeBudgetRemainingMs:
          this.options.guardrails.budgetSnapshot().remainingMs,
      },
    );
  }

  async releasePreparedToolCall(
    prepared: import("../kestrel/contracts/tool-invocation.js").PreparedToolCallV1,
  ): Promise<void> {
    await this.options.deps.toolGateway.releasePreparedToolCall?.(prepared);
  }

  private async emitToolUpdate(input: {
    phase: RunToolPhase;
    toolCallId: string;
    toolName: string;
    input?: unknown;
    output?: AgentToolResult;
    error?: RuntimeError | undefined;
    durationMs?: number | undefined;
    activation?: ToolActivationRefV1 | undefined;
    outcome?: ToolExecutionOutcomeV1 | undefined;
  }): Promise<void> {
    const { progress } = this.options;
    const update = buildRunToolUpdate({
      runId: progress.runId,
      sessionId: progress.sessionId,
      seq: progress.sequence(),
      stepIndex: progress.stepIndex,
      stepAgent: progress.stepAgent,
      ...input,
    });
    const event = buildRunToolEvent(update);

    await this.options.appendRunEvent(
      progress.runId,
      progress.sessionId,
      event.type,
      event.level,
      event.metadata,
      progress.stepIndex,
    );
  }

  private async persistBoundaryDecision(
    decision: ExecutionBoundaryDecisionV1,
  ): Promise<void> {
    await this.options.appendRunEvent(
      decision.runId,
      decision.sessionId,
      "execution_boundary.decision",
      decision.outcome === "DENY" || decision.outcome === "QUARANTINE"
        ? "WARN"
        : "INFO",
      { ...decision },
      decision.stepIndex,
    );
  }

  private async logToolQueueEvent(input: {
    runId: string;
    sessionId: string;
    stepIndex: number;
    eventName: string;
    eventType: "tool.queue.enqueued" | "tool.queue.dequeued" | "tool.queue.overflow";
    level: "INFO" | "WARN";
    metadata: Record<string, unknown>;
  }): Promise<void> {
    if (input.level === "WARN") {
      await this.options.logWarn({
        runId: input.runId,
        sessionId: input.sessionId,
        stepIndex: input.stepIndex,
        eventName: input.eventName,
        metadata: input.metadata,
      });
      await this.options.appendRunEvent(
        input.runId,
        input.sessionId,
        input.eventType,
        "WARN",
        input.metadata,
        input.stepIndex,
      );
      return;
    }

    await this.options.logInfo({
      runId: input.runId,
      sessionId: input.sessionId,
      stepIndex: input.stepIndex,
      eventName: input.eventName,
      metadata: input.metadata,
    });
    await this.options.appendRunEvent(
      input.runId,
      input.sessionId,
      input.eventType,
      "INFO",
      input.metadata,
      input.stepIndex,
    );
  }

  private async logToolRetryEvent(input: {
    runId: string;
    sessionId: string;
    stepIndex: number;
    phase: ProgressPhase;
    stepAgent: string;
    toolName: string;
    attempt: number;
    maxAttempts: number;
    error: unknown;
    sequence: () => number;
  }): Promise<void> {
    const message = `Retrying tool '${input.toolName}' (${input.attempt}/${input.maxAttempts}).`;
    await this.options.logWarn({
      runId: input.runId,
      sessionId: input.sessionId,
      stepIndex: input.stepIndex,
      eventName: "tool_retry",
      metadata: {
        tool: input.toolName,
        attempt: input.attempt,
        maxAttempts: input.maxAttempts,
      },
    });
    await this.options.appendRunEvent(
      input.runId,
      input.sessionId,
      "tool.retry",
      "WARN",
      {
        tool: input.toolName,
        attempt: input.attempt,
        maxAttempts: input.maxAttempts,
      },
      input.stepIndex,
    );
    await this.options.emitProgressFromSequence({
      runId: input.runId,
      sessionId: input.sessionId,
      seq: input.sequence(),
      kind: "stage",
      phase: input.phase,
      code: "RUN_STILL_ACTIVE",
      message,
      stepIndex: input.stepIndex,
      stepAgent: input.stepAgent,
      persist: true,
    });
  }
}

function readReturnedToolFailure(result: AgentToolResult): RuntimeError {
  const error = asPlainRecord(result.auditRecord.error);
  const output = asPlainRecord(result.auditRecord.output);
  const details = asPlainRecord(error?.details);
  return {
    code:
      readNonEmptyString(error?.code) ??
      readNonEmptyString(output?.errorCode) ??
      "TOOL_EXECUTION_FAILED",
    message:
      readNonEmptyString(error?.message) ??
      readNonEmptyString(output?.message) ??
      readNonEmptyString(output?.failureReason) ??
      "Tool execution failed.",
    ...(details !== undefined ? { details } : {}),
  };
}

function throwIfRuntimeIOAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new RunCancelledError();
  }
}

export function buildRunToolUpdate(input: {
  runId: string;
  sessionId: string;
  seq: number;
  toolCallId: string;
  toolName: string;
  phase: RunToolPhase;
  stepIndex?: number | undefined;
  stepAgent?: string | undefined;
  input?: unknown;
  output?: unknown;
  error?: RuntimeError | undefined;
  durationMs?: number | undefined;
  activation?: ToolActivationRefV1 | undefined;
  outcome?: ToolExecutionOutcomeV1 | undefined;
}): RunToolUpdateV1 | RunToolUpdateV2 {
  const outputRecord = asPlainRecord(input.output);
  const auditRecord = asPlainRecord(outputRecord?.auditRecord);
  const activityOutput = auditRecord?.output ?? input.output;
  const shared = {
    runId: input.runId,
    sessionId: input.sessionId,
    ts: new Date().toISOString(),
    seq: input.seq,
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    phase: input.phase,
    ...(input.stepIndex !== undefined ? { stepIndex: input.stepIndex } : {}),
    ...(input.stepAgent !== undefined ? { stepAgent: input.stepAgent } : {}),
    displayName: formatToolDisplayName(input.toolName),
    toolFamily: readToolFamily(input.toolName),
    provider: readToolProvider(input.toolName),
    ...(input.input !== undefined ? { input: sanitizeToolActivityValue(input.input) } : {}),
    ...(input.output !== undefined ? { output: sanitizeToolActivityValue(activityOutput) } : {}),
    ...(asPlainRecord(outputRecord?.presentation) !== undefined
      ? { presentation: outputRecord?.presentation as RunToolUpdateV1["presentation"] }
      : {}),
    ...(input.error !== undefined
      ? {
          error: {
            code: input.error.code,
            message: input.error.message,
            ...(input.error.details !== undefined
              ? { details: sanitizeToolActivityValue(input.error.details) as Record<string, unknown> }
              : {}),
          },
        }
      : {}),
    ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
  };
  return input.activation === undefined
    ? { version: "v1", ...shared }
    : {
        version: "v2",
        ...shared,
        activation: input.activation,
        ...(input.outcome === undefined ? {} : { outcome: input.outcome }),
      };
}

export function buildRunToolEvent(update: RunToolUpdateV1 | RunToolUpdateV2): {
  type: "run.tool.started" | "run.tool.completed" | "run.tool.failed";
  level: "INFO" | "ERROR";
  metadata: Record<string, unknown>;
} {
  return {
    type: update.phase === "started"
      ? "run.tool.started"
      : update.phase === "completed"
        ? "run.tool.completed"
        : "run.tool.failed",
    level: update.phase === "failed" ? "ERROR" : "INFO",
    metadata: {
      version: update.version,
      seq: update.seq,
      ts: update.ts,
      toolCallId: update.toolCallId,
      toolName: update.toolName,
      phase: update.phase,
      ...(update.version === "v2" ? { activation: update.activation } : {}),
      ...(update.version === "v2" && update.outcome !== undefined
        ? { outcome: update.outcome }
        : {}),
      ...(update.stepAgent !== undefined ? { stepAgent: update.stepAgent } : {}),
      ...(update.displayName !== undefined ? { displayName: update.displayName } : {}),
      ...(update.toolFamily !== undefined ? { toolFamily: update.toolFamily } : {}),
      ...(update.provider !== undefined ? { provider: update.provider } : {}),
      ...(update.input !== undefined ? { input: update.input } : {}),
      ...(update.output !== undefined ? { output: update.output } : {}),
      ...(update.presentation !== undefined ? { presentation: update.presentation } : {}),
      ...(update.error !== undefined ? { error: update.error } : {}),
      ...(update.durationMs !== undefined ? { durationMs: update.durationMs } : {}),
    },
  };
}

const TOOL_ACTIVITY_MAX_DEPTH = 4;
const TOOL_ACTIVITY_MAX_STRING = 2000;
const TOOL_ACTIVITY_MAX_ARRAY = 25;
const TOOL_ACTIVITY_MAX_KEYS = 50;

function sanitizeToolActivityValue(value: unknown, depth = 0): unknown {
  if (value === undefined) {
    return ;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.length <= TOOL_ACTIVITY_MAX_STRING
      ? value
      : `${value.slice(0, TOOL_ACTIVITY_MAX_STRING)}... [truncated ${value.length - TOOL_ACTIVITY_MAX_STRING} chars]`;
  }
  if (depth >= TOOL_ACTIVITY_MAX_DEPTH) {
    return summarizeNestedToolActivityValue(value);
  }
  if (Array.isArray(value)) {
    const items = value
      .slice(0, TOOL_ACTIVITY_MAX_ARRAY)
      .map((item) => sanitizeToolActivityValue(item, depth + 1));
    if (value.length > TOOL_ACTIVITY_MAX_ARRAY) {
      items.push(`[truncated ${value.length - TOOL_ACTIVITY_MAX_ARRAY} items]`);
    }
    return items;
  }
  if (typeof value !== "object") {
    return String(value);
  }

  const output: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, entryValue] of entries.slice(0, TOOL_ACTIVITY_MAX_KEYS)) {
    if (entryValue === undefined) {
      continue;
    }
    output[key] = sanitizeToolActivityValue(entryValue, depth + 1);
  }
  if (entries.length > TOOL_ACTIVITY_MAX_KEYS) {
    output.__truncatedKeys = entries.length - TOOL_ACTIVITY_MAX_KEYS;
  }
  return output;
}

function summarizeNestedToolActivityValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[array ${value.length}]`;
  }
  if (typeof value === "object" && value !== null) {
    return `[object ${Object.keys(value).length} keys]`;
  }
  return String(value);
}

function readToolFamily(toolName: string): string {
  if (toolName.startsWith("internet.")) {
    return "internet";
  }
  if (toolName.startsWith("free.")) {
    return toolName.split(".")[1] ?? "free";
  }
  if (toolName.startsWith("fs.")) {
    return "filesystem";
  }
  if (toolName.startsWith("dev.")) {
    return "dev-shell";
  }
  if (toolName.startsWith("project.")) {
    return "project";
  }
  if (toolName.startsWith("delegate.") || toolName === "agent.spawn") {
    return "delegation";
  }
  if (toolName === "code.execute") {
    return "code";
  }
  if (toolName === "FinalizeAnswer" || toolName === "effect_result_lookup" || toolName.startsWith("planning.")) {
    return "runtime";
  }
  if (toolName.startsWith("kestrel_one.")) {
    return "knowledge";
  }
  return toolName.includes(".") ? toolName.split(".")[0] ?? "tool" : "tool";
}

function readToolProvider(toolName: string): string {
  if (toolName.startsWith("internet.")) {
    return "tavily";
  }
  if (toolName.startsWith("free.weather.")) {
    return "open-meteo";
  }
  if (toolName.startsWith("free.time.")) {
    return "worldtimeapi";
  }
  if (toolName.startsWith("free.geocode.")) {
    return "nominatim";
  }
  if (toolName.startsWith("free.exchange.")) {
    return "open-er-api";
  }
  if (toolName.startsWith("kestrel_one.")) {
    return "kestrel-one";
  }
  return "kestrel";
}

function formatToolDisplayName(toolName: string): string {
  if (toolName === "FinalizeAnswer") {
    return "Finalize Answer";
  }
  return toolName
    .replace(/[_-]+/gu, " ")
    .split(".")
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function redactModelRequestForDiagnostics(request: ModelRequest): ModelRequest {
  if (request.reasoning?.continuation === undefined) return request;
  const { continuation: _continuation, ...reasoning } = request.reasoning;
  return {
    ...request,
    reasoning,
  };
}

function redactModelResponseForDiagnostics(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const response = value as Record<string, unknown>;
  const reasoning = typeof response.reasoning === "object" && response.reasoning !== null && !Array.isArray(response.reasoning)
    ? response.reasoning as Record<string, unknown>
    : undefined;
  const { rawResponse: _rawResponse, ...safe } = response;
  return reasoning === undefined
    ? safe
    : {
        ...safe,
        reasoning: "[PROVIDER_REASONING_NOT_RETAINED]",
      };
}

async function describeModelPreSpendEvidence(
  resolver: EffectiveModelContractResolverV1 | undefined,
  request: ModelRequest,
): Promise<EffectiveModelPreSpendEvidenceV1 | undefined> {
  if (resolver?.describePreSpendAttempt === undefined) return undefined;
  try {
    return await resolver.describePreSpendAttempt({ request });
  } catch {
    // Evidence generation must not replace the owning admission decision. The
    // resulting row remains explicitly legacy/unknown if a resolver cannot
    // describe the rejected attempt safely.
    return undefined;
  }
}

function createPendingModelCallProof(
  preSpendEvidence: EffectiveModelPreSpendEvidenceV1 | undefined,
): ModelCallProofV1 {
  return {
    version: "model_call_proof_v1",
    evidence: preSpendEvidence?.contract === undefined ? "legacy" : "captured",
    admission: "pending",
    ...(preSpendEvidence?.contract !== undefined ? { effectiveContract: preSpendEvidence.contract } : {}),
    capabilities: preSpendEvidence === undefined ? [] : readRequiredModelCapabilities(preSpendEvidence.request),
    terminal: "pending",
    validation: "not_requested",
  };
}

function createAdmittedModelCallProof(
  contract: EffectiveModelContractV1 | undefined,
  request: ModelRequest,
): ModelCallProofV1 {
  const capturedContract = contract?.status === "qualified" ? contract : undefined;
  return {
    version: "model_call_proof_v1",
    evidence: capturedContract === undefined ? "legacy" : "captured",
    admission: "admitted",
    ...(capturedContract !== undefined ? { effectiveContract: capturedContract } : {}),
    capabilities: readRequiredModelCapabilities(request),
    terminal: "pending",
    validation: "not_requested",
  };
}

function createPreSpendRejectedModelCallProof(
  error: RuntimeError,
  contract?: EffectiveModelContractV1 | undefined,
  request?: ModelRequest | undefined,
): ModelCallProofV1 {
  const failureCode = readNonEmptyString(error.code);
  const capturedContract = contract?.status === "qualified" ? contract : undefined;
  return {
    version: "model_call_proof_v1",
    evidence: capturedContract === undefined ? "legacy" : "captured",
    admission: "pre_spend_rejected",
    ...(capturedContract !== undefined ? { effectiveContract: capturedContract } : {}),
    capabilities: request === undefined ? [] : readRequiredModelCapabilities(request),
    terminal: "pre_spend_rejected",
    validation: "failed",
    ...(failureCode !== undefined ? { failureCode } : {}),
    ...(readProviderRequestId(error) !== undefined
      ? { providerRequestId: readProviderRequestId(error) }
      : {}),
  };
}

function isPreSpendModelFailure(code: string): boolean {
  return code === "HARNESS_ECONOMICS_CONTEXT_ADMISSION_BLOCKED";
}

function createCompletedModelCallProof(
  contract: EffectiveModelContractV1 | undefined,
  request: ModelRequest,
  response: unknown,
): ModelCallProofV1 {
  const providerRequestId = readProviderRequestId(response);
  const validation = asPlainRecord(asPlainRecord(response)?.validation)?.state;
  const capturedContract = contract?.status === "qualified" ? contract : undefined;
  return {
    version: "model_call_proof_v1",
    evidence: capturedContract === undefined ? "legacy" : "captured",
    admission: "admitted",
    ...(capturedContract !== undefined ? { effectiveContract: capturedContract } : {}),
    capabilities: readRequiredModelCapabilities(request),
    terminal: "completed",
    validation: validation === "passed" ? "passed" : "not_requested",
    ...(providerRequestId !== undefined ? { providerRequestId } : {}),
  };
}

function createFailedModelCallProof(
  contract: EffectiveModelContractV1 | undefined,
  request: ModelRequest,
  error: RuntimeError,
): ModelCallProofV1 {
  const failureCode = readNonEmptyString(error.code);
  const terminal = classifyModelCallFailure(failureCode, error);
  const providerRequestId = readProviderRequestId(error);
  const capturedContract = contract?.status === "qualified" ? contract : undefined;
  return {
    version: "model_call_proof_v1",
    evidence: capturedContract === undefined ? "legacy" : "captured",
    admission: "admitted",
    ...(capturedContract !== undefined ? { effectiveContract: capturedContract } : {}),
    capabilities: readRequiredModelCapabilities(request),
    terminal,
    validation: terminal === "verifier_rejected" ? "failed" : "not_requested",
    ...(failureCode !== undefined ? { failureCode } : {}),
    ...(providerRequestId !== undefined ? { providerRequestId } : {}),
  };
}

function readRequiredModelCapabilities(request: ModelRequest): ModelCallProofV1["capabilities"] {
  const requestRecord = asPlainRecord(request);
  const requirements = asPlainRecord(requestRecord?.requirements);
  const output = asPlainRecord(requirements?.output);
  const tools = asPlainRecord(requirements?.tools);
  const streaming = asPlainRecord(requirements?.streaming);
  const capabilities: ModelCallProofV1["capabilities"] = [];
  if (output?.kind === "json_object" || output?.kind === "json_schema") {
    capabilities.push("structured_output");
  }
  if (output?.assurance === "provider_strict_schema") capabilities.push("strict_schema");
  if (tools?.choice !== undefined && tools.choice !== "none") capabilities.push("tools");
  if (tools?.choice === "required" || tools?.choice === "named") {
    capabilities.push("required_tool_choice");
  }
  if (tools?.strictArguments === true) capabilities.push("strict_tool_inputs");
  if (streaming?.terminalBehavior === "required") capabilities.push("streaming_terminal");
  return capabilities;
}

function classifyModelCallFailure(
  code: string | undefined,
  error: RuntimeError,
): ModelCallProofV1["terminal"] {
  const terminalState = readNonEmptyString(asPlainRecord(error.details)?.terminalState);
  if (
    code === "RUN_CANCELLED" ||
    code === "IO_MODEL_TIMEOUT" ||
    code === "MODEL_TIMEOUT" ||
    code === "MODEL_NETWORK_DNS" ||
    code === "MODEL_NETWORK_ERROR" ||
    terminalState === "interrupted"
  ) {
    return "interrupted";
  }
  if (
    terminalState === "refused" ||
    terminalState === "incomplete" ||
    terminalState === "truncated" ||
    terminalState === "malformed" ||
    code === "MODEL_AUTH_ERROR" ||
    code === "MODEL_RATE_LIMITED"
  ) {
    return "provider_rejected";
  }
  if (code !== undefined && MODEL_RESPONSE_VERIFICATION_FAILURE_CODES.has(code)) {
    return "verifier_rejected";
  }
  return "provider_rejected";
}

const MODEL_RESPONSE_VERIFICATION_FAILURE_CODES = new Set([
  "MODEL_ENDPOINT_MISMATCH",
  "MODEL_CONTINUATION_KIND_UNSUPPORTED",
  "MODEL_CONTINUATION_PROVIDER_MISMATCH",
  "MODEL_MALFORMED_RESPONSE",
  "MODEL_NAMED_TOOL_CALL_MISSING",
  "MODEL_NAMED_TOOL_CALL_UNEXPECTED",
  "MODEL_OUTPUT_NOT_JSON_OBJECT",
  "MODEL_OUTPUT_SCHEMA_INVALID",
  "MODEL_REQUIRED_TOOL_CALL_MISSING",
  "MODEL_RESPONSE_SCHEMA_INVALID",
  "MODEL_RESPONSE_SCHEMA_MISSING",
  "MODEL_STREAM_TERMINAL_EVIDENCE_MISSING",
  "MODEL_STRUCTURED_OUTPUT_MISSING",
  "MODEL_TOOL_ARGUMENTS_INVALID",
  "MODEL_TOOL_CALL_ID_DUPLICATE",
  "MODEL_TOOL_CALL_ID_MISSING",
  "MODEL_TOOL_CALL_UNEXPECTED",
  "MODEL_TOOL_PARALLELISM_FORBIDDEN",
  "MODEL_TOOL_PARALLELISM_REQUIRED",
  "MODEL_TOOL_SCHEMA_INVALID",
  "MODEL_TOOL_UNKNOWN",
]);

function readProviderRequestId(value: unknown): string | undefined {
  const record = asPlainRecord(value);
  const details = asPlainRecord(record?.details);
  const provider = asPlainRecord(record?.provider);
  return readBoundedMetadataString(details?.requestId) ?? readBoundedMetadataString(provider?.requestId);
}

function readProviderReasoningRetention(value: unknown): ProviderReasoningRetentionPolicy {
  if (value === undefined) return { mode: "live_only", days: 7 };
  const record = asPlainRecord(value);
  const mode = record?.mode;
  const days = record?.days;
  if (
    (mode !== "live_only" && mode !== "provider_visible") ||
    typeof days !== "number" ||
    Number.isInteger(days) === false ||
    days < 1 ||
    days > 30
  ) {
    throw new Error("Invalid provider reasoning retention policy");
  }
  return { mode, days };
}

function readModelLifecycleMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const lifecycle: Record<string, unknown> = {};
  const contextBuilder = readBoundedMetadataString(metadata.contextBuilder);
  if (contextBuilder !== undefined) {
    lifecycle.contextBuilder = contextBuilder;
  }
  const contextBuilderVersion = metadata.contextBuilderVersion;
  if (
    typeof contextBuilderVersion === "number" &&
    Number.isSafeInteger(contextBuilderVersion) &&
    contextBuilderVersion >= 0
  ) {
    lifecycle.contextBuilderVersion = contextBuilderVersion;
  }
  const compactionAttempt = readPositiveMetadataInteger(metadata.compactionAttempt);
  if (compactionAttempt !== undefined) {
    lifecycle.compactionAttempt = compactionAttempt;
  }
  const maxSummaryAttempts = readPositiveMetadataInteger(metadata.maxSummaryAttempts);
  if (maxSummaryAttempts !== undefined) {
    lifecycle.maxSummaryAttempts = maxSummaryAttempts;
  }
  if (
    metadata.compactionAttemptKind === "initial" ||
    metadata.compactionAttemptKind === "correction"
  ) {
    lifecycle.compactionAttemptKind = metadata.compactionAttemptKind;
  }
  return lifecycle;
}

function readBoundedMetadataString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 128
    ? normalized
    : undefined;
}

function readPositiveMetadataInteger(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 100
    ? value
    : undefined;
}

function readHarnessEconomicsControl(
  runtimeAssembly: Record<string, unknown> | undefined,
): HarnessEconomicsControlV1 | undefined {
  const value = runtimeAssembly?.harnessEconomics;
  return value === undefined ? undefined : parseHarnessEconomicsControlV1(value);
}

function applyCachePolicy(
  request: ModelRequest,
  policy: HarnessEconomicsPolicyV1 | undefined,
  profile: ModelEconomicsProfileV1 | undefined,
): ModelRequest {
  if (policy?.mode !== "enforce" || policy.cache.mode !== "stable_prefix") return request;
  const messages = [...(request.messages ?? [])].sort((left, right) =>
    left.role === "system" && right.role !== "system" ? -1 : left.role !== "system" && right.role === "system" ? 1 : 0
  );
  const tools = [...(request.tools ?? [])].sort((left, right) => left.name.localeCompare(right.name));
  const anthropicCache = profile?.cache.behavior === "anthropic_ephemeral"
    ? {
        providerOptions: {
          ...(request.providerOptions ?? {}),
          anthropic: {
            ...(asPlainRecord(request.providerOptions?.anthropic) ?? {}),
            cacheControl: "ephemeral" as const,
          },
        },
      }
    : {};
  return { ...request, messages, tools, ...anthropicCache };
}

function buildStablePrefixRecord(
  request: ModelRequest,
  policy: HarnessEconomicsPolicyV1 | undefined,
  profile: ModelEconomicsProfileV1 | undefined,
  previousHash: string | undefined,
): EconomicsModelCallRequestedV1["cache"] {
  const stableValue = {
    system: (request.messages ?? []).filter((message) => message.role === "system"),
    tools: request.tools ?? [],
  };
  const stablePrefixHash = hashUnknown(stableValue);
  const counter = profile?.counting.method === "model_tokenizer"
    ? resolveModelTokenCounter(profile.counting.counter, profile.counting.counterVersion)
    : undefined;
  const stablePrefixTokens = countTextTokens(JSON.stringify(stableValue), counter).tokens;
  return {
    mode: policy?.cache.mode ?? "provider_default",
    stablePrefixHash,
    stablePrefixTokens,
    prefixChanged: previousHash !== undefined && previousHash !== stablePrefixHash,
  };
}

function applyEconomicsContextPolicy(input: {
  request: ModelRequest;
  contextSections?: ContextSectionCandidateV1[] | undefined;
  contextPipeline: unknown;
  policy?: HarnessEconomicsPolicyV1 | undefined;
  modelProfile?: ModelEconomicsProfileV1 | undefined;
  phase: string;
  toolExposureSelection: unknown;
}): { request: ModelRequest; contextSections?: ContextSectionCandidateV1[] | undefined } {
  if (input.policy?.mode !== "enforce" || input.modelProfile === undefined || input.contextSections === undefined) {
    return { request: input.request, ...(input.contextSections !== undefined ? { contextSections: input.contextSections } : {}) };
  }
  const manifest = buildModelRequestEconomicsManifest({
    request: input.request,
    contextSections: input.contextSections,
    policy: input.policy,
    modelProfile: input.modelProfile,
    phase: input.phase,
    ...(input.toolExposureSelection !== undefined
      ? { toolExposureSelection: parseToolExposureSelectionV1(input.toolExposureSelection) }
      : {}),
  });
  const decision = manifest.decision;
  if (decision === undefined) return { request: input.request, contextSections: input.contextSections };
  const policyById = new Map(input.policy.context.sections.map((section) => [section.id, section]));
  const optionalDrops = new Set(decision.manifest.sections
    .filter((section) => section.effectiveAdmission === "dropped" && policyById.get(section.id)?.priority === "optional")
    .map((section) => section.id));
  const unsupported = decision.manifest.sections.filter((section) =>
    section.effectiveAdmission === "blocked" ||
    (section.effectiveAdmission === "dropped" && optionalDrops.has(section.id) === false)
  );
  if (unsupported.length > 0 || optionalDrops.size === 0) {
    return { request: input.request, contextSections: input.contextSections };
  }
  const pipeline = parseContextPipeline(input.contextPipeline);
  if (pipeline === undefined || [...optionalDrops].some((id) => pipeline.some((section) => section.id === id) === false)) {
    return { request: input.request, contextSections: input.contextSections };
  }
  const messages = [...(input.request.messages ?? [])];
  const removedMessageIndices = new Set<number>();
  const runtimeSections = pipeline.filter((section) => section.binding === "runtime" && optionalDrops.has(section.id) === false);
  for (const section of pipeline) {
    if (optionalDrops.has(section.id) === false) continue;
    if (section.binding !== "runtime") removedMessageIndices.add(section.messageIndex);
  }
  const runtimeIndex = pipeline.find((section) => section.binding === "runtime")?.messageIndex;
  if (runtimeIndex !== undefined) {
    if (runtimeSections.length === 0) removedMessageIndices.add(runtimeIndex);
    else messages[runtimeIndex] = { role: "user", content: `<runtime_context>\n${runtimeSections.map((section) => section.renderedContent).join("\n\n")}\n</runtime_context>` };
  }
  const effectiveMessages = messages.filter((_message, index) => removedMessageIndices.has(index) === false);
  return {
    request: { ...input.request, messages: effectiveMessages },
    contextSections: input.contextSections.filter((section) => optionalDrops.has(section.id) === false),
  };
}

function parseContextPipeline(value: unknown): Array<{
  id: string;
  binding: "system" | "runtime" | "transcript";
  messageIndex: number;
  renderedContent: string;
}> | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.map((entry) => {
    const record = asPlainRecord(entry);
    const id = readNonEmptyString(record?.id);
    const binding = record?.binding;
    const messageIndex = record?.messageIndex;
    const renderedContent = typeof record?.renderedContent === "string" ? record.renderedContent : undefined;
    if (id === undefined || (binding !== "system" && binding !== "runtime" && binding !== "transcript") || !Number.isSafeInteger(messageIndex) || (messageIndex as number) < 0 || renderedContent === undefined) return undefined;
    return { id, binding, messageIndex: messageIndex as number, renderedContent };
  });
  return parsed.some((entry) => entry === undefined) ? undefined : parsed as Array<{ id: string; binding: "system" | "runtime" | "transcript"; messageIndex: number; renderedContent: string }>;
}

function assertEconomicsRequestAdmission(
  policy: HarnessEconomicsPolicyV1 | undefined,
  manifest: ReturnType<typeof buildModelRequestEconomicsManifest>,
): void {
  if (policy?.mode !== "enforce") return;
  // Tool-schema pressure is an efficiency signal, not a reason to make an
  // otherwise viable user request fail. Explicit assembly filtering happens
  // before this boundary; this check only records the final provider surface.
  if (manifest.decision !== undefined) {
    const changed = manifest.decision.manifest.sections.some((section) =>
      section.effectiveAdmission !== "admitted" || section.effectiveTokens !== section.proposed.tokens
    );
    if (changed) {
      throw createRuntimeFailure(
        "HARNESS_ECONOMICS_CONTEXT_ADMISSION_BLOCKED",
        "Harness economics enforcement blocked a model request whose context does not fit the selected policy. Truncation requires an explicit section binding before provider dispatch.",
        {
          policyId: policy.policyId,
          blockedSectionIds: manifest.decision.blockedSectionIds,
          droppedSectionIds: manifest.decision.droppedSectionIds,
        },
      );
    }
  }
}

function isModelResponse(value: unknown): value is ModelResponse<unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const provider = (value as Record<string, unknown>).provider;
  return typeof provider === "object" && provider !== null && !Array.isArray(provider);
}

function readRuntimeEvaluationObjective(
  runtimePayload: Record<string, unknown> | undefined,
  sessionState: Record<string, unknown>,
): string {
  const payloadObjective = asString(runtimePayload?.message) ??
    asString(runtimePayload?.goal);
  if (payloadObjective !== undefined) return payloadObjective;
  const agent = asPlainRecord(sessionState.agent);
  const visibleTodos = asPlainRecord(agent?.visibleTodos);
  return asString(visibleTodos?.objective) ?? "Complete the active user request.";
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
