import type { MountaintopScenario } from "../types.js";

export const nextJsTemplateStagedStatefulWorkflowScenario: MountaintopScenario = {
  id: "nextjs-template-staged-stateful-workflow",
  title: "Next.js Template Staged Stateful Workflow",
  description:
    "Build a checkpoint planner in stages so earlier persisted state remains meaningful as the feature grows.",
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
      id: "stage-one",
      label: "Checkpoint foundation",
      instruction:
        "Build the first stage of a checkpoint planner with persisted state in data/. Create exact files app/api/checkpoints/route.ts, app/lib/checkpoints.ts, and data/checkpoints.json (do not rename these paths). Seed data/checkpoints.json deterministically with a current checkpoint id 'cp-001' and a saved checkpoint list containing that same id.",
    },
    {
      id: "stage-two",
      label: "Dependent extension",
      instruction:
        "Extend the same workflow with a resume or continue-from-last-checkpoint view that depends on the stage one data model. Preserve the original checkpoint records and do not reset the store when adding the new view.",
    },
    {
      id: "stage-three",
      label: "History and safety",
      instruction:
        "Add a visible history or timeline view so prior checkpoints remain useful after the extension. Keep the earlier behavior intact, add validation and empty-state handling, and do not rewrite the persisted data shape unless the extension truly needs it.",
    },
    {
      id: "types-contract",
      label: "Strict types contract",
      instruction:
        "Keep generated source strict-TypeScript safe and lint-clean. Do not use any in app/lib/checkpoints.ts, app/api/checkpoints/route.ts, app/components/CheckpointPlannerClient.tsx, or other generated source files; use explicit interfaces/unions and narrowable record checks so @typescript-eslint/no-explicit-any passes. When parsing API error responses or JSON payloads, do not use patterns like (data as any)?.error; use declared response types or explicit record/string narrowing instead. Keep app/lib/checkpoints.ts strict-TypeScript safe. When normalizing parsed checkpoints, return a true Checkpoint[] without incompatible intermediate object shapes, keep note optional instead of forcing note: undefined, and use only type guards whose asserted type is assignable to the filtered element shape.",
    },
    {
      id: "ui-contract",
      label: "Visible UI contract",
      instruction:
        "Make app/page.tsx render a clear Checkpoint Planner page with exact visible text 'Resume last checkpoint' and a history section that proves the earlier state still matters. The exact text 'Resume last checkpoint' must be present in the initial rendered page output, not only after client-side data loading or a later state update. Keep the page smoke-test friendly.",
    },
    {
      id: "quality-gates",
      label: "Run quality checks",
      instruction:
        "Run pnpm lint, pnpm exec tsc --noEmit, and pnpm build in that order inside one shell command so the full gate chain executes back-to-back without extra status polling between successful gates. If a gate fails, apply one direct fix and rerun only the failing suffix chain in one shell command. Remediation shell edits must stay non-interactive and use direct shell-safe rewrites such as cat <<'EOF' > path ... EOF or mkdir -p dir && cat <<'EOF' > path ... EOF; do not use python or python3 one-liners/scripts or other external scripting dependencies to patch files. Once all three pass in one chain, do not run additional build/lint/typecheck commands.",
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
        "Immediately after the first successful lint+typecheck+build chain, print the marker in that same successful shell command by ending with exactly: printf 'MOUNTAINTOP_DONE:nextjs-template-staged-stateful-workflow\\n'. After printing the marker, do not call dev.process.read, dev.shell.status, or any further shell command.",
    },
  ],
  requiredArtifacts: [
    "package.json",
    "app/layout.tsx",
    "app/page.tsx",
    "app/api/checkpoints/route.ts",
    "app/lib/checkpoints.ts",
    "data/checkpoints.json",
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
    { path: "/", contains: ["Checkpoint Planner", "Resume last checkpoint"] },
  ],
  completionMarker: "MOUNTAINTOP_DONE:nextjs-template-staged-stateful-workflow",
  completionTimeoutSeconds: 300,
};
