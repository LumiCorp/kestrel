import { asArray, asRecord, asString } from "../../shared/valueAccess.js";
import type {
  DraftIntent,
  DecisionContextToolIntent,
  DecisionContextExecutionIntent,
  DecisionContextIntentMetadata,
  ExecutionIntent,
  ExecutionIntentMetadata,
  ExtractedFollowUpSourceSelection,
  ExtractedHostWorkflowKind,
  ExtractedOperationIntent,
  ExtractedRepoScope,
  ExtractedToolInputHints,
  ExtractedVerificationIntent,
  ExtractedVerificationKind,
  ExtractedWorkflowIntent,
  ExtractorDecision,
  LegacyExtractedToolIntent,
  ToolExecutionClass,
  ToolIntentCandidateView,
} from "./types.js";
import { deriveIntentWorkflowKind, normalizeWorkflowKind } from "../../../src/intentPolicy.js";

interface ToolIntentManifestCandidate {
  name: string;
  capabilityClasses?: string[] | undefined;
  executionClass?: ToolExecutionClass | undefined;
}

export interface ParsedExecutionIntentState {
  execution: DecisionContextExecutionIntent;
  metadata?: DecisionContextIntentMetadata | undefined;
  confidence: number;
}

export function parseDraftIntent(value: unknown): DraftIntent | undefined {
  return parseSplitExtractorDecision(value) ?? parseLegacyExtractorDecision(value);
}

export function parseExtractedToolIntent(value: unknown): LegacyExtractedToolIntent | undefined {
  const parsed = parseDraftIntent(value);
  return parsed === undefined ? undefined : toLegacyExtractedToolIntent(parsed);
}

export function parseExtractorDecision(value: unknown): ExtractorDecision | undefined {
  return parseDraftIntent(value);
}

export function serializeDraftIntentForState(
  value:
    | DraftIntent
    | {
        execution: DecisionContextExecutionIntent;
        metadata?: DecisionContextIntentMetadata | undefined;
        confidence: number;
      }
    | undefined,
): ExtractorDecision | undefined {
  if (value === undefined) {
    return undefined;
  }

  const execution: ExecutionIntent = {
    objective: value.execution.objective,
    candidateTools: uniqueNonEmptyStrings(value.execution.candidateTools),
    ...(value.execution.operationIntent !== undefined
      ? { operationIntent: value.execution.operationIntent }
      : {}),
    ...(value.execution.inputHints !== undefined ? { inputHints: value.execution.inputHints } : {}),
    ...(value.execution.command !== undefined ? { command: value.execution.command } : {}),
    ...(value.execution.commandMode !== undefined ? { commandMode: value.execution.commandMode } : {}),
    ...(value.execution.clarification !== undefined
      ? { clarification: value.execution.clarification }
      : {}),
  };

  const metadata =
    value.metadata === undefined || hasMetadataFields(value.metadata) === false
      ? undefined
      : {
          ...(value.metadata.workflowIntent !== undefined
            ? { workflowIntent: value.metadata.workflowIntent }
            : {}),
          ...(value.metadata.repoScope !== undefined ? { repoScope: value.metadata.repoScope } : {}),
          ...(value.metadata.verificationIntent !== undefined
            ? { verificationIntent: value.metadata.verificationIntent }
            : {}),
          ...(value.metadata.workspaceTargets !== undefined
            ? { workspaceTargets: value.metadata.workspaceTargets }
            : {}),
          ...(value.metadata.hostWorkflowKind !== undefined
            ? { hostWorkflowKind: value.metadata.hostWorkflowKind }
            : {}),
          ...(value.metadata.executionPreference !== undefined
            ? { executionPreference: value.metadata.executionPreference }
            : {}),
          ...(value.metadata.followUpSourceSelection !== undefined
            ? { followUpSourceSelection: value.metadata.followUpSourceSelection }
            : {}),
          ...(value.metadata.toolUseIntent !== undefined
            ? { toolUseIntent: value.metadata.toolUseIntent }
            : {}),
        };

  return {
    version: "v3",
    execution,
    ...(metadata !== undefined ? { metadata } : {}),
    confidence: value.confidence,
  };
}

export function serializeExtractorDecisionForState(
  value:
    | DraftIntent
    | {
        execution: DecisionContextExecutionIntent;
        metadata?: DecisionContextIntentMetadata | undefined;
        confidence: number;
      }
    | undefined,
): ExtractorDecision | undefined {
  return serializeDraftIntentForState(value);
}

