import path from "node:path";

import { REPO_BLOB_BASE_URL, REPO_TREE_BASE_URL, createPageUrl, normalizePathForUrl, resolveRepoRoot } from "@/lib/site";
import type { TocItem } from "@/lib/types";

export function slugifyHeading(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{Letter}\p{Number}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

export function extractToc(markdown: string): TocItem[] {
  const toc: TocItem[] = [];
  for (const line of markdown.split("\n")) {
    const match = /^(#{2,3})\s+(.+)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    const hashes = match[1];
    const text = match[2].replace(/\[(.*?)\]\((.*?)\)/g, "$1").trim();
    const level = hashes.length === 2 ? 2 : 3;
    toc.push({ id: slugifyHeading(text), text, level });
  }
  return toc;
}

export function stripMarkdown(markdown: string) {
  return markdown
    .replace(/^---[\s\S]*?---\s*/m, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/\[(.*?)\]\((.*?)\)/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveRepoLink(target: string, sourcePath: string | undefined) {
  if (
    target.startsWith("http://") ||
    target.startsWith("https://") ||
    target.startsWith("mailto:") ||
    target.startsWith("#")
  ) {
    return null;
  }

  if (target.startsWith("/")) {
    const roots = [resolveRepoRoot()].map((root) => normalizePathForUrl(root));
    for (const repoRoot of roots) {
      if (target === repoRoot) {
        return "";
      }
      if (target.startsWith(`${repoRoot}/`)) {
        return target.slice(repoRoot.length + 1);
      }
    }
    return null;
  }

  if (!sourcePath) {
    return null;
  }

  const baseDir = path.posix.dirname(sourcePath);
  return normalizePathForUrl(path.posix.normalize(path.posix.join(baseDir, target)));
}

function createRepoHttpLink(repoPath: string) {
  const normalized = normalizePathForUrl(repoPath).replace(/^\/+/, "");
  const baseUrl = path.posix.extname(normalized) === "" ? REPO_TREE_BASE_URL : REPO_BLOB_BASE_URL;
  return `${baseUrl}/${normalized}`;
}

export function normalizeMarkdownLinks(
  markdown: string,
  sourcePath: string | undefined,
  routeMap: Map<string, string>,
) {
  return markdown.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label: string, target: string) => {
    const resolvedRepoPath = resolveRepoLink(target, sourcePath);
    if (!resolvedRepoPath) {
      return match;
    }

    const mappedRoute = routeMap.get(resolvedRepoPath);
    if (mappedRoute) {
      return `[${label}](${mappedRoute})`;
    }

    return `[${label}](${createRepoHttpLink(resolvedRepoPath)})`;
  });
}

export function buildRouteMap(entries: Array<{ slug: string[]; sourceRefs?: string[]; sourcePath?: string }>) {
  const routeMap = new Map<string, string>();
  for (const entry of entries) {
    const url = createPageUrl(entry.slug);
    for (const ref of entry.sourceRefs ?? []) {
      routeMap.set(normalizePathForUrl(ref), url);
    }
    if (entry.sourcePath) {
      routeMap.set(normalizePathForUrl(entry.sourcePath), url);
    }
  }
  return routeMap;
}
