import { createHash } from "node:crypto";

import { buildFinalizePlainText } from "../../../../../cli/output/FinalizePayload.js";
import {
  clientSupportsGenerativeUi,
  getSupportedGenerativeUiBlocks,
  normalizeClientCapabilities,
} from "../../../../../src/clientCapabilities.js";
import { createRuntimeFailure } from "../../../../../src/runtime/RuntimeFailure.js";
import {
  sanitizeJsonValue,
  stringifySanitizedJson,
} from "../../../../../src/runtime/jsonSanitizer.js";
import {
  isDevShellLifecycleTool,
  normalizeDevShellLifecycle,
} from "../../../../../src/runtime/devshellLifecycle.js";
import { readActiveTaskGoalFromTranscript } from "../../../../../src/runtime/modelTranscript.js";
import { asArray, asRecord, asString } from "../../../../shared/valueAccess.js";
import {
  buildEvidenceCompletionSummary,
  parseEvidenceLedger,
  summarizeToolEvidenceLedger,
} from "../../evidenceLedger.js";
import { readLatestArtifactVerificationFacts } from "../../artifactVerificationFacts.js";

function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function summarizeText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

type ChatArtifactKind = "html" | "console";
type CodeExecutionStatus = "ok" | "error" | "timeout" | "blocked" | "runtime_unavailable";

interface ChatArtifactSource {
  type: "finalize" | "code.execute";
  toolName?: string;
}

interface BaseChatArtifact {
  id: string;
  kind: ChatArtifactKind;
  title?: string;
  source: ChatArtifactSource;
  sources?: ChatArtifactSource[];
}

interface HtmlChatArtifact extends BaseChatArtifact {
  kind: "html";
  trusted: true;
  html: string;
}

interface ConsoleChatArtifact extends BaseChatArtifact {
  kind: "console";
  status?: CodeExecutionStatus;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  text?: string;
  chunk?: string;
  chunkPreview?: string;
  truncated?: boolean;
  durationMs?: number;
  toolContext?: Record<string, unknown>;
}

type ChatArtifact = HtmlChatArtifact | ConsoleChatArtifact;

interface ManifestHtmlArtifact {
  kind: "html";
  id?: string;
  title?: string;
  html?: string;
  filePath?: string;
}

interface ManifestConsoleArtifact {
  kind: "console";
  id?: string;
  title?: string;
}

type ManifestArtifact = ManifestHtmlArtifact | ManifestConsoleArtifact;

interface PromoteArtifactsResult {
  artifacts: ChatArtifact[];
  manifestStatus: "none" | "parsed" | "invalid" | "missing";
}

const KCHAT_ARTIFACT_MANIFEST_PREFIX = "KCHAT_ARTIFACT_MANIFEST:";
const RUNTIME_UI_LINK_LIST_MAX_LINKS = 8;
const RUNTIME_UI_MAX_PREVIEWS_PER_RESULT_SET = 1;
const RUNTIME_UI_FETCH_EXCERPT_MAX_CHARS = 280;
const RUNTIME_UI_FS_SEARCH_MAX_LINES = 12;

interface ParsedKchatArtifactManifestResult {
  status: "none" | "parsed" | "invalid";
  artifacts: ManifestArtifact[];
}

export interface BuiltFinalizePayload {
  payload: {
    message: string;
    data: Record<string, unknown>;
  };
  telemetry: {
    manifestStatus: "none" | "parsed" | "invalid" | "missing";
    explicitCount: number;
    promotedCount: number;
    totalCount: number;
    inputCount: number;
    canonicalCount: number;
    duplicatesMerged: number;
    conflictCount: number;
  };
}

export function buildFinalizePayload(
  reactState: Record<string, unknown>,
  input: Record<string, unknown> | undefined,
): BuiltFinalizePayload {
  const inputRecord = asRecord(input) ?? {};
  const message = asString(inputRecord.message);
  if (message === undefined || message.trim().length === 0) {
    throw createFinalizeMessageRequiredError();
  }

  const explicitArtifacts = extractFinalizeArtifacts(inputRecord);
  const promotedCodeExecuteArtifacts = promoteCodeExecuteArtifacts(reactState.lastActionResult);
  const promotedDevShellArtifacts = promoteDevShellArtifacts(reactState.lastActionResult);
  const promotedCodeArtifacts = promotedCodeExecuteArtifacts.manifestStatus === "parsed"
    ? promotedCodeExecuteArtifacts.artifacts
    : [];
  const canonicalized = canonicalizeArtifacts(explicitArtifacts, [
    ...promotedCodeArtifacts,
    ...promotedDevShellArtifacts,
  ]);
  const mergedArtifacts = canonicalized.artifacts;

  const inputData = asRecord(inputRecord.data) ?? {};
  const inputUi = asRecord(inputData.ui) ?? {};
  const decisionVerification = asRecord(reactState.decisionVerification);
  const evidenceLedger = parseEvidenceLedger(reactState.evidenceLedger);
  const ledgerArtifactVerification = readLatestArtifactVerificationFromLedger(evidenceLedger);
  const toolEvidenceSummary = summarizeToolEvidenceLedger({
    ledger: evidenceLedger,
  });
  const runtimeEvidenceSummary = buildEvidenceCompletionSummary({
    ledger: evidenceLedger,
  });
  const finalizeLastActionResult = readFinalizeLastActionResult(reactState.lastActionResult);
  const runtimeSynthesizedBlocks = synthesizeRuntimeUiBlocks(reactState.lastActionResult);
  const inputBlocks = asArray(inputUi.blocks);
  const mergedBlocks = [...inputBlocks, ...runtimeSynthesizedBlocks];
  const mergedInputUi = mergedBlocks.length > 0
    ? {
        ...inputUi,
        blocks: mergedBlocks,
      }
    : inputUi;
  const clientCapabilities = normalizeClientCapabilities(
    asRecord(reactState.contextCache)?.clientCapabilities,
  );
  const sanitizedUi = sanitizeFinalizeUiForClient(mergedInputUi, clientCapabilities);
  const sanitizedFinalizeInput = sanitizeFinalizeInput(inputRecord);
  const {
    ui: _discardedUi,
    artifactVerification: _discardedInputArtifactVerification,
    changedFiles: _discardedFinalizeChangedFiles,
    checksRun: _discardedChecksRun,
    checksFailed: _discardedChecksFailed,
    ...inputDataRest
  } = inputData;
  const data: Record<string, unknown> = {
    ...inputDataRest,
    goal: readActiveTaskGoalFromTranscript(reactState.modelTranscript),
    plan: reactState.plan,
    ...(decisionVerification !== undefined ? { decisionVerification } : {}),
    ...(ledgerArtifactVerification !== undefined
      ? { artifactVerification: ledgerArtifactVerification }
      : {}),
    ...(toolEvidenceSummary !== undefined ? { toolEvidenceSummary } : {}),
    ...(runtimeEvidenceSummary.supportedTokens.length > 0 || runtimeEvidenceSummary.blockedTokens.length > 0
      ? {
          runtimeEvidenceSummary: {
            supportedTokens: runtimeEvidenceSummary.supportedTokens,
            blockedTokens: runtimeEvidenceSummary.blockedTokens,
          },
        }
      : {}),
    ...(finalizeLastActionResult !== undefined ? { lastActionResult: finalizeLastActionResult } : {}),
    finalizeInput: sanitizedFinalizeInput,
  };

  if (mergedArtifacts.length > 0) {
    data.ui = {
      ...sanitizedUi,
      artifacts: mergedArtifacts,
    };
  } else if (Object.keys(sanitizedUi).length > 0) {
    data.ui = sanitizedUi;
  }
  const plainText =
    buildFinalizePlainText(inputData);
  if (plainText !== undefined) {
    data.plainText = plainText;
  }
  return {
    payload: {
      message,
      data,
    },
    telemetry: {
      manifestStatus: promotedCodeExecuteArtifacts.manifestStatus,
      explicitCount: explicitArtifacts.length,
      promotedCount: promotedCodeExecuteArtifacts.artifacts.length + promotedDevShellArtifacts.length,
      totalCount: mergedArtifacts.length,
      inputCount: canonicalized.inputCount,
      canonicalCount: canonicalized.canonicalCount,
      duplicatesMerged: canonicalized.duplicatesMerged,
      conflictCount: canonicalized.conflictCount,
    },
  };
}

