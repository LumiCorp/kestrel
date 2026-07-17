import { Ajv, type ErrorObject, type ValidateFunction } from "ajv";

import type { BudgetSnapshot } from "../../../../src/kestrel/contracts/events.js";
import type { ModelToolSpec } from "../../../../src/kestrel/contracts/model-io.js";

import type { InteractionMode, ToolExecutionClass } from "../../../../src/mode/contracts.js";
import {
  analyzeVisibleTodosCompletion,
  normalizeVisibleTodoState,
  type VisibleTodoState,
} from "../../../../src/runtime/visibleTodos.js";
import type { RuntimePlanState } from "../../../../src/runtime/planDocument.js";
import { isPublicInternetHttpUrl } from "../../../../tools/runtime/builtInToolInputContracts.js";
import { readRetrievalToolFamily } from "../../../../src/engine/retrievalLoopGuard.js";
import { normalizeContinuationOffer } from "../../../../src/runtime/continuationOffer.js";
import { asArray, asRecord, asString } from "../../../shared/valueAccess.js";
import { isShellFilesystemInspectionCommand } from "../filesystemInspection.js";
export {
  DecisionCompileError,
  type DecisionErrorCode,
} from "./DecisionCompileError.js";
import {
  DecisionCompileError,
  type DecisionIngestCategory,
} from "./DecisionCompileError.js";
import {
  computeMissingRequiredCapabilities,
  validateDecisionPolicy,
} from "../policy/DecisionPolicy.js";
import { stableObjectHash, sortValue } from "../context/textUtils.js";
import {
  allowlistedCandidateNames,
  buildCandidateViews,
  deriveRequiredCapabilities,
  parseDraftIntent,
  resolveExecutionIntentToolName,
} from "../toolIntent.js";
import { normalizeToolActionInput, sanitizeToolInputForSchema } from "../toolInputNormalization.js";
import { validateFinalizationDecision } from "../finalizationPolicy.js";
import { hashToolInput } from "../memory/workingMemory.js";
import type {
  CompiledIntent,
  CompiledIntentIssue,
  CompiledIntentNextStep,
  DraftIntent,
  DecisionContextExecutionIntent,
  DecisionContextIntentMetadata,
  DecisionContextToolIntent,
  DecisionRecoveryVerdict,
  DecisionRepetitionSignals,
  DecisionFailureCode,
  DecisionTrace,
  DecisionVerification,
  EvidenceLedgerContext,
  EvidenceLedgerEntry,
  ReactAction,
  ToolCapabilityManifestItem,
  WebInference,
} from "../types.js";

export type DecisionPhase = "deliberator";

export interface DecisionPlan {
  intent: string;
  successCriteria: string[];
  rationale?: string | undefined;
}

export interface CompileAgentActionInput {
  phase: DecisionPhase;
  action: ReactAction;
  visibleTodosPatch?: VisibleTodoState | undefined;
  reason?: string | undefined;
  actionProvenance?: Record<string, unknown> | undefined;
  sourceRunId?: string | undefined;
  interactionMode?: InteractionMode | undefined;
  workspaceRoot?: string | undefined;
  observedCapabilities: string[];
  capabilityManifest: ToolCapabilityManifestItem[];
  availableTools?: ModelToolSpec[] | undefined;
  compiledIntent?: CompiledIntent | undefined;
  executionIntent?: DecisionContextExecutionIntent | undefined;
  intentMetadata?: DecisionContextIntentMetadata | undefined;
  intentConfidence?: number | undefined;
  toolIntent?: DecisionContextToolIntent | undefined;
  repetitionSignals?: DecisionRepetitionSignals | undefined;
  recoveryVerdict?: DecisionRecoveryVerdict | undefined;
  evidenceRecoverySummary?: Record<string, unknown> | undefined;
  postToolVerification?: Record<string, unknown> | undefined;
  /** @deprecated ignored compatibility input; work items are no longer compile-policy authorities. */
  workItem?: unknown;
  lastActionResult?: unknown;
  devShellProcesses?: Record<string, unknown>[] | undefined;
  evidenceContext?: EvidenceLedgerContext | undefined;
  evidenceLedger?: Array<EvidenceLedgerEntry | object> | undefined;
  visibleTodos?: VisibleTodoState | undefined;
  budget?: BudgetSnapshot | undefined;
  activePlan?: RuntimePlanState | undefined;
}

export interface CompiledDecision {
  phase: DecisionPhase;
  plan: DecisionPlan;
  visibleTodos?: VisibleTodoState | undefined;
  requiredCapabilities: string[];
  action?: ReactAction | undefined;
  reason?: string | undefined;
  confidence: number;
  verification: DecisionVerification;
  webInference?: WebInference | undefined;
  goalMet?: boolean | undefined;
  observationSummary?: string | undefined;
  trace: DecisionTrace[];
};

export interface CompileDraftIntentInput {
  capabilityManifest: Array<{
    name: string;
    description?: string | undefined;
    freshnessClass?: string | undefined;
    latencyClass?: string | undefined;
    costClass?: string | undefined;
    capabilityClasses?: string[] | undefined;
    executionClass?: ToolExecutionClass | undefined;
  }>;
  draftIntent?: DraftIntent | undefined;
  executionIntent?: DecisionContextExecutionIntent | undefined;
  intentMetadata?: DecisionContextIntentMetadata | undefined;
  intentConfidence?: number | undefined;
  toolIntent?: DecisionContextToolIntent | undefined;
  source?: CompiledIntent["source"] | undefined;
}

const TOOL_INPUT_AJV = new Ajv({
  allErrors: true,
  strict: false,
});
const TOOL_INPUT_VALIDATOR_CACHE = new Map<string, ValidateFunction>();

export function compileAgentAction(input: CompileAgentActionInput & { phase: "deliberator" }): CompiledDecision & { action: ReactAction } {
  const canonicalIntent = resolveCanonicalIntentContext(input);
  const compatibilityExecutionIntent = canonicalIntent.executionIntent;
  const plan = buildRuntimeOwnedActionPlan(input.action, input.reason);
  const actionRequiredCapabilities = deriveRequiredCapabilitiesFromReactAction(input.action, input.capabilityManifest);
  const canonicalRequiredCapabilities = requiredCapabilitiesForCanonicalIntent(canonicalIntent);
  const requiredCapabilities = mergeRequiredCapabilities(
    actionRequiredCapabilities,
    canonicalRequiredCapabilities,
  );
  const policyRequiredCapabilities = requiredCapabilities.filter(isModelFacingToolCapability);
  const visibleTodos = input.visibleTodosPatch ?? normalizeVisibleTodoState(input.visibleTodos);
  const trace: DecisionTrace[] = [
    {
      eventType: "decision.generated",
      phase: input.phase,
      decisionCode: "MODEL_TOOL_CALL_RECEIVED",
      ...(input.actionProvenance !== undefined ? { metadata: input.actionProvenance } : {}),
    },
  ];

  const normalizedAction = normalizeCompiledDecisionAction(
    input.action,
    readActiveWorkspaceRootFromDevShellProcesses(input.devShellProcesses),
  );
  validateDevShellExecCommandContract(normalizedAction);
  const action = validateToolActionSchemas(
    normalizedAction,
    input.availableTools,
  );
  validatePublicInternetUrlToolContract(action);
  validateSingleLoopAction(action);
  const repetitionSignals = withCompiledActionRepetitionSignals(
    input.repetitionSignals,
    action,
    input.postToolVerification,
  );
  validateWorkspaceRootMutationContract(action, input.workspaceRoot);
  validateDevShellProcessBatchContract(action);
  validateDevShellWriteStdinInput(action);
  validateActiveDevShellExecInput({
    action,
    devShellProcesses: input.devShellProcesses,
    postToolVerification: input.postToolVerification,
  });
  const exactRepeat = repetitionSignals?.sameToolAsLastAction === true &&
    repetitionSignals.sameInputAsLastAction === true;
  const repeatedFilesystemInspection = repetitionSignals?.sameFilesystemInspectionAsLastAction === true;
  const actionNovelty = exactRepeat === false && repeatedFilesystemInspection === false;
  const verification = {
    missingCapabilities: [],
    actionNovelty,
    expectedEvidenceDelta: actionNovelty ? "medium" : "low",
  } satisfies DecisionVerification;
  validateFinalizationDecision({
    action,
  });
  validateDevShellProcessTargets(action, input.devShellProcesses, input.postToolVerification);
  validateLiveDevShellExecReplay({
    action,
    devShellProcesses: input.devShellProcesses,
  });
  validateModeScopedTerminalAction({
    phase: input.phase,
    interactionMode: input.interactionMode,
    action,
    activePlan: input.activePlan,
  });
  const policyMissingRequiredCapabilities = computeMissingRequiredCapabilities(
    policyRequiredCapabilities,
    input.capabilityManifest,
  );
  const policyChecksPassed = validateDecisionPolicy({
    phase: input.phase,
    action,
    requiredCapabilities: policyRequiredCapabilities,
    observedCapabilities: input.observedCapabilities,
    hasExecutionEvidence: hasBuildModeExecutionEvidence(input),
    capabilityManifest: input.capabilityManifest,
    ...(compatibilityExecutionIntent !== undefined ? { executionIntent: compatibilityExecutionIntent } : {}),
    ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
  });

  const boundAction = action;
  trace.push({
    eventType: "decision.compiled",
    phase: input.phase,
    decisionCode: boundAction.kind,
    metadata: {
      confidence: 1,
      expectedEvidenceDelta: verification.expectedEvidenceDelta,
      missingCapabilities: verification.missingCapabilities,
      actionNovelty: verification.actionNovelty,
      requiredCapabilities,
      policyMissingRequiredCapabilities,
      ...(input.actionProvenance !== undefined ? { actionProvenance: input.actionProvenance } : {}),
    },
  });
  trace.push({
    eventType: "decision.policy_passed",
    phase: input.phase,
    decisionCode: boundAction.kind,
    metadata: {
      chosenActionKind: boundAction.kind,
      ...(resolveChosenActionName(boundAction) !== undefined
        ? { chosenActionName: resolveChosenActionName(boundAction) }
        : {}),
      requiredCapabilities,
      availableCapabilities: collectAvailableCapabilities(input.capabilityManifest),
      policyChecksPassed,
      decisionConfidence: 1,
      phase: input.phase,
    },
  });

  return {
    phase: input.phase,
    plan,
    ...(visibleTodos !== undefined ? { visibleTodos } : {}),
    requiredCapabilities,
    action: boundAction,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    confidence: 1,
    verification,
    trace,
  };
}

