import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCliAdapterFailureDiagnostics,
  buildCliCompletionPattern,
  buildScenarioPrompt,
  buildCliRunStartedPattern,
  buildCliSetupCommandSteps,
  buildWorkspaceCommandEnv,
  buildDeterministicSubmitActions,
  buildParityChecksForMode,
  buildPromptSubmissionSteps,
  checkRequiredArtifacts,
  checkWorkspaceValidationPreconditions,
  classifyCliAdapterFailure,
  classifyMountaintopStatus,
  collectModelEvidence,
  collectRuntimeQualityGateEvidence,
  collectRuntimeQualityGateEvidenceFromSessionStateForTests,
  collectToolEvidence,
  collectToolEvidenceFromSessionStateForTests,
  deriveFailureBucket,
  deriveEngineStatus,
  deriveQualityGateEvidence,
  deriveRuntimeCompletionAttributionDiagnostics,
  deriveRuntimeMarkerTimeoutDiagnostics,
  deriveRuntimeRunFailureDiagnostics,
  deriveRuntimeProgressGapDiagnostics,
  evaluateSimulatedUserWaitDecision,
  normalizeSmokeCheckBody,
  pruneMountaintopRuns,
  readRuntimeSessionStateForEvidence,
  resolveMountaintopWorkspacesBaseRoot,
  resolvePersistedSessionIdFromKestrelHome,
  resolveManagedWorktreeValidationWorkspacePath,
  resolveMountaintopWorkspacesRoot,
  resolveEngineOrder,
  resolveScenarioEngineOrder,
  runQualityGates,
  splitShellAndChainCommands,
  validateMountaintopScenario,
  waitForPostgresReady,
} from "../../scripts/mountaintop-e2e.js";
import { MOUNTAINTOP_SCENARIOS } from "../mountaintop/scenarios/index.js";
import { nextJsTemplateAuthSettingsAdminScenario } from "../mountaintop/scenarios/nextjs-template-auth-settings-admin.js";
import { nextJsTemplateDualShellScenario } from "../mountaintop/scenarios/nextjs-template-dual-shell.js";
import { nextJsTemplateFullStackTaskBoardScenario } from "../mountaintop/scenarios/nextjs-template-full-stack-task-board.js";
import { nextJsTemplateLongRunningStatefulWorkflowScenario } from "../mountaintop/scenarios/nextjs-template-long-running-stateful-workflow.js";
import { nextJsTemplateMultiPackageSharedPackageScenario } from "../mountaintop/scenarios/nextjs-template-multi-package-shared-package.js";
import { nextJsTemplateNewsletterResearchRealUserCliScenario } from "../mountaintop/scenarios/nextjs-template-newsletter-research-real-user-cli.js";
import { nextJsTemplateNewsletterRealUserCliScenario } from "../mountaintop/scenarios/nextjs-template-newsletter-real-user-cli.js";
import { nextJsTemplateScaffoldRealUserCliScenario } from "../mountaintop/scenarios/nextjs-template-scaffold-real-user-cli.js";
import { nextJsTemplateScaffoldSmokeScenario } from "../mountaintop/scenarios/nextjs-template-scaffold-smoke.js";
import { nextJsTemplateStagedStatefulWorkflowScenario } from "../mountaintop/scenarios/nextjs-template-staged-stateful-workflow.js";
import { nextJsTemplateTodoAuthRealUserCliScenario } from "../mountaintop/scenarios/nextjs-template-todo-auth-real-user-cli.js";

test("mountaintop scenario contract validates required fields", () => {
  const diagnostics = validateMountaintopScenario(nextJsTemplateDualShellScenario);
  assert.deepEqual(diagnostics, []);
});

test("mountaintop scenario index exposes the expanded scenario set", () => {
  const scenarioIds = MOUNTAINTOP_SCENARIOS.map((scenario) => scenario.id);
  assert.deepEqual(scenarioIds, [
    "nextjs-template-scaffold-smoke",
    "nextjs-template-scaffold-real-user-cli",
    "nextjs-template-newsletter-research-real-user-cli",
    "nextjs-template-newsletter-real-user-cli",
    "nextjs-template-dual-shell",
    "nextjs-template-multi-package-shared-package",
    "nextjs-template-full-stack-task-board",
    "nextjs-template-todo-auth-real-user-cli",
    "nextjs-template-auth-settings-admin",
    "nextjs-template-staged-stateful-workflow",
    "nextjs-template-long-running-stateful-workflow",
  ]);
  const scaffoldDiagnostics = validateMountaintopScenario(nextJsTemplateScaffoldSmokeScenario);
  assert.deepEqual(scaffoldDiagnostics, []);
  const realUserScaffoldDiagnostics = validateMountaintopScenario(nextJsTemplateScaffoldRealUserCliScenario);
  assert.deepEqual(realUserScaffoldDiagnostics, []);
  const newsletterResearchDiagnostics = validateMountaintopScenario(
    nextJsTemplateNewsletterResearchRealUserCliScenario,
  );
  assert.deepEqual(newsletterResearchDiagnostics, []);
  const newsletterDiagnostics = validateMountaintopScenario(nextJsTemplateNewsletterRealUserCliScenario);
  assert.deepEqual(newsletterDiagnostics, []);
  const diagnostics = validateMountaintopScenario(nextJsTemplateMultiPackageSharedPackageScenario);
  assert.deepEqual(diagnostics, []);
  const fullStackDiagnostics = validateMountaintopScenario(nextJsTemplateFullStackTaskBoardScenario);
  assert.deepEqual(fullStackDiagnostics, []);
  const todoAuthDiagnostics = validateMountaintopScenario(nextJsTemplateTodoAuthRealUserCliScenario);
  assert.deepEqual(todoAuthDiagnostics, []);
  const authSettingsDiagnostics = validateMountaintopScenario(nextJsTemplateAuthSettingsAdminScenario);
  assert.deepEqual(authSettingsDiagnostics, []);
  const stagedDiagnostics = validateMountaintopScenario(nextJsTemplateStagedStatefulWorkflowScenario);
  assert.deepEqual(stagedDiagnostics, []);
  const longRunningDiagnostics = validateMountaintopScenario(nextJsTemplateLongRunningStatefulWorkflowScenario);
  assert.deepEqual(longRunningDiagnostics, []);
});

test("mountaintop todo auth scenario keeps a natural operator envelope and locks the demo contract", () => {
  assert.deepEqual(nextJsTemplateTodoAuthRealUserCliScenario.supportedEngines, ["cli"]);
  assert.equal(nextJsTemplateTodoAuthRealUserCliScenario.promptEnvelope, "operator");
  assert.equal(nextJsTemplateTodoAuthRealUserCliScenario.completionMode, "runtime_finalize");
  assert.equal(nextJsTemplateTodoAuthRealUserCliScenario.completionMarker, undefined);
  assert.equal(nextJsTemplateTodoAuthRealUserCliScenario.provider.model, "openai/gpt-5.4-mini");
  assert.equal(
    nextJsTemplateTodoAuthRealUserCliScenario.operatorPrompt,
    "Let's build a simple todo list app for demo purposes. We're showing off our Kestrel Desktop capabilities by building a Next.js app that lets users sign up, log in, and create, complete, edit, and delete their own todo items. Each user only sees their own list.",
  );
  assert.deepEqual(nextJsTemplateTodoAuthRealUserCliScenario.simulatedUser, {
    mode: "explicit_waits",
    maxTurns: 3,
  });
  assert.deepEqual(nextJsTemplateTodoAuthRealUserCliScenario.smokeRoutes, [
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
  ]);

  const prompt = buildScenarioPrompt(nextJsTemplateTodoAuthRealUserCliScenario);
  assert.equal(prompt, nextJsTemplateTodoAuthRealUserCliScenario.operatorPrompt);
  assert.doesNotMatch(prompt, /CI=1 pnpm create next-app@15\.4\.5/u);
  assert.doesNotMatch(prompt, /Do not scaffold into a nested subdirectory/u);
  assert.doesNotMatch(prompt, /Do not use external auth providers/u);
  assert.doesNotMatch(prompt, /MOUNTAINTOP_DONE/u);

  const scaffoldMetadata = nextJsTemplateTodoAuthRealUserCliScenario.promptProgram.find(
    (step) => step.id === "real-scaffold",
  )?.instruction;
  assert.match(String(scaffoldMetadata), /CI=1 pnpm create next-app@15\.4\.5 \. --ts --eslint --app --use-pnpm --yes/u);
});