function readFinalizeLastActionResult(lastActionResult: unknown): unknown {
  const record = asRecord(lastActionResult);
  if (record?.kind === "validation_feedback") {
    return ;
  }
  return lastActionResult;
}

function sanitizeFinalizeInput(inputRecord: Record<string, unknown>): Record<string, unknown> {
  const {
    changedFiles: _discardedTopLevelChangedFiles,
    checksRun: _discardedTopLevelChecksRun,
    checksFailed: _discardedTopLevelChecksFailed,
    ...recordRest
  } = inputRecord;
  const inputData = asRecord(inputRecord.data);
  if (inputData === undefined) {
    return recordRest;
  }
  const {
    changedFiles: _discardedDataChangedFiles,
    checksRun: _discardedDataChecksRun,
    checksFailed: _discardedDataChecksFailed,
    ...dataRest
  } = inputData;
  return {
    ...recordRest,
    data: dataRest,
  };
}

function readLatestArtifactVerificationFromLedger(
  evidenceLedger: unknown,
): Record<string, unknown> | undefined {
  return readLatestArtifactVerificationFacts(evidenceLedger);
}

function sanitizeFinalizeUiForClient(
  ui: Record<string, unknown>,
  clientCapabilities: ReturnType<typeof normalizeClientCapabilities>,
): Record<string, unknown> {
  const nextUi = { ...ui };
  if (clientSupportsGenerativeUi(clientCapabilities) === false) {
    delete nextUi.blocks;
    return nextUi;
  }

  const supportedBlocks = new Set(getSupportedGenerativeUiBlocks(clientCapabilities));
  if (supportedBlocks.size === 0) {
    delete nextUi.blocks;
    return nextUi;
  }

  const blocks = asArray(ui.blocks).filter((block) => {
    const kind = asString(asRecord(block)?.kind);
    return kind !== undefined && supportedBlocks.has(kind as never);
  });

  if (blocks.length > 0) {
    nextUi.blocks = blocks;
  } else {
    delete nextUi.blocks;
  }

  return nextUi;
}

function synthesizeRuntimeUiBlocks(
  lastActionResult: unknown,
): Array<Record<string, unknown>> {
  const toolOutputs = readToolOutputsForRuntimeUi(lastActionResult);
  const synthesized: Array<Record<string, unknown>> = [];
  for (let index = 0; index < toolOutputs.length; index += 1) {
    const current = toolOutputs[index];
    if (current === undefined) {
      continue;
    }
    synthesized.push(...synthesizeRuntimeUiBlocksForToolOutput(current, index));
  }
  return synthesized;
}

function readToolOutputsForRuntimeUi(
  lastActionResult: unknown,
): Array<{ toolName: string; output: Record<string, unknown> }> {
  const record = asRecord(lastActionResult);
  if (record === undefined) {
    return [];
  }

  if (asString(record.kind) === "tool") {
    const toolName = asString(record.name);
    const output = asRecord(record.output);
    if (toolName === undefined || output === undefined) {
      return [];
    }
    return [{ toolName, output }];
  }

  if (asString(record.kind) !== "tool_batch") {
    return [];
  }

  const outputs: Array<{ toolName: string; output: Record<string, unknown> }> = [];
  for (const item of asArray(record.items)) {
    const parsedItem = asRecord(item);
    const toolName = asString(parsedItem?.name);
    const output = asRecord(parsedItem?.output);
    if (toolName !== undefined && output !== undefined) {
      outputs.push({ toolName, output });
    }
  }
  return outputs;
}

function synthesizeRuntimeUiBlocksForToolOutput(
  toolOutput: { toolName: string; output: Record<string, unknown> },
  toolOutputIndex: number,
): Array<Record<string, unknown>> {
  if (
    toolOutput.toolName === "internet.search" ||
    toolOutput.toolName === "internet.news" ||
    toolOutput.toolName === "internet.news" ||
    toolOutput.toolName === "source.search" ||
    toolOutput.toolName === "source.triage"
  ) {
    return synthesizeRuntimeUrlListBlocks(toolOutput, toolOutputIndex);
  }

  if (
    toolOutput.toolName === "internet.extract" ||
    toolOutput.toolName === "internet.extract" ||
    toolOutput.toolName === "source.fetch"
  ) {
    return synthesizeRuntimeFetchBlocks(toolOutput, toolOutputIndex);
  }

  if (toolOutput.toolName === "evidence.extract") {
    return synthesizeRuntimeEvidenceBlocks(toolOutput.output, toolOutputIndex);
  }

  if (toolOutput.toolName === "fs.search_text") {
    return synthesizeRuntimeFilesystemSearchBlocks(toolOutput.output, toolOutputIndex);
  }

  return [];
}