function buildRuntimeOwnedActionPlan(
  action: ReactAction,
  reason: string | undefined,
): DecisionPlan {
  const chosenName = resolveChosenActionName(action);
  const intent = chosenName !== undefined
    ? `Use ${chosenName} to advance the current request.`
    : action.kind === "finalize"
      ? "Finish the current request."
      : action.kind === "ask_user"
        ? "Ask the user for the information needed to continue."
        : action.kind === "cannot_satisfy"
          ? "Report the concrete blocker for the current request."
          : action.kind === "handoff_to_build"
            ? "Hand off the approved plan to build mode."
            : `Run ${action.kind}.`;
  return {
    intent,
    successCriteria: [reason ?? intent],
    ...(reason !== undefined ? { rationale: reason } : {}),
  };
}

function deriveRequiredCapabilitiesFromReactAction(
  action: ReactAction,
  capabilityManifest: ToolCapabilityManifestItem[],
): string[] {
  const manifestByName = new Map(capabilityManifest.map((item) => [item.name, item]));
  return Array.from(new Set(
    collectToolActionItems(action)
      .flatMap((item) => {
        const classes = manifestByName.get(item.name)?.capabilityClasses ?? [];
        return classes.length > 0 ? classes : [item.name];
      }),
  ));
}

function hasBuildModeExecutionEvidence(input: CompileAgentActionInput): boolean {
  if (input.observedCapabilities.length > 0) {
    return true;
  }
  const evidenceContext = input.evidenceContext;
  if (
    evidenceContext !== undefined &&
    (
      evidenceContext.latest !== undefined ||
      evidenceContext.successSupport.length > 0 ||
      evidenceContext.entries.length > 0
    )
  ) {
    return true;
  }
  if ((input.evidenceLedger ?? []).length > 0) {
    return true;
  }
  if (hasRecordFields(input.postToolVerification)) {
    return true;
  }
  if (hasObservedLastActionResult(input.lastActionResult)) {
    return true;
  }
  if (
    hasOpenVisibleTodoItems(input.visibleTodosPatch) ||
    hasOpenVisibleTodoItems(input.visibleTodos) ||
    closesExistingVisibleTodos(input.visibleTodos, input.visibleTodosPatch)
  ) {
    return true;
  }
  return false;
}

function hasOpenVisibleTodoItems(value: unknown): boolean {
  const visibleTodos = normalizeVisibleTodoState(value);
  if (visibleTodos === undefined || visibleTodos.items.length === 0) {
    return false;
  }
  return analyzeVisibleTodosCompletion(visibleTodos).openItems.length > 0;
}

function closesExistingVisibleTodos(previousValue: unknown, nextValue: unknown): boolean {
  const previous = normalizeVisibleTodoState(previousValue);
  const next = normalizeVisibleTodoState(nextValue);
  if (previous === undefined || next === undefined) {
    return false;
  }
  if (
    previous.items.length === 0 ||
    analyzeVisibleTodosCompletion(previous).openItems.length === 0 ||
    analyzeVisibleTodosCompletion(next).openItems.length > 0
  ) {
    return false;
  }
  return true;
}

function hasRecordFields(value: unknown): boolean {
  const record = asRecord(value);
  return record !== undefined && Object.keys(record).length > 0;
}

function hasObservedLastActionResult(value: unknown): boolean {
  const record = asRecord(value);
  if (record === undefined) {
    return false;
  }
  const kind = asString(record.kind);
  if (kind === undefined || kind === "validation_feedback") {
    return false;
  }
  return true;
}

function validateModeScopedTerminalAction(input: {
  phase: DecisionPhase;
  interactionMode?: InteractionMode | undefined;
  action: ReactAction;
  activePlan?: RuntimePlanState | undefined;
}): void {
  if (input.phase !== "deliberator") {
    return;
  }
  const interactionMode = input.interactionMode ?? "build";
  if (input.action.kind !== "handoff_to_build") {
    return;
  }
  if (interactionMode === "plan") {
    if (input.activePlan === undefined) {
      throw new DecisionCompileError(
        "DECISION_POLICY_FAILED",
        "handoff_to_build requires an active session plan document.",
        "policy",
        {
          phase: input.phase,
          interactionMode,
          actionKind: input.action.kind,
          requiredAction: "write_session_plan_before_handoff",
        },
      );
    }
    const normalizedContinuation = normalizeContinuationOffer(input.action.continuation, "compile-intent");
    if (normalizedContinuation !== undefined && normalizedContinuation.requiredMode === "build") {
      return;
    }
    throw new DecisionCompileError(
      "DECISION_POLICY_FAILED",
      "handoff_to_build requires a build-mode continuation payload.",
      "policy",
      {
        phase: input.phase,
        interactionMode,
        actionKind: input.action.kind,
        requiredAction: "call_handoff_to_build_with_compact_continuation",
      },
    );
  }
  throw new DecisionCompileError(
    "DECISION_POLICY_FAILED",
    "handoff_to_build is only valid in plan mode.",
    "policy",
    {
      phase: input.phase,
      interactionMode,
      actionKind: input.action.kind,
      requiredAction: "choose_valid_build_mode_action",
    },
  );
}

function validateWorkspaceRootMutationContract(
  action: ReactAction,
  workspaceRoot: string | undefined,
): void {
  const normalizedWorkspaceRoot = workspaceRoot !== undefined
    ? normalizeFilesystemPath(workspaceRoot)
    : undefined;
  const items = collectToolActionItems(action);
  for (const item of items) {
    if (item.name !== "fs.mkdir" && item.name !== "fs.delete") {
      continue;
    }
    const normalizedPath = normalizeFilesystemPath(asString(asRecord(item.input)?.path) ?? "");
    if (normalizedPath === undefined) {
      continue;
    }
    if (normalizedPath !== "." && normalizedPath !== normalizedWorkspaceRoot) {
      continue;
    }
    throw new DecisionCompileError(
      "DECISION_POLICY_FAILED",
      `${item.name} must target an explicit path inside the workspace, not the already-provisioned workspace root.`,
      "policy",
      {
        reason: "workspace_root_mutation_noop_rejected",
        toolName: item.name,
        path: asString(asRecord(item.input)?.path) ?? normalizedPath,
        workspaceRoot: normalizedWorkspaceRoot,
        requiredCorrection:
          item.name === "fs.mkdir"
            ? "The workspace root already exists. Create a concrete subdirectory or run the scaffold directly in the current directory."
            : "Choose a concrete file or subdirectory target instead of deleting the workspace root.",
      },
    );
  }
}

function validateSingleLoopAction(action: ReactAction): void {
  if (action.kind === "resolve_tool") {
    throw new DecisionCompileError(
      "DECISION_SCHEMA_FAILED",
      "Agent loop output must choose an executable action directly; resolve_tool is not a valid action.",
      "schema",
      {
        path: "nextAction.kind",
        expected: ["tool", "tool_batch", "ask_user", "finalize", "cannot_satisfy"],
        received: "resolve_tool",
      },
    );
  }
  if (action.kind === "effect") {
    throw new DecisionCompileError(
      "DECISION_SCHEMA_FAILED",
      "Agent loop output must not emit raw effect actions.",
      "schema",
      {
        path: "nextAction.kind",
        expected: ["tool", "tool_batch", "ask_user", "finalize", "cannot_satisfy"],
        received: "effect",
      },
    );
  }
}