test("mountaintop scaffold workspaces default outside the project checkout", () => {
  const previous = process.env.MOUNTAINTOP_WORKSPACES_ROOT;
  delete process.env.MOUNTAINTOP_WORKSPACES_ROOT;
  try {
    const baseRoot = resolveMountaintopWorkspacesBaseRoot();
    const root = resolveMountaintopWorkspacesRoot("run-123");
    assert.equal(root, path.join(baseRoot, "run-123"));
    assert.equal(path.isAbsolute(root), true);
    assert.equal(root.includes(`${path.sep}kestrel-mountaintop-workspaces${path.sep}run-123`), true);
    assert.equal(path.resolve(root).startsWith(path.resolve(process.cwd(), "tmp", "mountaintop")), false);
  } finally {
    if (previous === undefined) {
      delete process.env.MOUNTAINTOP_WORKSPACES_ROOT;
    } else {
      process.env.MOUNTAINTOP_WORKSPACES_ROOT = previous;
    }
  }
});

test("mountaintop scaffold smoke scenario locks root scaffold and no-rerun contracts", () => {
  const createInstruction = nextJsTemplateScaffoldSmokeScenario.promptProgram.find(
    (step) => step.id === "create-app",
  )?.instruction;
  assert.equal(typeof createInstruction, "string");
  assert.match(String(createInstruction), /CI=1 pnpm create next-app@15\.4\.5 \. --ts --eslint --app --use-pnpm --yes/u);

  const rootInstruction = nextJsTemplateScaffoldSmokeScenario.promptProgram.find(
    (step) => step.id === "root-scaffold-contract",
  )?.instruction;
  assert.equal(typeof rootInstruction, "string");
  assert.match(String(rootInstruction), /target must be '\.'/u);
  assert.match(String(rootInstruction), /Do not pass an absolute workspace path/u);
  assert.match(String(rootInstruction), /nested directory name/u);

  const bootstrapInstruction = nextJsTemplateScaffoldSmokeScenario.promptProgram.find(
    (step) => step.id === "bootstrap-completion-contract",
  )?.instruction;
  assert.equal(typeof bootstrapInstruction, "string");
  assert.match(String(bootstrapInstruction), /package\.json plus app\/page\.tsx exist/u);
  assert.match(String(bootstrapInstruction), /Do not rerun create-next-app/u);
  assert.match(String(bootstrapInstruction), /node_modules, \.next, or pnpm-lock\.yaml/u);
});

test("mountaintop real-user scaffold scenario keeps a natural operator envelope", () => {
  assert.deepEqual(nextJsTemplateScaffoldRealUserCliScenario.supportedEngines, ["cli"]);
  assert.equal(nextJsTemplateScaffoldRealUserCliScenario.promptEnvelope, "operator");
  assert.equal(nextJsTemplateScaffoldRealUserCliScenario.completionMode, "runtime_finalize");
  assert.equal(nextJsTemplateScaffoldRealUserCliScenario.completionMarker, undefined);
  assert.deepEqual(nextJsTemplateScaffoldRealUserCliScenario.requiredArtifactAlternatives, [
    { paths: ["app/layout.tsx", "src/app/layout.tsx"] },
    { paths: ["app/page.tsx", "src/app/page.tsx"] },
    { paths: ["app/globals.css", "src/app/globals.css"] },
  ]);

  const prompt = buildScenarioPrompt(nextJsTemplateScaffoldRealUserCliScenario);
  assert.match(prompt, /Create a new Next\.js app in this empty folder/u);
  assert.match(prompt, /Do not create generic bookkeeping files or memory notes unless the task explicitly requires them/u);
  assert.doesNotMatch(prompt, /MOUNTAINTOP_DONE/u);
  assert.doesNotMatch(prompt, /Final line must be exactly/u);
  assert.doesNotMatch(prompt, /Use dev\.shell\.run commands only/u);
});

test("mountaintop newsletter scenario requires live research and a structured top-10 report", () => {
  assert.deepEqual(nextJsTemplateNewsletterRealUserCliScenario.supportedEngines, ["cli"]);
  assert.equal(nextJsTemplateNewsletterRealUserCliScenario.promptEnvelope, "operator");
  assert.equal(nextJsTemplateNewsletterRealUserCliScenario.completionMode, "runtime_finalize");
  assert.equal(nextJsTemplateNewsletterRealUserCliScenario.completionMarker, undefined);
  assert.equal(nextJsTemplateNewsletterRealUserCliScenario.provider.model, "openai/gpt-5.4-mini");
  assert.deepEqual(nextJsTemplateNewsletterRealUserCliScenario.requiredJsonArrayArtifacts, [
    {
      paths: ["newsletter-report.json"],
      arrayPath: "stories",
      minLength: 10,
      requiredStringFields: ["title", "publisher", "url", "category", "summary"],
      requiredAbsoluteUrlFields: ["url"],
      forbiddenStringLiterals: ["[to be researched]"],
    },
  ]);
  assert.deepEqual(nextJsTemplateNewsletterRealUserCliScenario.requiredToolEvidence, [
    {
      tools: ["internet.news", "internet.search", "internet.search_advanced"],
      minSuccessfulCalls: 1,
    },
    {
      tools: ["fs.verify_json"],
      minSuccessfulCalls: 1,
    },
  ]);
  assert.deepEqual(nextJsTemplateNewsletterRealUserCliScenario.smokeRoutes, [
    {
      path: "/",
      contains: ["U.S. Business & Technology Briefing", "Top 10 Stories", "Source links"],
    },
  ]);

  const prompt = buildScenarioPrompt(nextJsTemplateNewsletterRealUserCliScenario);
  assert.match(prompt, /top 10 current U\.S\. business and technology stories/u);
  assert.match(prompt, /Scaffold the app in the current directory before you do any news research/u);
  assert.match(prompt, /Do not use current-news tools until the workspace has the standard app files and package\.json/u);
  assert.match(prompt, /CI=1 pnpm create next-app@15\.4\.5 \. --ts --eslint --app --use-pnpm --yes/u);
  assert.match(prompt, /If create-next-app succeeds and package\.json plus app\/page\.tsx or src\/app\/page\.tsx exist, treat the scaffold as complete/u);
  assert.match(prompt, /Immediately after the scaffold is complete, move straight into live news research and source collection/u);
  assert.match(prompt, /specifically internet\.news, internet\.search, or internet\.search_advanced/u);
  assert.match(prompt, /Prefer one broad live-news retrieval that returns multiple current stories, such as internet\.news/u);
  assert.match(prompt, /newsletter-report\.json/u);
  assert.match(prompt, /stories array of exactly 10 items/u);
  assert.match(prompt, /Do not write newsletter-report\.json until every story has a real populated publisher/u);
  assert.match(prompt, /Do not read, edit, or replace app\/page\.tsx, src\/app\/page\.tsx, app\/globals\.css, or src\/app\/globals\.css until newsletter-report\.json exists/u);
  assert.match(prompt, /Treat this as two strict stages after scaffolding/u);
  assert.match(prompt, /During Stage 1, do not inspect package metadata, page files, CSS files, or other app source files/u);
  assert.match(
    prompt,
    /Once newsletter-report\.json contains 10 distinct grounded stories with source URLs, stop researching and move directly to implementation and verification/u,
  );
  assert.match(prompt, /Do not leave the default create-next-app placeholder page/u);
  assert.match(prompt, /This is not a research-only task/u);
  assert.match(prompt, /real publishers and absolute source URLs/u);
  assert.doesNotMatch(prompt, /ERR_PNPM_IGNORED_BUILDS/u);
  assert.doesNotMatch(prompt, /pnpm approve-builds/u);
  assert.doesNotMatch(prompt, /ignored build scripts/u);
  assert.match(prompt, /If pnpm lint, pnpm exec tsc --noEmit, and pnpm build all exit 0/u);
  assert.match(prompt, /Do not keep rechecking or rerunning validation after all three commands are clean/u);
  assert.match(prompt, /run fs\.verify_json against newsletter-report\.json/u);
  assert.match(prompt, /do not issue another status or inventory command for that same result; execute the next required task immediately/u);
  assert.match(prompt, /Skip any planning-document workflow during this task and proceed directly with research, implementation, and verification/u);
  assert.doesNotMatch(prompt, /MOUNTAINTOP_DONE/u);
  assert.doesNotMatch(prompt, /Final line must be exactly/u);
});

