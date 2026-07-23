import type { ArtifactIntent } from "../../../../../src/kestrel/contracts/execution.js";

import { updateEvidenceRecoverySummary } from "../../../../../src/runtime/evidenceQuality.js";
import {
  detectReadOnlyResultDuplicate,
  type ReadOnlyResultDuplicateVerdict,
} from "../../../../../src/runtime/readOnlyResultDuplicates.js";
import {
  normalizeSourceCluster,
  readWebExtractionDiagnostics,
  type WebExtractionRetrySummary,
  normalizeWebExtractionRetrySummary,
  updateWebExtractionRetrySummary,
} from "../../../../../src/runtime/webExtraction.js";
import {
  sanitizeJsonValue,
  sanitizeUtf16String,
  stringifySanitizedJson,
} from "../../../../../src/runtime/jsonSanitizer.js";
import {
  isDevShellLifecycleTool,
  normalizeDevShellLifecycle,
} from "../../../../../src/runtime/devshellLifecycle.js";
import { readActiveTaskGoalFromTranscript } from "../../../../../src/runtime/modelTranscript.js";
import { asArray, asRecord, asString } from "../../../../shared/valueAccess.js";
import type { ReadOnlyResultDuplicateLedgerEntry } from "../../types.js";

type DevShellCommandLifecycle =
  | "active_streaming"
  | "settled_nonterminal"
  | "settled_terminal";

export type CapabilityEvidenceSnapshot = Record<string, { tool: string; stepIndex: number; ts: string }>;

const MAX_STORED_TOOL_PAYLOAD_BYTES = 8 * 1024;
const MAX_STORED_DEV_SHELL_PAYLOAD_BYTES = 192 * 1024;
const MAX_TOOL_PROMPT_PREVIEW_CHARS = 2 * 1024;
const FETCH_CONTENT_PREVIEW_CHARS = 1600;
const MAX_DEV_SHELL_PROMPT_PREVIEW_CHARS = 6 * 1024;
const MAX_COMPACT_DEV_SHELL_CHUNK_PREVIEW_CHARS = 4 * 1024;
const MAX_FAILURE_VISIBLE_TEXT_CHARS = 8 * 1024;
const MAX_FAILURE_DETAIL_TEXT_CHARS = 2 * 1024;
const MAX_FAILURE_DETAIL_ARRAY_ITEMS = 20;
const MAX_FAILURE_DETAIL_OBJECT_KEYS = 40;
const MAX_FAILURE_DETAIL_DEPTH = 4;
const MAX_TOOL_DIGEST_TOP_LEVEL_KEYS = 20;
const MAX_TOOL_DIGEST_SCALAR_FACTS = 40;
const MAX_TOOL_DIGEST_ARRAY_STATS = 20;
const MAX_TOOL_DIGEST_TEXT_SAMPLES = 8;
const MAX_TOOL_DIGEST_TEXT_PREVIEW_CHARS = 500;
const MAX_TOOL_DIGEST_SCALAR_PREVIEW_CHARS = 140;
const MAX_TOOL_DIGEST_DEPTH = 5;
const MAX_TOOL_DIGEST_ARRAY_SAMPLE_ITEMS = 3;
const MAX_OBSERVATION_TEXT_PREVIEW_CHARS = 500;
const INTERACTIVE_DEV_SHELL_TIMEOUT_GUIDANCE =
  "This command is interactive. Restart it with dev.process.start, then use dev.process.write/dev.process.read.";


function safeSerialize(value: unknown): string {
  try {
    return stableStringify(value);
  } catch {
    return stringifySanitizedJson({ value: sanitizeUtf16String(String(value)) });
  }
}

function stableStringify(value: unknown): string {
  return stringifySanitizedJson(sortValue(sanitizeJsonValue(value)));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortValue(item));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort((left, right) => left.localeCompare(right))) {
    sorted[key] = sortValue(record[key]);
  }
  return sorted;
}

function summarizeText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

export function compactInternetToolOutputForTests(
  toolName: string,
  output: unknown,
): Record<string, unknown> | undefined {
  return compactInternetToolOutput(toolName, output);
}

export function buildToolOutputDigestForTests(
  toolName: string,
  output: unknown,
): ReturnType<typeof buildToolOutputDigest> {
  return buildToolOutputDigest(toolName, output);
}

export function shapeToolExecutionResultForTests(input: {
  runId: string;
  stepIndex: number;
  toolName: string;
  output: unknown;
}): {
  storedOutput: unknown;
  verificationOutput: unknown;
  artifacts: ArtifactIntent[];
  decisionTrace: Array<Record<string, unknown>>;
} {
  return shapeToolExecutionResult(input);
}

function wrapArtifactPayload(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeJsonValue(value);
  if (typeof sanitized === "object" && sanitized !== null && Array.isArray(sanitized) === false) {
    return sanitized as Record<string, unknown>;
  }
  return {
    value: sanitized,
  };
}


export function shapeToolExecutionResult(input: {
  runId: string;
  stepIndex: number;
  toolName: string;
  output: unknown;
}): {
  storedOutput: unknown;
  verificationOutput: unknown;
  artifacts: ArtifactIntent[];
  decisionTrace: Array<Record<string, unknown>>;
} {
  const sanitizedOutput = sanitizeJsonValue(input.output);
  const serialized = safeSerialize(sanitizedOutput);
  const sizeBytes = Buffer.byteLength(serialized, "utf8");
  const inlinePayloadByteLimit = resolveStoredToolPayloadByteLimit(input.toolName);
  const internetSignal = readInternetToolResultSignal(input.toolName, sanitizedOutput);
  if (sizeBytes <= inlinePayloadByteLimit) {
    return {
      storedOutput: sanitizedOutput,
      verificationOutput: sanitizedOutput,
      artifacts: [],
      decisionTrace:
        internetSignal === undefined
          ? []
          : [
              {
                eventType: "tool.result_summarized",
                phase: "acter",
                decisionCode: "tool_result_signal",
                metadata: {
                  toolName: input.toolName,
                  status: internetSignal.status,
                  attempts: internetSignal.attempts,
                  ...(internetSignal.provider !== undefined ? { provider: internetSignal.provider } : {}),
                  ...(internetSignal.degradedCode !== undefined
                    ? { degradedCode: internetSignal.degradedCode }
                    : {}),
                  ...(internetSignal.degradedMessage !== undefined
                    ? { degradedMessage: internetSignal.degradedMessage }
                    : {}),
                  ...(internetSignal.retryAfterSeconds !== undefined
                    ? { retryAfterSeconds: internetSignal.retryAfterSeconds }
                    : {}),
                },
              },
            ],
    };
  }

  const artifactId = `${input.runId}:tool-output:${input.stepIndex}:${input.toolName}`;
  const digestArtifactId = `${input.runId}:tool-output-digest:${input.stepIndex}:${input.toolName}`;
  const digestSummary = buildToolOutputDigest(input.toolName, sanitizedOutput);
  const compactOutput = compactToolOutputForStorage(input.toolName, sanitizedOutput);
  const compactSerialized =
    compactOutput === undefined ? undefined : safeSerialize(compactOutput);
  const summary =
    compactSerialized !== undefined
      ? summarizeText(compactSerialized, resolveToolPromptPreviewChars(input.toolName))
      : summarizeText(serialized, resolveToolPromptPreviewChars(input.toolName));
  const truncatedEnvelope = {
    summary,
    truncated: true as const,
    sizeBytes,
    artifactIds: [artifactId],
    digestArtifactId,
    digestSummary,
  };
  return {
    storedOutput:
      compactOutput === undefined
        ? truncatedEnvelope
        : {
            ...compactOutput,
            ...truncatedEnvelope,
          },
    // Verification evaluates the complete sanitized tool result. Only the
    // persisted and model-visible projections are bounded.
    verificationOutput: sanitizedOutput,
    artifacts: [
      {
        id: artifactId,
        type: "tool-output",
        payload: {
          toolName: input.toolName,
          summary,
          output: wrapArtifactPayload(sanitizedOutput),
        },
      },
      {
        id: digestArtifactId,
        type: "tool-output-digest",
        payload: {
          toolName: input.toolName,
          outputArtifactId: artifactId,
          summary,
          digest: digestSummary,
        },
      },
    ],
    decisionTrace: [
      {
        eventType: "tool.result_summarized",
        phase: "acter",
        decisionCode: "tool_result_summarized",
        metadata: {
          toolName: input.toolName,
          sizeBytes,
          artifactId,
          digestArtifactId,
          ...(internetSignal !== undefined ? { status: internetSignal.status } : {}),
          ...(internetSignal !== undefined ? { attempts: internetSignal.attempts } : {}),
          ...(internetSignal?.provider !== undefined ? { provider: internetSignal.provider } : {}),
          ...(internetSignal?.degradedCode !== undefined
            ? { degradedCode: internetSignal.degradedCode }
            : {}),
          ...(internetSignal?.degradedMessage !== undefined
            ? { degradedMessage: internetSignal.degradedMessage }
            : {}),
          ...(internetSignal?.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: internetSignal.retryAfterSeconds }
            : {}),
        },
      },
    ],
  };
}

export function normalizeEffectResultForTool(input: {
  toolName: string;
  toolInput: Record<string, unknown>;
  effectResult: unknown;
  collectedOutput: unknown;
}): unknown {
  const effectRecord = asRecord(input.effectResult);
  if (effectRecord === undefined || asString(effectRecord.status) !== "FAILED") {
    return input.collectedOutput;
  }
  return buildRecoverableToolFailureOutput({
    toolName: input.toolName,
    toolInput: input.toolInput,
    error: asRecord(effectRecord.error) ?? effectRecord,
    failureResult: input.effectResult,
    collectedOutput: input.collectedOutput,
  });
}

