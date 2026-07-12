import fs from "node:fs/promises";
import path from "node:path";
import { cache } from "react";

import matter from "gray-matter";
import { compileMDX } from "next-mdx-remote/rsc";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";

import { mdxComponents } from "@/components/mdx-components";
import { findPageSpec, pageRegistry } from "@/lib/content-registry";
import { buildRouteMap, extractToc, normalizeMarkdownLinks, stripMarkdown } from "@/lib/markdown";
import { createPageUrl, REPO_BLOB_BASE_URL, resolveDocsAppRoot, resolveRepoRoot } from "@/lib/site";
import {
  DOCS_AUDIENCES,
  DOCS_SECTIONS,
  DOCS_STATUSES,
  SOURCE_KINDS,
  type DocsAudience,
  type DocsPageMeta,
  type DocsNavSection,
  type DocsSection,
  type DocsStatus,
  type NavEntry,
  type NavGroup,
  type RegisteredPageSpec,
  type RenderedPage,
  type SearchDocument,
  type SourceKind,
} from "@/lib/types";

interface Frontmatter {
  title?: string;
  summary?: string;
  section?: DocsSection;
  audience?: DocsAudience;
  status?: DocsStatus;
  sourceKind?: SourceKind;
  internal?: boolean;
  updatedAt?: string;
  last_verified_at?: string;
}

const routeMap = buildRouteMap(pageRegistry);

function resolveContentPath(spec: RegisteredPageSpec) {
  if (spec.filePath) {
    return path.join(resolveDocsAppRoot(), "content", spec.filePath);
  }
  if (spec.sourcePath) {
    return path.join(resolveRepoRoot(), spec.sourcePath);
  }
  throw new Error(`Docs page '${spec.slug.join("/")}' has no content source.`);
}

async function readPageSource(spec: RegisteredPageSpec) {
  return fs.readFile(resolveContentPath(spec), "utf8");
}

function isOneOf<T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === "string" && allowed.includes(value as T[number]);
}

function readFirstHeading(markdown: string) {
  for (const line of markdown.split("\n")) {
    const match = /^#\s+(.+)$/.exec(line.trim());
    if (match) {
      return match[1].trim();
    }
  }
  return null;
}

function createArchiveSummary(spec: RegisteredPageSpec, title: string) {
  if (spec.archiveGroup === "runbooks") {
    return `Archived runbook preserved in the Kestrel repository: ${title}.`;
  }
  return `Archived design or planning document preserved in the Kestrel repository: ${title}.`;
}