test("mountaintop newsletter research-only scenario requires grounded tool-backed reporting without scaffold", () => {
  assert.deepEqual(nextJsTemplateNewsletterResearchRealUserCliScenario.supportedEngines, ["cli"]);
  assert.equal(nextJsTemplateNewsletterResearchRealUserCliScenario.promptEnvelope, "operator");
  assert.equal(nextJsTemplateNewsletterResearchRealUserCliScenario.completionMode, "runtime_finalize");
  assert.equal(nextJsTemplateNewsletterResearchRealUserCliScenario.completionMarker, undefined);
  assert.equal(nextJsTemplateNewsletterResearchRealUserCliScenario.workspacePrecondition, "none");
  assert.equal(nextJsTemplateNewsletterResearchRealUserCliScenario.provider.model, "openai/gpt-5.4-mini");
  assert.deepEqual(nextJsTemplateNewsletterResearchRealUserCliScenario.qualityGates, []);
  assert.deepEqual(nextJsTemplateNewsletterResearchRealUserCliScenario.smokeRoutes, []);
  assert.deepEqual(nextJsTemplateNewsletterResearchRealUserCliScenario.requiredArtifacts, [
    "newsletter-report.json",
  ]);
  assert.deepEqual(nextJsTemplateNewsletterResearchRealUserCliScenario.requiredToolEvidence, [
    {
      tools: ["internet.news", "internet.search", "internet.search_advanced"],
      minSuccessfulCalls: 1,
    },
    {
      tools: ["fs.verify_json"],
      minSuccessfulCalls: 1,
    },
  ]);

  const prompt = buildScenarioPrompt(nextJsTemplateNewsletterResearchRealUserCliScenario);
  assert.match(prompt, /Research the top 10 current U\.S\. business and technology stories/u);
  assert.match(prompt, /Use the live research tools in this runtime/u);
  assert.match(prompt, /Do not scaffold a Next\.js app/u);
  assert.match(prompt, /do not create package\.json/u);
  assert.match(prompt, /newsletter-report\.json/u);
  assert.match(prompt, /10 distinct real stories with unique titles/u);
  assert.match(prompt, /run fs\.verify_json against newsletter-report\.json/u);
  assert.doesNotMatch(prompt, /MOUNTAINTOP_DONE/u);
});

test("mountaintop staged scenario prompt locks strict checkpoint typing contract", () => {
  const instruction = nextJsTemplateStagedStatefulWorkflowScenario.promptProgram.find(
    (step) => step.id === "types-contract",
  )?.instruction;
  assert.equal(typeof instruction, "string");
  assert.match(String(instruction), /Do not use any in app\/lib\/checkpoints\.ts/u);
  assert.match(String(instruction), /app\/api\/checkpoints\/route\.ts/u);
  assert.match(String(instruction), /app\/components\/CheckpointPlannerClient\.tsx/u);
  assert.match(String(instruction), /@typescript-eslint\/no-explicit-any passes/u);
  assert.match(String(instruction), /do not use patterns like \(data as any\)\?\.error/u);
  assert.match(String(instruction), /declared response types or explicit record\/string narrowing/u);
  assert.match(String(instruction), /return a true Checkpoint\[\]/u);
  assert.match(String(instruction), /keep note optional instead of forcing note: undefined/u);
  assert.match(
    String(instruction),
    /type guards whose asserted type is assignable to the filtered element shape/u,
  );

  const uiInstruction = nextJsTemplateStagedStatefulWorkflowScenario.promptProgram.find(
    (step) => step.id === "ui-contract",
  )?.instruction;
  assert.equal(typeof uiInstruction, "string");
  assert.match(String(uiInstruction), /exact visible text 'Resume last checkpoint'/u);
  assert.match(String(uiInstruction), /initial rendered page output/u);
  assert.match(String(uiInstruction), /not only after client-side data loading or a later state update/u);

  const gateInstruction = nextJsTemplateStagedStatefulWorkflowScenario.promptProgram.find(
    (step) => step.id === "quality-gates",
  )?.instruction;
  assert.equal(typeof gateInstruction, "string");
  assert.match(String(gateInstruction), /cat <<'EOF' > path \.\.\. EOF/u);
  assert.match(String(gateInstruction), /mkdir -p dir && cat <<'EOF' > path \.\.\. EOF/u);
  assert.match(String(gateInstruction), /do not use python or python3 one-liners\/scripts/u);
  assert.match(String(gateInstruction), /do not use .* external scripting dependencies to patch files/u);
});

test("mountaintop multi-package scenario prompt locks workspace package typing and suffix replay contract", () => {
  const sharedInstruction = nextJsTemplateMultiPackageSharedPackageScenario.promptProgram.find(
    (step) => step.id === "shared-package",
  )?.instruction;
  assert.equal(typeof sharedInstruction, "string");
  assert.match(String(sharedInstruction), /explicit exports\/types metadata/u);
  assert.match(String(sharedInstruction), /packages\/shared\/src\/index\.d\.ts/u);
  assert.match(String(sharedInstruction), /pnpm exec tsc --noEmit resolves @repo\/shared deterministically/u);
  assert.match(String(sharedInstruction), /do not use JSX or TSX syntax in that file/u);
  assert.match(String(sharedInstruction), /React\.createElement/u);

  const appInstruction = nextJsTemplateMultiPackageSharedPackageScenario.promptProgram.find(
    (step) => step.id === "app-integration",
  )?.instruction;
  assert.equal(typeof appInstruction, "string");
  assert.match(String(appInstruction), /tsconfig\.json paths entry for @repo\/shared/u);
  assert.match(String(appInstruction), /\.\/packages\/shared\/src\/index\.ts/u);

  const gateInstruction = nextJsTemplateMultiPackageSharedPackageScenario.promptProgram.find(
    (step) => step.id === "quality-gates",
  )?.instruction;
  assert.equal(typeof gateInstruction, "string");
  assert.match(String(gateInstruction), /If lint already passed and pnpm exec tsc --noEmit failed/u);
  assert.match(
    String(gateInstruction),
    /rerun command must start with exactly pnpm exec tsc --noEmit && pnpm build/u,
  );
  assert.match(
    String(gateInstruction),
    /Do not skip pnpm exec tsc --noEmit after a typecheck failure by jumping straight to pnpm build or printf/u,
  );
});

test("mountaintop long-running scenario prompt locks shell-safe implementation contract", () => {
  const instruction = nextJsTemplateLongRunningStatefulWorkflowScenario.promptProgram.find(
    (step) => step.id === "shell-shape-contract",
  )?.instruction;
  assert.equal(typeof instruction, "string");
  assert.match(String(instruction), /Pass raw shell command text directly to dev\.shell\.run/u);
  assert.match(String(instruction), /only for installs, checks, tests, builds, and non-mutating inspection/u);
  assert.match(String(instruction), /Do not use shell commands for source file edits/u);
  assert.match(String(instruction), /create and rewrite source files with typed filesystem tools/u);
  assert.match(String(instruction), /Do not wrap shell commands in surrounding single quotes, double quotes, JSON strings, markdown fences/u);
  assert.match(String(instruction), /escaped newline sequences, or explanatory prose/u);
  assert.match(String(instruction), /keep shell commands non-interactive/u);
});

test("mountaintop long-running scenario prompt locks strict React signature contract", () => {
  const instruction = nextJsTemplateLongRunningStatefulWorkflowScenario.promptProgram.find(
    (step) => step.id === "react-types-contract",
  )?.instruction;
  assert.equal(typeof instruction, "string");
  assert.match(String(instruction), /Do not annotate route pages or client components with JSX\.Element/u);
  assert.match(String(instruction), /prefer inferred return types instead/u);
  assert.match(String(instruction), /Do not leave unused generic parameters/u);
  assert.match(String(instruction), /unused exhaustiveness locals such as _exhaustive/u);
  assert.match(String(instruction), /avoid impossible literal comparisons created by control-flow narrowing/u);
  assert.match(String(instruction), /do not compare a status already narrowed to 'active' against 'completed'/u);
  assert.match(String(instruction), /do not let the mapped checkpoints array widen status to string/u);
  assert.match(String(instruction), /return a true WorkflowCheckpoint\[\]/u);
  assert.match(String(instruction), /promoted status typed as the CheckpointStatus literal 'promoted'/u);
  assert.match(String(instruction), /WorkflowHistoryEntry discriminated union/u);
  assert.match(String(instruction), /do not funnel run_resumed\/checkpoint_completed\/checkpoint_promoted\/milestone_completed payloads through Omit<WorkflowHistoryEntry, 'eventId' \| 'at'>/u);
  assert.match(String(instruction), /fromStage, checkpointId, and milestoneCheckpointId/u);
  assert.match(String(instruction), /preserves the event-specific member type when appending history entries/u);
  assert.match(String(instruction), /pass a full discriminated union member with its literal type already present/u);
  assert.match(String(instruction), /Do not call the helper with payloads that omit type/u);
  assert.match(String(instruction), /do not construct helper returns as \{ type, \.\.\.entry \}/u);
  assert.match(String(instruction), /type is specified more than once/u);
});

test("mountaintop long-running scenario completion budget allows steady progress to finish", () => {
  assert.equal(nextJsTemplateLongRunningStatefulWorkflowScenario.completionTimeoutSeconds, 600);
});