export function serializeToolIntentForState(
  value: DecisionContextToolIntent | undefined,
): LegacyExtractedToolIntent | undefined {
  if (value === undefined) {
    return undefined;
  }
  return {
    version: "v1",
    toolUseIntent: value.toolUseIntent ?? "single",
    objective: value.objective,
    candidateTools: [
      ...new Set([
        ...value.candidateTools.map((candidate) =>
          typeof candidate === "string" ? candidate : candidate.name
        ),
        ...value.allowlistedCandidates,
      ]),
    ],
    confidence: value.confidence,
    ...(value.workflowIntent !== undefined ? { workflowIntent: value.workflowIntent } : {}),
    ...(value.repoScope !== undefined ? { repoScope: value.repoScope } : {}),
    ...(value.verificationIntent !== undefined ? { verificationIntent: value.verificationIntent } : {}),
    ...(value.operationIntent !== undefined ? { operationIntent: value.operationIntent } : {}),
    ...(value.workspaceTargets !== undefined ? { workspaceTargets: value.workspaceTargets } : {}),
    ...(value.hostWorkflowKind !== undefined ? { hostWorkflowKind: value.hostWorkflowKind } : {}),
    ...(value.inputHints !== undefined ? { inputHints: value.inputHints } : {}),
    ...(value.executionPreference !== undefined ? { executionPreference: value.executionPreference } : {}),
    ...(value.command !== undefined ? { command: value.command } : {}),
    ...(value.commandMode !== undefined ? { commandMode: value.commandMode } : {}),
    ...(value.followUpSourceSelection !== undefined
      ? { followUpSourceSelection: value.followUpSourceSelection }
      : {}),
    ...(value.clarification !== undefined ? { clarification: value.clarification } : {}),
  };
}

export function buildParsedExecutionIntentState(
  value: unknown,
): ParsedExecutionIntentState | undefined {
  const parsed = parseDraftIntent(value);
  if (parsed === undefined) {
    return undefined;
  }

  return {
    execution: parsed.execution,
    ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
    confidence: parsed.confidence,
  };
}

export function buildToolIntentContext(
  value: unknown,
  capabilityManifest: ToolIntentManifestCandidate[],
): DecisionContextToolIntent | undefined {
  const parsed = buildParsedExecutionIntentState(value);
  if (parsed === undefined) {
    return undefined;
  }
  const candidateViews = buildCandidateViews(parsed.execution, capabilityManifest);
  const allowlistedCandidates = allowlistedCandidateNames(candidateViews);
  const derivedRequiredCapabilities = deriveRequiredCapabilities(candidateViews);
  const concreteToolName = resolveExecutionIntentToolName({
    execution: parsed.execution,
    candidateViews,
    metadata: parsed.metadata,
  });

  return {
    objective: parsed.execution.objective,
    confidence: parsed.confidence,
    candidateTools: candidateViews,
    allowlistedCandidates,
    derivedRequiredCapabilities,
    ...(parsed.execution.operationIntent !== undefined
      ? { operationIntent: parsed.execution.operationIntent }
      : {}),
    ...(parsed.metadata?.workflowIntent !== undefined
      ? { workflowIntent: parsed.metadata.workflowIntent }
      : {}),
    ...(parsed.execution.inputHints !== undefined ? { inputHints: parsed.execution.inputHints } : {}),
    ...(parsed.execution.command !== undefined ? { command: parsed.execution.command } : {}),
    ...(parsed.execution.commandMode !== undefined ? { commandMode: parsed.execution.commandMode } : {}),
    ...(parsed.execution.clarification !== undefined
      ? { clarification: parsed.execution.clarification }
      : {}),
    ...(parsed.metadata?.repoScope !== undefined ? { repoScope: parsed.metadata.repoScope } : {}),
    ...(parsed.metadata?.verificationIntent !== undefined
      ? { verificationIntent: parsed.metadata.verificationIntent }
      : {}),
    ...(parsed.metadata?.workspaceTargets !== undefined
      ? { workspaceTargets: parsed.metadata.workspaceTargets }
      : {}),
    ...(parsed.metadata?.hostWorkflowKind !== undefined
      ? { hostWorkflowKind: parsed.metadata.hostWorkflowKind }
      : {}),
    ...(parsed.metadata?.executionPreference !== undefined
      ? { executionPreference: parsed.metadata.executionPreference }
      : {}),
    ...(parsed.metadata?.followUpSourceSelection !== undefined
      ? { followUpSourceSelection: parsed.metadata.followUpSourceSelection }
      : {}),
    ...(parsed.metadata?.toolUseIntent !== undefined ? { toolUseIntent: parsed.metadata.toolUseIntent } : {}),
    ...(concreteToolName !== undefined ? { concreteToolName } : {}),
    isAmbiguous:
      parsed.execution.clarification?.needed === true ||
      allowlistedCandidates.length > 1,
  };
}

