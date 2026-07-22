import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import {
  access,
  constants as fsConstants,
  lstat,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  ApprovalCapabilityClass,
  ToolExecutionClass,
} from "../../src/mode/contracts.js";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import type {
  FileSystemToolPolicyConfig,
  SharedToolContext,
  ToolCapabilityMetadata,
  ToolPresentationMetadata,
} from "../contracts.js";
import { asRecord, readNumber, readString, requireStringField } from "../helpers.js";

export const FILESYSTEM_TOOL_NAMES = [
  "fs.list",
  "fs.read_text",
  "fs.create_text",
  "fs.edit_text",
  "fs.apply_patch",
  "fs.verify_json",
  "fs.search_text",
  "repo.trace",
  "fs.write_text",
  "fs.replace_text",
  "fs.mkdir",
  "fs.copy",
  "fs.move",
  "fs.delete",
] as const;

export const DEFAULT_FILE_READ_MAX_BYTES = 64 * 1024;
export const MAX_FILE_READ_BYTES = 1024 * 1024;
export const MAX_TEXT_EDIT_BYTES = 1024 * 1024;
export const DEFAULT_SEARCH_MAX_RESULTS = 20;
export const DEFAULT_SEARCH_MAX_PREVIEW_CHARS = 240;
export const DEFAULT_SEARCH_MAX_TOTAL_PREVIEW_CHARS = 12_000;
export const DEFAULT_LIST_MAX_DEPTH = 5;
export const MAX_LIST_ENTRIES = 1000;
export const MAX_JSON_VERIFICATION_REQUIREMENTS = 200;
export const MAX_JSON_VERIFICATION_FAILURES = 100;
export const MIN_SEARCH_MAX_PREVIEW_CHARS = 40;
export const MAX_SEARCH_MAX_PREVIEW_CHARS = 1000;
export const MIN_SEARCH_MAX_TOTAL_PREVIEW_CHARS = 1000;
export const MAX_SEARCH_MAX_TOTAL_PREVIEW_CHARS = 64_000;

interface ResolvedFileSystemPolicy {
  workspaceRoot: string;
  tempRoots: string[];
  allowedRoots: string[];
}

export interface ResolvedExistingPath {
  absolutePath: string;
  realPath: string;
  displayPath: string;
  lstat: Awaited<ReturnType<typeof lstat>>;
  stat: Awaited<ReturnType<typeof stat>>;
}

export interface ResolvedTargetPath {
  absolutePath: string;
  displayPath: string;
}

export interface FileSystemListEntry {
  path: string;
  type: "file" | "directory";
  size: number;
  mtime: string;
}

export interface FileSystemListResult {
  path: string;
  entries: FileSystemListEntry[];
  entryCount: number;
  truncated: boolean;
  maxEntries: number;
  empty: boolean;
  includeHidden: boolean;
  recursive: boolean;
  maxDepth: number;
  message?: string | undefined;
  omittedHiddenEntryCount?: number | undefined;
  directoryFacts?: FileSystemDirectoryFacts | undefined;
}

export interface FileSystemDirectoryFacts {
  visibleEntryCount: number;
  hiddenEntryCount: number;
  hasGitRepository: boolean;
  gitRepository?: FileSystemGitRepositoryFacts | undefined;
  classification?: "empty_git_repository" | undefined;
}

export interface FileSystemGitRepositoryFacts {
  present: boolean;
  initialized: boolean;
  headKind?: "branch" | "detached" | "unborn" | "unknown" | undefined;
  currentBranch?: string | undefined;
  hasHeadCommit?: boolean | undefined;
  hasIndex: boolean;
  latestMetadataMtime?: string | undefined;
}

export interface FileSystemSearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
  previewTruncated?: boolean | undefined;
  previewChars?: number | undefined;
}

export interface FileSystemSearchResult {
  matches: FileSystemSearchMatch[];
  matchCount: number;
  returnedMatchCount: number;
  truncated: boolean;
  previewTruncatedCount: number;
  totalPreviewChars: number;
  maxPreviewChars: number;
  maxTotalPreviewChars: number;
}

export interface TextStats {
  bytes: number;
  lines: number;
  whitespaceTokens: number;
}

export function withDefaultFileSystemPolicy(
  context: SharedToolContext | undefined,
): SharedToolContext {
  if (context?.fileSystem !== undefined) {
    return {
      ...context,
      fileSystem: resolveFileSystemPolicy(context.fileSystem),
    };
  }

  return {
    ...(context ?? {}),
    fileSystem: createDefaultFileSystemPolicy(),
  };
}

export function createDefaultFileSystemPolicy(): FileSystemToolPolicyConfig {
  return {
    workspaceRoot: process.cwd(),
    tempRoots: [os.tmpdir()],
  };
}