function validatePublicInternetUrlToolContract(action: ReactAction): void {
  const items = action.kind === "tool"
    ? [{ name: action.name, input: action.input, path: "nextAction.input" }]
    : action.kind === "tool_batch"
      ? action.items.map((item, index) => ({
          name: item.name,
          input: item.input,
          path: `nextAction.items[${index}].input`,
        }))
      : [];

  for (const item of items) {
    if (item.name !== "internet.extract" && item.name !== "internet.crawl" && item.name !== "internet.map") {
      continue;
    }
    const urls = readInternetUrlToolInputs(item.name, item.input);
    const invalidUrls = urls.filter((url) => isPublicInternetHttpUrl(url) === false);
    if (invalidUrls.length === 0) {
      continue;
    }
    throw new DecisionCompileError(
      "DECISION_SCHEMA_FAILED",
      `${item.name} requires public absolute http/https URLs and cannot inspect localhost, private network, or local app URLs.`,
      "schema",
      {
        reason: "internet_tool_local_url_rejected",
        toolName: item.name,
        path: item.path,
        field: item.name === "internet.extract" && Array.isArray(asRecord(item.input)?.urls) ? "urls" : "url",
        invalidValues: invalidUrls,
        expected: "public absolute http or https URLs",
        requiredCorrection:
          "Use local filesystem, dev shell, or browser/local app verification tools for localhost and generated app URLs.",
      },
    );
  }
}

function readInternetUrlToolInputs(toolName: string, input: unknown): string[] {
  const record = asRecord(input);
  if (record === undefined) {
    return [];
  }
  if (toolName === "internet.extract" && Array.isArray(record.urls)) {
    return record.urls.filter((url): url is string => typeof url === "string");
  }
  return typeof record.url === "string" ? [record.url] : [];
}

export function compileDraftIntent(input: CompileDraftIntentInput): CompiledIntent | undefined {
  const canonicalIntent = resolveCanonicalIntentContext({
    compiledIntent: undefined,
    executionIntent: input.executionIntent,
    intentMetadata: input.intentMetadata,
    intentConfidence: input.intentConfidence,
    toolIntent: input.toolIntent,
  });
  const draftIntent =
    input.draftIntent ??
    (canonicalIntent.executionIntent === undefined
      ? undefined
      : {
          version: "v3",
          execution: canonicalIntent.executionIntent,
          ...(canonicalIntent.intentMetadata !== undefined
            ? { metadata: canonicalIntent.intentMetadata }
            : {}),
          confidence: canonicalIntent.intentConfidence ?? canonicalIntent.toolIntent?.confidence ?? 1,
        } satisfies DraftIntent);
  if (draftIntent === undefined) {
    return ;
  }

  const candidateTools = buildCandidateViews(draftIntent.execution, input.capabilityManifest);
  const allowlistedCandidates = allowlistedCandidateNames(candidateTools);
  const explicitOperationKind = draftIntent.execution.operationIntent?.kind;
  const operationCompatibleCandidates =
    explicitOperationKind === undefined
      ? [...allowlistedCandidates]
      : filterCandidatesByOperationIntent(allowlistedCandidates, explicitOperationKind);
  const usableCandidates =
    explicitOperationKind === undefined
      ? [...allowlistedCandidates]
      : operationCompatibleCandidates.length > 0
        ? operationCompatibleCandidates
        : [];
  const requiredCapabilities = Array.from(
    new Set([
      ...requiredCapabilitiesForOperationIntent(explicitOperationKind),
      ...requiredCapabilitiesForVerificationIntent(draftIntent.metadata?.verificationIntent),
      ...deriveRequiredCapabilities(candidateTools),
    ]),
  );
  const resolvedToolName = resolveExecutionIntentToolName({
    execution: draftIntent.execution,
    candidateViews: candidateTools,
    metadata: draftIntent.metadata,
  });
  const concreteToolName =
    resolvedToolName !== undefined && usableCandidates.includes(resolvedToolName)
      ? resolvedToolName
      : undefined;
  const issues: CompiledIntentIssue[] = [];
  if (draftIntent.execution.clarification?.needed === true) {
    issues.push({
      code: "clarification_required",
      message: "The draft intent requires user clarification before execution can continue.",
      details: {
        ...(draftIntent.execution.clarification.prompt !== undefined
          ? { prompt: draftIntent.execution.clarification.prompt }
          : {}),
      },
    });
  }
  if (allowlistedCandidates.length === 0) {
    issues.push({
      code: "no_allowlisted_candidates",
      message: "The draft intent does not currently map to allowlisted capability-manifest tools.",
      details: {
        candidateTools: draftIntent.execution.candidateTools,
      },
    });
  }
  if (
    explicitOperationKind !== undefined &&
    allowlistedCandidates.length > 0 &&
    operationCompatibleCandidates.length === 0
  ) {
    issues.push({
      code: "operation_candidate_mismatch",
      message: "The draft intent's explicit operation kind does not match any allowlisted candidate tool.",
      details: {
        operationKind: explicitOperationKind,
        candidateTools: allowlistedCandidates,
        requiredCapabilities,
      },
    });
  }

  return {
    version: "compiled_v1",
    source: input.source ?? inferCompiledIntentSource(input, draftIntent),
    execution: draftIntent.execution,
    ...(draftIntent.metadata !== undefined ? { metadata: draftIntent.metadata } : {}),
    confidence: draftIntent.confidence,
    candidateTools,
    allowlistedCandidates,
    operationCompatibleCandidates,
    usableCandidates,
    requiredCapabilities,
    ...(concreteToolName !== undefined ? { concreteToolName } : {}),
    isAmbiguous:
      draftIntent.execution.clarification?.needed === true ||
      concreteToolName === undefined,
    nextStep: resolveCompiledIntentNextStep(issues),
    issues,
  };
}

export function compileIntentState(input: {
  value: unknown;
  capabilityManifest: Array<{
    name: string;
    description?: string | undefined;
    freshnessClass?: string | undefined;
    latencyClass?: string | undefined;
    costClass?: string | undefined;
    capabilityClasses?: string[] | undefined;
    executionClass?: ToolExecutionClass | undefined;
  }>;
}): CompiledIntent | undefined {
  const record = asRecord(input.value);
  if (record?.version === "compiled_v1") {
    const reparsedDraft = parseDraftIntent({
      version: "v3",
      execution: record.execution,
      metadata: record.metadata,
      confidence: record.confidence,
    });
    if (reparsedDraft === undefined) {
      return ;
    }
    return compileDraftIntent({
      draftIntent: reparsedDraft,
      capabilityManifest: input.capabilityManifest,
      source: "compiled_intent",
    });
  }

  const draftIntent = parseDraftIntent(input.value);
  if (draftIntent === undefined) {
    return ;
  }
  return compileDraftIntent({
    draftIntent,
    capabilityManifest: input.capabilityManifest,
  });
}

export function serializeCompiledIntentForState(
  value: CompiledIntent | undefined,
): CompiledIntent | undefined {
  if (value === undefined) {
    return ;
  }
  return {
    ...value,
    candidateTools: value.candidateTools.map((candidate) => ({
      ...candidate,
      capabilityClasses: [...candidate.capabilityClasses],
    })),
    allowlistedCandidates: [...value.allowlistedCandidates],
    operationCompatibleCandidates: [...value.operationCompatibleCandidates],
    usableCandidates: [...value.usableCandidates],
    requiredCapabilities: [...value.requiredCapabilities],
    issues: value.issues.map((issue) => ({
      ...issue,
      ...(issue.details !== undefined ? { details: { ...issue.details } } : {}),
    })),
  };
}

export function buildToolIntentContextFromCompiledIntent(
  value: CompiledIntent,
): DecisionContextToolIntent {
  return {
    objective: value.execution.objective,
    confidence: value.confidence,
    candidateTools: value.candidateTools,
    allowlistedCandidates: value.allowlistedCandidates,
    derivedRequiredCapabilities: value.requiredCapabilities,
    ...(value.execution.operationIntent !== undefined
      ? { operationIntent: value.execution.operationIntent }
      : {}),
    ...(value.metadata?.workflowIntent !== undefined
      ? { workflowIntent: value.metadata.workflowIntent }
      : {}),
    ...(value.execution.inputHints !== undefined ? { inputHints: value.execution.inputHints } : {}),
    ...(value.execution.command !== undefined ? { command: value.execution.command } : {}),
    ...(value.execution.commandMode !== undefined ? { commandMode: value.execution.commandMode } : {}),
    ...(value.execution.clarification !== undefined
      ? { clarification: value.execution.clarification }
      : {}),
    ...(value.metadata?.repoScope !== undefined ? { repoScope: value.metadata.repoScope } : {}),
    ...(value.metadata?.verificationIntent !== undefined
      ? { verificationIntent: value.metadata.verificationIntent }
      : {}),
    ...(value.metadata?.workspaceTargets !== undefined
      ? { workspaceTargets: value.metadata.workspaceTargets }
      : {}),
    ...(value.metadata?.hostWorkflowKind !== undefined
      ? { hostWorkflowKind: value.metadata.hostWorkflowKind }
      : {}),
    ...(value.metadata?.executionPreference !== undefined
      ? { executionPreference: value.metadata.executionPreference }
      : {}),
    ...(value.metadata?.followUpSourceSelection !== undefined
      ? { followUpSourceSelection: value.metadata.followUpSourceSelection }
      : {}),
    ...(value.metadata?.toolUseIntent !== undefined ? { toolUseIntent: value.metadata.toolUseIntent } : {}),
    ...(value.concreteToolName !== undefined ? { concreteToolName: value.concreteToolName } : {}),
    isAmbiguous: value.isAmbiguous,
  };
}

