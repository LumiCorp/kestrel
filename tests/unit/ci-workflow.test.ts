import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { CI_GATE_IDS } from "../../src/governance/gates.js";

const ROOT = process.cwd();

test("CI workflow exposes parallel owned gates behind one stable aggregate", async () => {
  const workflow = await readFile(
    path.join(ROOT, ".github/workflows/ci.yml"),
    "utf8"
  );
  const setup = await readFile(
    path.join(ROOT, ".github/actions/setup/action.yml"),
    "utf8"
  );

  assert.match(workflow, /^\s{2}ci-required:\s*$/mu);
  assert.match(workflow, /^\s{4}name: ci-required\s*$/mu);
  assert.doesNotMatch(workflow, /^\s{2}validate:\s*$/mu);
  assert.doesNotMatch(workflow, /run: pnpm run test\s*$/mu);
  assert.equal(workflow.match(/pnpm run ci:runtime\s*$/gmu)?.length, 1);
  assert.match(
    workflow,
    /if: needs\.ci-plan\.outputs\.package_macos == 'true'/u
  );
  assert.match(setup, /pnpm install --frozen-lockfile/u);
  assert.match(workflow, /cron: "0 7 \* \* \*"/u);
  assert.match(workflow, /image: pgvector\/pgvector:pg16/u);
  assert.match(workflow, /postgres-integration -- pnpm run ci:postgres/u);
  assert.match(workflow, /^\s{2}kestrel-one-product:\s*$/mu);
  assert.match(workflow, /kestrel-one-product -- pnpm run ci:product/u);
  assert.match(workflow, /pnpm run ci:run-gate/u);
  assert.match(workflow, /Full-repository Ultracite/u);
  assert.match(workflow, /static-policy\/lint -- pnpm run ci:lint:full/u);
  assert.match(workflow, /KESTREL_PRODUCT_WEBKIT/u);
  assert.match(workflow, /Upload failed product evidence/u);
  assert.doesNotMatch(workflow, /apt-get update/u);
  assert.match(workflow, /CI_GATE_SELECTIONS/u);
  assert.match(workflow, /CI_GATE_RESULTS/u);
  assert.doesNotMatch(workflow, /CI_GATE_PLAN/u);
  assert.doesNotMatch(workflow, /CI_JOB_RESULTS/u);
});

test("ci-required accepts explicit selected-gate results and rejects a mismatch", () => {
  const selections = Object.fromEntries(
    CI_GATE_IDS.map((gate) => [gate, gate === "web-unit"])
  );
  const results = Object.fromEntries(
    CI_GATE_IDS.map((gate) => [
      gate,
      gate === "web-unit" ? "success" : "skipped",
    ])
  );
  const run = (gateResults: Record<string, string>) =>
    spawnSync(
      process.execPath,
      ["--import", "tsx", "scripts/ci/assert-required.ts"],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          CI_PLAN_RESULT: "success",
          CI_GATE_SELECTIONS: JSON.stringify(selections),
          CI_GATE_RESULTS: JSON.stringify(gateResults),
        },
      }
    );

  const accepted = run(results);
  assert.equal(accepted.status, 0, accepted.stderr);

  const rejected = run({ ...results, "web-unit": "failure" });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /web-unit: expected success, received failure/u);
});

test("CI runtime owns the prompt and eval gates exactly once", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(ROOT, "package.json"), "utf8")
  ) as { scripts: Record<string, string> };
  const runtime = packageJson.scripts["ci:runtime"] ?? "";

  assert.equal(runtime.match(/prompt-suite/gu)?.length, 1);
  assert.equal(runtime.match(/evals:release-check/gu)?.length, 1);
  assert.doesNotMatch(packageJson.scripts.test ?? "", /eval/u);
  assert.doesNotMatch(packageJson.scripts["governance:check"] ?? "", /eval/u);
});

test("product-contract bootstrap waits for Compose health before database setup", async () => {
  const bootstrap = await readFile(
    path.join(ROOT, "apps", "web", "scripts", "product-dev-all.sh"),
    "utf8"
  );

  assert.match(
    bootstrap,
    /docker compose up -d --wait --wait-timeout 60 postgres/u
  );
  assert.match(bootstrap, /KESTREL_TURN_WORKER_READY_FILE/u);
  assert.match(bootstrap, /trap cleanup EXIT INT TERM/u);
});

test("product-contract infrastructure ports are allocated per run", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(ROOT, "package.json"), "utf8")
  ) as { scripts: Record<string, string> };
  const productConfig = await readFile(
    path.join(ROOT, "apps", "web", "playwright.product.config.ts"),
    "utf8"
  );
  const launcher = await readFile(
    path.join(ROOT, "apps", "web", "scripts", "run-product-contract.ts"),
    "utf8"
  );

  assert.equal(
    packageJson.scripts["ci:product"],
    "node --import tsx apps/web/scripts/run-product-contract.ts"
  );
  assert.match(
    productConfig,
    /requiredPort\("KESTREL_PRODUCT_REDIS_PORT"\)/u
  );
  assert.match(productConfig, /KESTREL_RUNNER_SERVICE_PORT/u);
  assert.match(
    productConfig,
    /gracefulShutdown: \{ signal: "SIGTERM", timeout: 30_000 \}/u
  );
  assert.match(launcher, /allocateProductContractPorts/u);
  assert.doesNotMatch(
    productConfig,
    /const\s+\w*[Pp]ort\s*=\s*[\d_]+/u
  );
});

test("product-contract browser proof waits for the durable worker before test timeouts", async () => {
  const productConfig = await readFile(
    path.join(ROOT, "apps", "web", "playwright.product.config.ts"),
    "utf8"
  );
  const setup = await readFile(
    path.join(ROOT, "apps", "web", "tests", "product", "global-setup.ts"),
    "utf8"
  );

  assert.match(productConfig, /globalSetup: "\.\/tests\/product\/global-setup\.ts"/u);
  assert.match(productConfig, /KESTREL_TURN_WORKER_READY_FILE/u);
  assert.match(setup, /waitForWorkerReady/u);
  assert.match(setup, /waitUntil: "commit"/u);
  assert.match(setup, /prewarmNavigationTimeoutMs/u);
  assert.match(setup, /\/api\/mobile\/v2\/threads/u);
});
