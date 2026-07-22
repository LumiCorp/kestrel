import type {
  ContentArchetype,
  DocsJourneyId,
  ExperienceLevel,
  ProductSurface,
  RegisteredPageSpec,
  SearchCapability,
  TocMode,
} from "@/lib/types";

interface PageOptions {
  sourceRefs?: string[];
  related?: string[];
  archetype?: ContentArchetype;
  surface?: ProductSurface;
  experienceLevel?: ExperienceLevel;
  estimatedTime?: string;
  tocMode?: TocMode;
  journeyId?: DocsJourneyId;
  priority?: number;
  capabilities?: SearchCapability[];
  internal?: boolean;
}

function defaultArchetype(slug: string): ContentArchetype {
  if (slug === "" || ["start", "desktop", "kestrel-one", "build", "operate", "reference"].includes(slug)) return "gateway";
  if (slug.includes("troubleshooting")) return "troubleshooting";
  if (slug.includes("upgrading") || slug.endsWith("/releases")) return "migration";
  if (slug.startsWith("reference/") || slug.startsWith("cli/")) return "reference";
  if (slug.startsWith("operate/")) return "operational-playbook";
  if (slug.startsWith("build/")) return "build-tutorial";
  if (slug.startsWith("desktop/") || slug.startsWith("kestrel-one/")) return "product-journey";
  return "explainer";
}

function defaultSurface(slug: string): ProductSurface {
  if (slug.startsWith("desktop")) return "desktop";
  if (slug.startsWith("kestrel-one")) return "kestrel-one";
  if (slug.startsWith("cli")) return "cli";
  if (slug.startsWith("operate")) return "operations";
  if (slug.startsWith("reference/protocol") || slug.startsWith("reference/events") || slug.startsWith("reference/terminal")) return "protocol";
  if (slug.startsWith("reference/next") || slug.includes("nextjs")) return "nextjs";
  if (slug.startsWith("reference")) return "runtime";
  if (slug.startsWith("build")) return "sdk";
  return "suite";
}

function page(slug: string, filePath: string, options: PageOptions = {}): RegisteredPageSpec {
  return {
    slug: slug === "" ? [] : slug.split("/"),
    filePath,
    archetype: options.archetype ?? defaultArchetype(slug),
    surface: options.surface ?? defaultSurface(slug),
    experienceLevel: options.experienceLevel ?? "beginner",
    tocMode: options.tocMode ?? (options.archetype === "gateway" || defaultArchetype(slug) === "gateway" ? "none" : "auto"),
    ...options,
  };
}