export function buildCandidateViews(
  execution: DecisionContextExecutionIntent | undefined,
  capabilityManifest: ToolIntentManifestCandidate[],
): ToolIntentCandidateView[] {
  if (execution === undefined) {
    return [];
  }
  return uniqueNonEmptyStrings(execution.candidateTools).map((name) => {
    const manifestItem = capabilityManifest.find((tool) => tool.name === name);
    return {
      name,
      allowlisted: manifestItem !== undefined,
      capabilityClasses: manifestItem?.capabilityClasses ?? [],
      ...(manifestItem?.executionClass !== undefined
        ? { executionClass: manifestItem.executionClass }
        : {}),
    };
  });
}

export function allowlistedCandidateNames(candidateViews: ToolIntentCandidateView[]): string[] {
  return candidateViews
    .filter((candidate) => candidate.allowlisted)
    .map((candidate) => candidate.name);
}

export function deriveRequiredCapabilities(candidateViews: ToolIntentCandidateView[]): string[] {
  return Array.from(
    new Set(
      candidateViews.flatMap((candidate) =>
        candidate.capabilityClasses
          .map((capability) => capability.trim())
          .filter((capability) => capability.length > 0),
      ),
    ),
  );
}

export function resolveExecutionIntentToolName(input: {
  execution: DecisionContextExecutionIntent | undefined;
  candidateViews: ToolIntentCandidateView[];
  metadata?: DecisionContextIntentMetadata | undefined;
}): string | undefined {
  if (input.execution === undefined) {
    return undefined;
  }
  const allowlisted = allowlistedCandidateNames(input.candidateViews);
  if (allowlisted.length === 1) {
    return allowlisted[0];
  }
  if (
    input.metadata?.toolUseIntent === "single" &&
    allowlisted.length === 1
  ) {
    return allowlisted[0];
  }
  return undefined;
}

function parseSplitExtractorDecision(value: unknown): DraftIntent | undefined {
  const root = asRecord(value);
  const executionRecord = asRecord(root?.execution);
  const confidence = typeof root?.confidence === "number" ? root.confidence : undefined;

  if (root?.version !== "v3" || executionRecord === undefined || confidence === undefined) {
    return undefined;
  }

  const execution = parseExecutionIntent(executionRecord);
  if (execution === undefined || confidence < 0 || confidence > 1) {
    return undefined;
  }

  const metadata = parseExecutionIntentMetadata(root?.metadata);
  return {
    version: "v3",
    execution,
    ...(metadata !== undefined ? { metadata } : {}),
    confidence,
  };
}

function parseLegacyExtractorDecision(value: unknown): DraftIntent | undefined {
  const legacy = parseLegacyExtractedToolIntent(value);
  if (legacy === undefined) {
    return undefined;
  }

  const metadata: ExecutionIntentMetadata = {
    ...(legacy.workflowIntent !== undefined ? { workflowIntent: legacy.workflowIntent } : {}),
    ...(legacy.repoScope !== undefined ? { repoScope: legacy.repoScope } : {}),
    ...(normalizeLegacyVerificationIntent(legacy.verificationIntent) !== undefined
      ? { verificationIntent: normalizeLegacyVerificationIntent(legacy.verificationIntent) }
      : {}),
    ...(legacy.workspaceTargets !== undefined ? { workspaceTargets: legacy.workspaceTargets } : {}),
    ...(legacy.hostWorkflowKind !== undefined ? { hostWorkflowKind: legacy.hostWorkflowKind } : {}),
    ...(legacy.executionPreference !== undefined
      ? { executionPreference: legacy.executionPreference }
      : {}),
    ...(legacy.followUpSourceSelection !== undefined
      ? { followUpSourceSelection: legacy.followUpSourceSelection }
      : {}),
    toolUseIntent: legacy.toolUseIntent,
  };

  return {
    version: "v3",
    execution: {
      objective: legacy.objective,
      candidateTools: legacy.candidateTools,
      ...(legacy.operationIntent !== undefined ? { operationIntent: legacy.operationIntent } : {}),
      ...(legacy.inputHints !== undefined ? { inputHints: legacy.inputHints } : {}),
      ...(legacy.command !== undefined ? { command: legacy.command } : {}),
      ...(legacy.commandMode !== undefined ? { commandMode: legacy.commandMode } : {}),
      ...(legacy.clarification !== undefined ? { clarification: legacy.clarification } : {}),
    },
    ...(hasMetadataFields(metadata) ? { metadata } : {}),
    confidence: legacy.confidence,
  };
}