test("mountaintop long-running scenario prompt locks explicit artifact order", () => {
  const instruction = nextJsTemplateLongRunningStatefulWorkflowScenario.promptProgram.find(
    (step) => step.id === "artifact-order-contract",
  )?.instruction;
  assert.equal(typeof instruction, "string");
  assert.match(String(instruction), /data\/workflow\.json, app\/lib\/workflowTypes\.ts, app\/lib\/workflow\.ts/u);
  assert.match(String(instruction), /app\/api\/workflow\/route\.ts, app\/components\/WorkflowConsoleClient\.tsx/u);
  assert.match(String(instruction), /app\/page\.tsx, app\/history\/page\.tsx/u);
  assert.match(String(instruction), /separate typed filesystem writes/u);
  assert.match(String(instruction), /Each write must target exactly the next listed path/u);
  assert.match(String(instruction), /after that write succeeds/u);
  assert.match(String(instruction), /move immediately to the next listed path/u);
  assert.match(String(instruction), /Do not skip route\/page artifacts/u);
  assert.match(String(instruction), /do not emit placeholder writes/u);
  assert.match(String(instruction), /do not leave the default create-next-app home page in place/u);
});

test("mountaintop long-running scenario prompt locks non-starter page and history route contracts", () => {
  const homeInstruction = nextJsTemplateLongRunningStatefulWorkflowScenario.promptProgram.find(
    (step) => step.id === "home-surface",
  )?.instruction;
  assert.equal(typeof homeInstruction, "string");
  assert.match(String(homeInstruction), /Replace the default create-next-app home page/u);
  assert.match(
    String(homeInstruction),
    /Do not leave starter imports, starter links, starter images, or starter copy in app\/page\.tsx/u,
  );

  const historyInstruction = nextJsTemplateLongRunningStatefulWorkflowScenario.promptProgram.find(
    (step) => step.id === "history-surface",
  )?.instruction;
  assert.equal(typeof historyInstruction, "string");
  assert.match(
    String(historyInstruction),
    /This route file must exist before any lint\/typecheck\/build command is allowed to run/u,
  );
});

test("mountaintop long-running scenario prompt requires workflow console component before quality gates", () => {
  const clientInstruction = nextJsTemplateLongRunningStatefulWorkflowScenario.promptProgram.find(
    (step) => step.id === "client-component-contract",
  )?.instruction;
  assert.equal(typeof clientInstruction, "string");
  assert.match(String(clientInstruction), /Create app\/components\/WorkflowConsoleClient\.tsx/u);
  assert.match(String(clientInstruction), /Do not skip this component/u);
  assert.match(String(clientInstruction), /Keep hook dependencies lint-clean/u);
  assert.match(String(clientInstruction), /react-hooks\/exhaustive-deps/u);

  const gateInstruction = nextJsTemplateLongRunningStatefulWorkflowScenario.promptProgram.find(
    (step) => step.id === "quality-gates",
  )?.instruction;
  assert.equal(typeof gateInstruction, "string");
  assert.match(
    String(gateInstruction),
    /Do not start pnpm lint, pnpm exec tsc --noEmit, or pnpm build until these files all exist/u,
  );
  assert.match(String(gateInstruction), /app\/components\/WorkflowConsoleClient\.tsx/u);
  assert.match(String(gateInstruction), /app\/history\/page\.tsx/u);
  assert.match(String(gateInstruction), /Do not rerun pnpm lint after it already passed/u);
  assert.match(String(gateInstruction), /do not stop at lint-only warnings while required typecheck\/build gates still remain/u);
});

test("mountaintop dual-shell scenario prompt locks single-command gate-chain contract", () => {
  const gateInstruction = nextJsTemplateDualShellScenario.promptProgram.find(
    (step) => step.id === "quality-gates",
  )?.instruction;
  assert.equal(typeof gateInstruction, "string");
  assert.match(String(gateInstruction), /inside one shell command/u);
  assert.match(
    String(gateInstruction),
    /without extra status polling between successful gates/u,
  );
  assert.match(String(gateInstruction), /rerun only the failing gate chain in one shell command/u);
});

test("mountaintop status classifier identifies infra/build failures", () => {
  assert.equal(classifyMountaintopStatus({ exitCode: 0, output: "" }), "passed");
  assert.equal(
    classifyMountaintopStatus({ exitCode: 1, output: "ECONNREFUSED: failed to connect" }),
    "infra_failed",
  );
  assert.equal(
    classifyMountaintopStatus({ exitCode: 1, output: "Failed to compile due to type error" }),
    "build_failed",
  );
  assert.equal(
    classifyMountaintopStatus({ exitCode: 1, output: "unexpected runtime failure" }),
    "failed",
  );
});

test("mountaintop CLI adapter failure classifier normalizes fail-fast and timeout reasons", () => {
  assert.equal(
    classifyCliAdapterFailure("ABORT_PATTERN_MATCHED:directory_conflict\nmatched='The directory .* contains files that could conflict'"),
    "fail_fast:directory_conflict",
  );
  assert.equal(classifyCliAdapterFailure("Timed out waiting for 'DONE'"), "marker_timeout");
  assert.equal(classifyCliAdapterFailure("Startup failed: profile missing"), "startup_failure");
  assert.equal(classifyCliAdapterFailure("Unhandled runner exception"), "runner_error");
});

test("mountaintop deterministic submit actions keep type->settle->enter contract", () => {
  const prompt = "single-pass prompt";
  const actions = buildDeterministicSubmitActions(prompt, {
    settleAfterTypeMs: 900,
    settleAfterEnterMs: 1100,
  });
  assert.equal(actions.length, 2);
  assert.equal(actions[0]?.typeText, prompt);
  assert.equal(actions[0]?.settleMs, 900);
  assert.equal(actions[actions.length - 1]?.key, "enter");
  assert.equal(actions[actions.length - 1]?.settleMs, 1100);
});

test("mountaintop deterministic submit actions can add confirmatory Enter presses", () => {
  const actions = buildDeterministicSubmitActions("long benchmark prompt", {
    settleAfterTypeMs: 750,
    settleAfterEnterMs: 900,
    extraEnterCount: 1,
    settleAfterExtraEnterMs: 300,
  });
  assert.equal(actions.length, 3);
  assert.equal(actions[0]?.typeText, "long benchmark prompt");
  assert.equal(actions[1]?.key, "enter");
  assert.equal(actions[1]?.settleMs, 900);
  assert.equal(actions[2]?.key, "enter");
  assert.equal(actions[2]?.settleMs, 300);
});

test("mountaintop prompt submission submits deterministically after setup ack", () => {
  const steps = buildPromptSubmissionSteps({
    setupCommands: ["/profiles use reference", "/mode build", "/code enable"],
    prompt: "run single pass and print MOUNTAINTOP_DONE marker",
  });
  assert.equal(steps.length, 1);
  assert.equal(steps[0]?.pattern, "(?:code-mode enabled\\.)|(?:code-mode already enabled\\.)");
  assert.equal(steps[0]?.send, "run single pass and print MOUNTAINTOP_DONE marker\n");
});

test("mountaintop setup-command sequencing uses ack-gated cursor-forward steps", () => {
  const steps = buildCliSetupCommandSteps([
    "/profiles use reference",
    "/mode build",
    "/code enable",
  ]);
  assert.equal(steps.length, 3);
  assert.equal(
    steps[0]?.pattern,
    "(?:·\\s+CHAT)|(?:Started fresh session)|(?:No workspace bound to the active session\\.)",
  );
  assert.equal(steps[0]?.fromCursor, true);
  assert.equal(steps[0]?.actions?.[0]?.typeText, "/profiles use reference");
  assert.equal(steps[0]?.actions?.[1]?.key, "enter");
  assert.equal(steps[1]?.pattern, "(?:Profile set to '.+')|(?:Profile already set to '.+')");
  assert.equal(steps[1]?.actions?.[0]?.typeText, "/mode build");
  assert.equal(
    steps[2]?.pattern,
    "(?:Mode set to (Chat|Plan|Build)\\.)|(?:Mode already set to (Chat|Plan|Build)\\.)",
  );
  assert.equal(steps[2]?.fromCursor, true);
  assert.equal(steps[2]?.actions?.[0]?.typeText, "/code enable");
});

test("mountaintop CLI run-start pattern accepts legacy and committed-step markers", () => {
  const pattern = new RegExp(buildCliRunStartedPattern(), "u");
  assert.equal(pattern.test("Kestrel Chat · Run started for 'user.message'."), true);
  assert.equal(pattern.test("Run started."), true);
  assert.equal(pattern.test("Run started for 'user.message'."), true);
  assert.equal(
    pattern.test("Committed step 'react.exec.dispatch' with status 'RUNNING'."),
    true,
  );
  assert.equal(pattern.test("Saved react.exec.dispatch (running)."), true);
});

test("mountaintop CLI completion pattern accepts visible finalize messages and raw markers", () => {
  const pattern = new RegExp(buildCliCompletionPattern("MOUNTAINTOP_DONE:nextjs-template-scaffold-smoke"), "u");
  assert.equal(pattern.test("MOUNTAINTOP_DONE:nextjs-template-scaffold-smoke"), true);
  assert.equal(pattern.test("The process has been finalized successfully, and no further actions are needed."), true);
  assert.equal(pattern.test("Run completed at step 'agent.exec.finalize'."), false);
});