function synthesizeRuntimeUrlListBlocks(
  toolOutput: { toolName: string; output: Record<string, unknown> },
  toolOutputIndex: number,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const warning = readRuntimeToolWarning(toolOutput.output);
  if (warning.warn) {
    blocks.push({
      id: buildRuntimeUiBlockId(toolOutputIndex, "status"),
      kind: "status",
      title: "Source status",
      value: "warn",
      tone: "warn",
      ...(warning.detail !== undefined ? { detail: warning.detail } : {}),
    });
  }

  const links = readRuntimeLinkItems(toolOutput.toolName, toolOutput.output);
  if (links.length > 0) {
    blocks.push({
      id: buildRuntimeUiBlockId(toolOutputIndex, "link-list"),
      kind: "link_list",
      title: "Sources",
      links,
    });
  }

  return blocks;
}

function synthesizeRuntimeFetchBlocks(
  toolOutput: { toolName: string; output: Record<string, unknown> },
  toolOutputIndex: number,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const warning = readRuntimeToolWarning(toolOutput.output);
  const fetchStatus = warning.warn ? "warn" : "ok";
  blocks.push({
    id: buildRuntimeUiBlockId(toolOutputIndex, "status"),
    kind: "status",
    title: "Fetch status",
    value: fetchStatus,
    tone: fetchStatus === "warn" ? "warn" : "good",
    ...(warning.detail !== undefined ? { detail: warning.detail } : {}),
  });

  const normalizedUrl = normalizeRuntimeHttpUrl(asString(toolOutput.output.url));
  const title =
    asString(toolOutput.output.title)
    ?? (normalizedUrl !== undefined ? readRuntimeDomain(normalizedUrl) : undefined)
    ?? "Fetched content";
  const excerpt = readRuntimeFetchExcerpt(toolOutput.output);
  if (excerpt !== undefined) {
    blocks.push({
      id: buildRuntimeUiBlockId(toolOutputIndex, "summary"),
      kind: "summary",
      title,
      body: excerpt,
    });
  }

  if (normalizedUrl !== undefined && RUNTIME_UI_MAX_PREVIEWS_PER_RESULT_SET > 0) {
    blocks.push({
      id: buildRuntimeUiBlockId(toolOutputIndex, "web-preview"),
      kind: "web_preview",
      url: normalizedUrl,
      ...(asString(toolOutput.output.title) !== undefined ? { title: asString(toolOutput.output.title) } : {}),
      ...(excerpt !== undefined ? { summary: excerpt } : {}),
    });
  }

  return blocks;
}

function synthesizeRuntimeEvidenceBlocks(
  output: Record<string, unknown>,
  toolOutputIndex: number,
): Array<Record<string, unknown>> {
  const items = asArray(output.items)
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== undefined);
  const strengths = items
    .map((item) => asPositiveNumber(item.evidenceStrength))
    .filter((value): value is number => value !== undefined);
  const minStrength = strengths.length > 0 ? Math.min(...strengths) : 0;
  const maxStrength = strengths.length > 0 ? Math.max(...strengths) : 0;
  const claim = asString(output.claim);
  const sourceId = asString(output.sourceId);

  const summaryParts: string[] = [];
  if (claim !== undefined) {
    summaryParts.push(`Claim: ${summarizeText(normalizeRuntimeInlineText(claim), 180)}`);
  }
  if (sourceId !== undefined) {
    summaryParts.push(`Source: ${sourceId}`);
  }
  if (summaryParts.length === 0) {
    summaryParts.push("Claim/source context unavailable.");
  }

  return [
    {
      id: buildRuntimeUiBlockId(toolOutputIndex, "summary"),
      kind: "summary",
      title: "Evidence context",
      body: summaryParts.join(" | "),
    },
    {
      id: buildRuntimeUiBlockId(toolOutputIndex, "metrics"),
      kind: "metric_list",
      title: "Evidence metrics",
      metrics: [
        { label: "Extracted items", value: String(items.length) },
        { label: "Min strength", value: minStrength.toFixed(4) },
        { label: "Max strength", value: maxStrength.toFixed(4) },
      ],
    },
  ];
}

function synthesizeRuntimeFilesystemSearchBlocks(
  output: Record<string, unknown>,
  toolOutputIndex: number,
): Array<Record<string, unknown>> {
  const searchPath = asString(output.path) ?? "unknown";
  const query = asString(output.query) ?? "";
  const matches = asArray(output.matches)
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== undefined);
  const formattedLines = matches
    .slice(0, RUNTIME_UI_FS_SEARCH_MAX_LINES)
    .map((item) => formatRuntimeFsSearchMatch(searchPath, item))
    .filter((line): line is string => line !== undefined);

  const blocks: Array<Record<string, unknown>> = [
    {
      id: buildRuntimeUiBlockId(toolOutputIndex, "metrics"),
      kind: "metric_list",
      title: "Filesystem search",
      metrics: [
        { label: "Path", value: searchPath },
        { label: "Query", value: query.length > 0 ? query : "(empty)" },
        { label: "Match count", value: String(matches.length) },
      ],
    },
  ];

  if (formattedLines.length > 0) {
    blocks.push({
      id: buildRuntimeUiBlockId(toolOutputIndex, "code-preview"),
      kind: "code_preview",
      title: "Matches",
      filename: searchPath,
      language: "text",
      code: formattedLines.join("\n"),
    });
  }

  return blocks;
}