export function resolveFileSystemPolicy(
  config: FileSystemToolPolicyConfig | undefined,
): FileSystemToolPolicyConfig {
  const fallback = createDefaultFileSystemPolicy();
  return {
    workspaceRoot:
      typeof config?.workspaceRoot === "string" && config.workspaceRoot.length > 0
        ? path.resolve(config.workspaceRoot)
        : path.resolve(fallback.workspaceRoot),
    tempRoots:
      Array.isArray(config?.tempRoots) && config.tempRoots.length > 0
        ? config.tempRoots.map((item) => path.resolve(item))
        : fallback.tempRoots.map((item) => path.resolve(item)),
  };
}

export function readBoolean(
  value: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  if (value === undefined) {
    return ;
  }

  const maybe = value[key];
  return typeof maybe === "boolean" ? maybe : undefined;
}

export function readRequiredPath(
  input: Record<string, unknown> | undefined,
  key: string,
  toolName: string,
): string {
  return requireStringField(toolName, input, key);
}

export function readOptionalPositiveInt(
  input: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = readNumber(input, key);
  if (value === undefined || Number.isFinite(value) === false) {
    return ;
  }

  const normalized = Math.trunc(value);
  return normalized > 0 ? normalized : undefined;
}

export function readOptionalBoundedPositiveInt(
  input: Record<string, unknown> | undefined,
  key: string,
  min: number,
  max: number,
): number | undefined {
  const value = readOptionalPositiveInt(input, key);
  if (value === undefined) {
    return ;
  }
  return Math.min(Math.max(value, min), max);
}

export function clampPositiveInt(value: number, max: number): number {
  if (Number.isFinite(value) === false) {
    return max;
  }
  return Math.min(Math.max(1, Math.trunc(value)), max);
}

export function buildUtf8TextStats(content: string): TextStats {
  let lines = content.length === 0 ? 0 : 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") {
      lines += 1;
    }
  }

  let whitespaceTokens = 0;
  const tokenPattern = /\S+/gu;
  while (tokenPattern.exec(content) !== null) {
    whitespaceTokens += 1;
  }

  return {
    bytes: Buffer.byteLength(content, "utf8"),
    lines,
    whitespaceTokens,
  };
}

export function readOptionalNonNegativeInt(
  input: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = readNumber(input, key);
  if (value === undefined || Number.isFinite(value) === false) {
    return ;
  }

  const normalized = Math.trunc(value);
  return normalized >= 0 ? normalized : undefined;
}

export function parseFileSystemInput(input: unknown): Record<string, unknown> {
  return asRecord(input) ?? {};
}

export function createFileSystemCapability(
  capabilityClass: string,
  executionClass: ToolExecutionClass,
): ToolCapabilityMetadata {
  const approvalCapability: ApprovalCapabilityClass =
    executionClass === "read_only" ? "workspace.read" : "workspace.write";
  return {
    freshnessClass: "volatile",
    latencyClass: "low",
    costClass: "free",
    executionClass,
    capabilityClasses: [capabilityClass],
    approvalCapabilities: [approvalCapability],
  };
}

export function createFileSystemPresentation(input: {
  displayName: string;
  aliases: string[];
  keywords: string[];
}): ToolPresentationMetadata {
  return {
    displayName: input.displayName,
    aliases: [...input.aliases],
    keywords: [...input.keywords],
    provider: "kestrel",
    toolFamily: "filesystem",
  };
}

export async function resolveExistingFileSystemPath(
  inputPath: string,
  config: FileSystemToolPolicyConfig | undefined,
): Promise<ResolvedExistingPath> {
  const policy = await resolvePolicy(config);
  const absolutePath = resolveAbsolutePath(inputPath, policy);
  const realPathValue = await safeRealPath(absolutePath);
  if (realPathValue === undefined) {
    throw createFileSystemFailure("TOOL_INPUT_INVALID", `Path does not exist: ${normalizeDisplayPath(absolutePath, policy)}`, {
      path: normalizeDisplayPath(absolutePath, policy),
      classification: "schema",
      recoverable: true,
    });
  }

  assertAllowedRealPath(realPathValue, policy);
  const entryLstat = await lstat(absolutePath);
  const entryStat = entryLstat.isSymbolicLink() ? await stat(absolutePath) : entryLstat;

  return {
    absolutePath,
    realPath: realPathValue,
    displayPath: normalizeDisplayPath(absolutePath, policy),
    lstat: entryLstat,
    stat: entryStat,
  };
}

export async function resolveTargetFileSystemPath(
  inputPath: string,
  config: FileSystemToolPolicyConfig | undefined,
): Promise<ResolvedTargetPath> {
  const policy = await resolvePolicy(config);
  const absolutePath = resolveAbsolutePath(inputPath, policy);
  const existingAncestor = await findNearestExistingAncestor(absolutePath);
  assertAllowedRealPath(existingAncestor.realPath, policy);

  return {
    absolutePath,
    displayPath: normalizeDisplayPath(absolutePath, policy),
  };
}