test("mountaintop CLI adapter failure diagnostics include failure class and transcript pointers", () => {
  const diagnostics = buildCliAdapterFailureDiagnostics({
    failureCode: "fail_fast:missing_shell_capabilities_loop",
    transcriptStdoutPath: "/tmp/cli.transcript.log",
    transcriptStderrPath: "/tmp/cli.transcript.stderr.log",
    runtimeSessionName: "mountaintop-cli-123",
    runtimeSessionId: "mountaintop-cli-123",
    runtimeRunId: "run-cli-123",
    runtimeCleanupStatus: "closed",
    transcriptTailPath: "/tmp/cli.transcript.tail.log",
  });
  assert.equal(diagnostics[0], "CLI adapter failed: fail_fast:missing_shell_capabilities_loop");
  assert.equal(diagnostics.includes("CLI adapter transcript stdout: /tmp/cli.transcript.log"), true);
  assert.equal(diagnostics.includes("CLI adapter transcript stderr: /tmp/cli.transcript.stderr.log"), true);
  assert.equal(diagnostics.includes("CLI adapter runtime session_name: mountaintop-cli-123"), true);
  assert.equal(diagnostics.includes("CLI adapter runtime session_id: mountaintop-cli-123"), true);
  assert.equal(diagnostics.includes("CLI adapter runtime run_id: run-cli-123"), true);
  assert.equal(diagnostics.includes("CLI adapter runtime cleanup: closed"), true);
  assert.equal(diagnostics.includes("CLI adapter transcript tail: /tmp/cli.transcript.tail.log"), true);
});

test("mountaintop runtime failure diagnostics include runtime failure code and message", () => {
  const diagnostics = deriveRuntimeRunFailureDiagnostics({
    code: "DECISION_POLICY_FAILED",
    message: "The runtime decision failed validation.",
  });
  assert.deepEqual(diagnostics, [
    "Runtime run failed code: DECISION_POLICY_FAILED",
    "Runtime run failed message: The runtime decision failed validation.",
  ]);
});

test("mountaintop marker-timeout diagnostics include replay context and failing gate attribution", () => {
  const diagnostics = deriveRuntimeMarkerTimeoutDiagnostics({
    lastCommand: "pnpm lint",
    completedExitCode: 1,
    remediationEvidenceToken: "devshell:remediate:cmd-lint:1:4102",
    recentCommands: [
      "pnpm lint",
      "pnpm lint",
      "pnpm exec tsc --noEmit",
    ],
  });
  assert.deepEqual(diagnostics, [
    "Runtime marker-timeout replay context: repeated_command='pnpm lint' repeat_count=2",
    "Runtime marker-timeout first failing gate command: pnpm lint",
    "Runtime marker-timeout settled exit code: 1",
    "Runtime marker-timeout remediation token: devshell:remediate:cmd-lint:1:4102",
  ]);
});

test("mountaintop runtime completion diagnostics distinguish wrapper validation from runtime churn", () => {
  const diagnostics = deriveRuntimeCompletionAttributionDiagnostics({
    runtimeCompletedAt: "2026-04-04T00:26:41.000Z",
    wrapperValidationDurationMs: 10_625,
    postMarkerRuntimeShellActions: 0,
    postMarkerSettledTerminalPollingRedirects: 0,
  });
  assert.deepEqual(diagnostics, [
    "Runtime completed at: 2026-04-04T00:26:41.000Z",
    "Wrapper validation duration: 10625 ms",
      "Post-completion runtime shell actions: 0",
      "Post-completion settled-terminal polling redirects: 0",
  ]);
});

test("mountaintop runtime completion diagnostics surface true post-marker settled polling", () => {
  const diagnostics = deriveRuntimeCompletionAttributionDiagnostics({
    runtimeCompletedAt: "2026-04-04T00:26:41.000Z",
    wrapperValidationDurationMs: 3200,
    postMarkerRuntimeShellActions: 2,
    postMarkerSettledTerminalPollingRedirects: 1,
  });
  assert.deepEqual(diagnostics, [
    "Runtime completed at: 2026-04-04T00:26:41.000Z",
    "Wrapper validation duration: 3200 ms",
      "Post-completion runtime shell actions: 2",
      "Post-completion settled-terminal polling redirects: 1",
  ]);
});

test("mountaintop engine mode helper resolves single-engine and dual-engine orders", () => {
  assert.deepEqual(resolveEngineOrder("cli"), ["cli"]);
  assert.deepEqual(resolveEngineOrder("web"), ["web"]);
  assert.deepEqual(resolveEngineOrder("both"), ["cli", "web"]);
  assert.deepEqual(resolveScenarioEngineOrder("both", { supportedEngines: ["cli"] }), ["cli"]);
  assert.deepEqual(resolveScenarioEngineOrder("both", { supportedEngines: ["web"] }), ["web"]);
  assert.deepEqual(resolveScenarioEngineOrder("web", { supportedEngines: ["cli"] }), ["web"]);
});

test("mountaintop parity checks are skipped in single-engine mode", () => {
  const parityChecks = buildParityChecksForMode(
    [
      {
        engine: "cli",
        status: "passed",
        failureBucket: undefined,
        failureBucketDiagnostics: [],
        durationMs: 1,
        workspacePath: "/tmp/cli",
        transcriptPath: "/tmp/cli.log",
        diagnostics: [],
        completionDetected: true,
        qualityGateResults: [],
        artifactChecks: [],
        toolEvidence: { successfulCalls: [], failedCalls: [], checks: [], diagnostics: [] },
        modelEvidence: {
          requestedProvider: "openrouter",
          requestedModel: "openai/gpt-5.4-mini",
          observedProviders: [],
          observedModels: [],
          diagnostics: [],
        },
        smokeChecks: [],
      },
    ],
    "cli",
  );
  assert.deepEqual(parityChecks, []);
});

test("mountaintop runtime progress diagnostics flag selected->started gaps", () => {
  const diagnostics = deriveRuntimeProgressGapDiagnostics({
    focusStep: "agent.loop",
    events: [
      {
        eventType: "step.selected",
        stepIndex: 62,
        stepName: "agent.loop",
        occurredAt: "2026-03-26T20:57:31.000Z",
      },
      {
        eventType: "outbox.dispatched",
        stepIndex: 61,
        stepName: null,
        occurredAt: "2026-03-26T20:57:30.000Z",
      },
      {
        eventType: "step.started",
        stepIndex: 61,
        stepName: "react.exec.collect",
        occurredAt: "2026-03-26T20:57:29.000Z",
      },
    ],
  });

  assert.equal(diagnostics.length, 2);
  assert.equal(
    diagnostics[0],
    "Runtime progress gap: step.selected_without_step.started step='agent.loop' step_index=62",
  );
});

test("mountaintop runtime progress diagnostics ignore selected steps that have started", () => {
  const diagnostics = deriveRuntimeProgressGapDiagnostics({
    focusStep: "agent.loop",
    events: [
      {
        eventType: "step.started",
        stepIndex: 54,
        stepName: "agent.loop",
        occurredAt: "2026-03-26T20:57:27.000Z",
      },
      {
        eventType: "step.selected",
        stepIndex: 54,
        stepName: "agent.loop",
        occurredAt: "2026-03-26T20:57:26.000Z",
      },
    ],
  });

  assert.deepEqual(diagnostics, []);
});

test("mountaintop resolves persisted runtime session id from kestrel sessions index", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mountaintop-session-index-"));
  const kestrelHome = path.join(root, ".kestrel");
  await mkdir(kestrelHome, { recursive: true });
  await writeFile(
    path.join(kestrelHome, "sessions.json"),
    JSON.stringify(
      {
        version: 5,
        sessions: [
          { name: "other", sessionId: "reference-other-1" },
          {
            name: "mountaintop-cli-xyz",
            sessionId: "reference-mountaintop-cli-xyz-177",
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  const resolved = await resolvePersistedSessionIdFromKestrelHome({
    kestrelHomePath: kestrelHome,
    sessionName: "mountaintop-cli-xyz",
  });
  assert.equal(resolved, "reference-mountaintop-cli-xyz-177");
});

test("mountaintop session resolver returns undefined when session is absent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mountaintop-session-miss-"));
  const kestrelHome = path.join(root, ".kestrel");
  await mkdir(kestrelHome, { recursive: true });
  await writeFile(path.join(kestrelHome, "sessions.json"), "{\"version\":5,\"sessions\":[]}\n", "utf8");

  const resolved = await resolvePersistedSessionIdFromKestrelHome({
    kestrelHomePath: kestrelHome,
    sessionName: "mountaintop-cli-missing",
  });
  assert.equal(resolved, undefined);
});

test("mountaintop retention pruning keeps newest run directories only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mountaintop-retention-"));
  const runA = path.join(root, "run-a");
  const runB = path.join(root, "run-b");
  const runC = path.join(root, "run-c");
  await mkdir(runA, { recursive: true });
  await mkdir(runB, { recursive: true });
  await mkdir(runC, { recursive: true });
  await writeFile(path.join(runA, "stamp.txt"), "a", "utf8");
  await writeFile(path.join(runB, "stamp.txt"), "b", "utf8");
  await writeFile(path.join(runC, "stamp.txt"), "c", "utf8");

  await new Promise((resolve) => setTimeout(resolve, 10));
  await writeFile(path.join(runC, "touch.txt"), "latest", "utf8");

  await pruneMountaintopRuns(root, 2);
  const remaining = (await readdir(root)).sort();
  assert.equal(remaining.length, 2);
  assert.equal(remaining.includes("run-c"), true);
});

