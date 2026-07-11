import type { MountaintopScenario } from "../types.js";

export const nextJsTemplateDualShellScenario: MountaintopScenario = {
  id: "nextjs-template-dual-shell",
  title: "Next.js Template Dual Shell",
  description: "Build a simple multi-page Next.js app through both CLI/TUI and web shells with strict quality gates.",
  provider: {
    profileId: "reference",
    provider: "openrouter",
    model: "google/gemini-3.1-flash-lite-preview",
  },
  setupCommands: [
    "/profiles use reference",
    "/mode build",
    "/code enable",
  ],
  promptProgram: [
    {
      id: "workspace-contract",
      label: "Workspace contract",
      instruction:
        "Do not run /workspace or cd /workspace. The current directory from pwd is the scenario workspace root.",
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
        "If create-next-app prints Success and both package.json plus app/ exist, treat bootstrap as complete even when node_modules or pnpm-lock.yaml are absent in this workspace. Do not loop on preflight checks; continue directly to file overwrites.",
    },
    {
      id: "create-pages",
      label: "Create pages",
      instruction:
        "Without exploratory reads, overwrite app/page.tsx, app/about/page.tsx, and app/contact/page.tsx with minimal components rendering h1 text Mountain Top Home/About/Contact.",
    },
    {
      id: "shared-layout",
      label: "Shared layout",
      instruction:
        "Without exploratory reads, overwrite app/layout.tsx with a minimal RootLayout that imports globals.css, renders nav links to /, /about, /contact, and renders {children}.",
    },
    {
      id: "quality-gates",
      label: "Run quality checks",
      instruction:
        "Run pnpm lint, pnpm exec tsc --noEmit, and pnpm build in that order inside one shell command so the full gate chain executes back-to-back without extra status polling between successful gates. If a gate fails, apply one direct fix and rerun only the failing gate chain in one shell command. Once all three pass in one chain, do not run additional build/lint/typecheck commands.",
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
        "Immediately after first successful lint+typecheck+build chain, run exactly: printf 'MOUNTAINTOP_DONE:nextjs-template-dual-shell\\n' ; after printing the marker, do not call dev.process.read, dev.shell.status, or any further shell command.",
    },
  ],
  requiredArtifacts: [
    "package.json",
    "app/layout.tsx",
    "app/page.tsx",
    "app/about/page.tsx",
    "app/contact/page.tsx",
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
    { path: "/", contains: ["Mountain Top Home"] },
    { path: "/about", contains: ["Mountain Top About"] },
    { path: "/contact", contains: ["Mountain Top Contact"] },
  ],
  completionMarker: "MOUNTAINTOP_DONE:nextjs-template-dual-shell",
  completionTimeoutSeconds: 300,
};
