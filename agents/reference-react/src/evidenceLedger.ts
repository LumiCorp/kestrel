import { createHash } from "node:crypto";

import { asArray, asRecord, asString } from "../../shared/valueAccess.js";
import {
  deriveCommandExecutionRole,
  isHelperFailureCommandRole,
} from "./commandRole.js";
import { buildKestrelAgentToolResultSummary } from "../../../src/runtime/KestrelAgentContextBuilder.js";
import {
  isDevShellLifecycleTool,
  normalizeDevShellLifecycle,
} from "../../../src/runtime/devshellLifecycle.js";
import type {
  ActiveControllerFailure,
  EvidenceClaimImpact,
  EvidenceLedgerContext,
  EvidenceLedgerEntry,
  EvidenceLedgerKind,
  EvidenceLedgerStatus,
  HelperOutcome,
} from "./types.js";

const MAX_LEDGER_ENTRIES = 80;
const DEFAULT_PREVIEW_BYTES = 2_000;
const MAX_FACT_TEXT_PREVIEW_CHARS = 500;
const MAX_MATCH_PREVIEW_ITEMS = 6;
const MAX_CHANGED_FILE_FACT_ITEMS = 40;

export function parseEvidenceLedger(value: unknown): EvidenceLedgerEntry[] {
  return asArray(value)
    .map(parseEvidenceLedgerEntry)
    .filter((entry): entry is EvidenceLedgerEntry => entry !== undefined)
    .slice(-MAX_LEDGER_ENTRIES);
}

export function appendEvidenceLedgerEntries(
  reactState: Record<string, unknown>,
  entries: EvidenceLedgerEntry[],
): EvidenceLedgerEntry[] {
  const existing = parseEvidenceLedger(reactState.evidenceLedger);
  return [...existing, ...entries].slice(-MAX_LEDGER_ENTRIES);
}

export function buildToolEvidenceEntries(input: {
  stepIndex?: number | undefined;
  toolName: string;
  toolInput?: Record<string, unknown> | undefined;
  toolOutput: unknown;
  inputHash?: string | undefined;
  /** @deprecated ignored compatibility input; work items no longer drive evidence. */
  workItem?: unknown;
  contextPreviewBytes?: number | undefined;
  reused?: boolean | undefined;
}): EvidenceLedgerEntry[] {
  const output = asRecord(input.toolOutput);
  const status = inferToolStatus(output);
  const target = inferToolTarget(input.toolName, input.toolInput, output);
  const raw = buildRawMetadata(output, input.contextPreviewBytes);
  const kind = inferToolEvidenceKind(input.toolName, output);
  const summary = buildKestrelAgentToolResultSummary({
    toolName: input.toolName,
    toolInput: input.toolInput,
    toolOutput: output,
    status,
  });
  const createdAt = buildEvidenceCreatedAt(input.stepIndex, output);
  const commandRole = deriveCommandExecutionRole({
    toolName: input.toolName,
    toolInput: input.toolInput,
  })?.effective;
  const base: EvidenceLedgerEntry = {
    id: buildEvidenceId({
      kind,
      stepIndex: input.stepIndex,
      salt: stableEvidenceSalt({
        toolName: input.toolName,
        toolInput: input.toolInput,
        toolOutput: input.toolOutput,
        inputHash: input.inputHash,
      }),
    }),
    version: "v1",
    createdAt,
    ...(input.stepIndex !== undefined ? { stepIndex: input.stepIndex } : {}),
    source: "tool",
    kind,
    status,
    summary,
    ...(target !== undefined ? { target } : {}),
    facts: {
      toolName: input.toolName,
      ...(input.inputHash !== undefined ? { inputHash: input.inputHash } : {}),
      ...(input.reused === true ? { reused: true } : {}),
      ...(commandRole !== undefined
        ? {
            commandRole: commandRole.role,
            commandRoleSource: commandRole.source,
            ...(commandRole.target !== undefined ? { commandRoleTarget: commandRole.target } : {}),
            ...(commandRole.sourcePath !== undefined ? { sourcePath: commandRole.sourcePath } : {}),
            ...(commandRole.evidenceIds !== undefined ? { evidenceIds: commandRole.evidenceIds } : {}),
            ...(commandRole.rationale !== undefined ? { commandRoleRationale: commandRole.rationale } : {}),
          }
        : {}),
      ...buildToolFacts(input.toolName, input.toolInput, output),
    },
    ...(raw !== undefined ? { raw } : {}),
    ...(buildLedgerLinks(output) !== undefined
      ? { links: buildLedgerLinks(output) }
      : {}),
    ...(buildToolNextUse(kind, status, target, raw) !== undefined
      ? { nextUse: buildToolNextUse(kind, status, target, raw) }
      : {}),
  };
  const derived = buildDerivedToolEvidence(input, base);
  return [base, ...derived];
}

export function buildPolicyCorrectionEvidenceEntry(input: {
  stepIndex?: number | undefined;
  reason: string;
  summary: string;
  facts?: Record<string, unknown> | undefined;
}): EvidenceLedgerEntry {
  return {
    id: buildEvidenceId({
      kind: "policy_correction",
      stepIndex: input.stepIndex,
      salt: `${input.reason}:${input.summary}`,
    }),
    version: "v1",
    createdAt: buildEvidenceCreatedAt(input.stepIndex),
    ...(input.stepIndex !== undefined ? { stepIndex: input.stepIndex } : {}),
    source: "policy",
    kind: "policy_correction",
    status: "blocked",
    summary: input.summary,
    facts: {
      reason: input.reason,
      ...(input.facts ?? {}),
    },
    ...(buildLedgerLinks() !== undefined
      ? { links: buildLedgerLinks() }
      : {}),
    nextUse: {
      requiresAction: input.reason,
      invalidatesRepeat: true,
    },
  };
}

export function buildEvidenceLedgerContext(input: {
  ledger: EvidenceLedgerEntry[];
  latestTarget?: { type: string; value: string } | undefined;
}): EvidenceLedgerContext {
  const normalizedLatestTarget = normalizeTargetValue(input.latestTarget?.value);
  const unresolved = input.ledger.filter(isUnresolvedEvidenceEntry);
  const completion = buildEvidenceCompletionSummaryFromEntries(input.ledger);
  const linkedToTarget = input.ledger.filter((entry) => {
    if (normalizedLatestTarget === undefined) {
      return false;
    }
    return normalizeTargetValue(entry.links?.sourcePath) === normalizedLatestTarget ||
      entry.target?.normalizedValue === normalizedLatestTarget ||
      normalizeTargetValue(entry.target?.value) === normalizedLatestTarget;
  });
  return {
    latest: input.ledger.at(-1),
    unresolved: unresolved.slice(-8),
    successBlockers: completion.blockerEntries.slice(-8),
    successSupport: completion.supportEntries.slice(-8),
    linkedToLatestTarget: linkedToTarget.slice(-8),
    repeatedInspection: findRepeatedInspection(input.ledger),
    entries: selectContextEntries(input.ledger, unresolved, linkedToTarget),
    contextPreviewTruncated: false,
  };
}

export function buildEvidenceCompletionSummary(input: {
  ledger: unknown;
}): {
  supportedTokens: string[];
  blockedTokens: string[];
  supportEntries: EvidenceLedgerEntry[];
  blockerEntries: EvidenceLedgerEntry[];
} {
  return buildEvidenceCompletionSummaryFromEntries(parseEvidenceLedger(input.ledger));
}

export function deriveActiveControllerFailure(input: {
  ledger: EvidenceLedgerEntry[];
}): ActiveControllerFailure | undefined {
  const activeArtifactTarget = undefined;
  for (let index = input.ledger.length - 1; index >= 0; index -= 1) {
    const entry = input.ledger[index];
    if (
      entry === undefined ||
      isControllerFailureEvidence(entry, activeArtifactTarget) === false
    ) {
      continue;
    }
    const failure = toActiveControllerFailure(entry, activeArtifactTarget);
    const failureArtifactTarget = normalizeTargetValue(failure.artifactTarget);
    if (
      activeArtifactTarget !== undefined &&
      failureArtifactTarget !== undefined &&
      failureArtifactTarget !== activeArtifactTarget
    ) {
      continue;
    }
    if (isControllerFailureSuperseded(input.ledger.slice(index + 1), failure, activeArtifactTarget)) {
      continue;
    }
    return failure;
  }
  return undefined;
}