test("mountaintop workspace precondition requires package.json before gates run", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mountaintop-precondition-"));
  const missingPkg = path.join(root, "missing-pkg");
  const ready = path.join(root, "ready");
  await mkdir(missingPkg, { recursive: true });
  await mkdir(ready, { recursive: true });
  await writeFile(path.join(ready, "package.json"), "{\"name\":\"probe\"}\n", "utf8");

  assert.equal(await checkWorkspaceValidationPreconditions(missingPkg), false);
  assert.equal(await checkWorkspaceValidationPreconditions(ready), true);
});

test("mountaintop structured tool evidence counts successful and failed research calls", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mountaintop-tool-evidence-"));
  const kestrelHome = path.join(root, ".kestrel");
  await mkdir(kestrelHome, { recursive: true });
  await writeFile(
    path.join(kestrelHome, "history.jsonl"),
    [
      JSON.stringify({
        data: {
          lastActionResult: {
            kind: "tool",
            name: "internet.news",
            output: { status: "ok" },
          },
        },
      }),
      JSON.stringify({
        data: {
          lastActionResult: {
            kind: "tool",
            name: "internet.search",
            output: { status: "failed" },
          },
        },
      }),
      JSON.stringify({
        run: {
          errors: [
            {
              details: {
                toolName: "internet.search_advanced",
              },
            },
          ],
        },
      }),
    ].join("\n"),
    "utf8",
  );

  const evidence = await collectToolEvidence({
    kestrelHomePath: kestrelHome,
    requiredToolEvidence: [
      {
        tools: ["internet.news", "internet.search", "internet.search_advanced"],
        minSuccessfulCalls: 1,
      },
    ],
  });

  assert.deepEqual(evidence.successfulCalls, [{ toolName: "internet.news", count: 1 }]);
  assert.deepEqual(evidence.failedCalls, [
    { toolName: "internet.search", count: 1 },
    { toolName: "internet.search_advanced", count: 1 },
  ]);
  assert.deepEqual(evidence.checks, [
    {
      tools: ["internet.news", "internet.search", "internet.search_advanced"],
      minSuccessfulCalls: 1,
      matchedSuccessfulCalls: 1,
      satisfied: true,
      diagnostics: [],
    },
  ]);
  assert.deepEqual(evidence.diagnostics, []);
});

test("mountaintop structured tool evidence accepts final runtime evidence summary tool tokens", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mountaintop-tool-evidence-summary-"));
  const kestrelHome = path.join(root, ".kestrel");
  await mkdir(kestrelHome, { recursive: true });
  await writeFile(
    path.join(kestrelHome, "history.jsonl"),
    `${JSON.stringify({
      data: {
        runtimeEvidenceSummary: {
          supportedTokens: ["tool:internet.news", "tool:fs.verify_json"],
          blockedTokens: [],
        },
      },
    })}\n`,
    "utf8",
  );

  const evidence = await collectToolEvidence({
    kestrelHomePath: kestrelHome,
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
  });

  assert.deepEqual(evidence.successfulCalls, [
    { toolName: "fs.verify_json", count: 1 },
    { toolName: "internet.news", count: 1 },
  ]);
  assert.equal(evidence.checks[0]?.satisfied, true);
  assert.equal(evidence.checks[1]?.satisfied, true);
});

test("mountaintop structured tool evidence fails missing research requirement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mountaintop-tool-evidence-missing-"));
  const kestrelHome = path.join(root, ".kestrel");
  await mkdir(kestrelHome, { recursive: true });
  await writeFile(
    path.join(kestrelHome, "history.jsonl"),
    `${JSON.stringify({ data: { lastActionResult: { kind: "tool", name: "dev.shell.run" } } })}\n`,
    "utf8",
  );

  const evidence = await collectToolEvidence({
    kestrelHomePath: kestrelHome,
    requiredToolEvidence: [
      {
        tools: ["internet.news", "internet.search", "internet.search_advanced"],
        minSuccessfulCalls: 1,
      },
    ],
  });

  assert.deepEqual(evidence.successfulCalls, [{ toolName: "dev.shell.run", count: 1 }]);
  assert.deepEqual(evidence.failedCalls, []);
  assert.equal(evidence.checks[0]?.satisfied, false);
  assert.equal(
    evidence.checks[0]?.diagnostics[0],
    "Required structured tool evidence not satisfied for [internet.news, internet.search, internet.search_advanced]: expected at least 1 successful call(s), observed 0.",
  );
});

test("mountaintop runtime quality-gate evidence accepts combined successful dev-shell verification", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mountaintop-quality-evidence-"));
  const kestrelHome = path.join(root, ".kestrel");
  await mkdir(kestrelHome, { recursive: true });
  await writeFile(
    path.join(kestrelHome, "history.jsonl"),
    `${JSON.stringify({
      data: {
        decisionVerification: {
          verificationSteps: ["check:pnpm lint", "check:pnpm exec tsc --noEmit", "check:pnpm build"],
        },
        lastActionResult: {
          kind: "tool",
          name: "dev.shell.run",
          output: {
            status: "COMPLETED",
            exitCode: 0,
            command: "pnpm lint && pnpm exec tsc --noEmit && pnpm build",
          },
        },
      },
    })}\n`,
    "utf8",
  );

  const evidence = await collectRuntimeQualityGateEvidence({ kestrelHomePath: kestrelHome });

  assert.deepEqual(evidence.successfulCommands, ["pnpm build", "pnpm exec tsc --noEmit", "pnpm lint"]);
  assert.deepEqual(evidence.verificationItems, ["pnpm build", "pnpm exec tsc --noEmit", "pnpm lint"]);
  assert.deepEqual(
    ["pnpm lint", "pnpm exec tsc --noEmit", "pnpm build"].map((expectedCommand) =>
      deriveQualityGateEvidence({ expectedCommand, evidence }).status
    ),
    ["passed", "passed", "passed"],
  );
});

test("mountaintop runtime quality-gate evidence accepts final runtime evidence summary tokens", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mountaintop-quality-evidence-summary-"));
  const kestrelHome = path.join(root, ".kestrel");
  await mkdir(kestrelHome, { recursive: true });
  await writeFile(
    path.join(kestrelHome, "history.jsonl"),
    `${JSON.stringify({
      data: {
        decisionVerification: {
          verificationSteps: ["check:pnpm lint", "check:pnpm build"],
        },
        runtimeEvidenceSummary: {
          supportedTokens: ["check:pnpm lint", "check:pnpm build"],
          blockedTokens: [],
        },
      },
    })}\n`,
    "utf8",
  );

  const evidence = await collectRuntimeQualityGateEvidence({ kestrelHomePath: kestrelHome });

  assert.deepEqual(evidence.successfulCommands, ["pnpm build", "pnpm lint"]);
  assert.deepEqual(evidence.verificationItems, ["pnpm build", "pnpm lint"]);
  assert.equal(deriveQualityGateEvidence({ expectedCommand: "pnpm build", evidence }).status, "passed");
});

test("mountaintop evidence helpers consume runtime session ledger when history is empty", () => {
  const sessionState = {
    agent: {
      evidenceLedger: [
        {
          id: "ev_news",
          version: "v1",
          createdAt: "2026-05-27T00:00:00.000Z",
          source: "tool",
          kind: "tool_result",
          status: "passed",
          summary: "internet.news produced passed evidence.",
          facts: {
            toolName: "internet.news",
          },
        },
        {
          id: "ev_verify",
          version: "v1",
          createdAt: "2026-05-27T00:00:01.000Z",
          source: "tool",
          kind: "tool_result",
          status: "passed",
          summary: "Verified JSON artifact 'newsletter-report.json::stories'.",
          facts: {
            toolName: "fs.verify_json",
          },
        },
        {
          id: "ev_build",
          version: "v1",
          createdAt: "2026-05-27T00:00:02.000Z",
          source: "tool",
          kind: "process_result",
          status: "passed",
          summary: "pnpm validation passed.",
          facts: {
            toolName: "dev.shell.run",
            command: "pnpm lint && pnpm exec tsc --noEmit && pnpm build",
            exitCode: 0,
          },
        },
      ],
    },
  };

  const gateEvidence = collectRuntimeQualityGateEvidenceFromSessionStateForTests(sessionState);
  const toolEvidence = collectToolEvidenceFromSessionStateForTests({
    sessionState,
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
  });

  assert.deepEqual(gateEvidence.successfulCommands, ["pnpm build", "pnpm exec tsc --noEmit", "pnpm lint"]);
  assert.equal(deriveQualityGateEvidence({ expectedCommand: "pnpm build", evidence: gateEvidence }).status, "passed");
  assert.deepEqual(toolEvidence.successfulCalls, [
    { toolName: "dev.shell.run", count: 1 },
    { toolName: "fs.verify_json", count: 1 },
    { toolName: "internet.news", count: 1 },
  ]);
  assert.equal(toolEvidence.checks[0]?.satisfied, true);
  assert.equal(toolEvidence.checks[1]?.satisfied, true);
});