function readRuntimeLinkItems(
  toolName: string,
  output: Record<string, unknown>,
): Array<{ label: string; url: string; description?: string }> {
  const records = readRuntimeLinkRecords(toolName, output);
  const links: Array<{ label: string; url: string; description?: string }> = [];
  for (const record of records) {
    const normalizedUrl = normalizeRuntimeHttpUrl(asString(record.url) ?? asString(record.href));
    if (normalizedUrl === undefined) {
      continue;
    }
    const label = asString(record.title) ?? readRuntimeDomain(normalizedUrl) ?? normalizedUrl;
    const description =
      asString(record.snippet)
      ?? asString(record.description)
      ?? asString(record.source)
      ?? asString(record.sourceType)
      ?? asString(record.publishedAt);
    links.push({
      label,
      url: normalizedUrl,
      ...(description !== undefined ? { description: normalizeRuntimeInlineText(description) } : {}),
    });
    if (links.length >= RUNTIME_UI_LINK_LIST_MAX_LINKS) {
      break;
    }
  }
  return links;
}

function readRuntimeLinkRecords(
  toolName: string,
  output: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const sourceValue = toolName === "source.triage"
    ? output.sources
    : (Array.isArray(output.results) ? output.results : output.highlights);
  return asArray(sourceValue)
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== undefined);
}

function readRuntimeFetchExcerpt(output: Record<string, unknown>): string | undefined {
  const content = asString(output.content) ?? asString(output.contentPreview);
  if (content === undefined) {
    return ;
  }
  const normalized = normalizeRuntimeInlineText(content);
  if (normalized.length === 0) {
    return ;
  }
  return summarizeText(normalized, RUNTIME_UI_FETCH_EXCERPT_MAX_CHARS);
}

function readRuntimeToolWarning(
  output: Record<string, unknown>,
): { warn: boolean; detail?: string } {
  const details: string[] = [];
  const status = asString(output.status);
  if (status !== undefined && status !== "ok") {
    details.push(`status=${status}`);
  }

  const quality = asString(output.quality);
  if (quality !== undefined) {
    const normalizedQuality = quality.trim().toLowerCase();
    if (
      normalizedQuality !== "ok" &&
      normalizedQuality !== "high" &&
      normalizedQuality !== "medium"
    ) {
      details.push(`quality=${quality}`);
    }
  }

  if (output.truncated === true) {
    details.push("truncated=true");
  }

  const degraded = asRecord(output.degraded);
  if (degraded !== undefined) {
    const code = asString(degraded.code);
    const message = asString(degraded.message);
    if (code !== undefined) {
      details.push(`degraded=${code}`);
    }
    if (message !== undefined) {
      details.push(summarizeText(normalizeRuntimeInlineText(message), 140));
    }
  }

  const error = asRecord(output.error);
  if (error !== undefined) {
    const code = asString(error.code);
    const message = asString(error.message);
    const errorStatus = asPositiveNumber(error.status);
    if (code !== undefined) {
      details.push(`error=${code}`);
    }
    if (errorStatus !== undefined) {
      details.push(`http=${errorStatus}`);
    }
    if (message !== undefined) {
      details.push(summarizeText(normalizeRuntimeInlineText(message), 140));
    }
  }

  return details.length > 0
    ? { warn: true, detail: details.join("; ") }
    : { warn: false };
}

function normalizeRuntimeHttpUrl(value: string | undefined): string | undefined {
  if (value === undefined) {
    return ;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return ;
  }
  const href = trimmed.startsWith("http://") || trimmed.startsWith("https://")
    ? trimmed
    : `https://${trimmed}`;
  try {
    const parsed = new URL(href);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return ;
    }
    return parsed.href;
  } catch {
    return ;
  }
}

function readRuntimeDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./u, "");
  } catch {
    return url;
  }
}

function normalizeRuntimeInlineText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function buildRuntimeUiBlockId(toolOutputIndex: number, suffix: string): string {
  return `runtime-ui-${toolOutputIndex + 1}-${suffix}`;
}

function formatRuntimeFsSearchMatch(
  defaultPath: string,
  match: Record<string, unknown>,
): string | undefined {
  const path = asString(match.path) ?? defaultPath;
  const line = asPositiveNumber(match.line) ?? 1;
  const column = asPositiveNumber(match.column) ?? 1;
  const previewRaw = asString(match.preview) ?? "";
  const preview = normalizeRuntimeInlineText(previewRaw);
  if (path.trim().length === 0) {
    return ;
  }
  return `${path}:${Math.max(1, Math.trunc(line))}:${Math.max(1, Math.trunc(column))} | ${preview.length > 0 ? preview : "<no preview>"}`;
}

function extractFinalizeArtifacts(inputRecord: Record<string, unknown>): ChatArtifact[] {
  const data = asRecord(inputRecord.data);
  const ui = asRecord(data?.ui);
  const artifacts = asArray(ui?.artifacts);
  const parsed: ChatArtifact[] = [];

  for (let index = 0; index < artifacts.length; index += 1) {
    const artifact = parseChatArtifact(artifacts[index], index, {
      type: "finalize",
    });
    if (artifact !== undefined) {
      parsed.push(artifact);
    }
  }

  return parsed;
}

function promoteCodeExecuteArtifacts(lastActionResult: unknown): PromoteArtifactsResult {
  const codeResult = readCodeExecutionResult(lastActionResult);
  if (codeResult === undefined) {
    return {
      artifacts: [],
      manifestStatus: "none",
    };
  }

  const manifest = parseKchatArtifactManifest(codeResult.stdout);
  if (manifest.status === "parsed") {
    return {
      artifacts: buildArtifactsFromManifest(manifest.artifacts, codeResult),
      manifestStatus: "parsed",
    };
  }
  if (manifest.status === "invalid") {
    return {
      artifacts: [],
      manifestStatus: "invalid",
    };
  }

  return {
    artifacts: [],
    manifestStatus: hasPromotableCodeExecutionArtifacts(codeResult) ? "missing" : "none",
  };
}

function promoteDevShellArtifacts(lastActionResult: unknown): ChatArtifact[] {
  const candidate = readLatestSettledDevShellArtifactCandidate(lastActionResult);
  if (candidate === undefined) {
    return [];
  }
  const artifact = buildConsoleArtifactFromDevShellResult(candidate);
  return artifact === undefined ? [] : [artifact];
}

