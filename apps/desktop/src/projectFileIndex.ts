import { execFile } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  DesktopDirectoryListing,
  DesktopFileContentSearchResponse,
  DesktopFileContentSearchResult,
  DesktopFileSearchResponse,
  DesktopFileSearchResult,
} from "../../../src/desktopShell/contracts.js";

export const DESKTOP_FILE_SEARCH_RESULT_LIMIT = 200;
export const DESKTOP_CONTENT_SEARCH_FILE_MAX_BYTES = 1024 * 1024;
export const DESKTOP_CONTENT_SEARCH_TOTAL_MAX_BYTES = 16 * 1024 * 1024;

type GitListFiles = (rootPath: string) => Promise<string[] | undefined>;

const execFileAsync = promisify(execFile);

export class DesktopProjectFileIndex {
  private readonly gitListFiles: GitListFiles;
  private readonly gitCache = new Map<string, string[] | undefined>();
  private readonly listingCache = new Map<string, Map<string, DesktopDirectoryListing>>();

  constructor(input: {
    gitListFiles?: GitListFiles | undefined;
  } = {}) {
    this.gitListFiles = input.gitListFiles ?? readGitFiles;
  }

  invalidate(rootPath: string): void {
    const normalizedRoot = path.resolve(rootPath);
    this.gitCache.delete(normalizedRoot);
  }

  retainRoots(rootPaths: readonly string[]): void {
    const retained = new Set(rootPaths.map((entry) => path.resolve(entry)));
    this.gitCache.clear();
    for (const rootPath of [...this.listingCache.keys()]) {
      if (retained.has(rootPath) === false) {
        this.listingCache.delete(rootPath);
      }
    }
  }

  rememberDirectoryListing(listing: DesktopDirectoryListing): void {
    const rootPath = path.resolve(listing.rootPath);
    const directoryPath = path.resolve(listing.directoryPath);
    const listings = this.listingCache.get(rootPath) ?? new Map<string, DesktopDirectoryListing>();
    listings.set(directoryPath, {
      ...listing,
      rootPath,
      directoryPath,
      entries: listing.entries.map((entry) => ({ ...entry })),
    });
    this.listingCache.set(rootPath, listings);
  }

  async search(rootPath: string, query: string): Promise<DesktopFileSearchResponse> {
    const normalizedRoot = path.resolve(rootPath);
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery.length === 0) {
      return {
        rootPath: normalizedRoot,
        query: normalizedQuery,
        results: [],
        truncated: false,
        fullSearchAvailable: true,
      };
    }

    const gitFiles = await this.readCachedGitFiles(normalizedRoot);
    if (gitFiles !== undefined) {
      return buildSearchResponse({
        rootPath: normalizedRoot,
        query: normalizedQuery,
        candidates: gitFiles.map((relativePath) => {
          const absolutePath = path.resolve(normalizedRoot, relativePath);
          if (isPathWithinRoot(normalizedRoot, absolutePath) === false) {
            return ;
          }
          return {
            path: absolutePath,
            name: path.basename(absolutePath),
            directoryPath: path.dirname(absolutePath),
          };
        }).filter((entry): entry is DesktopFileSearchResult => entry !== undefined),
        fullSearchAvailable: true,
      });
    }