export function assertWorkspaceSkillStateMutationAllowed(input: {
  absolutePath: string;
  config: FileSystemToolPolicyConfig | undefined;
  toolName: string;
  destructive?: boolean | undefined;
}): void {
  const policy = resolveFileSystemPolicy(input.config);
  const candidate = path.resolve(input.absolutePath);
  const protectedRoot = path.join(policy.workspaceRoot, ".kestrel", "skills");
  if (
    isWithinRoot(candidate, protectedRoot) ||
    (input.destructive === true && isWithinRoot(protectedRoot, candidate))
  ) {
    throw createFileSystemFailure(
      "WORKSPACE_SKILL_STATE_PROTECTED",
      `${input.toolName} cannot modify Kestrel-owned workspace skill state.`,
      {
        path: normalizeDisplayPath(candidate, policy),
        classification: "policy",
        recoverable: false,
      },
    );
  }
}

export async function ensureParentDirectory(
  targetPath: string,
  config: FileSystemToolPolicyConfig | undefined,
): Promise<void> {
  const parentPath = path.dirname(targetPath);
  const resolved = await resolveExistingFileSystemPath(parentPath, config);
  if (resolved.stat.isDirectory() === false) {
    throw createFileSystemFailure("TOOL_INPUT_INVALID", `Parent path is not a directory: ${resolved.displayPath}`, {
      path: resolved.displayPath,
      classification: "schema",
      recoverable: true,
    });
  }
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function ensureOverwriteAllowed(
  exists: boolean,
  destinationPath: string,
  overwrite: boolean,
): void {
  if (exists && overwrite === false) {
    throw createFileSystemFailure("TOOL_INPUT_INVALID", `Destination already exists: ${destinationPath}`, {
      path: destinationPath,
      classification: "schema",
      recoverable: true,
    });
  }
}

export async function prepareDestinationForMutation(input: {
  sourcePath: ResolvedExistingPath;
  destinationPath: ResolvedTargetPath;
  config: FileSystemToolPolicyConfig | undefined;
  overwrite: boolean;
}): Promise<void> {
  await ensureParentDirectory(input.destinationPath.absolutePath, input.config);

  const exists = await pathExists(input.destinationPath.absolutePath);
  if (exists === false) {
    if (input.sourcePath.absolutePath === input.destinationPath.absolutePath) {
      throw createFileSystemFailure("TOOL_INPUT_INVALID", `Source and destination must differ: ${input.destinationPath.displayPath}`, {
        path: input.destinationPath.displayPath,
        classification: "schema",
        recoverable: true,
      });
    }
    return;
  }

  const existingDestination = await resolveExistingFileSystemPath(
    input.destinationPath.absolutePath,
    input.config,
  );
  if (
    existingDestination.realPath === input.sourcePath.realPath ||
    isWithinRoot(input.sourcePath.realPath, existingDestination.realPath)
  ) {
    throw createFileSystemFailure("TOOL_INPUT_INVALID", `Source and destination must differ: ${input.destinationPath.displayPath}`, {
      path: input.destinationPath.displayPath,
      classification: "schema",
      recoverable: true,
    });
  }

  ensureOverwriteAllowed(true, input.destinationPath.displayPath, input.overwrite);
  await rm(existingDestination.absolutePath, {
    recursive: true,
    force: false,
  });
}

export async function listFileSystemEntries(input: {
  absolutePath: string;
  config: FileSystemToolPolicyConfig | undefined;
  recursive: boolean;
  maxDepth: number;
  includeHidden: boolean;
}): Promise<{ entries: FileSystemListEntry[]; truncated: boolean }> {
  const policy = await resolvePolicy(input.config);
  const root = await resolveExistingFileSystemPath(input.absolutePath, policy);
  const entries: FileSystemListEntry[] = [];
  const visitedDirectories = new Set<string>();
  let truncated = false;

  const addEntry = async (absolutePath: string): Promise<ResolvedExistingPath | undefined> => {
    if (entries.length >= MAX_LIST_ENTRIES) {
      truncated = true;
      return ;
    }

    const resolved = await resolveExistingFileSystemPath(absolutePath, policy);
    entries.push({
      path: normalizeDisplayPath(absolutePath, policy),
      type: resolved.stat.isDirectory() ? "directory" : "file",
      size: Number(resolved.stat.size),
      mtime: resolved.stat.mtime.toISOString(),
    });
    return resolved;
  };

  const visitDirectory = async (absolutePath: string, depth: number): Promise<void> => {
    const resolvedDirectory = await resolveExistingFileSystemPath(absolutePath, policy);
    if (resolvedDirectory.stat.isDirectory() === false) {
      return;
    }
    if (visitedDirectories.has(resolvedDirectory.realPath)) {
      return;
    }
    visitedDirectories.add(resolvedDirectory.realPath);

    const children = await readdir(absolutePath, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));

    for (const child of children) {
      if (input.includeHidden === false && isHiddenName(child.name)) {
        continue;
      }
      const childPath = path.join(absolutePath, child.name);
      const resolvedChild = await addEntry(childPath);
      if (resolvedChild === undefined) {
        break;
      }
      if (input.recursive && resolvedChild.stat.isDirectory() && depth < input.maxDepth) {
        await visitDirectory(childPath, depth + 1);
      }
    }
  };

  if (root.stat.isDirectory() === false) {
    await addEntry(root.absolutePath);
    return { entries, truncated };
  }

  if (input.recursive && input.maxDepth === 0) {
    return { entries, truncated };
  }

  await visitDirectory(root.absolutePath, 1);
  return { entries, truncated };
}

