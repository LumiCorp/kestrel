import type { MountaintopScenario } from "../types.js";

export const nextJsTemplateFullStackTaskBoardScenario: MountaintopScenario = {
  id: "nextjs-template-full-stack-task-board",
  title: "Next.js Template Full-Stack Task Board",
  description:
    "Build a small full-stack task board with file-backed persistence, create/edit/archive behavior, and a visible task management UI.",
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
      id: "task-board-product-slice",
      label: "Build task board",
      instruction:
        "Create a small task board product slice in the root app. You must create all of these files: app/api/tasks/route.ts, app/lib/tasks.ts, and data/tasks.json. Use file-backed persistence under data/ and a minimal API route under app/api/tasks. Support creating a task, editing a task, archiving a task, validation for empty input, and an empty-state view.",
    },
    {
      id: "ui-contract",
      label: "Visible UI contract",
      instruction:
        "Make app/page.tsx render a clear Task Board page with an add-task form, a task list, and controls that prove edit/archive behavior is wired. The page must contain the exact visible strings 'Task Board' and 'Add task' for smoke checks.",
    },
    {
      id: "quality-gates",
      label: "Run quality checks",
      instruction:
        "Run these three commands as separate dev.shell.run calls with exact command text in this order: pnpm lint ; pnpm exec tsc --noEmit ; pnpm build. Do not prepend shell prologues, combine commands, or alias command text. If a gate fails, apply one direct fix and rerun only the failing gate chain. Once all three pass in one chain, do not run additional build/lint/typecheck commands.",
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
        "Immediately after the first successful lint+typecheck+build chain, run exactly: printf 'MOUNTAINTOP_DONE:nextjs-template-full-stack-task-board\\n' ; after printing the marker, do not call dev.process.read, dev.shell.status, or any further shell command.",
    },
  ],
  requiredArtifacts: [
    "package.json",
    "app/layout.tsx",
    "app/page.tsx",
    "app/api/tasks/route.ts",
    "app/lib/tasks.ts",
    "data/tasks.json",
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
    { path: "/", contains: ["Task Board", "Add task"] },
  ],
  completionMarker: "MOUNTAINTOP_DONE:nextjs-template-full-stack-task-board",
  completionTimeoutSeconds: 600,
};