    return buildSearchResponse({
      rootPath: normalizedRoot,
      query: normalizedQuery,
      candidates: this.knownListingCandidates(normalizedRoot),
      fullSearchAvailable: false,
    });
  }

  async searchContent(rootPath: string, query: string): Promise<DesktopFileContentSearchResponse> {
    const normalizedRoot = path.resolve(rootPath);
    const normalizedQuery = query.trim();
    if (normalizedQuery.length === 0) {
      return emptyContentSearchResponse(normalizedRoot, normalizedQuery, true);
    }

    const gitFiles = await this.readCachedGitFiles(normalizedRoot);
    const candidates = gitFiles !== undefined
      ? gitFiles.map((relativePath) => path.resolve(normalizedRoot, relativePath))
      : this.knownListingCandidates(normalizedRoot).map((entry) => entry.path);
    const fullSearchAvailable = gitFiles !== undefined;
    const results: DesktopFileContentSearchResult[] = [];
    let scannedFileCount = 0;
    let skippedFileCount = 0;
    let scannedBytes = 0;
    let truncated = false;
    const realRoot = await realpath(normalizedRoot);

    for (const candidatePath of [...new Set(candidates)].sort((left, right) => left.localeCompare(right))) {
      if (results.length >= DESKTOP_FILE_SEARCH_RESULT_LIMIT) {
        truncated = true;
        break;
      }
      if (isPathWithinRoot(normalizedRoot, candidatePath) === false) {
        skippedFileCount += 1;
        continue;
      }
      try {
        const fileStats = await lstat(candidatePath);
        if (
          fileStats.isFile() === false ||
          fileStats.isSymbolicLink() ||
          fileStats.size > DESKTOP_CONTENT_SEARCH_FILE_MAX_BYTES ||
          scannedBytes + fileStats.size > DESKTOP_CONTENT_SEARCH_TOTAL_MAX_BYTES
        ) {
          skippedFileCount += 1;
          if (scannedBytes + fileStats.size > DESKTOP_CONTENT_SEARCH_TOTAL_MAX_BYTES) {
            truncated = true;
          }
          continue;
        }
        const realCandidate = await realpath(candidatePath);
        if (isPathWithinRoot(realRoot, realCandidate) === false) {
          skippedFileCount += 1;
          continue;
        }
        const buffer = await readFile(realCandidate);
        scannedBytes += buffer.byteLength;
        if (buffer.includes(0)) {
          skippedFileCount += 1;
          continue;
        }
        const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
        scannedFileCount += 1;
        appendContentMatches({
          results,
          candidatePath,
          query: normalizedQuery,
          content,
        });
      } catch {
        skippedFileCount += 1;
      }
    }

    return {
      rootPath: normalizedRoot,
      query: normalizedQuery,
      results: results.slice(0, DESKTOP_FILE_SEARCH_RESULT_LIMIT),
      truncated: truncated || results.length > DESKTOP_FILE_SEARCH_RESULT_LIMIT,
      fullSearchAvailable,
      scannedFileCount,
      skippedFileCount,
    };
  }

  private async readCachedGitFiles(rootPath: string): Promise<string[] | undefined> {
    if (this.gitCache.has(rootPath)) {
      return this.gitCache.get(rootPath);
    }
    const files = await this.gitListFiles(rootPath);
    this.gitCache.set(rootPath, files);
    return files;
  }

  private knownListingCandidates(rootPath: string): DesktopFileSearchResult[] {
    const listings = this.listingCache.get(rootPath);
    if (listings === undefined) {
      return [];
    }
    const candidates = new Map<string, DesktopFileSearchResult>();
    for (const listing of listings.values()) {
      for (const entry of listing.entries) {
        if (entry.kind !== "file") {
          continue;
        }
        const absolutePath = path.resolve(entry.path);
        if (isPathWithinRoot(rootPath, absolutePath) === false) {
          continue;
        }
        candidates.set(absolutePath, {
          path: absolutePath,
          name: entry.name,
          directoryPath: path.dirname(absolutePath),
        });
      }
    }
    return [...candidates.values()];
  }
}

function emptyContentSearchResponse(
  rootPath: string,
  query: string,
  fullSearchAvailable: boolean,
): DesktopFileContentSearchResponse {
  return {
    rootPath,
    query,
    results: [],
    truncated: false,
    fullSearchAvailable,
    scannedFileCount: 0,
    skippedFileCount: 0,
  };
}

function appendContentMatches(input: {
  results: DesktopFileContentSearchResult[];
  candidatePath: string;
  query: string;
  content: string;
}): void {
  const normalizedQuery = input.query.toLowerCase();
  const lines = input.content.split(/\r\n|\n|\r/u);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const normalizedLine = line.toLowerCase();
    let fromIndex = 0;
    while (fromIndex <= normalizedLine.length - normalizedQuery.length) {
      const matchIndex = normalizedLine.indexOf(normalizedQuery, fromIndex);
      if (matchIndex < 0) {
        break;
      }
      input.results.push({
        path: input.candidatePath,
        name: path.basename(input.candidatePath),
        directoryPath: path.dirname(input.candidatePath),
        lineNumber: lineIndex + 1,
        columnNumber: matchIndex + 1,
        preview: boundedMatchPreview(line, matchIndex, input.query.length),
      });
      if (input.results.length > DESKTOP_FILE_SEARCH_RESULT_LIMIT) {
        return;
      }
      fromIndex = matchIndex + Math.max(input.query.length, 1);
    }
  }
}

function boundedMatchPreview(line: string, matchIndex: number, matchLength: number): string {
  const start = Math.max(0, matchIndex - 80);
  const end = Math.min(line.length, matchIndex + matchLength + 120);
  return `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
}

function buildSearchResponse(input: {
  rootPath: string;
  query: string;
  candidates: DesktopFileSearchResult[];
  fullSearchAvailable: boolean;
}): DesktopFileSearchResponse {
  const matched = input.candidates
    .filter((entry) => {
      const relativePath = path.relative(input.rootPath, entry.path).replaceAll(path.sep, "/").toLowerCase();
      return entry.name.toLowerCase().includes(input.query) || relativePath.includes(input.query);
    })
    .sort((left, right) => left.path.localeCompare(right.path));
  return {
    rootPath: input.rootPath,
    query: input.query,
    results: matched.slice(0, DESKTOP_FILE_SEARCH_RESULT_LIMIT),
    truncated: matched.length > DESKTOP_FILE_SEARCH_RESULT_LIMIT,
    fullSearchAvailable: input.fullSearchAvailable,
  };
}

async function readGitFiles(rootPath: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", rootPath, "ls-files", "-co", "--exclude-standard", "-z"],
      {
        encoding: "buffer",
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return Buffer.from(stdout)
      .toString("utf8")
      .split("\0")
      .filter((entry) => entry.length > 0);
  } catch {
    return ;
  }
}

function isPathWithinRoot(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative.length === 0 || (relative.startsWith("..") === false && path.isAbsolute(relative) === false);
}
