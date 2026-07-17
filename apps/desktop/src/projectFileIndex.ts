import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import type {
  DesktopDirectoryListing,
  DesktopFileSearchResponse,
  DesktopFileSearchResult,
} from "../../../src/desktopShell/contracts.js";

export const DESKTOP_FILE_SEARCH_RESULT_LIMIT = 200;

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

function buildSearchResponse(input: {
  rootPath: string;
  query: string;
  candidates: DesktopFileSearchResult[];
  fullSearchAvailable: boolean;
}): DesktopFileSearchResponse {
  const matched = input.candidates
    .filter((entry) => entry.name.toLowerCase().includes(input.query))
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