function toLegacyExtractedToolIntent(value: DraftIntent): LegacyExtractedToolIntent {
  return {
    version: "v1",
    toolUseIntent: value.metadata?.toolUseIntent ?? "single",
    objective: value.execution.objective,
    candidateTools: value.execution.candidateTools,
    confidence: value.confidence,
    ...(value.metadata?.workflowIntent !== undefined ? { workflowIntent: value.metadata.workflowIntent } : {}),
    ...(value.metadata?.repoScope !== undefined ? { repoScope: value.metadata.repoScope } : {}),
    ...(value.metadata?.verificationIntent !== undefined
      ? { verificationIntent: value.metadata.verificationIntent }
      : {}),
    ...(value.execution.operationIntent !== undefined
      ? { operationIntent: value.execution.operationIntent }
      : {}),
    ...(value.metadata?.workspaceTargets !== undefined
      ? { workspaceTargets: value.metadata.workspaceTargets }
      : {}),
    ...(value.metadata?.hostWorkflowKind !== undefined
      ? { hostWorkflowKind: value.metadata.hostWorkflowKind }
      : {}),
    ...(value.execution.inputHints !== undefined ? { inputHints: value.execution.inputHints } : {}),
    ...(value.metadata?.executionPreference !== undefined
      ? { executionPreference: value.metadata.executionPreference }
      : {}),
    ...(value.execution.command !== undefined ? { command: value.execution.command } : {}),
    ...(value.execution.commandMode !== undefined ? { commandMode: value.execution.commandMode } : {}),
    ...(value.metadata?.followUpSourceSelection !== undefined
      ? { followUpSourceSelection: value.metadata.followUpSourceSelection }
      : {}),
    ...(value.execution.clarification !== undefined
      ? { clarification: value.execution.clarification }
      : {}),
  };
}