function requireStringField(spec: RegisteredPageSpec, fieldName: string, value: unknown) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Docs page '${spec.slug.join("/") || "/"}' is missing required '${fieldName}' frontmatter.`);
  }
  return value.trim();
}

function requireScalarField(spec: RegisteredPageSpec, fieldName: string, value: unknown) {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  throw new Error(`Docs page '${spec.slug.join("/") || "/"}' is missing required '${fieldName}' frontmatter.`);
}

function parseFrontmatter(spec: RegisteredPageSpec, frontmatter: Frontmatter, rawContent: string) {
  if (spec.archive) {
    const archiveTitle = typeof frontmatter.title === "string" && frontmatter.title.trim().length > 0
      ? frontmatter.title.trim()
      : readFirstHeading(rawContent);
    const title = archiveTitle ?? spec.slug[spec.slug.length - 1] ?? "Archived document";
    const updatedAt = frontmatter.last_verified_at !== undefined
      ? requireScalarField(spec, "last_verified_at", frontmatter.last_verified_at)
      : requireScalarField(spec, "updatedAt", frontmatter.updatedAt ?? "unknown");

    return {
      title,
      summary: createArchiveSummary(spec, title),
      section: "archive" as const,
      audience: "everyone" as const,
      status: isOneOf(frontmatter.status, DOCS_STATUSES) ? frontmatter.status : "active",
      sourceKind: "archived" as const,
      internal: false,
      updatedAt,
    };
  }

  const title = requireStringField(spec, "title", frontmatter.title);
  const summary = requireStringField(spec, "summary", frontmatter.summary);
  const updatedAt = requireScalarField(spec, "updatedAt", frontmatter.updatedAt);

  if (!isOneOf(frontmatter.section, DOCS_SECTIONS)) {
    throw new Error(`Docs page '${spec.slug.join("/") || "/"}' has invalid 'section' frontmatter.`);
  }
  if (!isOneOf(frontmatter.audience, DOCS_AUDIENCES)) {
    throw new Error(`Docs page '${spec.slug.join("/") || "/"}' has invalid 'audience' frontmatter.`);
  }
  if (!isOneOf(frontmatter.status, DOCS_STATUSES)) {
    throw new Error(`Docs page '${spec.slug.join("/") || "/"}' has invalid 'status' frontmatter.`);
  }
  if (frontmatter.sourceKind !== undefined && !isOneOf(frontmatter.sourceKind, SOURCE_KINDS)) {
    throw new Error(`Docs page '${spec.slug.join("/") || "/"}' has invalid 'sourceKind' frontmatter.`);
  }
  if (frontmatter.internal !== undefined && typeof frontmatter.internal !== "boolean") {
    throw new Error(`Docs page '${spec.slug.join("/") || "/"}' has invalid 'internal' frontmatter.`);
  }

  return {
    title,
    summary,
    section: frontmatter.section,
    audience: frontmatter.audience,
    status: frontmatter.status,
    sourceKind: frontmatter.sourceKind ?? "curated",
    internal: frontmatter.internal ?? false,
    updatedAt,
  };
}

function buildMeta(spec: RegisteredPageSpec, frontmatter: Frontmatter, rawContent: string): DocsPageMeta {
  const parsed = parseFrontmatter(spec, frontmatter, rawContent);
  return {
    slug: spec.slug,
    url: createPageUrl(spec.slug),
    title: parsed.title,
    summary: parsed.summary,
    section: parsed.section,
    audience: parsed.audience,
    status: parsed.status,
    sourceKind: parsed.sourceKind,
    internal: spec.internal ?? parsed.internal,
    archive: spec.archive ?? false,
    updatedAt: parsed.updatedAt,
    sourceUrl: `${REPO_BLOB_BASE_URL}/${spec.sourcePath ?? `apps/docs/content/${spec.filePath}`}`,
    toc: extractToc(rawContent),
    related: spec.related ?? [],
    archiveGroup: spec.archiveGroup,
  };
}

function deriveSearchPageKind(spec: RegisteredPageSpec, section: DocsSection) {
  if (spec.pageKind) {
    return spec.pageKind;
  }
  if (spec.archive) {
    return "archive" as const;
  }
  if (spec.slug.length === 0) {
    return "home" as const;
  }
  if (spec.slug.length <= 1) {
    return "landing" as const;
  }
  if (section === "build" || section === "deploy") {
    return "tutorial" as const;
  }
  if (section === "docs") {
    return "narrative" as const;
  }
  return "reference" as const;
}

function deriveSearchPriority(spec: RegisteredPageSpec, pageKind: ReturnType<typeof deriveSearchPageKind>) {
  if (typeof spec.priority === "number") {
    return spec.priority;
  }
  if (pageKind === "home") {
    return 80;
  }
  if (pageKind === "tutorial") {
    return 70;
  }
  if (pageKind === "narrative") {
    return 65;
  }
  if (pageKind === "reference") {
    return 60;
  }
  if (pageKind === "landing") {
    return 50;
  }
  return 0;
}

export const getAllPages = cache(async () => {
  const pages = await Promise.all(
    pageRegistry.map(async (spec) => {
      const rawSource = await readPageSource(spec);
      const parsed = matter(rawSource);
      const normalizedContent = normalizeMarkdownLinks(parsed.content, spec.sourcePath, routeMap);
      const meta = buildMeta(spec, parsed.data as Frontmatter, normalizedContent);
      return {
        spec,
        meta,
        rawContent: normalizedContent,
      };
    }),
  );

  return pages.sort((left, right) => left.meta.url.localeCompare(right.meta.url));
});

export function isPublicDocsPage(meta: DocsPageMeta) {
  return !meta.internal && !meta.archive && meta.section !== "archive" && meta.audience !== "maintainers";
}

export const getPublicPages = cache(async () => {
  const pages = await getAllPages();
  return pages.filter((page) => isPublicDocsPage(page.meta));
});

export const getPageMetaBySlug = cache(async (slug: string[]) => {
  const spec = findPageSpec(slug);
  if (!spec) {
    return null;
  }
  const pages = await getPublicPages();
  return pages.find((page) => page.meta.url === createPageUrl(slug))?.meta ?? null;
});

export const getRenderedPageBySlug = cache(async (slug: string[]): Promise<RenderedPage | null> => {
  const spec = findPageSpec(slug);
  if (!spec) {
    return null;
  }

  const rawSource = await readPageSource(spec);
  const parsed = matter(rawSource);
  const normalizedContent = normalizeMarkdownLinks(parsed.content, spec.sourcePath, routeMap);
  const meta = buildMeta(spec, parsed.data as Frontmatter, normalizedContent);
  const compiled = await compileMDX({
    source: normalizedContent,
    components: mdxComponents,
    options: {
      mdxOptions: {
        remarkPlugins: [remarkGfm],
        rehypePlugins: [rehypeSlug],
      },
    },
  });

  return {
    meta,
    content: compiled.content,
    rawContent: normalizedContent,
  };
});

export const getNavigation = cache(async (): Promise<NavGroup[]> => {
  const pages = await getPublicPages();
  const byUrl = new Map(pages.map((page) => [page.meta.url, page.meta]));
  const entry = (url: string): NavEntry => {
    const page = byUrl.get(url);
    if (!page) throw new Error(`Public docs navigation references missing or excluded page '${url}'.`);
    return { title: page.title, url, summary: page.summary, internal: false, sourceKind: page.sourceKind };
  };
  const group = (section: DocsNavSection, title: string, landingUrl: string, groups: Array<[string, string[]]>): NavGroup => ({
    section,
    title,
    landing: entry(landingUrl),
    groups: groups.map(([groupTitle, urls]) => ({ title: groupTitle, entries: urls.map(entry) })),
  });

  return [
    group("desktop", "Desktop", "/apps/desktop", [
      ["Start here", ["/apps/desktop", "/docs/quickstart", "/docs/why-kestrel", "/docs/core-concepts", "/docs/faq"]],
      ["Work locally", ["/cli/workspace-workflows", "/cli/kchat", "/cli/kcron"]],
      ["Companion surfaces", ["/apps/web"]],
    ]),
    group("build", "Build", "/build", [
      ["Start building", ["/build", "/build/workspace-copilot-demo", "/build/building-your-first-agent", "/build/running-your-first-streamed-request", "/build/adding-session-memory"]],
      ["Integrate", ["/build/openai-compatible-http", "/build/integrating-with-nextjs", "/build/nextjs-route-cookbook", "/build/adding-background-subscriptions", "/build/adding-observability"]],
      ["Automate", ["/build/workspaces-and-automation", "/build/automating-common-tasks"]],
    ]),
    group("deploy", "Deploy", "/deploy", [
      ["Deploy Kestrel", ["/deploy", "/deploy/running-the-runner-service", "/deploy/environment-and-auth", "/deploy/deployment-troubleshooting", "/cli/runner-service"]],
    ]),
    group("reference", "Reference", "/reference", [
      ["Concepts", ["/reference", "/reference/terminology", "/docs/architecture-overview", "/docs/runtime-model"]],
      ["CLI", ["/cli", "/cli/command-suite", "/cli/profiles-code-mode-and-mcp"]],
      ["Packages", ["/packages", "/packages/sdk", "/packages/next", "/packages/observability"]],
    ]),
  ];
});

export function getNavSectionForUrl(url: string): DocsNavSection {
  if (url.startsWith("/build")) return "build";
  if (url.startsWith("/deploy") || url === "/cli/runner-service") return "deploy";
  if (url.startsWith("/packages") || url === "/reference" || url.startsWith("/reference/") || url === "/cli" || url === "/cli/command-suite" || url === "/cli/profiles-code-mode-and-mcp" || url === "/docs/architecture-overview" || url === "/docs/runtime-model") return "reference";
  return "desktop";
}

export const getSectionPages = cache(async (section: DocsSection) => {
  const pages = await getPublicPages();
  return pages.filter((page) => page.meta.section === section && page.meta.url !== "/");
});

export const getRelatedPages = cache(async (meta: DocsPageMeta) => {
  const pages = await getPublicPages();
  const relatedByExplicitSlug = meta.related
    .map((slug) => pages.find((page) => page.meta.url === `/${slug}`)?.meta ?? null)
    .filter((page): page is DocsPageMeta => page !== null);

  if (relatedByExplicitSlug.length > 0) {
    return relatedByExplicitSlug;
  }

  return pages
    .filter((page) => page.meta.section === meta.section && page.meta.url !== meta.url && !page.meta.archive)
    .slice(0, 3)
    .map((page) => page.meta);
});

export const getSearchDocuments = cache(async (): Promise<SearchDocument[]> => {
  const pages = await getPublicPages();
  return pages.map((page) => ({
    id: page.meta.url,
    url: page.meta.url,
    title: page.meta.title,
    summary: page.meta.summary,
    section: page.meta.section,
    navSection: getNavSectionForUrl(page.meta.url),
    headings: page.meta.toc.map((item) => item.text),
    fullText: stripMarkdown(page.rawContent),
    internal: page.meta.internal,
    sourceKind: page.meta.sourceKind,
    pageKind: deriveSearchPageKind(page.spec, page.meta.section),
    priority: deriveSearchPriority(page.spec, deriveSearchPageKind(page.spec, page.meta.section)),
    capabilities: page.spec.capabilities ?? [],
  }));
});
