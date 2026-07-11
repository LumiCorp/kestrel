import type { MountaintopScenario } from "../types.js";

export const nextJsTemplateMultiPackageSharedPackageScenario: MountaintopScenario = {
  id: "nextjs-template-multi-package-shared-package",
  title: "Next.js Template Multi-Package Shared Package",
  description:
    "Convert the baseline app into a small workspace with a shared package and prove the app consumes it through the full build pipeline.",
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
        "Run exactly once as its own shell command: CI=1 pnpm create next-app@15.4.5 . --ts --eslint --app --use-pnpm --yes. Do not append workspace edits, lint, typecheck, or build to this bootstrap command.",
    },
    {
      id: "install-deps",
      label: "Install local deps",
      instruction:
        "Run pnpm install exactly once as its own shell command after bootstrap, then do not run pnpm install again.",
    },
    {
      id: "bootstrap-contract",
      label: "Bootstrap completion contract",
      instruction:
        "If create-next-app prints Success and both package.json plus app/ exist, treat bootstrap as complete even when node_modules or pnpm-lock.yaml are absent in this workspace. Do not loop on preflight checks; continue directly to product work.",
    },
    {
      id: "workspace-topology",
      label: "Establish workspace topology",
      instruction:
        "Create a pnpm workspace layout that includes the root app and a packages/shared package. Add required workspace manifest and package metadata so the shared package can be imported by name from the app at runtime. Preserve existing root package scripts/dependencies; do not replace package.json with a minimal object. Use the package name @repo/shared.",
    },
    {
      id: "shared-package",
      label: "Create shared package",
      instruction:
        "Create packages/shared with a minimal reusable export at exactly packages/shared/src/index.ts and package metadata at exactly packages/shared/package.json. Make the package TypeScript-resolvable from the root app before any quality gate runs: include explicit exports/types metadata in packages/shared/package.json and create packages/shared/src/index.d.ts alongside the source export so pnpm exec tsc --noEmit resolves @repo/shared deterministically. Because the source file path is exactly packages/shared/src/index.ts, do not use JSX or TSX syntax in that file; implement SharedComponent in a .ts-safe form such as React.createElement so TypeScript does not parse JSX in a .ts file. Use typed filesystem write tools for explicit file rewrites, not shell heredocs or regex/string-replacement shell patches. Export a small component named SharedComponent that renders the visible text 'Mountain Top Shared Package'. Keep the API tiny and stable.",
    },
    {
      id: "app-integration",
      label: "Wire app to shared package",
      instruction:
        "Update the root app so app/page.tsx imports SharedComponent from @repo/shared and renders it in the home route. If Next.js needs workspace-package transpilation, configure it explicitly in next.config.ts. Keep root TypeScript resolution explicit too: preserve baseUrl and add a tsconfig.json paths entry for @repo/shared that targets ./packages/shared/src/index.ts so pnpm exec tsc --noEmit resolves the workspace package before build. Keep the page simple and visible enough for smoke checks.",
    },
    {
      id: "quality-gates",
      label: "Run quality checks",
      instruction:
        "Run pnpm lint, pnpm exec tsc --noEmit, and pnpm build in that order inside one shell command so the full gate chain executes back-to-back without extra status polling between successful gates. If a gate fails, apply one direct fix and rerun only the failing suffix chain in one shell command. If lint already passed and pnpm exec tsc --noEmit failed, the rerun command must start with exactly pnpm exec tsc --noEmit && pnpm build and, once both pass, end in that same command with exactly printf 'MOUNTAINTOP_DONE:nextjs-template-multi-package-shared-package\\n'. Do not skip pnpm exec tsc --noEmit after a typecheck failure by jumping straight to pnpm build or printf. Once all three pass in one chain, do not run additional build/lint/typecheck commands.",
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
        "Immediately after the first successful lint+typecheck+build chain, print the marker in that same successful shell command by ending with exactly: printf 'MOUNTAINTOP_DONE:nextjs-template-multi-package-shared-package\\n'. After printing the marker, do not call dev.process.read, dev.shell.status, or any further shell command.",
    },
  ],
  requiredArtifacts: [
    "package.json",
    "pnpm-workspace.yaml",
    "packages/shared/package.json",
    "packages/shared/src/index.ts",
    "app/page.tsx",
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
  smokeRoutes: [{ path: "/", contains: ["Mountain Top Shared Package"] }],
  completionMarker: "MOUNTAINTOP_DONE:nextjs-template-multi-package-shared-package",
  completionTimeoutSeconds: 300,
};
