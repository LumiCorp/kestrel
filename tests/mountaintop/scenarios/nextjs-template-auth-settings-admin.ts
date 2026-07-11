import type { MountaintopScenario } from "../types.js";

export const nextJsTemplateAuthSettingsAdminScenario: MountaintopScenario = {
  id: "nextjs-template-auth-settings-admin",
  title: "Next.js Template Auth Settings Admin",
  description:
    "Build a small auth-aware settings/admin flow that preserves anonymous and authenticated behavior through the full quality gate chain.",
  provider: {
    profileId: "reference",
    provider: "openrouter",
    model: "google/gemini-3.1-flash-lite-preview",
  },
  setupCommands: ["/profiles use reference", "/mode build", "/code enable"],
  promptProgram: [
    {
      id: "workspace-contract",
      label: "Workspace contract",
      instruction:
        "Do not run /workspace or cd /workspace. The current directory from pwd is the scenario workspace root. Treat the repo as a fresh app scaffold unless files already exist.",
    },
    {
      id: "create-app",
      label: "Create Next app",
      instruction:
        "Run exactly once: CI=1 pnpm create next-app@15.4.5 . --ts --eslint --app --use-pnpm --yes",
    },
    {
      id: "install-deps",
      label: "Install local deps",
      instruction:
        "Run pnpm install exactly once, then do not run pnpm install again.",
    },
    {
      id: "bootstrap-contract",
      label: "Bootstrap completion contract",
      instruction:
        "If create-next-app prints Success and both package.json plus app/ exist, treat bootstrap as complete even when node_modules or pnpm-lock.yaml are absent in this workspace. Do not loop on preflight checks; continue directly to product work.",
    },
    {
      id: "auth-contract",
      label: "Auth contract",
      instruction:
        "Implement a deterministic auth stub using query-token checks only (no external auth provider). Use exact tokens demo-user and demo-admin. Keep the contract explicit and local.",
    },
    {
      id: "settings-admin-flow",
      label: "Build settings/admin flow",
      instruction:
        "Create app/lib/auth.ts plus app/settings/page.tsx and app/admin/page.tsx. /settings without token must render exact text 'Sign in required'. /admin without token must render exact text 'Unauthorized'. /admin?token=demo-admin must render exact text 'Admin Settings'. /settings?token=demo-user must render exact text 'User Settings'.",
    },
    {
      id: "next15-pageprops-contract",
      label: "Next.js 15 PageProps contract",
      instruction:
        "Keep route PageProps compatible with Next.js 15. If searchParams is typed, use Promise<Record<string, string | string[] | undefined>> and await it before token reads; do not use legacy object-typed searchParams signatures.",
    },
    {
      id: "home-surface",
      label: "Home route contract",
      instruction:
        "Update app/page.tsx to render exact title text 'Auth Settings Demo' and visible links or instructions for /settings?token=demo-user and /admin?token=demo-admin. Keep UI simple and smoke-test friendly.",
    },
    {
      id: "quality-gates",
      label: "Run quality checks",
      instruction:
        "Run pnpm lint, pnpm exec tsc --noEmit, and pnpm build in that order inside one shell command so the full gate chain executes back-to-back without extra status polling between successful gates. If a gate fails, apply one direct fix and rerun only the failing suffix chain in one shell command. Once all three pass in one chain, do not run additional build/lint/typecheck commands.",
    },
    {
      id: "settle-contract",
      label: "Settle contract",
      instruction:
        "When a dev.shell command is settled (no active command and a completion marker/exit code is present), do not issue another read/status for that same command; execute the next remediation or completion step immediately.",
    },
    {
      id: "completion-token",
      label: "Emit completion marker",
      instruction:
        "Immediately after the first successful lint+typecheck+build chain, print the marker in that same successful shell command by ending with exactly: printf 'MOUNTAINTOP_DONE:nextjs-template-auth-settings-admin\\n'. After printing the marker, do not call dev.process.read, dev.shell.status, or any further shell command.",
    },
  ],
  requiredArtifacts: [
    "package.json",
    "app/layout.tsx",
    "app/page.tsx",
    "app/settings/page.tsx",
    "app/admin/page.tsx",
    "app/lib/auth.ts",
  ],
  qualityGates: [
    {
      id: "lint",
      label: "pnpm lint",
      command: "pnpm",
      args: ["lint"],
      required: true,
    },
    {
      id: "typecheck",
      label: "typecheck",
      command: "pnpm",
      args: ["typecheck"],
      required: true,
    },
    {
      id: "build",
      label: "pnpm build",
      command: "pnpm",
      args: ["build"],
      required: true,
    },
  ],
  smokeRoutes: [
    { path: "/", contains: ["Auth Settings Demo"] },
    { path: "/settings", contains: ["Sign in required"] },
    { path: "/admin?token=demo-admin", contains: ["Admin Settings"] },
  ],
  completionMarker: "MOUNTAINTOP_DONE:nextjs-template-auth-settings-admin",
  completionTimeoutSeconds: 300,
};