const curatedPages: RegisteredPageSpec[] = [
  page("", "docs/home.mdx", { sourceRefs: ["README.md"], archetype: "gateway", priority: 100 }),

  page("start", "docs/index.mdx", { sourceRefs: ["README.md", "ARCHITECTURE.md"], archetype: "gateway", priority: 98 }),
  page("start/quickstart", "docs/quickstart.mdx", { sourceRefs: ["README.md"], archetype: "gateway", related: ["desktop/install", "kestrel-one/getting-started", "build/building-your-first-agent"], priority: 99 }),
  page("start/concepts", "docs/core-concepts.mdx", { sourceRefs: ["DESIGN.md", "ARCHITECTURE.md"], related: ["start/architecture", "reference/terminology", "reference/terminal-results"] }),
  page("start/why-kestrel", "docs/why-kestrel.mdx", { sourceRefs: ["README.md", "DESIGN.md"], related: ["start/concepts", "desktop", "build"] }),
  page("start/architecture", "docs/architecture-overview.mdx", { sourceRefs: ["ARCHITECTURE.md", "README.md"], related: ["start/concepts", "reference/protocol", "operate/reliability"] }),
  page("start/faq", "docs/faq.mdx", { sourceRefs: ["README.md"], related: ["start/quickstart", "desktop/troubleshooting", "operate/troubleshooting"] }),
  page("start/release-status", "start/release-status.mdx", { sourceRefs: ["package.json", "apps/docs/package.json"], related: ["reference/compatibility", "reference/releases"], priority: 94 }),

  page("desktop", "apps/desktop.mdx", { sourceRefs: ["apps/desktop/package.json", "apps/desktop/README.md"], archetype: "gateway", priority: 97, capabilities: ["operator control"] }),
  page("desktop/install", "desktop/install.mdx", { sourceRefs: ["apps/desktop/README.md", "README.md"], archetype: "task-recipe", estimatedTime: "5 minutes", journeyId: "desktop-first-success", related: ["desktop/first-run", "desktop/providers"] }),
  page("desktop/first-run", "desktop/first-run.mdx", { sourceRefs: ["apps/desktop/renderer/src/DesktopApp.tsx"], estimatedTime: "10 minutes", journeyId: "desktop-first-success", related: ["desktop/install", "desktop/providers", "desktop/workspaces-and-sessions"] }),
  page("desktop/providers", "desktop/providers.mdx", { sourceRefs: ["apps/desktop/renderer/src/DesktopApp.tsx", ".env.example"], archetype: "task-recipe", related: ["desktop/first-run", "desktop/troubleshooting"] }),
  page("desktop/workspaces-and-sessions", "desktop/workspaces-and-sessions.mdx", { sourceRefs: ["docs/cli/workspaces.md", "apps/desktop/renderer/src/DesktopApp.tsx"], journeyId: "desktop-first-success", related: ["desktop/operator-control", "desktop/recovery"] }),
  page("desktop/operator-control", "desktop/operator-control.mdx", { sourceRefs: ["cli/app/App.ts", "apps/desktop/renderer/src/DesktopApp.tsx"], journeyId: "desktop-first-success", related: ["desktop/workspaces-and-sessions", "desktop/recovery"], capabilities: ["operator control"] }),
  page("desktop/recovery", "desktop/recovery.mdx", { sourceRefs: ["apps/desktop/README.md", "RELIABILITY.md"], archetype: "operational-playbook", experienceLevel: "intermediate", journeyId: "desktop-first-success", related: ["desktop/operator-control", "desktop/troubleshooting"] }),
  page("desktop/troubleshooting", "desktop/troubleshooting.mdx", { sourceRefs: ["apps/desktop/README.md", "apps/desktop/renderer/src/DesktopApp.tsx"], related: ["desktop/providers", "desktop/recovery"] }),

  page("kestrel-one", "apps/web.mdx", { sourceRefs: ["apps/web/app/route-ownership.manifest.ts", "apps/web/README.md"], archetype: "gateway", priority: 99, capabilities: ["threads", "projects", "knowledge", "managed models", "access control"] }),
  page("kestrel-one/getting-started", "kestrel-one/getting-started.mdx", { sourceRefs: ["apps/web/README.md"], estimatedTime: "10 minutes", journeyId: "kestrel-one-collaboration", related: ["kestrel-one/threads", "kestrel-one/projects"] }),
  page("kestrel-one/threads", "kestrel-one/threads.mdx", { sourceRefs: ["apps/web/app/route-ownership.manifest.ts", "apps/web/lib/threads/store.ts"], journeyId: "kestrel-one-collaboration", related: ["kestrel-one/projects", "kestrel-one/artifacts-and-sharing"], priority: 98, capabilities: ["threads"] }),
  page("kestrel-one/projects", "kestrel-one/projects.mdx", { sourceRefs: ["apps/web/app/route-ownership.manifest.ts", "apps/web/lib/projects/store.ts"], journeyId: "kestrel-one-collaboration", related: ["kestrel-one/threads", "kestrel-one/apps", "kestrel-one/context-revisions"], priority: 97, capabilities: ["projects", "access control"] }),
  page("kestrel-one/apps", "kestrel-one/apps.mdx", { sourceRefs: ["apps/web/app/route-ownership.manifest.ts", "apps/web/lib/apps/service.ts", "apps/web/lib/apps/types.ts"], journeyId: "kestrel-one-collaboration", related: ["kestrel-one/projects", "kestrel-one/environments"], priority: 96, capabilities: ["apps", "access control"] }),
  page("kestrel-one/context-revisions", "kestrel-one/context-revisions.mdx", { sourceRefs: ["apps/web/lib/projects/store.ts"], archetype: "explainer", journeyId: "kestrel-one-collaboration", related: ["kestrel-one/projects", "kestrel-one/knowledge"], capabilities: ["projects", "knowledge"] }),
  page("kestrel-one/knowledge", "kestrel-one/knowledge.mdx", { sourceRefs: ["apps/web/README.md", "apps/web/app/route-ownership.manifest.ts"], journeyId: "kestrel-one-collaboration", related: ["kestrel-one/context-revisions", "kestrel-one/artifacts-and-sharing"], capabilities: ["knowledge"] }),
  page("kestrel-one/artifacts-and-sharing", "kestrel-one/artifacts-and-sharing.mdx", { sourceRefs: ["apps/web/app/route-ownership.manifest.ts"], journeyId: "kestrel-one-collaboration", related: ["kestrel-one/threads", "kestrel-one/knowledge"], capabilities: ["threads"] }),
  page("kestrel-one/organizations-and-access", "kestrel-one/organizations-and-access.mdx", { sourceRefs: ["apps/web/lib/knowledge/auth.ts", "apps/web/app/route-ownership.manifest.ts"], archetype: "explainer", experienceLevel: "intermediate", related: ["kestrel-one/projects", "kestrel-one/administration"], capabilities: ["access control", "projects"] }),
  page("kestrel-one/environments", "kestrel-one/environments.mdx", { sourceRefs: ["apps/web/app/route-ownership.manifest.ts", "apps/web/lib/environments/contracts.ts", "apps/web/lib/apps/service.ts"], archetype: "explainer", experienceLevel: "advanced", related: ["kestrel-one/apps", "kestrel-one/administration"], capabilities: ["environments", "apps", "access control"] }),
  page("kestrel-one/models-and-gateways", "kestrel-one/models-and-gateways.mdx", { sourceRefs: ["apps/web/README.md", "apps/web/lib/ai/gateway-credential-lease.ts"], archetype: "explainer", experienceLevel: "advanced", related: ["kestrel-one/managed-model-deployments", "operate/model-authority"], capabilities: ["gateways", "managed models"] }),
  page("kestrel-one/managed-model-deployments", "kestrel-one/managed-model-deployments.mdx", { sourceRefs: ["apps/web/lib/ai/managed-runpod-config.ts", "apps/web/app/route-ownership.manifest.ts"], experienceLevel: "advanced", related: ["kestrel-one/models-and-gateways", "kestrel-one/production-operations"], priority: 95, capabilities: ["managed models", "gateways", "access control"] }),
  page("kestrel-one/administration", "kestrel-one/administration.mdx", { sourceRefs: ["apps/web/app/route-ownership.manifest.ts", "apps/web/README.md"], archetype: "gateway", experienceLevel: "advanced", related: ["kestrel-one/organizations-and-access", "kestrel-one/production-operations"], capabilities: ["access control", "gateways"] }),
  page("kestrel-one/production-operations", "kestrel-one/production-operations.mdx", { sourceRefs: ["apps/web/README.md", "apps/web/lib/ai/managed-runpod-config.ts"], archetype: "operational-playbook", experienceLevel: "advanced", related: ["kestrel-one/administration", "operate/reliability"], capabilities: ["managed models", "gateways"] }),

  page("build", "build/index.mdx", { sourceRefs: ["packages/sdk/README.md"], archetype: "gateway", priority: 96 }),
  page("build/building-your-first-agent", "build/building-your-first-agent.mdx", { sourceRefs: ["packages/sdk/README.md", "packages/sdk/src/agent.ts"], estimatedTime: "15 minutes", journeyId: "reference-agent-build", related: ["build/protocol-and-results", "build/running-your-first-streamed-request"], priority: 99 }),
  page("build/running-your-first-streamed-request", "build/running-your-first-streamed-request.mdx", { sourceRefs: ["packages/sdk/README.md"], journeyId: "reference-agent-build", related: ["build/runner-events", "build/waiting-resume-and-cancellation"], priority: 93, capabilities: ["terminal results"] }),
  page("build/adding-session-memory", "build/adding-session-memory.mdx", { sourceRefs: ["packages/sdk/README.md", "packages/sdk/src/agent.ts"], journeyId: "reference-agent-build", related: ["build/integrating-with-nextjs"] }),
  page("build/adding-background-subscriptions", "build/adding-background-subscriptions.mdx", { sourceRefs: ["packages/sdk/README.md"], archetype: "task-recipe", experienceLevel: "intermediate" }),
  page("build/integrating-with-nextjs", "build/integrating-with-nextjs.mdx", { sourceRefs: ["packages/next/README.md"], surface: "nextjs", journeyId: "reference-agent-build", related: ["build/nextjs-route-cookbook", "operate/environment-and-auth"], priority: 95, capabilities: ["nextjs"] }),
  page("build/nextjs-route-cookbook", "build/nextjs-route-cookbook.mdx", { sourceRefs: ["packages/next/src/routes.ts"], archetype: "task-recipe", surface: "nextjs", experienceLevel: "intermediate", tocMode: "full", capabilities: ["nextjs", "terminal results"] }),
  page("build/openai-compatible-http", "build/openai-compatible-http.mdx", { sourceRefs: ["tests/integration/runner-service-openai-compat.test.ts"], experienceLevel: "intermediate", priority: 97, capabilities: ["openai-compatible http"] }),
  page("build/adding-observability", "build/adding-observability.mdx", { sourceRefs: ["packages/observability/README.md"], experienceLevel: "intermediate", journeyId: "reference-agent-build" }),
  page("build/protocol-and-results", "build/protocol-and-results.mdx", { sourceRefs: ["packages/protocol/src/index.ts", "packages/sdk/src/contracts.ts"], archetype: "explainer", surface: "protocol", related: ["reference/protocol", "reference/terminal-results"], priority: 98, capabilities: ["protocol", "terminal results"] }),
  page("build/runner-events", "build/runner-events.mdx", { sourceRefs: ["packages/protocol/src/index.ts", "cli/protocol/contracts.ts"], archetype: "explainer", surface: "protocol", experienceLevel: "intermediate", related: ["reference/events", "build/waiting-resume-and-cancellation"], capabilities: ["protocol", "terminal results"] }),
  page("build/waiting-resume-and-cancellation", "build/waiting-resume-and-cancellation.mdx", { sourceRefs: ["packages/sdk/src/agent.ts", "src/runtime/waitForPrompt.ts"], archetype: "explainer", experienceLevel: "intermediate", journeyId: "reference-agent-build", related: ["build/runner-events", "reference/terminal-results"], capabilities: ["terminal results", "operator control"] }),
  page("build/upgrading-to-0-6", "build/upgrading-to-0-6.mdx", { sourceRefs: ["packages/protocol/src/index.ts", "packages/sdk/src/contracts.ts"], related: ["reference/compatibility", "reference/releases"], priority: 96, capabilities: ["protocol", "terminal results"] }),

  page("operate", "operations/index.mdx", { sourceRefs: ["RELIABILITY.md", "SECURITY.md"], archetype: "gateway", priority: 95 }),
  page("operate/runner-service", "deploy/running-the-runner-service.mdx", { sourceRefs: ["tests/integration/web-command.test.ts", "cli/webCommand.ts"], archetype: "task-recipe", experienceLevel: "intermediate", priority: 94, capabilities: ["runner service"] }),
  page("operate/environment-and-auth", "deploy/environment-and-auth.mdx", { sourceRefs: ["cli/runner/service.ts", "packages/next/src/routes.ts"], related: ["operate/runner-service", "operate/credential-leases"], capabilities: ["runner service", "access control"] }),
  page("operate/deployment", "deploy/production-operating-model.mdx", { sourceRefs: ["ARCHITECTURE.md", "RELIABILITY.md"], related: ["operate/reliability", "kestrel-one/production-operations"] }),
  page("operate/credential-leases", "operate/credential-leases.mdx", { sourceRefs: ["apps/web/lib/ai/gateway-credential-lease.ts"], archetype: "explainer", experienceLevel: "advanced", related: ["operate/model-authority", "kestrel-one/models-and-gateways"], capabilities: ["gateways", "access control"] }),
  page("operate/model-authority", "operate/model-authority.mdx", { sourceRefs: ["apps/web/lib/ai/gateway-credential-lease.ts", "apps/web/lib/ai/managed-runpod-access.ts"], archetype: "explainer", experienceLevel: "advanced", related: ["operate/credential-leases", "kestrel-one/managed-model-deployments"], capabilities: ["gateways", "managed models", "access control"] }),
  page("operate/observability", "operations/artifact-inspection.mdx", { sourceRefs: ["RELIABILITY.md", "packages/observability/README.md"], related: ["operate/reliability", "reference/observability"], capabilities: ["artifact inspection"] }),
  page("operate/operator-control", "operations/operator-control-workflows.mdx", { sourceRefs: ["docs/cli/kchat.md", "packages/sdk/src/KestrelClient.ts"], related: ["desktop/operator-control", "operate/review-and-state"], capabilities: ["operator control"] }),
  page("operate/review-and-state", "operations/review-and-state-workflows.mdx", { sourceRefs: ["packages/sdk/src/KestrelClient.ts"], related: ["operate/operator-control", "reference/sdk"], capabilities: ["project review", "task graph", "project snapshot"] }),
  page("operate/security", "operations/security.mdx", { sourceRefs: ["SECURITY.md"], archetype: "explainer", experienceLevel: "advanced", related: ["operate/environment-and-auth", "kestrel-one/organizations-and-access"], capabilities: ["access control"] }),
  page("operate/reliability", "operations/reliability.mdx", { sourceRefs: ["RELIABILITY.md"], related: ["operate/replay", "operate/evaluations"] }),
  page("operate/replay", "runtime/store-and-replay.mdx", { sourceRefs: ["ARCHITECTURE.md", "RELIABILITY.md"], related: ["operate/reliability", "operate/evaluations"], capabilities: ["runtime", "evaluation"] }),
  page("operate/evaluations", "operations/evaluations.mdx", { sourceRefs: ["evals/README.md"], related: ["operate/quality-gates", "operate/replay"], priority: 92, capabilities: ["evaluation"] }),
  page("operate/quality-gates", "operations/quality-gates.mdx", { sourceRefs: ["QUALITY_SCORE.md"], related: ["operate/evaluations", "operate/reliability"] }),
  page("operate/troubleshooting", "deploy/deployment-troubleshooting.mdx", { sourceRefs: ["README.md", "RELIABILITY.md"], related: ["operate/runner-service", "operate/reliability"] }),

  page("reference", "reference/index.mdx", { sourceRefs: ["docs/index.md"], archetype: "gateway", priority: 91 }),
  page("reference/protocol", "reference/protocol.mdx", { sourceRefs: ["packages/protocol/src/index.ts", "packages/protocol/package.json"], related: ["reference/terminal-results", "reference/events", "reference/compatibility"], priority: 99, capabilities: ["protocol", "terminal results"] }),
  page("reference/sdk", "packages/sdk.mdx", { sourceRefs: ["packages/sdk/README.md", "packages/sdk/src/contracts.ts"], surface: "sdk", experienceLevel: "intermediate", tocMode: "full", related: ["reference/protocol", "reference/terminal-results"], priority: 98, capabilities: ["protocol", "operator control"] }),
  page("reference/nextjs", "packages/next.mdx", { sourceRefs: ["packages/next/README.md"], surface: "nextjs", experienceLevel: "intermediate", tocMode: "full", related: ["build/integrating-with-nextjs", "reference/sdk"], capabilities: ["nextjs"] }),
  page("reference/observability", "packages/observability.mdx", { sourceRefs: ["packages/observability/README.md"], surface: "sdk", experienceLevel: "intermediate", related: ["build/adding-observability", "operate/observability"] }),
  page("reference/workspace-skills", "packages/workspace-skills.mdx", { sourceRefs: ["packages/workspace-skills/README.md", "packages/workspace-skills/src/contracts.ts"], surface: "sdk", experienceLevel: "intermediate", related: ["desktop/workspaces-and-sessions", "operate/security"] }),
  page("reference/ai-sdk", "packages/ai-sdk.mdx", { sourceRefs: ["packages/ai-sdk/README.md", "packages/ai-sdk/src/index.ts", "packages/ai-sdk/package.json"], surface: "sdk", experienceLevel: "intermediate", related: ["reference/sdk", "reference/protocol"] }),
  page("reference/http", "reference/http.mdx", { sourceRefs: ["tests/integration/runner-service-openai-compat.test.ts"], experienceLevel: "intermediate", tocMode: "full", capabilities: ["openai-compatible http"] }),
  page("reference/terminal-results", "reference/terminal-results.mdx", { sourceRefs: ["packages/protocol/src/index.ts", "packages/sdk/src/contracts.ts"], related: ["reference/protocol", "reference/events"], priority: 97, capabilities: ["protocol", "terminal results"] }),
  page("reference/events", "reference/events.mdx", { sourceRefs: ["cli/protocol/contracts.ts", "packages/protocol/src/index.ts"], related: ["reference/protocol", "reference/terminal-results"], capabilities: ["protocol", "terminal results"] }),
  page("reference/configuration", "reference/configuration.mdx", { sourceRefs: [".env.example", "apps/web/.env.example"], related: ["operate/environment-and-auth", "cli/profiles-code-mode-and-mcp"] }),
  page("reference/compatibility", "reference/compatibility.mdx", { sourceRefs: ["package.json", "packages/protocol/package.json", "packages/sdk/package.json", "packages/next/package.json", "packages/ai-sdk/package.json", "packages/observability/package.json", "packages/workspace-skills/package.json"], related: ["reference/releases", "build/upgrading-to-0-6"], priority: 96 }),
  page("reference/releases", "reference/releases.mdx", { sourceRefs: ["package.json"], related: ["start/release-status", "reference/compatibility"] }),
  page("reference/terminology", "reference/terminology.mdx", { sourceRefs: ["README.md", "ARCHITECTURE.md"], related: ["start/concepts", "reference/protocol"] }),
  page("reference/cli", "cli/index.mdx", { sourceRefs: ["README.md", "docs/cli/kchat.md"], related: ["cli/kchat", "cli/command-suite"] }),
  page("cli/command-suite", "cli/command-suite.mdx", { sourceRefs: ["README.md", "docs/cli/kchat.md"], capabilities: ["cli"] }),
  page("cli/kchat", "cli/kchat.mdx", { sourceRefs: ["docs/cli/kchat.md", "cli/protocol/contracts.ts"], capabilities: ["cli", "operator control"] }),
  page("cli/kcron", "cli/kcron.mdx", { sourceRefs: ["cli/kcron.ts"], capabilities: ["cli"] }),
  page("cli/workspace-workflows", "cli/workspace-workflows.mdx", { sourceRefs: ["docs/cli/workspaces.md"], capabilities: ["cli"] }),
  page("cli/runner-service", "cli/runner-service.mdx", { sourceRefs: ["cli/webCommand.ts"], capabilities: ["cli", "runner service"] }),
  page("cli/profiles-code-mode-and-mcp", "cli/profiles-code-mode-and-mcp.mdx", { sourceRefs: ["docs/cli/kchat.md", "cli/config/ProfileStore.ts"], capabilities: ["cli", "profiles, code mode, and mcp"] }),

  page("archive", "archive/index.mdx", { sourceRefs: ["docs/PLANS.md"], archetype: "gateway", priority: 20, internal: true }),
];