function resolveCanonicalIntentContext(input: {
  compiledIntent?: CompiledIntent | undefined;
  executionIntent?: DecisionContextExecutionIntent | undefined;
  intentMetadata?: DecisionContextIntentMetadata | undefined;
  intentConfidence?: number | undefined;
  toolIntent?: DecisionContextToolIntent | undefined;
}): {
  executionIntent: DecisionContextExecutionIntent | undefined;
  intentMetadata: DecisionContextIntentMetadata | undefined;
  intentConfidence: number | undefined;
  toolIntent: DecisionContextToolIntent | undefined;
} {
  if (input.compiledIntent !== undefined) {
    return {
      executionIntent: input.compiledIntent.execution,
      intentMetadata: input.compiledIntent.metadata,
      intentConfidence: input.compiledIntent.confidence,
      toolIntent: buildToolIntentContextFromCompiledIntent(input.compiledIntent),
    };
  }

  if (input.executionIntent !== undefined || input.intentMetadata !== undefined) {
    return {
      executionIntent: input.executionIntent,
      intentMetadata: input.intentMetadata,
      intentConfidence: input.intentConfidence,
      toolIntent:
        input.executionIntent === undefined
          ? input.toolIntent
          : {
              objective: input.executionIntent.objective,
              confidence: input.intentConfidence ?? input.toolIntent?.confidence ?? 1,
              candidateTools:
                input.toolIntent?.candidateTools ?? input.executionIntent.candidateTools,
              allowlistedCandidates: input.toolIntent?.allowlistedCandidates ?? [],
              derivedRequiredCapabilities: input.toolIntent?.derivedRequiredCapabilities ?? [],
              ...(input.executionIntent.operationIntent !== undefined
                ? { operationIntent: input.executionIntent.operationIntent }
                : {}),
              ...(input.intentMetadata?.workflowIntent !== undefined
                ? { workflowIntent: input.intentMetadata.workflowIntent }
                : {}),
              ...(input.executionIntent.inputHints !== undefined
                ? { inputHints: input.executionIntent.inputHints }
                : {}),
              ...(input.executionIntent.command !== undefined ? { command: input.executionIntent.command } : {}),
              ...(input.executionIntent.commandMode !== undefined
                ? { commandMode: input.executionIntent.commandMode }
                : {}),
              ...(input.executionIntent.clarification !== undefined
                ? { clarification: input.executionIntent.clarification }
                : {}),
              ...(input.intentMetadata?.repoScope !== undefined ? { repoScope: input.intentMetadata.repoScope } : {}),
              ...(input.intentMetadata?.verificationIntent !== undefined
                ? { verificationIntent: input.intentMetadata.verificationIntent }
                : {}),
              ...(input.intentMetadata?.workspaceTargets !== undefined
                ? { workspaceTargets: input.intentMetadata.workspaceTargets }
                : {}),
              ...(input.intentMetadata?.hostWorkflowKind !== undefined
                ? { hostWorkflowKind: input.intentMetadata.hostWorkflowKind }
                : {}),
              ...(input.intentMetadata?.executionPreference !== undefined
                ? { executionPreference: input.intentMetadata.executionPreference }
                : {}),
              ...(input.intentMetadata?.followUpSourceSelection !== undefined
                ? { followUpSourceSelection: input.intentMetadata.followUpSourceSelection }
                : {}),
              ...(input.intentMetadata?.toolUseIntent !== undefined
                ? { toolUseIntent: input.intentMetadata.toolUseIntent }
                : {}),
            },
    };
  }

  return {
    executionIntent:
      input.toolIntent === undefined
        ? undefined
        : {
            objective: input.toolIntent.objective,
            candidateTools: input.toolIntent.candidateTools.map((candidate) =>
              typeof candidate === "string" ? candidate : candidate.name
            ),
            ...(input.toolIntent.operationIntent !== undefined
              ? { operationIntent: input.toolIntent.operationIntent }
              : {}),
            ...(input.toolIntent.inputHints !== undefined ? { inputHints: input.toolIntent.inputHints } : {}),
            ...(input.toolIntent.command !== undefined ? { command: input.toolIntent.command } : {}),
            ...(input.toolIntent.commandMode !== undefined ? { commandMode: input.toolIntent.commandMode } : {}),
            ...(input.toolIntent.clarification !== undefined
              ? { clarification: input.toolIntent.clarification }
              : {}),
          },
    intentMetadata:
      input.toolIntent === undefined
        ? undefined
        : {
            ...(input.toolIntent.workflowIntent !== undefined
              ? { workflowIntent: input.toolIntent.workflowIntent }
              : {}),
            ...(input.toolIntent.repoScope !== undefined ? { repoScope: input.toolIntent.repoScope } : {}),
            ...(input.toolIntent.verificationIntent !== undefined
              ? { verificationIntent: input.toolIntent.verificationIntent }
              : {}),
            ...(input.toolIntent.workspaceTargets !== undefined
              ? { workspaceTargets: input.toolIntent.workspaceTargets }
              : {}),
            ...(input.toolIntent.hostWorkflowKind !== undefined
              ? { hostWorkflowKind: input.toolIntent.hostWorkflowKind }
              : {}),
            ...(input.toolIntent.executionPreference !== undefined
              ? { executionPreference: input.toolIntent.executionPreference }
              : {}),
            ...(input.toolIntent.followUpSourceSelection !== undefined
              ? { followUpSourceSelection: input.toolIntent.followUpSourceSelection }
              : {}),
            ...(input.toolIntent.toolUseIntent !== undefined
              ? { toolUseIntent: input.toolIntent.toolUseIntent }
              : {}),
          },
    intentConfidence: input.toolIntent?.confidence,
    toolIntent: input.toolIntent,
  };
}

function inferCompiledIntentSource(
  input: CompileDraftIntentInput,
  draftIntent: DraftIntent,
): CompiledIntent["source"] {
  if (input.source !== undefined) {
    return input.source;
  }
  if (input.draftIntent !== undefined) {
    return "draft_intent";
  }
  if (input.executionIntent !== undefined || input.intentMetadata !== undefined) {
    return "decision_context";
  }
  if (input.toolIntent !== undefined) {
    return "legacy_tool_intent";
  }
  return draftIntent.version === "v3" ? "draft_intent" : "legacy_tool_intent";
}

function resolveCompiledIntentNextStep(
  issues: CompiledIntentIssue[],
): CompiledIntentNextStep {
  if (issues.some((issue) => issue.code === "clarification_required")) {
    return "wait_user";
  }
  if (issues.length > 0) {
    return "deliberator";
  }
  return "deliberator";
}

function filterCandidatesByOperationIntent(
  candidates: string[],
  operationKind:
    | "write_file"
    | "scaffold_app"
    | "run_host_command"
    | "run_sandbox_code"
    | "read_file"
    | "inspect_repo",
): string[] {
  return candidates.filter((toolName) => toolMatchesOperationIntent(toolName, operationKind));
}

function toolMatchesOperationIntent(
  toolName: string,
  operationKind:
    | "write_file"
    | "scaffold_app"
    | "run_host_command"
    | "run_sandbox_code"
    | "read_file"
    | "inspect_repo",
): boolean {
  if (operationKind === "write_file") {
    return toolName === "fs.write_text" || toolName === "fs.replace_text";
  }
  if (operationKind === "scaffold_app") {
    return toolName === "exec_command";
  }
  if (operationKind === "run_host_command") {
    return toolName === "exec_command" ||
      toolName === "dev.process.start" ||
      toolName === "dev.process.write" ||
      toolName === "dev.process.write_and_read";
  }
  if (operationKind === "run_sandbox_code") {
    return toolName === "code.execute";
  }
  if (operationKind === "read_file") {
    return toolName === "fs.read_text";
  }
  if (operationKind === "inspect_repo") {
    return toolName === "fs.list" || toolName === "fs.search_text" || toolName === "fs.read_text" || toolName === "repo.trace";
  }
  return false;
}

function requiredCapabilitiesForOperationIntent(
  operationKind:
    | "write_file"
    | "scaffold_app"
    | "run_host_command"
    | "run_sandbox_code"
    | "read_file"
    | "inspect_repo"
    | undefined,
): string[] {
  if (operationKind === "write_file") {
    return ["fs.write"];
  }
  if (operationKind === "scaffold_app") {
    return ["dev.shell", "host.shell"];
  }
  if (operationKind === "run_host_command") {
    return ["dev.shell", "host.shell"];
  }
  if (operationKind === "run_sandbox_code") {
    return ["code.execute", "code.sandbox"];
  }
  if (operationKind === "read_file" || operationKind === "inspect_repo") {
    return ["fs.read"];
  }
  return [];
}

function requiredCapabilitiesForVerificationIntent(
  verificationIntent: DecisionContextIntentMetadata["verificationIntent"] | undefined,
): string[] {
  if (verificationIntent?.requested !== true) {
    return [];
  }
  return verificationIntent.kinds?.includes("browser") === true ? ["browser.automation"] : [];
}

function requiredCapabilitiesForCanonicalIntent(input: {
  intentMetadata: DecisionContextIntentMetadata | undefined;
  toolIntent: DecisionContextToolIntent | undefined;
}): string[] {
  return mergeRequiredCapabilities(
    requiredCapabilitiesForVerificationIntent(input.intentMetadata?.verificationIntent),
    (input.toolIntent?.derivedRequiredCapabilities ?? []).filter(isBrowserAutomationCapability),
  );
}

