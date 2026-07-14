import type { ReactNode } from "react";

export const DOCS_SECTIONS = [
  "home",
  "start",
  "desktop",
  "kestrel-one",
  "docs",
  "build",
  "deploy",
  "apps",
  "packages",
  "cli",
  "runtime",
  "operations",
  "operate",
  "reference",
  "archive",
] as const;

export type DocsSection = (typeof DOCS_SECTIONS)[number];
export const DOCS_NAV_SECTIONS = ["start", "desktop", "kestrel-one", "build", "operate", "reference"] as const;
export type DocsNavSection = (typeof DOCS_NAV_SECTIONS)[number];

export const DOCS_AUDIENCES = ["everyone", "evaluators", "integrators", "maintainers"] as const;
export const DOCS_STATUSES = ["stable", "active", "draft"] as const;
export const SOURCE_KINDS = ["curated", "repo-inferred", "archived"] as const;

export type DocsAudience = (typeof DOCS_AUDIENCES)[number];
export type DocsStatus = (typeof DOCS_STATUSES)[number];
export type SourceKind = (typeof SOURCE_KINDS)[number];
export type ArchiveGroup = "plans" | "runbooks";
export const CONTENT_ARCHETYPES = [
  "gateway",
  "product-journey",
  "build-tutorial",
  "task-recipe",
  "explainer",
  "operational-playbook",
  "troubleshooting",
  "reference",
  "migration",
] as const;
export type ContentArchetype = (typeof CONTENT_ARCHETYPES)[number];

export const PRODUCT_SURFACES = [
  "suite",
  "desktop",
  "kestrel-one",
  "sdk",
  "nextjs",
  "runtime",
  "operations",
  "protocol",
  "cli",
] as const;
export type ProductSurface = (typeof PRODUCT_SURFACES)[number];
export type ExperienceLevel = "beginner" | "intermediate" | "advanced";
export type TocMode = "none" | "auto" | "full";
export type DocsJourneyId = "desktop-first-success" | "kestrel-one-collaboration" | "workspace-copilot-build";

export interface JourneyMeta {
  id: DocsJourneyId;
  label: string;
  step: number;
  total: number;
  previous?: { title: string; url: string };
  next?: { title: string; url: string };
}
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
  | "runtime"
  | "threads"
  | "projects"
  | "knowledge"
  | "managed models"
  | "gateways"
  | "protocol"
  | "terminal results"
  | "access control";

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
  archetype: ContentArchetype;
  surface: ProductSurface;
  experienceLevel: ExperienceLevel;
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
  tocMode: TocMode;
  archetype: ContentArchetype;
  surface: ProductSurface;
  experienceLevel: ExperienceLevel;
  estimatedTime?: string;
  journey?: JourneyMeta;
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
  archetype: ContentArchetype;
  surface: ProductSurface;
  experienceLevel?: ExperienceLevel;
  estimatedTime?: string;
  tocMode?: TocMode;
  journeyId?: DocsJourneyId;
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
