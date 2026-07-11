import { createHash } from "node:crypto";

import type { ToolExecutionClass } from "../../../src/mode/contracts.js";
import { asArray, asRecord, asString } from "../../shared/valueAccess.js";

export type FilesystemInspectionToolName = "fs.list" | "fs.read_text" | "fs.search_text";

export interface FilesystemInspectionCacheEntry {
  key: string;
  toolName: FilesystemInspectionToolName;
  inputHash?: string | undefined;
  input: Record<string, unknown>;
  output: unknown;
  stepIndex: number;
  updatedAt: string;
}

const MAX_FILESYSTEM_INSPECTION_CACHE_ENTRIES = 24;

export function normalizeFilesystemInspectionPath(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim().replace(/\\/gu, "/");
  if (trimmed.length === 0) {
    return undefined;
  }
  const withoutPrefix = trimmed.replace(/^(?:\.\/)+/u, "");
  const collapsed = withoutPrefix.replace(/\/+/gu, "/").replace(/\/$/u, "");
  return collapsed.length === 0 ? "." : collapsed;
}

export function buildFilesystemInspectionPathKey(
  toolName: string,
  pathValue: string | undefined,
): string | undefined {
  const normalizedPath = normalizeFilesystemInspectionPath(pathValue);
  return normalizedPath !== undefined ? `${toolName}:${normalizedPath}` : undefined;
}

export function isFilesystemInspectionToolName(toolName: string): toolName is FilesystemInspectionToolName {
  return toolName === "fs.list" || toolName === "fs.read_text" || toolName === "fs.search_text";
}

export function buildFilesystemInspectionActionKey(
  toolName: string,
  input: Record<string, unknown> | undefined,
): string | undefined {
  if (isFilesystemInspectionToolName(toolName) === false) {
    return undefined;
  }
  const normalizedPath = normalizeFilesystemInspectionPath(asString(input?.path) ?? ".");
  if (normalizedPath === undefined) {
    return undefined;
  }
  if (toolName === "fs.list") {
    return buildStableInspectionKey(toolName, {
      path: normalizedPath,
      includeHidden: input?.includeHidden === true,
      recursive: input?.recursive === true,
      maxDepth: normalizeNonNegativeInt(input?.maxDepth),
    });
  }
  if (toolName === "fs.read_text") {
    return buildStableInspectionKey(toolName, {
      path: normalizedPath,
      maxBytes: normalizePositiveInt(input?.maxBytes),
    });
  }
  return buildStableInspectionKey(toolName, {
    path: normalizedPath,
    query: asString(input?.query) ?? "",
    pattern: asString(input?.pattern),
    glob: asString(input?.glob),
    caseSensitive: input?.caseSensitive === true,
    maxResults: normalizeNonNegativeInt(input?.maxResults),
    maxPreviewChars: normalizePositiveInt(input?.maxPreviewChars),
    maxTotalPreviewChars: normalizePositiveInt(input?.maxTotalPreviewChars),
    maxBytes: normalizePositiveInt(input?.maxBytes),
  });
}

export function readFilesystemInspectionCache(
  reactState: Record<string, unknown> | undefined,
): FilesystemInspectionCacheEntry[] {
  return asArray(reactState?.filesystemInspectionCache)
    .map((item) => normalizeFilesystemInspectionCacheEntry(item))
    .filter((item): item is FilesystemInspectionCacheEntry => item !== undefined)
    .slice(-MAX_FILESYSTEM_INSPECTION_CACHE_ENTRIES);
}

export function findReusableFilesystemInspection(input: {
  reactState: Record<string, unknown>;
  toolName: string;
  toolInput: Record<string, unknown>;
}): FilesystemInspectionCacheEntry | undefined {
  const key = buildFilesystemInspectionActionKey(input.toolName, input.toolInput);
  if (key === undefined) {
    return undefined;
  }
  return readFilesystemInspectionCache(input.reactState)
    .slice()
    .reverse()
    .find((entry) => entry.key === key);
}

export function applyFilesystemInspectionCacheAfterToolResult(input: {
  reactState: Record<string, unknown>;
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput: unknown;
  stepIndex: number;
  inputHash?: string | undefined;
  executionClass?: ToolExecutionClass | undefined;
}): FilesystemInspectionCacheEntry[] | undefined {
  if (isFilesystemInspectionCacheInvalidatingTool(input.toolName, input.executionClass)) {
    return [];
  }
  if (isFilesystemInspectionToolName(input.toolName) === false) {
    return undefined;
  }
  if (toolOutputIndicatesFailure(input.toolOutput)) {
    return readFilesystemInspectionCache(input.reactState);
  }
  const key = buildFilesystemInspectionActionKey(input.toolName, input.toolInput);
  if (key === undefined) {
    return readFilesystemInspectionCache(input.reactState);
  }
  const nextEntry: FilesystemInspectionCacheEntry = {
    key,
    toolName: input.toolName,
    ...(input.inputHash !== undefined ? { inputHash: input.inputHash } : {}),
    input: input.toolInput,
    output: input.toolOutput,
    stepIndex: input.stepIndex,
    updatedAt: new Date().toISOString(),
  };
  const prior = readFilesystemInspectionCache(input.reactState)
    .filter((entry) => entry.key !== key);
  return [...prior, nextEntry].slice(-MAX_FILESYSTEM_INSPECTION_CACHE_ENTRIES);
}