function parseLegacyExtractedToolIntent(value: unknown): LegacyExtractedToolIntent | undefined {
  const root = asRecord(value);
  const toolUseIntent = root?.toolUseIntent;
  const objective = asString(root?.objective);
  const candidateTools = parseCandidateToolNames(root?.candidateTools);
  const confidence = typeof root?.confidence === "number" ? root.confidence : undefined;
  const workflowIntent = parseWorkflowIntent(root?.workflowIntent);
  const repoScope = parseRepoScope(root?.repoScope);
  const verificationIntent = parseVerificationIntent(root?.verificationIntent);
  const operationIntent = parseOperationIntent(root?.operationIntent);
  const workspaceTargets = parseStringList(root?.workspaceTargets);
  const hostWorkflowKind = parseHostWorkflowKind(root?.hostWorkflowKind);
  const inputHints = parseInputHints(root?.inputHints);
  const executionPreference = parseExecutionPreference(root?.executionPreference);
  const command = parseCommand(root?.command);
  const commandMode = parseCommandMode(root?.commandMode);
  const followUpSourceSelection = parseFollowUpSourceSelection(root?.followUpSourceSelection);
  const clarification = parseClarification(root?.clarification);

  if (
    (toolUseIntent !== "none" && toolUseIntent !== "single" && toolUseIntent !== "multi") ||
    objective === undefined ||
    confidence === undefined ||
    confidence < 0 ||
    confidence > 1
  ) {
    return undefined;
  }

  return {
    version: root?.version === "v1" ? "v1" : "v2",
    toolUseIntent,
    objective,
    candidateTools,
    confidence,
    ...(workflowIntent !== undefined ? { workflowIntent } : {}),
    ...(repoScope !== undefined ? { repoScope } : {}),
    ...(verificationIntent !== undefined ? { verificationIntent } : {}),
    ...(operationIntent !== undefined ? { operationIntent } : {}),
    ...(workspaceTargets !== undefined ? { workspaceTargets } : {}),
    ...(hostWorkflowKind !== undefined ? { hostWorkflowKind } : {}),
    ...(inputHints !== undefined ? { inputHints } : {}),
    ...(executionPreference !== undefined ? { executionPreference } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(commandMode !== undefined ? { commandMode } : {}),
    ...(followUpSourceSelection !== undefined ? { followUpSourceSelection } : {}),
    ...(clarification !== undefined ? { clarification } : {}),
  };
}

function parseExecutionIntent(value: unknown): ExecutionIntent | undefined {
  const record = asRecord(value);
  const objective = asString(record?.objective);
  if (record === undefined || objective === undefined) {
    return undefined;
  }

  const candidateTools = parseCandidateToolNames(record.candidateTools);
  const operationIntent = parseOperationIntent(record.operationIntent);
  const inputHints = parseInputHints(record.inputHints);
  const command = parseCommand(record.command);
  const commandMode = parseCommandMode(record.commandMode);
  const clarification = parseClarification(record.clarification);

  return {
    objective,
    candidateTools,
    ...(operationIntent !== undefined ? { operationIntent } : {}),
    ...(inputHints !== undefined ? { inputHints } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(commandMode !== undefined ? { commandMode } : {}),
    ...(clarification !== undefined ? { clarification } : {}),
  };
}

function parseExecutionIntentMetadata(value: unknown): ExecutionIntentMetadata | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }

  const metadata: ExecutionIntentMetadata = {};
  const workflowIntent =
    parseWorkflowIntent(record.workflowIntent) ??
    deriveWorkflowIntentFromLegacyFields({
      taskKind: record.taskKind,
      mutationIntent: record.mutationIntent,
      operationIntent: asRecord(record.operationIntent)?.kind,
    });
  const repoScope = parseRepoScope(record.repoScope);
  const verificationIntent = parseVerificationIntent(record.verificationIntent);
  const workspaceTargets = parseStringList(record.workspaceTargets);
  const hostWorkflowKind = parseHostWorkflowKind(record.hostWorkflowKind);
  const executionPreference = parseExecutionPreference(record.executionPreference);
  const followUpSourceSelection = parseFollowUpSourceSelection(record.followUpSourceSelection);
  const toolUseIntent = asString(record.toolUseIntent);

  if (workflowIntent !== undefined) {
    metadata.workflowIntent = workflowIntent;
  }
  if (repoScope !== undefined) {
    metadata.repoScope = repoScope;
  }
  if (verificationIntent !== undefined) {
    metadata.verificationIntent = verificationIntent;
  }
  if (workspaceTargets !== undefined) {
    metadata.workspaceTargets = workspaceTargets;
  }
  if (hostWorkflowKind !== undefined) {
    metadata.hostWorkflowKind = hostWorkflowKind;
  }
  if (executionPreference !== undefined) {
    metadata.executionPreference = executionPreference;
  }
  if (followUpSourceSelection !== undefined) {
    metadata.followUpSourceSelection = followUpSourceSelection;
  }
  if (toolUseIntent === "none" || toolUseIntent === "single" || toolUseIntent === "multi") {
    metadata.toolUseIntent = toolUseIntent;
  }

  return hasMetadataFields(metadata) ? metadata : undefined;
}

function parseClarification(
  value: unknown,
): ExecutionIntent["clarification"] | undefined {
  const clarificationRecord = asRecord(value);
  const clarificationNeeded = clarificationRecord?.needed;
  const clarificationPrompt = asString(clarificationRecord?.prompt);
  if (typeof clarificationNeeded !== "boolean") {
    return undefined;
  }
  return {
    needed: clarificationNeeded,
    ...(clarificationPrompt !== undefined ? { prompt: clarificationPrompt } : {}),
  };
}

function hasMetadataFields(metadata: ExecutionIntentMetadata): boolean {
  return Object.keys(metadata).length > 0;
}