function readLatestSettledDevShellArtifactCandidate(
  lastActionResult: unknown,
): { toolName: string; output: Record<string, unknown> } | undefined {
  const record = asRecord(lastActionResult);
  if (record === undefined) {
    return ;
  }

  if (asString(record.kind) === "tool") {
    const toolName = asString(record.name);
    const output = asRecord(record.output);
    if (
      toolName !== undefined &&
      output !== undefined &&
      isPromotableDevShellConsoleTool(toolName) &&
      isSettledDevShellOutput(toolName, output)
    ) {
      return { toolName, output };
    }
    return ;
  }

  if (asString(record.kind) !== "tool_batch") {
    return ;
  }

  const items = asArray(record.items);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = asRecord(items[index]);
    const toolName = asString(item?.name);
    const output = asRecord(item?.output);
    if (
      toolName !== undefined &&
      output !== undefined &&
      isPromotableDevShellConsoleTool(toolName) &&
      isSettledDevShellOutput(toolName, output)
    ) {
      return { toolName, output };
    }
  }

  return ;
}

function isPromotableDevShellConsoleTool(toolName: string): boolean {
  return isDevShellLifecycleTool(toolName);
}

function isSettledDevShellOutput(toolName: string, output: Record<string, unknown>): boolean {
  const completion = readDevShellCompletionMarker(output);
  if (completion !== undefined) {
    return true;
  }
  const status = normalizeDevShellLifecycle(toolName, undefined, output)?.status ?? asString(output.status);
  return status === "COMPLETED" || status === "FAILED" || status === "STOPPED" || status === "LOST";
}

