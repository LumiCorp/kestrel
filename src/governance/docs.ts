import { readFile } from "node:fs/promises";

import type { DocIndexEntry, DocDriftFinding } from "./contracts.js";

export function parseFrontmatter(markdown: string): Record<string, unknown> {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (match === null) {
    return {};
  }

  const data: Record<string, unknown> = {};
  const body = match[1] ?? "";
  const lines = body.split("\n");
  for (const line of lines) {
    const sep = line.indexOf(":");
    if (sep <= 0) {
      continue;
    }
    const key = line.slice(0, sep).trim();
    const value = line.slice(sep + 1).trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      data[key] = value
        .slice(1, -1)
        .split(",")
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
      continue;
    }
    data[key] = value;
  }
  return data;
}

export async function loadDocIndexEntry(path: string): Promise<DocIndexEntry | null> {
  const raw = await readFile(path, "utf8");
  const frontmatter = parseFrontmatter(raw);
  if (Object.keys(frontmatter).length === 0) {
    return null;
  }
  if (
    typeof frontmatter.id !== "string" ||
    typeof frontmatter.domain !== "string" ||
    typeof frontmatter.status !== "string" ||
    typeof frontmatter.owner !== "string" ||
    typeof frontmatter.last_verified_at !== "string"
  ) {
    return null;
  }

  return {
    id: frontmatter.id,
    domain: frontmatter.domain,
    status: normalizeStatus(frontmatter.status),
    owner: frontmatter.owner,
    last_verified_at: frontmatter.last_verified_at,
    depends_on: Array.isArray(frontmatter.depends_on)
      ? frontmatter.depends_on.filter((item): item is string => typeof item === "string")
      : undefined,
  };
}

export function findDocDrift(input: {
  docPath: string;
  entry: DocIndexEntry;
  now: Date;
  staleAfterDays: number;
  content: string;
}): DocDriftFinding[] {
  const findings: DocDriftFinding[] = [];
  const verified = new Date(input.entry.last_verified_at);
  const ageMs = input.now.getTime() - verified.getTime();
  const staleMs = input.staleAfterDays * 24 * 60 * 60 * 1000;
  if (requiresFreshness(input.entry) && Number.isFinite(ageMs) && ageMs > staleMs) {
    findings.push({
      type: "stale",
      severity: "medium",
      target_doc: input.docPath,
      suggested_fix: "Update document and refresh last_verified_at.",
      confidence: 0.95,
    });
  }

  if (/\[[^\]]+\]\((?!https?:\/\/|#)/.test(input.content) === false) {
    findings.push({
      type: "missing_link",
      severity: "low",
      target_doc: input.docPath,
      suggested_fix: "Add at least one local cross-link to related docs.",
      confidence: 0.7,
    });
  }

  return findings;
}

function normalizeStatus(value: string): DocIndexEntry["status"] {
  if (value === "active" || value === "deprecated" || value === "draft" || value === "historical") {
    return value;
  }
  return "draft";
}

export function requiresFreshness(entry: Pick<DocIndexEntry, "status">): boolean {
  return entry.status !== "deprecated" && entry.status !== "historical";
}