const archivedPlans: RegisteredPageSpec[] = [
  "2026-04-20-desktop-project-library-persistence-design",
  "2026-04-20-thread-titlebar-icon-first-design",
  "2026-04-20-thread-titlebar-icon-first-implementation-plan",
  "2026-04-27-terminal-bench-dual-adapter-design",
  "2026-04-28-terminal-bench-task-queue-improvement-loop-design",
  "2026-05-11-terminal-bench-completion-boundary-hardening",
  "2026-05-13-composer-multimodal-followups-design",
  "2026-05-14-reference-react-command-processor-milestones",
].map((slug) => ({
  slug: ["archive", "plans", slug],
  sourcePath: `docs/plans/${slug}.md`,
  archetype: "reference" as const,
  surface: "suite" as const,
  experienceLevel: "advanced" as const,
  tocMode: "auto" as const,
  archive: true,
  archiveGroup: "plans" as const,
}));

const archivedRunbooks: RegisteredPageSpec[] = [
  "2026-02-25-kestrel-mvp-operator-runbook",
  "2026-02-26-v3-migration-runbook",
].map((slug) => ({
  slug: ["archive", "runbooks", slug],
  sourcePath: `docs/runbooks/${slug}.md`,
  archetype: "operational-playbook" as const,
  surface: "operations" as const,
  experienceLevel: "advanced" as const,
  tocMode: "auto" as const,
  archive: true,
  archiveGroup: "runbooks" as const,
}));

export const pageRegistry = [...curatedPages, ...archivedPlans, ...archivedRunbooks];

const slugSet = new Set<string>();
for (const spec of pageRegistry) {
  const key = spec.slug.join("/");
  if (slugSet.has(key)) throw new Error(`Duplicate docs slug registered: '${key || "/"}'.`);
  slugSet.add(key);
}

export function findPageSpec(slug: string[]) {
  return pageRegistry.find((spec) => spec.slug.length === slug.length && spec.slug.every((segment, index) => segment === slug[index])) ?? null;
}
