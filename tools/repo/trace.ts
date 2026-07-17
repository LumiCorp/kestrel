import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { SharedToolModule } from "../contracts.js";
import {
  createToolInputError,
  parseObjectInput,
  parseOptionalStringArray,
  readNumber,
  readString,
} from "../helpers.js";
import {
  normalizeDisplayPath,
  resolveExistingFileSystemPath,
} from "../filesystem/shared.js";

const DEFAULT_MAX_RESULTS = 40;
const MAX_RESULTS_LIMIT = 200;
const DEFAULT_CONTEXT_LINES = 2;
const MAX_CONTEXT_LINES = 10;
const MAX_SEARCHED_FILES = 5000;
const MAX_FILE_BYTES = 1_000_000;
const PREVIEW_LIMIT = 300;

const DEFAULT_INCLUDE_GLOBS = [
  "**/*.c",
  "**/*.cc",
  "**/*.cfg",
  "**/*.cpp",
  "**/*.cs",
  "**/*.css",
  "**/*.go",
  "**/*.h",
  "**/*.hpp",
  "**/*.htm",
  "**/*.html",
  "**/*.ini",
  "**/*.java",
  "**/*.jinja",
  "**/*.jinja2",
  "**/*.js",
  "**/*.json",
  "**/*.jsonc",
  "**/*.jsx",
  "**/*.kt",
  "**/*.mjs",
  "**/*.md",
  "**/*.mdx",
  "**/*.php",
  "**/*.pot_t",
  "**/*.py",
  "**/*.rb",
  "**/*.rs",
  "**/*.rst",
  "**/*.scala",
  "**/*.scss",
  "**/*.sh",
  "**/*.sql",
  "**/*.swift",
  "**/*.toml",
  "**/*.ts",
  "**/*.tsx",
  "**/*.txt",
  "**/*.xml",
  "**/*.yaml",
  "**/*.yml",
  "**/Dockerfile",
  "**/Makefile",
  "**/package.json",
  "**/pyproject.toml",
  "**/tox.ini",
] as const;

const DEFAULT_EXCLUDE_GLOBS = [
  "**/.git/**",
  "**/.cache/**",
  "**/.next/**",
  "**/.tox/**",
  "**/.venv/**",
  "**/__pycache__/**",
  "**/build/**",
  "**/coverage/**",
  "**/dist/**",
  "**/node_modules/**",
  "**/target/**",
  "**/venv/**",
] as const;

const DEFAULT_EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  ".cache",
  ".next",
  ".tox",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "venv",
]);

interface RepoTraceInput {
  path: string;
  seeds: string[];
  includeGlobs: string[];
  excludeGlobs: string[];
  maxResults: number;
  contextLines: number;
}

interface RepoTraceMatch {
  seed: string;
  line: number;
  column: number;
  preview: string;
  contextBefore: string[];
  contextAfter: string[];
}

interface RepoTraceGroup {
  path: string;
  matches: RepoTraceMatch[];
}

interface RepoTraceResult {
  path: string;
  seeds: string[];
  searchedFileCount: number;
  matchedFileCount: number;
  resultCount: number;
  truncated: boolean;
  groups: RepoTraceGroup[];
}

export const repoTraceTool: SharedToolModule = {
  definition: {
    name: "repo.trace",
    description: "Trace exact strings or symbols across repository text, source, tests, templates, docs, and config files. Use for structured read-only reference search when plain file reads or search results are too scattered.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        seeds: {
          type: "array",
          items: { type: "string" },
        },
        includeGlobs: {
          type: "array",
          items: { type: "string" },
        },
        excludeGlobs: {
          type: "array",
          items: { type: "string" },
        },
        maxResults: { type: "number" },
        contextLines: { type: "number" },
      },
      required: ["seeds"],
      additionalProperties: false,
    },
    capability: {
      freshnessClass: "volatile",
      latencyClass: "low",
      costClass: "free",
      executionClass: "read_only",
      capabilityClasses: ["fs.read", "repo.trace"],
      approvalCapabilities: ["workspace.read"],
    },
    presentation: {
      displayName: "Trace Repository References",
      aliases: ["repo trace", "reference search", "trace references"],
      keywords: ["repo", "trace", "references", "search", "tests", "config"],
      provider: "kestrel",
      toolFamily: "repo",
    },
  },
  createHandler(context) {
    return async (input: unknown) => {
      const parsed = parseRepoTraceInput(input);
      return traceRepositoryReferences({
        ...parsed,
        fileSystem: context.fileSystem,
      });
    };
  },
};