export function isFilesystemInspectionCacheInvalidatingTool(
  toolName: string,
  executionClass?: ToolExecutionClass | undefined,
): boolean {
  if (
    toolName === "fs.write_text" ||
    toolName === "fs.replace_text" ||
    toolName === "fs.patch_text" ||
    toolName === "fs.delete" ||
    toolName === "fs.mkdir" ||
    toolName === "fs.copy" ||
    toolName === "fs.move"
  ) {
    return true;
  }
  return toolName.startsWith("dev.shell.") && executionClass === "external_side_effect";
}

export function isShellFilesystemInspectionCommand(commandText: string | undefined): boolean {
  if (commandText === undefined) {
    return false;
  }
  const normalized = commandText.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }

  const nonInspectionPatterns = [
    /\bpnpm\s+(test|lint|build|start|dev)\b/u,
    /\bnpm\s+(test|run|start)\b/u,
    /\byarn\s+(test|build|start)\b/u,
    /\bjest\b/u,
    /\bvitest\b/u,
    /\beslint\b/u,
    /\btsc\b/u,
    /\bapply_patch\b/u,
    /\b(writefilesync|appendfilesync|mkdirsync|rm\s|mv\s|cp\s|touch\s)\b/u,
  ];
  if (nonInspectionPatterns.some((pattern) => pattern.test(normalized))) {
    return false;
  }

  const inspectionPatterns = [
    /\bls\b/u,
    /\bfind\b/u,
    /\brg\b/u,
    /\bsed\s+-n\b/u,
    /\bcat\b/u,
    /\breadfilesync\b/u,
    /\breaddirsync\b/u,
    /\bexistssync\b/u,
  ];
  return inspectionPatterns.some((pattern) => pattern.test(normalized));
}

export function buildShellFilesystemInspectionKey(
  commandText: string | undefined,
  workspaceRoot: string | undefined,
): string | undefined {
  if (isShellFilesystemInspectionCommand(commandText) === false) {
    return undefined;
  }
  const normalizedRoot = normalizeFilesystemInspectionPath(workspaceRoot) ?? ".";
  const normalizedTargets = extractShellInspectionTargets(commandText);
  if (normalizedTargets.length > 0) {
    return `shell.inspect:${normalizedRoot}:targets=${normalizedTargets.join(",")}`;
  }
  return `shell.inspect:${normalizedRoot}:cmd=${fingerprintShellInspectionCommand(commandText)}`;
}

function extractShellInspectionTargets(commandText: string | undefined): string[] {
  if (commandText === undefined) {
    return [];
  }

  const rawTargets: string[] = [];
  const patterns = [
    /readFileSync\(\s*["'`]([^"'`]+)["'`]/gu,
    /readdirSync\(\s*["'`]([^"'`]+)["'`]/gu,
    /existsSync\(\s*["'`]([^"'`]+)["'`]/gu,
    /\bcat\s+(?:--\S+\s+)*([^\s;&|]+)/gu,
    /\bsed\s+-n\s+['"][^'"]*['"]\s+([^\s;&|]+)/gu,
    /\bfind\s+([^\s;&|]+)/gu,
    /\bls\s+([^\s;&|]+)/gu,
  ];

  for (const pattern of patterns) {
    for (const match of commandText.matchAll(pattern)) {
      const candidate = typeof match[1] === "string" ? match[1] : undefined;
      if (candidate !== undefined) {
        rawTargets.push(candidate);
      }
    }
  }

  return [...new Set(
    rawTargets
      .map((target) => normalizeFilesystemInspectionPath(stripShellQuotes(target)))
      .filter((target): target is string => target !== undefined),
  )].sort((left, right) => left.localeCompare(right));
}

function fingerprintShellInspectionCommand(commandText: string | undefined): string {
  const normalized = (commandText ?? "").replace(/\s+/gu, " ").trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 12);
}

function buildStableInspectionKey(toolName: FilesystemInspectionToolName, value: Record<string, unknown>): string {
  const normalized = JSON.stringify(sortJsonValue(value));
  return `${toolName}:${createHash("sha256").update(normalized).digest("hex").slice(0, 16)}`;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort((left, right) => left.localeCompare(right))) {
    const item = record[key];
    if (item !== undefined) {
      sorted[key] = sortJsonValue(item);
    }
  }
  return sorted;
}

function normalizePositiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

function normalizeNonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function normalizeFilesystemInspectionCacheEntry(value: unknown): FilesystemInspectionCacheEntry | undefined {
  const record = asRecord(value);
  const key = asString(record?.key);
  const toolName = asString(record?.toolName);
  const input = asRecord(record?.input);
  const stepIndex = typeof record?.stepIndex === "number" && Number.isFinite(record.stepIndex)
    ? Math.trunc(record.stepIndex)
    : undefined;
  const updatedAt = asString(record?.updatedAt);
  if (
    key === undefined ||
    toolName === undefined ||
    isFilesystemInspectionToolName(toolName) === false ||
    input === undefined ||
    record?.output === undefined ||
    stepIndex === undefined ||
    updatedAt === undefined
  ) {
    return undefined;
  }
  return {
    key,
    toolName,
    ...(asString(record?.inputHash) !== undefined ? { inputHash: asString(record?.inputHash) } : {}),
    input,
    output: record.output,
    stepIndex,
    updatedAt,
  };
}

function toolOutputIndicatesFailure(output: unknown): boolean {
  const record = asRecord(output);
  const status = asString(record?.status)?.toLowerCase();
  return (
    record?.ok === false ||
    asRecord(record?.error) !== undefined ||
    asString(record?.errorCode) !== undefined ||
    asString(record?.error) !== undefined ||
    status === "failed" ||
    status === "failure" ||
    status === "error" ||
    status === "lost" ||
    status === "denied"
  );
}

function stripShellQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