export function buildHelperOutcomeEvidenceEntry(input: {
  stepIndex?: number | undefined;
  helperOutcome: HelperOutcome;
}): EvidenceLedgerEntry {
  const artifactTarget = input.helperOutcome.artifactTarget;
  const command = input.helperOutcome.command;
  const status = helperOutcomeToLedgerStatus(input.helperOutcome.status);
  return {
    id: buildEvidenceId({
      kind: "helper_outcome",
      stepIndex: input.stepIndex,
      salt: `${input.helperOutcome.status}:${command ?? ""}:${artifactTarget ?? ""}:${input.helperOutcome.summary}`,
    }),
    version: "v1",
    createdAt: buildEvidenceCreatedAt(input.stepIndex),
    ...(input.stepIndex !== undefined ? { stepIndex: input.stepIndex } : {}),
    source: "agent.loop",
    kind: "helper_outcome",
    status,
    summary: `Helper outcome ${input.helperOutcome.status}: ${input.helperOutcome.summary}`,
    ...(input.helperOutcome.processId !== undefined
      ? {
          target: {
            type: "process" as const,
            value: input.helperOutcome.processId,
            normalizedValue: input.helperOutcome.processId,
          },
        }
      : artifactTarget !== undefined
        ? {
            target: {
              type: "artifact" as const,
              value: artifactTarget,
              normalizedValue: normalizeTarget(artifactTarget),
            },
          }
        : {}),
    facts: sanitizeRecord({
      ...input.helperOutcome,
      ...(command !== undefined ? { command } : {}),
      ...(artifactTarget !== undefined ? { artifactTarget } : {}),
    }),
    ...(buildLedgerLinks() !== undefined ||
    input.helperOutcome.processId !== undefined
      ? {
          links: {
            ...(buildLedgerLinks() ?? {}),
            ...(input.helperOutcome.processId !== undefined ? { processId: input.helperOutcome.processId } : {}),
          },
        }
      : {}),
    nextUse: helperOutcomeNextUse(input.helperOutcome),
    claimImpact: helperOutcomeClaimImpact(input.helperOutcome, artifactTarget),
  };
}

export function summarizeToolEvidenceLedger(input: {
  ledger: EvidenceLedgerEntry[] | undefined;
}): {
  successfulCalls: Array<{ toolName: string; count: number }>;
  failedCalls: Array<{ toolName: string; count: number }>;
} | undefined {
  const successfulCounts = new Map<string, number>();
  const failedCounts = new Map<string, number>();
  for (const entry of input.ledger ?? []) {
    if (entry.source !== "tool") {
      continue;
    }
    const toolName = asString(entry.facts.toolName)?.trim();
    if (toolName === undefined || toolName.length === 0) {
      continue;
    }
    if (entry.status === "failed" || entry.status === "blocked") {
      incrementToolCount(failedCounts, toolName);
      continue;
    }
    incrementToolCount(successfulCounts, toolName);
  }
  if (successfulCounts.size === 0 && failedCounts.size === 0) {
    return undefined;
  }
  return {
    successfulCalls: [...successfulCounts.entries()]
      .map(([toolName, count]) => ({ toolName, count }))
      .sort((left, right) => left.toolName.localeCompare(right.toolName)),
    failedCalls: [...failedCounts.entries()]
      .map(([toolName, count]) => ({ toolName, count }))
      .sort((left, right) => left.toolName.localeCompare(right.toolName)),
  };
}

function buildEvidenceCompletionSummaryFromEntries(
  ledger: EvidenceLedgerEntry[],
): {
  supportedTokens: string[];
  blockedTokens: string[];
  supportEntries: EvidenceLedgerEntry[];
  blockerEntries: EvidenceLedgerEntry[];
} {
  const tokenState = new Map<string, { status: "supports" | "blocks"; entry: EvidenceLedgerEntry }>();
  for (let index = 0; index < ledger.length; index += 1) {
    const entry = ledger[index];
    if (entry === undefined) {
      continue;
    }
    for (const token of readCompletionSupportTokens(entry)) {
      tokenState.set(token, { status: "supports", entry });
    }
    if (isArtifactVerificationBlockerSuperseded(ledger, index, entry)) {
      continue;
    }
    for (const token of readCompletionBlockerTokens(entry)) {
      tokenState.set(token, { status: "blocks", entry });
    }
  }
  const supportedTokens: string[] = [];
  const blockedTokens: string[] = [];
  const supportEntries = new Map<string, EvidenceLedgerEntry>();
  const blockerEntries = new Map<string, EvidenceLedgerEntry>();
  for (const [token, state] of tokenState) {
    if (state.status === "supports") {
      supportedTokens.push(token);
      supportEntries.set(state.entry.id, state.entry);
      continue;
    }
    blockedTokens.push(token);
    blockerEntries.set(state.entry.id, state.entry);
  }
  return {
    supportedTokens: supportedTokens.sort((left, right) => left.localeCompare(right)),
    blockedTokens: blockedTokens.sort((left, right) => left.localeCompare(right)),
    supportEntries: [...supportEntries.values()],
    blockerEntries: [...blockerEntries.values()],
  };
}

function isArtifactVerificationBlockerSuperseded(
  ledger: EvidenceLedgerEntry[],
  index: number,
  entry: EvidenceLedgerEntry,
): boolean {
  if (
    entry.kind !== "artifact_verification" ||
    (
      entry.status !== "failed" &&
      entry.status !== "blocked" &&
      entry.status !== "inconclusive"
    )
  ) {
    return false;
  }
  return ledger
    .slice(index + 1)
    .some((laterEntry) =>
      readCompletionSupportTokens(laterEntry)
        .some(isConcreteCompletionSupportToken)
    );
}

function isConcreteCompletionSupportToken(token: string): boolean {
  return token.startsWith("check:") ||
    token.startsWith("file:") ||
    token.startsWith("verify:");
}

function readCompletionSupportTokens(entry: EvidenceLedgerEntry): string[] {
  if (entry.status !== "passed") {
    return [];
  }
  const tokens: string[] = [];
  const toolName = asString(entry.facts.toolName)?.trim();
  if (toolName !== undefined && toolName.length > 0) {
    tokens.push(`tool:${toolName}`);
  }
  if (entry.kind === "artifact_verification") {
    const target = readEntryArtifactTarget(entry);
    if (target !== undefined) {
      tokens.push(`verify:${target}`);
    }
  }
  if (entry.kind === "process_result") {
    tokens.push(...readEntryCommandSegments(entry).map((command) => `check:${command}`));
  }
  if (isSuccessfulFileMutationEvidence(entry)) {
    const filePath = readEntryPathTarget(entry);
    if (filePath !== undefined) {
      tokens.push(`file:${filePath}`);
    }
    tokens.push(...readEntryChangedFiles(entry).map((path) => `file:${path}`));
  }
  if (entry.kind === "file_content") {
    const filePath = readEntryPathTarget(entry);
    if (filePath !== undefined) {
      tokens.push(`file:${filePath}`);
    }
  }
  return uniqueStrings(tokens);
}

function readCompletionBlockerTokens(entry: EvidenceLedgerEntry): string[] {
  if (
    entry.status !== "failed" &&
    entry.status !== "blocked" &&
    entry.status !== "inconclusive"
  ) {
    return [];
  }
  const tokens: string[] = [];
  if (entry.kind === "artifact_verification") {
    const target = readEntryArtifactTarget(entry);
    if (target !== undefined) {
      tokens.push(`verify:${target}`);
    }
  }
  if (entry.kind === "process_result") {
    tokens.push(...readEntryCommandSegments(entry).map((command) => `check:${command}`));
  }
  if (isFileMutationToolName(asString(entry.facts.toolName))) {
    const filePath = readEntryPathTarget(entry);
    if (filePath !== undefined) {
      tokens.push(`file:${filePath}`);
    }
    tokens.push(...readEntryChangedFiles(entry).map((path) => `file:${path}`));
  }
  return uniqueStrings(tokens);
}

