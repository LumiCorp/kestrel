import type { MountaintopScenario } from "../types.js";

export const nextJsTemplateTodoAuthRealUserCliScenario: MountaintopScenario = {
  id: "nextjs-template-todo-auth-real-user-cli",
  title: "Next.js Todo Auth Real User CLI",
  description:
    "Prove the CLI can turn a natural operator request into a small auth-aware todo app with local persistence, per-user isolation, and normal runtime finalization.",
  supportedEngines: ["cli"],
  promptEnvelope: "operator",
  operatorPrompt:
    "Let's build a simple todo list app for demo purposes. We're showing off our Kestrel Desktop capabilities by building a Next.js app that lets users sign up, log in, and create, complete, edit, and delete their own todo items. Each user only sees their own list.",
  provider: {
    profileId: "reference",
    provider: "openrouter",
    model: "openai/gpt-5.4-mini",
  },
  setupCommands: ["/profiles use reference", "/mode build", "/code enable"],
  simulatedUser: {
    mode: "explicit_waits",
    maxTurns: 3,
  },
  promptProgram: [
    {
      id: "operator-request",
      label: "Operator request",
      instruction:
        "Let's build a simple todo list app for demo purposes. We're showing off our Kestrel Desktop capabilities by building a Next.js app that lets users sign up, log in, and create, complete, edit, and delete their own todo items. Each user only sees their own list.",
    },
    {
      id: "workspace-contract",
      label: "Workspace contract",
      instruction:
        "Work in the current directory only. Do not scaffold into a nested subdirectory, do not use an absolute target path, and do not run /workspace or cd /workspace.",
    },
    {
      id: "real-scaffold",
      label: "Real scaffold path",
      instruction:
        "Start from a real scaffold in this empty workspace by running exactly once: CI=1 pnpm create next-app@15.4.5 . --ts --eslint --app --use-pnpm --yes. Do not hand-write the framework boilerplate from scratch.",
    },
    {
      id: "bootstrap-completion-contract",
      label: "Bootstrap completion contract",
      instruction:
        "If create-next-app succeeds and package.json plus app/page.tsx exist, treat the scaffold as complete immediately. The scaffold stage ends at that moment. Do not rerun create-next-app, do not treat the now-non-empty root as a conflict, and do not spend another turn re-listing the scaffolded workspace just to reconfirm it.",
    },
    {
      id: "scaffold-protection-contract",
      label: "Scaffold protection contract",
      instruction:
        "After the first successful scaffold, do not delete or clean up scaffold outputs as part of recovery. Never remove app/, public/, package.json, node_modules, pnpm-lock.yaml, or the generated config files to make the scaffold command runnable again. Move directly from the successful scaffold into implementation edits.",
    },
    {
      id: "layout-contract",
      label: "File layout contract",
      instruction:
        "Keep the implementation in the root app/ and data/ directories. Do not move the App Router tree into src/app for this benchmark.",
    },
    {
      id: "auth-contract",
      label: "Auth contract",
      instruction:
        "Implement a fully local auth flow only. Do not use external auth providers, hosted databases, SaaS backends, or OAuth. Store users, session state, and todos in local data files or deterministic local helpers so the app is self-contained inside this workspace.",
    },
    {
      id: "product-slice",
      label: "Todo auth product slice",
      instruction:
        "Build the full demo slice with sign-up, log-in, log-out, and per-user todo CRUD. Create these files: app/signup/page.tsx, app/login/page.tsx, app/todos/page.tsx, app/api/auth/signup/route.ts, app/api/auth/login/route.ts, app/api/auth/logout/route.ts, app/api/todos/route.ts, app/api/todos/[id]/route.ts, app/lib/auth.ts, app/lib/todos.ts, data/users.json, and data/todos.json.",
    },
    {
      id: "privacy-contract",
      label: "Per-user isolation",
      instruction:
        "Every todo read and write must be scoped to the authenticated user. Do not leak or merge another user's items in the UI or API. If the visitor is not authenticated, app/todos/page.tsx must render the exact visible text 'Sign in required'.",
    },
    {
      id: "ui-contract",
      label: "Visible UI contract",
      instruction:
        "The home route must render the exact visible strings 'Todo Demo', 'Sign Up', and 'Log In'. The signup page must render the exact heading 'Create your account'. The login page must render the exact heading 'Welcome back'. The authenticated todo page must render the exact heading 'My Todos' and expose add, edit, complete, and delete controls in the UI.",
    },
    {
      id: "seed-contract",
      label: "Seed data contract",
      instruction:
        "Seed two demo users locally so the benchmark has deterministic starting data: alice@example.com and bob@example.com. Their starter todo items must be different, and the home page should mention those demo emails as example accounts for the operator.",
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
        "When a scaffold or verification shell command is settled with output or exit code, do not issue another status or inventory command for that same result; execute the next required task immediately. After the scaffold settles successfully, the next step must be implementation work inside app/ or data/, not another scaffold decision.",
    },
    {
      id: "no-bookkeeping",
      label: "No bookkeeping files",
      instruction:
        "Do not create generic bookkeeping files, planning documents, or memory notes unless the task explicitly requires them.",
    },
  ],
  requiredArtifacts: [
    "package.json",
    "next.config.ts",
    "tsconfig.json",
    "eslint.config.mjs",
    "app/layout.tsx",
    "app/page.tsx",
    "app/globals.css",
    "app/signup/page.tsx",
    "app/login/page.tsx",
    "app/todos/page.tsx",
    "app/api/auth/signup/route.ts",
    "app/api/auth/login/route.ts",
    "app/api/auth/logout/route.ts",
    "app/api/todos/route.ts",
    "app/api/todos/[id]/route.ts",
    "app/lib/auth.ts",
    "app/lib/todos.ts",
    "data/users.json",
    "data/todos.json",
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
  smokeRoutes: [
    {
      path: "/",
      contains: ["Todo Demo", "Sign Up", "Log In", "alice@example.com", "bob@example.com"],
    },
    {
      path: "/signup",
      contains: ["Create your account"],
    },
    {
      path: "/login",
      contains: ["Welcome back"],
    },
    {
      path: "/todos",
      contains: ["Sign in required"],
    },
  ],
  completionMode: "runtime_finalize",
  completionTimeoutSeconds: 720,
};