export async function listFileSystemDirectory(input: {
  absolutePath: string;
  config: FileSystemToolPolicyConfig | undefined;
  recursive: boolean;
  maxDepth: number;
  includeHidden: boolean;
}): Promise<FileSystemListResult> {
  const policy = await resolvePolicy(input.config);
  const root = await resolveExistingFileSystemPath(input.absolutePath, policy);
  const listResult = await listFileSystemEntries({
    ...input,
    config: policy,
  });
  const entries = listResult.entries;
  const directoryFacts =
    root.stat.isDirectory() && input.includeHidden === false
      ? await readDirectoryFacts(root.absolutePath, policy)
      : undefined;
  const omittedHiddenEntryCount = directoryFacts?.hiddenEntryCount ?? 0;
  const empty = entries.length === 0;
  const depthLimited = root.stat.isDirectory() && input.recursive && input.maxDepth === 0;
  const message = buildListDirectoryMessage({
    empty,
    depthLimited,
    includeHidden: input.includeHidden,
    directoryFacts,
  });
  return {
    path: root.displayPath,
    entries,
    entryCount: entries.length,
    truncated: listResult.truncated,
    maxEntries: MAX_LIST_ENTRIES,
    empty,
    includeHidden: input.includeHidden,
    recursive: input.recursive,
    maxDepth: input.maxDepth,
    ...(message !== undefined ? { message } : {}),
    ...(omittedHiddenEntryCount > 0 ? { omittedHiddenEntryCount } : {}),
    ...(directoryFacts !== undefined ? { directoryFacts } : {}),
  };
}

async function readDirectoryFacts(
  absolutePath: string,
  policy: FileSystemToolPolicyConfig | undefined,
): Promise<FileSystemDirectoryFacts> {
  const children = await readdir(absolutePath, { withFileTypes: true });
  const visibleEntryCount = children.filter((child) => isHiddenName(child.name) === false).length;
  const hiddenNames = new Set(children.filter((child) => isHiddenName(child.name)).map((child) => child.name));
  const hasGitRepository = hiddenNames.has(".git");
  const gitRepository = hasGitRepository
    ? await readAllowedGitRepositoryFacts(path.join(absolutePath, ".git"), policy)
    : undefined;
  const classification =
    visibleEntryCount === 0 && hasGitRepository
      ? "empty_git_repository"
      : undefined;
  return {
    visibleEntryCount,
    hiddenEntryCount: hiddenNames.size,
    hasGitRepository,
    ...(gitRepository !== undefined ? { gitRepository } : {}),
    ...(classification !== undefined ? { classification } : {}),
  };
}

async function readAllowedGitRepositoryFacts(
  gitPath: string,
  policy: FileSystemToolPolicyConfig | undefined,
): Promise<FileSystemGitRepositoryFacts | undefined> {
  try {
    const resolved = await resolveExistingFileSystemPath(gitPath, policy);
    return readGitRepositoryFacts(resolved.absolutePath);
  } catch {
    return ;
  }
}

async function readGitRepositoryFacts(gitPath: string): Promise<FileSystemGitRepositoryFacts> {
  const head = (await readOptionalText(path.join(gitPath, "HEAD")))?.trim();
  const branchRef = head?.match(/^ref:\s+refs\/heads\/(.+)$/u)?.[1]?.trim();
  const detachedCommit = head !== undefined && /^[0-9a-f]{40}$/iu.test(head) ? head : undefined;
  const refPath = branchRef !== undefined ? path.join(gitPath, "refs", "heads", ...branchRef.split("/")) : undefined;
  const branchCommit = refPath !== undefined ? await readOptionalText(refPath) : undefined;
  const packedRefs = branchCommit === undefined && branchRef !== undefined
    ? await readOptionalText(path.join(gitPath, "packed-refs"))
    : undefined;
  const hasPackedBranchRef = packedRefs !== undefined
    ? packedRefs.split(/\r?\n/u).some((line) => line.endsWith(` refs/heads/${branchRef}`))
    : false;
  const hasHeadCommit =
    detachedCommit !== undefined ||
    (branchCommit !== undefined && /^[0-9a-f]{40}$/iu.test(branchCommit.trim())) ||
    hasPackedBranchRef;
  const headKind =
    branchRef !== undefined
      ? hasHeadCommit ? "branch" : "unborn"
      : detachedCommit !== undefined
        ? "detached"
        : head !== undefined
          ? "unknown"
          : undefined;
  const latestMetadataMtime = await latestDirectoryMtime(gitPath);
  return {
    present: true,
    initialized: true,
    ...(headKind !== undefined ? { headKind } : {}),
    ...(branchRef !== undefined ? { currentBranch: branchRef } : {}),
    ...(head !== undefined ? { hasHeadCommit } : {}),
    hasIndex: await pathExists(path.join(gitPath, "index")),
    ...(latestMetadataMtime !== undefined ? { latestMetadataMtime } : {}),
  };
}

