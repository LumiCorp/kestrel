import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { contractTest } from "../helpers/contract-test.js";

const runner = readFileSync(
  new URL("../../scripts/validate.mjs", import.meta.url),
  "utf8",
);
const rootPackage = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { scripts?: Record<string, string> };
const runnerDockerIgnore = readFileSync(
  new URL(
    "../../deploy/fly/kestrel-one-runner/Dockerfile.dockerignore",
    import.meta.url,
  ),
  "utf8",
);
const workflow = readFileSync(
  new URL("../../.github/workflows/ci.yml", import.meta.url),
  "utf8",
);
const proofChecker = readFileSync(
  new URL("../../scripts/check-contract-proofs.mjs", import.meta.url),
  "utf8",
);
const proofRegistry = readFileSync(
  new URL("../proof/registry.json", import.meta.url),
  "utf8",
);
const mutationAudit = readFileSync(
  new URL("../../scripts/validation/audit-mutations.mjs", import.meta.url),
  "utf8",
);
const productStack = readFileSync(
  new URL(
    "../../apps/web/scripts/product-validation-stack.mjs",
    import.meta.url,
  ),
  "utf8",
);
const productPlaywright = readFileSync(
  new URL("../../apps/web/playwright.product.config.ts", import.meta.url),
  "utf8",
);
const productBrowserProof = readFileSync(
  new URL(
    "../../apps/web/tests/product/durable-conversation.spec.ts",
    import.meta.url,
  ),
  "utf8",
);
const tuiJourneys = readFileSync(
  new URL("../ops/tui/tui.ops.ts", import.meta.url),
  "utf8",
);
const tuiPtyHelper = readFileSync(
  new URL("../ops/helpers/pty.ts", import.meta.url),
  "utf8",
);
const webCommandProof = readFileSync(
  new URL("../integration/web-command.test.ts", import.meta.url),
  "utf8",
);