export function buildRecoverableToolFailureOutput(input: {
  toolName: string;
  toolInput: Record<string, unknown>;
  error: unknown;
  failureResult?: unknown;
  collectedOutput?: unknown;
}): Record<string, unknown> {
  const errorRecord = normalizeFailureErrorRecord(input.error);
  const details = asRecord(errorRecord?.details);
  const failureResultRecord = asRecord(input.failureResult);
  const collectedOutputRecord = asRecord(input.collectedOutput);
  const outputRecord =
    asRecord(errorRecord?.output) ??
    asRecord(details?.output) ??
    asRecord(failureResultRecord?.output) ??
    collectedOutputRecord;
  const message = asString(errorRecord?.message) ??
    asString(details?.message) ??
    asString(failureResultRecord?.message) ??
    (input.error instanceof Error ? input.error.message : undefined) ??
    "Tool execution failed.";
  const errorCode = asString(errorRecord?.code) ?? "TOOL_EXECUTION_FAILED";
  const detailPath = asString(details?.path);
  const inputPath = asString(input.toolInput.path);
  const visibleContext = buildVisibleToolFailureContext({
    toolName: input.toolName,
    toolInput: input.toolInput,
    error: errorRecord,
    details,
    output: outputRecord,
    failureResult: failureResultRecord,
  });
  const visibleDetails = details === undefined ? undefined : sanitizeFailureVisibleValue(details);
  return {
    status: "FAILED",
    toolName: input.toolName,
    errorCode,
    message,
    truncated: false,
    recoverable: details?.recoverable !== false && errorRecord?.recoverable !== false,
    ...(detailPath !== undefined ? { path: detailPath } : inputPath !== undefined ? { path: inputPath } : {}),
    ...visibleContext,
    ...(visibleDetails !== undefined ? { details: visibleDetails } : {}),
  };
}

function normalizeFailureErrorRecord(error: unknown): Record<string, unknown> | undefined {
  const record = asRecord(error);
  if (record !== undefined) {
    return record;
  }
  if (error instanceof Error) {
    const code = typeof (error as { code?: unknown }).code === "string"
      ? String((error as { code?: unknown }).code)
      : undefined;
    const details = asRecord((error as { details?: unknown }).details);
    return {
      ...(code !== undefined ? { code } : {}),
      message: error.message,
      ...(details !== undefined ? { details } : {}),
    };
  }
  return ;
}

function buildVisibleToolFailureContext(input: {
  toolName: string;
  toolInput: Record<string, unknown>;
  error: Record<string, unknown> | undefined;
  details: Record<string, unknown> | undefined;
  output: Record<string, unknown> | undefined;
  failureResult: Record<string, unknown> | undefined;
}): Record<string, unknown> {
  const visible: Record<string, unknown> = {};
  mergeFailureContext(visible, readToolInputFailureContext(input.toolName, input.toolInput));
  mergeFailureContext(visible, pickFailureVisibleFields(input.failureResult));
  mergeFailureContext(visible, pickFailureVisibleFields(input.output));
  mergeFailureContext(visible, pickFailureVisibleFields(input.details));
  mergeFailureContext(visible, pickFailureVisibleFields(input.error));
  mergeFailureContext(visible, interactiveDevShellTimeoutGuidance(input.toolName, { status: "FAILED", ...visible }));
  return visible;
}

function readToolInputFailureContext(
  toolName: string,
  toolInput: Record<string, unknown>,
): Record<string, unknown> {
  const context: Record<string, unknown> = {};
  if (isDevShellLifecycleTool(toolName)) {
    copyFailureStringField(context, toolInput, "command");
    copyFailureStringField(context, toolInput, "cwd");
    copyFailureStringField(context, toolInput, "workspaceRoot");
    copyFailureStringField(context, toolInput, "processId");
    copyFailureStringField(context, toolInput, "sessionId");
  }
  copyFailureStringField(context, toolInput, "path");
  copyFailureStringField(context, toolInput, "sourcePath");
  copyFailureStringField(context, toolInput, "destinationPath");
  return context;
}

function pickFailureVisibleFields(value: Record<string, unknown> | undefined): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  const visible: Record<string, unknown> = {};
  for (const key of [
    "command",
    "cwd",
    "workspaceRoot",
    "processId",
    "path",
    "sourcePath",
    "destinationPath",
    "status",
    "statusCode",
    "exitCode",
    "signal",
    "failureReason",
    "failurePhase",
    "commandKind",
    "strictModeApplied",
    "strictModeReason",
    "field",
    "expected",
    "receivedType",
    "provider",
    "reason",
    "bootstrapReason",
    "logPath",
    "socketPath",
    "bootstrapStatusPath",
  ]) {
    copyFailureScalarField(visible, value, key);
  }
  for (const key of ["text", "stdout", "stderr", "chunk", "logTail"]) {
    const text = asString(value[key]);
    if (text !== undefined) {
      visible[key] = summarizeText(text, MAX_FAILURE_VISIBLE_TEXT_CHARS);
      if (text.length > MAX_FAILURE_VISIBLE_TEXT_CHARS) {
        visible[`${key}Truncated`] = true;
      }
    }
  }
  for (const key of ["validationErrors", "invalidValues", "missingEnvNames", "unauthorizedSourceWrites"]) {
    if (value[key] !== undefined) {
      visible[key] = sanitizeFailureVisibleValue(value[key]);
    }
  }
  return visible;
}

function mergeFailureContext(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) {
      target[key] = value;
    }
  }
}

function interactiveDevShellTimeoutGuidance(
  toolName: string,
  value: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName !== "dev.shell.run") {
    return {};
  }
  if (asString(value.status) !== "FAILED") {
    return {};
  }
  if (typeof value.exitCode !== "number" || Math.trunc(value.exitCode) !== 124) {
    return {};
  }
  const outputText = asString(value.text) ?? asString(value.stdout) ?? asString(value.chunk) ?? asString(value.chunkPreview);
  if (outputText === undefined || looksLikeInteractivePromptSuffix(outputText) === false) {
    return {};
  }
  return { nextSuggestedAction: INTERACTIVE_DEV_SHELL_TIMEOUT_GUIDANCE };
}

function looksLikeInteractivePromptSuffix(text: string): boolean {
  const tail = text.replace(/\s+$/u, "");
  return tail.endsWith(">") || tail.endsWith("?") || tail.endsWith(":");
}

function copyFailureStringField(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  const value = asString(source[key]);
  if (value !== undefined) {
    target[key] = value;
  }
}

function copyFailureScalarField(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  const value = source[key];
  if (typeof value === "string") {
    target[key] = summarizeText(value, MAX_FAILURE_DETAIL_TEXT_CHARS);
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    target[key] = Math.trunc(value);
    return;
  }
  if (typeof value === "boolean" || value === null) {
    target[key] = value;
  }
}

function sanitizeFailureVisibleValue(value: unknown, depth = 0): unknown {
  const sanitized = sanitizeJsonValue(value);
  if (typeof sanitized === "string") {
    return summarizeText(sanitized, MAX_FAILURE_DETAIL_TEXT_CHARS);
  }
  if (
    typeof sanitized === "number" ||
    typeof sanitized === "boolean" ||
    sanitized === null ||
    sanitized === undefined
  ) {
    return sanitized;
  }
  if (Array.isArray(sanitized)) {
    if (depth >= MAX_FAILURE_DETAIL_DEPTH) {
      return {
        itemCount: sanitized.length,
        truncated: sanitized.length > 0,
      };
    }
    return sanitized
      .slice(0, MAX_FAILURE_DETAIL_ARRAY_ITEMS)
      .map((item) => sanitizeFailureVisibleValue(item, depth + 1));
  }
  if (typeof sanitized === "object") {
    if (depth >= MAX_FAILURE_DETAIL_DEPTH) {
      return {
        keyCount: Object.keys(sanitized as Record<string, unknown>).length,
        truncated: true,
      };
    }
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(sanitized as Record<string, unknown>)
      .sort((left, right) => left.localeCompare(right))
      .slice(0, MAX_FAILURE_DETAIL_OBJECT_KEYS)) {
      output[key] = sanitizeFailureVisibleValue((sanitized as Record<string, unknown>)[key], depth + 1);
    }
    return output;
  }
  return String(sanitized);
}

interface ToolOutputDigestEnvelope {
  version: "v1";
  toolName: string;
  topLevelKeys: string[];
  scalarFacts: Array<{
    path: string;
    value: string | number | boolean | null;
  }>;
  arrayStats: Array<{
    path: string;
    count: number;
  }>;
  textPreview?: string | undefined;
  adapter?: Record<string, unknown> | undefined;
}

function buildToolOutputDigest(
  toolName: string,
  output: unknown,
): ToolOutputDigestEnvelope {
  const sanitized = sanitizeJsonValue(output);
  const digest = buildGenericToolOutputDigest(toolName, sanitized);
  const adapter = buildToolOutputDigestAdapter(toolName, asRecord(sanitized));
  if (adapter === undefined) {
    return digest;
  }
  return {
    ...digest,
    adapter,
  };
}

function buildGenericToolOutputDigest(
  toolName: string,
  output: unknown,
): ToolOutputDigestEnvelope {
  const topLevelKeys = asRecord(output) === undefined
    ? []
    : Object.keys(asRecord(output) ?? {})
      .sort((left, right) => left.localeCompare(right))
      .slice(0, MAX_TOOL_DIGEST_TOP_LEVEL_KEYS);
  const scalarFacts: ToolOutputDigestEnvelope["scalarFacts"] = [];
  const arrayStats: ToolOutputDigestEnvelope["arrayStats"] = [];
  const textSamples: string[] = [];
  collectToolDigestFacts({
    value: output,
    path: "$",
    depth: 0,
    scalarFacts,
    arrayStats,
    textSamples,
  });
  return {
    version: "v1",
    toolName,
    topLevelKeys,
    scalarFacts,
    arrayStats,
    ...(textSamples.length > 0
      ? {
          textPreview: summarizeText(
            textSamples.join(" | "),
            MAX_TOOL_DIGEST_TEXT_PREVIEW_CHARS,
          ),
        }
      : {}),
  };
}