function isSuccessfulFileMutationEvidence(entry: EvidenceLedgerEntry): boolean {
  const toolName = asString(entry.facts.toolName);
  if (toolName === "dev.shell.run" || toolName === "exec_command") {
    return readEntryChangedFiles(entry).length > 0;
  }
  if (isFileMutationToolName(toolName) === false) {
    return false;
  }
  if (
    entry.facts.changed === false ||
    (typeof entry.facts.replacements === "number" && Math.trunc(entry.facts.replacements) <= 0)
  ) {
    return false;
  }
  return true;
}

function isFileMutationToolName(toolName: string | undefined): boolean {
  return toolName === "fs.write_text" ||
    toolName === "fs.replace_text" ||
    toolName === "fs.patch_text";
}

function readEntryCommandSegments(entry: EvidenceLedgerEntry): string[] {
  const command = asString(entry.facts.command)?.trim();
  if (command === undefined || command.length === 0) {
    return [];
  }
  return splitShellAndChainCommands(command)
    .map(normalizeEvidenceCommand)
    .filter((item): item is string => item !== undefined);
}

function splitShellAndChainCommands(command: string): string[] {
  return command.split(/\s+&&\s+/u);
}

function normalizeEvidenceCommand(value: string): string | undefined {
  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized.length > 0 ? normalized : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function readEntryArtifactTarget(entry: EvidenceLedgerEntry): string | undefined {
  const target = asString(entry.target?.value)?.trim() ??
    asString(entry.facts.target)?.trim();
  return target !== undefined && target.length > 0 ? normalizeTarget(target) : undefined;
}

function readEntryPathTarget(entry: EvidenceLedgerEntry): string | undefined {
  const target = entry.target?.type === "path" ? asString(entry.target.value)?.trim() : undefined;
  const path = target ??
    asString(entry.facts.outputPath)?.trim() ??
    asString(entry.facts.inputPath)?.trim() ??
    asString(entry.facts.sourcePath)?.trim();
  return path !== undefined && path.length > 0 ? normalizeTarget(path) : undefined;
}

function readEntryChangedFiles(entry: EvidenceLedgerEntry): string[] {
  return readChangedFiles(entry.facts);
}

function readChangedFiles(value: unknown): string[] {
  return uniqueStrings(
    asArray(asRecord(value)?.changedFiles)
      .map((item) => asString(item)?.trim())
      .filter((item): item is string => item !== undefined && item.length > 0)
      .map(normalizeTarget),
  ).slice(0, MAX_CHANGED_FILE_FACT_ITEMS);
}

function parseEvidenceLedgerEntry(value: unknown): EvidenceLedgerEntry | undefined {
  const root = asRecord(value);
  const id = asString(root?.id)?.trim();
  const source = parseLedgerSource(root?.source);
  const kind = parseLedgerKind(root?.kind);
  const status = parseLedgerStatus(root?.status);
  const summary = asString(root?.summary)?.trim();
  const facts = asRecord(root?.facts) ?? {};
  if (
    root === undefined ||
    root.version !== "v1" ||
    id === undefined ||
    source === undefined ||
    kind === undefined ||
    status === undefined ||
    summary === undefined ||
    summary.length === 0
  ) {
    return undefined;
  }
  const createdAt = asString(root.createdAt) ?? buildEvidenceCreatedAt();
  return {
    id,
    version: "v1",
    createdAt,
    ...(typeof root.stepIndex === "number" && Number.isFinite(root.stepIndex)
      ? { stepIndex: Math.trunc(root.stepIndex) }
      : {}),
    source,
    kind,
    status,
    summary,
    ...(parseTarget(root.target) !== undefined ? { target: parseTarget(root.target) } : {}),
    facts,
    ...(parseRaw(root.raw) !== undefined ? { raw: parseRaw(root.raw) } : {}),
    ...(parseLinks(root.links) !== undefined ? { links: parseLinks(root.links) } : {}),
    ...(parseNextUse(root.nextUse) !== undefined ? { nextUse: parseNextUse(root.nextUse) } : {}),
    ...(parseClaimImpact(root.claimImpact) !== undefined ? { claimImpact: parseClaimImpact(root.claimImpact) } : {}),
  };
}

function parseLedgerSource(value: unknown): EvidenceLedgerEntry["source"] | undefined {
  const source = asString(value);
  if (source === "observer") {
    // Compatibility parse for historical persisted ledgers; not an active source.
    return "agent.loop";
  }
  return source === "tool" ||
    source === "agent.loop" ||
    source === "policy" ||
    source === "runtime"
    ? source
    : undefined;
}

function inferToolEvidenceKind(toolName: string, output: Record<string, unknown> | undefined): EvidenceLedgerKind {
  if (toolName === "fs.list") {
    return "file_listing";
  }
  if (toolName === "fs.read_text" || toolName === "fs.search_text") {
    return "file_content";
  }
  if (isDevShellLifecycleTool(toolName)) {
    const status = normalizeDevShellLifecycle(toolName, undefined, output)?.status ?? asString(output?.status);
    return status === "RUNNING" ? "process_state" : "process_result";
  }
  return "tool_result";
}

function inferToolStatus(output: Record<string, unknown> | undefined): EvidenceLedgerStatus {
  const status = asString(output?.status)?.toLowerCase();
  if (status === "running") {
    return "running";
  }
  const exitCode = typeof output?.exitCode === "number" && Number.isFinite(output.exitCode)
    ? Math.trunc(output.exitCode)
    : undefined;
  if (exitCode !== undefined && exitCode !== 0) {
    return "failed";
  }
  if (status === "no_change") {
    return "inconclusive";
  }
  if (status === "failed" || status === "lost" || status === "error") {
    return "failed";
  }
  if (status === "blocked") {
    return "blocked";
  }
  if (
    output?.ok === false ||
    asRecord(output?.error) !== undefined ||
    asString(output?.errorCode) !== undefined ||
    asString(output?.error) !== undefined
  ) {
    return "failed";
  }
  return "passed";
}

function inferToolTarget(
  toolName: string,
  input: Record<string, unknown> | undefined,
  output: Record<string, unknown> | undefined,
): EvidenceLedgerEntry["target"] | undefined {
  const path = asString(output?.path) ?? asString(input?.path);
  if (path !== undefined) {
    return { type: "path", value: path, normalizedValue: normalizeTarget(path) };
  }
  const processId =
    asString(output?.processId) ??
    asString(input?.processId) ??
    asString(output?.sessionId) ??
    asString(input?.sessionId);
  if (processId !== undefined) {
    return { type: "process", value: processId, normalizedValue: processId };
  }
  const url = asString(output?.url) ?? asString(input?.url);
  if (url !== undefined) {
    return { type: "url", value: url, normalizedValue: url };
  }
  return { type: "tool", value: toolName, normalizedValue: toolName };
}

function buildToolFacts(
  toolName: string,
  input: Record<string, unknown> | undefined,
  output: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const entries = asArray(output?.entries);
  const hasEntryOutput = Array.isArray(output?.entries);
  const matches = asArray(output?.matches);
  const hasMatchOutput = Array.isArray(output?.matches);
  const sentInput = toolName === "dev.process.write" || toolName === "dev.process.write_and_read" || toolName === "exec_command"
    ? asString(input?.data) ?? asString(input?.stdin) ?? asString(input?.input) ?? asString(input?.chars)
    : undefined;
  const response = toolName === "dev.process.write" || toolName === "dev.process.write_and_read" || toolName === "exec_command"
    ? asString(output?.output) ?? asString(output?.text) ?? asString(output?.chunk) ?? asString(output?.stderr) ?? asString(output?.stdout)
    : undefined;
  const readContent = toolName === "fs.read_text" || toolName === "fs.search_text"
    ? asString(output?.content) ?? asString(output?.contentPreview) ?? asString(output?.text)
    : undefined;
  const processIdFact =
    asString(output?.processId) ??
    asString(input?.processId) ??
    asString(output?.sessionId) ??
    asString(input?.sessionId);
  const sessionIdFact = asString(output?.sessionId) ?? asString(input?.sessionId);
  return {
    ...(asString(input?.path) !== undefined ? { inputPath: asString(input?.path) } : {}),
    ...(asString(output?.path) !== undefined ? { outputPath: asString(output?.path) } : {}),
    ...(asString(input?.sourcePath) !== undefined ? { sourcePath: asString(input?.sourcePath) } : {}),
    ...(asString(output?.sourcePath) !== undefined ? { sourcePath: asString(output?.sourcePath) } : {}),
    ...(asString(input?.destinationPath) !== undefined ? { destinationPath: asString(input?.destinationPath) } : {}),
    ...(asString(output?.destinationPath) !== undefined ? { destinationPath: asString(output?.destinationPath) } : {}),
    ...(toolName === "fs.list" && typeof input?.includeHidden === "boolean"
      ? { inputIncludeHidden: input.includeHidden }
      : {}),
    ...(toolName === "fs.list" && typeof input?.recursive === "boolean"
      ? { inputRecursive: input.recursive }
      : {}),
    ...(toolName === "fs.list" && typeof input?.maxDepth === "number" && Number.isFinite(input.maxDepth)
      ? { inputMaxDepth: Math.max(0, Math.trunc(input.maxDepth)) }
      : {}),
    ...(toolName === "fs.read_text" && typeof input?.maxBytes === "number" && Number.isFinite(input.maxBytes)
      ? { inputMaxBytes: Math.max(1, Math.trunc(input.maxBytes)) }
      : {}),
    ...(readContent !== undefined
      ? {
          contentPreview: clamp(readContent, 2_000),
          contentPreviewTruncated: readContent.length > 2_000,
        }
      : {}),
    ...(toolName === "fs.search_text" && asString(input?.query) !== undefined
      ? { query: asString(input?.query) }
      : {}),
    ...(toolName === "fs.search_text" && asString(input?.glob) !== undefined
      ? { glob: asString(input?.glob) }
      : {}),
    ...(toolName === "fs.search_text" && typeof input?.caseSensitive === "boolean"
      ? { caseSensitive: input.caseSensitive }
      : {}),
    ...(toolName === "fs.search_text" && typeof input?.maxResults === "number" && Number.isFinite(input.maxResults)
      ? { maxResults: Math.max(0, Math.trunc(input.maxResults)) }
      : {}),
    ...(toolName === "fs.search_text" && typeof input?.maxPreviewChars === "number" && Number.isFinite(input.maxPreviewChars)
      ? { maxPreviewChars: Math.max(1, Math.trunc(input.maxPreviewChars)) }
      : {}),
    ...(toolName === "fs.search_text" && typeof input?.maxTotalPreviewChars === "number" && Number.isFinite(input.maxTotalPreviewChars)
      ? { maxTotalPreviewChars: Math.max(1, Math.trunc(input.maxTotalPreviewChars)) }
      : {}),
    ...(toolName === "fs.search_text" && hasMatchOutput
      ? {
          matchCount: typeof output?.matchCount === "number" && Number.isFinite(output.matchCount)
            ? Math.max(0, Math.trunc(output.matchCount))
            : matches.length,
          returnedMatchCount: typeof output?.returnedMatchCount === "number" && Number.isFinite(output.returnedMatchCount)
            ? Math.max(0, Math.trunc(output.returnedMatchCount))
            : matches.length,
          truncated: typeof output?.truncated === "boolean" ? output.truncated : undefined,
          previewTruncatedCount: typeof output?.previewTruncatedCount === "number" && Number.isFinite(output.previewTruncatedCount)
            ? Math.max(0, Math.trunc(output.previewTruncatedCount))
            : undefined,
          totalPreviewChars: typeof output?.totalPreviewChars === "number" && Number.isFinite(output.totalPreviewChars)
            ? Math.max(0, Math.trunc(output.totalPreviewChars))
            : undefined,
          matches: matches
            .slice(0, MAX_MATCH_PREVIEW_ITEMS)
            .map((match) => asRecord(match))
            .filter((match): match is Record<string, unknown> => match !== undefined)
            .map((match) => ({
              ...(asString(match.path) !== undefined ? { path: asString(match.path) } : {}),
              ...(typeof match.line === "number" && Number.isFinite(match.line)
                ? { line: Math.trunc(match.line) }
                : {}),
              ...(typeof match.column === "number" && Number.isFinite(match.column)
                ? { column: Math.trunc(match.column) }
                : {}),
              ...(asString(match.preview) !== undefined
                ? {
                    preview: clamp(asString(match.preview) ?? "", MAX_FACT_TEXT_PREVIEW_CHARS),
                    previewTruncated: (asString(match.preview) ?? "").length > MAX_FACT_TEXT_PREVIEW_CHARS,
                  }
                : {}),
            })),
          matchesTruncated: matches.length > MAX_MATCH_PREVIEW_ITEMS,
        }
      : {}),
    ...(toolName === "fs.replace_text" && asString(input?.find) !== undefined
      ? compactStringFact("find", asString(input?.find) ?? "", MAX_FACT_TEXT_PREVIEW_CHARS)
      : {}),
    ...(toolName === "fs.replace_text" && asString(input?.replace) !== undefined
      ? compactStringFact("replace", asString(input?.replace) ?? "", MAX_FACT_TEXT_PREVIEW_CHARS)
      : {}),
    ...(toolName === "fs.replace_text" && typeof input?.all === "boolean"
      ? { all: input.all }
      : {}),
    ...(toolName === "fs.replace_text" && typeof output?.findWhitespaceTokenCount === "number" && Number.isFinite(output.findWhitespaceTokenCount)
      ? { findWhitespaceTokenCount: Math.max(0, Math.trunc(output.findWhitespaceTokenCount)) }
      : {}),
    ...(toolName === "fs.replace_text" && typeof output?.replaceWhitespaceTokenCount === "number" && Number.isFinite(output.replaceWhitespaceTokenCount)
      ? { replaceWhitespaceTokenCount: Math.max(0, Math.trunc(output.replaceWhitespaceTokenCount)) }
      : {}),
    ...(toolName === "fs.replace_text" && typeof output?.perReplacementWhitespaceTokenDelta === "number" && Number.isFinite(output.perReplacementWhitespaceTokenDelta)
      ? { perReplacementWhitespaceTokenDelta: Math.trunc(output.perReplacementWhitespaceTokenDelta) }
      : {}),
    ...(toolName === "fs.replace_text" && typeof output?.bytesBefore === "number" && Number.isFinite(output.bytesBefore)
      ? { bytesBefore: Math.max(0, Math.trunc(output.bytesBefore)) }
      : {}),
    ...(toolName === "fs.replace_text" && typeof output?.bytesAfter === "number" && Number.isFinite(output.bytesAfter)
      ? { bytesAfter: Math.max(0, Math.trunc(output.bytesAfter)) }
      : {}),
    ...(toolName === "fs.replace_text" && typeof output?.lineCountBefore === "number" && Number.isFinite(output.lineCountBefore)
      ? { lineCountBefore: Math.max(0, Math.trunc(output.lineCountBefore)) }
      : {}),
    ...(toolName === "fs.replace_text" && typeof output?.lineCountAfter === "number" && Number.isFinite(output.lineCountAfter)
      ? { lineCountAfter: Math.max(0, Math.trunc(output.lineCountAfter)) }
      : {}),
    ...(toolName === "fs.replace_text" && typeof output?.whitespaceTokenCountBefore === "number" && Number.isFinite(output.whitespaceTokenCountBefore)
      ? { whitespaceTokenCountBefore: Math.max(0, Math.trunc(output.whitespaceTokenCountBefore)) }
      : {}),
    ...(toolName === "fs.replace_text" && typeof output?.whitespaceTokenCountAfter === "number" && Number.isFinite(output.whitespaceTokenCountAfter)
      ? { whitespaceTokenCountAfter: Math.max(0, Math.trunc(output.whitespaceTokenCountAfter)) }
      : {}),
    ...(toolName === "fs.replace_text" && typeof output?.lineCountDelta === "number" && Number.isFinite(output.lineCountDelta)
      ? { lineCountDelta: Math.trunc(output.lineCountDelta) }
      : {}),
    ...(toolName === "fs.replace_text" && typeof output?.whitespaceTokenCountDelta === "number" && Number.isFinite(output.whitespaceTokenCountDelta)
      ? { whitespaceTokenCountDelta: Math.trunc(output.whitespaceTokenCountDelta) }
      : {}),
    ...(toolName === "fs.write_text" && (asString(input?.mode) ?? asString(output?.mode)) !== undefined
      ? { mode: asString(input?.mode) ?? asString(output?.mode) }
      : {}),
    ...(toolName === "fs.write_text" && typeof input?.createParents === "boolean"
      ? { createParents: input.createParents }
      : {}),
    ...(toolName === "fs.write_text" && typeof output?.existed === "boolean"
      ? { existed: output.existed }
      : {}),
    ...(toolName === "fs.write_text" && typeof output?.changed === "boolean"
      ? { changed: output.changed }
      : {}),
    ...(toolName === "fs.write_text" && typeof output?.bytesBefore === "number" && Number.isFinite(output.bytesBefore)
      ? { bytesBefore: Math.max(0, Math.trunc(output.bytesBefore)) }
      : {}),
    ...(toolName === "fs.write_text" && typeof output?.bytesAfter === "number" && Number.isFinite(output.bytesAfter)
      ? { bytesAfter: Math.max(0, Math.trunc(output.bytesAfter)) }
      : {}),
    ...(toolName === "fs.write_text" && typeof output?.lineCountBefore === "number" && Number.isFinite(output.lineCountBefore)
      ? { lineCountBefore: Math.max(0, Math.trunc(output.lineCountBefore)) }
      : {}),
    ...(toolName === "fs.write_text" && typeof output?.lineCountAfter === "number" && Number.isFinite(output.lineCountAfter)
      ? { lineCountAfter: Math.max(0, Math.trunc(output.lineCountAfter)) }
      : {}),
    ...(toolName === "fs.write_text" && typeof output?.whitespaceTokenCountBefore === "number" && Number.isFinite(output.whitespaceTokenCountBefore)
      ? { whitespaceTokenCountBefore: Math.max(0, Math.trunc(output.whitespaceTokenCountBefore)) }
      : {}),
    ...(toolName === "fs.write_text" && typeof output?.whitespaceTokenCountAfter === "number" && Number.isFinite(output.whitespaceTokenCountAfter)
      ? { whitespaceTokenCountAfter: Math.max(0, Math.trunc(output.whitespaceTokenCountAfter)) }
      : {}),
    ...(toolName === "fs.write_text" && numberDelta(output?.whitespaceTokenCountBefore, output?.whitespaceTokenCountAfter) !== undefined
      ? { whitespaceTokenCountDelta: numberDelta(output?.whitespaceTokenCountBefore, output?.whitespaceTokenCountAfter) }
      : {}),
    ...(toolName === "fs.write_text" && numberDelta(output?.lineCountBefore, output?.lineCountAfter) !== undefined
      ? { lineCountDelta: numberDelta(output?.lineCountBefore, output?.lineCountAfter) }
      : {}),
    ...(toolName === "fs.write_text" && asRecord(output?.diffPreview) !== undefined
      ? compactDiffPreviewFact(asRecord(output?.diffPreview))
      : {}),
    ...(toolName === "fs.write_text" && asString(input?.content) !== undefined
      ? {
          contentBytes: Buffer.byteLength(asString(input?.content) ?? "", "utf8"),
          contentHash: createHash("sha256").update(asString(input?.content) ?? "").digest("hex").slice(0, 16),
          ...compactStringFact("contentPreview", asString(input?.content) ?? "", MAX_FACT_TEXT_PREVIEW_CHARS),
        }
      : {}),
    ...(asString(input?.command) !== undefined ? { command: asString(input?.command) } : {}),
    ...(asString(output?.command) !== undefined ? { command: asString(output?.command) } : {}),
    ...(processIdFact !== undefined ? { processId: processIdFact } : {}),
    ...(sessionIdFact !== undefined ? { sessionId: sessionIdFact } : {}),
    ...(sentInput !== undefined
      ? {
          sentInputPreview: clamp(sentInput, 500),
          sentInputBytes: Buffer.byteLength(sentInput, "utf8"),
        }
      : {}),
    ...(response !== undefined
      ? {
          responsePreview: clamp(response, 800),
          responseBytes: Buffer.byteLength(response, "utf8"),
          responseHash: createHash("sha256").update(response).digest("hex").slice(0, 16),
        }
      : {}),
    ...(asString(output?.cwd) !== undefined ? { cwd: asString(output?.cwd) } : {}),
    ...(asString(output?.workspaceRoot) !== undefined ? { workspaceRoot: asString(output?.workspaceRoot) } : {}),
    ...(readChangedFiles(output).length > 0 ? { changedFiles: readChangedFiles(output) } : {}),
    ...(typeof output?.exitCode === "number" ? { exitCode: Math.trunc(output.exitCode) } : {}),
    ...(typeof output?.replacements === "number" && Number.isFinite(output.replacements)
      ? { replacements: Math.max(0, Math.trunc(output.replacements)) }
      : {}),
    ...(typeof output?.changed === "boolean" ? { changed: output.changed } : {}),
    ...(typeof output?.bytesWritten === "number" && Number.isFinite(output.bytesWritten)
      ? { bytesWritten: Math.max(0, Math.trunc(output.bytesWritten)) }
      : {}),
    ...(hasEntryOutput ? { entryCount: entries.length } : {}),
    ...(asString(output?.message) !== undefined ? { message: asString(output?.message) } : {}),
    ...(typeof output?.empty === "boolean" ? { empty: output.empty } : {}),
    ...(typeof output?.omittedHiddenEntryCount === "number" && Number.isFinite(output.omittedHiddenEntryCount)
      ? { omittedHiddenEntryCount: Math.max(0, Math.trunc(output.omittedHiddenEntryCount)) }
      : {}),
    ...(asRecord(output?.directoryFacts) !== undefined ? { directoryFacts: asRecord(output?.directoryFacts) } : {}),
    ...(toolName === "fs.list" && hasEntryOutput
      ? {
          entries: entries
            .slice(0, 40)
            .map((entry) => asRecord(entry))
            .filter((entry): entry is Record<string, unknown> => entry !== undefined)
            .map((entry) => ({
              ...(asString(entry.name) !== undefined ? { name: asString(entry.name) } : {}),
              ...(asString(entry.path) !== undefined ? { path: asString(entry.path) } : {}),
              ...(asString(entry.type) !== undefined ? { type: asString(entry.type) } : {}),
            })),
        }
      : {}),
  };
}

function numberDelta(before: unknown, after: unknown): number | undefined {
  if (
    typeof before !== "number" ||
    typeof after !== "number" ||
    Number.isFinite(before) === false ||
    Number.isFinite(after) === false
  ) {
    return undefined;
  }
  return Math.trunc(after) - Math.trunc(before);
}

function formatSignedNumber(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

function compactDiffPreviewFact(
  diffPreview: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (diffPreview === undefined) {
    return {};
  }
  const before = asString(diffPreview.before);
  const after = asString(diffPreview.after);
  return {
    ...(before !== undefined ? { diffPreviewBefore: clamp(before, MAX_FACT_TEXT_PREVIEW_CHARS) } : {}),
    ...(after !== undefined ? { diffPreviewAfter: clamp(after, MAX_FACT_TEXT_PREVIEW_CHARS) } : {}),
    ...(typeof diffPreview.truncated === "boolean" ? { diffPreviewTruncated: diffPreview.truncated } : {}),
  };
}

function compactStringFact(
  key: string,
  value: string,
  maxChars: number,
): Record<string, unknown> {
  return {
    [key]: clamp(value, maxChars),
    ...(value.length > maxChars ? { [`${key}Truncated`]: true } : {}),
  };
}

function buildRawMetadata(
  output: Record<string, unknown> | undefined,
  contextPreviewBytes = DEFAULT_PREVIEW_BYTES,
): EvidenceLedgerEntry["raw"] | undefined {
  const content = asString(output?.content) ?? asString(output?.text) ?? asString(output?.chunk);
  const bytes = content !== undefined
    ? Buffer.byteLength(content, "utf8")
    : typeof output?.sizeBytes === "number"
      ? Math.max(0, Math.trunc(output.sizeBytes))
      : undefined;
  const hash = content !== undefined
    ? createHash("sha256").update(content).digest("hex").slice(0, 16)
    : undefined;
  const contextPreviewTruncated = bytes !== undefined && bytes > contextPreviewBytes;
  const raw = {
    ...(asString(output?.digestArtifactId) !== undefined ? { ref: asString(output?.digestArtifactId) } : {}),
    ...(bytes !== undefined ? { bytes } : {}),
    ...(hash !== undefined ? { hash } : {}),
    ...(typeof output?.truncated === "boolean" ? { toolOutputTruncated: output.truncated } : {}),
    ...(contextPreviewTruncated ? { contextPreviewTruncated: true, contextPreviewBytes } : {}),
  };
  return Object.keys(raw).length > 0 ? raw : undefined;
}

function buildDerivedToolEvidence(
  input: {
    stepIndex?: number | undefined;
    toolName: string;
    toolInput?: Record<string, unknown> | undefined;
    toolOutput: unknown;
  },
  base: EvidenceLedgerEntry,
): EvidenceLedgerEntry[] {
  const output = asRecord(input.toolOutput);
  if (isArtifactVerificationTool(input.toolName)) {
    const artifactVerification = asRecord(output?.artifactVerification);
    const target = asString(artifactVerification?.target) ?? asString(output?.target);
    const status = asString(artifactVerification?.status);
    if (
      artifactVerification !== undefined &&
      target !== undefined &&
      (status === "passed" || status === "failed" || status === "inconclusive")
    ) {
      const requirementIds = asArray(artifactVerification.requirements)
        .map((item) => asString(asRecord(item)?.id)?.trim())
        .filter((item): item is string => item !== undefined && item.length > 0);
      return [
        {
          ...base,
          id: `${base.id}:artifact_verification`,
          source: "runtime",
          kind: "artifact_verification",
          status,
          summary: asString(output?.summary) ??
            `Artifact verification ${status} for ${target}.`,
          target: {
            type: "artifact",
            value: target,
            normalizedValue: normalizeTarget(target),
          },
          facts: artifactVerification,
          links: {
            ...(base.links ?? {}),
            artifactTarget: target,
          },
          nextUse: status === "passed"
            ? {
                supports: target,
                invalidatesRepeat: true,
              }
            : {
                blocks: target,
                requiresAction: "repair_artifact_or_run_observable_verification",
                invalidatesRepeat: true,
              },
          claimImpact: {
            success: status === "passed" ? "supports" : "neutral",
            reason: status === "passed"
              ? "artifact_verification_passed"
              : "artifact_verification_failed_feedback",
            scope: "artifact",
            target,
            ...(requirementIds.length > 0 ? { requirementIds } : {}),
          },
        },
      ];
    }
  }
  const command = asString(output?.command) ?? asString(input.toolInput?.command);
  const commandRole = deriveCommandExecutionRole({
    toolName: input.toolName,
    toolInput: input.toolInput,
  })?.effective;
  const sourcePath = commandRole?.sourcePath ??
    inferSourcePath(command);
  const artifactTarget = commandRole?.artifactTarget;
  const status = asString(output?.status);
  const exitCode = typeof output?.exitCode === "number" ? Math.trunc(output.exitCode) : undefined;
  const chunk = asString(output?.output) ?? asString(output?.text) ?? asString(output?.chunk) ?? asString(output?.stderr) ?? asString(output?.stdout);
  const processId =
    asString(output?.processId) ??
    asString(input.toolInput?.processId) ??
    asString(output?.sessionId) ??
    asString(input.toolInput?.sessionId);
  if (
    (input.toolName.startsWith("dev.shell.") || input.toolName === "exec_command") &&
    command !== undefined &&
    (commandRole?.role === "helper_execution" || commandRole?.role === "helper_repair_check") &&
    helperCommandRoleHasConcreteTarget(commandRole) &&
    !((exitCode !== undefined && exitCode !== 0) || status === "FAILED" || status === "LOST")
  ) {
    const helperOutcome = inferHelperOutcomeFromProcessResult({
      status,
      exitCode,
      chunk,
      processId,
      command,
      artifactTarget,
    });
    if (helperOutcome !== undefined) {
      return [
        {
          ...buildHelperOutcomeEvidenceEntry({
            stepIndex: input.stepIndex,
            helperOutcome,
          }),
          id: `${base.id}:helper_outcome`,
          source: "runtime",
        },
      ];
    }
  }
  if (
    input.toolName === "dev.shell.run" &&
    sourcePath !== undefined &&
    isHelperFailureCommandRole(commandRole?.role) &&
    ((exitCode !== undefined && exitCode !== 0) || status === "FAILED" || status === "LOST")
  ) {
    return [
      {
        ...buildHelperOutcomeEvidenceEntry({
          stepIndex: input.stepIndex,
          helperOutcome: {
            status: "failed_runtime",
            summary: clamp(chunk ?? base.summary, 600),
            ...(processId !== undefined ? { processId } : {}),
            ...(command !== undefined ? { command } : {}),
            ...(artifactTarget !== undefined ? { artifactTarget } : {}),
            progressEvidence: "Helper/controller tactic failed during execution.",
            remainingWork: "Treat this as failed controller evidence; inspect or repair source only when that advances the active artifact target or latest blocker.",
            nextSuggestedAction: "replan",
          },
        }),
        id: `${base.id}:helper_outcome`,
        source: "runtime",
      },
      {
        ...base,
        id: `${base.id}:helper_failure`,
        source: "runtime",
        kind: "helper_failure",
        status: "failed",
        summary: `Generated helper failed: ${command ?? input.toolName}`,
        target: { type: "path", value: sourcePath, normalizedValue: normalizeTarget(sourcePath) },
        facts: {
          command,
          sourcePath,
          ...(commandRole !== undefined
            ? {
                commandRole: commandRole.role,
                commandRoleSource: commandRole.source,
                ...(artifactTarget !== undefined ? { artifactTarget } : {}),
              }
            : {}),
          ...(exitCode !== undefined ? { exitCode } : {}),
          errorPreview: clamp(chunk ?? base.summary, 1_200),
        },
        links: {
          ...(base.links ?? {}),
          sourcePath,
          ...(artifactTarget !== undefined ? { artifactTarget } : {}),
        },
        nextUse: {
          blocks: "evidence_collection",
          requiresAction: "choose_next_evidence_or_derivation_tactic",
          invalidatesRepeat: true,
        },
      },
    ];
  }
  return [];
}

function isArtifactVerificationTool(toolName: string): boolean {
  return toolName === "fs.verify_json";
}

function buildToolNextUse(
  kind: EvidenceLedgerKind,
  status: EvidenceLedgerStatus,
  target: EvidenceLedgerEntry["target"],
  raw: EvidenceLedgerEntry["raw"],
): EvidenceLedgerEntry["nextUse"] | undefined {
  if (status === "failed" || status === "blocked" || status === "inconclusive") {
    return {
      blocks: target?.value,
      requiresAction: "repair_or_choose_new_action",
      invalidatesRepeat: true,
    };
  }
  if (kind === "file_listing" || kind === "file_content") {
    return {
      supports: target?.value,
    };
  }
  return undefined;
}

function incrementToolCount(target: Map<string, number>, toolName: string): void {
  target.set(toolName, (target.get(toolName) ?? 0) + 1);
}

function buildLedgerLinks(output?: Record<string, unknown> | undefined): EvidenceLedgerEntry["links"] | undefined {
  const links = {
    ...(asString(output?.processId) !== undefined
      ? { processId: asString(output?.processId) }
      : asString(output?.sessionId) !== undefined
        ? { processId: asString(output?.sessionId) }
        : {}),
  };
  return Object.keys(links).length > 0 ? links : undefined;
}

function isUnresolvedEvidenceEntry(entry: EvidenceLedgerEntry): boolean {
  return entry.status === "failed" ||
    entry.status === "inconclusive" ||
    entry.status === "blocked" ||
    entry.nextUse?.requiresAction !== undefined;
}

function helperCommandRoleHasConcreteTarget(
  commandRole: NonNullable<ReturnType<typeof deriveCommandExecutionRole>>["effective"] | undefined,
): boolean {
  return commandRole?.sourcePath !== undefined ||
    commandRole?.artifactTarget !== undefined;
}

function helperOutcomeToLedgerStatus(status: HelperOutcome["status"]): EvidenceLedgerStatus {
  if (status === "running") {
    return "running";
  }
  if (status === "completed_done") {
    return "passed";
  }
  if (status === "failed_runtime") {
    return "failed";
  }
  return status === "stalled" ? "blocked" : "inconclusive";
}

function helperOutcomeNextUse(outcome: HelperOutcome): EvidenceLedgerEntry["nextUse"] {
  if (outcome.status === "completed_done") {
    return {
      supports: "helper_completion",
      ...(outcome.nextSuggestedAction !== undefined ? { requiresAction: outcome.nextSuggestedAction } : {}),
    };
  }
  if (outcome.status === "running") {
    return {
      supports: "helper_progress",
      requiresAction: outcome.nextSuggestedAction ?? "collect_output",
    };
  }
  if (outcome.status === "failed_runtime") {
    return {
      blocks: "helper_completion",
      requiresAction: outcome.nextSuggestedAction ?? "replan",
      invalidatesRepeat: true,
    };
  }
  return {
    blocks: "helper_completion",
    requiresAction: outcome.nextSuggestedAction ?? (outcome.status === "stalled" ? "stop_process" : "replan"),
    invalidatesRepeat: true,
  };
}

function helperOutcomeClaimImpact(
  outcome: HelperOutcome,
  artifactTarget: string | undefined,
): EvidenceClaimImpact | undefined {
  if (outcome.status === "completed_done") {
    return {
      success: "neutral",
      reason: "helper_completed_done",
      scope: "helper",
      ...(artifactTarget !== undefined ? { target: artifactTarget } : {}),
    };
  }
  if (outcome.status === "running") {
    return {
      success: "neutral",
      reason: `helper_${outcome.status}`,
      scope: "helper",
      ...(artifactTarget !== undefined ? { target: artifactTarget } : {}),
    };
  }
  return {
    success: "neutral",
    reason: `helper_${outcome.status}`,
    scope: "helper",
    ...(artifactTarget !== undefined ? { target: artifactTarget } : {}),
  };
}

function inferHelperOutcomeFromProcessResult(input: {
  status: string | undefined;
  exitCode: number | undefined;
  chunk: string | undefined;
  processId: string | undefined;
  command: string;
  artifactTarget: string | undefined;
}): HelperOutcome | undefined {
  const chunk = input.chunk?.trim() ?? "";
  if (input.status === "RUNNING") {
    return {
      status: "running",
      summary: chunk.length > 0
        ? "Helper process is still running and produced output."
        : "Helper process is still running.",
      ...(input.processId !== undefined ? { processId: input.processId } : {}),
      command: input.command,
      ...(input.artifactTarget !== undefined ? { artifactTarget: input.artifactTarget } : {}),
      ...(chunk.length > 0 ? { progressEvidence: clamp(chunk, 600) } : {}),
      remainingWork: "Collect more output, send valid stdin if the helper protocol requires it, stop it, or replan from current evidence.",
      nextSuggestedAction: chunk.length > 0 ? "collect_output" : "continue_helper",
    };
  }
  if (input.status === "COMPLETED" && (input.exitCode === undefined || input.exitCode === 0)) {
    return {
      status: "completed_incomplete",
      summary: input.artifactTarget !== undefined
        ? `Helper process exited successfully, but the required artifact ${input.artifactTarget} still needs explicit completion or verification evidence.`
        : "Helper process exited successfully, but helper job completion still needs explicit evidence.",
      ...(input.processId !== undefined ? { processId: input.processId } : {}),
      command: input.command,
      ...(input.artifactTarget !== undefined ? { artifactTarget: input.artifactTarget } : {}),
      ...(chunk.length > 0 ? { progressEvidence: clamp(chunk, 600) } : {}),
      remainingWork: "Judge helper output and artifact evidence before verifying or continuing; exit 0 alone is not job completion.",
      nextSuggestedAction: input.artifactTarget !== undefined ? "replan" : "continue_helper",
    };
  }
  return undefined;
}

function normalizeTargetValue(value: string | undefined): string | undefined {
  return value === undefined ? undefined : normalizeTarget(value);
}

function findRepeatedInspection(ledger: EvidenceLedgerEntry[]): EvidenceLedgerEntry | undefined {
  void ledger;
  return undefined;
}

function selectContextEntries(
  ledger: EvidenceLedgerEntry[],
  unresolved: EvidenceLedgerEntry[],
  linked: EvidenceLedgerEntry[],
): EvidenceLedgerEntry[] {
  const selected = new Map<string, EvidenceLedgerEntry>();
  for (const entry of [...unresolved, ...linked, ...ledger.slice(-8)]) {
    selected.set(entry.id, entry);
  }
  return [...selected.values()].slice(-16);
}

function isControllerFailureEvidence(
  entry: EvidenceLedgerEntry,
  activeArtifactTarget: string | undefined,
): boolean {
  if (entry.kind === "helper_failure" && entry.status === "failed") {
    return true;
  }
  if (entry.kind === "process_result" && entry.status === "failed") {
    const toolName = asString(entry.facts.toolName);
    const commandRole = asString(entry.facts.commandRole);
    if (toolName !== "dev.shell.run") {
      return false;
    }
    if (
      commandRole === "helper_execution" ||
      commandRole === "helper_repair_check"
    ) {
      return activeArtifactTarget === undefined ||
        normalizeTargetValue(readControllerArtifactTarget(entry)) === activeArtifactTarget ||
        readControllerSourcePath(entry) !== undefined;
    }
    return entry.nextUse?.requiresAction === "repair_or_choose_new_action";
  }
  if (entry.kind !== "helper_outcome") {
    return false;
  }
  const helperStatus = asString(entry.facts.status);
  return entry.status === "failed" ||
    entry.status === "blocked" ||
    helperStatus === "failed_runtime" ||
    helperStatus === "completed_incomplete" ||
    helperStatus === "stalled";
}

function toActiveControllerFailure(
  entry: EvidenceLedgerEntry,
  activeArtifactTarget: string | undefined,
): ActiveControllerFailure {
  const artifactTarget = readControllerArtifactTarget(entry) ?? activeArtifactTarget;
  return {
    evidenceId: entry.id,
    ...(entry.stepIndex !== undefined ? { stepIndex: entry.stepIndex } : {}),
    status: entry.status as EvidenceLedgerStatus,
    summary: entry.summary,
    ...(readControllerCommand(entry) !== undefined ? { command: readControllerCommand(entry) } : {}),
    ...(readControllerSourcePath(entry) !== undefined ? { sourcePath: readControllerSourcePath(entry) } : {}),
    ...(artifactTarget !== undefined
      ? { artifactTarget }
      : {}),
    ...(readControllerProcessId(entry) !== undefined ? { processId: readControllerProcessId(entry) } : {}),
    ...(readControllerErrorPreview(entry) !== undefined ? { errorPreview: readControllerErrorPreview(entry) } : {}),
  };
}

function isControllerFailureSuperseded(
  laterEntries: EvidenceLedgerEntry[],
  failure: ActiveControllerFailure,
  activeArtifactTarget: string | undefined,
): boolean {
  const failureArtifactTarget = normalizeTargetValue(failure.artifactTarget) ?? activeArtifactTarget;
  const failureSourcePath = normalizeTargetValue(failure.sourcePath);
  for (const entry of laterEntries) {
    if (
      failureArtifactTarget !== undefined &&
      entry.status === "passed" &&
      isArtifactWriteEvidence(entry) &&
      normalizeTargetValue(readControllerArtifactTarget(entry)) === failureArtifactTarget
    ) {
      return true;
    }
    if (
      entry.kind === "helper_outcome" &&
      entry.status === "passed" &&
      asString(entry.facts.status) === "completed_done" &&
      (
        (failureArtifactTarget !== undefined &&
          normalizeTargetValue(readControllerArtifactTarget(entry)) === failureArtifactTarget) ||
        (failureSourcePath !== undefined &&
          normalizeTargetValue(readControllerSourcePath(entry)) === failureSourcePath)
      )
    ) {
      return true;
    }
    if (
      failureSourcePath !== undefined &&
      entry.kind === "process_result" &&
      entry.status === "passed" &&
      asString(entry.facts.toolName) === "dev.shell.run" &&
      normalizeTargetValue(readControllerSourcePath(entry)) === failureSourcePath
    ) {
      return true;
    }
  }
  return false;
}

function isArtifactWriteEvidence(entry: EvidenceLedgerEntry): boolean {
  const toolName = asString(entry.facts.toolName);
  if (
    toolName === "fs.replace_text" &&
    (entry.facts.changed === false ||
      (typeof entry.facts.replacements === "number" && Math.trunc(entry.facts.replacements) <= 0))
  ) {
    return false;
  }
  return toolName === "fs.write_text" ||
    toolName === "fs.replace_text" ||
    toolName === "fs.patch_text";
}

function readControllerCommand(entry: EvidenceLedgerEntry): string | undefined {
  return asString(entry.facts.command);
}

function readControllerSourcePath(entry: EvidenceLedgerEntry): string | undefined {
  return asString(entry.facts.sourcePath) ??
    entry.links?.sourcePath ??
    (entry.target?.type === "path" ? entry.target.value : undefined) ??
    inferSourcePath(readControllerCommand(entry));
}

function readControllerArtifactTarget(entry: EvidenceLedgerEntry): string | undefined {
  return asString(entry.facts.artifactTarget) ??
    asString(entry.facts.target) ??
    entry.links?.artifactTarget ??
    (entry.target?.type === "artifact" ? entry.target.value : undefined);
}

function readControllerProcessId(entry: EvidenceLedgerEntry): string | undefined {
  return asString(entry.facts.processId) ??
    entry.links?.processId ??
    (entry.target?.type === "process" ? entry.target.value : undefined);
}

function readControllerErrorPreview(entry: EvidenceLedgerEntry): string | undefined {
  return asString(entry.facts.errorPreview) ??
    asString(entry.facts.progressEvidence) ??
    entry.summary;
}

function inferSourcePath(command: string | undefined): string | undefined {
  if (command === undefined) {
    return undefined;
  }
  const runnerMatch = command.match(/(?:python3?|node|tsx|bash|sh)\s+([^\s;&|]+?\.(?:py|js|mjs|ts|sh))/u);
  if (runnerMatch?.[1] !== undefined) {
    return runnerMatch[1];
  }
  const directMatch = command.match(/(^|[\s;&|])((?:\.\/|\/)?[^\s;&|]+?\.(?:py|js|mjs|ts|sh))(?=$|[\s;&|])/u);
  return directMatch?.[2];
}

function parseLedgerKind(value: unknown): EvidenceLedgerKind | undefined {
  const kind = asString(value);
  if (kind === "observer_judgment") {
    // Compatibility parse for historical persisted ledgers; not an active kind.
    return "policy_correction";
  }
  if (kind === "file_mutation") {
    // Compatibility parse for historical persisted ledgers; file writes now use file_write.
    return "file_write";
  }
  return kind === "tool_result" ||
    kind === "file_listing" ||
    kind === "file_content" ||
    kind === "process_result" ||
    kind === "process_state" ||
    kind === "helper_outcome" ||
    kind === "helper_failure" ||
    kind === "helper_stall" ||
    kind === "file_write" ||
    kind === "artifact_verification" ||
    kind === "policy_correction"
    ? kind
    : undefined;
}

function parseLedgerStatus(value: unknown): EvidenceLedgerStatus | undefined {
  const status = asString(value);
  return status === "passed" ||
    status === "failed" ||
    status === "inconclusive" ||
    status === "running" ||
    status === "blocked"
    ? status
    : undefined;
}

function parseTarget(value: unknown): EvidenceLedgerEntry["target"] | undefined {
  const target = asRecord(value);
  const type = target?.type === "path" ||
    target?.type === "process" ||
    target?.type === "artifact" ||
    target?.type === "url" ||
    target?.type === "tool" ||
    target?.type === "workspace"
    ? target.type
    : undefined;
  const targetValue = asString(target?.value);
  if (type === undefined || targetValue === undefined) {
    return undefined;
  }
  return {
    type,
    value: targetValue,
    ...(asString(target?.normalizedValue) !== undefined
      ? { normalizedValue: asString(target?.normalizedValue) }
      : {}),
  };
}

function parseRaw(value: unknown): EvidenceLedgerEntry["raw"] | undefined {
  const raw = asRecord(value);
  if (raw === undefined) {
    return undefined;
  }
  const parsed = {
    ...(asString(raw.ref) !== undefined ? { ref: asString(raw.ref) } : {}),
    ...(typeof raw.bytes === "number" ? { bytes: Math.max(0, Math.trunc(raw.bytes)) } : {}),
    ...(asString(raw.hash) !== undefined ? { hash: asString(raw.hash) } : {}),
    ...(typeof raw.toolOutputTruncated === "boolean" ? { toolOutputTruncated: raw.toolOutputTruncated } : {}),
    ...(typeof raw.contextPreviewTruncated === "boolean" ? { contextPreviewTruncated: raw.contextPreviewTruncated } : {}),
    ...(typeof raw.contextPreviewBytes === "number"
      ? { contextPreviewBytes: Math.max(0, Math.trunc(raw.contextPreviewBytes)) }
      : {}),
  };
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseLinks(value: unknown): EvidenceLedgerEntry["links"] | undefined {
  const links = asRecord(value);
  if (links === undefined) {
    return undefined;
  }
  const parsed = {
    ...(asString(links.processId) !== undefined ? { processId: asString(links.processId) } : {}),
    ...(asString(links.sourcePath) !== undefined ? { sourcePath: asString(links.sourcePath) } : {}),
    ...(asString(links.artifactTarget) !== undefined ? { artifactTarget: asString(links.artifactTarget) } : {}),
    ...(asArray(links.priorEvidenceIds).length > 0
      ? {
          priorEvidenceIds: asArray(links.priorEvidenceIds)
            .map((item) => asString(item))
            .filter((item): item is string => item !== undefined),
        }
      : {}),
  };
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseNextUse(value: unknown): EvidenceLedgerEntry["nextUse"] | undefined {
  const nextUse = asRecord(value);
  if (nextUse === undefined) {
    return undefined;
  }
  const parsed = {
    ...(asString(nextUse.supports) !== undefined ? { supports: asString(nextUse.supports) } : {}),
    ...(asString(nextUse.blocks) !== undefined ? { blocks: asString(nextUse.blocks) } : {}),
    ...(asString(nextUse.requiresAction) !== undefined ? { requiresAction: asString(nextUse.requiresAction) } : {}),
    ...(typeof nextUse.invalidatesRepeat === "boolean" ? { invalidatesRepeat: nextUse.invalidatesRepeat } : {}),
  };
  return Object.keys(parsed).length > 0 ? parsed : undefined;
}

function parseClaimImpact(value: unknown): EvidenceClaimImpact | undefined {
  const root = asRecord(value);
  const success = root?.success === "blocks" ||
    root?.success === "supports" ||
    root?.success === "neutral"
    ? root.success
    : undefined;
  const scope = root?.scope === "artifact" ||
    root?.scope === "helper" ||
    root?.scope === "environment" ||
    root?.scope === "policy" ||
    root?.scope === "general"
    ? root.scope
    : undefined;
  const reason = asString(root?.reason)?.trim();
  if (success === undefined || scope === undefined || reason === undefined || reason.length === 0) {
    return undefined;
  }
  const requirementIds = asArray(root?.requirementIds)
    .map((item) => asString(item)?.trim())
    .filter((item): item is string => item !== undefined && item.length > 0)
    .sort();
  return {
    success,
    reason,
    scope,
    ...(asString(root?.target) !== undefined ? { target: asString(root?.target) } : {}),
    ...(requirementIds.length > 0 ? { requirementIds } : {}),
  };
}

function sanitizeRecord(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function stableEvidenceSalt(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function buildEvidenceCreatedAt(stepIndex?: number, output?: Record<string, unknown> | undefined): string {
  const outputTimestamp =
    asString(output?.completedAt) ??
    asString(output?.updatedAt) ??
    asString(output?.startedAt) ??
    asString(output?.submittedAt);
  if (outputTimestamp !== undefined) {
    return outputTimestamp;
  }
  const safeStep = typeof stepIndex === "number" && Number.isFinite(stepIndex)
    ? Math.max(0, Math.trunc(stepIndex))
    : 0;
  return new Date(safeStep * 1000).toISOString();
}

function normalizeTarget(value: string): string {
  return value.trim().replace(/\\/gu, "/").replace(/\/+/gu, "/").replace(/^\.\//u, "");
}

function buildEvidenceId(input: {
  kind: EvidenceLedgerKind;
  stepIndex?: number | undefined;
  salt: string;
}): string {
  const hash = createHash("sha256").update(`${input.kind}:${input.stepIndex ?? "x"}:${input.salt}`).digest("hex").slice(0, 12);
  return `ev_${input.stepIndex ?? "x"}_${hash}`;
}

function clamp(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 3))}...`;
}