test("mountaintop runtime session evidence lookup diagnoses missing failed-run session state", async () => {
  const lookup = await readRuntimeSessionStateForEvidence({
    runtimeContext: {
      sessionId: "reference-mountaintop-cli-missing",
      runId: "run-missing",
    },
    loadSessionState: async () => {},
  });

  assert.equal(lookup.state, undefined);
  assert.deepEqual(lookup.diagnostics, [
    "Runtime session evidence unavailable: session 'reference-mountaintop-cli-missing' not found in database.",
  ]);
});

test("mountaintop runtime quality gates write evidence summaries without rerunning commands", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mountaintop-quality-gates-"));
  const kestrelHome = path.join(root, ".kestrel");
  const logsDir = path.join(root, "logs");
  await mkdir(kestrelHome, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  await writeFile(
    path.join(kestrelHome, "history.jsonl"),
    `${JSON.stringify({
      data: {
        decisionVerification: {
          verificationSteps: ["check:pnpm lint"],
        },
        lastActionResult: {
          kind: "tool",
          name: "dev.shell.run",
          output: {
            status: "COMPLETED",
            exitCode: 0,
            command: "pnpm lint",
          },
        },
      },
    })}\n`,
    "utf8",
  );

  const results = await runQualityGates({
    kestrelHomePath: kestrelHome,
    logsDir,
    engine: "cli",
    gates: [
      {
        id: "lint",
        label: "pnpm lint",
        command: "pnpm",
        args: ["lint"],
        required: true,
      },
    ],
  });
  const log = JSON.parse(await readFile(path.join(logsDir, "cli.gate.lint.log"), "utf8")) as {
    status: string;
    evidence: { successfulCommands: string[] };
  };

  assert.equal(results[0]?.status, "passed");
  assert.equal(results[0]?.required, true);
  assert.equal(results[0]?.durationMs, 0);
  assert.equal(log.status, "passed");
  assert.deepEqual(log.evidence.successfulCommands, ["pnpm lint"]);
});

test("mountaintop runtime quality gates fail when verification or successful command evidence is missing", async () => {
  const missing = deriveQualityGateEvidence({
    expectedCommand: "pnpm lint",
    evidence: {
      successfulCommands: [],
      verificationItems: [],
      diagnostics: ["Runtime quality-gate evidence unavailable: missing history."],
    },
  });
  assert.equal(missing.status, "failed");
  assert.match(missing.diagnostics[0] ?? "", /verificationItem=missing, successfulCommand=missing/u);

  const failedShell = deriveQualityGateEvidence({
    expectedCommand: "pnpm lint",
    evidence: {
      successfulCommands: [],
      verificationItems: ["pnpm lint"],
      diagnostics: [],
    },
  });
  assert.equal(failedShell.status, "failed");
  assert.match(failedShell.diagnostics[0] ?? "", /verificationItem=present, successfulCommand=missing/u);
});

test("mountaintop optional quality gates do not fail engine status", () => {
  const status = deriveEngineStatus({
    blockingDiagnostics: [],
    completionDetected: true,
    artifactChecks: [],
    toolEvidence: {
      successfulCalls: [],
      failedCalls: [],
      checks: [],
      diagnostics: [],
    },
    gateResults: [
      {
        id: "optional-lint",
        label: "optional lint",
        required: false,
        status: "failed",
        durationMs: 0,
        outputPath: "/tmp/optional-lint.log",
        diagnostics: ["optional gate missing"],
      },
    ],
    smokeChecks: [],
  });

  assert.equal(status, "passed");
});

test("mountaintop simulated user waits trigger only for explicit runtime waits", () => {
  const replyDecision = evaluateSimulatedUserWaitDecision({
    sessionSnapshot: {
      name: "mountaintop-cli-123",
      sessionId: "session-123",
      lastRunStatus: "WAITING",
      pendingWaitFor: {
        eventType: "user.reply",
        metadata: {
          question: "Should I continue with build mode?",
        },
      },
    },
    seenWaitFingerprints: new Set(),
    maxTurns: 3,
  });
  assert.equal(replyDecision.kind, "reply");
  assert.equal(replyDecision.prompt, "Should I continue with build mode?");
  assert.match(replyDecision.fingerprint ?? "", /session-123/u);

  const noWaitDecision = evaluateSimulatedUserWaitDecision({
    sessionSnapshot: {
      name: "mountaintop-cli-123",
      sessionId: "session-123",
      lastRunStatus: "RUNNING",
      pendingWaitFor: {
        eventType: "user.reply",
        metadata: {
          question: "Should I continue with build mode?",
        },
      },
    },
    seenWaitFingerprints: new Set(),
    maxTurns: 3,
  });
  assert.equal(noWaitDecision.kind, "none");

  const duplicateDecision = evaluateSimulatedUserWaitDecision({
    sessionSnapshot: {
      name: "mountaintop-cli-123",
      sessionId: "session-123",
      lastRunStatus: "WAITING",
      pendingWaitFor: {
        eventType: "user.reply",
        metadata: {
          question: "Should I continue with build mode?",
        },
      },
    },
    seenWaitFingerprints: new Set([replyDecision.fingerprint ?? ""]),
    maxTurns: 3,
  });
  assert.equal(duplicateDecision.kind, "none");

  const exhaustedDecision = evaluateSimulatedUserWaitDecision({
    sessionSnapshot: {
      name: "mountaintop-cli-123",
      sessionId: "session-123",
      lastRunStatus: "WAITING",
      pendingWaitFor: {
        eventType: "user.reply",
        metadata: {
          question: "One more thing?",
        },
      },
    },
    seenWaitFingerprints: new Set(["wait-1", "wait-2", "wait-3"]),
    maxTurns: 3,
  });
  assert.equal(exhaustedDecision.kind, "turn_cap_exhausted");
  assert.match(exhaustedDecision.diagnostics[0] ?? "", /turn cap reached/u);
});

test("mountaintop failure buckets separate harness, agent runtime, and product output failures", () => {
  const harness = deriveFailureBucket({
    status: "failed",
    completionDetected: false,
    artifactChecks: [],
    toolEvidence: {
      successfulCalls: [],
      failedCalls: [],
      checks: [],
      diagnostics: [],
    },
    gateResults: [],
    smokeChecks: [],
  });
  assert.equal(harness.bucket, "harness");

  const agentRuntime = deriveFailureBucket({
    status: "failed",
    completionDetected: false,
    runtimeFailureObserved: true,
    artifactChecks: [],
    toolEvidence: {
      successfulCalls: [],
      failedCalls: [],
      checks: [],
      diagnostics: [],
    },
    gateResults: [],
    smokeChecks: [],
  });
  assert.equal(agentRuntime.bucket, "agent_runtime");

  const productOutput = deriveFailureBucket({
    status: "build_failed",
    completionDetected: true,
    artifactChecks: [
      {
        path: "app/page.tsx",
        exists: true,
      },
    ],
    toolEvidence: {
      successfulCalls: [],
      failedCalls: [],
      checks: [],
      diagnostics: [],
    },
    gateResults: [
      {
        id: "build",
        label: "pnpm build",
        required: true,
        status: "failed",
        durationMs: 1,
        outputPath: "/tmp/build.log",
        diagnostics: ["build failed"],
      },
    ],
    smokeChecks: [],
  });
  assert.equal(productOutput.bucket, "product_output");
});

test("mountaintop workspace command env keeps Corepack cache outside the workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mountaintop-command-env-"));
  const workspacePath = path.join(root, "workspace");
  const logsDir = path.join(root, "logs");
  await mkdir(workspacePath, { recursive: true });
  await mkdir(logsDir, { recursive: true });

  const env = await buildWorkspaceCommandEnv({ workspacePath, logsDir });
  const corepackHome = String(env.COREPACK_HOME);

  assert.equal(corepackHome.startsWith(`${workspacePath}${path.sep}`), false);
  assert.equal(corepackHome.startsWith(`${logsDir}${path.sep}`), true);
});