function mergeRequiredCapabilities(...sets: Array<readonly string[] | undefined>): string[] {
  return uniqueStrings(sets.flatMap((set) => [...(set ?? [])]));
}

function normalizeCompiledDecisionAction(
  action: ReactAction,
  workspaceRoot: string | undefined,
): ReactAction {
  if (action.kind === "tool") {
    return {
      ...action,
      input: normalizeToolActionInput(action.name, action.input, workspaceRoot),
    };
  }

  if (action.kind === "tool_batch") {
    return {
      ...action,
      items: action.items.map((item) => ({
        ...item,
        input: normalizeToolActionInput(item.name, item.input, workspaceRoot),
      })),
    };
  }

  return action;
}

function readActiveWorkspaceRootFromDevShellProcesses(
  devShellProcesses: Record<string, unknown>[] | undefined,
): string | undefined {
  for (const process of asArray(devShellProcesses)) {
    const processWorkspaceRoot = asString(asRecord(process)?.workspaceRoot)?.trim();
    if (processWorkspaceRoot !== undefined && processWorkspaceRoot.length > 0) {
      return processWorkspaceRoot;
    }
  }
  return ;
}

function validateDevShellProcessBatchContract(action: ReactAction): void {
  if (action.kind !== "tool_batch" || action.items.length <= 1) {
    return;
  }
  const stopItem = action.items.find((item) => item.name === "dev.process.stop");
  if (stopItem === undefined) {
    return;
  }
  throw new DecisionCompileError(
    "DECISION_POLICY_FAILED",
    "dev.process.stop must be emitted as a single process action, not batched with other tools.",
    "policy",
    {
      reason: "dev_process_stop_batch_rejected",
      toolName: "dev.process.stop",
      actionKind: "tool_batch",
      requiredCorrection: "emit_dev.process.stop_as_single_action_then_observe",
    },
  );
}

function validateDevShellWriteStdinInput(action: ReactAction): void {
  const items =
    action.kind === "tool"
      ? [{ name: action.name, input: action.input }]
      : action.kind === "tool_batch"
        ? action.items
        : [];
  for (const item of items) {
    if (item.name !== "dev.process.write" && item.name !== "dev.process.write_and_read") {
      continue;
    }
    const text = asString(item.input.data) ?? asString(item.input.input);
    if (text === undefined) {
      continue;
    }
    if (text.includes("\\n") && text.includes("\n") === false) {
      throw new DecisionCompileError(
        "DECISION_POLICY_FAILED",
        `${item.name} input contains literal backslash-n instead of an actual newline.`,
        "policy",
        {
          reason: "dev_shell_stdin_literal_escaped_newline",
          toolName: item.name,
          requiredCorrection:
            "This sends backslash-n literally. Use an actual newline character if the process expects Enter.",
        },
      );
    }
  }
}

function validateActiveDevShellExecInput(input: {
  action: ReactAction;
  devShellProcesses: Record<string, unknown>[] | undefined;
  postToolVerification: Record<string, unknown> | undefined;
}): void {
  const activeFacts = readActiveDevShellProcessFacts(input.devShellProcesses, input.postToolVerification);
  if (activeFacts.active !== true) {
    return;
  }
  const execActions = collectDevShellToolActions(input.action).filter((item) =>
    item.name === "dev.shell.run" || item.name === "dev.process.start"
  );
  for (const action of execActions) {
    const command = asString(asRecord(action.input)?.command);
    if (command === undefined) {
      continue;
    }
    const hasActualNewline = command.includes("\n") || command.includes("\r");
    const hasEscapedNewline = command.includes("\\n") || command.includes("\\r");
    if (hasActualNewline === false && hasEscapedNewline === false) {
      continue;
    }
    throw new DecisionCompileError(
      "DECISION_POLICY_FAILED",
      `${action.name} cannot run newline-shaped shell text while a live foreground process is active.`,
      "policy",
      {
        reason: hasActualNewline
          ? "active_process_exec_multiline_rejected"
          : "active_process_exec_literal_escaped_newline_rejected",
        toolName: action.name,
        activeProcessPresent: true,
        ...(activeFacts.activeProcessId !== undefined ? { activeProcessId: activeFacts.activeProcessId } : {}),
        liveProcessIds: activeFacts.liveProcessIds,
        commandPreview: command.slice(0, 240),
        requiredCorrection:
          "A live process is active. Do not run controller scripts or escaped newline text as a new command. Use the live process/session id, stop it before running shell commands, or create files with file tools.",
      },
    );
  }
}

function readActiveDevShellProcessFacts(
  devShellProcesses: Record<string, unknown>[] | undefined,
  postToolVerification: Record<string, unknown> | undefined,
): { active: boolean; activeProcessId?: string | undefined; liveProcessIds: string[] } {
  const devShell = asRecord(postToolVerification?.devShell);
  const activeProcessId =
    asString(devShell?.activeProcessId)?.trim() ??
    asString(devShell?.processId)?.trim() ??
    asString(devShell?.commandAttributionId)?.trim();
  const inactiveLatestProcessId =
    devShell?.activeProcessPresent === false
      ? activeProcessId
      : undefined;
  const latestStatus = normalizeProcessStatus(asString(devShell?.status));
  const rawLiveProcessIds =
    devShellProcesses
      ?.filter((process) => process.live === true || normalizeProcessStatus(asString(process.status)) === "RUNNING")
      .map((process) => asString(process.processId))
      .filter((processId): processId is string => processId !== undefined && processId.trim().length > 0)
      .map((processId) => processId.trim()) ?? [];
  const liveProcessIds =
    inactiveLatestProcessId !== undefined &&
      (latestStatus === "STOPPED" || latestStatus === "COMPLETED" || latestStatus === "FAILED")
      ? rawLiveProcessIds.filter((processId) => processId !== inactiveLatestProcessId)
      : rawLiveProcessIds;
  const active =
    liveProcessIds.length > 0 ||
    devShell?.activeProcessPresent === true ||
    (activeProcessId !== undefined && activeProcessId.length > 0 && devShell?.activeProcessPresent !== false);
  return {
    active,
    ...(activeProcessId !== undefined && activeProcessId.length > 0 ? { activeProcessId } : {}),
    liveProcessIds: activeProcessId !== undefined && activeProcessId.length > 0 && !liveProcessIds.includes(activeProcessId)
      ? [...liveProcessIds, activeProcessId]
      : liveProcessIds,
  };
}

function validateLiveDevShellExecReplay(input: {
  action: ReactAction;
  devShellProcesses: Record<string, unknown>[] | undefined;
}): void {
  const execActions = collectDevShellToolActions(input.action).filter((item) =>
    item.name === "dev.process.start" || item.name === "exec_command"
  );
  if (execActions.length === 0 || input.devShellProcesses === undefined) {
    return;
  }
  for (const action of execActions) {
    const actionInput = asRecord(action.input);
    const requestedCommand = asString(actionInput?.command)?.trim();
    if (requestedCommand === undefined || requestedCommand.length === 0) {
      continue;
    }
    const liveProcess = findMatchingLiveProcessForCommand(input.devShellProcesses, actionInput, requestedCommand);
    if (liveProcess === undefined) {
      continue;
    }
    throw new DecisionCompileError(
      "DECISION_POLICY_FAILED",
      "Cannot start the same command while that command already has a live process; continue or stop the live process first.",
      "policy",
      {
        reason: "live_dev_process_start_replay_requires_process_continuation",
        toolName: action.name,
        command: requestedCommand,
        processId: liveProcess.processId,
        liveProcessIds: input.devShellProcesses
          .filter((process) => process.live === true || normalizeProcessStatus(asString(process.status)) === "RUNNING")
          .map((process) => asString(process.processId))
          .filter((processId): processId is string => processId !== undefined),
        requiredCorrection: action.name === "exec_command"
          ? "Continue the live session with exec_command sessionId + stdin/read, or stop it before starting a new process. Use fresh command only when intentionally resetting or starting unrelated work."
          : "Continue the live process with write/read, or stop it before starting a new process. Use fresh start only when intentionally resetting or starting unrelated work.",
      },
    );
  }
}

function findMatchingLiveProcessForCommand(
  devShellProcesses: Record<string, unknown>[],
  actionInput: Record<string, unknown> | undefined,
  requestedCommand: string,
): { processId: string } | undefined {
  const requestedCwd = asString(actionInput?.cwd)?.trim();
  const requestedWorkspaceRoot = asString(actionInput?.workspaceRoot)?.trim();
  for (const process of devShellProcesses) {
    const processId = asString(process.processId)?.trim();
    const processCommand = asString(process.command)?.trim();
    const processCwd = asString(process.cwd)?.trim();
    const processWorkspaceRoot = asString(process.workspaceRoot)?.trim();
    const live = process.live === true || normalizeProcessStatus(asString(process.status)) === "RUNNING";
    if (live !== true || processId === undefined || processCommand !== requestedCommand) {
      continue;
    }
    if (requestedCwd !== undefined && processCwd !== undefined && requestedCwd !== processCwd) {
      continue;
    }
    if (
      requestedWorkspaceRoot !== undefined &&
      processWorkspaceRoot !== undefined &&
      requestedWorkspaceRoot !== processWorkspaceRoot
    ) {
      continue;
    }
    return { processId };
  }
  return ;
}

