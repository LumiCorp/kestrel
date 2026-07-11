import type { MountaintopScenario } from "../types.js";

export const nextJsTemplateLongRunningStatefulWorkflowScenario: MountaintopScenario = {
  id: "nextjs-template-long-running-stateful-workflow",
  title: "Next.js Template Long-Running Stateful Workflow",
  description:
    "Build a long-horizon workflow console where later flows depend on persisted state from earlier milestones without resetting history.",
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
      id: "stage-one-foundation",
      label: "Stage one foundation",
      instruction:
        "Create a workflow foundation in app/lib/workflow.ts and app/api/workflow/route.ts backed by data/workflow.json. The persisted model must include activeRun, checkpoints, and history arrays.",
    },
    {
      id: "stage-two-dependent-flow",
      label: "Stage two dependent flow",
      instruction:
        "Extend the app with a continue/resume flow that depends on stage one persisted activeRun and checkpoints. Do not reset history or rewrite identifiers when adding this extension.",
    },
    {
      id: "stage-three-long-horizon",
      label: "Stage three long-horizon flow",
      instruction:
        "Add a second dependent flow for promoting a checkpoint into a completed milestone and append that transition to history. Keep prior checkpoints visible and consistent with the persisted data shape.",
    },
    {
      id: "artifact-order-contract",
      label: "Artifact order contract",
      instruction:
        "Implement the product slice in this exact file order as separate typed filesystem writes: data/workflow.json, app/lib/workflowTypes.ts, app/lib/workflow.ts, app/api/workflow/route.ts, app/components/WorkflowConsoleClient.tsx, app/page.tsx, app/history/page.tsx. Each write must target exactly the next listed path and, after that write succeeds, move immediately to the next listed path. Do not skip route/page artifacts, do not emit placeholder writes, and do not leave the default create-next-app home page in place.",
    },
    {
      id: "history-surface",
      label: "History route contract",
      instruction:
        "Create app/history/page.tsx that renders exact title text 'Workflow Timeline' and shows persisted history entries from data/workflow.json. This route file must exist before any lint/typecheck/build command is allowed to run.",
    },
    {
      id: "home-surface",
      label: "Home route contract",
      instruction:
        "Replace the default create-next-app home page in app/page.tsx. The file must render exact title text 'Long-Running Workflow Console' and exact text 'Resume pending workflow'. Do not leave starter imports, starter links, starter images, or starter copy in app/page.tsx, and do not run quality gates until this replacement is complete. The page must clearly show active workflow state plus checkpoint controls.",
    },
    {
      id: "client-component-contract",
      label: "Client component contract",
      instruction:
        "Create app/components/WorkflowConsoleClient.tsx as the interactive workflow console surface and wire app/page.tsx to the persisted workflow model through local imports. Do not skip this component or inline it into an unrelated starter page. Keep hook dependencies lint-clean: if checkpoints/history fallback arrays are derived from props, memoize those fallbacks or otherwise keep their identities stable so react-hooks/exhaustive-deps does not warn about a logical-expression dependency changing on every render.",
    },
    {
      id: "lint-sensitive-contract",
      label: "Lint-sensitive constraints",
      instruction:
        "Use next/link for internal navigation to /history and avoid raw <a> links for internal routes. Do not use any in source files; use explicit interfaces/unions so @typescript-eslint/no-explicit-any passes.",
    },
    {
      id: "react-types-contract",
      label: "React and TypeScript signatures",
      instruction:
        "Keep App Router component signatures strict-TypeScript safe. Do not annotate route pages or client components with JSX.Element or Promise<JSX.Element>; prefer inferred return types instead. Do not leave unused generic parameters or unused exhaustiveness locals such as _exhaustive in source files. In app/lib/workflow.ts, avoid impossible literal comparisons created by control-flow narrowing; do not compare a status already narrowed to 'active' against 'completed' in the same branch, and keep run status/stage transitions representable by the declared unions. When promoting checkpoints, do not let the mapped checkpoints array widen status to string: return a true WorkflowCheckpoint[] and keep the promoted status typed as the CheckpointStatus literal 'promoted'. Keep workflow history writes assignable to the WorkflowHistoryEntry discriminated union: do not funnel run_resumed/checkpoint_completed/checkpoint_promoted/milestone_completed payloads through Omit<WorkflowHistoryEntry, 'eventId' | 'at'> because event-specific fields such as fromStage, checkpointId, and milestoneCheckpointId must stay present on the matching union member. Use a helper shape that preserves the event-specific member type when appending history entries. If you use an appendHistoryEntry helper, pass a full discriminated union member with its literal type already present and let the helper add only eventId and at. Do not call the helper with payloads that omit type, and do not construct helper returns as { type, ...entry } when entry already includes type because TypeScript will report that type is specified more than once.",
    },
    {
      id: "shell-shape-contract",
      label: "Shell shape contract",
      instruction:
        "Keep implementation shell commands shell-safe, bounded, and balanced. Pass raw shell command text directly to dev.shell.run only for installs, checks, tests, builds, and non-mutating inspection. Do not use shell commands for source file edits; create and rewrite source files with typed filesystem tools. Do not wrap shell commands in surrounding single quotes, double quotes, JSON strings, markdown fences, escaped newline sequences, or explanatory prose, and keep shell commands non-interactive.",
    },
    {
      id: "quality-gates",
      label: "Run quality checks",
      instruction:
        "Do not start pnpm lint, pnpm exec tsc --noEmit, or pnpm build until these files all exist and are non-starter implementations: data/workflow.json, app/lib/workflowTypes.ts, app/lib/workflow.ts, app/api/workflow/route.ts, app/components/WorkflowConsoleClient.tsx, app/page.tsx, and app/history/page.tsx. Then run pnpm lint, pnpm exec tsc --noEmit, and pnpm build in that order inside one shell command so the full gate chain executes back-to-back without extra status polling between successful gates. If a gate fails, apply one direct fix and rerun only the failing suffix chain in one shell command. Do not rerun pnpm lint after it already passed if the remaining failure is in pnpm exec tsc --noEmit or pnpm build, and do not stop at lint-only warnings while required typecheck/build gates still remain. Once all three pass in one chain, do not run additional build/lint/typecheck commands.",
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
        "Immediately after the first successful lint+typecheck+build chain, print the marker in that same successful shell command by ending with exactly: printf 'MOUNTAINTOP_DONE:nextjs-template-long-running-stateful-workflow\\n'. After printing the marker, do not call dev.process.read, dev.shell.status, or any further shell command.",
    },
  ],
  requiredArtifacts: [
    "package.json",
    "app/layout.tsx",
    "app/page.tsx",
    "app/history/page.tsx",
    "app/api/workflow/route.ts",
    "app/lib/workflow.ts",
    "data/workflow.json",
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
    { path: "/", contains: ["Long-Running Workflow Console", "Resume pending workflow"] },
    { path: "/history", contains: ["Workflow Timeline"] },
  ],
  completionMarker: "MOUNTAINTOP_DONE:nextjs-template-long-running-stateful-workflow",
  completionTimeoutSeconds: 600,
};
