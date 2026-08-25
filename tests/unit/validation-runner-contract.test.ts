import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { KESTREL_HARNESS_ECONOMICS } from "../../src/profile/kestrelOnePolicy.js";
import {
  RUNTIME_HERMETIC_LANE_IDS,
  RUNTIME_HERMETIC_ISOLATION,
  RUNTIME_HERMETIC_WORKERS,
  validateRuntimeHermeticLaneManifest,
} from "../../scripts/validation/runtime-hermetic-lanes.mjs";
import {
  partitionTestFiles,
  runFailFastShards,
} from "../../scripts/validation/run-node-test-group.mjs";
import { renderValidationSummary } from "../../scripts/summarize-validation-report.mjs";
import { runWeightedTaskQueue } from "../../scripts/validation/weighted-task-queue.mjs";

const runner = readFileSync(
  new URL("../../scripts/validate.mjs", import.meta.url),
  "utf8",
);
const rootPackage = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { scripts?: Record<string, string> };
const runtimeHermeticLaneManifest = JSON.parse(
  readFileSync(
    new URL(
      "../../scripts/validation/runtime-hermetic-lanes.json",
      import.meta.url,
    ),
    "utf8",
  ),
) as {
  version: number;
  lanes: Record<
    string,
    { isolation: string; workers: number; files: string[] }
  >;
};
const nodeTestGroupRunner = readFileSync(
  new URL("../../scripts/validation/run-node-test-group.mjs", import.meta.url),
  "utf8",
);
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
const productGatewaySeed = readFileSync(
  new URL(
    "../../apps/web/scripts/seed-product-contract-gateway.ts",
    import.meta.url,
  ),
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

test("validation durations are evidence rather than correctness gates", () => {
  for (const prohibited of [
    "const budgets",
    "TARGET_MS",
    "MAXIMUM_MS",
    "budgetMs",
    "exceeded its",
  ]) {
    assert.doesNotMatch(runner, new RegExp(prohibited, "u"));
  }
  assert.match(
    runner,
    /measurements\.push\(\{ kind: "phase", name, durationMs \}\)/u,
  );
  assert.match(
    runner,
    /measurements\.push\(\{\s*kind: "task",\s*phase: phaseName,\s*name: item\.label,\s*durationMs,/u,
  );
  assert.match(runner, /slowestTasks:/u);
  assert.doesNotMatch(runner, /contract-timings|slowestTests|assertionTimeMs/u);
});

test("validation groups use a global resource budget and deterministic lane order", () => {
  assert.match(
    runner,
    /for \(const item of options\.setup \?\? \[\]\) await runTask\(name, item\)/u,
  );
  assert.match(runner, /await runWeightedTaskQueue\(tasks/u);
  assert.match(runner, /const HERMETIC_RESOURCE_BUDGET = 12/u);
  assert.match(runner, /const HERMETIC_TASK_CONCURRENCY = 4/u);
  assert.match(runner, /resourceBudget: HERMETIC_RESOURCE_BUDGET/u);
  assert.match(runner, /function orderHermeticTasks\(tasks\)/u);
  assert.match(runner, /\["Web hermetic", 0\]/u);
  assert.match(runner, /\["runtime\/runtime-core hermetic", 1\]/u);
  assert.match(runner, /\["runtime\/eval-replay hermetic", 2\]/u);
  assert.doesNotMatch(runner, /Promise\.all\(tasks/u);
  assert.doesNotMatch(runner, /\["runtime hermetic",/u);
  assert.doesNotMatch(runner, /hermeticFileConcurrency/u);
  assert.match(runner, /return files\.map\(\(file\) =>\s*nodeTests\(/u);
  assert.match(runner, /singleThreaded\.has\(file\) \? 1 : 4/u);
  assert.doesNotMatch(runner, /runtime process: remaining/u);
  assert.match(runner, /group\.label === "Web"/u);
  assert.match(runner, /group\.isolation !== undefined/u);
  assert.match(runner, /NODE_TEST_GROUP_RUNNER/u);
  assert.match(nodeTestGroupRunner, /--experimental-test-isolation=none/u);
  assert.match(nodeTestGroupRunner, /--test-concurrency=1/u);
  assert.match(nodeTestGroupRunner, /process\.kill\(-child\.pid, signal\)/u);
  assert.match(nodeTestGroupRunner, /spawnSync\("taskkill"/u);
  assert.match(nodeTestGroupRunner, /detached: process\.platform !== "win32"/u);
  assert.match(nodeTestGroupRunner, /process\.removeListener\("SIGTERM"/u);
});

test("runtime hermetic lane manifest is explicit, complete, and independently runnable", () => {
  assert.deepEqual(
    Object.keys(runtimeHermeticLaneManifest.lanes),
    RUNTIME_HERMETIC_LANE_IDS,
  );
  assert.equal(runtimeHermeticLaneManifest.version, 2);
  const assigned = Object.values(runtimeHermeticLaneManifest.lanes).flatMap(
    (definition) => definition.files,
  );
  assert.equal(assigned.length, 344);
  assert.equal(new Set(assigned).size, 344);
  assert.ok(
    runtimeHermeticLaneManifest.lanes["cli-command-mode"]?.files.includes(
      "tests/unit/approval-policy-pack-digest.test.ts",
    ),
  );
  assert.ok(
    runtimeHermeticLaneManifest.lanes["cli-command-mode"]?.files.includes(
      "tests/unit/runtime-cli-store-flag.test.ts",
    ),
  );
  for (const definition of Object.values(runtimeHermeticLaneManifest.lanes)) {
    assert.equal(definition.isolation, RUNTIME_HERMETIC_ISOLATION);
    assert.equal(definition.workers, RUNTIME_HERMETIC_WORKERS);
  }
  assert.equal(
    rootPackage.scripts?.["validate:lane"],
    "node scripts/validate.mjs --lane",
  );

  for (const lane of RUNTIME_HERMETIC_LANE_IDS) {
    assert.match(runner, new RegExp(`runtime/${lane}`, "u"));
  }
});

test("validation summary always exposes every runtime hermetic lane", () => {
  const summary = renderValidationSummary({
    status: "passed",
    durationMs: 12_000,
    telemetry: { managedProcessLaunches: 9 },
    measurements: RUNTIME_HERMETIC_LANE_IDS.map((lane, index) => ({
      kind: "task",
      phase: "hermetic",
      name: `runtime/${lane} hermetic`,
      durationMs: (index + 1) * 1_000,
    })),
    slowestTasks: Array.from({ length: 8 }, (_, index) => ({
      kind: "task",
      phase: "hermetic",
      name: `unrelated slow task ${index}`,
      durationMs: 20_000 - index,
    })),
  });

  assert.match(summary, /### Runtime Lanes/u);
  for (const lane of RUNTIME_HERMETIC_LANE_IDS) {
    assert.match(summary, new RegExp(`\\| ${lane} \\|`, "u"));
  }
});

test("runtime hermetic lane manifest rejects ownership drift", () => {
  const filesByLane = Object.fromEntries(
    RUNTIME_HERMETIC_LANE_IDS.map((lane) => [lane, [`tests/${lane}.test.ts`]]),
  );
  const discovered = Object.values(filesByLane).flat();
  const fixture = () => ({
    version: 2,
    lanes: Object.fromEntries(
      Object.entries(filesByLane).map(([lane, files]) => [
        lane,
        {
          isolation: RUNTIME_HERMETIC_ISOLATION,
          workers: RUNTIME_HERMETIC_WORKERS,
          files: [...files],
        },
      ]),
    ),
  });

  const validated = validateRuntimeHermeticLaneManifest(fixture(), discovered);
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(validated).map(([lane, definition]) => [
        lane,
        definition.files,
      ]),
    ),
    filesByLane,
  );

  const unknown = fixture();
  unknown.lanes["unknown-lane"] = {
    isolation: RUNTIME_HERMETIC_ISOLATION,
    workers: RUNTIME_HERMETIC_WORKERS,
    files: ["tests/unknown.test.ts"],
  };
  assert.throws(
    () => validateRuntimeHermeticLaneManifest(unknown, discovered),
    /unknown lane/u,
  );

  const empty = fixture();
  empty.lanes["runtime-core"]!.files = [];
  assert.throws(
    () => validateRuntimeHermeticLaneManifest(empty, discovered),
    /must not be empty/u,
  );

  const duplicate = fixture();
  duplicate.lanes["cli-command-mode"]?.files.push("tests/runtime-core.test.ts");
  assert.throws(
    () => validateRuntimeHermeticLaneManifest(duplicate, discovered),
    /more than once/u,
  );

  const stale = fixture();
  stale.lanes["runtime-core"]?.files.push("tests/process-boundary.test.ts");
  assert.throws(
    () => validateRuntimeHermeticLaneManifest(stale, discovered),
    /missing or non-hermetic/u,
  );

  assert.throws(
    () =>
      validateRuntimeHermeticLaneManifest(fixture(), [
        ...discovered,
        "tests/unassigned.test.ts",
      ]),
    /unassigned root hermetic/u,
  );

  const invalidIsolation = fixture();
  (invalidIsolation.lanes["runtime-core"] as { isolation: string }).isolation =
    "process-per-file";
  assert.throws(
    () => validateRuntimeHermeticLaneManifest(invalidIsolation, discovered),
    /isolation must be 'shared-process'/u,
  );

  const invalidWorkers = fixture();
  (invalidWorkers.lanes["runtime-core"] as { workers: number }).workers = 3;
  assert.throws(
    () => validateRuntimeHermeticLaneManifest(invalidWorkers, discovered),
    /workers must be 4/u,
  );

  const missingExecution = fixture();
  missingExecution.lanes["runtime-core"] = undefined as never;
  assert.throws(
    () => validateRuntimeHermeticLaneManifest(missingExecution, discovered),
    /must be an object/u,
  );
});

test("shared-process test groups partition files deterministically and exactly once", () => {
  const files = [
    "d.test.ts",
    "b.test.ts",
    "e.test.ts",
    "a.test.ts",
    "c.test.ts",
  ];
  const shards = partitionTestFiles(files, 4);

  assert.deepEqual(shards, [
    ["a.test.ts", "e.test.ts"],
    ["b.test.ts"],
    ["c.test.ts"],
    ["d.test.ts"],
  ]);
  assert.deepEqual(shards.flat().sort(), [...files].sort());
  assert.equal(new Set(shards.flat()).size, files.length);
  assert.deepEqual(partitionTestFiles(["only.test.ts"], 4), [["only.test.ts"]]);
  assert.throws(() => partitionTestFiles(files, 0), /positive integer/u);
  assert.throws(
    () => partitionTestFiles(["same.test.ts", "same.test.ts"], 4),
    /more than once/u,
  );
});

test("shared-process test groups abort sibling shards on first failure", async () => {
  const operations = new Map<
    number,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  const aborted: number[] = [];
  const execution = runFailFastShards([["a"], ["b"], ["c"]], {
    run: (_shard, index) =>
      new Promise<void>((resolve, reject) => {
        operations.set(index, { resolve, reject });
      }),
    abort: (index) => {
      aborted.push(index);
      operations.get(index)?.reject(new Error(`aborted ${index}`));
    },
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  operations.get(0)?.reject(new Error("first failure"));
  await assert.rejects(execution, /first failure/u);
  assert.deepEqual(aborted.sort(), [1, 2]);
});

test("weighted task queue enforces budget and bypasses blocked work", async () => {
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  let activeCost = 0;
  let peakCost = 0;
  const tasks = [
    { label: "large-a", resourceCost: 8 },
    { label: "large-b", resourceCost: 8 },
    { label: "small-c", resourceCost: 4 },
  ];
  const queue = runWeightedTaskQueue(tasks, {
    budget: 12,
    run: (item) => {
      started.push(item.label);
      activeCost += item.resourceCost;
      peakCost = Math.max(peakCost, activeCost);
      return new Promise<void>((resolve) => {
        releases.set(item.label, () => {
          activeCost -= item.resourceCost;
          resolve();
        });
      });
    },
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["large-a", "small-c"]);
  releases.get("small-c")?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["large-a", "small-c"]);
  releases.get("large-a")?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["large-a", "small-c", "large-b"]);
  releases.get("large-b")?.();
  await queue;
  assert.equal(peakCost, 12);
});

test("weighted task queue fails fast and stops launching pending work", async () => {
  const started: string[] = [];
  const releases = new Map<
    string,
    { resolve: () => void; reject: (error: Error) => void }
  >();
  let failures = 0;
  const queue = runWeightedTaskQueue(
    [
      { label: "first", resourceCost: 8 },
      { label: "second", resourceCost: 4 },
      { label: "pending", resourceCost: 4 },
    ],
    {
      budget: 12,
      run: (item) => {
        started.push(item.label);
        return new Promise<void>((resolve, reject) => {
          releases.set(item.label, { resolve, reject });
        });
      },
      onFailure: () => {
        failures += 1;
      },
    },
  );

  await new Promise<void>((resolve) => setImmediate(resolve));
  releases.get("first")?.reject(new Error("stop"));
  await assert.rejects(queue, /stop/u);
  assert.deepEqual(started, ["first", "second"]);
  assert.equal(failures, 1);
  releases.get("second")?.resolve();
});

test("focused validation uses the canonical runner lifecycle and report", () => {
  assert.match(runner, /await runValidation\(request\)/u);
  assert.match(
    runner,
    /if \(validationRequest\.mode === "full"\) await runFullValidation\(\);\n    else if \(validationRequest\.mode === "lane"\)/u,
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
});

test("PostgreSQL validation keeps its generated database authority hermetic", () => {
  assert.match(runner, /KESTREL_DISABLE_DOTENV: "1"/u);
});

test("focused audit prepares only the database required by live mutation owners", () => {
  const auditLeaf = runner.slice(
    runner.indexOf('if (boundary === "audit")'),
    runner.indexOf('if (boundary === "postgres")'),
  );
  assert.match(auditLeaf, /postgres = await startPostgres\(\)/u);
  assert.match(
    auditLeaf,
    /await phase\("audit", auditTasks\(postgres\), \{\s*setup: \[preparePostgresTask\(postgres\)\],\s*\}\)/u,
  );
  const auditTasksSource = runner.slice(
    runner.indexOf("function auditTasks(context)"),
    runner.indexOf("async function phase"),
  );
  assert.match(auditTasksSource, /scripts\/validation\/audit-mutations\.mjs/u);
  assert.match(auditTasksSource, /env: context\.environment/u);
  assert.doesNotMatch(auditTasksSource, /registry|check-contract-proofs/u);
  for (const replayed of [
    "webProductionBuildTask",
    "hermeticTasks",
    "processTasks",
    "postgresTasks",
    "run-postgres.ts",
    "chromiumTasks",
    "check-coverage",
  ]) {
    assert.doesNotMatch(auditLeaf, new RegExp(replayed, "u"));
  }
});

test("portable validation harnesses do not enforce wall-clock correctness gates", () => {
  assert.doesNotMatch(mutationAudit, /\btimeout:\s*[1-9]/u);
  assert.doesNotMatch(productStack, /attempt\s*</u);
  assert.doesNotMatch(productBrowserProof, /deadline|Date\.now\(\)\s*\+\s*\d/u);
  assert.doesNotMatch(tuiJourneys, /timeoutSeconds|concurrency:\s*true/u);
  assert.doesNotMatch(tuiPtyHelper, /timeoutSeconds|startupTimeoutSeconds/u);
  assert.doesNotMatch(
    webCommandProof,
    /--max-time|Timed out waiting|Date\.now\(\)\s*-\s*startedAt/u,
  );
  assert.match(productPlaywright, /timeout:\s*0/u);
  assert.match(productPlaywright, /expect:\s*\{ timeout:\s*0 \}/u);
  assert.match(productPlaywright, /KESTREL_ENVIRONMENT_GATEWAY_URL/u);
  assert.match(productPlaywright, /generateKeyPairSync\("ed25519"\)/u);
  assert.match(productPlaywright, /KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY/u);
  assert.match(productPlaywright, /KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY/u);
  assert.match(productPlaywright, /KESTREL_WORKSPACE_SERVICE_TOKEN/u);
});

test("product validation provisions the exact economics-admitted model it runs", () => {
  const agentModel = productPlaywright.match(
    /AI_AGENT_MODEL:\s*"([^"]+)"/u,
  )?.[1];
  const openRouterModel = productPlaywright.match(
    /OPENROUTER_MODEL:\s*"([^"]+)"/u,
  )?.[1];

  assert.ok(agentModel);
  assert.equal(openRouterModel, agentModel);
  assert.ok(
    KESTREL_HARNESS_ECONOMICS.modelProfiles.some(
      (profile) =>
        profile.provider === "openrouter" && profile.model === agentModel,
    ),
    `product validation model '${agentModel}' must have an exact Kestrel economics profile`,
  );
  assert.match(
    productGatewaySeed,
    /const rawModelId = process\.env\.AI_AGENT_MODEL\?\.trim\(\)/u,
  );
  assert.match(productGatewaySeed, /rawModelId,/u);
  assert.match(productGatewaySeed, /id: syncedModel\.id/u);
  assert.match(productGatewaySeed, /resolveOpenRouterModel: true/u);
  assert.match(productGatewaySeed, /expectedModelUpdatedAt: syncedModel\.updatedAt/u);
});

test("required pull-request validation is the minimal portable gate", () => {
  const fullValidation = runner.slice(
    runner.indexOf("async function runFullValidation()"),
    runner.indexOf("function hermeticTasks()"),
  );
  assert.match(
    fullValidation,
    /task\("public boundary", PNPM, \["run", "check:public-boundary"\]\)/u,
  );
  assert.match(fullValidation, /phase\(\s*"sharedBuild"/u);
  assert.match(
    fullValidation,
    /task\("shared artifacts", PNPM, \["run", "build:shared"\]\)/u,
  );
  assert.match(
    fullValidation,
    /phase\("hermetic", hermeticTasks\(\), \{\s*resourceBudget: HERMETIC_RESOURCE_BUDGET/u,
  );
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
  assert.match(
    workflow,
    /run: node scripts\/summarize-validation-report\.mjs/u,
  );
  assert.match(workflow, /uses: actions\/upload-artifact@v7/u);
  assert.match(
    workflow,
    /name: validation-report-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/u,
  );
  assert.match(workflow, /path: test-results\/validation\/report\.json/u);
  assert.doesNotMatch(workflow, /playwright install/u);
});

test("root builds prepare every shared workspace artifact before compilation", () => {
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
  assert.match(
    rootPackage.scripts?.["web:prepare"] ?? "",
    /--filter @kestrel-agents\/workspace-skills build/u,
  );
  assert.match(runnerDockerIgnore, /^tests\/\*$/mu);
  assert.doesNotMatch(runnerDockerIgnore, /tests\/helpers/u);
});

test("workspace type analysis does not repeat shared package build coverage", () => {
  const sharedBuildPhase = runner.slice(
    runner.indexOf('await phase(\n    "sharedBuild"'),
    runner.indexOf('await phase("hermetic"'),
  );
  const typeAnalysis = sharedBuildPhase.slice(
    sharedBuildPhase.indexOf('task("workspace type analysis"'),
  );

  for (const alreadyBuilt of [
    "@lumi/kestrel-environment-auth",
    "@kestrel/mcp-security",
  ]) {
    assert.match(
      rootPackage.scripts?.["build:shared"] ?? "",
      new RegExp(`--filter ${alreadyBuilt}`, "u"),
    );
    assert.doesNotMatch(typeAnalysis, new RegExp(alreadyBuilt, "u"));
  }
  for (const appBoundary of [
    "@kestrel/desktop",
    "@kestrel/environment-router",
    "@kestrel/preview-edge",
    "@kestrel/workspace-runtime",
    "@kestrel/mcp-service",
  ]) {
    assert.match(typeAnalysis, new RegExp(appBoundary, "u"));
  }
});

test("shared artifacts gate parallel root build and workspace type analysis", () => {
  const sharedBuildPhase = runner.slice(
    runner.indexOf('await phase(\n    "sharedBuild"'),
    runner.indexOf('await phase("hermetic"'),
  );
  assert.match(
    sharedBuildPhase,
    /setup: \[task\("shared artifacts", PNPM, \["run", "build:shared"\]\)\]/u,
  );
  assert.match(sharedBuildPhase, /resourceBudget: 2/u);
  assert.match(
    sharedBuildPhase,
    /task\("root artifact", PNPM, \["run", "build:self"\]\)/u,
  );
  assert.match(sharedBuildPhase, /task\("workspace type analysis", PNPM/u);
  assert.ok(
    sharedBuildPhase.indexOf('task("shared artifacts"') >
      sharedBuildPhase.indexOf('task("workspace type analysis"'),
    "shared artifacts should be declared as setup after the parallel task list",
  );
});

test("desktop public build commands prepare shared workspace artifacts", () => {
  const desktopPackage = JSON.parse(
    readFileSync(
      new URL("../../apps/desktop/package.json", import.meta.url),
      "utf8",
    ),
  ) as { scripts?: Record<string, string> };

  assert.equal(
    desktopPackage.scripts?.["prepare:workspace"],
    "pnpm -w run build:shared",
  );
  for (const scriptName of ["dev", "build", "typecheck"]) {
    assert.match(
      desktopPackage.scripts?.[scriptName] ?? "",
      /^pnpm run prepare:workspace && /u,
    );
  }
});
test("process validation builds every generated artifact it consumes", () => {
  const processSetup = runner.slice(
    runner.indexOf("function processSetupTasks()"),
    runner.indexOf("function testTasksForBoundary"),
  );
  assert.match(
    processSetup,
    /task\("shared and root artifacts", PNPM, \["run", "build"\]\)/u,
  );
  assert.match(processSetup, /@kestrel\/workspace-runtime/u);
  assert.match(processSetup, /"build:self"/u);
  assert.ok(
    processSetup.indexOf("shared and root artifacts") <
      processSetup.indexOf("packed consumer fixture"),
  );
  assert.ok(
    processSetup.indexOf("Workspace Runtime artifact") <
      processSetup.indexOf("packed consumer fixture"),
  );
});