function collectToolDigestFacts(input: {
  value: unknown;
  path: string;
  depth: number;
  scalarFacts: ToolOutputDigestEnvelope["scalarFacts"];
  arrayStats: ToolOutputDigestEnvelope["arrayStats"];
  textSamples: string[];
}): void {
  if (input.depth > MAX_TOOL_DIGEST_DEPTH) {
    return;
  }
  if (
    input.scalarFacts.length >= MAX_TOOL_DIGEST_SCALAR_FACTS &&
    input.arrayStats.length >= MAX_TOOL_DIGEST_ARRAY_STATS &&
    input.textSamples.length >= MAX_TOOL_DIGEST_TEXT_SAMPLES
  ) {
    return;
  }

  const scalarValue = coerceToolDigestScalar(input.value);
  if (scalarValue !== undefined) {
    if (input.scalarFacts.length < MAX_TOOL_DIGEST_SCALAR_FACTS) {
      input.scalarFacts.push({
        path: input.path,
        value: scalarValue,
      });
    }
    if (typeof scalarValue === "string" && scalarValue.trim().length > 0 && input.textSamples.length < MAX_TOOL_DIGEST_TEXT_SAMPLES) {
      input.textSamples.push(scalarValue);
    }
    return;
  }

  if (Array.isArray(input.value)) {
    if (input.arrayStats.length < MAX_TOOL_DIGEST_ARRAY_STATS) {
      input.arrayStats.push({
        path: input.path,
        count: input.value.length,
      });
    }
    for (let index = 0; index < Math.min(input.value.length, MAX_TOOL_DIGEST_ARRAY_SAMPLE_ITEMS); index += 1) {
      collectToolDigestFacts({
        ...input,
        value: input.value[index],
        path: `${input.path}[${index}]`,
        depth: input.depth + 1,
      });
    }
    return;
  }

  const record = asRecord(input.value);
  if (record === undefined) {
    return;
  }
  const keys = Object.keys(record).sort((left, right) => left.localeCompare(right));
  for (const key of keys) {
    collectToolDigestFacts({
      ...input,
      value: record[key],
      path: input.path === "$" ? `$.${key}` : `${input.path}.${key}`,
      depth: input.depth + 1,
    });
  }
}

function coerceToolDigestScalar(
  value: unknown,
): string | number | boolean | null | undefined {
  if (value === null) {
    return null;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    return summarizeText(value, MAX_TOOL_DIGEST_SCALAR_PREVIEW_CHARS);
  }
  return ;
}

function buildToolOutputDigestAdapter(
  toolName: string,
  output: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (output === undefined) {
    return ;
  }
  if (toolName === "internet.research") {
    return buildDeepReportDigestAdapter(output);
  }
  if (toolName === "internet.search" || toolName === "internet.news" || toolName === "internet.news") {
    return buildSearchDigestAdapter(toolName, output);
  }
  if (toolName === "internet.extract" || toolName === "internet.extract") {
    return buildFetchDigestAdapter(toolName, output);
  }
  if (toolName === "code.execute") {
    return buildCodeExecuteDigestAdapter(output);
  }
  return ;
}

function buildDeepReportDigestAdapter(
  output: Record<string, unknown>,
): Record<string, unknown> {
  const report = asRecord(output.report);
  const findings = asArray(report?.findings)
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== undefined);
  const sources = asArray(report?.sources)
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== undefined);
  return {
    adapterName: "internet.research",
    ...(asString(report?.summary) !== undefined ? { summary: asString(report?.summary) } : {}),
    findingCount: findings.length,
    sourceCount: sources.length,
    highlights: findings.slice(0, 5).map((item) => ({
      ...(asString(item.title) !== undefined ? { title: asString(item.title) } : {}),
      ...(asString(item.url) !== undefined ? { url: asString(item.url) } : {}),
      ...(asString(item.source) !== undefined ? { source: asString(item.source) } : {}),
      ...(asString(item.snippet) !== undefined
        ? { snippet: summarizeText(asString(item.snippet) ?? "", 180) }
        : {}),
    })),
  };
}

function buildSearchDigestAdapter(
  toolName: string,
  output: Record<string, unknown>,
): Record<string, unknown> {
  const results = readInternetResultItems(output.results);
  return {
    adapterName: toolName,
    ...readInternetEnvelope(output),
    ...(asString(output.query) !== undefined ? { query: asString(output.query) } : {}),
    ...(asString(output.scope) !== undefined ? { scope: asString(output.scope) } : {}),
    ...(asString(output.region) !== undefined ? { region: asString(output.region) } : {}),
    resultCount: results.length,
    highlights: results.slice(0, 5),
  };
}

function buildFetchDigestAdapter(
  toolName: string,
  output: Record<string, unknown>,
): Record<string, unknown> {
  const structured = asRecord(output.structured);
  const content = asString(output.content);
  return {
    adapterName: toolName,
    ...readInternetEnvelope(output),
    ...(asString(output.url) !== undefined ? { url: asString(output.url) } : {}),
    ...(asString(output.title) !== undefined ? { title: asString(output.title) } : {}),
    ...(typeof output.charCount === "number" ? { charCount: output.charCount } : {}),
    ...(asString(output.quality) !== undefined ? { quality: asString(output.quality) } : {}),
    ...(output.truncated === true ? { truncated: true } : {}),
    ...(content !== undefined
      ? { contentPreview: summarizeText(content, FETCH_CONTENT_PREVIEW_CHARS) }
      : {}),
    ...(Array.isArray(output.contentIssues)
      ? {
          contentIssues: asArray(output.contentIssues)
            .map((item) => asString(item))
            .filter((item): item is string => item !== undefined)
            .slice(0, 8),
        }
      : {}),
    ...(asString(output.selectorCoverage) !== undefined
      ? { selectorCoverage: asString(output.selectorCoverage) }
      : {}),
    ...(structured !== undefined ? { structuredKeys: Object.keys(structured).sort((a, b) => a.localeCompare(b)).slice(0, 10) } : {}),
  };
}

function buildCodeExecuteDigestAdapter(
  output: Record<string, unknown>,
): Record<string, unknown> {
  const artifacts = asArray(output.artifacts)
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== undefined);
  return {
    adapterName: "code.execute",
    ...(asString(output.status) !== undefined ? { status: asString(output.status) } : {}),
    ...(typeof output.exitCode === "number" ? { exitCode: output.exitCode } : {}),
    ...(typeof output.durationMs === "number" ? { durationMs: output.durationMs } : {}),
    ...(asString(output.summary) !== undefined ? { summary: asString(output.summary) } : {}),
    ...(asString(output.stdout) !== undefined
      ? { stdoutPreview: summarizeText(asString(output.stdout) ?? "", 200) }
      : {}),
    ...(asString(output.stderr) !== undefined
      ? { stderrPreview: summarizeText(asString(output.stderr) ?? "", 200) }
      : {}),
    artifactCount: artifacts.length,
    artifactPaths: artifacts
      .map((item) => asString(item.path))
      .filter((item): item is string => item !== undefined)
      .slice(0, 8),
  };
}

interface InternetToolResultSignal {
  status: "ok" | "degraded";
  attempts: number;
  provider?: string | undefined;
  degradedCode?: string | undefined;
  degradedMessage?: string | undefined;
  retryAfterSeconds?: number | undefined;
}

function resolveStoredToolPayloadByteLimit(toolName: string): number {
  return isInlineHighVolumeDevShellTool(toolName)
    ? MAX_STORED_DEV_SHELL_PAYLOAD_BYTES
    : MAX_STORED_TOOL_PAYLOAD_BYTES;
}

function resolveToolPromptPreviewChars(toolName: string): number {
  return isInlineHighVolumeDevShellTool(toolName)
    ? MAX_DEV_SHELL_PROMPT_PREVIEW_CHARS
    : MAX_TOOL_PROMPT_PREVIEW_CHARS;
}

function isInlineHighVolumeDevShellTool(toolName: string): boolean {
  return toolName === "exec_command" ||
    toolName === "dev.process.read" ||
    toolName === "dev.process.start" ||
    toolName === "dev.shell.run";
}

function compactToolOutputForStorage(
  toolName: string,
  output: unknown,
): Record<string, unknown> | undefined {
  return compactArtifactVerificationToolOutput(toolName, output) ??
    compactInternetToolOutput(toolName, output) ??
    compactDevShellToolOutput(toolName, output);
}