async function readOptionalText(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return ;
  }
}

async function latestDirectoryMtime(directoryPath: string): Promise<string | undefined> {
  const latest = await latestDirectoryMtimeValue(directoryPath, 3);
  return latest?.toISOString();
}

async function latestDirectoryMtimeValue(directoryPath: string, maxDepth: number): Promise<Date | undefined> {
  let latest: Date | undefined;
  const visit = async (targetPath: string, depth: number): Promise<void> => {
    let entryStat: Awaited<ReturnType<typeof lstat>>;
    try {
      entryStat = await lstat(targetPath);
    } catch {
      return;
    }
    if (latest === undefined || entryStat.mtime > latest) {
      latest = entryStat.mtime;
    }
    if (entryStat.isDirectory() === false || depth >= maxDepth) {
      return;
    }
    let children: Dirent[];
    try {
      children = await readdir(targetPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      await visit(path.join(targetPath, child.name), depth + 1);
    }
  };
  await visit(directoryPath, 0);
  return latest;
}

function buildListDirectoryMessage(input: {
  empty: boolean;
  depthLimited: boolean;
  includeHidden: boolean;
  directoryFacts?: FileSystemDirectoryFacts | undefined;
}): string | undefined {
  if (input.empty === false) {
    return ;
  }
  if (input.depthLimited) {
    return "No entries were returned because recursive listing was limited to maxDepth 0.";
  }
  if (input.directoryFacts?.classification === "empty_git_repository") {
    return [
      "This directory contains Git repository metadata and no visible project files.",
      describeGitRepositoryFacts(input.directoryFacts.gitRepository),
    ].filter((part) => part !== undefined).join(" ");
  }
  if (input.includeHidden === false && (input.directoryFacts?.hiddenEntryCount ?? 0) > 0) {
    return "This directory has no visible entries. Hidden entries were omitted because includeHidden is false.";
  }
  return "This directory is empty.";
}

function describeGitRepositoryFacts(facts: FileSystemGitRepositoryFacts | undefined): string | undefined {
  if (facts === undefined) {
    return ;
  }
  const branchText = facts.currentBranch !== undefined ? ` on branch ${facts.currentBranch}` : "";
  const headText =
    facts.hasHeadCommit === true
      ? `has a HEAD commit${branchText}`
      : facts.headKind === "unborn"
        ? `has an unborn HEAD${branchText}`
        : "has repository metadata";
  const indexText = facts.hasIndex ? " and an index" : "";
  const mtimeText = facts.latestMetadataMtime !== undefined
    ? ` Latest Git metadata mtime: ${facts.latestMetadataMtime}.`
    : "";
  return `Git state: ${headText}${indexText}.${mtimeText}`;
}

export async function readUtf8TextFile(input: {
  absolutePath: string;
  config: FileSystemToolPolicyConfig | undefined;
  maxBytes: number;
}): Promise<{ content: string; truncated: boolean; displayPath: string; bytesRead: number; maxBytes: number }> {
  const resolved = await resolveExistingFileSystemPath(input.absolutePath, input.config);
  if (resolved.stat.isFile() === false) {
    throw createFileSystemFailure("TOOL_INPUT_INVALID", `Path is not a file: ${resolved.displayPath}`, {
      path: resolved.displayPath,
      classification: "schema",
      recoverable: true,
    });
  }

  const limit = clampPositiveInt(input.maxBytes, MAX_FILE_READ_BYTES);
  const buffer = Buffer.allocUnsafe(limit + 1);
  const handle = await open(resolved.absolutePath, "r");
  let bytesRead = 0;
  try {
    const result = await handle.read(buffer, 0, buffer.byteLength, 0);
    bytesRead = result.bytesRead;
  } finally {
    await handle.close();
  }
  const truncated = bytesRead > limit || Number(resolved.stat.size) > limit;
  const contentBytes = Math.min(bytesRead, limit);
  const content = buffer.subarray(0, contentBytes).toString("utf8");

  return {
    content,
    truncated,
    displayPath: resolved.displayPath,
    bytesRead: contentBytes,
    maxBytes: limit,
  };
}

export async function searchUtf8Text(input: {
  basePath: string;
  query: string;
  glob: string | undefined;
  caseSensitive: boolean;
  maxResults: number;
  maxPreviewChars: number;
  maxTotalPreviewChars: number;
  config: FileSystemToolPolicyConfig | undefined;
}): Promise<FileSystemSearchResult> {
  const policy = await resolvePolicy(input.config);
  const base = await resolveExistingFileSystemPath(input.basePath, policy);
  const boundedResults = Math.max(1, input.maxResults);
  const budget = createSearchResultBudget({
    maxResults: boundedResults,
    maxPreviewChars: input.maxPreviewChars,
    maxTotalPreviewChars: input.maxTotalPreviewChars,
  });
  const ripgrepResults = await searchWithRipgrep({
    absolutePath: base.absolutePath,
    query: input.query,
    glob: input.glob,
    caseSensitive: input.caseSensitive,
    budget,
    policy,
  });
  if (ripgrepResults !== undefined) {
    return ripgrepResults;
  }

  if (base.stat.isDirectory()) {
    throw createFileSystemFailure(
      "TOOL_PROVIDER_FAILED",
      "Directory search requires ripgrep so ignored files and generated artifact roots remain outside the default search scope.",
      {
        path: base.displayPath,
        classification: "runtime",
        recoverable: true,
      },
    );
  }

  return searchInProcess({
    absolutePath: base.absolutePath,
    query: input.query,
    glob: input.glob,
    caseSensitive: input.caseSensitive,
    budget,
    policy,
  });
}

export function normalizeDisplayPath(
  absolutePath: string,
  config: FileSystemToolPolicyConfig | ResolvedFileSystemPolicy,
): string {
  const workspaceRoot = path.resolve(config.workspaceRoot);
  const normalized = path.resolve(absolutePath);
  if (isWithinRoot(normalized, workspaceRoot)) {
    const relativePath = path.relative(workspaceRoot, normalized);
    return relativePath.length === 0 ? "." : relativePath;
  }

  return normalized;
}

function resolveAbsolutePath(
  inputPath: string,
  policy: ResolvedFileSystemPolicy,
): string {
  return path.resolve(
    path.isAbsolute(inputPath) ? inputPath : path.join(policy.workspaceRoot, inputPath),
  );
}

async function resolvePolicy(
  config: FileSystemToolPolicyConfig | undefined,
): Promise<ResolvedFileSystemPolicy> {
  const normalized = resolveFileSystemPolicy(config);
  const roots = [normalized.workspaceRoot, ...normalized.tempRoots];
  const allowedRoots = await Promise.all(
    roots.map(async (root) => {
      const rootRealPath = await safeRealPath(root);
      return rootRealPath ?? path.resolve(root);
    }),
  );

  return {
    workspaceRoot: normalized.workspaceRoot,
    tempRoots: normalized.tempRoots,
    allowedRoots,
  };
}

async function safeRealPath(value: string): Promise<string | undefined> {
  try {
    return await realpath(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return ;
    }
    throw error;
  }
}

async function findNearestExistingAncestor(
  candidatePath: string,
): Promise<{ path: string; realPath: string }> {
  let currentPath = path.resolve(candidatePath);

  while (true) {
    const resolved = await safeRealPath(currentPath);
    if (resolved !== undefined) {
      return {
        path: currentPath,
        realPath: resolved,
      };
    }

    const parent = path.dirname(currentPath);
    if (parent === currentPath) {
      break;
    }
    currentPath = parent;
  }

  throw createFileSystemFailure("TOOL_INPUT_INVALID", `Path is outside allowed roots: ${candidatePath}`, {
    path: candidatePath,
    classification: "policy",
    recoverable: false,
  });
}

function assertAllowedRealPath(
  realPathValue: string,
  policy: ResolvedFileSystemPolicy,
): void {
  if (policy.allowedRoots.some((root) => isWithinRoot(realPathValue, root))) {
    return;
  }

  throw createFileSystemFailure("TOOL_INPUT_INVALID", `Path is outside allowed roots: ${realPathValue}`, {
    path: realPathValue,
    classification: "policy",
    recoverable: false,
  });
}

function createFileSystemFailure(
  code: string,
  message: string,
  details?: Record<string, unknown>,
) {
  return createRuntimeFailure(code, message, {
    subsystem: "tooling",
    toolFamily: "filesystem",
    ...(details ?? {}),
  });
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative.startsWith("..") === false && path.isAbsolute(relative) === false);
}