function validateDevShellProcessTargets(
  action: ReactAction,
  devShellProcesses: Record<string, unknown>[] | undefined,
  postToolVerification: Record<string, unknown> | undefined,
): void {
  if (devShellProcesses === undefined) {
    return;
  }
  const processFacts = new Map<string, { live: boolean; status?: string | undefined }>();
  for (const entry of devShellProcesses) {
    const processId = asString(entry.processId)?.trim();
    if (processId === undefined || processId.length === 0) {
      continue;
    }
    processFacts.set(processId, {
      live: entry.live === true,
      ...(asString(entry.status) !== undefined ? { status: asString(entry.status) } : {}),
    });
  }
  const devShellVerification = asRecord(postToolVerification?.devShell);
  const activeProcessId = asString(devShellVerification?.activeProcessId)?.trim();
  if (activeProcessId !== undefined && activeProcessId.length > 0 && !processFacts.has(activeProcessId)) {
    processFacts.set(activeProcessId, {
      live: devShellVerification?.activeProcessPresent === true,
      ...(asString(devShellVerification?.status) !== undefined ? { status: asString(devShellVerification?.status) } : {}),
    });
  }
  const items =
    action.kind === "tool"
      ? [{ name: action.name, input: action.input }]
      : action.kind === "tool_batch"
        ? action.items
        : [];
  for (const item of items) {
    if (!isDevShellProcessTargetTool(item.name)) {
      continue;
    }
    const processId = asString(asRecord(item.input)?.processId)?.trim();
    if (processId === undefined || processId.length === 0) {
      continue;
    }
    const fact = processFacts.get(processId);
    if (fact === undefined) {
      const liveProcessIds = [...processFacts.entries()].filter(([, value]) => value.live).map(([id]) => id);
      throw new DecisionCompileError(
        "DECISION_POLICY_FAILED",
        `${item.name} must target a known dev-shell processId from the current process table.`,
        "policy",
        {
          reason: "dev_shell_unknown_process_id",
          toolName: item.name,
          processId,
          knownProcessIds: [...processFacts.keys()],
          liveProcessIds,
          requiredCorrection: liveProcessIds.length === 0
            ? "do_not_invent_process_handles_no_live_process_remains_use_exec_command_or_repair_controller_file"
            : "use_listed_live_process_id_or_start_needed_command_with_dev.process.start",
        },
      );
    }
    if (
      (item.name === "dev.process.write" ||
        item.name === "dev.process.write_and_read" ||
        item.name === "dev.process.stop") &&
      fact.live !== true
    ) {
      const liveProcessIds = [...processFacts.entries()].filter(([, value]) => value.live).map(([id]) => id);
      throw new DecisionCompileError(
        "DECISION_POLICY_FAILED",
        `${item.name} must target a live dev-shell processId.`,
        "policy",
        {
          reason: "dev_shell_inactive_process_target",
          toolName: item.name,
          processId,
          status: fact.status,
          liveProcessIds,
          requiredCorrection: liveProcessIds.length === 0
            ? "chosen_process_is_not_live_no_live_process_remains_use_exec_command_or_repair_controller_file"
            : "chosen_process_is_not_live_use_listed_live_process_id_or_start_needed_command_with_dev.process.start",
        },
      );
    }
  }
}

function isDevShellProcessTargetTool(toolName: string): boolean {
  return (
    toolName === "dev.process.write" ||
    toolName === "dev.process.write_and_read" ||
    toolName === "dev.process.read" ||
    toolName === "dev.process.stop"
  );
}

function normalizeSourcePath(path: string | undefined): string | undefined {
  const trimmed = path?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return ;
  }
  return trimmed
    .replace(/\\/gu, "/")
    .replace(/\/+/gu, "/")
    .replace(/^\.\//u, "")
    .replace(/\/\.\//gu, "/");
}

function sourcePathMatches(candidatePath: string | undefined, sourcePath: string | undefined): boolean {
  if (candidatePath === undefined || sourcePath === undefined) {
    return false;
  }
  return candidatePath === sourcePath ||
    candidatePath.endsWith(`/${sourcePath}`) ||
    sourcePath.endsWith(`/${candidatePath}`);
}

function lastActionProvidedHelperProcessEvidence(
  lastActionResult: unknown,
  evidenceContext: EvidenceLedgerContext | undefined,
): boolean {
  const last = asRecord(lastActionResult);
  const toolName = asString(last?.name);
  if (
    toolName === "exec_command" ||
    toolName === "dev.shell.run" ||
    toolName === "dev.process.write_and_read" ||
    toolName === "dev.process.read" ||
    toolName === "dev.process.stop"
  ) {
    return true;
  }
  const latest = evidenceContext?.latest;
  if (latest === undefined) {
    return false;
  }
  const facts = asRecord(latest.facts);
  return latest.kind === "helper_outcome" ||
    ((asString(facts?.commandRole) === "helper_execution" || asString(facts?.commandRole) === "helper_repair_check") &&
      (latest.kind === "process_result" || latest.kind === "process_state"));
}

function latestHelperEvidenceToolName(evidenceContext: EvidenceLedgerContext | undefined): string | undefined {
  const latest = evidenceContext?.latest;
  return asString(asRecord(latest?.facts)?.toolName);
}

const DISALLOWED_INTERACTIVE_EXEC_COMMANDS = new Set(["nano", "vim", "vi", "emacs", "ed", "pico"]);

function validateDevShellExecCommandContract(action: ReactAction): void {
  for (const item of collectDevShellToolActions(action)) {
    if (item.name === "exec_command") {
      const input = asRecord(item.input);
      const command = asString(input?.command);
      const sessionId = asString(input?.sessionId);
      const hasStdin = input !== undefined && Object.hasOwn(input, "stdin");
      const hasStop = input?.stop === true;
      if (command !== undefined && (sessionId !== undefined || hasStdin || hasStop)) {
        throw new DecisionCompileError(
          "DECISION_SCHEMA_FAILED",
          "exec_command input mixed start-process fields with continuation fields.",
          "schema",
          {
            reason: "exec_command_ambiguous_lifecycle_input",
            toolName: "exec_command",
            fields: ["command", "sessionId", "stdin", "stop"],
            requiredCorrection:
              "Use command by itself to start a new process, or use sessionId with stdin/stop to continue an existing process. Do not include both shapes.",
          },
        );
      }
      continue;
    }
    if (item.name !== "dev.shell.run") {
      continue;
    }
    const command = asString(asRecord(item.input)?.command);
    const executable = readPrimaryShellExecutable(command);
    if (executable !== undefined && DISALLOWED_INTERACTIVE_EXEC_COMMANDS.has(executable)) {
      throw new DecisionCompileError(
        "DECISION_POLICY_FAILED",
        `dev.shell.run cannot launch full-screen interactive editor '${executable}'.`,
        "policy",
        {
          reason: "interactive_editor_exec_rejected",
          toolName: "dev.shell.run",
          command,
          executable,
          requiredCorrection: "write_source_with_typed_filesystem_tool",
        },
      );
    }
    if (isInteractivePythonInterpreterCommand(command)) {
      throw new DecisionCompileError(
        "DECISION_POLICY_FAILED",
        "dev.shell.run cannot launch an interactive Python interpreter for helper repair.",
        "policy",
        {
          reason: "interactive_interpreter_exec_rejected",
          toolName: "dev.shell.run",
          command,
          executable,
          requiredCorrection: "write_or_repair_source_with_typed_filesystem_tool",
        },
      );
    }
  }
}

function isInteractivePythonInterpreterCommand(command: string | undefined): boolean {
  const trimmed = command?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return false;
  }
  const match = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)*([^\s;&|()<>]+)\s+(-[A-Za-z]*i[A-Za-z]*)(?:\s|$)/u.exec(trimmed);
  const rawExecutable = match?.[1]?.trim();
  const executable = rawExecutable?.split("/").filter((part) => part.length > 0).at(-1)?.toLowerCase();
  if (executable === undefined || match?.[2] === undefined) {
    return false;
  }
  if (/^python(?:3(?:\.\d+)?)?$/u.test(executable) === false) {
    return false;
  }
  return true;
}

function readPrimaryShellExecutable(command: string | undefined): string | undefined {
  const trimmed = command?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return ;
  }
  const match = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)\s+)*([^\s;&|()<>]+)/u.exec(trimmed);
  const raw = match?.[1]?.trim();
  if (raw === undefined || raw.length === 0) {
    return ;
  }
  return raw.split("/").filter((part) => part.length > 0).at(-1)?.toLowerCase();
}

function readActionToolNames(action: ReactAction): string[] {
  if (action.kind === "tool") {
    return [action.name];
  }
  if (action.kind === "tool_batch") {
    return action.items.map((item) => item.name);
  }
  if (action.kind === "effect") {
    return [action.type];
  }
  return [];
}

function collectToolActionItems(
  action: ReactAction,
): Array<{ name: string; input: unknown; executionRole?: unknown | undefined }> {
  if (action.kind === "tool") {
    return [{ name: action.name, input: action.input, executionRole: action.executionRole }];
  }
  if (action.kind === "tool_batch") {
    return action.items.map((item) => ({ name: item.name, input: item.input, executionRole: item.executionRole }));
  }
  return [];
}