function compactArtifactVerificationToolOutput(
  toolName: string,
  output: unknown,
): Record<string, unknown> | undefined {
  if (isArtifactVerificationTool(toolName) === false) {
    return ;
  }
  const record = asRecord(output);
  const artifactVerification = asRecord(record?.artifactVerification);
  if (record === undefined || artifactVerification === undefined) {
    return ;
  }
  const requirements = asArray(artifactVerification.requirements)
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== undefined);
  const requirementStatusCounts = summarizeVerificationRequirementStatuses(requirements);
  const failedOrInconclusiveRequirements = requirements
    .filter((item) => {
      const status = asString(item.status);
      return status === "failed" || status === "inconclusive";
    })
    .map(compactVerificationRequirement)
    .slice(0, 12);
  return {
    ...(asString(record.path) !== undefined ? { path: asString(record.path) } : {}),
    ...(asString(record.target) !== undefined ? { target: asString(record.target) } : {}),
    ...(asString(record.status) !== undefined ? { status: asString(record.status) } : {}),
    ...(asString(record.verificationToken) !== undefined ? { verificationToken: asString(record.verificationToken) } : {}),
    ...(asString(record.summary) !== undefined ? { summary: asString(record.summary) } : {}),
    ...(typeof record.truncated === "boolean" ? { verifierTruncated: record.truncated } : {}),
    artifactVerification: {
      ...(asString(artifactVerification.target) !== undefined ? { target: asString(artifactVerification.target) } : {}),
      ...(asString(artifactVerification.status) !== undefined ? { status: asString(artifactVerification.status) } : {}),
      ...(asRecord(artifactVerification.evidence) !== undefined ? { evidence: asRecord(artifactVerification.evidence) } : {}),
      requirementsSummary: {
        total: requirements.length,
        ...requirementStatusCounts,
      },
      ...(failedOrInconclusiveRequirements.length > 0
        ? { requirements: failedOrInconclusiveRequirements }
        : {}),
      ...(Array.isArray(artifactVerification.failures)
        ? {
            failures: asArray(artifactVerification.failures)
              .map((item) => asString(item))
              .filter((item): item is string => item !== undefined)
              .slice(0, 12),
          }
        : {}),
    },
  };
}

function isArtifactVerificationTool(toolName: string): boolean {
  return toolName === "fs.verify_json";
}

function summarizeVerificationRequirementStatuses(
  requirements: Record<string, unknown>[],
): Record<string, number> {
  const counts: {
    passed: number;
    failed: number;
    inconclusive: number;
  } = {
    passed: 0,
    failed: 0,
    inconclusive: 0,
  };
  for (const requirement of requirements) {
    const status = asString(requirement.status);
    if (status === "passed") {
      counts.passed += 1;
    } else if (status === "failed") {
      counts.failed += 1;
    } else if (status === "inconclusive") {
      counts.inconclusive += 1;
    }
  }
  return counts;
}

function compactVerificationRequirement(requirement: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(asString(requirement.id) !== undefined ? { id: asString(requirement.id) } : {}),
    ...(asString(requirement.status) !== undefined ? { status: asString(requirement.status) } : {}),
    ...(asString(requirement.observed) !== undefined
      ? { observed: summarizeText(asString(requirement.observed) ?? "", MAX_TOOL_DIGEST_SCALAR_PREVIEW_CHARS) }
      : {}),
    ...(asString(requirement.expectation) !== undefined
      ? { expectation: summarizeText(asString(requirement.expectation) ?? "", MAX_TOOL_DIGEST_SCALAR_PREVIEW_CHARS) }
      : {}),
  };
}

function compactInternetToolOutput(
  toolName: string,
  output: unknown,
): Record<string, unknown> | undefined {
  if (toolName.startsWith("internet.") === false) {
    return ;
  }

  const record = asRecord(output);
  if (record === undefined) {
    return ;
  }

  if (toolName === "internet.search" || toolName === "internet.news") {
    const resultItems = readInternetResultItems(record.results);
    return {
      ...readInternetEnvelope(record),
      ...(asString(record.query) !== undefined ? { query: asString(record.query) } : {}),
      ...(asString(record.region) !== undefined ? { region: asString(record.region) } : {}),
      resultCount: resultItems.length,
      highlights: resultItems.slice(0, 5),
    };
  }

  if (toolName === "internet.news") {
    const resultItems = readInternetResultItems(record.results);
    return {
      ...readInternetEnvelope(record),
      ...(asString(record.scope) !== undefined ? { scope: asString(record.scope) } : {}),
      resultCount: resultItems.length,
      highlights: resultItems.slice(0, 5),
    };
  }

  if (toolName === "internet.images") {
    const images = asArray(record.results)
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== undefined)
      .map((item) => ({
        ...(asString(item.title) !== undefined ? { title: asString(item.title) } : {}),
        ...(asString(item.url) !== undefined ? { url: asString(item.url) } : {}),
        ...(asString(item.source) !== undefined ? { source: asString(item.source) } : {}),
      }))
      .filter((item) => Object.keys(item).length > 0);
    return {
      ...readInternetEnvelope(record),
      ...(asString(record.query) !== undefined ? { query: asString(record.query) } : {}),
      resultCount: images.length,
      highlights: images.slice(0, 5),
    };
  }

  if (toolName === "internet.extract" || toolName === "internet.extract") {
    const content = asString(record.content);
    const structured = asRecord(record.structured);
    return {
      ...readInternetEnvelope(record),
      ...(asString(record.url) !== undefined ? { url: asString(record.url) } : {}),
      ...(asString(record.title) !== undefined ? { title: asString(record.title) } : {}),
      ...(content !== undefined ? { contentPreview: summarizeText(content, FETCH_CONTENT_PREVIEW_CHARS) } : {}),
      ...(typeof record.charCount === "number" ? { charCount: record.charCount } : {}),
      ...(record.truncated === true ? { truncated: true } : {}),
      ...(asString(record.quality) !== undefined ? { quality: asString(record.quality) } : {}),
      ...(Array.isArray(record.contentIssues)
        ? { contentIssues: asArray(record.contentIssues).map((item) => asString(item)).filter((item): item is string => item !== undefined).slice(0, 8) }
        : {}),
      ...(asString(record.selectorCoverage) !== undefined
        ? { selectorCoverage: asString(record.selectorCoverage) }
        : {}),
      ...(structured !== undefined ? { structuredKeys: Object.keys(structured).slice(0, 10) } : {}),
    };
  }

  if (toolName === "internet.research") {
    const report = asRecord(record.report);
    const findings = asArray(report?.findings)
      .map((item) => asRecord(item))
      .filter((item): item is Record<string, unknown> => item !== undefined)
      .map((item) => ({
        ...(asString(item.title) !== undefined ? { title: asString(item.title) } : {}),
        ...(asString(item.url) !== undefined ? { url: asString(item.url) } : {}),
        ...(asString(item.source) !== undefined ? { source: asString(item.source) } : {}),
        ...(asString(item.snippet) !== undefined
          ? { snippet: summarizeText(asString(item.snippet) ?? "", 180) }
          : {}),
      }))
      .filter((item) => Object.keys(item).length > 0);
    return {
      ...readInternetEnvelope(record),
      report: {
        ...(asString(report?.summary) !== undefined ? { summary: asString(report?.summary) } : {}),
        findings: findings.slice(0, 5),
      },
    };
  }

  return ;
}

function compactDevShellToolOutput(
  toolName: string,
  output: unknown,
): Record<string, unknown> | undefined {
  const record = asRecord(output);
  if (record === undefined) {
    return ;
  }

  const lifecycle = normalizeDevShellLifecycle(toolName, undefined, record);
  if (lifecycle !== undefined) {
    const text = lifecycle.outputText ?? asString(record.text) ?? asString(record.chunk) ?? asString(record.output);
    const compact = {
      ...(lifecycle.processId !== undefined ? { processId: lifecycle.processId } : {}),
      ...(lifecycle.sessionId !== undefined ? { sessionId: lifecycle.sessionId } : {}),
      ...(lifecycle.command !== undefined ? { command: lifecycle.command } : {}),
      ...(lifecycle.cwd !== undefined ? { cwd: lifecycle.cwd } : {}),
      ...(lifecycle.workspaceRoot !== undefined ? { workspaceRoot: lifecycle.workspaceRoot } : {}),
      ...(lifecycle.status !== undefined ? { status: lifecycle.status } : {}),
      ...(asString(record.submittedAt) !== undefined ? { submittedAt: asString(record.submittedAt) } : {}),
      ...(asString(record.startedAt) !== undefined ? { startedAt: asString(record.startedAt) } : {}),
      ...(asString(record.updatedAt) !== undefined ? { updatedAt: asString(record.updatedAt) } : {}),
      ...(asString(record.completedAt) !== undefined ? { completedAt: asString(record.completedAt) } : {}),
      ...(lifecycle.exitCode !== undefined ? { exitCode: lifecycle.exitCode } : {}),
      ...(asString(record.failureReason) !== undefined ? { failureReason: asString(record.failureReason) } : {}),
      ...(asString(record.failurePhase) !== undefined ? { failurePhase: asString(record.failurePhase) } : {}),
      ...(asString(record.commandKind) !== undefined ? { commandKind: asString(record.commandKind) } : {}),
      ...(record.strictModeApplied === true ? { strictModeApplied: true } : {}),
      ...(asString(record.strictModeReason) !== undefined ? { strictModeReason: asString(record.strictModeReason) } : {}),
      ...(readChangedFiles(record).length > 0 ? { changedFiles: readChangedFiles(record) } : {}),
      ...(lifecycle.truncated === true ? { truncated: true } : {}),
      ...(lifecycle.cursor !== undefined ? { cursor: lifecycle.cursor } : {}),
      ...(text !== undefined
        ? {
            chunkPreview: summarizeText(
              text,
              MAX_COMPACT_DEV_SHELL_CHUNK_PREVIEW_CHARS,
            ),
            chunkBytes: Buffer.byteLength(text, "utf8"),
          }
        : {}),
    };
    return {
      ...compact,
      ...interactiveDevShellTimeoutGuidance(toolName, {
        ...record,
        ...compact,
      }),
    };
  }

  return ;
}

function readChangedFiles(value: unknown): string[] {
  return asArray(asRecord(value)?.changedFiles)
    .map((item) => asString(item)?.trim())
    .filter((item): item is string => item !== undefined && item.length > 0)
    .slice(0, 40);
}