function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}

async function searchWithRipgrep(input: {
  absolutePath: string;
  query: string;
  glob: string | undefined;
  caseSensitive: boolean;
  budget: SearchResultBudget;
  policy: ResolvedFileSystemPolicy;
}): Promise<FileSystemSearchResult | undefined> {
  const args = [
    "--json",
    "--line-number",
    "--column",
    "--color",
    "never",
    "--fixed-strings",
    "--no-require-git",
    "--sort",
    "path",
  ];
  if (input.caseSensitive === false) {
    args.push("--ignore-case");
  }
  args.push(input.query, input.absolutePath);

  const globMatcher = input.glob !== undefined ? createGlobMatcher(input.glob) : undefined;
  let stdout = "";
  let stderr = "";
  let killedForLimit = false;

  return await new Promise<FileSystemSearchResult | undefined>((resolve, reject) => {
    const child = spawn("rg", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        resolve(undefined);
        return;
      }
      reject(error);
    });

    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      let lineEnd = stdout.indexOf("\n");
      while (lineEnd >= 0) {
        const line = stdout.slice(0, lineEnd).trim();
        stdout = stdout.slice(lineEnd + 1);
        if (line.length > 0) {
          const parsed = parseRipgrepMatch(line, input.policy);
          if (parsed !== undefined && (globMatcher === undefined || globMatcher.test(parsed.path))) {
            input.budget.add(parsed);
            if (input.budget.isFull()) {
              killedForLimit = true;
              child.kill("SIGTERM");
              break;
            }
          }
        }
        lineEnd = stdout.indexOf("\n");
      }
    });

    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on("close", (code, signal) => {
      if (killedForLimit) {
        resolve(input.budget.toResult());
        return;
      }

      if (signal !== null) {
        reject(new Error(`rg terminated by signal ${signal}`));
        return;
      }

      if (code === 0 || code === 1) {
        resolve(input.budget.toResult());
        return;
      }

      reject(new Error(stderr.trim() || `rg failed with exit code ${code ?? "unknown"}`));
    });
  });
}

