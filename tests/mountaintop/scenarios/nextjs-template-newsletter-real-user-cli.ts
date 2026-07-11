import type { MountaintopScenario } from "../types.js";

export const nextJsTemplateNewsletterRealUserCliScenario: MountaintopScenario = {
  id: "nextjs-template-newsletter-real-user-cli",
  title: "Next.js Newsletter Real User CLI",
  description:
    "Prove the CLI can gather live U.S. business and technology news, produce a top-10 report, and turn it into a polished newsletter-style single-page app from an empty directory.",
  supportedEngines: ["cli"],
  promptEnvelope: "operator",
  provider: {
    profileId: "reference",
    provider: "openrouter",
    model: "openai/gpt-5.4-mini",
  },
  setupCommands: ["/profiles use reference", "/mode build"],
  promptProgram: [
    {
      id: "operator-request",
      label: "Operator request",
      instruction:
        "Create a new Next.js single-page newsletter app in this empty folder that covers the top 10 current U.S. business and technology stories.",
    },
    {
      id: "scaffold-first",
      label: "Scaffold first",
      instruction:
        "Scaffold the app in the current directory before you do any news research. Do not use current-news tools until the workspace has the standard app files and package.json.",
    },
    {
      id: "real-scaffold",
      label: "Real scaffold path",
      instruction:
        "Use this exact bootstrap command in the empty workspace: CI=1 pnpm create next-app@15.4.5 . --ts --eslint --app --use-pnpm --yes. Do not hand-write the initial framework boilerplate from scratch.",
    },
    {
      id: "bootstrap-completion-contract",
      label: "Bootstrap completion contract",
      instruction:
        "If create-next-app succeeds and package.json plus app/page.tsx or src/app/page.tsx exist, treat the scaffold as complete. Do not rerun create-next-app and do not spend another turn re-listing or re-reading the scaffolded workspace just to reconfirm it.",
    },
    {
      id: "scaffold-to-research-transition",
      label: "Transition to research",
      instruction:
        "Immediately after the scaffold is complete, move straight into live news research and source collection. Do not loop on extra scaffold verification unless the scaffold command failed or the required app files are missing.",
    },
    {
      id: "live-research",
      label: "Live research",
      instruction:
        "Use the live research tools in this runtime, specifically internet.news, internet.search, or internet.search_advanced when available, to gather current headlines and source URLs before you write the content. Use real reporting, not placeholder copy or invented stories.",
    },
    {
      id: "research-shape",
      label: "Research shape",
      instruction:
        "Prefer one broad live-news retrieval that returns multiple current stories, such as internet.news, before you branch into narrower follow-up searches. Use internet.search or internet.search_advanced only to fill missing story slots or missing fields; do not keep issuing overlapping broad retrieval queries once you already have enough grounded candidate stories to assemble the 10-story report.",
    },
    {
      id: "report-contract",
      label: "Structured report",
      instruction:
        "Save the curated result locally as newsletter-report.json with a stories array of exactly 10 items. Each item must include title, publisher, url, category, and summary. Do not write newsletter-report.json until every story has a real populated publisher, an absolute http or https source URL, and a non-placeholder summary.",
    },
    {
      id: "report-before-ui",
      label: "Report before UI",
      instruction:
        "Finish the research artifact first. Do not read, edit, or replace app/page.tsx, src/app/page.tsx, app/globals.css, or src/app/globals.css until newsletter-report.json exists with 10 grounded stories and the report is ready for fs.verify_json.",
    },
    {
      id: "stage-separation",
      label: "Stage separation",
      instruction:
        "Treat this as two strict stages after scaffolding. Stage 1 is report assembly only: use internet.news, internet.search, internet.search_advanced, the minimal file write needed for newsletter-report.json, and fs.verify_json. During Stage 1, do not inspect package metadata, page files, CSS files, or other app source files. Stage 2 starts only after newsletter-report.json exists and fs.verify_json has passed; only then may you edit the page, styles, and run the build-quality commands.",
    },
    {
      id: "research-stop-condition",
      label: "Research stop condition",
      instruction:
        "Once newsletter-report.json contains 10 distinct grounded stories with source URLs, stop researching and move directly to implementation and verification. Do not keep searching just to improve the list further.",
    },
    {
      id: "page-contract",
      label: "Newsletter page",
      instruction:
        "Render the page from that local report data as a polished newsletter with the visible headings 'U.S. Business & Technology Briefing', 'Top 10 Stories', and 'Source links'.",
    },
    {
      id: "replace-placeholder",
      label: "Replace scaffold placeholder",
      instruction:
        "Do not leave the default create-next-app placeholder page in app/page.tsx or src/app/page.tsx. The task is incomplete until that page is replaced with the newsletter experience and newsletter-report.json exists.",
    },
    {
      id: "not-research-only",
      label: "Not research only",
      instruction:
        "This is not a research-only task. After the app is scaffolded and the research step is complete, implement the page and verify the build. Do not stop after writing a partial, empty, or placeholder-filled report artifact.",
    },
    {
      id: "workspace-root",
      label: "Workspace root",
      instruction:
        "Work in the current directory only. Do not scaffold into a nested subdirectory and do not use an absolute target path.",
    },
    {
      id: "completion-bar",
      label: "Definition of done",
      instruction:
        "Before you finish, make sure package.json exists, newsletter-report.json contains 10 real stories with real publishers and absolute source URLs, and pnpm lint, pnpm exec tsc --noEmit, and pnpm build all pass from this workspace.",
    },
    {
      id: "validation-stop-condition",
      label: "Validation stop condition",
      instruction:
        "If pnpm lint, pnpm exec tsc --noEmit, and pnpm build all exit 0 after any required build approval, finalize immediately. Do not keep rechecking or rerunning validation after all three commands are clean.",
    },
    {
      id: "runtime-verifier",
      label: "Runtime verifier",
      instruction:
        "Before you finalize, run fs.verify_json against newsletter-report.json with arrayPath stories, minLength 10, requiredStringFields title,publisher,url,category,summary, requiredAbsoluteUrlFields url, and forbiddenStringLiterals [to be researched]. Do not finalize until that verifier reports passed.",
    },
    {
      id: "settle-contract",
      label: "Settle contract",
      instruction:
        "When a scaffold or verification shell command is settled with output or exit code, do not issue another status or inventory command for that same result; execute the next required task immediately.",
    },
    {
      id: "no-bookkeeping",
      label: "No bookkeeping files",
      instruction:
        "Do not create generic bookkeeping files or memory notes unless the task explicitly requires them.",
    },
    {
      id: "no-plan-doc-loop",
      label: "No plan document loop",
      instruction:
        "Skip any planning-document workflow during this task and proceed directly with research, implementation, and verification.",
    },
  ],
  requiredArtifacts: [
    "package.json",
    "next.config.ts",
    "tsconfig.json",
    "eslint.config.mjs",
    "newsletter-report.json",
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
  requiredJsonArrayArtifacts: [
    {
      paths: ["newsletter-report.json"],
      arrayPath: "stories",
      minLength: 10,
      requiredStringFields: ["title", "publisher", "url", "category", "summary"],
      requiredAbsoluteUrlFields: ["url"],
      forbiddenStringLiterals: ["[to be researched]"],
    },
  ],
  requiredToolEvidence: [
    {
      tools: ["internet.news", "internet.search", "internet.search_advanced"],
      minSuccessfulCalls: 1,
    },
    {
      tools: ["fs.verify_json"],
      minSuccessfulCalls: 1,
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
  smokeRoutes: [
    {
      path: "/",
      contains: ["U.S. Business & Technology Briefing", "Top 10 Stories", "Source links"],
    },
  ],
  completionMode: "runtime_finalize",
  completionTimeoutSeconds: 720,
};
