import type { MountaintopScenario } from "../types.js";

export const nextJsTemplateScaffoldRealUserCliScenario: MountaintopScenario = {
  id: "nextjs-template-scaffold-real-user-cli",
  title: "Next.js Template Scaffold Real User CLI",
  description:
    "Prove the CLI can scaffold a fresh Next.js app from an empty directory using a natural operator request and normal runtime finalization.",
  supportedEngines: ["cli"],
  promptEnvelope: "operator",
  provider: {
    profileId: "reference",
    provider: "openrouter",
    model: "google/gemini-3.1-flash-lite-preview",
  },
  setupCommands: ["/profiles use reference", "/mode build"],
  promptProgram: [
    {
      id: "operator-request",
      label: "Operator request",
      instruction:
        "Create a new Next.js app in this empty folder using TypeScript, the App Router, ESLint, and pnpm.",
    },
    {
      id: "workspace-root",
      label: "Workspace root",
      instruction:
        "Work in the current directory only. Do not scaffold into a nested subdirectory and do not use an absolute target path.",
    },
    {
      id: "real-scaffold",
      label: "Real scaffold path",
      instruction:
        "Use a real Next.js bootstrap command in this empty workspace, such as pnpm create next-app@latest . with the required flags, instead of hand-writing the framework boilerplate from scratch.",
    },
    {
      id: "completion-bar",
      label: "Definition of done",
      instruction:
        "Before you finish, make sure pnpm lint, pnpm exec tsc --noEmit, and pnpm build all pass from this workspace.",
    },
    {
      id: "no-bookkeeping",
      label: "No bookkeeping files",
      instruction:
        "Do not create generic bookkeeping files or memory notes unless the task explicitly requires them.",
    },
  ],
  requiredArtifacts: [
    "package.json",
    "next.config.ts",
    "tsconfig.json",
    "eslint.config.mjs",
  ],
  requiredArtifactAlternatives: [
    {
      paths: ["app/layout.tsx", "src/app/layout.tsx"],
    },
    {
      paths: ["app/page.tsx", "src/app/page.tsx"],
    },
    {
      paths: ["app/globals.css", "src/app/globals.css"],
    },
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
  completionMode: "runtime_finalize",
  completionTimeoutSeconds: 420,
};
