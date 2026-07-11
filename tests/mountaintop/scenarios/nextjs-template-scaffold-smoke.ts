import type { MountaintopScenario } from "../types.js";

export const nextJsTemplateScaffoldSmokeScenario: MountaintopScenario = {
  id: "nextjs-template-scaffold-smoke",
  title: "Next.js Template Scaffold Smoke",
  description:
    "Build a fresh Next.js app from an empty workspace and verify the scaffold with lint, typecheck, build, and server startup.",
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
        "Do not run /workspace or cd /workspace. The current directory from pwd is the scenario workspace root. Treat the repo as an empty app scaffold target unless files already exist.",
    },
    {
      id: "create-app",
      label: "Create Next app",
      instruction:
        "Run exactly once: CI=1 pnpm create next-app@15.4.5 . --ts --eslint --app --use-pnpm --yes",
    },
    {
      id: "root-scaffold-contract",
      label: "Root scaffold contract",
      instruction:
        "The scaffold target must be '.' from the workspace root. Do not pass an absolute workspace path or a nested directory name to create-next-app.",
    },
    {
      id: "bootstrap-completion-contract",
      label: "Bootstrap completion contract",
      instruction:
        "If create-next-app prints Success and package.json plus app/page.tsx exist, treat bootstrap as complete. Do not rerun create-next-app, pnpm create, or npx create-next-app after that point, even if node_modules, .next, or pnpm-lock.yaml are absent or incomplete.",
    },
    {
      id: "quality-gates",
      label: "Run scaffold quality checks",
      instruction:
        "After the scaffold is complete, run these three commands as separate dev.shell.run calls with exact command text in this order: pnpm lint ; pnpm exec tsc --noEmit ; pnpm build. If a gate fails, apply one direct fix and rerun only the failing gate chain. Do not rerun the scaffold command to repair a quality gate.",
    },
    {
      id: "settle-contract",
      label: "Settle contract",
      instruction:
        "When a dev.shell command is settled with a completion marker or exit code, do not issue another read/status for that same command; execute the next required step immediately.",
    },
    {
      id: "completion-token",
      label: "Emit completion marker",
      instruction:
        "Immediately after the first successful lint+typecheck+build chain, run exactly: printf 'MOUNTAINTOP_DONE:nextjs-template-scaffold-smoke\\n' ; after printing the marker, do not call dev.process.read, dev.shell.status, or any further shell command.",
    },
  ],
  requiredArtifacts: [
    "package.json",
    "app/layout.tsx",
    "app/page.tsx",
    "app/globals.css",
    "next.config.ts",
    "tsconfig.json",
    "eslint.config.mjs",
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
      args: ["exec", "tsc", "--noEmit"],
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
  smokeRoutes: [],
  completionMarker: "MOUNTAINTOP_DONE:nextjs-template-scaffold-smoke",
  completionTimeoutSeconds: 420,
};