contractTest(
  "runtime.hermetic",
  "validation durations are evidence rather than correctness gates",
  () => {
    for (const prohibited of [
      "const budgets",
      "TARGET_MS",
      "MAXIMUM_MS",
      "budgetMs",
      "exceeded its",
    ]) {
      assert.doesNotMatch(runner, new RegExp(prohibited, "u"));
      assert.doesNotMatch(proofChecker, new RegExp(prohibited, "u"));
      assert.doesNotMatch(proofRegistry, new RegExp(prohibited, "u"));
    }
    assert.match(
      runner,
      /measurements\.push\(\{ kind: "phase", name, durationMs \}\)/u,
    );
    assert.match(
      runner,
      /measurements\.push\(\{\s*kind: "task",\s*phase: phaseName,\s*name: item\.label,\s*durationMs,/u,
    );
    assert.match(runner, /slowestTests:/u);
  },
);

contractTest(
  "runtime.hermetic",
  "validation groups are sequential and Node concurrency is capped at four",
  () => {
    assert.match(
      runner,
      /for \(const item of options\.setup \?\? \[\]\) await runTask\(name, item\)/u,
    );
    assert.match(
      runner,
      /for \(const item of tasks\) await runTask\(name, item\)/u,
    );
    assert.doesNotMatch(runner, /Promise\.all\(tasks/u);
    assert.doesNotMatch(runner, /test-concurrency=6/u);
    assert.match(runner, /return files\.map\(\(file\) =>\s*nodeTests\(/u);
    assert.match(runner, /singleThreaded\.has\(file\) \? 1 : 4/u);
    assert.doesNotMatch(runner, /runtime process: remaining/u);
  },
);

contractTest(
  "runtime.hermetic",
  "focused validation uses the canonical runner lifecycle and report",
  () => {
    assert.match(runner, /await runValidation\(request\)/u);
    assert.match(
      runner,
      /if \(validationRequest\.mode === "full"\) await runFullValidation\(\);\n    else await runLeaf/u,
    );
    assert.match(
      runner,
      /writeReport\("passed", undefined, validationRequest\)/u,
    );
    assert.match(runner, /writeReport\("failed", error, validationRequest\)/u);
    assert.match(
      runner,
      /if \(validationRequest\.mode === "full"\) \{\s*rmSync\(REPORT_DIR/u,
    );
    assert.match(runner, /mkdirSync\(REPORT_DIR, \{ recursive: true \}\)/u);
  },
);

contractTest(
  "runtime.hermetic",
  "PostgreSQL validation keeps its generated database authority hermetic",
  () => {
    assert.match(runner, /KESTREL_DISABLE_DOTENV: "1"/u);
  },
);

contractTest(
  "runtime.hermetic",
  "focused audit checks mutations and contracts without replaying validation boundaries",
  () => {
    const auditLeaf = runner.slice(
      runner.indexOf('if (boundary === "audit")'),
      runner.indexOf('if (boundary === "postgres")'),
    );
    assert.match(auditLeaf, /await phase\("audit", auditTasks\(\)\)/u);
    for (const replayed of [
      "webProductionBuildTask",
      "hermeticTasks",
      "processTasks",
      "startPostgres",
      "chromiumTasks",
      "check-coverage",
    ]) {
      assert.doesNotMatch(auditLeaf, new RegExp(replayed, "u"));
    }
  },
);

contractTest(
  "runtime.hermetic",
  "portable validation harnesses do not enforce wall-clock correctness gates",
  () => {
    assert.doesNotMatch(mutationAudit, /\btimeout:\s*[1-9]/u);
    assert.doesNotMatch(productStack, /attempt\s*</u);
    assert.doesNotMatch(
      productBrowserProof,
      /deadline|Date\.now\(\)\s*\+\s*\d/u,
    );
    assert.doesNotMatch(tuiJourneys, /timeoutSeconds|concurrency:\s*true/u);
    assert.doesNotMatch(tuiPtyHelper, /timeoutSeconds|startupTimeoutSeconds/u);
    assert.doesNotMatch(
      webCommandProof,
      /--max-time|Timed out waiting|Date\.now\(\)\s*-\s*startedAt/u,
    );
    assert.match(productPlaywright, /timeout:\s*0/u);
    assert.match(productPlaywright, /expect:\s*\{ timeout:\s*0 \}/u);
    assert.match(productPlaywright, /KESTREL_ENVIRONMENT_GATEWAY_URL/u);
    assert.match(productPlaywright, /KESTREL_WORKSPACE_SERVICE_TOKEN/u);
  },
);

contractTest(
  "runtime.hermetic",
  "required pull-request validation is the minimal portable gate",
  () => {
    const fullValidation = runner.slice(
      runner.indexOf("async function runFullValidation()"),
      runner.indexOf("function hermeticTasks()"),
    );
    assert.match(fullValidation, /task\("public boundary", PNPM, \["run", "check:public-boundary"\]\)/u);
    assert.match(fullValidation, /phase\("sharedBuild"/u);
    assert.match(
      fullValidation,
      /task\("shared artifacts", PNPM, \["run", "build:shared"\]\)/u,
    );
    assert.match(fullValidation, /phase\("hermetic", hermeticTasks\(\)\)/u);
    for (const excluded of [
      "webProductionBuildTask",
      "processTasks",
      "processSetupTasks",
      "startPostgres",
      "postgresTasks",
      "chromiumTasks",
      "auditTasks",
    ]) {
      assert.doesNotMatch(fullValidation, new RegExp(excluded, "u"));
    }
    assert.doesNotMatch(
      runner,
      /validateGraphContract|enforceRequestInvariants|NODE_V8_COVERAGE|check-coverage/u,
    );
    assert.match(workflow, /uses: actions\/checkout@v4/u);
    assert.match(workflow, /uses: \.\/\.github\/actions\/setup/u);
    assert.match(workflow, /run: pnpm validate/u);
    assert.doesNotMatch(
      workflow,
      /playwright install|actions\/upload-artifact|test-results/u,
    );
  },
);

contractTest(
  "runtime.hermetic",
  "root builds prepare every shared workspace artifact before compilation",
  () => {
    assert.equal(
      rootPackage.scripts?.build,
      "pnpm run build:shared && pnpm run build:self",
    );
    const sharedBuild = rootPackage.scripts?.["build:shared"] ?? "";
    for (const packageName of [
      "@lumi/kestrel-environment-auth",
      "@kestrel/mcp-security",
      "@kestrel-agents/protocol",
      "@kestrel-agents/sdk",
      "@kestrel-agents/ai-sdk",
      "@kestrel-agents/next",
      "@kestrel-agents/observability",
      "@kestrel-agents/workspace-skills",
    ]) {
      assert.match(sharedBuild, new RegExp(`--filter ${packageName}`, "u"));
    }
    assert.match(sharedBuild, /run build:self$/u);
    assert.match(runnerDockerIgnore, /^tests\/\*$/mu);
    assert.match(runnerDockerIgnore, /^!tests\/helpers\/$/mu);
    assert.match(
      runnerDockerIgnore,
      /^!tests\/helpers\/contract-test\.ts$/mu,
    );
  },
);