function parseWorkflowIntent(value: unknown): ExtractedWorkflowIntent | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const kind = normalizeWorkflowKind(asString(record.kind));
  return kind === undefined ? undefined : { kind };
}

function deriveWorkflowIntentFromLegacyFields(input: {
  taskKind: unknown;
  mutationIntent: unknown;
  operationIntent: unknown;
}): ExtractedWorkflowIntent | undefined {
  const kind = deriveIntentWorkflowKind({
    workflowKind: undefined,
    operationKind: asString(input.operationIntent),
    legacyTaskKind: asString(input.taskKind),
    legacyMutationIntent: asString(input.mutationIntent),
  });
  return kind === undefined ? undefined : { kind };
}

function parseRepoScope(value: unknown): ExtractedRepoScope | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const kind = record.kind;
  if (kind !== "workspace" && kind !== "paths" && kind !== "unknown") {
    return undefined;
  }
  const targets = parseStringList(record.targets);
  return {
    kind,
    ...(targets !== undefined ? { targets } : {}),
  };
}

function parseVerificationIntent(value: unknown): ExtractedVerificationIntent | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.requested !== "boolean") {
    return undefined;
  }
  const kinds = asArray(record.kinds)
    .map((entry) => parseVerificationKind(entry))
    .filter((entry): entry is ExtractedVerificationKind => entry !== undefined);
  return {
    requested: record.requested,
    ...(kinds.length > 0 ? { kinds } : {}),
  };
}

function normalizeLegacyVerificationIntent(
  value: LegacyExtractedToolIntent["verificationIntent"],
): ExtractedVerificationIntent | undefined {
  if (value === undefined || typeof value.requested !== "boolean") {
    return undefined;
  }
  const kinds = (value.kinds ?? [])
    .map((entry) => parseVerificationKind(entry))
    .filter((entry): entry is ExtractedVerificationKind => entry !== undefined);
  return {
    requested: value.requested,
    ...(kinds.length > 0 ? { kinds } : {}),
  };
}

function parseVerificationKind(value: unknown): ExtractedVerificationKind | undefined {
  return value === "test" ||
    value === "lint" ||
    value === "build" ||
    value === "smoke" ||
    value === "browser"
    ? value
    : undefined;
}

function parseOperationIntent(value: unknown): ExtractedOperationIntent | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }
  const kind = record.kind;
  return kind === "write_file" ||
      kind === "scaffold_app" ||
      kind === "run_host_command" ||
      kind === "run_sandbox_code" ||
      kind === "read_file" ||
      kind === "inspect_repo"
    ? { kind }
    : undefined;
}

function parseStringList(value: unknown): string[] | undefined {
  const items = asArray(value)
    .map((entry) => asString(entry)?.trim())
    .filter((entry): entry is string => entry !== undefined && entry.length > 0);
  return items.length > 0 ? items : undefined;
}
function parseCandidateToolNames(value: unknown): string[] {
  return uniqueNonEmptyStrings(
    asArray(value)
      .map((entry) => normalizeCandidateToolName(entry))
      .filter((entry): entry is string => entry !== undefined),
  );
}

function uniqueNonEmptyStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function normalizeCandidateToolName(value: unknown): string | undefined {
  const direct = asString(value)?.trim();
  if (direct !== undefined && direct.length > 0) {
    return direct;
  }
  const record = asRecord(value);
  const fromRecord = asString(record?.name)?.trim();
  if (fromRecord !== undefined && fromRecord.length > 0) {
    return fromRecord;
  }
  return undefined;
}