function buildConsoleArtifactFromDevShellResult(input: {
  toolName: string;
  output: Record<string, unknown>;
}): ConsoleChatArtifact | undefined {
  const completion = readDevShellCompletionMarker(input.output);
  const lifecycle = normalizeDevShellLifecycle(input.toolName, undefined, input.output);
  const processId =
    lifecycle?.processId ??
    asString(input.output.processId) ??
    asString(input.output.sessionId) ??
    asString(input.output.completionProcessId) ??
    completion?.processId;
  const exitCode =
    completion?.exitCode ??
    asPositiveNumber(input.output.completionExitCode) ??
    asPositiveNumber(input.output.completedExitCode) ??
    asPositiveNumber(input.output.exitCode) ??
    asPositiveNumber(input.output.lastExitCode);
  const consoleOutput = readDevShellConsoleOutput(input.output);
  if (consoleOutput.stdout === undefined && consoleOutput.stderr === undefined && exitCode === undefined) {
    return ;
  }
  const status = normalizeDevShellConsoleStatus(exitCode);
  const text = readCleanedDevShellOutputText(input.output.text ?? input.output.output);
  const chunk = readCleanedDevShellOutputText(input.output.chunk);
  const chunkPreview = readCleanedDevShellOutputText(input.output.chunkPreview);
  const durationMs = asPositiveNumber(input.output.durationMs);
  const toolContext = buildDevShellToolContext(input.output, processId);

  return {
    id: processId !== undefined ? `dev-shell-console-${processId}` : "dev-shell-console",
    kind: "console",
    title: "Dev Shell Output",
    source: {
      type: "finalize",
      toolName: input.toolName,
    },
    ...(status !== undefined ? { status } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(consoleOutput.stdout !== undefined ? { stdout: consoleOutput.stdout } : {}),
    ...(consoleOutput.stderr !== undefined ? { stderr: consoleOutput.stderr } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(chunk !== undefined ? { chunk } : {}),
    ...(chunkPreview !== undefined ? { chunkPreview } : {}),
    ...(input.output.truncated === true ? { truncated: true } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(toolContext !== undefined ? { toolContext } : {}),
  };
}

const DEV_SHELL_TOOL_CONTEXT_FIELDS = [
  "processId",
  "sessionId",
  "status",
  "exitCode",
  "completionExitCode",
  "completedExitCode",
  "lastExitCode",
  "cursor",
  "nextCursor",
  "bytesWritten",
  "command",
  "cwd",
  "workspaceRoot",
  "submittedAt",
  "startedAt",
  "updatedAt",
  "completedAt",
  "durationMs",
  "securityMode",
  "failureReason",
  "truncated",
  "preflight",
  "sourceWriteGuard",
  "unauthorizedSourceWrites",
] as const;

function buildDevShellToolContext(
  output: Record<string, unknown>,
  processId: string | undefined,
): Record<string, unknown> | undefined {
  const context: Record<string, unknown> = {};
  if (processId !== undefined) {
    context.processId = processId;
  }
  for (const field of DEV_SHELL_TOOL_CONTEXT_FIELDS) {
    const value = output[field];
    if (value !== undefined) {
      context[field] = sanitizeJsonValue(value);
    }
  }
  return Object.keys(context).length > 0 ? context : undefined;
}

function readDevShellConsoleOutput(output: Record<string, unknown>): {
  stdout?: string | undefined;
  stderr?: string | undefined;
} {
  const explicitStdout = readCleanedDevShellOutputText(output.stdout);
  const explicitStderr = readCleanedDevShellOutputText(output.stderr);
  if (explicitStdout !== undefined || explicitStderr !== undefined) {
    return {
      ...(explicitStdout !== undefined ? { stdout: explicitStdout } : {}),
      ...(explicitStderr !== undefined ? { stderr: explicitStderr } : {}),
    };
  }

  return {
    stdout:
      readCleanedDevShellOutputText(output.text) ??
      readCleanedDevShellOutputText(output.output) ??
      readCleanedDevShellOutputText(output.chunk) ??
      readCleanedDevShellOutputText(output.chunkPreview),
  };
}

function readCleanedDevShellOutputText(value: unknown): string | undefined {
  const raw = asString(value);
  if (raw === undefined) {
    return ;
  }
  const cleaned = stripDevShellCompletionMarkers(raw);
  return cleaned.length > 0 ? cleaned : undefined;
}

function stripDevShellCompletionMarkers(value: string): string {
  const cleaned = value
    .split(/\r?\n/u)
    .filter((line) => /^__KESTREL_CMD_DONE__:([^:\s]+):(-?\d+)$/u.test(line.trim()) === false)
    .join("\n")
    .trimEnd();
  return cleaned;
}

function readDevShellCompletionMarker(
  output: Record<string, unknown> | undefined,
): { processId?: string | undefined; exitCode?: number | undefined } | undefined {
  const completionProcessId = asString(output?.completionProcessId);
  const completionExitCode =
    typeof output?.completionExitCode === "number" && Number.isFinite(output.completionExitCode)
      ? Math.trunc(output.completionExitCode)
      : undefined;
  if (completionProcessId !== undefined || completionExitCode !== undefined) {
    return {
      ...(completionProcessId !== undefined ? { processId: completionProcessId } : {}),
      ...(completionExitCode !== undefined ? { exitCode: completionExitCode } : {}),
    };
  }
  const text = asString(output?.text) ?? asString(output?.output) ?? asString(output?.chunk) ?? asString(output?.chunkPreview);
  if (text === undefined || text.length === 0) {
    return ;
  }
  const matches = [...text.matchAll(/__KESTREL_CMD_DONE__:([^:\s]+):(-?\d+)/g)];
  if (matches.length === 0) {
    return ;
  }
  const marker = matches[matches.length - 1];
  if (marker === undefined) {
    return ;
  }
  const processId = typeof marker[1] === "string" ? marker[1] : undefined;
  const parsedExitCode =
    typeof marker[2] === "string" ? Number.parseInt(marker[2], 10) : Number.NaN;
  const exitCode = Number.isFinite(parsedExitCode) ? Math.trunc(parsedExitCode) : undefined;
  if (processId === undefined && exitCode === undefined) {
    return ;
  }
  return {
    ...(processId !== undefined ? { processId } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}

function normalizeDevShellConsoleStatus(
  exitCode: number | undefined,
): CodeExecutionStatus | undefined {
  if (exitCode === undefined) {
    return ;
  }
  return exitCode === 0 ? "ok" : "error";
}

function hasPromotableCodeExecutionArtifacts(codeResult: {
  artifacts: Record<string, unknown>[];
}): boolean {
  return codeResult.artifacts.length > 0;
}

function readCodeExecutionResult(
  value: unknown,
): {
  status?: CodeExecutionStatus;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
  artifacts: Record<string, unknown>[];
} | undefined {
  const lastAction = asRecord(value);
  if (asString(lastAction?.kind) !== "tool" || asString(lastAction?.name) !== "code.execute") {
    return ;
  }

  const output = asRecord(lastAction?.output);
  if (output === undefined) {
    return ;
  }

  const status = asCodeExecutionStatus(output.status);
  const exitCodeRaw = output.exitCode;
  const stdout = asString(output.stdout);
  const stderr = asString(output.stderr);
  const exitCode =
    typeof exitCodeRaw === "number"
      ? exitCodeRaw
      : exitCodeRaw === null
        ? null
        : undefined;
  const durationMs = typeof output.durationMs === "number" ? output.durationMs : undefined;
  const artifacts = asArray(output.artifacts)
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== undefined);

  return {
    ...(status !== undefined ? { status } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(stdout !== undefined ? { stdout } : {}),
    ...(stderr !== undefined ? { stderr } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    artifacts,
  };
}

function asCodeExecutionStatus(value: unknown): CodeExecutionStatus | undefined {
  if (
    value === "ok" ||
    value === "error" ||
    value === "timeout" ||
    value === "blocked" ||
    value === "runtime_unavailable"
  ) {
    return value;
  }
  return ;
}

function parseKchatArtifactManifest(stdout: string | undefined): ParsedKchatArtifactManifestResult {
  if (stdout === undefined || stdout.trim().length === 0) {
    return {
      status: "none",
      artifacts: [],
    };
  }

  const lines = stdout.split(/\r?\n/u);
  let sawManifestLine = false;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line?.startsWith(KCHAT_ARTIFACT_MANIFEST_PREFIX) !== true) {
      continue;
    }
    sawManifestLine = true;

    const rawJson = line.slice(KCHAT_ARTIFACT_MANIFEST_PREFIX.length).trim();
    if (rawJson.length === 0) {
      continue;
    }

    try {
      const parsed = JSON.parse(rawJson);
      const root = asRecord(parsed);
      if (asString(root?.version) !== "v1") {
        continue;
      }

      const manifestArtifacts = asArray(root?.artifacts);
      if (manifestArtifacts.length === 0) {
        return {
          status: "parsed",
          artifacts: [],
        };
      }

      const parsedArtifacts = manifestArtifacts.map((item) => parseManifestArtifact(item));
      if (parsedArtifacts.some((item) => item === undefined)) {
        continue;
      }
      return {
        status: "parsed",
        artifacts: parsedArtifacts as ManifestArtifact[],
      };
    } catch {
    }
  }

  return {
    status: sawManifestLine ? "invalid" : "none",
    artifacts: [],
  };
}

function parseManifestArtifact(value: unknown): ManifestArtifact | undefined {
  const artifact = asRecord(value);
  const kind = asString(artifact?.kind);
  if (kind === "console") {
    const id = asString(artifact?.id);
    const title = asString(artifact?.title);
    return {
      kind: "console",
      ...(id !== undefined ? { id } : {}),
      ...(title !== undefined ? { title } : {}),
    };
  }

  if (kind === "html") {
    const id = asString(artifact?.id);
    const title = asString(artifact?.title);
    const html = asString(artifact?.html);
    const filePath = asString(artifact?.filePath);
    return {
      kind: "html",
      ...(id !== undefined ? { id } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(html !== undefined ? { html } : {}),
      ...(filePath !== undefined ? { filePath } : {}),
    };
  }

  return ;
}

function buildArtifactsFromManifest(
  manifestArtifacts: ManifestArtifact[],
  codeResult: {
    status?: CodeExecutionStatus;
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
    durationMs?: number;
    artifacts: Record<string, unknown>[];
  },
): ChatArtifact[] {
  const parsed: ChatArtifact[] = [];

  for (const [index, item] of manifestArtifacts.entries()) {
    if (item.kind === "console") {
      parsed.push(
        buildConsoleArtifactFromCodeResult(codeResult, {
          ...(item.id !== undefined ? { id: item.id } : {}),
          ...(item.title !== undefined ? { title: item.title } : {}),
        }),
      );
      continue;
    }

    const html = item.html ?? resolveHtmlFromExecutionArtifact(codeResult.artifacts, item.filePath);
    if (html === undefined) {
      continue;
    }

    parsed.push({
      id: item.id ?? `code-html-${index + 1}`,
      kind: "html",
      ...(item.title !== undefined ? { title: item.title } : {}),
      source: {
        type: "code.execute",
        toolName: "code.execute",
      },
      trusted: true,
      html,
    });
  }

  return parsed;
}

function resolveHtmlFromExecutionArtifact(
  artifacts: Record<string, unknown>[],
  filePath: string | undefined,
): string | undefined {
  if (filePath === undefined || filePath.trim().length === 0) {
    return ;
  }

  const match = artifacts.find((artifact) => asString(artifact.path) === filePath);
  const preview = asRecord(match?.preview);
  const text = asString(preview?.text);
  const truncated = preview?.truncated === true;
  if (text === undefined || truncated) {
    return ;
  }
  return text;
}

function buildConsoleArtifactFromCodeResult(
  codeResult: {
    status?: CodeExecutionStatus;
    exitCode?: number | null;
    stdout?: string;
    stderr?: string;
    durationMs?: number;
  },
  overrides: {
    id?: string;
    title?: string;
  } = {},
): ConsoleChatArtifact {
  return {
    id: overrides.id ?? "code-console",
    kind: "console",
    ...(overrides.title !== undefined ? { title: overrides.title } : { title: "Execution Output" }),
    source: {
      type: "code.execute",
      toolName: "code.execute",
    },
    ...(codeResult.status !== undefined ? { status: codeResult.status } : {}),
    ...(codeResult.exitCode !== undefined ? { exitCode: codeResult.exitCode } : {}),
    ...(codeResult.stdout !== undefined ? { stdout: codeResult.stdout } : {}),
    ...(codeResult.stderr !== undefined ? { stderr: codeResult.stderr } : {}),
    ...(codeResult.durationMs !== undefined ? { durationMs: codeResult.durationMs } : {}),
  };
}

function parseChatArtifact(
  value: unknown,
  index: number,
  defaultSource: ChatArtifactSource,
): ChatArtifact | undefined {
  const artifact = asRecord(value);
  if (artifact === undefined) {
    return ;
  }

  const kind = asString(artifact.kind);
  const source = parseArtifactSource(artifact.source) ?? defaultSource;
  const sources = parseArtifactSources(artifact.sources);
  const id = asString(artifact.id) ?? `artifact-${index + 1}`;
  const title = asString(artifact.title);

  if (kind === "html") {
    const html = asString(artifact.html);
    if (html === undefined || html.trim().length === 0) {
      return ;
    }
    return {
      id,
      kind,
      ...(title !== undefined ? { title } : {}),
      source,
      ...(sources.length > 0 ? { sources } : {}),
      trusted: true,
      html,
    };
  }

  if (kind === "console") {
    const status = asCodeExecutionStatus(artifact.status);
    const stdout = asString(artifact.stdout);
    const stderr = asString(artifact.stderr);
    const text = asString(artifact.text);
    const chunk = asString(artifact.chunk);
    const chunkPreview = asString(artifact.chunkPreview);
    const toolContext = asRecord(artifact.toolContext);
    return {
      id,
      kind,
      ...(title !== undefined ? { title } : {}),
      source,
      ...(sources.length > 0 ? { sources } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(typeof artifact.exitCode === "number" || artifact.exitCode === null
        ? { exitCode: artifact.exitCode as number | null }
        : {}),
      ...(stdout !== undefined ? { stdout } : {}),
      ...(stderr !== undefined ? { stderr } : {}),
      ...(text !== undefined ? { text } : {}),
      ...(chunk !== undefined ? { chunk } : {}),
      ...(chunkPreview !== undefined ? { chunkPreview } : {}),
      ...(artifact.truncated === true ? { truncated: true } : {}),
      ...(typeof artifact.durationMs === "number" ? { durationMs: artifact.durationMs } : {}),
      ...(toolContext !== undefined ? { toolContext: sanitizeJsonValue(toolContext) } : {}),
    };
  }

  return ;
}

function parseArtifactSource(value: unknown): ChatArtifactSource | undefined {
  const source = asRecord(value);
  const type = asString(source?.type);
  if (type !== "finalize" && type !== "code.execute") {
    return ;
  }
  const toolName = asString(source?.toolName);
  return {
    type,
    ...(toolName !== undefined ? { toolName } : {}),
  };
}

function parseArtifactSources(value: unknown): ChatArtifactSource[] {
  if (Array.isArray(value) === false) {
    return [];
  }
  return value
    .map((item) => parseArtifactSource(item))
    .filter((item): item is ChatArtifactSource => item !== undefined);
}

interface CanonicalizedArtifactsResult {
  artifacts: ChatArtifact[];
  inputCount: number;
  canonicalCount: number;
  duplicatesMerged: number;
  conflictCount: number;
}

function canonicalizeArtifacts(
  explicitArtifacts: ChatArtifact[],
  promotedArtifacts: ChatArtifact[],
): CanonicalizedArtifactsResult {
  const inputCount = explicitArtifacts.length + promotedArtifacts.length;
  const indexByFingerprint = new Map<string, number>();
  const canonical: Array<{
    artifact: ChatArtifact;
    hasExplicitPayload: boolean;
  }> = [];
  let duplicatesMerged = 0;
  let conflictCount = 0;

  const entries: Array<{ artifact: ChatArtifact; origin: "explicit" | "promoted" }> = [
    ...explicitArtifacts.map((artifact) => ({ artifact, origin: "explicit" as const })),
    ...promotedArtifacts.map((artifact) => ({ artifact, origin: "promoted" as const })),
  ];

  for (const entry of entries) {
    const fingerprint = buildArtifactFingerprint(entry.artifact);
    const existingIndex = indexByFingerprint.get(fingerprint);
    if (existingIndex === undefined) {
      const normalized = normalizeArtifactSources(entry.artifact);
      canonical.push({
        artifact: normalized,
        hasExplicitPayload: entry.origin === "explicit",
      });
      indexByFingerprint.set(fingerprint, canonical.length - 1);
      continue;
    }

    duplicatesMerged += 1;
    const existing = canonical[existingIndex]!;
    const incoming = normalizeArtifactSources(entry.artifact);
    const mergedSources = mergeArtifactSources(existing.artifact, incoming);
    const hasConflict = artifactsPayloadEqual(existing.artifact, incoming) === false;
    if (hasConflict) {
      conflictCount += 1;
    }
    const shouldReplacePayload = entry.origin === "explicit" && existing.hasExplicitPayload === false;
    const baseArtifact = mergeDuplicateArtifactPayload(
      shouldReplacePayload ? incoming : existing.artifact,
      shouldReplacePayload ? existing.artifact : incoming,
    );
    const preferredSource = selectPrimarySource(
      mergedSources,
      shouldReplacePayload ? incoming.source : existing.artifact.source,
    );
    canonical[existingIndex] = {
      artifact: {
        ...baseArtifact,
        source: preferredSource,
        ...(mergedSources.length > 1 ? { sources: mergedSources } : {}),
      },
      hasExplicitPayload: existing.hasExplicitPayload || entry.origin === "explicit",
    };
  }

  return {
    artifacts: canonical.map((entry) => entry.artifact),
    inputCount,
    canonicalCount: canonical.length,
    duplicatesMerged,
    conflictCount,
  };
}

function mergeDuplicateArtifactPayload(primary: ChatArtifact, secondary: ChatArtifact): ChatArtifact {
  if (primary.kind !== "console" || secondary.kind !== "console") {
    return primary;
  }
  return {
    ...primary,
    ...(primary.status === undefined && secondary.status !== undefined ? { status: secondary.status } : {}),
    ...(primary.exitCode === undefined && secondary.exitCode !== undefined ? { exitCode: secondary.exitCode } : {}),
    ...(primary.stdout === undefined && secondary.stdout !== undefined ? { stdout: secondary.stdout } : {}),
    ...(primary.stderr === undefined && secondary.stderr !== undefined ? { stderr: secondary.stderr } : {}),
    ...(primary.text === undefined && secondary.text !== undefined ? { text: secondary.text } : {}),
    ...(primary.chunk === undefined && secondary.chunk !== undefined ? { chunk: secondary.chunk } : {}),
    ...(primary.chunkPreview === undefined && secondary.chunkPreview !== undefined
      ? { chunkPreview: secondary.chunkPreview }
      : {}),
    ...(primary.truncated === undefined && secondary.truncated !== undefined ? { truncated: secondary.truncated } : {}),
    ...(primary.durationMs === undefined && secondary.durationMs !== undefined ? { durationMs: secondary.durationMs } : {}),
    ...(primary.toolContext === undefined && secondary.toolContext !== undefined
      ? { toolContext: secondary.toolContext }
      : {}),
  };
}

function normalizeArtifactSources(artifact: ChatArtifact): ChatArtifact {
  const sources = mergeSources(
    [artifact.source],
    Array.isArray(artifact.sources) ? artifact.sources : [],
  );
  return {
    ...artifact,
    source: selectPrimarySource(sources, artifact.source),
    ...(sources.length > 1 ? { sources } : {}),
  };
}

function mergeArtifactSources(existing: ChatArtifact, incoming: ChatArtifact): ChatArtifactSource[] {
  return mergeSources(
    collectArtifactSources(existing),
    collectArtifactSources(incoming),
  );
}

function collectArtifactSources(artifact: ChatArtifact): ChatArtifactSource[] {
  const declared = Array.isArray(artifact.sources) ? artifact.sources : [];
  return mergeSources([artifact.source], declared);
}

function mergeSources(primary: ChatArtifactSource[], secondary: ChatArtifactSource[]): ChatArtifactSource[] {
  const merged: ChatArtifactSource[] = [];
  const seen = new Set<string>();
  for (const source of [...primary, ...secondary]) {
    const key = `${source.type}:${source.toolName ?? ""}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push(source);
  }
  return merged;
}

function selectPrimarySource(
  sources: ChatArtifactSource[],
  fallback: ChatArtifactSource,
): ChatArtifactSource {
  return sources.find((source) => source.type === "finalize") ?? sources[0] ?? fallback;
}

function buildArtifactFingerprint(artifact: ChatArtifact): string {
  const normalizedId = artifact.id.trim().toLowerCase();
  if (normalizedId.length > 0) {
    return `${artifact.kind}:id:${normalizedId}`;
  }
  if (artifact.kind === "html") {
    const title = normalizeWhitespace(artifact.title ?? "");
    const body = normalizeWhitespace(artifact.html);
    return `${artifact.kind}:hash:${title}:${hashString(body)}`;
  }
  const signature = stringifySanitizedJson({
    title: normalizeWhitespace(artifact.title ?? ""),
    status: artifact.status ?? null,
    exitCode: artifact.exitCode ?? null,
    stdout: artifact.stdout ?? "",
    stderr: artifact.stderr ?? "",
    durationMs: artifact.durationMs ?? null,
  });
  return `${artifact.kind}:hash:${hashString(signature)}`;
}

function artifactsPayloadEqual(left: ChatArtifact, right: ChatArtifact): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "html" && right.kind === "html") {
    return (
      normalizeWhitespace(left.title ?? "") === normalizeWhitespace(right.title ?? "") &&
      normalizeWhitespace(left.html) === normalizeWhitespace(right.html)
    );
  }
  const leftConsole = left as ConsoleChatArtifact;
  const rightConsole = right as ConsoleChatArtifact;
  return (
    normalizeWhitespace(leftConsole.title ?? "") === normalizeWhitespace(rightConsole.title ?? "") &&
    (leftConsole.status ?? null) === (rightConsole.status ?? null) &&
    (leftConsole.exitCode ?? null) === (rightConsole.exitCode ?? null) &&
    (leftConsole.durationMs ?? null) === (rightConsole.durationMs ?? null) &&
    (leftConsole.stdout ?? "") === (rightConsole.stdout ?? "") &&
    (leftConsole.stderr ?? "") === (rightConsole.stderr ?? "") &&
    (leftConsole.text ?? "") === (rightConsole.text ?? "") &&
    (leftConsole.chunk ?? "") === (rightConsole.chunk ?? "") &&
    (leftConsole.chunkPreview ?? "") === (rightConsole.chunkPreview ?? "") &&
    (leftConsole.truncated ?? false) === (rightConsole.truncated ?? false) &&
    stringifySanitizedJson(leftConsole.toolContext ?? {}) === stringifySanitizedJson(rightConsole.toolContext ?? {})
  );
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createFinalizeMessageRequiredError(): Error {
  return createRuntimeFailure(
    "AGENT_FINALIZE_MESSAGE_REQUIRED",
    "Finalize action requires input.message. agent.loop must provide a user-facing finalize message.",
    {
      subsystem: "react",
      step: "agent.exec.finalize",
      classification: "schema",
      recoverable: true,
      requiredField: "state.agent.nextAction.input.message",
    },
  );
}
