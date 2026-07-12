import type { ReactNode } from "react";

export const DOCS_SECTIONS = [
  "home",
  "docs",
  "build",
  "deploy",
  "apps",
  "packages",
  "cli",
  "runtime",
  "operations",
  "reference",
  "archive",
] as const;

export type DocsSection = (typeof DOCS_SECTIONS)[number];
export const DOCS_NAV_SECTIONS = ["desktop", "build", "deploy", "reference"] as const;
export type DocsNavSection = (typeof DOCS_NAV_SECTIONS)[number];

export const DOCS_AUDIENCES = ["everyone", "evaluators", "integrators", "maintainers"] as const;
export const DOCS_STATUSES = ["stable", "active", "draft"] as const;
export const SOURCE_KINDS = ["curated", "repo-inferred", "archived"] as const;

export type DocsAudience = (typeof DOCS_AUDIENCES)[number];
export type DocsStatus = (typeof DOCS_STATUSES)[number];
export type SourceKind = (typeof SOURCE_KINDS)[number];
export type ArchiveGroup = "plans" | "runbooks";
export type SearchPageKind = "home" | "landing" | "narrative" | "tutorial" | "reference" | "archive";
export type SearchCapability =
  | "openai-compatible http"
  | "operator control"
  | "project review"
  | "task graph"
  | "project snapshot"
  | "scene replay"
  | "workspace automation"
  | "cli"
  | "profiles, code mode, and mcp"
  | "runner service"
  | "nextjs"
  | "artifact inspection"
  | "evaluation"
  | "runtime";

export interface TocItem {
  id: string;
  text: string;
  level: 2 | 3;
}

export interface SearchDocument {
  id: string;
  url: string;
  title: string;
  summary: string;
  section: DocsSection;
  navSection: DocsNavSection;
  headings: string[];
  fullText: string;
  internal: boolean;
  sourceKind: SourceKind;
  pageKind: SearchPageKind;
  priority: number;
  capabilities: SearchCapability[];
}

export interface SearchResultEntry {
  id: string;
  url: string;
  title: string;
  summary: string;
  section: DocsSection;
  navSection: DocsNavSection;
  internal: boolean;
  sourceKind: SourceKind;
  pageKind: SearchPageKind;
  priority: number;
  capabilities: SearchCapability[];
}

export interface DocsPageMeta {
  slug: string[];
  url: string;
  title: string;
  summary: string;
  section: DocsSection;
  audience: DocsAudience;
  status: DocsStatus;
  sourceKind: SourceKind;
  internal: boolean;
  archive: boolean;
  updatedAt: string;
  sourceUrl: string;
  toc: TocItem[];
  related: string[];
  archiveGroup?: ArchiveGroup;
}

export interface RenderedPage {
  meta: DocsPageMeta;
  content: ReactNode;
  rawContent: string;
}

export interface RegisteredPageSpec {
  slug: string[];
  filePath?: string;
  sourcePath?: string;
  sourceRefs?: string[];
  related?: string[];
  includeInSidebar?: boolean;
  internal?: boolean;
  archive?: boolean;
  archiveGroup?: ArchiveGroup;
  pageKind?: SearchPageKind;
  priority?: number;
  capabilities?: SearchCapability[];
}

export interface NavEntry {
  title: string;
  url: string;
  summary: string;
  internal: boolean;
  sourceKind: SourceKind;
}

export interface NavGroup {
  section: DocsNavSection;
  title: string;
  landing: NavEntry | null;
  groups: Array<{
    title: string;
    entries: NavEntry[];
  }>;
}