function parseRipgrepMatch(
  line: string,
  policy: ResolvedFileSystemPolicy,
): FileSystemSearchMatch | undefined {
  const event = JSON.parse(line) as {
    type?: string;
    data?: {
      path?: { text?: string };
      lines?: { text?: string };
      line_number?: number;
      submatches?: Array<{ start?: number }>;
    };
  };

  if (event.type !== "match" || event.data?.path?.text === undefined) {
    return ;
  }

  return {
    path: normalizeDisplayPath(event.data.path.text, policy),
    line: typeof event.data.line_number === "number" ? event.data.line_number : 1,
    column:
      typeof event.data.submatches?.[0]?.start === "number" ? event.data.submatches[0].start + 1 : 1,
    preview: (event.data.lines?.text ?? "").replace(/\r?\n$/, ""),
  };
}

async function searchInProcess(input: {
  absolutePath: string;
  query: string;
  glob: string | undefined;
  caseSensitive: boolean;
  budget: SearchResultBudget;
  policy: ResolvedFileSystemPolicy;
}): Promise<FileSystemSearchResult> {
  const globMatcher = input.glob !== undefined ? createGlobMatcher(input.glob) : undefined;
  const visitedDirectories = new Set<string>();
  const normalizedNeedle = input.caseSensitive ? input.query : input.query.toLowerCase();

  const searchFile = async (absolutePath: string): Promise<void> => {
    const resolved = await resolveExistingFileSystemPath(absolutePath, input.policy);
    if (resolved.stat.isFile() === false) {
      return;
    }
    if (Number(resolved.stat.size) > MAX_FILE_READ_BYTES) {
      throw createFileSystemFailure(
        "TOOL_PROVIDER_FAILED",
        "Direct file search without ripgrep is limited to 1048576 bytes.",
        {
          path: resolved.displayPath,
          maxBytes: MAX_FILE_READ_BYTES,
          classification: "runtime",
          recoverable: true,
        },
      );
    }

    const displayPath = normalizeDisplayPath(absolutePath, input.policy);
    if (globMatcher !== undefined && globMatcher.test(displayPath) === false) {
      return;
    }

    const content = await readFile(absolutePath, "utf8");
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const preview = lines[index] ?? "";
      const haystack = input.caseSensitive ? preview : preview.toLowerCase();
      const columnIndex = haystack.indexOf(normalizedNeedle);
      if (columnIndex < 0) {
        continue;
      }

      input.budget.add({
        path: displayPath,
        line: index + 1,
        column: columnIndex + 1,
        preview,
      });
      if (input.budget.isFull()) {
        return;
      }
    }
  };

  const visit = async (absolutePath: string): Promise<void> => {
    if (input.budget.isFull()) {
      return;
    }

    const resolved = await resolveExistingFileSystemPath(absolutePath, input.policy);
    if (resolved.stat.isDirectory() === false) {
      await searchFile(absolutePath);
      return;
    }

    if (visitedDirectories.has(resolved.realPath)) {
      return;
    }
    visitedDirectories.add(resolved.realPath);

    const children = await readdir(absolutePath, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));

    for (const child of children) {
      if (isHiddenName(child.name)) {
        continue;
      }
      await visit(path.join(absolutePath, child.name));
      if (input.budget.isFull()) {
        return;
      }
    }
  };

  await visit(input.absolutePath);
  return input.budget.toResult();
}

interface SearchResultBudget {
  add: (match: FileSystemSearchMatch) => void;
  isFull: () => boolean;
  toResult: () => FileSystemSearchResult;
}