function actionTargetsProcess(action: ReactAction, processId: string): boolean {
  if (action.kind === "tool") {
    return asString(action.input.processId) === processId;
  }
  if (action.kind === "tool_batch") {
    return action.items.every((item) => asString(item.input.processId) === processId);
  }
  return false;
}

function actionTargetsAnyLiveProcess(action: ReactAction, processIds: Set<string>): boolean {
  if (processIds.size === 0) {
    return false;
  }
  if (action.kind === "tool") {
    const processId = asString(action.input.processId);
    return processId !== undefined && processIds.has(processId);
  }
  if (action.kind === "tool_batch") {
    return action.items.every((item) => {
      const processId = asString(item.input.processId);
      return processId !== undefined && processIds.has(processId);
    });
  }
  return false;
}

function actionIsStopForProcess(action: ReactAction, processId: string): boolean {
  return action.kind === "tool" &&
    action.name === "dev.process.stop" &&
    asString(action.input.processId) === processId;
}

function findLiveProcessForCommand(
  devShellProcesses: Record<string, unknown>[] | undefined,
  command: string | undefined,
): string | undefined {
  const expectedCommand = command?.trim();
  if (expectedCommand === undefined || expectedCommand.length === 0) {
    return ;
  }
  return devShellProcesses
    ?.map((process) => {
      const processId = asString(process.processId)?.trim() ?? "";
      const processCommand = asString(process.command)?.trim() ?? "";
      const status = normalizeProcessStatus(asString(process.status));
      const live = process.live === true || status === "RUNNING";
      return live && processId.length > 0 && processCommand === expectedCommand ? processId : undefined;
    })
    .find((processId): processId is string => processId !== undefined);
}

function normalizeProcessStatus(value: string | undefined): string | undefined {
  return value?.trim().toUpperCase();
}

export function validateToolActionSchemas(
  action: ReactAction,
  availableTools: ModelToolSpec[] | undefined,
): ReactAction {
  if (availableTools === undefined || availableTools.length === 0) {
    if (action.kind === "tool" || action.kind === "tool_batch") {
      throw new DecisionCompileError(
        "DECISION_SCHEMA_FAILED",
        "Tool actions require concrete availableTools definitions for schema validation.",
        "schema",
        {
          actionKind: action.kind,
          ...(action.kind === "tool"
            ? { toolName: action.name, path: "nextAction.name" }
            : { path: "nextAction.items" }),
          availableToolNames: [],
          reason: "tool_not_available",
        },
      );
    }
    return action;
  }

  const toolSpecs = new Map(availableTools.map((tool) => [tool.name, tool] as const));
  if (action.kind === "tool") {
    assertToolIsAvailable(action.name, "nextAction.name", toolSpecs);
    const sanitizedInput = sanitizeActionInputForSchema(action.name, action.input, toolSpecs);
    validateToolActionInput({
      name: action.name,
      input: sanitizedInput,
      path: "nextAction.input",
      toolSpecs,
    });
    return {
      ...action,
      input: sanitizedInput,
    };
  }

  if (action.kind === "tool_batch") {
    for (const [index, item] of action.items.entries()) {
      assertToolIsAvailable(item.name, `nextAction.items[${index}].name`, toolSpecs);
    }
    const sanitizedItems = action.items.map((item) => ({
      ...item,
      input: sanitizeActionInputForSchema(item.name, item.input, toolSpecs),
    }));
    for (const [index, item] of action.items.entries()) {
      validateToolActionInput({
        name: sanitizedItems[index]?.name ?? item.name,
        input: sanitizedItems[index]?.input ?? item.input,
        path: `nextAction.items[${index}].input`,
        toolSpecs,
      });
    }
    return {
      ...action,
      items: sanitizedItems,
    };
  }

  return action;
}

function assertToolIsAvailable(
  toolName: string,
  path: string,
  toolSpecs: Map<string, ModelToolSpec>,
): void {
  if (toolSpecs.has(toolName)) {
    return;
  }
  throw new DecisionCompileError(
    "DECISION_SCHEMA_FAILED",
    `Tool '${toolName}' is not available in the current action contract.`,
    "schema",
    {
      toolName,
      path,
      availableToolNames: [...toolSpecs.keys()],
      reason: "tool_not_available",
    },
  );
}

function sanitizeActionInputForSchema(
  name: string,
  input: Record<string, unknown>,
  toolSpecs: Map<string, ModelToolSpec>,
): Record<string, unknown> {
  const tool = toolSpecs.get(name);
  if (tool === undefined) {
    return input;
  }
  const sanitized = sanitizeToolInputForSchema(tool.inputSchema, input);
  return asRecord(sanitized) ?? input;
}

function validateToolActionInput(input: {
  name: string;
  input: Record<string, unknown>;
  path: string;
  toolSpecs: Map<string, ModelToolSpec>;
}): void {
  const toolSpec = input.toolSpecs.get(input.name);
  if (toolSpec === undefined) {
    return;
  }

  const validator = getToolInputValidator(input.name, toolSpec.inputSchema);
  const valid = validator(input.input);
  if (valid === true) {
    return;
  }

  const validationErrors = (validator.errors ?? []).map((error) => ({
    instancePath: error.instancePath,
    schemaPath: error.schemaPath,
    keyword: error.keyword,
    message: error.message,
  }));
  const primaryError = validator.errors?.[0];
  const primaryMessage = validationErrors[0]?.message ?? "input does not satisfy the tool schema.";
  throw new DecisionCompileError(
    "DECISION_SCHEMA_FAILED",
    `Tool action '${input.name}' input failed schema validation: ${primaryMessage}`,
    "schema",
    {
      toolName: input.name,
      path: input.path,
      expected: describeToolInputExpectation(primaryError),
      received: describeToolInputReceived(input.input, primaryError),
      schemaPath: primaryError?.schemaPath,
      validationPath: primaryError?.instancePath,
      validationErrors,
    },
  );
}

function describeToolInputExpectation(error: ErrorObject | undefined): string {
  if (error === undefined) {
    return "tool input matching the registered JSON schema";
  }
  if (error.keyword === "required") {
    const missingProperty = asString(asRecord(error.params)?.missingProperty);
    return missingProperty !== undefined && missingProperty.length > 0
      ? `required property '${missingProperty}'`
      : "required property";
  }
  if (error.keyword === "additionalProperties") {
    const additionalProperty = asString(asRecord(error.params)?.additionalProperty);
    return additionalProperty !== undefined && additionalProperty.length > 0
      ? `no additional property '${additionalProperty}'`
      : "no additional properties";
  }
  if (error.keyword === "type") {
    const expectedType = readAjvParamAsString(error.params, "type");
    return expectedType !== undefined ? `type ${expectedType}` : "schema type match";
  }
  if (error.keyword === "enum") {
    return "one of the allowed enum values";
  }
  return error.message ?? "tool input matching the registered JSON schema";
}

function describeToolInputReceived(input: Record<string, unknown>, error: ErrorObject | undefined): string {
  if (error?.keyword === "required") {
    return "missing";
  }
  if (error?.keyword === "additionalProperties") {
    const additionalProperty = asString(asRecord(error.params)?.additionalProperty);
    if (additionalProperty !== undefined && Object.hasOwn(input, additionalProperty)) {
      return describeValueShape(input[additionalProperty]);
    }
  }
  return describeValueShape(readJsonPointer(input, error?.instancePath));
}

function readAjvParamAsString(params: ErrorObject["params"], key: string): string | undefined {
  const value = asRecord(params)?.[key];
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const rendered = value
      .map((item) => asString(item))
      .filter((item): item is string => item !== undefined)
      .join(" | ");
    return rendered.length > 0 ? rendered : undefined;
  }
  return ;
}

function readJsonPointer(input: unknown, pointer: string | undefined): unknown {
  if (pointer === undefined || pointer.length === 0) {
    return input;
  }
  let current = input;
  for (const rawSegment of pointer.split("/").slice(1)) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }
    const record = asRecord(current);
    if (record === undefined) {
      return ;
    }
    current = record[segment];
  }
  return current;
}