async function traceRepositoryReferences(input: RepoTraceInput & {
  fileSystem: Parameters<typeof resolveExistingFileSystemPath>[1];
}): Promise<RepoTraceResult> {
  const root = await resolveExistingFileSystemPath(input.path, input.fileSystem);
  const displayPolicy = input.fileSystem ?? { workspaceRoot: process.cwd(), tempRoots: [] };
  const groups = new Map<string, RepoTraceGroup>();
  let searchedFileCount = 0;
  let resultCount = 0;
  let truncated = false;

  const includeMatchers = input.includeGlobs.map(globToRegExp);
  const excludeMatchers = input.excludeGlobs.map(globToRegExp);

  const addMatchesForFile = async (absoluteFilePath: string): Promise<void> => {
    if (truncated) {
      return;
    }
    const displayPath = normalizeDisplayPath(absoluteFilePath, displayPolicy);
    if (matchesAny(displayPath, excludeMatchers) || matchesAny(stripLeadingDotSlash(displayPath), excludeMatchers)) {
      return;
    }
    if (
      matchesAny(displayPath, includeMatchers) === false &&
      matchesAny(stripLeadingDotSlash(displayPath), includeMatchers) === false
    ) {
      return;
    }

    const fileStat = await lstat(absoluteFilePath);
    if (fileStat.isFile() === false || fileStat.size > MAX_FILE_BYTES) {
      return;
    }

    const buffer = await readFile(absoluteFilePath);
    if (looksBinary(buffer)) {
      return;
    }

    searchedFileCount += 1;
    if (searchedFileCount > MAX_SEARCHED_FILES) {
      truncated = true;
      return;
    }

    const lines = buffer.toString("utf8").split(/\r?\n/u);
    for (const [index, line] of lines.entries()) {
      for (const seed of input.seeds) {
        let columnIndex = line.indexOf(seed);
        while (columnIndex >= 0) {
          const group = groups.get(displayPath) ?? { path: displayPath, matches: [] };
          group.matches.push({
            seed,
            line: index + 1,
            column: columnIndex + 1,
            preview: clipLine(line),
            contextBefore: lines.slice(Math.max(0, index - input.contextLines), index).map(clipLine),
            contextAfter: lines.slice(index + 1, index + 1 + input.contextLines).map(clipLine),
          });
          groups.set(displayPath, group);
          resultCount += 1;
          if (resultCount >= input.maxResults) {
            truncated = true;
            return;
          }
          columnIndex = line.indexOf(seed, columnIndex + Math.max(seed.length, 1));
        }
      }
    }
  };

  const visit = async (absolutePath: string): Promise<void> => {
    if (truncated) {
      return;
    }
    const entryStat = await lstat(absolutePath);
    if (entryStat.isSymbolicLink()) {
      return;
    }
    if (entryStat.isFile()) {
      await addMatchesForFile(absolutePath);
      return;
    }
    if (entryStat.isDirectory() === false) {
      return;
    }
    const dirName = path.basename(absolutePath);
    const displayPath = normalizeDisplayPath(absolutePath, displayPolicy);
    if (
      absolutePath !== root.absolutePath &&
      (DEFAULT_EXCLUDED_DIRECTORY_NAMES.has(dirName) ||
        matchesAny(displayPath.endsWith("/") ? displayPath : `${displayPath}/`, excludeMatchers))
    ) {
      return;
    }
    const children = await readdir(absolutePath, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      await visit(path.join(absolutePath, child.name));
      if (truncated) {
        return;
      }
    }
  };

  await visit(root.absolutePath);

  const renderedGroups = [...groups.values()];
  return {
    path: root.displayPath,
    seeds: [...input.seeds],
    searchedFileCount: Math.min(searchedFileCount, MAX_SEARCHED_FILES),
    matchedFileCount: renderedGroups.length,
    resultCount,
    truncated,
    groups: renderedGroups,
  };
}

function parseRepoTraceInput(input: unknown): RepoTraceInput {
  const body = parseObjectInput("repo.trace", input);
  const seeds = parseRequiredSeeds(body);
  return {
    path: readString(body, "path") ?? ".",
    seeds,
    includeGlobs: parseOptionalStringArray(body, "includeGlobs", 100).length > 0
      ? parseOptionalStringArray(body, "includeGlobs", 100)
      : [...DEFAULT_INCLUDE_GLOBS],
    excludeGlobs: [
      ...DEFAULT_EXCLUDE_GLOBS,
      ...parseOptionalStringArray(body, "excludeGlobs", 100),
    ],
    maxResults: clampInt(readNumber(body, "maxResults"), DEFAULT_MAX_RESULTS, 1, MAX_RESULTS_LIMIT),
    contextLines: clampInt(readNumber(body, "contextLines"), DEFAULT_CONTEXT_LINES, 0, MAX_CONTEXT_LINES),
  };
}

function parseRequiredSeeds(input: Record<string, unknown>): string[] {
  const raw = input.seeds;
  if (Array.isArray(raw) === false) {
    throw createToolInputError("repo.trace", "repo.trace requires input.seeds as a non-empty string array.", {
      field: "seeds",
    });
  }
  const seeds = parseOptionalStringArray(input, "seeds", 50);
  if (seeds.length === 0) {
    throw createToolInputError("repo.trace", "repo.trace requires at least one non-empty seed.", {
      field: "seeds",
    });
  }
  return [...new Set(seeds)];
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || Number.isFinite(value) === false) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    const next = glob[index + 1];
    if (char === "*" && next === "*") {
      if (glob[index + 2] === "/") {
        source += "(?:.*/)?";
        index += 2;
        continue;
      }
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    if (char === "?") {
      source += "[^/]";
      continue;
    }
    source += escapeRegExp(char ?? "");
  }
  return new RegExp(`^${source}$`, "u");
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function stripLeadingDotSlash(value: string): string {
  return value.startsWith("./") ? value.slice(2) : value;
}

function looksBinary(buffer: Buffer): boolean {
  const limit = Math.min(buffer.length, 4096);
  for (let index = 0; index < limit; index += 1) {
    if (buffer[index] === 0) {
      return true;
    }
  }
  return false;
}

function clipLine(value: string): string {
  if (value.length <= PREVIEW_LIMIT) {
    return value;
  }
  return `${value.slice(0, PREVIEW_LIMIT - 3)}...`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}