function parseInputHints(value: unknown): ExtractedToolInputHints | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }

  const inputHints: ExtractedToolInputHints = {};
  const query = asString(record.query);
  const url = asString(record.url);
  const urlSource = asString(record.urlSource);
  const topic = asString(record.topic);
  const text = asString(record.text);
  const claim = asString(record.claim);
  const sourceId = asString(record.sourceId);
  const maxItems = typeof record.maxItems === "number" && Number.isFinite(record.maxItems)
    ? Math.trunc(record.maxItems)
    : undefined;
  const path = asString(record.path);
  const content = asString(record.content);
  const mode = asString(record.mode);
  const language = asString(record.language);
  const code = asString(record.code);
  const scope = asString(record.scope);
  const freshness = asString(record.freshness);
  const region = asString(record.region);
  const locationQuery = asString(record.locationQuery);
  const timezoneQuery = asString(record.timezoneQuery);
  const baseCurrency = asString(record.baseCurrency);
  const quoteCurrency = asString(record.quoteCurrency);

  if (query !== undefined && query.trim().length > 0) {
    inputHints.query = query.trim();
  }
  if (url !== undefined && url.trim().length > 0) {
    inputHints.url = url.trim();
  }
  if (urlSource === "user" || urlSource === "prior_result_grounding") {
    inputHints.urlSource = urlSource;
  }
  if (topic !== undefined && topic.trim().length > 0) {
    inputHints.topic = topic.trim();
  }
  if (text !== undefined) {
    inputHints.text = text;
  }
  if (claim !== undefined && claim.trim().length > 0) {
    inputHints.claim = claim.trim();
  }
  if (sourceId !== undefined && sourceId.trim().length > 0) {
    inputHints.sourceId = sourceId.trim();
  }
  if (maxItems !== undefined && maxItems > 0) {
    inputHints.maxItems = maxItems;
  }
  if (path !== undefined && path.trim().length > 0) {
    inputHints.path = path.trim();
  }
  if (content !== undefined) {
    inputHints.content = content;
  }
  if (mode === "overwrite" || mode === "append") {
    inputHints.mode = mode;
  }
  if (language === "javascript" || language === "python" || language === "bash") {
    inputHints.language = language;
  }
  if (code !== undefined) {
    inputHints.code = code;
  }
  if (scope === "us" || scope === "global") {
    inputHints.scope = scope;
  }
  if (freshness !== undefined && freshness.trim().length > 0) {
    inputHints.freshness = freshness.trim();
  }
  if (region !== undefined && region.trim().length > 0) {
    inputHints.region = region.trim();
  }
  if (locationQuery !== undefined && locationQuery.trim().length > 0) {
    inputHints.locationQuery = locationQuery.trim();
  }
  if (timezoneQuery !== undefined && timezoneQuery.trim().length > 0) {
    inputHints.timezoneQuery = timezoneQuery.trim();
  }
  if (baseCurrency !== undefined && baseCurrency.trim().length > 0) {
    inputHints.baseCurrency = baseCurrency.trim().toUpperCase();
  }
  if (quoteCurrency !== undefined && quoteCurrency.trim().length > 0) {
    inputHints.quoteCurrency = quoteCurrency.trim().toUpperCase();
  }

  return Object.keys(inputHints).length > 0 ? inputHints : undefined;
}

function parseExecutionPreference(value: unknown): ExecutionIntentMetadata["executionPreference"] {
  return value === "host_shell" || value === "sandbox_snippet" || value === "none"
    ? value
    : undefined;
}

function parseCommand(value: unknown): string | undefined {
  const parsed = asString(value);
  if (parsed === undefined) {
    return undefined;
  }
  const trimmed = parsed.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseCommandMode(value: unknown): ExecutionIntent["commandMode"] {
  return value === "oneshot" || value === "persistent"
    ? value
    : undefined;
}

function parseHostWorkflowKind(value: unknown): ExtractedHostWorkflowKind | undefined {
  return value === "none" || value === "oneshot_command" || value === "persistent_command"
    ? value
    : undefined;
}

function parseFollowUpSourceSelection(value: unknown): ExtractedFollowUpSourceSelection | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return undefined;
  }

  const kind = asString(record.kind);
  if (kind === "use_prior_source") {
    const candidateId = asString(record.candidateId);
    if (candidateId === undefined || candidateId.trim().length === 0) {
      return undefined;
    }
    return {
      kind,
      candidateId: candidateId.trim(),
      ...(asString(record.reason) !== undefined ? { reason: asString(record.reason) } : {}),
    };
  }

  if (kind === "search_pivot") {
    const toolName = asString(record.toolName);
    const query = asString(record.query);
    if (
      toolName === undefined ||
      toolName.trim().length === 0 ||
      query === undefined ||
      query.trim().length === 0
    ) {
      return undefined;
    }
    return {
      kind,
      toolName: toolName.trim(),
      query: query.trim(),
      ...(asString(record.reason) !== undefined ? { reason: asString(record.reason) } : {}),
    };
  }

  if (kind === "none") {
    return {
      kind,
      ...(asString(record.reason) !== undefined ? { reason: asString(record.reason) } : {}),
    };
  }

  return undefined;
}