function createSearchResultBudget(input: {
  maxResults: number;
  maxPreviewChars: number;
  maxTotalPreviewChars: number;
}): SearchResultBudget {
  const matches: FileSystemSearchMatch[] = [];
  let totalPreviewChars = 0;
  let previewTruncatedCount = 0;
  let truncated = false;
  const maxResults = Math.max(1, input.maxResults);
  const maxPreviewChars = Math.min(
    Math.max(input.maxPreviewChars, MIN_SEARCH_MAX_PREVIEW_CHARS),
    MAX_SEARCH_MAX_PREVIEW_CHARS,
  );
  const maxTotalPreviewChars = Math.min(
    Math.max(input.maxTotalPreviewChars, MIN_SEARCH_MAX_TOTAL_PREVIEW_CHARS),
    MAX_SEARCH_MAX_TOTAL_PREVIEW_CHARS,
  );

  const add = (match: FileSystemSearchMatch): void => {
    if (matches.length >= maxResults || totalPreviewChars >= maxTotalPreviewChars) {
      truncated = true;
      return;
    }
    const originalPreview = match.preview;
    const preview = clampText(originalPreview, maxPreviewChars);
    const previewTruncated = preview.length < originalPreview.length;
    if (totalPreviewChars + preview.length > maxTotalPreviewChars) {
      truncated = true;
      return;
    }
    if (previewTruncated) {
      previewTruncatedCount += 1;
      truncated = true;
    }
    totalPreviewChars += preview.length;
    matches.push({
      path: match.path,
      line: match.line,
      column: match.column,
      preview,
      previewChars: preview.length,
      ...(previewTruncated ? { previewTruncated: true } : {}),
    });
    if (matches.length >= maxResults || totalPreviewChars >= maxTotalPreviewChars) {
      truncated = true;
    }
  };

  return {
    add,
    isFull: () => matches.length >= maxResults || totalPreviewChars >= maxTotalPreviewChars,
    toResult: () => ({
      matches,
      matchCount: matches.length,
      returnedMatchCount: matches.length,
      truncated,
      previewTruncatedCount,
      totalPreviewChars,
      maxPreviewChars,
      maxTotalPreviewChars,
    }),
  };
}

function clampText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 3) {
    return value.slice(0, maxChars);
  }
  return `${value.slice(0, maxChars - 3)}...`;
}

interface GlobMatcher {
  test: (displayPath: string) => boolean;
}

function createGlobMatcher(pattern: string): GlobMatcher {
  const normalizedPattern = toPosix(pattern);
  const matchBasename = normalizedPattern.includes("/") === false;
  const patternSegments = splitGlobPath(normalizedPattern).map(compileGlobSegment);
  return {
    test(displayPath) {
      const normalizedDisplayPath = toPosix(displayPath);
      const target = matchBasename ? path.posix.basename(normalizedDisplayPath) : normalizedDisplayPath;
      return matchGlobSegments(patternSegments, splitGlobPath(target), 0, 0);
    },
  };
}

type CompiledGlobSegment =
  | { kind: "globstar" }
  | { kind: "segment"; regExp: RegExp };

function splitGlobPath(value: string): string[] {
  return value.split("/").filter((segment) => segment.length > 0);
}

function compileGlobSegment(segment: string): CompiledGlobSegment {
  if (segment === "**") {
    return { kind: "globstar" };
  }
  return { kind: "segment", regExp: new RegExp(`^${compileGlobSegmentPattern(segment)}$`) };
}

function compileGlobSegmentPattern(segment: string): string {
  let pattern = "";
  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (char === "*") {
      if (segment[index + 1] === "*") {
        pattern += ".*";
        index += 1;
      } else {
        pattern += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      pattern += "[^/]";
      continue;
    }
    if (char === "{") {
      const endIndex = segment.indexOf("}", index + 1);
      const content = endIndex >= 0 ? segment.slice(index + 1, endIndex) : undefined;
      if (content !== undefined && content.includes(",")) {
        pattern += `(?:${content.split(",").map(escapeRegExp).join("|")})`;
        index = endIndex;
        continue;
      }
    }
    pattern += escapeRegExp(char ?? "");
  }
  return pattern;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchGlobSegments(
  patternSegments: CompiledGlobSegment[],
  pathSegments: string[],
  patternIndex: number,
  pathIndex: number,
): boolean {
  if (patternIndex >= patternSegments.length) {
    return pathIndex >= pathSegments.length;
  }

  const segment = patternSegments[patternIndex];
  if (segment?.kind === "globstar") {
    if (patternIndex === patternSegments.length - 1) {
      return true;
    }
    for (let nextPathIndex = pathIndex; nextPathIndex <= pathSegments.length; nextPathIndex += 1) {
      if (matchGlobSegments(patternSegments, pathSegments, patternIndex + 1, nextPathIndex)) {
        return true;
      }
    }
    return false;
  }

  if (segment === undefined || pathIndex >= pathSegments.length) {
    return false;
  }
  return segment.regExp.test(pathSegments[pathIndex] ?? "") &&
    matchGlobSegments(patternSegments, pathSegments, patternIndex + 1, pathIndex + 1);
}

function toPosix(value: string): string {
  return value.split(path.sep).join(path.posix.sep);
}

export function readOptionalGlob(
  input: Record<string, unknown> | undefined,
): string | undefined {
  const value = readString(input, "glob");
  return value !== undefined && value.length > 0 ? value : undefined;
}