function describeValueShape(value: unknown): string {
  if (value === undefined) {
    return "undefined";
  }
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function getToolInputValidator(
  name: string,
  schema: Record<string, unknown>,
): ValidateFunction {
  const schemaKey = `${name}:${JSON.stringify(schema)}`;
  const cached = TOOL_INPUT_VALIDATOR_CACHE.get(schemaKey);
  if (cached !== undefined) {
    return cached;
  }

  try {
    const validator = TOOL_INPUT_AJV.compile(schema);
    TOOL_INPUT_VALIDATOR_CACHE.set(schemaKey, validator);
    return validator;
  } catch (error) {
    throw new DecisionCompileError(
      "DECISION_SCHEMA_FAILED",
      `Tool action '${name}' uses an invalid input schema.`,
      "provider_schema",
      {
        toolName: name,
        reason: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

function isModelFacingToolCapability(capability: string): boolean {
  const staleProofCapability = ["artifact", "verification"].join("_");
  return capability.trim().toLowerCase() !== staleProofCapability;
}

function withCompiledActionRepetitionSignals(
  signals: DecisionRepetitionSignals | undefined,
  action: ReactAction,
  postToolVerification: Record<string, unknown> | undefined,
): DecisionRepetitionSignals | undefined {
  const nextToolName = resolveChosenActionName(action);
  const nextToolFamily = readPrimaryActionToolFamily(action);
  const nextToolInputHash = hashCompiledToolInput(action);
  void postToolVerification;
  const nextFilesystemInspectionKey = undefined;
  if (
    signals === undefined &&
    nextToolName === undefined &&
    nextToolFamily === undefined &&
    nextToolInputHash === undefined &&
    nextFilesystemInspectionKey === undefined
  ) {
    return ;
  }
  const {
    nextToolName: _priorNextToolName,
    nextToolFamily: _priorNextToolFamily,
    nextToolInputHash: _priorNextToolInputHash,
    nextFilesystemInspectionKey: _priorNextFilesystemInspectionKey,
    sameToolAsLastAction: _priorSameToolAsLastAction,
    sameInputAsLastAction: _priorSameInputAsLastAction,
    sameToolFamilyAsLastAction: _priorSameToolFamilyAsLastAction,
    sameFilesystemInspectionAsLastAction: _priorSameFilesystemInspectionAsLastAction,
    ...baseSignals
  } = signals ?? {};
  return {
    ...baseSignals,
    ...(nextToolName !== undefined ? { nextToolName } : {}),
    ...(nextToolFamily !== undefined ? { nextToolFamily } : {}),
    ...(nextToolInputHash !== undefined ? { nextToolInputHash } : {}),
    ...(nextFilesystemInspectionKey !== undefined ? { nextFilesystemInspectionKey } : {}),
    ...(signals?.lastToolName !== undefined && nextToolName !== undefined
      ? { sameToolAsLastAction: signals.lastToolName === nextToolName }
      : {}),
    ...(signals?.lastToolInputHash !== undefined && nextToolInputHash !== undefined
      ? { sameInputAsLastAction: signals.lastToolInputHash === nextToolInputHash }
      : {}),
    ...(signals?.lastToolFamily !== undefined && nextToolFamily !== undefined
      ? { sameToolFamilyAsLastAction: signals.lastToolFamily === nextToolFamily }
      : {}),
    ...(signals?.lastFilesystemInspectionKey !== undefined && nextFilesystemInspectionKey !== undefined
      ? { sameFilesystemInspectionAsLastAction: signals.lastFilesystemInspectionKey === nextFilesystemInspectionKey }
      : {}),
  };
}

function hashCompiledToolInput(action: ReactAction): string | undefined {
  if (action.kind === "tool") {
    return hashToolInput(action.name, action.input);
  }
  if (action.kind === "tool_batch") {
    if (action.items.length === 0) {
      return ;
    }
    if (action.items.length === 1) {
      const item = action.items[0];
      return item === undefined ? undefined : hashToolInput(item.name, item.input);
    }
    return stableObjectHash(
      action.items.map((item) => ({
        name: item.name,
        input: sortValue(item.input),
      })),
    );
  }
  return ;
}

function normalizeFilesystemPath(path: string): string | undefined {
  const trimmed = path.trim().replace(/\\/gu, "/");
  if (trimmed.length === 0) {
    return ;
  }
  const withoutPrefix = trimmed.replace(/^(?:\.\/)+/u, "");
  const collapsed = withoutPrefix.replace(/\/+/gu, "/").replace(/\/$/u, "");
  return collapsed.length === 0 ? "." : collapsed;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function isBrowserAutomationCapability(capability: string): boolean {
  return capability.trim().toLowerCase() === "browser.automation";
}

function readPrimaryActionToolFamily(action: ReactAction): string | undefined {
  if (action.kind === "tool") {
    return readRetrievalToolFamily(action.name);
  }
  if (action.kind === "tool_batch") {
    const families = uniqueStrings(
      action.items
        .map((item) => readRetrievalToolFamily(item.name))
        .filter((family) => family.length > 0),
    );
    return families.length === 1 ? families[0] : undefined;
  }
  return ;
}

function isDevShellToolName(name: string): boolean {
  return name === "exec_command" ||
    name === "dev.shell.run" ||
    name === "dev.process.start" ||
    name === "dev.process.write" ||
    name === "dev.process.write_and_read" ||
    name === "dev.process.read" ||
    name === "dev.process.stop";
}

function collectDevShellToolActions(
  action: ReactAction,
): Array<{ name: string; input: unknown }> {
  if (action.kind === "tool") {
    return isDevShellToolName(action.name)
      ? [{ name: action.name, input: action.input }]
      : [];
  }
  if (action.kind === "tool_batch") {
    return action.items
      .filter((item) => isDevShellToolName(item.name))
      .map((item) => ({ name: item.name, input: item.input }));
  }
  return [];
}

function collectDevShellToolNames(action: ReactAction): string[] {
  if (action.kind === "tool") {
    return isDevShellToolName(action.name) ? [action.name] : [];
  }
  if (action.kind === "tool_batch") {
    return action.items
      .map((item) => item.name)
      .filter((name) => isDevShellToolName(name));
  }
  return [];
}

function isShellFilesystemInspectionAction(
  action: ReactAction,
  postToolVerification: Record<string, unknown> | undefined,
): boolean {
  if (action.kind !== "tool") {
    return false;
  }
  if (action.name === "dev.process.read") {
    const devShell = asRecord(postToolVerification?.devShell);
    return isShellFilesystemInspectionCommand(
      asString(asRecord(devShell?.lastCommand)?.command),
    );
  }
  if (action.name !== "dev.shell.run" && action.name !== "exec_command") {
    return false;
  }
  return isShellFilesystemInspectionCommand(asString(asRecord(action.input)?.command));
}

function isSettledDevShellCommand(
  sourceToolName: string | undefined,
  devShell: Record<string, unknown> | undefined,
): boolean {
  if (sourceToolName !== "dev.process.read" && sourceToolName !== "dev.shell.run") {
    return false;
  }
  return (
    devShell?.noProgress === true ||
    readIntegerNumber(devShell?.completedExitCode) !== undefined ||
    readNonNegativeNumber(devShell?.completionCursor) !== undefined ||
    readNonNegativeNumber(devShell?.chunkBytes) === 0
  );
}

function readIntegerNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || Number.isFinite(value) === false) {
    return ;
  }
  return Math.trunc(value);
}

function readNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.max(0, Math.trunc(value))
    : undefined;
}

function mapFailureCodeToCategory(
  code: DecisionFailureCode,
): DecisionIngestCategory {
  if (code === "DECISION_SCHEMA_FAILED") {
    return "schema";
  }
  if (code === "DECISION_PARSE_FAILED") {
    return "parse";
  }
  if (code === "DECISION_CAPABILITY_UNAVAILABLE") {
    return "capability";
  }
  if (code === "DECISION_CAPABILITY_EVIDENCE_REQUIRED") {
    return "evidence";
  }
  if (code === "DECISION_MODEL_EMPTY_RESPONSE") {
    return "capability";
  }
  if (code === "DECISION_POLICY_FAILED") {
    return "policy";
  }
  return "parse";
}

export function mapDecisionCompileError(error: unknown): {
  code: DecisionFailureCode;
  message: string;
  details?: Record<string, unknown> | undefined;
} {
  if (error instanceof DecisionCompileError) {
    return {
      code: error.code,
      message: error.message,
      details: {
        ...(error.diagnostics ?? {}),
        category: error.category,
      },
    };
  }

  if (error instanceof Error) {
    const code =
      typeof (error as unknown as { code?: unknown }).code === "string"
        ? ((error as unknown as { code: string }).code as string)
        : undefined;
    const details =
      typeof (error as unknown as { details?: unknown }).details === "object" &&
      (error as unknown as { details?: unknown }).details !== null
        ? ((error as unknown as { details: Record<string, unknown> }).details as Record<string, unknown>)
        : undefined;
    if (
      code === "DECISION_SCHEMA_FAILED" ||
      code === "DECISION_PARSE_FAILED" ||
      code === "DECISION_POLICY_FAILED" ||
      code === "DECISION_CAPABILITY_UNAVAILABLE" ||
      code === "DECISION_CAPABILITY_EVIDENCE_REQUIRED"
    ) {
      return {
        code,
        message: error.message,
        details: {
          ...(details ?? {}),
          category: mapFailureCodeToCategory(code),
        },
      };
    }

    return {
      code: "DECISION_PARSE_FAILED",
      message: error.message,
      details: {
        category: "parse",
      },
    };
  }

  return {
    code: "DECISION_PARSE_FAILED",
    message: "Unknown decision compilation error.",
    details: {
      category: "parse",
    },
  };
}

function collectAvailableCapabilities(capabilityManifest: ToolCapabilityManifestItem[]): string[] {
  const classes = new Set<string>();
  for (const item of capabilityManifest) {
    for (const capabilityClass of item.capabilityClasses) {
      const normalized = capabilityClass.trim();
      if (normalized.length > 0) {
        classes.add(normalized);
      }
    }
  }
  return [...classes];
}

function resolveChosenActionName(action: ReactAction): string | undefined {
  if (action.kind === "tool") {
    return action.name;
  }
  if (action.kind === "tool_batch") {
    const names = action.items
      .map((item) => item.name.trim())
      .filter((name) => name.length > 0);
    return names.length > 0 ? names.join(",") : undefined;
  }
  if (action.kind === "effect") {
    return action.type;
  }
  return ;
}