function readInternetToolResultSignal(
  toolName: string,
  output: unknown,
): InternetToolResultSignal | undefined {
  if (toolName.startsWith("internet.") === false) {
    return ;
  }

  const record = asRecord(output);
  if (record === undefined) {
    return ;
  }

  const status = asString(record.status);
  const attempts = asPositiveNumber(record.attempts) ?? 1;
  const provider = asString(record.provider);
  const degraded = asRecord(record.degraded);
  const degradedCode = asString(degraded?.code);
  const degradedMessage = asString(degraded?.message);
  const retryAfterSeconds = asPositiveNumber(degraded?.retryAfterSeconds);

  if (
    status !== "ok" &&
    status !== "degraded" &&
    provider === undefined &&
    degradedCode === undefined &&
    degradedMessage === undefined
  ) {
    return ;
  }

  return {
    status: status === "degraded" || degradedCode !== undefined ? "degraded" : "ok",
    attempts,
    ...(provider !== undefined ? { provider } : {}),
    ...(degradedCode !== undefined ? { degradedCode } : {}),
    ...(degradedMessage !== undefined ? { degradedMessage } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}

function readInternetEnvelope(record: Record<string, unknown>): Record<string, unknown> {
  const status = asString(record.status);
  const attempts = asPositiveNumber(record.attempts);
  const provider = asString(record.provider);
  const degraded = asRecord(record.degraded);
  return {
    ...(status !== undefined ? { status } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
    ...(provider !== undefined ? { provider } : {}),
    ...(degraded !== undefined ? { degraded } : {}),
  };
}

function readInternetResultItems(value: unknown): Array<Record<string, unknown>> {
  return asArray(value)
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== undefined)
    .map((item) => ({
      ...(asString(item.title) !== undefined ? { title: asString(item.title) } : {}),
      ...(asString(item.url) !== undefined ? { url: asString(item.url) } : {}),
      ...(asString(item.source) !== undefined ? { source: asString(item.source) } : {}),
      ...(asString(item.publishedAt) !== undefined ? { publishedAt: asString(item.publishedAt) } : {}),
      ...(asString(item.snippet) !== undefined
        ? { snippet: summarizeText(asString(item.snippet) ?? "", 180) }
        : {}),
    }))
    .filter((item) => Object.keys(item).length > 0);
}

function asPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function collectToolArtifacts(toolName: string, output: unknown): ArtifactIntent[] {
  if (toolName !== "code.execute") {
    return [];
  }

  const result = asRecord(output);
  const retention = asRecord(result?.retention);
  const persistSummary = retention?.persistSummary !== false;
  const persistArtifacts = retention?.persistArtifacts === true;
  const status = asString(result?.status) ?? "unknown";
  const summary = asString(result?.summary) ?? "";
  const policy = asRecord(result?.policy) ?? {};
  const language = asString(policy.language) ?? undefined;
  const executionArtifacts = asArray(result?.artifacts)
    .map((value) => asRecord(value))
    .filter((value): value is Record<string, unknown> => value !== undefined);

  const intents: ArtifactIntent[] = [];
  if (persistSummary) {
    intents.push({
      type: "code.execution.summary",
      payload: {
        tool: toolName,
        status,
        summary,
        language,
        exitCode: result?.exitCode,
        durationMs: result?.durationMs,
        stdout: asString(result?.stdout),
        stderr: asString(result?.stderr),
      },
    });
  }

  if (persistArtifacts) {
    for (const artifact of executionArtifacts) {
      const path = asString(artifact.path);
      if (path === undefined) {
        continue;
      }
      intents.push({
        type: "code.execution.file",
        payload: {
          tool: toolName,
          status,
          language,
          path,
          sizeBytes: artifact.sizeBytes,
          sha256: artifact.sha256,
          preview: asRecord(artifact.preview),
        },
      });
    }
  }

  return intents;
}

export function buildPostToolVerification(input: {
  reactState: Record<string, unknown>;
  nextCapabilities: Record<string, { tool: string; stepIndex: number; ts: string }>;
  output: unknown;
  toolName?: string | undefined;
  action?: unknown;
  duplicateResult?: ReadOnlyResultDuplicateVerdict | undefined;
}): Record<string, unknown> {
  const prior = capabilityEvidenceFromAgentFeedback(input.reactState);
  const nextKeys = Object.keys(input.nextCapabilities);
  const priorKeys = new Set(Object.keys(prior));
  const newCapabilities = nextKeys.filter((key) => priorKeys.has(key) === false);
  const evidenceCount = estimateEvidenceCount(input.output, input.toolName);
  const internetDiagnostics = readWebExtractionDiagnostics(input.toolName, input.output);
  const devShellDiagnostics = readDevShellVerificationDiagnostics(
    input.toolName,
    input.output,
    input.reactState,
    input.action,
  );
  const recoveryStage = deriveEvidenceRecoveryStage({
    reactState: input.reactState,
    toolName: input.toolName,
    output: input.output,
    action: input.action,
  });
  const recoveryOutput = withVerificationSignals(input.output, {
    recoveryStage,
    duplicateResult: input.duplicateResult,
  });
  const retrySummary = buildWebExtractionRetrySummary({
    prior: asRecord(asRecord(input.reactState.postToolVerification)?.webExtractionRetrySummary),
    objective: readActiveTaskGoal(input.reactState),
    toolName: input.toolName,
    output: input.output,
    action: input.action,
  });
  const evidenceRecoverySummary = updateEvidenceRecoverySummary({
    prior: asRecord(asRecord(input.reactState.postToolVerification)?.evidenceRecoverySummary),
    objective: readActiveTaskGoal(input.reactState),
    toolName: input.toolName,
    output: recoveryOutput,
    action: input.action,
  });
  const evidenceRecovery = evidenceRecoverySummary?.latest;
  const resultQuality =
    internetDiagnostics?.lowYield === true ||
    evidenceRecovery?.lowSignal === true ||
    evidenceCount === 0
      ? "partial"
      : "ok";
  return {
    resultQuality,
    newCapabilities,
    newFactsCount: evidenceCount,
    contradictionsDetected: false,
    verifiedAt: new Date().toISOString(),
    ...(internetDiagnostics !== undefined
      ? {
          webExtraction: {
            sourceCluster: internetDiagnostics.sourceCluster,
            quality: internetDiagnostics.quality,
            truncated: internetDiagnostics.truncated,
            lowYield: internetDiagnostics.lowYield,
            contentIssues: internetDiagnostics.contentIssues,
            selectorCoverage: internetDiagnostics.selectorCoverage,
          },
        }
      : {}),
    ...(devShellDiagnostics !== undefined ? { devShell: devShellDiagnostics } : {}),
    ...(retrySummary !== undefined ? { webExtractionRetrySummary: retrySummary } : {}),
    ...(recoveryStage !== undefined ? { recoveryStage } : {}),
    ...(evidenceRecovery !== undefined
      ? {
          evidenceRecovery: {
            family: evidenceRecovery.family,
            toolName: evidenceRecovery.toolName,
            quality: evidenceRecovery.quality,
            lowSignal: evidenceRecovery.lowSignal,
            issues: evidenceRecovery.issues,
            resultsCount: evidenceRecovery.resultsCount,
            domainDiversity: evidenceRecovery.domainDiversity,
            repeatedFingerprintCount: evidenceRecovery.repeatedFingerprintCount,
            candidateUrls: evidenceRecovery.candidateUrls,
          },
        }
      : {}),
    ...(evidenceRecoverySummary !== undefined
      ? { evidenceRecoverySummary }
      : {}),
    ...(input.duplicateResult !== undefined ? { duplicateResult: input.duplicateResult } : {}),
  };
}

function readActiveTaskGoal(reactState: Record<string, unknown>): string | undefined {
  return readActiveTaskGoalFromTranscript(reactState.modelTranscript);
}

function readDevShellVerificationDiagnostics(
  toolName: string | undefined,
  output: unknown,
  reactState: Record<string, unknown>,
  action: unknown,
): Record<string, unknown> | undefined {
  if (toolName === undefined || isDevShellLifecycleTool(toolName) === false) {
    return ;
  }
  const record = asRecord(output);
  if (record === undefined) {
    return ;
  }
  const priorDevShell = asRecord(asRecord(reactState.exec)?.devShell);
  const actionInput = asRecord(asRecord(action)?.input);
  const lifecycle = normalizeDevShellLifecycle(toolName, actionInput, record);
  const currentCommand = normalizeDevShellCommandContext(actionInput);
  const priorLastCommand = normalizeDevShellCommandContext(priorDevShell?.lastCommand);
  const lastCommand =
    lifecycle?.kind === "start"
      ? currentCommand ?? priorLastCommand
      : priorLastCommand;
  const status = lifecycle?.status ?? asString(record.status);
  const processId =
    lifecycle?.processId ??
    asString(record.processId) ??
    asString(actionInput?.processId) ??
    asString(priorDevShell?.activeProcessId) ??
    asString(priorDevShell?.processId);
  const activeProcessPresent = status === "RUNNING" && processId !== undefined;
  const chunkBytes = readDevShellChunkBytes(record);
  const exitCode = asPositiveNumber(record.exitCode);
  const lastCommandSegments = readDevShellCommandSegments(asString(lastCommand?.command));
  const recentCommands =
    lifecycle?.kind === "start" && asString(currentCommand?.command) !== undefined
      ? appendRecentDevShellCommand(
          readDevShellRecentCommands(priorDevShell?.recentCommands),
          asString(currentCommand?.command)!,
        )
      : readDevShellRecentCommands(priorDevShell?.recentCommands);
  const priorProcesses = asRecord(priorDevShell?.processes) ?? {};
  const priorProcess = processId !== undefined ? asRecord(priorProcesses[processId]) : undefined;
  const commandContext =
    normalizeDevShellCommandContext(record) ??
    currentCommand ??
    normalizeDevShellCommandContext(priorProcess) ??
    priorLastCommand;
  const lastInput = asRecord(priorDevShell?.lastProcessInput);
  const lastStdin =
    processId !== undefined && asString(lastInput?.processId) === processId
      ? asString(lastInput?.chars)
      : undefined;
  const processes =
    processId === undefined
      ? priorProcesses
      : {
          ...priorProcesses,
          [processId]: {
            ...(priorProcess ?? {}),
            processId,
            ...(asString(commandContext?.command) !== undefined ? { command: asString(commandContext?.command) } : {}),
            ...(asString(commandContext?.cwd) !== undefined ? { cwd: asString(commandContext?.cwd) } : {}),
            ...(asString(commandContext?.workspaceRoot) !== undefined ? { workspaceRoot: asString(commandContext?.workspaceRoot) } : {}),
            ...(status !== undefined ? { status } : {}),
            ...(asString(record.submittedAt) !== undefined ? { submittedAt: asString(record.submittedAt) } : {}),
            ...(asString(record.startedAt) !== undefined ? { startedAt: asString(record.startedAt) } : {}),
            ...(asString(record.updatedAt) !== undefined ? { updatedAt: asString(record.updatedAt) } : {}),
            ...(asString(record.completedAt) !== undefined ? { completedAt: asString(record.completedAt) } : {}),
            ...(exitCode !== undefined ? { exitCode } : {}),
            chunkBytes,
            ...(record.truncated === true ? { truncated: true } : {}),
            ...(lastStdin !== undefined ? { lastStdinPreview: summarizeText(lastStdin, 240) } : {}),
          },
        };
  const helperOutcome = asRecord(priorDevShell?.helperOutcome);
  const commandLifecycle: DevShellCommandLifecycle =
    activeProcessPresent
      ? "active_streaming"
      : status === "COMPLETED"
        ? "settled_terminal"
        : "settled_nonterminal";
  return {
    toolName,
    ...(processId !== undefined ? { processId, commandAttributionId: processId } : {}),
    ...(activeProcessPresent ? { activeProcessId: processId, liveProcessIds: [processId] } : {}),
    ...(status !== undefined ? { status } : {}),
    activeProcessPresent,
    commandLifecycle,
    shellObservationKind: activeProcessPresent ? "process_running" : "process_settled",
    chunkBytes,
    noProgress: lifecycle?.kind === "read" && chunkBytes === 0,
    ...(exitCode !== undefined ? { completedExitCode: exitCode } : {}),
    ...(lastCommandSegments.length > 0 ? { lastCommandSegments } : {}),
    ...(recentCommands.length > 0 ? { recentCommands } : {}),
    ...(lastCommand !== undefined ? { lastCommand } : {}),
    ...(Object.keys(processes).length > 0 ? { processes } : {}),
    ...(helperOutcome !== undefined ? { helperOutcome } : {}),
    ...(record.truncated === true ? { truncated: true } : {}),
  };
}

function deriveEvidenceRecoveryStage(input: {
  reactState: Record<string, unknown>;
  toolName?: string | undefined;
  output: unknown;
  action?: unknown;
}): "broaden_search" | "target_article_fetch" | undefined {
  const toolName = input.toolName ?? readPrimaryToolName(input.output);
  const postToolVerification = asRecord(input.reactState.postToolVerification);
  const priorRecoverySummary = asRecord(postToolVerification?.evidenceRecoverySummary);
  const priorLowSignalAttempts = asPositiveNumber(priorRecoverySummary?.lowSignalAttempts) ?? 0;
  if ((toolName === "internet.search" || toolName === "internet.news") && priorLowSignalAttempts > 0) {
    return "broaden_search";
  }

  if (toolName !== "internet.extract" && toolName !== "internet.extract") {
    return ;
  }

  const outputRecord = asRecord(input.output);
  const actionRecord = asRecord(input.action);
  const actionInput = asRecord(actionRecord?.input);
  const url = asString(outputRecord?.url) ?? asString(actionInput?.url);
  if (url === undefined) {
    return ;
  }

  const candidateUrls = asArray(asRecord(priorRecoverySummary?.latest)?.candidateUrls)
    .map((item) => asString(item))
    .filter((item): item is string => item !== undefined);
  if (candidateUrls.includes(url)) {
    return "target_article_fetch";
  }

  const sourceCluster = normalizeSourceCluster(url);
  if (sourceCluster === undefined) {
    return ;
  }
  const priorWebExtraction = normalizeWebExtractionRetrySummary(postToolVerification?.webExtractionRetrySummary);
  const matchedCluster = priorWebExtraction?.clusters.find(
    (entry) => entry.sourceCluster === sourceCluster && entry.lowYieldAttempts > 0,
  );
  return matchedCluster !== undefined ? "target_article_fetch" : undefined;
}

function withVerificationSignals(
  output: unknown,
  input: {
    recoveryStage: "broaden_search" | "target_article_fetch" | undefined;
    duplicateResult?: ReadOnlyResultDuplicateVerdict | undefined;
  },
): unknown {
  if (input.recoveryStage === undefined && input.duplicateResult === undefined) {
    return output;
  }
  const record = asRecord(output);
  if (record === undefined) {
    return output;
  }
  return {
    ...record,
    ...(input.recoveryStage !== undefined ? { recoveryStage: input.recoveryStage } : {}),
    ...(input.duplicateResult !== undefined ? { duplicateResult: input.duplicateResult } : {}),
  };
}

export function toDuplicateResult(input: {
  toolName: string;
  output: unknown;
  ledger: ReadonlyArray<ReadOnlyResultDuplicateLedgerEntry>;
  kind?: "duplicate_cached_result" | undefined;
  fallbackMatchedPriorStep?: number | undefined;
}): ReadOnlyResultDuplicateVerdict | undefined {
  const detected = detectReadOnlyResultDuplicate({
    toolName: input.toolName,
    output: input.output,
    ledger: input.ledger,
  });
  if (detected === undefined) {
    return ;
  }
  if (input.kind !== "duplicate_cached_result") {
    return detected;
  }
  return {
    ...detected,
    kind: "duplicate_cached_result",
    duplicateCount: Math.max(2, detected.duplicateCount),
    ...(input.fallbackMatchedPriorStep !== undefined
      ? { matchedPriorStep: input.fallbackMatchedPriorStep }
      : detected.matchedPriorStep !== undefined
        ? { matchedPriorStep: detected.matchedPriorStep }
        : {}),
  };
}

export function annotateVerificationBatchItems(input: {
  items: Array<{
    name: string;
    input?: Record<string, unknown> | undefined;
    output: unknown;
  }>;
  duplicateLedger: ReadonlyArray<ReadOnlyResultDuplicateLedgerEntry>;
  stepIndex: number;
}): Array<{
  name: string;
  input?: Record<string, unknown> | undefined;
  output: unknown;
}> {
  let duplicateLedger = [...input.duplicateLedger];
  return input.items.map((item, index) => {
    const duplicateResult = toDuplicateResult({
      toolName: item.name,
      output: item.output,
      ledger: duplicateLedger,
    });
    duplicateLedger = advanceDuplicateLedger(duplicateLedger, duplicateResult, input.stepIndex + index);
    return {
      name: item.name,
      ...(item.input !== undefined ? { input: item.input } : {}),
      output:
        duplicateResult === undefined
          ? item.output
          : withVerificationSignals(item.output, {
              recoveryStage: undefined,
              duplicateResult,
            }),
    };
  });
}

export function advanceDuplicateLedger(
  ledger: ReadonlyArray<ReadOnlyResultDuplicateLedgerEntry>,
  duplicateResult: ReadOnlyResultDuplicateVerdict | undefined,
  stepIndex: number,
): ReadOnlyResultDuplicateLedgerEntry[] {
  if (duplicateResult === undefined) {
    return [...ledger];
  }
  const nextEntry: ReadOnlyResultDuplicateLedgerEntry = {
    fingerprint: duplicateResult.fingerprint,
    family: duplicateResult.family,
    toolName: duplicateResult.toolName,
    ...(duplicateResult.canonicalSource !== undefined
      ? { canonicalSource: duplicateResult.canonicalSource }
      : {}),
    ...(duplicateResult.canonicalUrl !== undefined ? { canonicalUrl: duplicateResult.canonicalUrl } : {}),
    count: duplicateResult.duplicateCount,
    firstSeenStep: duplicateResult.matchedPriorStep ?? stepIndex,
    lastSeenStep: stepIndex,
    ...(duplicateResult.matchedPriorStep !== undefined
      ? { matchedPriorStep: duplicateResult.matchedPriorStep }
      : {}),
    updatedAt: new Date().toISOString(),
  };
  const next = [...ledger];
  const existingIndex = next.findIndex((entry) => entry.fingerprint === nextEntry.fingerprint);
  if (existingIndex === -1) {
    next.unshift(nextEntry);
    return next;
  }
  const existing = next[existingIndex];
  if (existing === undefined) {
    next.unshift(nextEntry);
    return next;
  }
  next.splice(existingIndex, 1, {
    ...existing,
    ...nextEntry,
    count: Math.max(existing.count, nextEntry.count),
    firstSeenStep: Math.min(existing.firstSeenStep, nextEntry.firstSeenStep),
    lastSeenStep: Math.max(existing.lastSeenStep, nextEntry.lastSeenStep),
  });
  return next;
}

function estimateEvidenceCount(value: unknown, toolName?: string | undefined): number {
  const internetDiagnostics = readWebExtractionDiagnostics(toolName, value);
  if (internetDiagnostics !== undefined) {
    const content = asString(asRecord(value)?.content) ?? "";
    if (internetDiagnostics.lowYield) {
      return Math.max(0, Math.floor(content.length / 800));
    }
    return Math.max(1, Math.floor(content.length / 400));
  }

  if (Array.isArray(value)) {
    return value.length;
  }
  const record = asRecord(value);
  if (record === undefined) {
    return 0;
  }
  const resultKeys = Object.keys(record);
  if (resultKeys.length === 0) {
    return 0;
  }
  let count = 0;
  for (const key of resultKeys) {
    const entry = record[key];
    if (Array.isArray(entry)) {
      count += entry.length;
      continue;
    }
    if (entry !== null && typeof entry === "object") {
      count += Object.keys(asRecord(entry) ?? {}).length;
      continue;
    }
    count += 1;
  }
  return count;
}

function buildWebExtractionRetrySummary(input: {
  prior: unknown;
  objective: string | undefined;
  toolName?: string | undefined;
  output: unknown;
  action?: unknown;
}): WebExtractionRetrySummary | undefined {
  let summary = updateWebExtractionRetrySummary({
    prior: input.prior,
    objective: input.objective,
    toolName: input.toolName ?? readPrimaryToolName(input.output),
    output: input.output,
    action: input.action,
  });
  const record = asRecord(input.output);
  const items = asArray(record?.items);
  for (const entry of items) {
    const item = asRecord(entry);
    const itemName = asString(item?.name);
    if (itemName === undefined) {
      continue;
    }
    summary = updateWebExtractionRetrySummary({
      prior: summary,
      objective: input.objective,
      toolName: itemName,
      output: item?.output,
    }) ?? summary;
  }
  return summary;
}

function readPrimaryToolName(value: unknown): string | undefined {
  const record = asRecord(value);
  const items = asArray(record?.items);
  const firstItem = asRecord(items[0]);
  return asString(firstItem?.name);
}

interface ToolFeedbackInput {
  toolName: string;
  stepIndex?: number | undefined;
  input?: Record<string, unknown> | undefined;
  inputHash?: string | undefined;
  output?: unknown;
  capabilityClasses: string[];
  reused?: boolean | undefined;
  status?: "ok" | "partial" | "cached" | "failed" | undefined;
}

export function buildToolActionResultFeedback(input: ToolFeedbackInput): Record<string, unknown> {
  const status = input.status ?? inferToolFeedbackStatus(input.output);
  const outputSummary = input.output === undefined
    ? undefined
    : summarizeText(safeSerialize(input.output), MAX_TOOL_DIGEST_TEXT_PREVIEW_CHARS);
  const errorInfo = status === "failed" ? readToolFeedbackError(input.output) : undefined;
  return {
    ok: status !== "failed",
    kind: "tool",
    status,
    name: input.toolName,
    toolName: input.toolName,
    capabilityClasses: input.capabilityClasses,
    ...(input.stepIndex !== undefined ? { stepIndex: input.stepIndex } : {}),
    ...(input.input !== undefined ? { input: input.input } : {}),
    ...(input.inputHash !== undefined ? { inputHash: input.inputHash } : {}),
    ...(input.output !== undefined ? { output: input.output } : {}),
    ...(outputSummary !== undefined ? { outputSummary } : {}),
    ...(errorInfo !== undefined ? { error: errorInfo } : {}),
    ...(input.reused !== undefined ? { reused: input.reused } : {}),
    ts: new Date().toISOString(),
  };
}

export function appendToolObservation(
  reactState: Record<string, unknown>,
  input: ToolFeedbackInput,
): unknown[] {
  return appendToolObservations(reactState, [input]);
}

export function appendToolObservations(
  reactState: Record<string, unknown>,
  inputs: ToolFeedbackInput[],
): unknown[] {
  const appended = inputs.map((input) => {
    const feedback = buildToolActionResultFeedback(input);
    const { output: _output, input: _input, ...compact } = feedback;
    const compactInput = compactToolObservationInput(input.toolName, input.input);
    const compactOutput = compactToolObservationOutput(input.toolName, input.output);
    return {
      ...compact,
      kind: "tool_observation",
      ...(compactInput !== undefined ? { input: compactInput } : {}),
      ...(compactOutput !== undefined ? { output: compactOutput } : {}),
      outputRef: asString(asRecord(input.output)?.digestArtifactId) ??
        asArray(asRecord(input.output)?.artifactIds).map((item) => asString(item)).find((item) => item !== undefined),
    };
  });
  return [...asArray(reactState.observations), ...appended].slice(-30);
}

function compactToolObservationInput(
  toolName: string,
  input: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (input === undefined) {
    return ;
  }
  if (toolName === "fs.search_text") {
    return pickDefined({
      path: asString(input.path),
      query: asString(input.query),
      glob: asString(input.glob),
      caseSensitive: typeof input.caseSensitive === "boolean" ? input.caseSensitive : undefined,
      maxResults: typeof input.maxResults === "number" ? Math.trunc(input.maxResults) : undefined,
      maxPreviewChars: typeof input.maxPreviewChars === "number" ? Math.trunc(input.maxPreviewChars) : undefined,
      maxTotalPreviewChars: typeof input.maxTotalPreviewChars === "number" ? Math.trunc(input.maxTotalPreviewChars) : undefined,
    });
  }
  if (toolName === "fs.replace_text") {
    return pickDefined({
      path: asString(input.path),
      ...compactObservationString("find", asString(input.find)),
      ...compactObservationString("replace", asString(input.replace)),
      all: typeof input.all === "boolean" ? input.all : undefined,
    });
  }
  if (toolName === "fs.write_text") {
    const content = asString(input.content);
    return pickDefined({
      path: asString(input.path),
      mode: asString(input.mode),
      createParents: typeof input.createParents === "boolean" ? input.createParents : undefined,
      ...(content !== undefined
        ? {
            contentBytes: Buffer.byteLength(content, "utf8"),
            ...compactObservationString("contentPreview", content),
          }
        : {}),
    });
  }
  if (isDevShellLifecycleTool(toolName)) {
    const lifecycle = normalizeDevShellLifecycle(toolName, input, undefined);
    return pickDefined({
      command: lifecycle?.command ?? asString(input.command),
      cwd: lifecycle?.cwd ?? asString(input.cwd),
      workspaceRoot: lifecycle?.workspaceRoot ?? asString(input.workspaceRoot),
      processId: lifecycle?.processId ?? asString(input.processId),
      sessionId: lifecycle?.sessionId,
      stdin: lifecycle?.stdin !== undefined ? summarizeText(lifecycle.stdin, 240) : undefined,
      timeoutMs: typeof input.timeoutMs === "number" ? Math.trunc(input.timeoutMs) : undefined,
      maxOutputBytes: typeof input.maxOutputBytes === "number" ? Math.trunc(input.maxOutputBytes) : undefined,
      maxBytes: typeof input.maxBytes === "number" ? Math.trunc(input.maxBytes) : undefined,
    });
  }
  return ;
}

function compactToolObservationOutput(
  toolName: string,
  output: unknown,
): Record<string, unknown> | undefined {
  const record = asRecord(output);
  if (record === undefined) {
    return ;
  }
  if (toolName === "fs.search_text") {
    const matches = asArray(record.matches);
    return pickDefined({
      path: asString(record.path),
      query: asString(record.query),
      matchCount: typeof record.matchCount === "number" ? Math.trunc(record.matchCount) : Array.isArray(record.matches) ? matches.length : undefined,
      returnedMatchCount: typeof record.returnedMatchCount === "number" ? Math.trunc(record.returnedMatchCount) : undefined,
      truncated: typeof record.truncated === "boolean" ? record.truncated : undefined,
      previewTruncatedCount: typeof record.previewTruncatedCount === "number" ? Math.trunc(record.previewTruncatedCount) : undefined,
      totalPreviewChars: typeof record.totalPreviewChars === "number" ? Math.trunc(record.totalPreviewChars) : undefined,
      maxPreviewChars: typeof record.maxPreviewChars === "number" ? Math.trunc(record.maxPreviewChars) : undefined,
      maxTotalPreviewChars: typeof record.maxTotalPreviewChars === "number" ? Math.trunc(record.maxTotalPreviewChars) : undefined,
      matches: Array.isArray(record.matches)
        ? matches
            .slice(0, 6)
            .map((match) => asRecord(match))
            .filter((match): match is Record<string, unknown> => match !== undefined)
            .map((match) => pickDefined({
              path: asString(match.path),
              line: typeof match.line === "number" ? Math.trunc(match.line) : undefined,
              column: typeof match.column === "number" ? Math.trunc(match.column) : undefined,
              ...compactObservationString("preview", asString(match.preview)),
            }))
        : undefined,
      matchesTruncated: Array.isArray(record.matches) ? matches.length > 6 : undefined,
    });
  }
  if (toolName === "fs.replace_text") {
    return pickDefined({
      path: asString(record.path),
      replacements: typeof record.replacements === "number" ? Math.trunc(record.replacements) : undefined,
      changed: typeof record.changed === "boolean" ? record.changed : undefined,
      status: asString(record.status),
      message: asString(record.message),
      findWhitespaceTokenCount: typeof record.findWhitespaceTokenCount === "number"
        ? Math.trunc(record.findWhitespaceTokenCount)
        : undefined,
      replaceWhitespaceTokenCount: typeof record.replaceWhitespaceTokenCount === "number"
        ? Math.trunc(record.replaceWhitespaceTokenCount)
        : undefined,
      perReplacementWhitespaceTokenDelta: typeof record.perReplacementWhitespaceTokenDelta === "number"
        ? Math.trunc(record.perReplacementWhitespaceTokenDelta)
        : undefined,
      bytesBefore: typeof record.bytesBefore === "number" ? Math.trunc(record.bytesBefore) : undefined,
      bytesAfter: typeof record.bytesAfter === "number" ? Math.trunc(record.bytesAfter) : undefined,
      lineCountBefore: typeof record.lineCountBefore === "number" ? Math.trunc(record.lineCountBefore) : undefined,
      lineCountAfter: typeof record.lineCountAfter === "number" ? Math.trunc(record.lineCountAfter) : undefined,
      whitespaceTokenCountBefore: typeof record.whitespaceTokenCountBefore === "number"
        ? Math.trunc(record.whitespaceTokenCountBefore)
        : undefined,
      whitespaceTokenCountAfter: typeof record.whitespaceTokenCountAfter === "number"
        ? Math.trunc(record.whitespaceTokenCountAfter)
        : undefined,
      lineCountDelta: typeof record.lineCountDelta === "number" ? Math.trunc(record.lineCountDelta) : undefined,
      whitespaceTokenCountDelta: typeof record.whitespaceTokenCountDelta === "number"
        ? Math.trunc(record.whitespaceTokenCountDelta)
        : undefined,
    });
  }
  if (toolName === "fs.write_text") {
    return pickDefined({
      path: asString(record.path),
      mode: asString(record.mode),
      bytesWritten: typeof record.bytesWritten === "number" ? Math.trunc(record.bytesWritten) : undefined,
      existed: typeof record.existed === "boolean" ? record.existed : undefined,
      changed: typeof record.changed === "boolean" ? record.changed : undefined,
      bytesBefore: typeof record.bytesBefore === "number" ? Math.trunc(record.bytesBefore) : undefined,
      bytesAfter: typeof record.bytesAfter === "number" ? Math.trunc(record.bytesAfter) : undefined,
      lineCountBefore: typeof record.lineCountBefore === "number" ? Math.trunc(record.lineCountBefore) : undefined,
      lineCountAfter: typeof record.lineCountAfter === "number" ? Math.trunc(record.lineCountAfter) : undefined,
      whitespaceTokenCountBefore: typeof record.whitespaceTokenCountBefore === "number"
        ? Math.trunc(record.whitespaceTokenCountBefore)
        : undefined,
      whitespaceTokenCountAfter: typeof record.whitespaceTokenCountAfter === "number"
        ? Math.trunc(record.whitespaceTokenCountAfter)
        : undefined,
      ...compactDiffPreviewObservation(asRecord(record.diffPreview)),
    });
  }
  const lifecycle = normalizeDevShellLifecycle(toolName, undefined, record);
  if (lifecycle !== undefined) {
    return pickDefined({
      command: lifecycle.command ?? asString(record.command),
      cwd: lifecycle.cwd ?? asString(record.cwd),
      workspaceRoot: lifecycle.workspaceRoot ?? asString(record.workspaceRoot),
      processId: lifecycle.processId ?? asString(record.processId),
      sessionId: lifecycle.sessionId,
      status: lifecycle.status ?? asString(record.status),
      exitCode: lifecycle.exitCode ?? (typeof record.exitCode === "number" ? Math.trunc(record.exitCode) : undefined),
      signal: asString(record.signal),
      changedFiles: readChangedFiles(record).length > 0 ? readChangedFiles(record) : undefined,
      cursor: lifecycle.cursor,
      truncated: lifecycle.truncated,
      ...compactObservationString("textPreview", lifecycle.outputText ?? asString(record.text)),
      ...compactObservationString("stdoutPreview", asString(record.stdout)),
      ...compactObservationString("stderrPreview", asString(record.stderr)),
      ...compactObservationString("chunkPreview", asString(record.chunk)),
    });
  }
  return ;
}

function compactDiffPreviewObservation(
  diffPreview: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (diffPreview === undefined) {
    return {};
  }
  return {
    ...compactObservationString("diffPreviewBefore", asString(diffPreview.before)),
    ...compactObservationString("diffPreviewAfter", asString(diffPreview.after)),
    diffPreviewTruncated: typeof diffPreview.truncated === "boolean" ? diffPreview.truncated : undefined,
  };
}

function compactObservationString(
  key: string,
  value: string | undefined,
): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  return {
    [key]: summarizeText(value, MAX_OBSERVATION_TEXT_PREVIEW_CHARS),
    ...(value.length > MAX_OBSERVATION_TEXT_PREVIEW_CHARS ? { [`${key}Truncated`]: true } : {}),
  };
}

function pickDefined(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

export function capabilityEvidenceFromAgentFeedback(reactState: Record<string, unknown>): CapabilityEvidenceSnapshot {
  const snapshot: CapabilityEvidenceSnapshot = {};
  const ingest = (record: Record<string, unknown> | undefined): void => {
    if (record === undefined) {
      return;
    }
    const toolName = asString(record.toolName) ?? asString(record.name);
    if (toolName === undefined) {
      return;
    }
    const stepIndex = typeof record.stepIndex === "number" ? record.stepIndex : 0;
    const ts = asString(record.ts) ?? new Date(0).toISOString();
    for (const capability of asArray(record.capabilityClasses)) {
      if (typeof capability !== "string") {
        continue;
      }
      const normalized = capability.trim();
      if (normalized.length === 0 || snapshot[normalized] !== undefined) {
        continue;
      }
      snapshot[normalized] = {
        tool: toolName,
        stepIndex,
        ts,
      };
    }
  };
  for (const observation of asArray(reactState.observations)) {
    ingest(asRecord(observation));
  }
  const lastActionResult = asRecord(reactState.lastActionResult);
  ingest(lastActionResult);
  for (const item of asArray(lastActionResult?.items)) {
    ingest(asRecord(item));
  }
  return snapshot;
}

function latestFeedbackSummary(reactState: Record<string, unknown>): string | undefined {
  const lastActionResult = asRecord(reactState.lastActionResult);
  const direct =
    asString(lastActionResult?.outputSummary) ??
    asString(lastActionResult?.message) ??
    asString(asRecord(lastActionResult?.error)?.message);
  if (direct !== undefined) {
    return direct;
  }
  const observations = asArray(reactState.observations);
  const latest = asRecord(observations[observations.length - 1]);
  return asString(latest?.outputSummary) ?? asString(asRecord(latest?.error)?.message);
}

function inferToolFeedbackStatus(output: unknown): "ok" | "failed" {
  const record = asRecord(output);
  const status = asString(record?.status);
  if (status === "FAILED" || status === "failed" || record?.recoverable === false) {
    return "failed";
  }
  return "ok";
}

function readToolFeedbackError(output: unknown): Record<string, unknown> | undefined {
  const record = asRecord(output);
  if (record === undefined) {
    return ;
  }
  const error = asRecord(record.error);
  if (error !== undefined) {
    return error;
  }
  const message = asString(record.message);
  const code = asString(record.errorCode);
  if (message === undefined && code === undefined) {
    return ;
  }
  return {
    ...(code !== undefined ? { code } : {}),
    ...(message !== undefined ? { message } : {}),
  };
}

export function nextCapabilityEvidence(
  value: unknown,
  toolClasses: Array<{ toolName: string; classes: string[] }>,
  stepIndex: number,
): CapabilityEvidenceSnapshot {
  const baseline = asRecord(value) ?? {};
  const next: CapabilityEvidenceSnapshot = {};

  for (const [capability, rawMeta] of Object.entries(baseline)) {
    const meta = asRecord(rawMeta);
    const tool = asString(meta?.tool);
    const existingStep =
      typeof meta?.stepIndex === "number" ? meta.stepIndex : undefined;
    const ts = asString(meta?.ts);
    if (tool === undefined || existingStep === undefined || ts === undefined) {
      continue;
    }
    next[capability] = {
      tool,
      stepIndex: existingStep,
      ts,
    };
  }

  const now = new Date().toISOString();
  for (const entry of toolClasses) {
    for (const capability of entry.classes) {
      const normalized = capability.trim();
      if (normalized.length === 0) {
        continue;
      }
      if (next[normalized] !== undefined) {
        continue;
      }
      next[normalized] = {
        tool: entry.toolName,
        stepIndex,
        ts: now,
      };
    }
  }

  return next;
}

function readDevShellChunkBytes(record: Record<string, unknown> | undefined): number {
  const chunkBytes =
    typeof record?.chunkBytes === "number" && Number.isFinite(record.chunkBytes)
      ? Math.max(0, Math.trunc(record.chunkBytes))
      : undefined;
  if (chunkBytes !== undefined) {
    return chunkBytes;
  }
  const chunk = asString(record?.text) ?? asString(record?.chunk) ?? asString(record?.output) ?? "";
  return Buffer.byteLength(chunk, "utf8");
}


function normalizeDevShellCommandContext(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (record === undefined) {
    return ;
  }
  const command = asString(record.command);
  const cwd = asString(record.cwd);
  const workspaceRoot = asString(record.workspaceRoot);
  const envMode = asString(record.envMode);
  const sourceMutation = asString(record.sourceMutation);
  const requiredTools = asArray(record.requiredTools)
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
  const envNames = asArray(record.envNames)
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
  const context: Record<string, unknown> = {
    ...(command !== undefined ? { command } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
    ...(envMode !== undefined ? { envMode } : {}),
    ...(sourceMutation !== undefined ? { sourceMutation } : {}),
    ...(requiredTools.length > 0 ? { requiredTools } : {}),
    ...(envNames.length > 0 ? { envNames } : {}),
  };
  return Object.keys(context).length > 0 ? context : undefined;
}


function readDevShellCommandSegments(command: unknown): string[] {
  if (typeof command !== "string") {
    return [];
  }
  return command
    .split("&&")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .slice(0, 12);
}


const MAX_DEV_SHELL_RECENT_COMMANDS = 24;

function readDevShellRecentCommands(value: unknown): string[] {
  return asArray(value)
    .map((item) => asString(item)?.trim())
    .filter((item): item is string => item !== undefined && item.length > 0)
    .slice(-MAX_DEV_SHELL_RECENT_COMMANDS);
}


function appendRecentDevShellCommand(previous: string[], command: string): string[] {
  const next = [...previous, command.trim()].filter((entry) => entry.length > 0);
  return next.slice(-MAX_DEV_SHELL_RECENT_COMMANDS);
}