test("mountaintop shell command splitter handles deterministic && gate chains", () => {
  assert.deepEqual(
    splitShellAndChainCommands("pnpm lint && pnpm exec tsc --noEmit && pnpm build"),
    ["pnpm lint", "pnpm exec tsc --noEmit", "pnpm build"],
  );
  assert.deepEqual(
    splitShellAndChainCommands("printf 'a && b' && pnpm lint"),
    ["printf 'a && b'", "pnpm lint"],
  );
});

test("mountaintop waits for query-ready postgres before running migrations", async () => {
  let attempts = 0;
  const result = await waitForPostgresReady({
    databaseUrl: "postgres://kestrel:kestrel@localhost:55432/kestrel_ops_test",
    timeoutMs: 5000,
    pollIntervalMs: 1,
    probe: async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error(`not ready ${attempts}`);
      }
    },
    sleepFn: async () => {},
  });

  assert.deepEqual(result, {
    ready: true,
    attempts: 3,
    timeoutMs: 5000,
    pollIntervalMs: 1,
  });
});

test("mountaintop readiness reports the last postgres query error on timeout", async () => {
  const result = await waitForPostgresReady({
    databaseUrl: "postgres://kestrel:kestrel@localhost:55432/kestrel_ops_test",
    timeoutMs: 0,
    pollIntervalMs: 1,
    probe: async () => {
      throw new Error("read ECONNRESET");
    },
    sleepFn: async () => {},
  });

  assert.deepEqual(result, {
    ready: false,
    attempts: 1,
    timeoutMs: 0,
    pollIntervalMs: 1,
    lastError: "read ECONNRESET",
  });
});

test("mountaintop structured tool evidence uses runtime recovery and session snapshots when per-call rows are absent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mountaintop-tool-evidence-runtime-"));
  const kestrelHome = path.join(root, ".kestrel");
  await mkdir(kestrelHome, { recursive: true });
  await writeFile(
    path.join(kestrelHome, "history.jsonl"),
    `${JSON.stringify({
      data: {
        guardToolName: "internet.search_advanced",
        artifactRecovery: {
          artifactIds: ["run-1:tool-output:7:internet.news"],
          digestArtifactIds: ["run-1:tool-output-digest:7:internet.search"],
        },
      },
    })}\n`,
    "utf8",
  );
  await writeFile(
    path.join(kestrelHome, "sessions.json"),
    JSON.stringify({
      version: 5,
      sessions: [
        {
          state: {
            runtimePlan: {
              commandNames: ["internet.news"],
            },
          },
        },
      ],
    }),
    "utf8",
  );

  const evidence = await collectToolEvidence({
    kestrelHomePath: kestrelHome,
    requiredToolEvidence: [
      {
        tools: ["internet.news", "internet.search", "internet.search_advanced"],
        minSuccessfulCalls: 1,
      },
    ],
  });

  assert.deepEqual(evidence.successfulCalls, [
    { toolName: "internet.news", count: 2 },
    { toolName: "internet.search", count: 1 },
    { toolName: "internet.search_advanced", count: 1 },
  ]);
  assert.deepEqual(evidence.failedCalls, []);
  assert.equal(evidence.checks[0]?.satisfied, true);
});

test("mountaintop structured tool evidence consumes runtime finalize tool summaries authoritatively", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mountaintop-tool-evidence-finalize-"));
  const kestrelHome = path.join(root, ".kestrel");
  await mkdir(kestrelHome, { recursive: true });
  await writeFile(
    path.join(kestrelHome, "history.jsonl"),
    `${JSON.stringify({
      role: "assistant",
      data: {
        toolEvidenceSummary: {
          successfulCalls: [
            { toolName: "internet.news", count: 2 },
            { toolName: "internet.search", count: 1 },
            { toolName: "fs.verify_json", count: 1 },
          ],
          failedCalls: [
            { toolName: "internet.search_advanced", count: 1 },
          ],
        },
        lastActionResult: {
          kind: "tool",
          name: "fs.verify_json",
          output: { status: "ok" },
        },
      },
    })}\n`,
    "utf8",
  );

  const evidence = await collectToolEvidence({
    kestrelHomePath: kestrelHome,
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
  });

  assert.deepEqual(evidence.successfulCalls, [
    { toolName: "fs.verify_json", count: 1 },
    { toolName: "internet.news", count: 2 },
    { toolName: "internet.search", count: 1 },
  ]);
  assert.deepEqual(evidence.failedCalls, [{ toolName: "internet.search_advanced", count: 1 }]);
  assert.equal(evidence.checks[0]?.satisfied, true);
  assert.equal(evidence.checks[1]?.satisfied, true);
});

test("mountaintop model evidence collects provider and model from reasoning history records", async () => {
  const kestrelHomePath = await mkdtemp(path.join(os.tmpdir(), "mountaintop-model-evidence-"));
  await writeFile(
    path.join(kestrelHomePath, "history.jsonl"),
    `${JSON.stringify({
      source: "runner",
      role: "assistant",
      data: {
        reasoning: true,
        model: {
          provider: "openrouter",
          model: "openai/gpt-5.4-mini-20260317",
        },
      },
    })}\n`,
    "utf8",
  );

  const evidence = await collectModelEvidence({
    kestrelHomePath,
    provider: nextJsTemplateNewsletterRealUserCliScenario.provider,
  });

  assert.deepEqual(evidence.observedProviders, ["openrouter"]);
  assert.deepEqual(evidence.observedModels, ["openai/gpt-5.4-mini-20260317"]);
});

test("mountaintop artifact checks validate structured json report requirements", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mountaintop-json-artifact-"));
  await writeFile(
    path.join(root, "newsletter-report.json"),
    JSON.stringify(
      {
        stories: Array.from({ length: 10 }, (_, index) => ({
          title: `Story ${index + 1}`,
          publisher: "Example News",
          url: `https://example.com/story-${index + 1}`,
          category: index < 5 ? "business" : "technology",
          summary: `Summary ${index + 1}`,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );

  const checks = await checkRequiredArtifacts(
    root,
    ["newsletter-report.json"],
    [],
    [
      {
        paths: ["newsletter-report.json"],
        arrayPath: "stories",
        minLength: 10,
        requiredStringFields: ["title", "publisher", "url", "category", "summary"],
        requiredAbsoluteUrlFields: ["url"],
        forbiddenStringLiterals: ["[to be researched]"],
      },
    ],
  );
  assert.deepEqual(checks, [
    {
      path: "newsletter-report.json",
      exists: true,
    },
    {
      path: "newsletter-report.json::stories[0..9]",
      exists: true,
    },
  ]);
});

test("mountaintop artifact checks reject placeholder rows and non-url sources", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mountaintop-json-artifact-invalid-"));
  await writeFile(
    path.join(root, "newsletter-report.json"),
    JSON.stringify(
      {
        stories: Array.from({ length: 10 }, (_, index) => ({
          title: "[to be researched]",
          publisher: "Example News",
          url: index === 0 ? "notaurl" : `https://example.com/story-${index + 1}`,
          category: index < 5 ? "business" : "technology",
          summary: `Summary ${index + 1}`,
        })),
      },
      null,
      2,
    ),
    "utf8",
  );

  const checks = await checkRequiredArtifacts(
    root,
    ["newsletter-report.json"],
    [],
    [
      {
        paths: ["newsletter-report.json"],
        arrayPath: "stories",
        minLength: 10,
        requiredStringFields: ["title", "publisher", "url", "category", "summary"],
        requiredAbsoluteUrlFields: ["url"],
        forbiddenStringLiterals: ["[to be researched]"],
      },
    ],
  );
  assert.equal(checks[1]?.exists, false);
  assert.equal(
    checks[1]?.diagnostics?.some((line) => /forbidden placeholder|absolute http\(s\) URL/u.test(line)),
    true,
  );
});

test("mountaintop smoke body normalization decodes html entities for visible-text assertions", () => {
  assert.equal(
    normalizeSmokeCheckBody("<h1>U.S. Business &amp; Technology Briefing</h1>").includes(
      "U.S. Business & Technology Briefing",
    ),
    true,
  );
});

test("mountaintop validation prefers a bound managed worktree when present", () => {
  const resolved = resolveManagedWorktreeValidationWorkspacePath("/tmp/source-workspace", {
    agent: {
      exec: {
        managedWorktreeBinding: {
          status: "bound",
          worktreeRoot: "/tmp/managed-worktree",
        },
      },
    },
  });
  assert.equal(resolved, "/tmp/managed-worktree");

  const fallback = resolveManagedWorktreeValidationWorkspacePath("/tmp/source-workspace", {
    agent: {
      exec: {
        managedWorktreeBinding: {
          status: "missing",
          worktreeRoot: "/tmp/managed-worktree",
        },
      },
    },
  });
  assert.equal(fallback, "/tmp/source-workspace");
});
